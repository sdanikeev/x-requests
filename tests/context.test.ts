import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Fetch from '../src/Fetch.js';
import XClient from '../src/XClient.js';
import type { Fetcher, FetcherRequestParams, ResponseContext } from '../src/types.js';
import { createFakeFetcher } from './helpers.js';

const realFetch = globalThis.fetch;

const mockFetch = (response: Response) => {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
};

describe('response context', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('should fill the status and the headers if Fetch gets a successful response', async () => {
    mockFetch(new Response('{"a":1}', { status: 201, headers: { 'Content-Type': 'application/json', 'X-Id': '7' } }));
    const context: ResponseContext = {};

    await new Fetch().request({ method: 'get', url: 'https://example.com' }, context);

    assert.equal(context.status, 201);
    assert.equal(context.headers?.get('x-id'), '7');
  });

  it('should fill the status and the headers before throwing if the response is an error', async () => {
    mockFetch(new Response('no', { status: 503, headers: { 'Retry-After': '3' } }));
    const context: ResponseContext = {};

    await assert.rejects(new Fetch().request({ method: 'get', url: 'https://example.com' }, context));

    assert.equal(context.status, 503);
    assert.equal(context.headers?.get('retry-after'), '3');
  });

  it('should fill the status if Fetch opens a stream', async () => {
    mockFetch(new Response('data: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const context: ResponseContext = {};

    for await (const item of new Fetch().stream({ method: 'get', url: 'https://example.com' }, context)) void item;

    assert.equal(context.status, 200);
  });

  it('should fill the status of a refused stream if the connection is rejected', async () => {
    mockFetch(new Response('no', { status: 401 }));
    const context: ResponseContext = {};

    await assert.rejects(async () => {
      for await (const item of new Fetch().stream({ method: 'get', url: 'https://example.com' }, context)) void item;
    });

    assert.equal(context.status, 401);
  });

  it('should not require a context if Fetch is called without one', async () => {
    mockFetch(new Response('ok'));

    assert.equal(await new Fetch().request({ method: 'get', url: 'https://example.com' }), 'ok');
  });

  it('should give middleware what the fetcher put into the context if it supports it', async () => {
    const fetcher: Fetcher = {
      async request<T>(_data: FetcherRequestParams, context?: ResponseContext) {
        if (context) context.status = 202;

        return 'body' as T;
      },
    };
    const client = new XClient(fetcher);
    const seen: (number | undefined)[] = [];

    client.use(async (data, next, context) => {
      const result = await next(data);

      seen.push(context.status);

      return result;
    });
    await client.get('https://example.com');

    assert.deepEqual(seen, [202]);
  });

  it('should give middleware an empty context if the fetcher does not support it', async () => {
    const { fetcher } = createFakeFetcher();
    const client = new XClient(fetcher);
    const seen: ResponseContext[] = [];

    client.use(async (data, next, context) => {
      const result = await next(data);

      seen.push({ ...context });

      return result;
    });
    await client.get('https://example.com');

    assert.deepEqual(seen, [{}]);
  });

  it('should give every attempt its own context if the request is retried', async () => {
    let attempt = 0;
    const fetcher: Fetcher = {
      async request<T>(_data: FetcherRequestParams, context?: ResponseContext) {
        attempt++;
        if (context) context.status = attempt;

        if (attempt === 1) throw new Error('down');

        return 'ok' as T;
      },
    };
    const client = new XClient(fetcher);
    const contexts = new Set<ResponseContext>();

    client.use(async (data, next, context) => {
      contexts.add(context);

      return next(data);
    });
    await client.get('https://example.com').retries(1, 1);

    assert.equal(contexts.size, 2);
  });
});
