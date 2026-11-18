import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AbortError, CircuitOpenError, HttpError, NetworkError, ParseError, TimeoutError, ValidationError } from '../src/errors.js';
import { circuitBreakerMiddleware } from '../src/middlewares/circuitBreaker.js';
import type { CircuitBreakerOptions } from '../src/middlewares/circuitBreaker.js';
import XClient from '../src/XClient.js';
import type { Fetcher, FetcherRequestParams } from '../src/types.js';
import { createStreamFetcher, event } from './helpers.js';

const url = 'https://api.example.com/items';

// answers with the next item of the script: an Error is thrown, anything else is returned
const scripted = (script: unknown[]) => {
  const calls: FetcherRequestParams[] = [];
  const fetcher: Fetcher = {
    async request<T>(data: FetcherRequestParams) {
      calls.push(data);

      const item = script[calls.length - 1] ?? { ok: true };

      if (item instanceof Error) throw item;

      return item as T;
    },
  };

  return { fetcher, calls };
};

const setup = (script: unknown[], options: CircuitBreakerOptions = {}) => {
  const clock = { now: 1000 };
  const breaker = circuitBreakerMiddleware({ failureThreshold: 3, resetTimeout: 1000, now: () => clock.now, ...options });
  const { fetcher, calls } = scripted(script);

  return { client: new XClient(fetcher, { middleware: [breaker] }), breaker, calls, clock };
};

const down = () => new NetworkError('down');
const fail = async (client: XClient, times: number) => {
  for (let i = 0; i < times; i++) await assert.rejects(async () => client.get(url));
};

