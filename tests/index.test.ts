import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import xclient, {
  HttpError,
  HttpStatus,
  NetworkError,
  ParseError,
  TimeoutError,
  ValidationError,
  XRequestError,
  isHttpError,
} from '../src/index.js';
import { createFakeFetcher } from './helpers.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('xclient (public API)', () => {
  it('should use the given fetcher if one is passed', async () => {
    const { fetcher, calls } = createFakeFetcher({ ok: 1 });

    const result = await xclient({ fetcher }).get('https://example.com/a');

    assert.deepEqual(result, { ok: 1 });
    assert.equal(calls[0]?.url, 'https://example.com/a');
  });

  it('should pass config (baseUrl) to requests if config is given', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await xclient({ fetcher, config: { baseUrl: 'https://api.com' } }).get('/users');

    assert.equal(calls[0]?.url, 'https://api.com/users');
  });

  it('should limit retries() if config.maxRetries is set', () => {
    const { fetcher } = createFakeFetcher();
    const client = xclient({ fetcher, config: { maxRetries: 2 } });

    assert.throws(() => client.get('https://example.com').retries(3), /maxRetries/);
  });

  it('should use the built-in Fetch over global fetch if called without arguments', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url}`);

      return new Response('{"v":1}', { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const result = await xclient().post('https://example.com/x').body({ a: 1 });

    assert.deepEqual(result, { v: 1 });
    assert.deepEqual(seen, ['POST https://example.com/x']);
  });

  it('should create an independent client if xclient is called repeatedly', async () => {
    const a = createFakeFetcher('a');
    const b = createFakeFetcher('b');

    assert.equal(await xclient({ fetcher: a.fetcher }).get('https://x.com'), 'a');
    assert.equal(await xclient({ fetcher: b.fetcher }).get('https://x.com'), 'b');
    assert.equal(a.calls.length, 1);
    assert.equal(b.calls.length, 1);
  });

  it('should export errors, constants and the type guard', () => {
    assert.equal(HttpStatus.NOT_FOUND, 404);
    assert.equal(typeof isHttpError, 'function');

    for (const Cls of [HttpError, NetworkError, ParseError, TimeoutError]) {
      assert.ok(Cls.prototype instanceof XRequestError, Cls.name);
    }
    assert.ok(new ValidationError('x') instanceof Error);
  });
});
