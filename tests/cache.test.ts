import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AbortError, NetworkError, ValidationError } from '../src/errors.js';
import { cacheMiddleware } from '../src/middlewares/cache.js';
import type { CacheOptions } from '../src/middlewares/cache.js';
import XClient from '../src/XClient.js';
import { createFakeFetcher, createFlakyFetcher, createStreamFetcher, event } from './helpers.js';
import type { Fetcher, FetcherRequestParams, ResponseContext } from '../src/types.js';

const url = 'https://example.com/items';

const setup = (options: Partial<CacheOptions> = {}, response: unknown = { id: 1 }) => {
  const clock = { now: 1000 };
  const cache = cacheMiddleware({ ttl: 100, now: () => clock.now, ...options });
  const { fetcher, calls } = createFakeFetcher(response);

  return { client: new XClient(fetcher, { middleware: [cache] }), cache, calls, clock };
};

describe('cacheMiddleware', () => {
  it('should call the fetcher once if the same GET is repeated within the ttl', async () => {
    const { client, calls } = setup();

    await client.get(url);
    await client.get(url);

    assert.equal(calls.length, 1);
  });

  it('should call the fetcher again if the ttl has passed', async () => {
    const { client, calls, clock } = setup();

    await client.get(url);
    clock.now += 101;
    await client.get(url);

    assert.equal(calls.length, 2);
  });

  it('should treat requests as different if the query differs', async () => {
    const { client, calls } = setup();

    await client.get(url).params({ page: 1 });
    await client.get(url).params({ page: 2 });
    await client.get(url).params({ page: 1 });

    assert.equal(calls.length, 2);
  });

  it('should treat requests as the same if the query only differs in key order', async () => {
    const { client, calls } = setup();

    await client.get(url).params({ a: 1, b: 2 });
    await client.get(url).params({ b: 2, a: 1 });

    assert.equal(calls.length, 1);
  });

  it('should not cache a request if its method is not in methods', async () => {
    const { client, calls } = setup();

    await client.post(url);
    await client.post(url);

    assert.equal(calls.length, 2);
  });

  it('should cache a request if its method is added to methods', async () => {
    const { client, calls } = setup({ methods: ['get', 'post'] });

    await client.post(url);
    await client.post(url);

    assert.equal(calls.length, 1);
  });

  it('should share one call if identical requests are made at the same time', async () => {
    const { client, calls } = setup();

    await Promise.all([client.get(url), client.get(url), client.get(url)]);

    assert.equal(calls.length, 1);
  });

  it('should not cache a failure if the request fails', async () => {
    const { fetcher, calls } = createFlakyFetcher(1, { id: 1 }, () => new NetworkError('down'));
    const client = new XClient(fetcher, { middleware: [cacheMiddleware({ ttl: 100 })] });

    await assert.rejects(async () => client.get(url));
    assert.deepEqual(await client.get(url), { id: 1 });
    assert.equal(calls.length, 2);
  });

  it('should drop the entries of the url if an unsafe request succeeds', async () => {
    const { client, calls } = setup();

    await client.get(url);
    await client.post(url);
    await client.get(url);

    assert.equal(calls.length, 3);
  });

  it('should keep the entries of other urls if an unsafe request succeeds', async () => {
    const { client, calls } = setup();

    await client.get(url);
    await client.post('https://example.com/other');
    await client.get(url);

    assert.equal(calls.length, 2);
  });

  it('should keep the entries if an unsafe request fails', async () => {
    let fail = false;
    const calls: FetcherRequestParams[] = [];
    const fetcher: Fetcher = {
      async request<T>(data: FetcherRequestParams) {
        calls.push(data);

        if (fail) throw new NetworkError('down');

        return { id: 1 } as T;
      },
    };
    const client = new XClient(fetcher, { middleware: [cacheMiddleware({ ttl: 100 })] });

    await client.get(url);
    fail = true;
    await assert.rejects(async () => client.post(url));
    await client.get(url);

    assert.equal(calls.length, 2);
  });

  it('should not share a response between callers if clone is on', async () => {
    const { client } = setup();

    const first = await client.get(url) as { id: number };

    first.id = 99;

    assert.deepEqual(await client.get(url), { id: 1 });
  });

  it('should return the same object if clone is off', async () => {
    const { client } = setup({ clone: false });

    assert.equal(await client.get(url), await client.get(url));
  });

  it('should use separate entries if the Authorization header differs', async () => {
    const { client, calls } = setup();

    await client.get(url).headers({ Authorization: 'Bearer a' });
    await client.get(url).headers({ authorization: 'Bearer b' });
    await client.get(url).headers({ Authorization: 'Bearer a' });

    assert.equal(calls.length, 2);
  });

  it('should use separate entries if a header from vary differs', async () => {
    const { client, calls } = setup({ vary: ['Accept-Language'] });

    await client.get(url).headers({ 'accept-language': 'en' });
    await client.get(url).headers({ 'Accept-Language': 'de' });

    assert.equal(calls.length, 2);
  });

  it('should use the given key function if key is set', async () => {
    const { client, calls } = setup({ key: () => 'same' });

    await client.get(url).params({ a: 1 });
    await client.get('https://example.com/other');

    assert.equal(calls.length, 1);
  });

  it('should drop the least recently used entry if maxEntries is exceeded', async () => {
    const { client, calls } = setup({ maxEntries: 2 });

    await client.get(`${url}/1`);
    await client.get(`${url}/2`);
    await client.get(`${url}/1`);
    await client.get(`${url}/3`);
    await client.get(`${url}/1`);
    await client.get(`${url}/2`);

    assert.deepEqual(calls.map(call => call.url.slice(-1)), ['1', '2', '3', '2']);
  });

  it('should forget everything if clear() is called', async () => {
    const { client, cache, calls } = setup();

    await client.get(url);
    cache.clear();
    await client.get(url);

    assert.equal(calls.length, 2);
  });

  it('should forget one url if invalidate() is called', async () => {
    const { client, cache, calls } = setup();

    await client.get(url);
    await client.get('https://example.com/other');
    cache.invalidate(url);
    await client.get(url);
    await client.get('https://example.com/other');

    assert.equal(calls.length, 3);
  });

  it('should not cache a stream if the request is a stream', async () => {
    const { fetcher, calls } = createStreamFetcher([[event('{"n":1}')], [event('{"n":1}')]]);
    const client = new XClient(fetcher, { middleware: [cacheMiddleware({ ttl: 100 })] });

    for await (const item of client.get(url).stream()) void item;
    for await (const item of client.get(url).stream()) void item;

    assert.equal(calls.length, 2);
  });

  it('should return a primitive as is if the response is not an object', async () => {
    const { client, calls } = setup({}, 'text');

    assert.equal(await client.get(url), 'text');
    assert.equal(await client.get(url), 'text');
    assert.equal(calls.length, 1);
  });

  it('should use the real clock if now is not given', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher, { middleware: [cacheMiddleware({ ttl: 60_000 })] });

    await client.get(url);
    await client.get(url);

    assert.equal(calls.length, 1);
  });

  it('should throw a ValidationError if ttl is not positive', () => {
    assert.throws(() => cacheMiddleware({ ttl: 0 }), ValidationError);
  });

  it('should throw a ValidationError if maxEntries is less than 1', () => {
    assert.throws(() => cacheMiddleware({ ttl: 1, maxEntries: 0 }), ValidationError);
  });
});

