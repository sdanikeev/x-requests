import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NetworkError, ValidationError } from '../src/errors.js';
import XClient from '../src/XClient.js';
import { createFakeFetcher, createFlakyFetcher, createStreamFetcher, event } from './helpers.js';

const url = 'https://example.com/payments';

describe('idempotent', () => {
  it('should send a generated Idempotency-Key if idempotent() is called without a key', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XClient(fetcher).post(url).idempotent();

    assert.match(calls[0]?.headers?.['Idempotency-Key'] ?? '', /^[0-9a-f-]{36}$/);
  });

  it('should send the same key on every attempt if the request is retried', async () => {
    const { fetcher, calls } = createFlakyFetcher(2, { ok: true }, () => new NetworkError('down'));

    await new XClient(fetcher).post(url).idempotent().retries(2, 1);

    const keys = calls.map(call => call.headers?.['Idempotency-Key']);

    assert.equal(keys.length, 3);
    assert.ok(keys[0]);
    assert.deepEqual(new Set(keys).size, 1);
  });

  it('should send different keys if two requests are idempotent', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher);

    await client.post(url).idempotent();
    await client.post(url).idempotent();

    assert.notEqual(calls[0]?.headers?.['Idempotency-Key'], calls[1]?.headers?.['Idempotency-Key']);
  });

  it('should send the given key if idempotent() gets one', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XClient(fetcher).post(url).idempotent('order-42');

    assert.equal(calls[0]?.headers?.['Idempotency-Key'], 'order-42');
  });

  it('should keep other headers if the key is added', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XClient(fetcher).post(url).headers({ 'X-Custom': '1' }).idempotent('k');

    assert.deepEqual(calls[0]?.headers, { 'X-Custom': '1', 'Idempotency-Key': 'k' });
  });

  it('should not overwrite the header if it is set with headers()', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XClient(fetcher).post(url).headers({ 'idempotency-key': 'mine' }).idempotent('generated');

    assert.deepEqual(calls[0]?.headers, { 'idempotency-key': 'mine' });
  });

  it('should use the header name from the config if idempotencyHeader is set', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XClient(fetcher, { idempotencyHeader: 'X-Request-Id' }).post(url).idempotent('k');

    assert.deepEqual(calls[0]?.headers, { 'X-Request-Id': 'k' });
  });

  it('should not send the header if idempotent() is not called', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XClient(fetcher).post(url);

    assert.equal(calls[0]?.headers, undefined);
  });

  it('should throw a ValidationError if the key is empty', () => {
    const { fetcher } = createFakeFetcher();
    const request = new XClient(fetcher).post(url);

    assert.throws(() => request.idempotent(' '), ValidationError);
  });

  it('should send the same key on every reconnect if a stream is idempotent', async () => {
    const { fetcher, calls } = createStreamFetcher([
      [event('{"n":1}', { id: '1' }), new NetworkError('drop')],
      [event('{"n":2}', { id: '2' })],
    ]);

    const request = new XClient(fetcher).get(url).idempotent('stream-key').retries(1, 1);

    for await (const item of request.stream()) void item;

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.headers?.['Idempotency-Key'], 'stream-key');
    assert.equal(calls[1]?.headers?.['Idempotency-Key'], 'stream-key');
    assert.equal(calls[1]?.headers?.['Last-Event-ID'], '1');
  });
});
