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

describe('error classes', () => {
  it('should extend XRequestError and Error and use the class name as name if an error is created', () => {
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

  it('should distinguish errors by kind if they are of different classes', () => {
    assert.equal(new HttpError(500, '').kind, 'http');
    assert.equal(new NetworkError('x').kind, 'network');
    assert.equal(new TimeoutError(1).kind, 'timeout');
    assert.equal(new ParseError('').kind, 'parse');
    assert.equal(new ValidationError('x').kind, 'validation');
  });

  it('should not make ValidationError an XRequestError if it is created', () => {
    assert.equal(new ValidationError('x') instanceof XRequestError, false);
  });

  it('toRequestError should wrap foreign errors in NetworkError with cause if the error is not an XRequestError', () => {
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
  it('should return true only for HttpError if the value is checked, optionally by status', () => {
    const error = new HttpError(404, '');

    assert.equal(isHttpError(error), true);
    assert.equal(isHttpError(error, 404), true);
    assert.equal(isHttpError(error, 500), false);
    assert.equal(isHttpError(new NetworkError('x')), false);
    assert.equal(isHttpError('str'), false);
    assert.equal(isHttpError(undefined), false);
  });
});

describe('errors from Fetch', () => {
  it('should set data to parsed json and body to raw text if the HttpError body is json', async () => {
    respond('{"message":"nope"}', 404);

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof HttpError
        && error.status === 404
        && error.body === '{"message":"nope"}'
        && (error.data as { message: string }).message === 'nope',
    );
  });

  it('should keep a non-json body as a string in data if the HttpError body is not json', async () => {
    respond('Bad gateway', 502, 'text/plain');

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof HttpError && error.data === 'Bad gateway',
    );
  });

  it('should keep the HTTP status if the error body contains broken json', async () => {
    respond('{oops', 500);

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof HttpError && error.status === 500 && error.data === '{oops',
    );
  });

  it('should throw NetworkError with cause if a network failure happens', async () => {
    const cause = new TypeError('fetch failed');
    globalThis.fetch = (async () => {
      throw cause;
    }) as typeof fetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof NetworkError && error.cause === cause,
    );
  });

  it('should throw TimeoutError with timeoutMs if the request times out', async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com', timeout: 10 }),
      (error: unknown) => error instanceof TimeoutError && error.timeoutMs === 10,
    );
  });

  it('should throw ParseError if a successful response contains invalid json', async () => {
    respond('{oops', 200);

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof ParseError && error.body === '{oops',
    );
  });
});

describe('XRequest.result()', () => {
  it('should return { ok: true, data } if the request succeeds', async () => {
    const { fetcher } = createFakeFetcher({ id: 1 });

    const result = await new XRequest(fetcher, 'get', 'https://example.com').result();

    assert.deepEqual(result, { ok: true, data: { id: 1 } });
  });

  it('should return { ok: false, error } without rejecting if the request fails', async () => {
    const { fetcher } = createFlakyFetcher(10, undefined, () => new HttpError(404, 'nf'));

    const result = await new XRequest(fetcher, 'get', 'https://example.com').result();

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error instanceof HttpError && result.error.status === 404);
  });

  it('should turn a foreign error into NetworkError if a custom fetcher throws it', async () => {
    const { fetcher } = createFlakyFetcher(10);

    const result = await new XRequest(fetcher, 'get', 'https://example.com').result();

    assert.ok(!result.ok && result.error instanceof NetworkError);
  });

  it('should return the last error if retries are exhausted', async () => {
    const { fetcher, calls } = createFlakyFetcher(10, undefined, n => new HttpError(503, `try ${n}`));

    const result = await new XRequest(fetcher, 'get', 'https://example.com').retries(2, 1).result();

    assert.equal(calls.length, 3);
    assert.ok(!result.ok && result.error instanceof HttpError && result.error.body === 'try 3');
  });

  it('should always return ok if a fallback is set', async () => {
    const { fetcher } = createFlakyFetcher(10);

    const result = await new XRequest(fetcher, 'get', 'https://example.com').fallback('x').result();

    assert.deepEqual(result, { ok: true, data: 'x' });
  });

  it('should throw ValidationError instead of returning it if the request is invalid', async () => {
    const { fetcher } = createFakeFetcher();

    await assert.rejects(
      async () => await new XRequest(fetcher, 'get', 'https://x.com/{id}').result(),
      (error: unknown) => error instanceof ValidationError && /id/.test(error.message),
    );
  });
});

describe('retries and error types', () => {
  it('should retry if the error is TimeoutError or NetworkError', async () => {
    for (const make of [() => new TimeoutError(1), () => new NetworkError('x')]) {
      const { fetcher, calls } = createFlakyFetcher(1, 'ok', make);

      const result = await new XRequest(fetcher, 'get', 'https://example.com').retries(2, 1);

      assert.equal(result, 'ok');
      assert.equal(calls.length, 2);
    }
  });

  it('should not retry if the error is ParseError', async () => {
    const { fetcher, calls } = createFlakyFetcher(10, undefined, () => new ParseError('{'));

    await assert.rejects(
      async () => await new XRequest(fetcher, 'get', 'https://example.com').retries(3, 1),
      ParseError,
    );
    assert.equal(calls.length, 1);
  });
});
