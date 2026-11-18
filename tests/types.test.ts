import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import XClient from '../src/XClient.js';
import { HttpError, isHttpError } from '../src/errors.js';
import type { AbortError, NetworkError, ParseError, RequestError, TimeoutError } from '../src/errors.js';
import type { PathParamNames } from '../src/routes.js';
import { createFakeFetcher, createFlakyFetcher, createStreamFetcher } from './helpers.js';
import type { SseEvent } from '../src/types.js';

// Compile-time assertions: a mistake here fails `tsc` (and thus `npm test`).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <_T extends true>() => { };

type User = { id: number; name: string };
type CreateUser = { name: string };

interface Routes {
  '/users': {
    get: { query?: { page?: number }; response: User[] };
    post: { body: CreateUser; response: User };
  };
  '/companies/{companyId}/users/{userId}': {
    get: { response: User };
    delete: { response: void };
  };
  '/orders/{id}': {
    get: {
      response: { id: number };
      errors: { 404: { message: string }; 422: { fields: string[] } };
    };
  };
  '/ping': {
    get: { response: 'pong' };
  };
}

describe('route typing', () => {
  it('should infer path param names from the string if the url has placeholders', () => {
    assertType<Equal<PathParamNames<'/a/{x}/b/{y}'>, 'x' | 'y'>>();
    assertType<Equal<PathParamNames<'/plain'>, never>>();
  });

  it('should take the response type from the route if it is declared', async () => {
    const { fetcher } = createFakeFetcher([{ id: 1, name: 'A' }]);
    const client = new XClient<Routes>(fetcher);

    const users = await client.get('/users');
    assertType<Equal<typeof users, User[]>>();

    const pong = await client.get('/ping');
    assertType<Equal<typeof pong, 'pong'>>();

    assert.deepEqual(users, [{ id: 1, name: 'A' }]);
  });

  it('should offer only routes with the given method if a method is called', () => {
    const { fetcher } = createFakeFetcher();
    const client = new XClient<Routes>(fetcher);

    // /ping only has get
    // @ts-expect-error
    void (() => client.post('/ping'));
    // unknown path
    // @ts-expect-error
    void (() => client.get('/nope'));
    // /users has no delete
    // @ts-expect-error
    void (() => client.delete('/users'));
  });

  it('should require path params and check their names if the route has placeholders', async () => {
    const { fetcher, calls } = createFakeFetcher({ id: 1, name: 'A' });
    const client = new XClient<Routes>(fetcher);

    const user = await client.get('/companies/{companyId}/users/{userId}', { companyId: 1, userId: 2 });
    assertType<Equal<typeof user, User>>();
    assert.equal(calls[0]?.url, '/companies/1/users/2');

    // @ts-expect-error — params are missing
    void (() => client.get('/companies/{companyId}/users/{userId}'));
    // @ts-expect-error — typo in the name
    void (() => client.get('/companies/{companyId}/users/{userId}', { companyId: 1, user: 2 }));
    // @ts-expect-error — a param is missing
    void (() => client.get('/companies/{companyId}/users/{userId}', { companyId: 1 }));
    // @ts-expect-error — a route without params does not accept them
    void (() => client.get('/users', { id: 1 }));
  });

  it('should type body from the route if it is declared', async () => {
    const { fetcher, calls } = createFakeFetcher({ id: 1, name: 'A' });
    const client = new XClient<Routes>(fetcher);

    const created = await client.post('/users').body({ name: 'A' });
    assertType<Equal<typeof created, User>>();
    assert.deepEqual(calls[0]?.body, { name: 'A' });

    // @ts-expect-error — invalid field
    void (() => client.post('/users').body({ title: 'A' }));
    // @ts-expect-error — get /users has no body
    void (() => client.get('/users').body({ name: 'A' }));
  });

  it('should type params (query) from the route if they are declared', async () => {
    const { fetcher, calls } = createFakeFetcher([]);
    const client = new XClient<Routes>(fetcher);

    await client.get('/users').params({ page: 2 });
    assert.deepEqual(calls[0]?.params, { page: 2 });

    // @ts-expect-error — page must be a number
    void (() => client.get('/users').params({ page: 'two' }));
    // @ts-expect-error — post /users has no query
    void (() => client.post('/users').params({ page: 1 }));
  });

  it('should widen the result type and keep typing if fallback is used', async () => {
    const { fetcher } = createFakeFetcher({ id: 1, name: 'A' });
    const client = new XClient<Routes>(fetcher);

    const result = await client.post('/users').body({ name: 'A' }).fallback(null);
    assertType<Equal<typeof result, User | null>>();

    // @ts-expect-error — body typing is kept after fallback
    void (() => client.post('/users').fallback(null).body({ nope: 1 }));
  });

  it('should accept any url if no routes are described', async () => {
    const { fetcher, calls } = createFakeFetcher({ any: 1 });
    const client = new XClient(fetcher);

    const result = await client.get('/whatever/{id}', { id: 5 }).body({ free: 'form' });

    assertType<Equal<typeof result, unknown>>();
    assert.equal(calls[0]?.url, '/whatever/5');
  });

  describe('error typing', () => {
    type NotFound = { message: string };

    it('result() should return a discriminated union if it is awaited', async () => {
      const { fetcher } = createFlakyFetcher(0, { id: 1 });
      const client = new XClient<Routes>(fetcher);

      const result = await client.get('/orders/{id}', { id: 1 }).result();

      if (result.ok) {
        assertType<Equal<typeof result.data, { id: number }>>();
      } else {
        assertType<Equal<typeof result.data, undefined>>();
      }
      assert.equal(result.ok, true);
    });

    type ErrorOfResult<R> = R extends { ok: false; error: infer E } ? E : never;

    it('should include declared HttpErrors and system errors if errors are declared', async () => {
      const { fetcher } = createFlakyFetcher(10, undefined, () => new HttpError(404, '{}', { message: 'nf' }));
      const client = new XClient<Routes>(fetcher);
      const request = client.get('/orders/{id}', { id: 1 });
      type Err = ErrorOfResult<Awaited<ReturnType<typeof request.result>>>;

      // narrowing checks live in a function so the test's flow analysis does not affect the types
      const narrow = (error: Err) => {
        assertType<Equal<typeof error.kind, 'http' | 'timeout' | 'network' | 'parse' | 'abort'>>();

        if (isHttpError(error, 404)) {
          assertType<Equal<typeof error, HttpError<404, NotFound>>>();
          assertType<Equal<typeof error.data, NotFound>>();
        }
        if (isHttpError(error, 422)) {
          assertType<Equal<typeof error.data, { fields: string[] }>>();
        }
        if (error.kind === 'timeout') assertType<Equal<typeof error, TimeoutError>>();
        if (error.kind === 'network') assertType<Equal<typeof error, NetworkError>>();
        if (error.kind === 'parse') assertType<Equal<typeof error, ParseError>>();
        if (error.kind === 'abort') assertType<Equal<typeof error, AbortError>>();
      };

      const result = await request.result();

      assert.ok(!result.ok);
      narrow(result.error);
      assert.ok(isHttpError(result.error, 404));
      assert.equal((result.error.data as NotFound).message, 'nf');
    });

    it('should use HttpError with unknown data if the route has no errors', async () => {
      const { fetcher } = createFlakyFetcher(10);
      const client = new XClient<Routes>(fetcher);

      const result = await client.get('/users').result();

      if (!result.ok) {
        assertType<Equal<typeof result.error, RequestError>>();
        if (isHttpError(result.error, 500)) {
          assertType<Equal<typeof result.error.data, unknown>>();
        }
      }
      assert.equal(result.ok, false);
    });

    it('should type error as RequestError if the client is untyped', async () => {
      const { fetcher } = createFlakyFetcher(10);

      const result = await new XClient(fetcher).get('/x').result();

      if (!result.ok) assertType<Equal<typeof result.error, RequestError>>();
      assert.equal(result.ok, false);
    });

    it('should keep errors if .fallback() or other chain methods are called', () => {
      const { fetcher } = createFlakyFetcher(0, { id: 1 });
      const client = new XClient<Routes>(fetcher);

      const request = client.get('/orders/{id}', { id: 1 }).timeout(100).retries(2).fallback(null);
      type Err = Awaited<ReturnType<typeof request.result>> extends infer R
        ? R extends { ok: false; error: infer E } ? E : never
        : never;

      assertType<Equal<Extract<Err, HttpError<404, NotFound>>, HttpError<404, NotFound>>>();
    });

    it('isHttpError should narrow unknown (catch) to HttpError if it returns true', () => {
      const check = (caught: unknown) => {
        if (isHttpError(caught, 409)) {
          assertType<Equal<typeof caught, HttpError<409>>>();
        }
      };

      check(new HttpError(409, ''));
      assert.ok(isHttpError(new HttpError(409, ''), 409));
    });
  });

  describe('errors.default and path param types in manual routes', () => {
    type Body = { message: string };

    interface Manual {
      '/items/{id}': {
        get: {
          response: string;
          path: { id: number };
          errors: { 404: { gone: true }; default: Body };
        };
      };
    }

    it('should take path params from the declared path if it is set', () => {
      const { fetcher } = createFlakyFetcher(0);
      const client = new XClient<Manual>(fetcher);

      void (() => client.get('/items/{id}', { id: 1 }));
      // @ts-expect-error — id is declared as number
      void (() => client.get('/items/{id}', { id: 'x' }));
    });

    it('should type HttpError for other statuses and keep declared ones exact if default is declared', async () => {
      const { fetcher } = createFlakyFetcher(10, undefined, () => new HttpError(500, ''));
      const client = new XClient<Manual>(fetcher);
      const request = client.get('/items/{id}', { id: 1 });
      type Err = Awaited<ReturnType<typeof request.result>> extends infer R
        ? R extends { ok: false; error: infer E } ? E : never
        : never;

      const narrow = (error: Err) => {
        if (isHttpError(error, 404)) assertType<Equal<typeof error, HttpError<404, { gone: true }>>>();
        if (isHttpError(error, 500)) assertType<Equal<typeof error, HttpError<500, Body>>>();
      };

      narrow((await request.result() as { error: Err }).error);
      assert.ok(true);
    });
  });
});