// answers with the given Cache-Control and fills the context like Fetch does
const withCacheControl = (value: string | undefined) => {
  const calls: FetcherRequestParams[] = [];
  const fetcher: Fetcher = {
    async request<T>(data: FetcherRequestParams, context?: ResponseContext) {
      calls.push(data);

      if (context) context.headers = new Headers(value === undefined ? {} : { 'Cache-Control': value });

      return { id: calls.length } as T;
    },
  };

  return { fetcher, calls };
};

describe('cacheMiddleware and Cache-Control', () => {
  const run = async (header: string | undefined, options: Partial<CacheOptions> = {}, wait = 0) => {
    const clock = { now: 1000 };
    const { fetcher, calls } = withCacheControl(header);
    const client = new XClient(fetcher, {
      middleware: [cacheMiddleware({ ttl: 100_000, now: () => clock.now, ...options })],
    });

    await client.get(url);
    clock.now += wait;
    await client.get(url);

    return calls.length;
  };

  it('should call the fetcher again if the response says no-store', async () => {
    assert.equal(await run('no-store'), 2);
  });

  it('should call the fetcher again if the response says no-cache', async () => {
    assert.equal(await run('private, no-cache'), 2);
  });

  it('should call the fetcher again if the response says max-age=0', async () => {
    assert.equal(await run('max-age=0'), 2);
  });

  it('should shorten the lifetime if max-age is less than ttl', async () => {
    assert.equal(await run('max-age=5', {}, 4000), 1);
    assert.equal(await run('max-age=5', {}, 6000), 2);
  });

  it('should keep ttl if max-age is greater than ttl', async () => {
    assert.equal(await run('max-age=3600', { ttl: 1000 }, 1500), 2);
  });

  it('should keep ttl if the response has no Cache-Control or an unreadable max-age', async () => {
    assert.equal(await run(undefined, {}, 50_000), 1);
    assert.equal(await run('max-age=soon', {}, 50_000), 1);
  });

  it('should read a quoted max-age if the server quotes it', async () => {
    assert.equal(await run('max-age="2"', {}, 3000), 2);
  });

  it('should ignore Cache-Control if respectCacheControl is off', async () => {
    assert.equal(await run('no-store', { respectCacheControl: false }), 1);
  });

  it('should ignore Cache-Control if the fetcher does not report headers', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher, { middleware: [cacheMiddleware({ ttl: 100 })] });

    await client.get(url);
    await client.get(url);

    assert.equal(calls.length, 1);
  });
});

