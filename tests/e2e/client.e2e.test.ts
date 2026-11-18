import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import xclient, { AbortError, HttpError, HttpStatus, authMiddleware, cacheMiddleware, circuitBreakerMiddleware, CircuitOpenError, isHttpError, loggerMiddleware } from '../../src/index.js';
import type { ServerResponse } from 'node:http';
import type { LogEntry } from '../../src/index.js';
import { sendJson, sleep, startServer } from './server.js';

type Item = { id: number; name: string };

interface Routes {
  '/items/{id}': {
    get: {
      path: { id: number };
      query?: { verbose?: boolean };
      response: Item;
      errors: { 404: { message: string } };
    };
  };
  '/items': {
    get: { response: Item[] };
    post: { body: { name: string }; response: Item };
  };
  '/files/{name}': { get: { path: { name: string }; response: { pathname: string } } };
  '/text': { get: { response: string } };
  '/empty': { delete: { response: undefined } };
  '/echo': { post: { body: Record<string, unknown>; response: { length: number; data: string } } };
  '/upload': { post: { response: { contentType: string; body: string } } };
  '/payments': { post: { response: { key: string | null; attempt: number } } };
  '/secure': { get: { response: { user: string } } };
  '/retry-after': { get: { response: { attempt: number } } };
  '/order': { post: { response: { attempt: number } } };
  '/order-safe': { post: { response: { attempt: number } } };
  '/broken': { get: { response: never } };
  '/no-store': { get: { response: { hit: number } } };
  '/sse/secure': { get: { events: { tick: { n: number } } } };
  '/cached': { get: { response: { hit: number } } };
  '/download': { get: { response: unknown } };
  '/headers': { get: { response: Record<string, string | null> } };
  '/flaky/{id}': { get: { path: { id: number }; response: { ok: true; attempt: number } } };
  '/always-503': { get: { response: never; errors: { default: { message: string } } } };
  '/missing': { get: { response: never } };
  '/slow': { get: { response: { ok: true } } };
  '/slow-then-fast': { get: { response: { attempt: number } } };
  '/reset': { get: { response: never } };
  '/bad-json': { get: { response: never } };
  '/rate-limited': { get: { response: { attempt: number } } };
  '/sse/feed': {
    get: { events: { tick: { n: number }; done: { total: number } } };
  };
  '/sse/drop': { get: { events: { tick: { n: number } } } };
  '/sse/forever': { get: { events: { tick: { n: number } } } };
  '/sse/fail': { get: { events: { tick: { n: number } } } };
}

const sse = (res: ServerResponse) => res.writeHead(200, { 'Content-Type': 'text/event-stream' });

