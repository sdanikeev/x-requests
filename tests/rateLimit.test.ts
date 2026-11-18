import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AbortError, NetworkError, ValidationError } from '../src/errors.js';
import { rateLimitMiddleware } from '../src/middlewares/rateLimit.js';
import type { RateLimitOptions } from '../src/middlewares/rateLimit.js';
import XClient from '../src/XClient.js';
import type { Fetcher, FetcherRequestParams } from '../src/types.js';
import { createStreamFetcher, event } from './helpers.js';

const url = 'https://api.example.com/items';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

// a fetcher whose calls finish only when the test says so
const createManualFetcher = () => {
  const calls: { url: string; finish: (value?: unknown) => void; fail: (error: Error) => void }[] = [];
  const fetcher: Fetcher = {
    request<T>(data: FetcherRequestParams) {
      return new Promise<T>((resolve, reject) => {
        calls.push({ url: data.url, finish: value => resolve((value ?? { ok: true }) as T), fail: reject });
      });
    },
  };

  return { fetcher, calls };
};

const setup = (options: RateLimitOptions) => {
  const clock = { now: 1000 };
  const timers: { callback: () => void; ms: number }[] = [];
  const middleware = rateLimitMiddleware({
    now: () => clock.now,
    schedule: (callback, ms) => timers.push({ callback, ms }),
    ...options,
  });
  const { fetcher, calls } = createManualFetcher();
  const client = new XClient(fetcher, { middleware: [middleware] });

  // moves the clock and runs the timers that were set
  const advance = async (ms: number) => {
    clock.now += ms;
    timers.splice(0).forEach(timer => timer.callback());
    await tick();
  };

  return { client, calls, timers, advance, middleware };
};

