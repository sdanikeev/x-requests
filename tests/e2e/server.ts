import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Context = {
  req: IncomingMessage;
  res: ServerResponse;
  /** 1-based number of the request to this pathname */
  hit: number;
  url: URL;
  body: string;
};

export type Handler = (ctx: Context) => void | Promise<void>;

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const sendJson = (res: ServerResponse, status: number, data: unknown) => {
  if (res.destroyed) return;

  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

/**
 * Real HTTP server on an ephemeral port. Routes are matched by exact pathname;
 * every pathname has its own hit counter, so tests can assert how many requests
 * actually reached the wire (retries, deduplication, ...).
 */
export const startServer = async (routes: Record<string, Handler>) => {
  const hits = new Map<string, number>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const hit = (hits.get(url.pathname) ?? 0) + 1;

      hits.set(url.pathname, hit);

      const handler = routes[url.pathname];

      if (!handler) {
        sendJson(res, 404, { message: `no route ${url.pathname}` });

        return;
      }

      await handler({ req, res, hit, url, body: Buffer.concat(chunks).toString() });
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hitsOf: (pathname: string) => hits.get(pathname) ?? 0,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
};
