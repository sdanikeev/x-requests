import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AbortError, HttpError, NetworkError, ParseError, TimeoutError, ValidationError } from '../src/errors.js';
import Fetch from '../src/Fetch.js';
import XClient from '../src/XClient.js';
import type { SseEvent } from '../src/types.js';
import { createFakeFetcher, createStreamFetcher, event } from './helpers.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const collect = async <T>(stream: AsyncIterable<T>) => {
  const items: T[] = [];

  for await (const item of stream) items.push(item);

  return items;
};

const sseResponse = (body: string | ReadableStream<Uint8Array>, init: ResponseInit = {}) =>
  new Response(body, { headers: { 'Content-Type': 'text/event-stream' }, ...init });

describe('XRequest.stream()', () => {
  it('should yield parsed json events if the route streams json', async () => {
    const { fetcher } = createStreamFetcher([[event('{"a":1}'), event('{"a":2}', { event: 'update', id: '2' })]]);

    const events = await collect(new XClient(fetcher).get('https://example.com/events').stream());

    assert.deepEqual(events, [
      { event: 'message', data: { a: 1 } },
      { event: 'update', data: { a: 2 }, id: '2' },
    ]);
  });

  it('should yield raw strings if json is disabled', async () => {
    const { fetcher } = createStreamFetcher([[event('[DONE]')]]);

    const events = await collect(new XClient(fetcher).get('https://example.com/events').stream({ json: false }));

    assert.deepEqual(events, [event('[DONE]')]);
  });

  it('should keep empty data as an empty string if json is enabled', async () => {
    const { fetcher } = createStreamFetcher([[event('')]]);

    const events = await collect(new XClient(fetcher).get('https://example.com/events').stream());

    assert.deepEqual(events.map(item => item.data), ['']);
  });

  it('should throw ParseError and not reconnect if an event is not valid json', async () => {
    const { fetcher, calls } = createStreamFetcher([[event('{oops')], [event('{}')]]);

    await assert.rejects(collect(new XClient(fetcher).get('https://example.com/events').retries(2, 1).stream()), ParseError);
    assert.equal(calls.length, 1);
  });

  it('should send the url, method, params and headers to the fetcher if they are set', async () => {
    const { fetcher, calls } = createStreamFetcher([[]]);

    await collect(new XClient(fetcher, { baseUrl: 'https://example.com' })
      .get('/events/{id}', { id: 3 })
      .params({ q: 1 })
      .headers({ Authorization: 'x' })
      .stream());

    assert.equal(calls[0]?.url, 'https://example.com/events/3');
    assert.equal(calls[0]?.method, 'get');
    assert.deepEqual(calls[0]?.params, { q: 1 });
    assert.deepEqual(calls[0]?.headers, { Authorization: 'x' });
  });

  it('should reconnect with Last-Event-ID and keep the other headers if the connection fails', async () => {
    const { fetcher, calls } = createStreamFetcher([
      [event('{"n":1}', { id: '10' }), new NetworkError('reset')],
      [event('{"n":2}', { id: '11' })],
    ]);

    const events = await collect(new XClient(fetcher)
      .get('https://example.com/events')
      .headers({ Authorization: 'x' })
      .retries(2, 1)
      .stream());

    assert.deepEqual(events.map(item => item.data), [{ n: 1 }, { n: 2 }]);
    assert.equal(calls[0]?.headers?.['Last-Event-ID'], undefined);
    assert.deepEqual(calls[1]?.headers, { 'Authorization': 'x', 'Last-Event-ID': '10' });
  });

  it('should wait for the retry hint of the server if the stream sent one', async () => {
    const { fetcher } = createStreamFetcher([
      [event('1', { retry: 40 }), new NetworkError('reset')],
      [event('2')],
    ]);
    const started = Date.now();

    await collect(new XClient(fetcher).get('https://example.com/events').retries(1, 5000).stream({ json: false }));

    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 35 && elapsed < 1000, `waited ${elapsed} ms`);
  });

  it('should give up with the last error if reconnects are exhausted', async () => {
    const { fetcher, calls } = createStreamFetcher([[new NetworkError('1')], [new NetworkError('2')], [new NetworkError('3')]]);

    await assert.rejects(
      collect(new XClient(fetcher).get('https://example.com/events').retries(2, 1).stream()),
      (error: unknown) => error instanceof NetworkError && error.message === '3',
    );
    assert.equal(calls.length, 3);
  });

  it('should count only consecutive failures if events arrive between them', async () => {
    const { fetcher, calls } = createStreamFetcher([
      [event('1'), new NetworkError('a')],
      [event('2'), new NetworkError('b')],
      [event('3')],
    ]);

    const events = await collect(new XClient(fetcher).get('https://example.com/events').retries(1, 1).stream({ json: false }));

    assert.equal(events.length, 3);
    assert.equal(calls.length, 3);
  });

  it('should not reconnect if retries are not set', async () => {
    const { fetcher, calls } = createStreamFetcher([[new NetworkError('reset')], [event('1')]]);

    await assert.rejects(collect(new XClient(fetcher).get('https://example.com/events').stream()), NetworkError);
    assert.equal(calls.length, 1);
  });

  it('should not reconnect if the status is not worth retrying', async () => {
    const { fetcher, calls } = createStreamFetcher([[new HttpError(404, '')], [event('1')]]);

    await assert.rejects(collect(new XClient(fetcher).get('https://example.com/events').retries(2, 1).stream()), HttpError);
    assert.equal(calls.length, 1);
  });

  it('should end without reconnecting if the server closes the stream normally', async () => {
    const { fetcher, calls } = createStreamFetcher([[event('1')], [event('2')]]);

    const events = await collect(new XClient(fetcher).get('https://example.com/events').retries(3, 1).stream({ json: false }));

    assert.equal(events.length, 1);
    assert.equal(calls.length, 1);
  });

  it('should throw AbortError and not open a connection if the signal is already aborted', async () => {
    const { fetcher, calls } = createStreamFetcher([[event('1')]]);

    await assert.rejects(
      collect(new XClient(fetcher).get('https://example.com/events').signal(AbortSignal.abort()).stream()),
      AbortError,
    );
    assert.equal(calls.length, 0);
  });

  it('should stop waiting for the reconnect if the signal is aborted during the pause', async () => {
    const controller = new AbortController();
    const { fetcher } = createStreamFetcher([[new NetworkError('reset')], [event('1')]]);
    const started = Date.now();

    setTimeout(() => controller.abort(), 20);

    await assert.rejects(
      collect(new XClient(fetcher).get('https://example.com/events').signal(controller.signal).retries(2, 5000).stream()),
      AbortError,
    );
    assert.ok(Date.now() - started < 1000);
  });

  it('should throw ValidationError if the fetcher cannot stream', async () => {
    const { fetcher } = createFakeFetcher();

    await assert.rejects(collect(new XClient(fetcher).get('https://example.com/events').stream()), ValidationError);
  });

  it('should throw ValidationError if the request is invalid', async () => {
    const { fetcher } = createStreamFetcher([[]]);

    await assert.rejects(collect(new XClient(fetcher).get('').stream()), ValidationError);
  });

  it('should pass the stream through middlewares if any are registered', async () => {
    const { fetcher, calls } = createStreamFetcher([[event('1')]]);
    const client = new XClient(fetcher);
    const order: string[] = [];

    client.onRequest((data) => {
      order.push('request');

      return { ...data, headers: { ...data.headers, 'X-Trace': '1' } };
    });
    client.onResponse((response) => {
      order.push('response');

      return response;
    });

    await collect(client.get('https://example.com/events').stream({ json: false }));

    assert.deepEqual(order, ['request', 'response']);
    assert.equal(calls[0]?.headers?.['X-Trace'], '1');
  });

  it('should throw ValidationError if a middleware wraps a fetcher that cannot stream', async () => {
    const { fetcher } = createFakeFetcher();
    const client = new XClient(fetcher);

    client.use((data, next) => next(data));

    await assert.rejects(collect(client.get('https://example.com/events').stream()), ValidationError);
  });
});