// a call that finishes only when told to and honors the signal like the real fetch
const createControlledFetcher = () => {
  const calls: { signal: AbortSignal | undefined; finish: (value: unknown) => void }[] = [];
  const fetcher: Fetcher = {
    request<T>(data: FetcherRequestParams) {
      return new Promise<T>((resolve, reject) => {
        const call = { signal: data.signal, finish: (value: unknown) => resolve(value as T) };

        calls.push(call);
        data.signal?.addEventListener('abort', () => reject(new AbortError({ cause: data.signal?.reason })), { once: true });
      });
    },
  };

  return { fetcher, calls };
};

const pending = () => new Promise<void>(resolve => setImmediate(resolve));

describe('cacheMiddleware and cancellation', () => {
  const setupShared = () => {
    const { fetcher, calls } = createControlledFetcher();

    return { client: new XClient(fetcher, { middleware: [cacheMiddleware({ ttl: 1000 })] }), calls };
  };

  it('should keep the shared call alive for the others if the first caller is aborted', async () => {
    const { client, calls } = setupShared();
    const controller = new AbortController();

    const first = client.get(url).signal(controller.signal).result();
    const second = client.get(url).result();

    await pending();
    controller.abort();
    calls[0]?.finish({ id: 1 });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(calls.length, 1);
    assert.equal(firstResult.ok, false);
    assert.ok(!firstResult.ok && firstResult.error instanceof AbortError);
    assert.deepEqual(secondResult, { ok: true, data: { id: 1 } });
  });

  it('should abort the shared call if every caller is aborted', async () => {
    const { client, calls } = setupShared();
    const a = new AbortController();
    const b = new AbortController();

    const first = client.get(url).signal(a.signal).result();
    const second = client.get(url).signal(b.signal).result();

    await pending();
    a.abort();
    assert.equal(calls[0]?.signal?.aborted, false);
    b.abort();

    assert.equal(calls[0]?.signal?.aborted, true);
    assert.ok(!(await first).ok);
    assert.ok(!(await second).ok);
  });

  it('should abort the call and reject with AbortError if the only caller is aborted', async () => {
    const { client, calls } = setupShared();
    const controller = new AbortController();
    const result = client.get(url).signal(controller.signal).result();

    await pending();
    controller.abort('stop');

    const settled = await result;

    assert.equal(calls[0]?.signal?.aborted, true);
    assert.ok(!settled.ok && settled.error instanceof AbortError);
    assert.equal(!settled.ok && settled.error.cause, 'stop');
  });

  it('should start a new call if a request comes after the shared call was aborted', async () => {
    const { client, calls } = setupShared();
    const controller = new AbortController();
    const aborted = client.get(url).signal(controller.signal).result();

    await pending();
    controller.abort();
    await aborted;

    const next = client.get(url).result();

    await pending();
    calls[1]?.finish({ id: 2 });

    assert.equal(calls.length, 2);
    assert.deepEqual(await next, { ok: true, data: { id: 2 } });
  });

  it('should not keep the shared call alive if a caller without a signal is waiting', async () => {
    const { client, calls } = setupShared();
    const controller = new AbortController();

    const first = client.get(url).signal(controller.signal).result();
    const second = client.get(url).result();

    await pending();
    controller.abort();

    assert.equal(calls[0]?.signal?.aborted, false);
    calls[0]?.finish({ id: 1 });
    await Promise.all([first, second]);
  });

  it('should reject at once if the signal is already aborted when a caller joins a pending call', async () => {
    const cache = cacheMiddleware({ ttl: 1000 });
    let release: (value: unknown) => void = () => { };
    const next = () => new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const owner = cache({ method: 'get', url }, next, {});
    const controller = new AbortController();

    controller.abort('late');

    await assert.rejects(cache({ method: 'get', url, signal: controller.signal }, next, {}), AbortError);

    release({ id: 1 });
    assert.deepEqual(await owner, { id: 1 });
  });
});
