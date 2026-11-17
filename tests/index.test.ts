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

describe('xclient (публичный API)', () => {
  it('использует переданный fetcher', async () => {
    const { fetcher, calls } = createFakeFetcher({ ok: 1 });

    const result = await xclient({ fetcher }).get('https://example.com/a');

    assert.deepEqual(result, { ok: 1 });
    assert.equal(calls[0]?.url, 'https://example.com/a');
  });

  it('передаёт config (baseUrl) в запросы', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await xclient({ fetcher, config: { baseUrl: 'https://api.com' } }).get('/users');

    assert.equal(calls[0]?.url, 'https://api.com/users');
  });

  it('config.maxRetries ограничивает retries()', () => {
    const { fetcher } = createFakeFetcher();
    const client = xclient({ fetcher, config: { maxRetries: 2 } });

    assert.throws(() => client.get('https://example.com').retries(3), /maxRetries/);
  });

  it('без аргументов использует встроенный Fetch поверх глобального fetch', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url}`);

      return new Response('{"v":1}', { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const result = await xclient().post('https://example.com/x').body({ a: 1 });

    assert.deepEqual(result, { v: 1 });
    assert.deepEqual(seen, ['POST https://example.com/x']);
  });

  it('каждый вызов xclient создаёт независимый клиент', async () => {
    const a = createFakeFetcher('a');
    const b = createFakeFetcher('b');

    assert.equal(await xclient({ fetcher: a.fetcher }).get('https://x.com'), 'a');
    assert.equal(await xclient({ fetcher: b.fetcher }).get('https://x.com'), 'b');
    assert.equal(a.calls.length, 1);
    assert.equal(b.calls.length, 1);
  });

  it('экспортирует ошибки, константы и охранник', () => {
    assert.equal(HttpStatus.NOT_FOUND, 404);
    assert.equal(typeof isHttpError, 'function');

    for (const Cls of [HttpError, NetworkError, ParseError, TimeoutError]) {
      assert.ok(Cls.prototype instanceof XRequestError, Cls.name);
    }
    assert.ok(new ValidationError('x') instanceof Error);
  });
});
