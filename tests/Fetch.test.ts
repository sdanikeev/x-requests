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

  it('возвращает распарсенный json', async () => {
    mockFetch(jsonResponse({ id: 1 }));

    const result = await new Fetch().request({ method: 'get', url: 'https://example.com' });

    assert.deepEqual(result, { id: 1 });
  });

  it('кидает ошибку со статусом при !ok', async () => {
    mockFetch(jsonResponse({ error: 'nope' }, 404));

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      /Status: 404/,
    );
  });

  it('ошибка !ok — HttpError с полем status и body', async () => {
    mockFetch(jsonResponse({ error: 'nope' }, 404));

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (err: unknown) => err instanceof HttpError && err.status === 404 && err.body.includes('nope'),
    );
  });

  it('добавляет params в query-string', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({
      method: 'get',
      url: 'https://example.com/users',
      params: { page: 2, q: 'a b', skip: undefined, nul: null },
    });

    assert.equal(calls[0]?.url, 'https://example.com/users?page=2&q=a+b');
  });

  it('сохраняет query, уже записанный в url', async () => {
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

  it('сериализует body в json', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({
      method: 'post',
      url: 'https://example.com',
      body: { a: 1 },
    });

    assert.equal(calls[0]?.init.body, '{"a":1}');
  });

  it('строковый body не оборачивается в кавычки повторно', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({ method: 'post', url: 'https://example.com', body: 'raw' });

    assert.equal(calls[0]?.init.body, 'raw');
  });

  it('ставит Content-Type: application/json по умолчанию', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({ method: 'post', url: 'https://example.com', body: {} });

    const headers = calls[0]?.init.headers as Headers;
    assert.equal(headers.get('content-type'), 'application/json');
  });

  it('не перезаписывает переданный Content-Type', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({
      method: 'post',
      url: 'https://example.com',
      headers: { 'Content-Type': 'text/plain' },
    });

    const headers = calls[0]?.init.headers as Headers;
    assert.equal(headers.get('content-type'), 'text/plain');
  });

  it('передаёт пользовательские заголовки', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({
      method: 'get',
      url: 'https://example.com',
      headers: { Authorization: 'Bearer x' },
    });

    const headers = calls[0]?.init.headers as Headers;
    assert.equal(headers.get('authorization'), 'Bearer x');
  });

  it('метод уходит в верхнем регистре (lowercase patch не нормализуется fetch)', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({ method: 'patch', url: 'https://example.com' });

    assert.equal(calls[0]?.init.method, 'PATCH');
  });

  it('не падает на ответе 204 без тела', async () => {
    mockFetch(new Response(null, {status: 204}));

    const result = await new Fetch().request({
      method: 'post',
      url: 'https://example.com',
    });

    assert.equal(result, undefined);
  });

  it('GET без body не отправляет Content-Type', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({method: 'get', url: 'https://example.com'});

    const headers = calls[0]?.init.headers as Headers;

    assert.equal(headers.has('content-type'), false);
  });

  it('timeout превращается в AbortSignal', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({ method: 'get', url: 'https://example.com', timeout: 1000 });

    assert.ok(calls[0]?.init.signal instanceof AbortSignal);
  });

  it('без timeout signal не передаётся', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({ method: 'get', url: 'https://example.com' });

    assert.equal(calls[0]?.init.signal, undefined);
  });

  it('запрос реально прерывается по timeout', async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com', timeout: 10 }),
    );
  });

  it('пропускает null и undefined в params', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({
      method: 'get',
      url: 'https://example.com',
      params: { a: 1, b: null, c: undefined },
    });

    assert.equal(calls[0]?.url, 'https://example.com/?a=1');
  });

  it('не-json ответ возвращается строкой', async () => {
    mockFetch(new Response('plain text', { headers: { 'Content-Type': 'text/plain' } }));

    const result = await new Fetch().request({ method: 'get', url: 'https://example.com' });

    assert.equal(result, 'plain text');
  });

  it('кидает понятную ошибку при невалидном json', async () => {
    mockFetch(new Response('{oops', { headers: { 'Content-Type': 'application/json' } }));

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      /Failed to parse JSON/,
    );
  });

  it('пустое тело с application/json не падает', async () => {
    mockFetch(new Response('', { headers: { 'Content-Type': 'application/json' } }));

    const result = await new Fetch().request({ method: 'get', url: 'https://example.com' });

    assert.equal(result, '');
  });

  it('ответ 205 без тела возвращает undefined', async () => {
    mockFetch(new Response(null, { status: 205 }));

    const result = await new Fetch().request({ method: 'post', url: 'https://example.com' });

    assert.equal(result, undefined);
  });

  it('не-json ответ возвращается строкой и для запроса с body', async () => {
    mockFetch(new Response('plain text', { headers: { 'Content-Type': 'text/plain' } }));

    const result = await new Fetch().request({
      method: 'post',
      url: 'https://example.com',
      body: { a: 1 },
    });

    assert.equal(result, 'plain text');
  });

  it('ответ без Content-Type возвращается строкой', async () => {
    mockFetch(new Response('raw'));

    const result = await new Fetch().request({ method: 'get', url: 'https://example.com' });

    assert.equal(result, 'raw');
  });

  it('json распарсивается независимо от наличия body в запросе', async () => {
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

  it('без method по умолчанию используется GET', async () => {
    mockFetch(jsonResponse({}));

    await new Fetch().request({ url: 'https://example.com' } as never);

    assert.equal(calls[0]?.init.method, 'GET');
  });

  it('отказ fetch не-Error значением -> NetworkError со строкой', async () => {
    globalThis.fetch = (async () => {
      throw 'boom';
    }) as unknown as typeof fetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof NetworkError && error.message === 'boom' && error.cause === 'boom',
    );
  });

  it('TimeoutError без заданного timeout не содержит мс в сообщении', async () => {
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

  it('сообщение TimeoutError содержит миллисекунды', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('aborted', 'TimeoutError');
    }) as typeof fetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com', timeout: 250 }),
      /after 250 ms/,
    );
  });

  it('HttpError без тела: data — пустая строка', async () => {
    mockFetch(new Response(null, { status: 500 }));

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof HttpError && error.data === '' && error.body === '',
    );
  });

  it('HttpError с пустым json-телом: data — пустая строка', async () => {
    mockFetch(new Response('', { status: 502, headers: { 'Content-Type': 'application/json' } }));

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com' }),
      (error: unknown) => error instanceof HttpError && error.data === '',
    );
  });
});
