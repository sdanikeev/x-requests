import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HttpError,
  NetworkError,
  ParseError,
  TimeoutError,
  ValidationError,
  XRequestError,
  isHttpError,
  toRequestError,
} from '../src/errors.js';
import Fetch from '../src/Fetch.js';
import XRequest from '../src/XRequest.js';
import { createFakeFetcher, createFlakyFetcher } from './helpers.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const respond = (body: string, status: number, contentType = 'application/json') => {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { 'Content-Type': contentType } })) as typeof fetch;
};

describe('классы ошибок', () => {
  it('все наследуются от XRequestError и Error, имя = имя класса', () => {
    const errors = [
      new HttpError(500, ''),
      new NetworkError('x'),
      new TimeoutError(10),
      new ParseError('{'),
    ];

    for (const error of errors) {
      assert.ok(error instanceof XRequestError);
      assert.ok(error instanceof Error);
      assert.equal(error.name, error.constructor.name);
    }
  });

  it('kind различает ошибки', () => {
    assert.equal(new HttpError(500, '').kind, 'http');
    assert.equal(new NetworkError('x').kind, 'network');
    assert.equal(new TimeoutError(1).kind, 'timeout');
    assert.equal(new ParseError('').kind, 'parse');
    assert.equal(new ValidationError('x').kind, 'validation');
  });

  it('ValidationError не входит в XRequestError', () => {
    assert.equal(new ValidationError('x') instanceof XRequestError, false);
  });

  it('toRequestError оборачивает чужие ошибки в NetworkError с cause', () => {
    const original = new Error('boom');
    const wrapped = toRequestError(original);

    assert.ok(wrapped instanceof NetworkError);
    assert.equal(wrapped.message, 'boom');
    assert.equal(wrapped.cause, original);
    assert.equal(toRequestError(wrapped), wrapped);
    assert.ok(toRequestError('str') instanceof NetworkError);
  });
});

describe('isHttpError', () => {
  it('true только для HttpError (с проверкой статуса)', () => {
    const error = new HttpError(404, '');

    assert.equal(isHttpError(error), true);
    assert.equal(isHttpError(error, 404), true);
    assert.equal(isHttpError(error, 500), false);
    assert.equal(isHttpError(new NetworkError('x')), false);
    assert.equal(isHttpError('str'), false);
    assert.equal(isHttpError(undefined), false);
  });
});

describe('ошибки из Fetch', () => {
  it('HttpError: data — распарсенный json, body — сырой текст', async () => {
    respond('{"message":"nope"}', 404);

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof HttpError
        && error.status === 404
        && error.body === '{"message":"nope"}'
        && (error.data as { message: string }).message === 'nope',
    );
  });

  it('HttpError: не-json тело остаётся строкой в data', async () => {
    respond('Bad gateway', 502, 'text/plain');

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof HttpError && error.data === 'Bad gateway',
    );
  });

  it('HttpError: битый json в теле ошибки не маскирует HTTP-статус', async () => {
    respond('{oops', 500);

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof HttpError && error.status === 500 && error.data === '{oops',
    );
  });

  it('сетевой сбой -> NetworkError с cause', async () => {
    const cause = new TypeError('fetch failed');
    globalThis.fetch = (async () => {
      throw cause;
    }) as typeof fetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof NetworkError && error.cause === cause,
    );
  });

  it('таймаут -> TimeoutError с timeoutMs', async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com', timeout: 10 }),
      (error: unknown) => error instanceof TimeoutError && error.timeoutMs === 10,
    );
  });

  it('невалидный json в успешном ответе -> ParseError', async () => {
    respond('{oops', 200);

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof ParseError && error.body === '{oops',
    );
  });
});

describe('XRequest.result()', () => {
  it('успех -> { ok: true, data }', async () => {
    const { fetcher } = createFakeFetcher({ id: 1 });

    const result = await new XRequest(fetcher, 'get', 'https://example.com').result();

    assert.deepEqual(result, { ok: true, data: { id: 1 } });
  });

  it('ошибка -> { ok: false, error }, промис не отклоняется', async () => {
    const { fetcher } = createFlakyFetcher(10, undefined, () => new HttpError(404, 'nf'));

    const result = await new XRequest(fetcher, 'get', 'https://example.com').result();

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error instanceof HttpError && result.error.status === 404);
  });

  it('чужая ошибка из кастомного fetcher становится NetworkError', async () => {
    const { fetcher } = createFlakyFetcher(10);

    const result = await new XRequest(fetcher, 'get', 'https://example.com').result();

    assert.ok(!result.ok && result.error instanceof NetworkError);
  });

  it('после исчерпания ретраев возвращает последнюю ошибку', async () => {
    const { fetcher, calls } = createFlakyFetcher(10, undefined, n => new HttpError(503, `try ${n}`));

    const result = await new XRequest(fetcher, 'get', 'https://example.com').retries(2, 1).result();

    assert.equal(calls.length, 3);
    assert.ok(!result.ok && result.error instanceof HttpError && result.error.body === 'try 3');
  });

  it('с fallback всегда ok', async () => {
    const { fetcher } = createFlakyFetcher(10);

    const result = await new XRequest(fetcher, 'get', 'https://example.com').fallback('x').result();

    assert.deepEqual(result, { ok: true, data: 'x' });
  });

  it('ValidationError по-прежнему бросается, а не возвращается', async () => {
    const { fetcher } = createFakeFetcher();

    await assert.rejects(
      async () => await new XRequest(fetcher, 'get', 'https://x.com/{id}').result(),
      (error: unknown) => error instanceof ValidationError && /id/.test(error.message),
    );
  });
});

describe('ретраи и типы ошибок', () => {
  it('TimeoutError и NetworkError повторяются', async () => {
    for (const make of [() => new TimeoutError(1), () => new NetworkError('x')]) {
      const { fetcher, calls } = createFlakyFetcher(1, 'ok', make);

      const result = await new XRequest(fetcher, 'get', 'https://example.com').retries(2, 1);

      assert.equal(result, 'ok');
      assert.equal(calls.length, 2);
    }
  });

  it('ParseError не повторяется', async () => {
    const { fetcher, calls } = createFlakyFetcher(10, undefined, () => new ParseError('{'));

    await assert.rejects(
      async () => await new XRequest(fetcher, 'get', 'https://example.com').retries(3, 1),
      ParseError,
    );
    assert.equal(calls.length, 1);
  });
});
