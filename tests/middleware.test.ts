import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NetworkError } from '../src/errors.js';
import { compose } from '../src/middleware.js';
import type { Middleware } from '../src/middleware.js';
import XClient from '../src/XClient.js';
import xclient from '../src/index.js';
import { createFakeFetcher, createFlakyFetcher, createStreamFetcher } from './helpers.js';

describe('compose', () => {
  it('should call the last handler if there are no middlewares', async () => {
    const run = compose([], async data => data.url);

    assert.equal(await run({ method: 'get', url: '/a' }), '/a');
  });

  it('should wrap middlewares in registration order if several are composed', async () => {
    const order: string[] = [];
    const trace = (name: string): Middleware => async (data, next) => {
      order.push(`${name}:before`);
      const result = await next(data);
      order.push(`${name}:after`);

      return result;
    };

    await compose([trace('a'), trace('b')], async () => {
      order.push('fetch');
    })({ method: 'get', url: '/' });

    assert.deepEqual(order, ['a:before', 'b:before', 'fetch', 'b:after', 'a:after']);
  });

  it('should skip the rest of the chain if a middleware does not call next', async () => {
    let reached = false;
    const run = compose([async () => 'cached'], async () => {
      reached = true;
    });

    assert.equal(await run({ method: 'get', url: '/' }), 'cached');
    assert.equal(reached, false);
  });
});

describe('XClient middleware', () => {
  it('should send changes made by a middleware to the fetcher if it modifies the request', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher);

    client.use((data, next) => next({ ...data, headers: { ...data.headers, Authorization: 'Bearer t' } }));
    await client.get('https://example.com/a');

    assert.equal(calls[0]?.headers?.Authorization, 'Bearer t');
  });

  it('should pass the changed response to the caller if onResponse transforms it', async () => {
    const { fetcher } = createFakeFetcher({ name: 'x' });
    const client = new XClient(fetcher);

    client.onResponse(response => ({ wrapped: response }));

    assert.deepEqual(await client.get('https://example.com/a'), { wrapped: { name: 'x' } });
  });

  it('should change the request if onRequest returns a new one', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher);

    client.onRequest(async data => ({ ...data, url: `${data.url}?v=1` }));
    await client.get('https://example.com/a');

    assert.equal(calls[0]?.url, 'https://example.com/a?v=1');
  });

  it('should run onRequest in order and onResponse in reverse order if both are added twice', async () => {
    const { fetcher } = createFakeFetcher('');
    const client = new XClient(fetcher);
    const order: string[] = [];

    client.onRequest((data) => {
      order.push('req1');

      return data;
    });
    client.onRequest((data) => {
      order.push('req2');

      return data;
    });
    client.onResponse((response) => {
      order.push('res1');

      return response;
    });
    client.onResponse((response) => {
      order.push('res2');

      return response;
    });
    await client.get('https://example.com/a');

    assert.deepEqual(order, ['req1', 'req2', 'res2', 'res1']);
  });

  it('should stop calling a middleware if the returned function is called', async () => {
    const { fetcher } = createFakeFetcher();
    const client = new XClient(fetcher);
    let calls = 0;

    const off = client.use((data, next) => {
      calls++;
      return next(data);
    });
    await client.get('https://example.com/a');
    off();
    off();
    await client.get('https://example.com/a');

    assert.equal(calls, 1);
  });

  it('should apply a middleware added after the client was created if a request is made later', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher);

    await client.get('https://example.com/a');
    client.onRequest(data => ({ ...data, url: 'https://example.com/b' }));
    await client.get('https://example.com/a');

    assert.deepEqual(calls.map(call => call.url), ['https://example.com/a', 'https://example.com/b']);
  });

  it('should use middlewares from the config if they are passed to xclient', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = xclient({
      fetcher,
      config: { middleware: [(data, next) => next({ ...data, headers: { 'X-Trace': '1' } })] },
    });

    await client.get('https://example.com/a');

    assert.equal(calls[0]?.headers?.['X-Trace'], '1');
  });

  it('should not share middlewares between clients if they are created separately', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const middleware: Middleware[] = [];
    const first = new XClient(fetcher, { middleware });
    const second = new XClient(fetcher, { middleware });

    first.onRequest(data => ({ ...data, url: 'https://example.com/first' }));
    await second.get('https://example.com/a');

    assert.equal(calls[0]?.url, 'https://example.com/a');
    assert.equal(middleware.length, 0);
  });

  it('should run the middleware on every attempt if the request is retried', async () => {
    const { fetcher } = createFlakyFetcher(2);
    const client = new XClient(fetcher);
    let attempts = 0;

    client.onRequest((data) => {
      attempts++;
      return data;
    });
    await client.get('https://example.com/a').retries(2, 1);

    assert.equal(attempts, 3);
  });

  it('should turn an error thrown by a middleware into NetworkError if the request fails', async () => {
    const { fetcher } = createFakeFetcher();
    const client = new XClient(fetcher);

    client.use(async () => {
      throw new Error('boom');
    });

    const result = await client.get('https://example.com/a').result();

    assert.equal(result.ok, false);
    assert.ok(result.error instanceof NetworkError);
  });

  it('should mark the request as a stream for middleware but not for the fetcher if the request is a stream', async () => {
    const { fetcher, calls } = createStreamFetcher([[]]);
    const seen: (boolean | undefined)[] = [];
    const client = new XClient(fetcher);

    client.use((data, next) => {
      seen.push(data.stream);

      return next(data);
    });

    for await (const item of client.get('https://example.com/a').stream()) void item;

    assert.deepEqual(seen, [true]);
    assert.equal('stream' in (calls[0] ?? {}), false);
  });

  it('should not mark the request as a stream if it is a plain request', async () => {
    const { fetcher } = createFakeFetcher();
    const seen: (boolean | undefined)[] = [];
    const client = new XClient(fetcher);

    client.use((data, next) => {
      seen.push(data.stream);

      return next(data);
    });
    await client.get('https://example.com/a');

    assert.deepEqual(seen, [undefined]);
  });
});
