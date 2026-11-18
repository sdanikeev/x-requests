import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HttpError, NetworkError } from '../src/errors.js';
import { loggerMiddleware } from '../src/middlewares/logger.js';
import type { LogEntry } from '../src/middlewares/logger.js';
import XClient from '../src/XClient.js';
import type { Fetcher, FetcherRequestParams, ResponseContext } from '../src/types.js';
import { createFakeFetcher, createFlakyFetcher, createStreamFetcher, event } from './helpers.js';

const url = 'https://example.com/items';

const setup = (...args: Parameters<typeof loggerMiddleware>) => {
  const entries: LogEntry[] = [];
  const middleware = loggerMiddleware({ log: entry => entries.push(entry), ...args[0] });

  return { entries, middleware };
};

describe('loggerMiddleware', () => {
  it('should log the method, the url and ok if the request succeeds', async () => {
    const { fetcher } = createFakeFetcher();
    const { entries, middleware } = setup();

    await new XClient(fetcher, { middleware: [middleware] }).post(url);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.method, 'POST');
    assert.equal(entries[0]?.url, url);
    assert.equal(entries[0]?.ok, true);
    assert.equal(entries[0]?.stream, false);
    assert.equal(typeof entries[0]?.durationMs, 'number');
  });

  it('should log the status and the error if the request fails with an HttpError', async () => {
    const { fetcher } = createFlakyFetcher(1, {}, () => new HttpError(404, 'no', 'no'));
    const { entries, middleware } = setup();

    await assert.rejects(async () => new XClient(fetcher, { middleware: [middleware] }).get(url));

    assert.equal(entries[0]?.ok, false);
    assert.equal(entries[0]?.status, 404);
    assert.ok(entries[0]?.error instanceof HttpError);
  });

  it('should log every attempt if the request is retried', async () => {
    const { fetcher } = createFlakyFetcher(2, {}, () => new NetworkError('down'));
    const { entries, middleware } = setup();

    await new XClient(fetcher, { middleware: [middleware] }).get(url).retries(2, 1);

    assert.deepEqual(entries.map(entry => entry.ok), [false, false, true]);
    assert.equal(entries[0]?.status, undefined);
  });

  it('should redact sensitive headers if they are sent', async () => {
    const { fetcher } = createFakeFetcher();
    const { entries, middleware } = setup();

    await new XClient(fetcher, { middleware: [middleware] })
      .get(url)
      .headers({ 'Authorization': 'Bearer secret', 'Cookie': 'a=1', 'X-Trace': '7' });

    assert.deepEqual(entries[0]?.headers, { 'Authorization': '[redacted]', 'Cookie': '[redacted]', 'X-Trace': '7' });
  });

  it('should redact the given headers if redactHeaders is set', async () => {
    const { fetcher } = createFakeFetcher();
    const { entries, middleware } = setup({ redactHeaders: ['X-Secret'] });

    await new XClient(fetcher, { middleware: [middleware] })
      .get(url)
      .headers({ 'Authorization': 'Bearer visible', 'x-secret': 'hidden' });

    assert.deepEqual(entries[0]?.headers, { 'Authorization': 'Bearer visible', 'x-secret': '[redacted]' });
  });

  it('should log once when the stream ends if the request is a stream', async () => {
    const { fetcher } = createStreamFetcher([[event('{"n":1}'), event('{"n":2}')]]);
    const { entries, middleware } = setup();

    const stream = new XClient(fetcher, { middleware: [middleware] }).get(url).stream();

    assert.equal(entries.length, 0);
    for await (const item of stream) void item;

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.stream, true);
    assert.equal(entries[0]?.ok, true);
  });

  it('should log a failure if the stream breaks', async () => {
    const { fetcher } = createStreamFetcher([[event('{"n":1}'), new NetworkError('drop')]]);
    const { entries, middleware } = setup();

    await assert.rejects(async () => {
      for await (const item of new XClient(fetcher, { middleware: [middleware] }).get(url).stream()) void item;
    });

    assert.equal(entries[0]?.ok, false);
    assert.ok(entries[0]?.error instanceof NetworkError);
  });

  it('should log ok if the consumer stops reading the stream early', async () => {
    const { fetcher } = createStreamFetcher([[event('{"n":1}'), event('{"n":2}')]]);
    const { entries, middleware } = setup();

    for await (const item of new XClient(fetcher, { middleware: [middleware] }).get(url).stream()) {
      void item;
      break;
    }

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.ok, true);
  });

  it('should write one line with console.info if no sink is given', async (t) => {
    const lines: string[] = [];

    t.mock.method(console, 'info', (line: string) => lines.push(line));

    const { fetcher } = createFakeFetcher();

    await new XClient(fetcher, { middleware: [loggerMiddleware()] }).get(url);

    assert.match(lines[0] ?? '', /^GET https:\/\/example\.com\/items ok \d+ms$/);
  });

  it('should write the status in the default line if the request fails with an HttpError', async (t) => {
    const lines: string[] = [];

    t.mock.method(console, 'info', (line: string) => lines.push(line));

    const { fetcher } = createFlakyFetcher(1, {}, () => new HttpError(503, 'x', 'x'));

    await assert.rejects(async () => new XClient(fetcher, { middleware: [loggerMiddleware()] }).get(url));

    assert.match(lines[0] ?? '', / 503 \d+ms$/);
  });

  it('should write the message in the default line if the request fails with another error', async (t) => {
    const lines: string[] = [];

    t.mock.method(console, 'info', (line: string) => lines.push(line));

    const { fetcher } = createFlakyFetcher(1, {}, () => new NetworkError('socket hang up'));

    await assert.rejects(async () => new XClient(fetcher, { middleware: [loggerMiddleware()] }).get(url));

    assert.match(lines[0] ?? '', /socket hang up/);
  });

  it('should log the status of a successful response if the fetcher reports it', async () => {
    const fetcher: Fetcher = {
      async request<T>(_data: FetcherRequestParams, context?: ResponseContext) {
        if (context) context.status = 201;

        return {} as T;
      },
    };
    const { entries, middleware } = setup();

    await new XClient(fetcher, { middleware: [middleware] }).post(url);

    assert.equal(entries[0]?.status, 201);
  });

  it('should log the status of the connection if the request is a stream', async () => {
    const fetcher: Fetcher = {
      async request<T>() {
        return undefined as T;
      },
      async* stream(_data: FetcherRequestParams, context?: ResponseContext) {
        if (context) context.status = 200;

        yield event('{"n":1}');
      },
    };
    const { entries, middleware } = setup();

    for await (const item of new XClient(fetcher, { middleware: [middleware] }).get(url).stream()) void item;

    assert.equal(entries[0]?.status, 200);
  });

  it('should write the status in the default line if the response is successful', async (t) => {
    const lines: string[] = [];

    t.mock.method(console, 'info', (line: string) => lines.push(line));

    const fetcher: Fetcher = {
      async request<T>(_data: FetcherRequestParams, context?: ResponseContext) {
        if (context) context.status = 200;

        return {} as T;
      },
    };

    await new XClient(fetcher, { middleware: [loggerMiddleware()] }).get(url);

    assert.match(lines[0] ?? '', / 200 \d+ms$/);
  });
});
