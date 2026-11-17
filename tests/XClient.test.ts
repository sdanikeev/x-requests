import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import XClient from '../src/XClient.js';
import { createFakeFetcher } from './helpers.js';

describe('XClient', () => {
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options'] as const) {
    it(`${method}() создаёт запрос с методом ${method} и нужным url`, async () => {
      const { fetcher, calls } = createFakeFetcher();
      const client = new XClient(fetcher);

      await client[method]('https://example.com/a');

      assert.equal(calls[0]?.method, method);
      assert.equal(calls[0]?.url, 'https://example.com/a');
    });
  }

  it('options() принимает url-строку', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher);

    // сейчас сигнатура options(url: Method) — тип не string
    await client.options('https://example.com/a' as never);

    assert.equal(calls[0]?.method, 'options');
    assert.equal(calls[0]?.url, 'https://example.com/a');
  });

  it('применяет baseUrl из конфига', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher, { baseUrl: 'https://example.com' });

    await client.get('/users');

    assert.equal(calls[0]?.url, 'https://example.com/users');
  });

  it('каждый вызов создаёт новый независимый запрос', () => {
    const { fetcher } = createFakeFetcher();
    const client = new XClient(fetcher);

    assert.notEqual(client.get('https://a.b'), client.get('https://a.b'));
  });

  it('get() принимает path-параметры вторым аргументом', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher);

    await client.get('https://api.com/companies/{companyId}/users/{userId}', { companyId: 1, userId: 2 });

    assert.equal(calls[0]?.url, 'https://api.com/companies/1/users/2');
  });
});
