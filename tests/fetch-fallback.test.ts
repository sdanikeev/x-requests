import { afterEach, before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import Fetch from '../src/Fetch.js';
import { HttpError, NetworkError } from '../src/errors.js';

// Real HTTP against a local server through the `node-fetch` fallback
// (used when there is no global `fetch`).
const realFetch = globalThis.fetch;
let server: Server;
let base: string;

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/missing') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"message":"nf"}');

        return;
      }
      if (req.url === '/empty') {
        res.writeHead(204);
        res.end();

        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'] ?? null,
        body: Buffer.concat(chunks).toString(),
      }));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Fetch без глобального fetch (node-fetch)', () => {
  it('GET с query-параметрами', async () => {
    globalThis.fetch = undefined as never;

    const result = await new Fetch().request<{ method: string; url: string; contentType: string | null }>({
      method: 'get',
      url: `${base}/items`,
      params: { page: 2 },
    });

    assert.equal(result.method, 'GET');
    assert.equal(result.url, '/items?page=2');
    assert.equal(result.contentType, null);
  });

  it('POST отправляет json body и Content-Type', async () => {
    globalThis.fetch = undefined as never;

    const result = await new Fetch().request<{ body: string; contentType: string }>({
      method: 'post',
      url: `${base}/items`,
      body: { a: 1 },
    });

    assert.equal(result.contentType, 'application/json');
    assert.deepEqual(JSON.parse(result.body), { a: 1 });
  });

  it('HttpError с распарсенным телом', async () => {
    globalThis.fetch = undefined as never;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: `${base}/missing` }),
      (error: unknown) => error instanceof HttpError
        && error.status === 404
        && (error.data as { message: string }).message === 'nf',
    );
  });

  it('204 -> undefined', async () => {
    globalThis.fetch = undefined as never;

    assert.equal(await new Fetch().request({ method: 'post', url: `${base}/empty` }), undefined);
  });

  it('недоступный сервер -> NetworkError', async () => {
    globalThis.fetch = undefined as never;
    const dead = createServer();

    await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', resolve));
    const { port } = dead.address() as AddressInfo;

    await new Promise(resolve => dead.close(resolve));

    await assert.rejects(
      new Fetch().request({ method: 'get', url: `http://127.0.0.1:${port}/` }),
      NetworkError,
    );
  });
});
