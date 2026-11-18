import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HttpError } from '../src/errors.js';
import { authMiddleware } from '../src/middlewares/auth.js';
import XClient from '../src/XClient.js';
import type { Fetcher, FetcherRequestParams } from '../src/types.js';
import { createFakeFetcher, createStreamFetcher, event } from './helpers.js';

const url = 'https://example.com/me';

// accepts only the current token, answers 401 to any other
const createAuthServer = (valid: () => string) => {
  const calls: FetcherRequestParams[] = [];
  const fetcher: Fetcher = {
    async request<T>(data: FetcherRequestParams) {
      calls.push(data);

      if (data.headers?.Authorization !== `Bearer ${valid()}`) throw new HttpError(401, 'nope', 'nope');

      return { ok: true } as T;
    },
  };

  return { fetcher, calls };
};

describe('authMiddleware', () => {
  it('should add the bearer token if the request has no Authorization header', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher, { middleware: [authMiddleware({ getToken: () => 't1' })] });

    await client.get(url);

    assert.equal(calls[0]?.headers?.Authorization, 'Bearer t1');
  });

  it('should read the token again on every request if getToken is async', async () => {
    const { fetcher, calls } = createFakeFetcher();
    let token = 'a';
    const client = new XClient(fetcher, { middleware: [authMiddleware({ getToken: async () => token })] });

    await client.get(url);
    token = 'b';
    await client.get(url);

    assert.deepEqual(calls.map(call => call.headers?.Authorization), ['Bearer a', 'Bearer b']);
  });

  it('should not touch the request if the Authorization header is already set', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher, { middleware: [authMiddleware({ getToken: () => 't1' })] });

    await client.get(url).headers({ authorization: 'Basic x' });

    assert.deepEqual(calls[0]?.headers, { authorization: 'Basic x' });
  });

  it('should send no header if there is no token', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher, { middleware: [authMiddleware({ getToken: () => undefined })] });

    await client.get(url);

    assert.equal(calls[0]?.headers, undefined);
  });

  it('should use the given scheme and header name if they are set', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const client = new XClient(fetcher, {
      middleware: [
        authMiddleware({ getToken: () => 'k', scheme: '', header: 'X-Api-Key' }),
      ],
    });

    await client.get(url);

    assert.deepEqual(calls[0]?.headers, { 'X-Api-Key': 'k' });
  });

  it('should refresh the token and repeat the request once if the response is 401', async () => {
    let token = 'old';
    const { fetcher, calls } = createAuthServer(() => 'new');
    let refreshed = 0;
    const client = new XClient(fetcher, {
      middleware: [
        authMiddleware({
          getToken: () => token,
          refresh: async () => {
            refreshed++;
            token = 'new';

            return token;
          },
        }),
      ],
    });

    assert.deepEqual(await client.get(url), { ok: true });
    assert.equal(refreshed, 1);
    assert.deepEqual(calls.map(call => call.headers?.Authorization), ['Bearer old', 'Bearer new']);
  });

  it('should refresh only once if several requests get 401 at the same time', async () => {
    let token = 'old';
    const { fetcher } = createAuthServer(() => 'new');
    let refreshed = 0;
    const client = new XClient(fetcher, {
      middleware: [
        authMiddleware({
          getToken: () => token,
          refresh: async () => {
            refreshed++;
            await new Promise(resolve => setTimeout(resolve, 10));
            token = 'new';

            return token;
          },
        }),
      ],
    });

    await Promise.all([client.get(url), client.get(url), client.get(url)]);

    assert.equal(refreshed, 1);
  });

  it('should not refresh again if another request already replaced the token', async () => {
    let token = 'old';
    const { fetcher, calls } = createAuthServer(() => 'new');
    let refreshed = 0;
    const slow: Fetcher = {
      async request<T>(data: FetcherRequestParams) {
        // the token changes while the request is in flight
        token = 'new';

        return fetcher.request<T>(data);
      },
    };
    const client = new XClient(slow, {
      middleware: [authMiddleware({ getToken: () => token, refresh: () => {
        refreshed++;

        return 'x';
      },
      })],
    });

    await client.get(url);

    assert.equal(refreshed, 0);
    assert.equal(calls.at(-1)?.headers?.Authorization, 'Bearer new');
  });

  it('should throw the 401 if the repeated request fails with 401 too', async () => {
    const { fetcher, calls } = createAuthServer(() => 'never');
    const client = new XClient(fetcher, {
      middleware: [authMiddleware({ getToken: () => 'old', refresh: () => 'still-bad' })],
    });

    await assert.rejects(async () => client.get(url), (error: unknown) => error instanceof HttpError && error.status === 401);
    assert.equal(calls.length, 2);
  });

  it('should rethrow the error if it is not a 401', async () => {
    const fetcher: Fetcher = {
      async request() {
        throw new HttpError(500, 'boom', 'boom');
      },
    };
    let refreshed = false;
    const client = new XClient(fetcher, {
      middleware: [authMiddleware({ getToken: () => 't', refresh: () => {
        refreshed = true;

        return 'x';
      },
      })],
    });

    await assert.rejects(async () => client.get(url), /Status: 500/);
    assert.equal(refreshed, false);
  });

  it('should add the token to a stream connection if the request is a stream', async () => {
    const { fetcher, calls } = createStreamFetcher([[]]);
    const client = new XClient(fetcher, { middleware: [authMiddleware({ getToken: () => 't1' })] });

    for await (const item of client.get(url).stream()) void item;

    assert.equal(calls[0]?.headers?.Authorization, 'Bearer t1');
  });

  it('should reconnect once with a new token if a stream is refused with 401 before its first event', async () => {
    let token = 'old';
    const { fetcher, calls } = createStreamFetcher([
      [new HttpError(401, 'expired', 'expired')],
      [event('{"n":1}')],
    ]);
    const client = new XClient(fetcher, {
      middleware: [authMiddleware({ getToken: () => token, refresh: () => (token = 'new') })],
    });
    const received: unknown[] = [];

    for await (const item of client.get(url).stream()) received.push(item.data);

    assert.deepEqual(received, [{ n: 1 }]);
    assert.deepEqual(calls.map(call => call.headers?.Authorization), ['Bearer old', 'Bearer new']);
  });

  it('should throw the 401 if the stream is refused again after the refresh', async () => {
    const { fetcher, calls } = createStreamFetcher([
      [new HttpError(401, 'no', 'no')],
      [new HttpError(401, 'no', 'no')],
    ]);
    const client = new XClient(fetcher, {
      middleware: [authMiddleware({ getToken: () => 'old', refresh: () => 'bad' })],
    });

    await assert.rejects(async () => {
      for await (const item of client.get(url).stream()) void item;
    }, /Status: 401/);
    assert.equal(calls.length, 2);
  });

  it('should not refresh if a stream fails with 401 after its first event', async () => {
    const { fetcher, calls } = createStreamFetcher([[event('{"n":1}'), new HttpError(401, 'no', 'no')]]);
    let refreshed = 0;
    const client = new XClient(fetcher, {
      middleware: [authMiddleware({ getToken: () => 'old', refresh: () => (refreshed++, 'new') })],
    });

    await assert.rejects(async () => {
      for await (const item of client.get(url).stream()) void item;
    }, /Status: 401/);
    assert.equal(refreshed, 0);
    assert.equal(calls.length, 1);
  });

  it('should pass a stream error on if it is not a 401', async () => {
    const { fetcher } = createStreamFetcher([[new HttpError(500, 'boom', 'boom')]]);
    const client = new XClient(fetcher, {
      middleware: [authMiddleware({ getToken: () => 'old', refresh: () => 'new' })],
    });

    await assert.rejects(async () => {
      for await (const item of client.get(url).stream()) void item;
    }, /Status: 500/);
  });

  it('should stop the stream underneath if the consumer stops reading a refreshing stream', async () => {
    const { fetcher } = createStreamFetcher([[event('{"n":1}'), event('{"n":2}')]]);
    const client = new XClient(fetcher, {
      middleware: [authMiddleware({ getToken: () => 'old', refresh: () => 'new' })],
    });
    const received: unknown[] = [];

    for await (const item of client.get(url).stream()) {
      received.push(item.data);
      break;
    }

    assert.deepEqual(received, [{ n: 1 }]);
  });
});