describe('rateLimitMiddleware', () => {
  it('should start requests at once if they are within the limit', async () => {
    const { client, calls } = setup({ limit: 2, interval: 1000 });

    void client.get(url).result();
    void client.get(url).result();
    await tick();

    assert.equal(calls.length, 2);
  });

  it('should hold the request above the limit until the window moves on', async () => {
    const { client, calls, advance, timers } = setup({ limit: 2, interval: 1000 });

    for (let i = 0; i < 3; i++) void client.get(url).result();
    await tick();

    assert.equal(calls.length, 2);
    assert.equal(timers[0]?.ms, 1000);

    await advance(1000);

    assert.equal(calls.length, 3);
  });

  it('should run the waiting requests in the order they came if the limit is hit', async () => {
    const { client, calls, advance } = setup({ limit: 1, interval: 1000 });

    for (const id of ['a', 'b', 'c']) void client.get(`${url}/${id}`).result();
    await tick();
    await advance(1000);
    await advance(1000);

    assert.deepEqual(calls.map(call => call.url.slice(-1)), ['a', 'b', 'c']);
  });

  it('should wait only for the part of the window that is left if the first request was earlier', async () => {
    const { client, advance, timers } = setup({ limit: 1, interval: 1000 });

    void client.get(url).result();
    await tick();
    await advance(400);
    void client.get(url).result();
    await tick();

    assert.equal(timers[0]?.ms, 600);
  });

  it('should limit the requests running at the same time if maxConcurrent is set', async () => {
    const { client, calls } = setup({ maxConcurrent: 2 });

    for (let i = 0; i < 3; i++) void client.get(url).result();
    await tick();

    assert.equal(calls.length, 2);

    calls[0]?.finish();
    await tick();

    assert.equal(calls.length, 3);
  });

  it('should free the place if the request fails', async () => {
    const { client, calls } = setup({ maxConcurrent: 1 });

    const first = client.get(url).result();
    void client.get(url).result();
    await tick();
    calls[0]?.fail(new NetworkError('down'));
    await first;
    await tick();

    assert.equal(calls.length, 2);
  });

  it('should leave the queue without using the limit if a waiting request is aborted', async () => {
    const { client, calls, advance } = setup({ limit: 1, interval: 1000 });
    const controller = new AbortController();

    void client.get(url).result();
    const aborted = client.get(url).signal(controller.signal).result();
    void client.get(`${url}/third`).result();
    await tick();
    controller.abort();

    const result = await aborted;

    assert.ok(!result.ok && result.error instanceof AbortError);

    await advance(1000);

    assert.deepEqual(calls.map(call => call.url), [url, `${url}/third`]);
  });

  it('should reject at once if the signal is already aborted when the request arrives', async () => {
    const { middleware } = setup({ limit: 1, interval: 1000 });
    const controller = new AbortController();

    controller.abort();

    await assert.rejects(
      middleware({ method: 'get', url, signal: controller.signal }, async () => 'x', {}),
      AbortError,
    );
  });

  it('should fail the request if the queue is full', async () => {
    const { client } = setup({ limit: 1, interval: 1000, maxQueue: 1 });

    void client.get(url).result();
    void client.get(url).result();
    await tick();

    const third = await client.get(url).result();

    assert.ok(!third.ok && third.error instanceof NetworkError);
    assert.match(third.error.message, /queue is full/);
  });

  it('should not count a request that starts at once against maxQueue', async () => {
    const { client, calls } = setup({ limit: 1, interval: 1000, maxQueue: 0 });

    void client.get(url).result();
    await tick();

    assert.equal(calls.length, 1);
  });

  it('should keep separate limits for every origin if the key is not set', async () => {
    const { client, calls } = setup({ limit: 1, interval: 1000 });

    void client.get('https://a.example.com/x').result();
    void client.get('https://b.example.com/x').result();
    await tick();

    assert.equal(calls.length, 2);
  });

  it('should share one limit if the key function returns the same key', async () => {
    const { client, calls } = setup({ limit: 1, interval: 1000, key: () => 'all' });

    void client.get('https://a.example.com/x').result();
    void client.get('https://b.example.com/x').result();
    await tick();

    assert.equal(calls.length, 1);
  });

  it('should use a place for every attempt if the request is retried', async () => {
    const { client, calls, advance } = setup({ limit: 2, interval: 1000 });

    const first = client.get(url).retries(1, 1, { jitter: false }).result();

    await tick();
    calls[0]?.fail(new NetworkError('down'));
    await new Promise(resolve => setTimeout(resolve, 15));

    assert.equal(calls.length, 2);

    void client.get(`${url}/other`).result();
    await tick();

    assert.equal(calls.length, 2);

    calls[1]?.finish();
    await first;
    await advance(1000);

    assert.equal(calls.length, 3);
  });

  it('should hold the place until the stream ends if the request is a stream', async () => {
    const { fetcher: streamFetcher } = createStreamFetcher([[event('{"n":1}'), event('{"n":2}')]]);
    const { fetcher: manual, calls } = createManualFetcher();
    const middleware = rateLimitMiddleware({ maxConcurrent: 1 });
    const client = new XClient({ ...manual, stream: streamFetcher.stream!.bind(streamFetcher) }, { middleware: [middleware] });
    const reader = client.get(url).stream();

    await reader.next();
    void client.get(url).result();
    await tick();

    assert.equal(calls.length, 0);

    await reader.return();
    await tick();

    assert.equal(calls.length, 1);
  });

  it('should not hold the place if a stream is never read', async () => {
    const middleware = rateLimitMiddleware({ maxConcurrent: 1 });
    const unread = await middleware({ method: 'get', url, stream: true }, async () => (async function* () { })(), {});
    const result = await middleware({ method: 'get', url }, async () => 'done', {});

    assert.ok(unread);
    assert.equal(result, 'done');
  });

  it('should wait for the real time if schedule and now are not given', async () => {
    const middleware = rateLimitMiddleware({ limit: 1, interval: 40 });
    const { fetcher } = createManualFetcher();
    const started: number[] = [];
    const client = new XClient({
      async request<T>(data: FetcherRequestParams) {
        started.push(Date.now());

        return fetcher.request<T>(data).catch(() => ({}) as T);
      },
    }, { middleware: [middleware] });

    void client.get(url).result();
    void client.get(url).result();
    await new Promise(resolve => setTimeout(resolve, 90));

    assert.equal(started.length, 2);
    assert.ok((started[1] ?? 0) - (started[0] ?? 0) >= 35);
  });

  it('should throw a ValidationError if the options are not valid', () => {
    assert.throws(() => rateLimitMiddleware({}), ValidationError);
    assert.throws(() => rateLimitMiddleware({ limit: 1 }), ValidationError);
    assert.throws(() => rateLimitMiddleware({ limit: 0, interval: 10 }), ValidationError);
    assert.throws(() => rateLimitMiddleware({ maxConcurrent: 0 }), ValidationError);
  });
});
