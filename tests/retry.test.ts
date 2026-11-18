import { afterEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

import Fetch from '../src/Fetch.js';
import { HttpError, NetworkError } from '../src/errors.js';
import XClient from '../src/XClient.js';
import { createFlakyFetcher, createStreamFetcher, event } from './helpers.js';

const url = 'https://example.com/orders';
const realFetch = globalThis.fetch;

// records the pause of every retry and does not really wait
const recordDelays = (t: TestContext) => {
  const delays: number[] = [];
  const original = globalThis.setTimeout;

  t.mock.method(globalThis, 'setTimeout', ((handler: () => void, ms?: number) => {
    delays.push(ms ?? 0);

    return original(handler, 0);
  }) as typeof setTimeout);

  return delays;
};

const unavailable = (retryAfter?: string, status = 503) => () =>
  new HttpError(status, 'down', 'down', new Headers(retryAfter === undefined ? {} : { 'Retry-After': retryAfter }));

describe('HttpError headers', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('should carry the response headers if Fetch gets an error response', async () => {
    globalThis.fetch = (async () => new Response('no', { status: 503, headers: { 'Retry-After': '3' } })) as typeof fetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url }),
      (error: unknown) => error instanceof HttpError && error.headers?.get('retry-after') === '3',
    );
  });

  it('should carry the response headers if a stream connection is refused', async () => {
    globalThis.fetch = (async () => new Response('no', { status: 429, headers: { 'Retry-After': '9' } })) as typeof fetch;

    await assert.rejects(
      async () => {
        for await (const item of new Fetch().stream({ method: 'get', url })) void item;
      },
      (error: unknown) => error instanceof HttpError && error.headers?.get('retry-after') === '9',
    );
  });
});

describe('Retry-After', () => {
  it('should wait as long as the server asks if Retry-After is in seconds', async (t) => {
    const delays = recordDelays(t);
    const { fetcher } = createFlakyFetcher(1, {}, unavailable('2'));

    await new XClient(fetcher).get(url).retries(1, 100);

    assert.deepEqual(delays, [2000]);
  });

  it('should wait until the date if Retry-After is an HTTP date', async (t) => {
    const delays = recordDelays(t);
    const { fetcher } = createFlakyFetcher(1, {}, unavailable(new Date(Date.now() + 5000).toUTCString()));

    await new XClient(fetcher).get(url).retries(1, 100);

    assert.ok((delays[0] ?? 0) >= 3000 && (delays[0] ?? 0) <= 5000);
  });

  it('should not wait if Retry-After is a date in the past', async (t) => {
    const delays = recordDelays(t);
    const { fetcher } = createFlakyFetcher(1, {}, unavailable('Wed, 21 Oct 2015 07:28:00 GMT'));

    await new XClient(fetcher).get(url).retries(1, 100);

    assert.deepEqual(delays, [0]);
  });

  it('should use the backoff if Retry-After is not readable', async (t) => {
    const delays = recordDelays(t);
    const { fetcher } = createFlakyFetcher(1, {}, unavailable('soon'));

    await new XClient(fetcher).get(url).retries(1, 100, { jitter: false });

    assert.deepEqual(delays, [100]);
  });

  it('should use the backoff if the response has no Retry-After', async (t) => {
    const delays = recordDelays(t);
    const { fetcher } = createFlakyFetcher(1, {}, unavailable());

    await new XClient(fetcher).get(url).retries(1, 100, { jitter: false });

    assert.deepEqual(delays, [100]);
  });

  it('should ignore Retry-After if the status is not 429 or 503', async (t) => {
    const delays = recordDelays(t);
    const { fetcher } = createFlakyFetcher(1, {}, unavailable('60', 500));

    await new XClient(fetcher).get(url).retries(1, 100, { jitter: false });

    assert.deepEqual(delays, [100]);
  });

  it('should honor Retry-After if the status is 429', async (t) => {
    const delays = recordDelays(t);
    const { fetcher } = createFlakyFetcher(1, {}, unavailable('1', 429));

    await new XClient(fetcher).get(url).retries(1, 100);

    assert.deepEqual(delays, [1000]);
  });

  it('should fail at once if Retry-After is longer than maxRetryAfter', async () => {
    const { fetcher, calls } = createFlakyFetcher(1, {}, unavailable('120'));

    await assert.rejects(async () => new XClient(fetcher).get(url).retries(3, 1), /Status: 503/);
    assert.equal(calls.length, 1);
  });

  it('should wait for a long Retry-After if maxRetryAfter allows it', async (t) => {
    const delays = recordDelays(t);
    const { fetcher } = createFlakyFetcher(1, {}, unavailable('120'));

    await new XClient(fetcher).get(url).retries(1, 1, { maxRetryAfter: 200_000 });

    assert.deepEqual(delays, [120_000]);
  });

  it('should use Retry-After as the pause between stream reconnects if the connection is refused', async (t) => {
    const delays = recordDelays(t);
    const { fetcher, calls } = createStreamFetcher([[unavailable('3')()], [event('{"n":1}')]]);

    for await (const item of new XClient(fetcher).get(url).retries(1, 100).stream()) void item;

    assert.equal(calls.length, 2);
    assert.deepEqual(delays, [3000]);
  });
});