describe('e2e: client against a real HTTP server', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let client: ReturnType<typeof xclient<Routes>>;

  before(async () => {
    server = await startServer({
      '/items/1': ({ res, url }) => sendJson(res, 200, {
        id: 1,
        name: url.searchParams.get('verbose') === 'true' ? 'verbose-item' : 'item',
      }),
      '/items/404': ({ res }) => sendJson(res, 404, { message: 'item not found' }),
      '/items': ({ req, res, body }) => {
        if (req.method === 'POST') {
          sendJson(res, 201, { id: 2, name: (JSON.parse(body) as { name: string }).name });

          return;
        }
        sendJson(res, 200, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
      },
      '/files/a%2Fb%20c%3F': ({ res, req }) => sendJson(res, 200, { pathname: req.url }),
      '/text': ({ res }) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello');
      },
      '/empty': ({ res }) => {
        res.writeHead(204);
        res.end();
      },
      '/echo': ({ res, body }) => sendJson(res, 200, { length: body.length, data: body }),
      '/upload': ({ req, res, body }) => sendJson(res, 200, { contentType: req.headers['content-type'] ?? '', body }),
      '/payments': ({ req, res, hit }) => hit === 1
        ? sendJson(res, 503, { message: 'try later' })
        : sendJson(res, 200, { key: (req.headers['idempotency-key'] as string | undefined) ?? null, attempt: hit }),
      '/secure': ({ req, res }) => req.headers.authorization === 'Bearer fresh'
        ? sendJson(res, 200, { user: 'me' })
        : sendJson(res, 401, { message: 'expired' }),
      '/cached': ({ res, hit }) => sendJson(res, 200, { hit }),
      '/retry-after': ({ res, hit }) => {
        if (hit > 1) return sendJson(res, 200, { attempt: hit });

        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end('{"message":"later"}');
      },
      '/order': ({ res, hit }) => hit === 1
        ? sendJson(res, 503, { message: 'try later' })
        : sendJson(res, 200, { attempt: hit }),
      '/order-safe': ({ res, hit }) => hit === 1
        ? sendJson(res, 503, { message: 'try later' })
        : sendJson(res, 200, { attempt: hit }),
      '/broken': ({ res }) => sendJson(res, 500, { message: 'broken' }),
      '/no-store': ({ res, hit }) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ hit }));
      },
      '/sse/secure': ({ req, res }) => {
        if (req.headers.authorization !== 'Bearer fresh') return sendJson(res, 401, { message: 'expired' });

        sse(res);
        res.end('event: tick\ndata: {"n":1}\n\n');
      },
      '/download': ({ res }) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from([0, 1, 2, 255]));
      },
      '/headers': ({ req, res }) => sendJson(res, 200, {
        contentType: req.headers['content-type'] ?? null,
        custom: (req.headers['x-custom'] as string | undefined) ?? null,
        authorization: req.headers.authorization ?? null,
      }),
      '/flaky/1': ({ res, hit }) => hit < 3
        ? sendJson(res, 503, { message: 'try later' })
        : sendJson(res, 200, { ok: true, attempt: hit }),
      '/always-503': ({ res }) => sendJson(res, 503, { message: 'down' }),
      '/slow': async ({ res }) => {
        await sleep(300);
        sendJson(res, 200, { ok: true });
      },
      '/slow-then-fast': async ({ res, hit }) => {
        if (hit === 1) await sleep(300);
        sendJson(res, 200, { attempt: hit });
      },
      '/reset': ({ req }) => {
        req.socket.destroy();
      },
      '/bad-json': ({ res }) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{oops');
      },
      '/rate-limited': ({ res, hit }) => hit === 1
        ? sendJson(res, HttpStatus.TOO_MANY_REQUESTS, { message: 'slow down' })
        : sendJson(res, 200, { attempt: hit }),
      '/sse/feed': ({ res }) => {
        sse(res);
        res.write(': hello\n\n');
        res.write('event: tick\nid: 1\ndata: {"n":1}\n\n');
        res.write('event: tick\nid: 2\ndata: {"n":2}\n\n');
        res.end('event: done\nid: 3\ndata: {"total":2}\n\n');
      },
      '/sse/drop': ({ req, res, hit }) => {
        sse(res);

        if (hit === 1) {
          res.write('retry: 5\nevent: tick\nid: 41\ndata: {"n":1}\n\n');
          setTimeout(() => req.socket.destroy(), 20);

          return;
        }

        res.end(`event: tick\nid: 42\ndata: {"n":${Number(req.headers['last-event-id'])}}\n\n`);
      },
      '/sse/forever': ({ res }) => {
        sse(res);
        res.write('event: tick\ndata: {"n":1}\n\n');
      },
      '/sse/fail': ({ res }) => sendJson(res, 503, { message: 'down' }),
    });

    client = xclient<Routes>({ config: { baseUrl: server.url } });
  });

  after(async () => {
    await server.close();
  });

  describe('basics', () => {
    it('should send path param and query and return a typed response if a GET request is made', async () => {
      const item = await client.get('/items/{id}', { id: 1 }).params({ verbose: true });

      assert.deepEqual(item, { id: 1, name: 'verbose-item' });
    });

    it('should deliver the json body and parse the 201 response if a POST request is made', async () => {
      const created = await client.post('/items').body({ name: 'new' });

      assert.deepEqual(created, { id: 2, name: 'new' });
    });

    it('should escape path params on the wire if they contain special characters', async () => {
      const result = await client.get('/files/{name}', { name: 'a/b c?' });

      assert.equal(result.pathname, '/files/a%2Fb%20c%3F');
    });

    it('should return a string for text/plain and undefined for 204 if the server responds so', async () => {
      assert.equal(await client.get('/text'), 'hello');
      assert.equal(await client.delete('/empty'), undefined);
    });

    it('should deliver custom headers and send Content-Type only if the request has a body', async () => {
      const withoutBody = await client.get('/headers').headers({ 'X-Custom': 'yes', 'Authorization': 'Bearer t' });

      assert.deepEqual(withoutBody, { contentType: null, custom: 'yes', authorization: 'Bearer t' });
    });

    it('should deliver the whole body if it is large (1 MB)', async () => {
      const big = 'x'.repeat(1_000_000);

      const result = await client.post('/echo').body({ big });

      assert.equal(JSON.parse(result.data).big.length, big.length);
    });
  });

  describe('files', () => {
    it('should send a multipart body with a boundary and the file if multipart() is used', async () => {
      const result = await client.post('/upload').multipart({
        title: 'cat',
        file: new File(['file-content'], 'cat.txt', { type: 'text/plain' }),
      });

      assert.match(result.contentType, /^multipart\/form-data; boundary=/);
      assert.match(result.body, /name="title"\r\n\r\ncat/);
      assert.match(result.body, /name="file"; filename="cat.txt"/);
      assert.match(result.body, /file-content/);
    });

    it('should return the exact bytes if responseType is blob', async () => {
      const blob = await client.get('/download').responseType('blob');

      assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 1, 2, 255]);
    });
  });

  describe('idempotency', () => {
    it('should send the key on the retried request if the first attempt failed', async () => {
      const result = await client.post('/payments').idempotent('order-1').retries(2, 1);

      assert.deepEqual(result, { key: 'order-1', attempt: 2 });
    });
  });

  describe('built-in middleware', () => {
    it('should refresh the token once and succeed if parallel requests get 401', async () => {
      let token = 'stale';
      let refreshed = 0;
      const secured = xclient<Routes>({
        config: {
          baseUrl: server.url,
          middleware: [
            authMiddleware({
              getToken: () => token,
              refresh: async () => {
                refreshed++;
                await sleep(10);
                token = 'fresh';

                return token;
              },
            }),
          ],
        },
      });

      const results = await Promise.all([secured.get('/secure'), secured.get('/secure'), secured.get('/secure')]);

      assert.deepEqual(results, [{ user: 'me' }, { user: 'me' }, { user: 'me' }]);
      assert.equal(refreshed, 1);
    });

    it('should send one request to the server if cacheMiddleware gets identical GETs', async () => {
      const cached = xclient<Routes>({
        config: { baseUrl: server.url, middleware: [cacheMiddleware({ ttl: 5000 })] },
      });
      const before = server.hitsOf('/cached');

      const results = await Promise.all([cached.get('/cached'), cached.get('/cached')]);
      const later = await cached.get('/cached');

      assert.deepEqual(results[0], results[1]);
      assert.deepEqual(later, results[0]);
      assert.equal(server.hitsOf('/cached') - before, 1);
    });
  });

  describe('response metadata for middleware', () => {
    it('should log the real status of a successful response if loggerMiddleware is used', async () => {
      const entries: LogEntry[] = [];
      const logged = xclient<Routes>({
        config: { baseUrl: server.url, middleware: [loggerMiddleware({ log: entry => entries.push(entry) })] },
      });

      await logged.post('/items').body({ name: 'x' });

      assert.equal(entries[0]?.status, 201);
    });

    it('should not cache a response if the server says no-store', async () => {
      const cached = xclient<Routes>({
        config: { baseUrl: server.url, middleware: [cacheMiddleware({ ttl: 5000 })] },
      });
      const before = server.hitsOf('/no-store');

      await cached.get('/no-store');
      await cached.get('/no-store');

      assert.equal(server.hitsOf('/no-store') - before, 2);
    });

    it('should reconnect a stream with a new token if the server answers 401', async () => {
      let token = 'stale';
      const secured = xclient<Routes>({
        config: {
          baseUrl: server.url,
          middleware: [authMiddleware({ getToken: () => token, refresh: () => (token = 'fresh') })],
        },
      });
      const received: unknown[] = [];

      for await (const item of secured.get('/sse/secure').stream()) received.push(item.data);

      assert.deepEqual(received, [{ n: 1 }]);
    });

    it('should keep the request of another caller alive if the first one is aborted while a shared call is pending', async () => {
      const cached = xclient<Routes>({
        config: { baseUrl: server.url, middleware: [cacheMiddleware({ ttl: 5000 })] },
      });
      const controller = new AbortController();

      const first = cached.get('/slow').signal(controller.signal).result();
      const second = cached.get('/slow').result();

      await sleep(20);
      controller.abort();

      assert.equal((await first).ok, false);
      assert.deepEqual(await second, { ok: true, data: { ok: true } });
    });
  });

  describe('reliable retries', () => {
    it('should wait for Retry-After before the next attempt if the server asks for it', async () => {
      const started = Date.now();
      const result = await client.get('/retry-after').retries(1, 10);

      assert.deepEqual(result, { attempt: 2 });
      assert.ok(Date.now() - started >= 950);
    });

    it('should not repeat a POST if it is not idempotent', async () => {
      const before = server.hitsOf('/order');
      const result = await client.post('/order').retries(2, 1).result();

      assert.ok(!result.ok);
      assert.equal(server.hitsOf('/order') - before, 1);
    });

    it('should repeat a POST if it is idempotent', async () => {
      const before = server.hitsOf('/order-safe');
      const result = await client.post('/order-safe').idempotent().retries(2, 1);

      assert.equal(server.hitsOf('/order-safe') - before, 2);
      assert.equal(result.attempt, 2);
    });

    it('should stop calling the server if the circuit breaker opens', async () => {
      const guarded = xclient<Routes>({
        config: { baseUrl: server.url, middleware: [circuitBreakerMiddleware({ failureThreshold: 2, resetTimeout: 60_000 })] },
      });
      const before = server.hitsOf('/broken');

      await guarded.get('/broken').result();
      await guarded.get('/broken').result();

      const refused = await guarded.get('/broken').result();

      assert.ok(!refused.ok && refused.error instanceof CircuitOpenError);
      assert.equal(server.hitsOf('/broken') - before, 2);
    });
  });

  describe('errors', () => {
    it('should throw HttpError with a typed body if the server responds with 404', async () => {
      const result = await client.get('/items/{id}', { id: 404 }).result();

      assert.ok(!result.ok);
      assert.ok(isHttpError(result.error, 404));
      assert.equal(result.error.data.message, 'item not found');
    });

    it('should not retry if the server responds with 404', async () => {
      const hitsBefore = server.hitsOf('/items/404');

      await client.get('/items/{id}', { id: 404 }).retries(3, 1).result();

      assert.equal(server.hitsOf('/items/404') - hitsBefore, 1);
    });

    it('should throw ParseError without retrying if the server returns invalid JSON', async () => {
      const result = await client.get('/bad-json').retries(3, 1).result();

      assert.ok(!result.ok);
      assert.equal(result.error.kind, 'parse');
      assert.equal(server.hitsOf('/bad-json'), 1);
    });

    it('should throw NetworkError and retry if the connection is dropped', async () => {
      const result = await client.get('/reset').retries(2, 1).result();

      assert.ok(!result.ok);
      assert.equal(result.error.kind, 'network');
      assert.equal(server.hitsOf('/reset'), 3);
    });

    it('should throw NetworkError if the server does not exist', async () => {
      const dead = xclient({ config: { baseUrl: 'http://127.0.0.1:1' } });

      const result = await dead.get('/x').result();

      assert.ok(!result.ok);
      assert.equal(result.error.kind, 'network');
    });
  });

  describe('retries', () => {
    it('should succeed on the third attempt if the server responds 503, 503, 200', async () => {
      const result = await client.get('/flaky/{id}', { id: 1 }).retries(3, 1);

      assert.deepEqual(result, { ok: true, attempt: 3 });
    });

    it('should retry if the server responds with 429', async () => {
      const result = await client.get('/rate-limited').retries(2, 1);

      assert.deepEqual(result, { attempt: 2 });
    });

    it('should make retries + 1 requests and throw the last error if retries are exhausted', async () => {
      const result = await client.get('/always-503').retries(2, 1).result();

      assert.ok(!result.ok);
      assert.ok(isHttpError(result.error, 503));
      assert.equal(result.error.data.message, 'down');
      assert.equal(server.hitsOf('/always-503'), 3);
    });

    it('should wait with exponential backoff between attempts if backoff is set', async () => {
      const started = Date.now();

      await client.get('/always-503').retries(3, 20, { jitter: false }).result();

      // pauses: 20 + 40 + 80 = 140 ms
      assert.ok(Date.now() - started >= 135, `too fast: ${Date.now() - started} ms`);
    });
  });

  describe('timeouts', () => {
    it('should throw TimeoutError if the server is slow', async () => {
      const started = Date.now();

      const result = await client.get('/slow').timeout(50).result();

      assert.ok(!result.ok);
      assert.equal(result.error.kind, 'timeout');
      assert.ok(Date.now() - started < 250, 'timeout must not wait for the server response');
    });

    it('should apply the timeout to every attempt and let a fast attempt win if retries are set', async () => {
      const result = await client.get('/slow-then-fast').timeout(50).retries(2, 1);

      assert.deepEqual(result, { attempt: 2 });
    });

    it('should send every attempt to the server if timeout and retries are combined', async () => {
      const hitsBefore = server.hitsOf('/slow');

      await client.get('/slow').timeout(30).retries(2, 1).result();

      assert.equal(server.hitsOf('/slow') - hitsBefore, 3);
    });
  });

  describe('cancellation', () => {
    it('should throw AbortError without waiting for the server if the signal fires', async () => {
      const controller = new AbortController();
      const started = Date.now();

      setTimeout(() => controller.abort(), 30);
      const result = await client.get('/slow').signal(controller.signal).result();

      assert.ok(!result.ok);
      assert.equal(result.error.kind, 'abort');
      assert.ok(Date.now() - started < 250, 'abort must not wait for the server response');
    });

    it('should not retry if the request is aborted', async () => {
      const controller = new AbortController();
      const hitsBefore = server.hitsOf('/slow');

      setTimeout(() => controller.abort(), 30);
      await client.get('/slow').signal(controller.signal).retries(3, 1).result();

      assert.equal(server.hitsOf('/slow') - hitsBefore, 1);
    });
  });

  describe('server-sent events', () => {
    it('should yield typed events and ignore comments if the server streams them', async () => {
      const events = [];

      for await (const event of client.get('/sse/feed').stream()) {
        events.push(event);
      }

      assert.deepEqual(events, [
        { event: 'tick', data: { n: 1 }, id: '1' },
        { event: 'tick', data: { n: 2 }, id: '2' },
        { event: 'done', data: { total: 2 }, id: '3' },
      ]);
    });

    it('should reconnect with Last-Event-ID after the connection drops', async () => {
      const events = [];

      for await (const event of client.get('/sse/drop').retries(2, 1000).stream()) {
        events.push(event.data.n);
      }

      assert.deepEqual(events, [1, 41]);
      assert.equal(server.hitsOf('/sse/drop'), 2);
    });

    it('should stop the stream and free the connection if the signal is aborted', async () => {
      const controller = new AbortController();
      const result = [];
      let error: unknown;

      try {
        for await (const event of client.get('/sse/forever').signal(controller.signal).stream()) {
          result.push(event.data.n);
          controller.abort();
        }
      } catch (caught) {
        error = caught;
      }

      assert.deepEqual(result, [1]);
      assert.ok(error instanceof AbortError);
    });

    it('should throw HttpError and not reconnect if the status is an error', async () => {
      const hitsBefore = server.hitsOf('/sse/fail');
      let error: unknown;

      try {
        for await (const event of client.get('/sse/fail').retries(1, 1).stream()) {
          assert.fail(`no events expected, got ${event.event}`);
        }
      } catch (caught) {
        error = caught;
      }

      assert.ok(isHttpError(error, 503));
      assert.equal(server.hitsOf('/sse/fail') - hitsBefore, 2);
    });
  });

  describe('fallbacks', () => {
    it('should use the fallback value if retries are exhausted', async () => {
      const hitsBefore = server.hitsOf('/always-503');

      const result = await client.get('/always-503').retries(1, 1).fallback({ cached: true });

      assert.deepEqual(result, { cached: true });
      assert.equal(server.hitsOf('/always-503') - hitsBefore, 2);
    });

    it('should pass the real HttpError to the fallback function if the request fails', async () => {
      const result = await client.get('/always-503').fallback(error => (
        error instanceof HttpError ? error.status : 0
      ));

      assert.equal(result, 503);
    });

    it('should not use the fallback if the request succeeds', async () => {
      const item = await client.get('/items/{id}', { id: 1 }).fallback(null);

      assert.equal(item?.id, 1);
    });
  });

  describe('concurrency', () => {
    it('should resolve independent requests if they are run with Promise.all', async () => {
      const [a, b, list] = await Promise.all([
        client.get('/items/{id}', { id: 1 }),
        client.post('/items').body({ name: 'p' }),
        client.get('/items'),
      ]);

      assert.equal(a.id, 1);
      assert.equal(b.name, 'p');
      assert.equal(list.length, 2);
    });

    it('should hit the server once if the same request is passed to Promise.all twice', async () => {
      const hitsBefore = server.hitsOf('/items');
      const request = client.get('/items');

      const [first, second] = await Promise.all([request, request]);

      assert.equal(first, second);
      assert.equal(server.hitsOf('/items') - hitsBefore, 1);
    });

    it('should not mix up responses if 200 requests run in parallel', async () => {
      const ids = Array.from({ length: 200 }, (_, i) => i);

      const results = await Promise.all(ids.map(async (i) => {
        const echo = await client.post('/echo').body({ i });

        return JSON.parse(echo.data).i as number;
      }));

      assert.deepEqual(results, ids);
    });

    it('should not affect parallel requests if one request retries', async () => {
      const [flaky, plain] = await Promise.all([
        client.get('/rate-limited').retries(2, 30),
        client.get('/items/{id}', { id: 1 }),
      ]);

      assert.ok(flaky.attempt >= 1);
      assert.equal(plain.id, 1);
    });
  });
});
