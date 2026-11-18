import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import xclient, { HttpError, HttpStatus, isHttpError } from '../../src/index.js';
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
  '/headers': { get: { response: Record<string, string | null> } };
  '/flaky/{id}': { get: { path: { id: number }; response: { ok: true; attempt: number } } };
  '/always-503': { get: { response: never; errors: { default: { message: string } } } };
  '/missing': { get: { response: never } };
  '/slow': { get: { response: { ok: true } } };
  '/slow-then-fast': { get: { response: { attempt: number } } };
  '/reset': { get: { response: never } };
  '/bad-json': { get: { response: never } };
  '/rate-limited': { get: { response: { attempt: number } } };
}

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

      await client.get('/always-503').retries(3, 20).result();

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