describe('jitter', () => {
  it('should halve the backoff if the random value is 0', async (t) => {
    const delays = recordDelays(t);

    t.mock.method(Math, 'random', () => 0);

    const { fetcher } = createFlakyFetcher(2, {}, () => new NetworkError('down'));

    await new XClient(fetcher).get(url).retries(2, 100);

    assert.deepEqual(delays, [50, 100]);
  });

  it('should stay below the full backoff if the random value is close to 1', async (t) => {
    const delays = recordDelays(t);

    t.mock.method(Math, 'random', () => 0.99);

    const { fetcher } = createFlakyFetcher(1, {}, () => new NetworkError('down'));

    await new XClient(fetcher).get(url).retries(1, 100);

    assert.ok((delays[0] ?? 0) > 99 && (delays[0] ?? 0) < 100);
  });

  it('should use the exact backoff if jitter is off', async (t) => {
    const delays = recordDelays(t);
    const { fetcher } = createFlakyFetcher(2, {}, () => new NetworkError('down'));

    await new XClient(fetcher).get(url).retries(2, 100, { jitter: false });

    assert.deepEqual(delays, [100, 200]);
  });

  it('should use the config default if the request does not set jitter', async (t) => {
    const delays = recordDelays(t);
    const { fetcher } = createFlakyFetcher(1, {}, () => new NetworkError('down'));

    await new XClient(fetcher, { retry: { jitter: false } }).get(url).retries(1, 100);

    assert.deepEqual(delays, [100]);
  });

  it('should prefer the request option if the config sets another value', async (t) => {
    const delays = recordDelays(t);

    t.mock.method(Math, 'random', () => 0);

    const { fetcher } = createFlakyFetcher(1, {}, () => new NetworkError('down'));

    await new XClient(fetcher, { retry: { jitter: false } }).get(url).retries(1, 100, { jitter: true });

    assert.deepEqual(delays, [50]);
  });
});

describe('retries of unsafe methods', () => {
  it('should not retry a POST if it is not idempotent', async () => {
    const { fetcher, calls } = createFlakyFetcher(1, {}, unavailable());

    await assert.rejects(async () => new XClient(fetcher).post(url).retries(3, 1), /Status: 503/);
    assert.equal(calls.length, 1);
  });

  it('should not retry a PATCH if it is not idempotent', async () => {
    const { fetcher, calls } = createFlakyFetcher(1, {}, () => new NetworkError('down'));

    await assert.rejects(async () => new XClient(fetcher).patch(url).retries(3, 1));
    assert.equal(calls.length, 1);
  });

  it('should retry a POST if idempotent() is called', async () => {
    const { fetcher, calls } = createFlakyFetcher(2, {}, () => new NetworkError('down'));

    await new XClient(fetcher).post(url).idempotent().retries(2, 1);

    assert.equal(calls.length, 3);
  });

  it('should retry a POST if idempotent() is called after retries()', async () => {
    const { fetcher, calls } = createFlakyFetcher(1, {}, () => new NetworkError('down'));

    await new XClient(fetcher).post(url).retries(2, 1).idempotent();

    assert.equal(calls.length, 2);
  });

  it('should retry a POST if unsafe is set on the request', async () => {
    const { fetcher, calls } = createFlakyFetcher(1, {}, () => new NetworkError('down'));

    await new XClient(fetcher).post(url).retries(2, 1, { unsafe: true });

    assert.equal(calls.length, 2);
  });

  it('should retry a POST if unsafe is set in the config', async () => {
    const { fetcher, calls } = createFlakyFetcher(1, {}, () => new NetworkError('down'));

    await new XClient(fetcher, { retry: { unsafe: true } }).post(url).retries(2, 1);

    assert.equal(calls.length, 2);
  });

  it('should retry PUT, DELETE, GET and OPTIONS if they are not idempotent() marked', async () => {
    for (const method of ['put', 'delete', 'get', 'options'] as const) {
      const { fetcher, calls } = createFlakyFetcher(1, {}, () => new NetworkError('down'));

      await new XClient(fetcher)[method](url).retries(2, 1);

      assert.equal(calls.length, 2, method);
    }
  });

  it('should not reconnect a POST stream if it is not idempotent', async () => {
    const { fetcher, calls } = createStreamFetcher([[new NetworkError('drop')], [event('{"n":1}')]]);

    await assert.rejects(async () => {
      for await (const item of new XClient(fetcher).post(url).retries(2, 1).stream()) void item;
    }, NetworkError);
    assert.equal(calls.length, 1);
  });

  it('should reconnect a POST stream if idempotent() is called', async () => {
    const { fetcher, calls } = createStreamFetcher([[new NetworkError('drop')], [event('{"n":1}')]]);

    for await (const item of new XClient(fetcher).post(url).idempotent().retries(2, 1).stream()) void item;

    assert.equal(calls.length, 2);
  });
});
