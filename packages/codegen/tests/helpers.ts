import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const spec = {
  openapi: '3.0.3',
  info: { title: 'Test', version: '1.0.0' },
  paths: {
    '/ping': {
      get: {
        operationId: 'ping',
        responses: {
          200: { description: 'ok', content: { 'text/plain': { schema: { type: 'string' } } } },
        },
      },
    },
  },
};

export const createTempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'x-requests-codegen-'));

  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

export const writeSpec = async (dir: string, name = 'openapi.json') => {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(spec));

  return path;
};

export const startSpecServer = async (status = 200) => {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(spec));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/openapi.json`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};

export const waitFor = async (condition: () => Promise<boolean> | boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) return true;

    await new Promise(resolve => setTimeout(resolve, 25));
  }

  return false;
};