describe('Fetch.stream()', () => {
  const stream = (url = 'https://example.com/events', extra: Partial<Parameters<Fetch['stream']>[0]> = {}) =>
    new Fetch().stream({ method: 'get', url, ...extra });

  it('should request text/event-stream and yield events if the response is a stream', async () => {
    const calls: { url: string; init: RequestInit }[] = [];

    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });

      return sseResponse('event: a\ndata: 1\n\ndata: 2\n\n');
    }) as typeof fetch;

    const events = await collect(stream('https://example.com/events', { params: { q: 'x' } }));

    assert.deepEqual(events, [{ event: 'a', data: '1' }, { event: 'message', data: '2' }]);
    assert.equal(calls[0]?.url, 'https://example.com/events?q=x');
    assert.equal(calls[0]?.init.method, 'GET');
    assert.equal(new Headers(calls[0]?.init.headers).get('accept'), 'text/event-stream');
  });

  it('should keep the Accept header if the caller passes one', async () => {
    let headers: Headers | undefined;

    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      headers = new Headers(init.headers);

      return sseResponse('');
    }) as typeof fetch;

    await collect(stream('https://example.com/events', { headers: { Accept: 'text/plain' } }));

    assert.equal(headers?.get('accept'), 'text/plain');
  });

  it('should send the body if a POST stream has one', async () => {
    let init: RequestInit | undefined;

    globalThis.fetch = (async (_url: string, requestInit: RequestInit) => {
      init = requestInit;

      return sseResponse('');
    }) as typeof fetch;

    await collect(new Fetch().stream({ method: 'post', url: 'https://example.com/chat', body: { a: 1 } }));

    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, '{"a":1}');
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
  });

  it('should end without events if the response has no body', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

    assert.deepEqual(await collect(stream()), []);
  });

  it('should throw HttpError with a parsed body if the status is not ok', async () => {
    globalThis.fetch = (async () => new Response('{"message":"no"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    await assert.rejects(
      collect(stream()),
      (error: unknown) => error instanceof HttpError && error.status === 503 && (error.data as { message: string }).message === 'no',
    );
  });

  it('should keep a non-json error body as text if the status is not ok', async () => {
    globalThis.fetch = (async () => new Response('down', { status: 500 })) as typeof fetch;

    await assert.rejects(collect(stream()), (error: unknown) => error instanceof HttpError && error.data === 'down');
  });

  it('should throw NetworkError if the connection cannot be opened', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    await assert.rejects(collect(stream()), (error: unknown) => error instanceof NetworkError && error.message === 'fetch failed');
  });

  it('should stringify a non-Error rejection of fetch if it rejects with a string', async () => {
    globalThis.fetch = (async () => {
      throw 'boom';
    }) as typeof fetch;

    await assert.rejects(collect(stream()), (error: unknown) => error instanceof NetworkError && error.message === 'boom');
  });

  it('should throw NetworkError if the connection drops in the middle of the stream', async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('data: 1\n\n'));
        else controller.error(new Error('socket hang up'));
      },
    });

    globalThis.fetch = (async () => sseResponse(body)) as typeof fetch;

    const received: SseEvent<string>[] = [];

    await assert.rejects(
      (async () => {
        for await (const item of stream()) received.push(item);
      })(),
      (error: unknown) => error instanceof NetworkError && error.message === 'socket hang up',
    );
    assert.equal(received.length, 1);
  });

  it('should throw TimeoutError if the connection is not established in time', async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as typeof fetch;

    await assert.rejects(
      collect(stream('https://example.com/events', { timeout: 20 })),
      (error: unknown) => error instanceof TimeoutError && error.timeoutMs === 20,
    );
  });

  it('should not apply the timeout to the stream itself if the connection is already open', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('data: late\n\n'));
          controller.close();
        }, 60);
      },
    });

    globalThis.fetch = (async () => sseResponse(body)) as typeof fetch;

    const events = await collect(stream('https://example.com/events', { timeout: 20 }));

    assert.deepEqual(events.map(item => item.data), ['late']);
  });

  it('should throw AbortError if the signal is aborted while the stream is open', async () => {
    const controller = new AbortController();

    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          init.signal?.addEventListener('abort', () => streamController.error(init.signal?.reason));
        },
      });

      return sseResponse(body);
    }) as typeof fetch;

    setTimeout(() => controller.abort(new Error('stop')), 20);

    await assert.rejects(
      collect(stream('https://example.com/events', { signal: controller.signal })),
      (error: unknown) => error instanceof AbortError && (error.cause as Error).message === 'stop',
    );
  });

  it('should throw AbortError if the signal is already aborted', async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      if (init.signal?.aborted) reject(init.signal.reason);
    })) as typeof fetch;

    await assert.rejects(collect(stream('https://example.com/events', { signal: AbortSignal.abort() })), AbortError);
  });

  it('should close the connection if the consumer stops reading early', async () => {
    let aborted = false;

    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
      });

      return sseResponse(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\n'));
        },
      }));
    }) as typeof fetch;

    for await (const item of stream()) {
      assert.equal(item.data, '1');
      break;
    }

    assert.equal(aborted, true);
  });

  it('should read a stream that is not a web stream if the body is only async iterable', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: (async function* () {
        yield Buffer.from('data: node\n\n');
      })(),
    })) as unknown as typeof fetch;

    assert.deepEqual((await collect(stream())).map(item => item.data), ['node']);
  });
});