describe('circuitBreakerMiddleware', () => {
  it('should stay closed if failures are below the threshold', async () => {
    const { client, breaker } = setup([down(), down()]);

    await fail(client, 2);

    assert.equal(breaker.state('https://api.example.com'), 'closed');
  });

  it('should open and refuse requests without calling the service if the threshold is reached', async () => {
    const { client, breaker, calls } = setup([down(), down(), down()]);

    await fail(client, 3);

    assert.equal(breaker.state('https://api.example.com'), 'open');
    await assert.rejects(async () => client.get(url), CircuitOpenError);
    assert.equal(calls.length, 3);
  });

  it('should say how long to wait if the circuit is open', async () => {
    const { client, clock } = setup([down(), down(), down()]);

    await fail(client, 3);
    clock.now += 400;

    await assert.rejects(
      async () => client.get(url),
      (error: unknown) => error instanceof CircuitOpenError && error.retryAfterMs === 600,
    );
  });

  it('should count only failures in a row if a request succeeds in between', async () => {
    const { client, breaker } = setup([down(), down(), { ok: true }, down(), down()]);

    await fail(client, 2);
    await client.get(url);
    await fail(client, 2);

    assert.equal(breaker.state('https://api.example.com'), 'closed');
  });

  it('should let one trial request through if resetTimeout has passed', async () => {
    const { client, breaker, calls, clock } = setup([down(), down(), down(), { ok: true }]);

    await fail(client, 3);
    clock.now += 1000;

    assert.equal(breaker.state('https://api.example.com'), 'half-open');
    assert.deepEqual(await client.get(url), { ok: true });
    assert.equal(calls.length, 4);
    assert.equal(breaker.state('https://api.example.com'), 'closed');
  });

  it('should open again at once if the trial request fails', async () => {
    const { client, breaker, calls, clock } = setup([down(), down(), down(), down()]);

    await fail(client, 3);
    clock.now += 1000;
    await assert.rejects(async () => client.get(url), NetworkError);

    assert.equal(breaker.state('https://api.example.com'), 'open');
    await assert.rejects(async () => client.get(url), CircuitOpenError);
    assert.equal(calls.length, 4);
  });

  it('should refuse other requests while the trial request is running', async () => {
    const clock = { now: 1000 };
    const breaker = circuitBreakerMiddleware({ failureThreshold: 1, resetTimeout: 1000, now: () => clock.now });
    let release: (value: unknown) => void = () => { };
    let failNext = true;
    const fetcher: Fetcher = {
      request<T>() {
        if (failNext) return Promise.reject(down());

        return new Promise<T>((resolve) => {
          release = resolve as (value: unknown) => void;
        });
      },
    };
    const client = new XClient(fetcher, { middleware: [breaker] });

    await assert.rejects(async () => client.get(url), NetworkError);
    clock.now += 1000;
    failNext = false;

    const trial = client.get(url).result();

    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(async () => client.get(url), CircuitOpenError);
    release({ ok: true });
    await trial;

    assert.equal(breaker.state('https://api.example.com'), 'closed');
  });

  it('should keep waiting for a trial request if the previous one was aborted', async () => {
    const { client, breaker, clock } = setup([down(), down(), down(), new AbortError(), { ok: true }]);

    await fail(client, 3);
    clock.now += 1000;
    await assert.rejects(async () => client.get(url), AbortError);

    assert.equal(breaker.state('https://api.example.com'), 'half-open');
    assert.deepEqual(await client.get(url), { ok: true });
  });

  it('should count timeouts and HTTP 5xx as failures if isFailure is not set', async () => {
    const { client, breaker } = setup([new TimeoutError(10), new HttpError(503, 'x', 'x'), new HttpError(500, 'x', 'x')]);

    await fail(client, 3);

    assert.equal(breaker.state('https://api.example.com'), 'open');
  });

  it('should not count a 4xx or a parse error as a failure if the service answered', async () => {
    const { client, breaker } = setup([
      new HttpError(404, 'x', 'x'),
      new HttpError(429, 'x', 'x'),
      new ParseError('{', { cause: new Error('bad') }),
      new HttpError(422, 'x', 'x'),
    ]);

    await fail(client, 4);

    assert.equal(breaker.state('https://api.example.com'), 'closed');
  });

  it('should not count an abort as a failure if a request is cancelled', async () => {
    const { client, breaker } = setup([new AbortError(), new AbortError(), new AbortError(), new AbortError()]);

    await fail(client, 4);

    assert.equal(breaker.state('https://api.example.com'), 'closed');
  });

  it('should use isFailure if it is set', async () => {
    const { client, breaker } = setup([new HttpError(404, 'x', 'x')], {
      failureThreshold: 1,
      isFailure: error => error instanceof HttpError && error.status === 404,
    });

    await fail(client, 1);

    assert.equal(breaker.state('https://api.example.com'), 'open');
  });

  it('should keep a separate circuit for every origin if the key is not set', async () => {
    const { client, calls } = setup([down(), down(), down()]);

    await fail(client, 3);

    assert.deepEqual(await client.get('https://other.example.com/items'), { ok: true });
    assert.equal(calls.length, 4);
  });

  it('should use the key function if it is set', async () => {
    const { client, breaker } = setup([down(), down(), down()], { key: () => 'shared' });

    await fail(client, 3);

    assert.equal(breaker.state('shared'), 'open');
    await assert.rejects(async () => client.get('https://other.example.com/items'), CircuitOpenError);
  });

  it('should group requests by the url itself if it is not absolute', async () => {
    const { client, breaker } = setup([down(), down(), down()]);

    for (let i = 0; i < 3; i++) await assert.rejects(async () => client.get('/relative'));

    assert.equal(breaker.state('/relative'), 'open');
  });

  it('should close the circuits if reset() is called', async () => {
    const { client, breaker } = setup([down(), down(), down()]);

    await fail(client, 3);
    breaker.reset('https://api.example.com');

    assert.equal(breaker.state('https://api.example.com'), 'closed');
    assert.deepEqual(await client.get(url), { ok: true });
  });

  it('should close every circuit if reset() gets no key', async () => {
    const { client, breaker } = setup([down(), down(), down()]);

    await fail(client, 3);
    breaker.reset();

    assert.equal(breaker.state('https://api.example.com'), 'closed');
  });

  it('should not retry an open circuit if retries are set', async () => {
    const { client, calls } = setup([down(), down(), down()]);

    await fail(client, 3);
    await assert.rejects(async () => client.get(url).retries(3, 1), CircuitOpenError);

    assert.equal(calls.length, 3);
  });

  it('should return the fallback if the circuit is open', async () => {
    const { client } = setup([down(), down(), down()]);

    await fail(client, 3);

    assert.equal(await client.get(url).fallback('cached'), 'cached');
  });

  it('should report kind circuit if result() is used', async () => {
    const { client } = setup([down(), down(), down()]);

    await fail(client, 3);

    const result = await client.get(url).result();

    assert.ok(!result.ok);
    assert.equal(result.error.kind, 'circuit');
  });

  it('should refuse a stream if the circuit is open', async () => {
    const breaker = circuitBreakerMiddleware({ failureThreshold: 1, resetTimeout: 1000 });
    const { fetcher: streamFetcher, calls } = createStreamFetcher([[event('{"n":1}')]]);
    const { fetcher } = scripted([down()]);
    const client = new XClient({ ...fetcher, stream: streamFetcher.stream!.bind(streamFetcher) }, { middleware: [breaker] });

    await assert.rejects(async () => client.get(url), NetworkError);
    await assert.rejects(async () => {
      for await (const item of client.get(url).stream()) void item;
    }, CircuitOpenError);
    assert.equal(calls.length, 0);
  });

  it('should let a stream through and not count it if the circuit is closed', async () => {
    const breaker = circuitBreakerMiddleware({ failureThreshold: 1, resetTimeout: 1000 });
    const { fetcher } = createStreamFetcher([[new NetworkError('drop')]]);
    const client = new XClient(fetcher, { middleware: [breaker] });

    await assert.rejects(async () => {
      for await (const item of client.get(url).stream()) void item;
    }, NetworkError);

    assert.equal(breaker.state('https://api.example.com'), 'closed');
  });

  it('should throw a ValidationError if the options are not valid', () => {
    assert.throws(() => circuitBreakerMiddleware({ failureThreshold: 0 }), ValidationError);
    assert.throws(() => circuitBreakerMiddleware({ resetTimeout: 0 }), ValidationError);
  });

  it('should use the real clock if now is not given', async () => {
    const breaker = circuitBreakerMiddleware({ failureThreshold: 1 });
    const { fetcher } = scripted([down()]);
    const client = new XClient(fetcher, { middleware: [breaker] });

    await assert.rejects(async () => client.get(url), NetworkError);

    assert.equal(breaker.state('https://api.example.com'), 'open');
  });
});
