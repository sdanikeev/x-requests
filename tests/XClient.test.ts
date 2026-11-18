import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import XClient from '../src/XClient.js';
import { createFakeFetcher } from './helpers.js';

describe('XClient', () => {
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options'] as const) {
    it(`${method}() should create a ${method} request with the given url`, async () => {
      const { fetcher, calls } = createFakeFetcher();
      const client = new XClient(fetcher);

      await client[method]('https://example.com/a');

      assert.equal(calls[0]?.method, method);
      assert.equal(calls[0]?.url, 'https://example.com/a');
    });
  }

  it('options() should accept a url string', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher);

    // the signature is currently options(url: Method), not string
    await client.options('https://example.com/a' as never);

    assert.equal(calls[0]?.method, 'options');
    assert.equal(calls[0]?.url, 'https://example.com/a');
  });

  it('should prepend baseUrl from the config if one is set', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher, { baseUrl: 'https://example.com' });

    await client.get('/users');

    assert.equal(calls[0]?.url, 'https://example.com/users');
  });

  it('should create a new independent request if called repeatedly', () => {
    const { fetcher } = createFakeFetcher();
    const client = new XClient(fetcher);

    assert.notEqual(client.get('https://a.b'), client.get('https://a.b'));
  });

  it('get() should substitute path params if they are passed as the second argument', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher);

    await client.get('https://api.com/companies/{companyId}/users/{userId}', { companyId: 1, userId: 2 });

    assert.equal(calls[0]?.url, 'https://api.com/companies/1/users/2');
  });
});