describe('event typing', () => {
  interface StreamRoutes {
    '/events': { get: { events: { message: { text: string }; ping: { at: number } } } };
    '/plain': { get: { response: string } };
  }

  it('should make events a discriminated union by name if the route declares events', async () => {
    const { fetcher } = createStreamFetcher([[]]);
    const client = new XClient<StreamRoutes>(fetcher);

    for await (const event of client.get('/events').stream()) {
      if (event.event === 'message') assertType<Equal<typeof event.data, { text: string }>>();
      if (event.event === 'ping') assertType<Equal<typeof event.data, { at: number }>>();
      assertType<Equal<typeof event.event, 'message' | 'ping'>>();
    }
  });

  it('should type data as string if json is disabled', async () => {
    const { fetcher } = createStreamFetcher([[]]);
    const client = new XClient<StreamRoutes>(fetcher);

    for await (const event of client.get('/events').stream({ json: false })) {
      assertType<Equal<typeof event.data, string>>();
    }
  });

  it('should type events as unknown data if the route declares no events', async () => {
    const { fetcher } = createStreamFetcher([[]]);
    const client = new XClient<StreamRoutes>(fetcher);

    for await (const event of client.get('/plain').stream()) {
      assertType<Equal<typeof event, SseEvent>>();
    }
  });

  it('should type events as unknown data if the client is untyped', async () => {
    const { fetcher } = createStreamFetcher([[]]);

    for await (const event of new XClient(fetcher).get('https://example.com/events').stream()) {
      assertType<Equal<typeof event, SseEvent>>();
    }
  });

  it('should keep event typing after .fallback() and other chain methods', () => {
    const { fetcher } = createStreamFetcher([[]]);
    const request = new XClient<StreamRoutes>(fetcher).get('/events').timeout(1).fallback(null).retries(1);

    const check = async () => {
      for await (const event of request.stream()) {
        assertType<Equal<typeof event.event, 'message' | 'ping'>>();
      }
    };

    assert.equal(typeof check, 'function');
  });
});
