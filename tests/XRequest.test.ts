import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import XRequest from '../src/XRequest.js';
import { HttpError } from '../src/errors.js';
import { createFakeFetcher, createFlakyFetcher } from './helpers.js';

describe('XRequest', () => {
  it('should send method and url to the fetcher if the request is awaited', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XRequest(fetcher, 'get', 'https://example.com/users');

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'get');
    assert.equal(calls[0]?.url, 'https://example.com/users');
  });

  it('should pass body, params and headers to the fetcher if they are set', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XRequest(fetcher, 'post', 'https://example.com/users')
      .body({ name: 'a' })
      .params({ page: 1 })
      .headers({ Authorization: 'Bearer x' });

    assert.deepEqual(calls[0]?.body, { name: 'a' });
    assert.deepEqual(calls[0]?.params, { page: 1 });
    assert.deepEqual(calls[0]?.headers, { Authorization: 'Bearer x' });
  });

  it('should not add body, params or headers if they are not set', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XRequest(fetcher, 'get', 'https://example.com');

    assert.ok(!('body' in calls[0]!));
    assert.ok(!('params' in calls[0]!));
    assert.ok(!('headers' in calls[0]!));
  });

  it('should return the fetcher response if the request is awaited', async () => {
    const { fetcher } = createFakeFetcher({ id: 1 });

    const result = await new XRequest(fetcher, 'get', 'https://example.com');

    assert.deepEqual(result, { id: 1 });
  });

  it('should return this from builder methods if they are chained', () => {
    const { fetcher } = createFakeFetcher();
    const req = new XRequest(fetcher, 'get', 'https://example.com');

    assert.equal(req.body({}), req);
    assert.equal(req.params({}), req);
    assert.equal(req.headers({}), req);
    assert.equal(req.timeout(100), req);
  });

  it('should join a relative url with baseUrl if baseUrl is set', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XRequest(fetcher, 'get', '/users', { baseUrl: 'https://example.com' });

    assert.equal(calls[0]?.url, 'https://example.com/users');
  });

  it('should keep the path of baseUrl if it has one (/api/v1)', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XRequest(fetcher, 'get', 'users', { baseUrl: 'https://example.com/api/v1/' });

    assert.equal(calls[0]?.url, 'https://example.com/api/v1/users');
  });

  it('should throw if the url is empty', async () => {
    const { fetcher } = createFakeFetcher();

    await assert.rejects(async () => {
      await new XRequest(fetcher, 'get', '');
    });
  });

  it('should execute the request once if it is awaited several times', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const req = new XRequest(fetcher, 'get', 'https://example.com');

    await req;
    await req;

    assert.equal(calls.length, 1);
  });

  it('should pass timeout to the fetcher if it is set', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XRequest(fetcher, 'get', 'https://example.com').timeout(500);

    assert.equal((calls[0] as { timeout?: number }).timeout, 500);
  });

  describe('retries', () => {
    it('should run once and rethrow the error if retries are not set', async () => {
      const { fetcher, calls } = createFlakyFetcher(1);

      await assert.rejects(async () => await new XRequest(fetcher, 'get', 'https://example.com'), /fail #1/);

      assert.equal(calls.length, 1);
    });

    it('should retry and return the result of the successful attempt if an attempt fails', async () => {
      const { fetcher, calls } = createFlakyFetcher(2, { data: 42 });

      const result = await new XRequest(fetcher, 'get', 'https://example.com').retries(3, 1);

      assert.deepEqual(result, { data: 42 });
      assert.equal(calls.length, 3);
    });

    it('should not make extra attempts if an attempt succeeds', async () => {
      const { fetcher, calls } = createFlakyFetcher(0);

      await new XRequest(fetcher, 'get', 'https://example.com').retries(3, 1);

      assert.equal(calls.length, 1);
    });

    it('should throw the last error if attempts are exhausted', async () => {
      const { fetcher, calls } = createFlakyFetcher(10);

      await assert.rejects(
        async () => await new XRequest(fetcher, 'get', 'https://example.com').retries(2, 1),
        /fail #3/,
      );

      assert.equal(calls.length, 3);
    });

    it('should wait for backoff between attempts if backoff is set', async () => {
      const { fetcher } = createFlakyFetcher(2);
      const start = Date.now();

      await new XRequest(fetcher, 'get', 'https://example.com').retries(2, 30);

      assert.ok(Date.now() - start >= 80);
    });

    it('should not restart retries if the request is awaited several times', async () => {
      const { fetcher, calls } = createFlakyFetcher(1);
      const req = new XRequest(fetcher, 'get', 'https://example.com').retries(2, 1);

      await req;
      await req;

      assert.equal(calls.length, 2);
    });

    for (const status of [400, 401, 403, 404, 422]) {
      it(`should not retry if the status is ${status}`, async () => {
        const { fetcher, calls } = createFlakyFetcher(10, undefined, () => new HttpError(status, ''));

        await assert.rejects(
          async () => await new XRequest(fetcher, 'get', 'https://example.com').retries(3, 1),
          (err: unknown) => err instanceof HttpError && err.status === status,
        );

        assert.equal(calls.length, 1);
      });
    }

    for (const status of [429, 500, 503]) {
      it(`should retry if the status is ${status}`, async () => {
        const { fetcher, calls } = createFlakyFetcher(1, { ok: true }, () => new HttpError(status, ''));

        const result = await new XRequest(fetcher, 'get', 'https://example.com').retries(2, 1);

        assert.deepEqual(result, { ok: true });
        assert.equal(calls.length, 2);
      });
    }

    it('should not retry if validation fails because the url is missing', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await assert.rejects(
        async () => await new XRequest(fetcher, 'get', '').retries(3, 1),
        /The value is missing: url/,
      );

      assert.equal(calls.length, 0);
    });

    it('should throw if retries exceeds maxRetries from the config', () => {
      const { fetcher } = createFakeFetcher();
      const req = new XRequest(fetcher, 'get', 'https://example.com', { maxRetries: 2 });

      assert.throws(() => req.retries(3, 1), /maxRetries/);
    });

    it('should accept retries if it is within maxRetries', () => {
      const { fetcher } = createFakeFetcher();
      const req = new XRequest(fetcher, 'get', 'https://example.com', { maxRetries: 2 });

      assert.doesNotThrow(() => req.retries(2, 1));
    });

    it('should reject maxRetries: 0 if it is set in the config', () => {
      const { fetcher } = createFakeFetcher();

      assert.throws(
        () => new XRequest(fetcher, 'get', 'https://example.com', { maxRetries: 0 }),
        /maxRetries/,
      );
    });

    it('should reject retries(0) if it is called', () => {
      const { fetcher } = createFakeFetcher();
      const req = new XRequest(fetcher, 'get', 'https://example.com');

      assert.throws(() => req.retries(0, 1), /Retry count/);
    });
  });

  describe('fallback', () => {
    it('should return the fallback value if the request fails', async () => {
      const { fetcher } = createFlakyFetcher(10);

      const result = await new XRequest(fetcher, 'get', 'https://example.com').fallback({ cached: true });

      assert.deepEqual(result, { cached: true });
    });

    it('should use falsy values as fallback if they are passed', async () => {
      for (const value of [0, null, '', false]) {
        const { fetcher } = createFlakyFetcher(10);

        const result = await new XRequest(fetcher, 'get', 'https://example.com').fallback(value);

        assert.equal(result, value);
      }
    });

    it('should call the fallback function lazily with the error if the request fails', async () => {
      const { fetcher } = createFlakyFetcher(10);
      let calledWith: unknown;
      const req = new XRequest(fetcher, 'get', 'https://example.com').fallback((error) => {
        calledWith = error;

        return 'from-fn';
      });

      assert.equal(calledWith, undefined);
      assert.equal(await req, 'from-fn');
      assert.match(String(calledWith), /fail #1/);
    });

    it('should not call the fallback if the request succeeds', async () => {
      const { fetcher } = createFlakyFetcher(0, { real: 1 });
      let called = false;

      const result = await new XRequest(fetcher, 'get', 'https://example.com').fallback(() => {
        called = true;

        return { fake: 1 };
      });

      assert.deepEqual(result, { real: 1 });
      assert.equal(called, false);
    });

    it('should apply the fallback only if retries are exhausted', async () => {
      const { fetcher, calls } = createFlakyFetcher(10);

      const result = await new XRequest(fetcher, 'get', 'https://example.com')
        .retries(2, 1)
        .fallback('fallback');

      assert.equal(result, 'fallback');
      assert.equal(calls.length, 3);
    });

    it('should return the real response instead of the fallback if a retry succeeds', async () => {
      const { fetcher } = createFlakyFetcher(1, 'real');

      const result = await new XRequest(fetcher, 'get', 'https://example.com')
        .retries(2, 1)
        .fallback('fallback');

      assert.equal(result, 'real');
    });

    it('should still rethrow the error if no fallback is set', async () => {
      const { fetcher } = createFlakyFetcher(10);

      await assert.rejects(async () => await new XRequest(fetcher, 'get', 'https://example.com'), /fail #1/);
    });

    it('should not hide a validation error if a fallback is set', async () => {
      const { fetcher } = createFakeFetcher();

      await assert.rejects(
        async () => await new XRequest(fetcher, 'get', '').fallback('x'),
        /The value is missing: url/,
      );
    });

    it('should not call onrejected if the fallback handled the error', async () => {
      const { fetcher } = createFlakyFetcher(10);
      let rejected = false;

      await new XRequest(fetcher, 'get', 'https://example.com')
        .fallback('x')
        .then(undefined, () => {
          rejected = true;
        });

      assert.equal(rejected, false);
    });

    it('should not call the fallback or the request again if the request is awaited again', async () => {
      const { fetcher, calls } = createFlakyFetcher(10);
      const req = new XRequest(fetcher, 'get', 'https://example.com').fallback('x');

      await req;
      await req;

      assert.equal(calls.length, 1);
    });
  });

  describe('url and config', () => {
    it('should not apply baseUrl if the url is absolute', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', 'https://other.com/x', { baseUrl: 'https://api.com' });

      assert.equal(calls[0]?.url, 'https://other.com/x');
    });

    it('should join baseUrl without double slashes if slashes are at the boundary', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', '//users', { baseUrl: 'https://api.com///' });

      assert.equal(calls[0]?.url, 'https://api.com/users');
    });

    it('should not pass timeout to the fetcher if timeout(null) is called', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', 'https://example.com').timeout(null);

      assert.equal('timeout' in (calls[0] ?? {}), false);
    });

    it('should throw a validation error if the method or url is empty', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await assert.rejects(
        async () => await new XRequest(fetcher, 'get', ''),
        /The value is missing: url/,
      );
      assert.equal(calls.length, 0);
    });

    it('should use 500 ms as default backoff if retries(n) is called without backoff', () => {
      const { fetcher } = createFakeFetcher();

      assert.doesNotThrow(() => new XRequest(fetcher, 'get', 'https://example.com').retries(2));
    });
  });

  describe('path params', () => {
    it('should substitute params into the url if the url has placeholders', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', 'https://api.com/companies/{companyId}/users/{userId}')
        .path({ companyId: 1, userId: 'abc' });

      assert.equal(calls[0]?.url, 'https://api.com/companies/1/users/abc');
    });

    it('should escape values if they contain special characters', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', 'https://api.com/files/{name}').path({ name: 'a/b c?' });

      assert.equal(calls[0]?.url, 'https://api.com/files/a%2Fb%20c%3F');
    });

    it('should work with baseUrl if both are set', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', '/users/{id}', { baseUrl: 'https://api.com' }).path({ id: 7 });

      assert.equal(calls[0]?.url, 'https://api.com/users/7');
    });

    it('should substitute every occurrence if a param appears several times', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', 'https://api.com/{id}/copy/{id}').path({ id: 5 });

      assert.equal(calls[0]?.url, 'https://api.com/5/copy/5');
    });

    it('should throw and not send the request if a param is missing', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await assert.rejects(
        async () => await new XRequest(fetcher, 'get', 'https://api.com/users/{id}'),
        /The path parameter is missing: id/,
      );
      assert.equal(calls.length, 0);
    });

    it('should not hide a missing path param if a fallback is set', async () => {
      const { fetcher } = createFakeFetcher();

      await assert.rejects(
        async () => await new XRequest(fetcher, 'get', 'https://api.com/users/{id}').fallback('x'),
        /The path parameter is missing/,
      );
    });

    it('should leave the url unchanged if it has no placeholders', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', 'https://api.com/users').path({ id: 1 });

      assert.equal(calls[0]?.url, 'https://api.com/users');
    });
  });
});
