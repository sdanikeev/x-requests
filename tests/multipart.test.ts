import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Fetch from '../src/Fetch.js';
import XClient from '../src/XClient.js';
import { createFakeFetcher, createFlakyFetcher } from './helpers.js';
import { NetworkError } from '../src/errors.js';

type Call = { url: string; init: RequestInit };

const realFetch = globalThis.fetch;
let calls: Call[];

const mockFetch = (response: () => Response) => {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });

    return response();
  }) as typeof fetch;
};

const contentTypeOf = (call: Call | undefined) => new Headers(call?.init.headers).get('Content-Type');

describe('multipart', () => {
  it('should convert an object to FormData if multipart() gets an object', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XClient(fetcher).post('https://example.com/upload').multipart({
      title: 'cat',
      count: 2,
      draft: false,
      tags: ['a', 'b'],
      file: new File(['abc'], 'cat.txt', { type: 'text/plain' }),
    });

    const form = calls[0]?.body as FormData;

    assert.ok(form instanceof FormData);
    assert.equal(form.get('title'), 'cat');
    assert.equal(form.get('count'), '2');
    assert.equal(form.get('draft'), 'false');
    assert.deepEqual(form.getAll('tags'), ['a', 'b']);
    assert.equal((form.get('file') as File).name, 'cat.txt');
  });

  it('should skip a field if its value is null or undefined', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XClient(fetcher).post('https://example.com/upload').multipart({ a: null, b: undefined, c: 'x' });

    assert.deepEqual([...(calls[0]?.body as FormData).keys()], ['c']);
  });

  it('should pass the same FormData through if multipart() gets a FormData', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const form = new FormData();

    await new XClient(fetcher).post('https://example.com/upload').multipart(form);

    assert.equal(calls[0]?.body, form);
  });

  it('should send the same FormData on every attempt if the request is retried', async () => {
    const { fetcher, calls } = createFlakyFetcher(2, { ok: true }, () => new NetworkError('down'));

    await new XClient(fetcher).post('https://example.com/upload').multipart({ a: '1' }).idempotent().retries(2, 1);

    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.body, calls[2]?.body);
  });
});

describe('Fetch body and response types', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('should not set Content-Type if the body is FormData', async () => {
    mockFetch(() => new Response('ok'));

    await new Fetch().request({ method: 'post', url: 'https://example.com', body: new FormData() });

    assert.equal(contentTypeOf(calls[0]), null);
  });

  it('should not set Content-Type if the body is a Blob or URLSearchParams', async () => {
    mockFetch(() => new Response('ok'));

    await new Fetch().request({ method: 'post', url: 'https://example.com', body: new Blob(['x']) });
    await new Fetch().request({ method: 'post', url: 'https://example.com', body: new URLSearchParams({ a: '1' }) });

    assert.equal(contentTypeOf(calls[0]), null);
    assert.equal(contentTypeOf(calls[1]), null);
  });

  it('should send the body as is if it is a Blob', async () => {
    mockFetch(() => new Response('ok'));
    const blob = new Blob(['x']);

    await new Fetch().request({ method: 'post', url: 'https://example.com', body: blob });

    assert.equal(calls[0]?.init.body, blob);
  });

  it('should keep the json Content-Type if the body is an object', async () => {
    mockFetch(() => new Response('ok'));

    await new Fetch().request({ method: 'post', url: 'https://example.com', body: { a: 1 } });

    assert.equal(contentTypeOf(calls[0]), 'application/json');
  });

  it('should return a Blob if responseType is blob', async () => {
    mockFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'application/octet-stream' } }));

    const result = await new Fetch().request<Blob>({ method: 'get', url: 'https://example.com', responseType: 'blob' });

    assert.ok(result instanceof Blob);
    assert.equal(result.size, 3);
  });

  it('should return an ArrayBuffer if responseType is arrayBuffer', async () => {
    mockFetch(() => new Response(new Uint8Array([1, 2, 3])));

    const result = await new Fetch().request<ArrayBuffer>({
      method: 'get',
      url: 'https://example.com',
      responseType: 'arrayBuffer',
    });

    assert.deepEqual([...new Uint8Array(result)], [1, 2, 3]);
  });

  it('should return raw text if responseType is text and the response is json', async () => {
    mockFetch(() => new Response('{"a":1}', { headers: { 'Content-Type': 'application/json' } }));

    const result = await new Fetch().request({ method: 'get', url: 'https://example.com', responseType: 'text' });

    assert.equal(result, '{"a":1}');
  });

  it('should throw an HttpError with the text body if responseType is blob and the status is an error', async () => {
    mockFetch(() => new Response('nope', { status: 500 }));

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com', responseType: 'blob' }),
      /Status: 500/,
    );
  });

  it('should return undefined if responseType is blob and the status is 204', async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const result = await new Fetch().request({ method: 'get', url: 'https://example.com', responseType: 'blob' });

    assert.equal(result, undefined);
  });
});
