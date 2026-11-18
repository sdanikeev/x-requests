import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HttpError, NetworkError, TimeoutError } from '../src/errors.js';
import Fetch from '../src/Fetch.js';

type Call = { url: string; init: RequestInit };

const realFetch = globalThis.fetch;
let calls: Call[];

const mockFetch = (response: Response) => {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as typeof fetch;
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('Fetch', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('should return parsed json if the response is json', async () => {
    mockFetch(jsonResponse({ id: 1 }));

    const result = await new Fetch().request({ method: 'get', url: 'https://example.com' });

    assert.deepEqual(result, { id: 1 });
  });

  it('should throw an error with the status if the response is not ok', async () => {
    mockFetch(jsonResponse({ error: 'nope' }, 404));

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      /Status: 404/,
    );
  });

  it('should throw HttpError with status and body if the response is not ok', async () => {
    mockFetch(jsonResponse({ error: 'nope' }, 404));

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (err: unknown) => err instanceof HttpError && err.status === 404 && err.body.includes('nope'),
    );
  });

  it('should add params to the query string if params are given', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({
      method: 'get',
      url: 'https://example.com/users',
      params: { page: 2, q: 'a b', skip: undefined, nul: null },
    });

    assert.equal(calls[0]?.url, 'https://example.com/users?page=2&q=a+b');
  });

  it('should keep the query already present in the url if params are given', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({
      method: 'get',
      url: 'https://example.com/users?sort=asc',
      params: { page: 1 },
    });

    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get('sort'), 'asc');
    assert.equal(url.searchParams.get('page'), '1');
  });

  it('should serialize the body to json if a body is given', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({
      method: 'post',
      url: 'https://example.com',
      body: { a: 1 },
    });

    assert.equal(calls[0]?.init.body, '{"a":1}');
  });

  it('should not quote a string body again if the body is a string', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({ method: 'post', url: 'https://example.com', body: 'raw' });

    assert.equal(calls[0]?.init.body, 'raw');
  });

  it('should set Content-Type to application/json if none is passed', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({ method: 'post', url: 'https://example.com', body: {} });

    const headers = calls[0]?.init.headers as Headers;
    assert.equal(headers.get('content-type'), 'application/json');
  });

  it('should not override Content-Type if it is passed explicitly', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({
      method: 'post',
      url: 'https://example.com',
      headers: { 'Content-Type': 'text/plain' },
    });

    const headers = calls[0]?.init.headers as Headers;
    assert.equal(headers.get('content-type'), 'text/plain');
  });

  it('should send custom headers if they are passed', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({
      method: 'get',
      url: 'https://example.com',
      headers: { Authorization: 'Bearer x' },
    });

    const headers = calls[0]?.init.headers as Headers;
    assert.equal(headers.get('authorization'), 'Bearer x');
  });

  it('should send the method in upper case if it is given in lower case', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({ method: 'patch', url: 'https://example.com' });

    assert.equal(calls[0]?.init.method, 'PATCH');
  });

  it('should not fail if the response is 204 without a body', async () => {
    mockFetch(new Response(null, {status: 204}));

    const result = await new Fetch().request({
      method: 'post',
      url: 'https://example.com',
    });

    assert.equal(result, undefined);
  });

  it('should not send Content-Type if a GET request has no body', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({method: 'get', url: 'https://example.com'});

    const headers = calls[0]?.init.headers as Headers;

    assert.equal(headers.has('content-type'), false);
  });

  it('should pass an AbortSignal if timeout is set', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({ method: 'get', url: 'https://example.com', timeout: 1000 });

    assert.ok(calls[0]?.init.signal instanceof AbortSignal);
  });

  it('should not pass a signal if timeout is not set', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({ method: 'get', url: 'https://example.com' });

    assert.equal(calls[0]?.init.signal, undefined);
  });

  it('should abort the request if the timeout elapses', async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com', timeout: 10 }),
    );
  });

  it('should skip null and undefined values if they are in params', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({
      method: 'get',
      url: 'https://example.com',
      params: { a: 1, b: null, c: undefined },
    });

    assert.equal(calls[0]?.url, 'https://example.com/?a=1');
  });

  it('should return a string if the response is not json', async () => {
    mockFetch(new Response('plain text', { headers: { 'Content-Type': 'text/plain' } }));

    const result = await new Fetch().request({ method: 'get', url: 'https://example.com' });

    assert.equal(result, 'plain text');
  });

  it('should throw a clear error if the json is invalid', async () => {
    mockFetch(new Response('{oops', { headers: { 'Content-Type': 'application/json' } }));

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      /Failed to parse JSON/,
    );
  });

  it('should not fail if the body is empty with application/json', async () => {
    mockFetch(new Response('', { headers: { 'Content-Type': 'application/json' } }));

    const result = await new Fetch().request({ method: 'get', url: 'https://example.com' });

    assert.equal(result, '');
  });

  it('should return undefined if the response is 205 without a body', async () => {
    mockFetch(new Response(null, { status: 205 }));

    const result = await new Fetch().request({ method: 'post', url: 'https://example.com' });

    assert.equal(result, undefined);
  });

  it('should return a string if the response is not json and the request has a body', async () => {
    mockFetch(new Response('plain text', { headers: { 'Content-Type': 'text/plain' } }));

    const result = await new Fetch().request({
      method: 'post',
      url: 'https://example.com',
      body: { a: 1 },
    });

    assert.equal(result, 'plain text');
  });

  it('should return a string if the response has no Content-Type', async () => {
    mockFetch(new Response('raw'));

    const result = await new Fetch().request({ method: 'get', url: 'https://example.com' });

    assert.equal(result, 'raw');
  });

  it('should parse json if the response is json regardless of the request body', async () => {
    for (const body of [undefined, { a: 1 }]) {
      mockFetch(jsonResponse({ ok: 1 }));

      const result = await new Fetch().request({
        method: 'post',
        url: 'https://example.com',
        ...(body && { body }),
      });

      assert.deepEqual(result, { ok: 1 });
    }
  });

  it('should use GET if no method is given', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({ url: 'https://example.com' } as never);

    assert.equal(calls[0]?.init.method, 'GET');
  });

  it('should throw NetworkError with a string message if fetch rejects with a non-Error value', async () => {
    globalThis.fetch = (async () => {
      throw 'boom';
    }) as unknown as typeof fetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof NetworkError && error.message === 'boom' && error.cause === 'boom',
    );
  });

  it('should omit milliseconds from the TimeoutError message if no timeout is set', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('aborted', 'TimeoutError');
    }) as typeof fetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof TimeoutError
        && error.timeoutMs === undefined
        && error.message === 'Request timed out',
    );
  });

  it('should include milliseconds in the TimeoutError message if a timeout is set', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('aborted', 'TimeoutError');
    }) as typeof fetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com', timeout: 250 }),
      /after 250 ms/,
    );
  });

  it('should set data to an empty string if the HttpError has no body', async () => {
    mockFetch(new Response(null, { status: 500 }));

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof HttpError && error.data === '' && error.body === '',
    );
  });

  it('should set data to an empty string if the HttpError has an empty json body', async () => {
    mockFetch(new Response('', { status: 502, headers: { 'Content-Type': 'application/json' } }));

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof HttpError && error.data === '',
    );
  });
});
