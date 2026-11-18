import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { components, paths } from '../examples/generated_v1.js';
import type { FromOpenApi } from '../src/openapi.js';
import { HttpError, isHttpError } from '../src/errors.js';
import XClient from '../src/XClient.js';
import { createFakeFetcher, createFlakyFetcher, createStreamFetcher, event } from './helpers.js';

// Compile-time assertions: a mistake here fails `tsc` (and thus `npm test`).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <_T extends true>() => { };

type User = components['schemas']['User'];
type CreateUser = components['schemas']['CreateUser'];
type UpdateUser = components['schemas']['UpdateUser'];
type ApiError = components['schemas']['ApiError'];
type ValidationError = components['schemas']['ValidationError'];

type Routes = FromOpenApi<paths>;

describe('FromOpenApi', () => {
  it('should keep all paths if the schema is converted', () => {
    assertType<Equal<keyof Routes, '/ping' | '/users' | '/users/{id}' | '/companies/{companyId}/users/{userId}' | '/events' | '/messages'>>();
  });

  it('should drop missing methods (put?: never) and the parameters key if the schema is converted', () => {
    assertType<Equal<keyof Routes['/ping'], 'get'>>();
    assertType<Equal<keyof Routes['/users'], 'get' | 'post'>>();
    assertType<Equal<keyof Routes['/users/{id}'], 'get' | 'patch' | 'delete'>>();
  });

  it('should take the only content type if the response is text/plain', () => {
    assertType<Equal<Routes['/ping']['get'], { response: 'pong' }>>();
  });

  it('should type query and an array response if they are declared', () => {
    assertType<Equal<Routes['/users']['get'], {
      query?: { page?: number; limit?: number; role?: components['schemas']['Role'] };
      response: User[];
    }>>();
  });

  it('should type body, the 201 response and errors if a POST operation is declared', () => {
    assertType<Equal<Routes['/users']['post'], {
      body: CreateUser;
      response: User;
      errors: { 409: ApiError; 422: ValidationError };
    }>>();
  });

  it('should merge path-level params into the operation and keep query optional if they are declared', () => {
    assertType<Equal<Routes['/users/{id}']['get'], {
      query?: { expand?: 'company' | 'orders' };
      path: { id: number };
      response: User;
      errors: { 404: ApiError };
    }>>();
  });

  it('should take body from requestBody if a PATCH operation is declared', () => {
    assertType<Equal<Routes['/users/{id}']['patch'], {
      body: UpdateUser;
      path: { id: number };
      response: User;
      errors: { 404: ApiError };
    }>>();
  });

  it('should set response to undefined if a DELETE returns 204 without content', () => {
    assertType<Equal<Routes['/users/{id}']['delete'], {
      path: { id: number };
      response: undefined;
      errors: { 404: ApiError };
    }>>();
  });

  it('should map header params to headers, type path params and map default to errors.default if they are declared', () => {
    assertType<Equal<Routes['/companies/{companyId}/users/{userId}']['get'], {
      headers?: { 'X-Request-Id'?: string };
      path: { companyId: number; userId: number };
      response: User;
      errors: { default: ApiError };
    }>>();
  });

  it('should keep required query and optional requestBody if optionality is declared', () => {
    type Custom = {
      '/search': {
        get: {
          parameters: { query: { q: string }; header?: never; path?: never; cookie?: never };
          requestBody?: never;
          responses: { 200: { headers: Record<string, unknown>; content: { 'application/json': string[] } } };
        };
        post: {
          parameters: { query?: never; header?: never; path?: never; cookie?: never };
          requestBody?: { content: { 'application/json': { filter: string } } };
          responses: { 204: { headers: Record<string, unknown>; content?: never } };
        };
        put?: never;
      };
    };
    type R = FromOpenApi<Custom>;

    assertType<Equal<R['/search']['get'], { query: { q: string }; response: string[] }>>();
    assertType<Equal<R['/search']['post'], { body?: { filter: string }; response: undefined }>>();
  });
});

describe('FromOpenApi + client', () => {
  const user: User = { id: 1, email: 'a@b.c', role: 'admin' };

  it('should infer types from the generated schema if xclient is created with it', async () => {
    const { fetcher, calls } = createFakeFetcher(user);
    const client = new XClient<Routes>(fetcher);

    const created = await client.post('/users').body({ email: 'a@b.c' });
    assertType<Equal<typeof created, User>>();
    assert.deepEqual(calls[0]?.body, { email: 'a@b.c' });

    const found = await client.get('/users/{id}', { id: 1 }).params({ expand: 'company' });
    assertType<Equal<typeof found, User>>();
    assert.equal(calls[1]?.url, '/users/1');

    const removed = await client.delete('/users/{id}', { id: 1 });
    assertType<Equal<typeof removed, undefined>>();
  });

  it('should take path param types from the schema if they are declared', () => {
    const { fetcher } = createFakeFetcher();
    const client = new XClient<Routes>(fetcher);

    // valid: id is a number
    void (() => client.get('/users/{id}', { id: 1 }));
    // @ts-expect-error — the schema declares id: integer, a string is invalid
    void (() => client.get('/users/{id}', { id: 'abc' }));
    // @ts-expect-error — extra param
    void (() => client.get('/users/{id}', { id: 1, extra: 1 }));
  });

  it('should type the body of other statuses if errors.default is declared', async () => {
    const { fetcher } = createFlakyFetcher(10, undefined, () => new HttpError(503, '', { message: 'down' }));
    const client = new XClient<Routes>(fetcher);

    const request = client.get('/companies/{companyId}/users/{userId}', { companyId: 1, userId: 2 });
    type Err = Awaited<ReturnType<typeof request.result>> extends infer R
      ? R extends { ok: false; error: infer E } ? E : never
      : never;

    const narrow = (error: Err) => {
      if (isHttpError(error, 503)) {
        assertType<Equal<typeof error, HttpError<503, ApiError>>>();
      }
    };

    const result = await request.result();

    assert.ok(!result.ok);
    narrow(result.error);
    assert.ok(isHttpError(result.error, 503));
    assert.equal(result.error.data.message, 'down');
  });

  it('should type errors from responses if they are declared', async () => {
    const { fetcher } = createFlakyFetcher(10, undefined, () => new HttpError(404, '', { message: 'nf' }));
    const client = new XClient<Routes>(fetcher);

    const result = await client.get('/users/{id}', { id: 1 }).result();

    assert.ok(!result.ok);
    assert.ok(isHttpError(result.error, 404));
    assert.equal(result.error.data.message, 'nf');
  });

  it('should reject invalid usage if routes are generated', () => {
    const { fetcher } = createFakeFetcher();
    const client = new XClient<Routes>(fetcher);

    // @ts-expect-error — /ping has no post
    void (() => client.post('/ping'));
    // @ts-expect-error — email is required
    void (() => client.post('/users').body({ name: 'x' }));
    // @ts-expect-error — invalid enum value in query
    void (() => client.get('/users').params({ role: 'root' }));
    // @ts-expect-error — path param is required
    void (() => client.get('/users/{id}'));
  });
});

describe('FromOpenApi + server-sent events', () => {
  type Message = components['schemas']['Message'];

  it('should map a union of { event, data } objects to named events if the response is text/event-stream', () => {
    assertType<Equal<Routes['/events']['get']['events'], { tick: { n: number }; done: { total: number } }>>();
  });

  it('should not declare a response if the response is only text/event-stream', () => {
    assertType<Equal<'response' extends keyof Routes['/events']['get'] ? true : false, false>>();
    assertType<Equal<'response' extends keyof Routes['/messages']['get'] ? true : false, false>>();
  });

  it('should map a plain schema to message events if the schema has no event names', () => {
    assertType<Equal<Routes['/messages']['get']['events'], { message: Message }>>();
  });

  it('should keep the other content as response and add events if the response is negotiated', () => {
    type Mixed = FromOpenApi<{
      '/mixed': {
        get: {
          responses: {
            200: {
              content: {
                'application/json': { total: number };
                'text/event-stream': { event: 'tick'; data: { n: number } };
              };
            };
          };
        };
      };
    }>;

    assertType<Equal<Mixed['/mixed']['get']['response'], { total: number }>>();
    assertType<Equal<Mixed['/mixed']['get']['events'], { tick: { n: number } }>>();
  });

  it('should not add events if the response has no text/event-stream content', () => {
    assertType<Equal<'events' extends keyof Routes['/ping']['get'] ? true : false, false>>();
    assertType<Equal<'events' extends keyof Routes['/users']['get'] ? true : false, false>>();
  });

  it('should type the stream of the client from the generated schema if stream() is called', async () => {
    const { fetcher } = createStreamFetcher([[
      event('{"n":1}', { event: 'tick' }),
      event('{"total":1}', { event: 'done' }),
    ]]);
    const client = new XClient<Routes>(fetcher);
    const names: string[] = [];

    for await (const item of client.get('/events').stream()) {
      names.push(item.event);

      if (item.event === 'tick') assertType<Equal<typeof item.data, { n: number }>>();
      if (item.event === 'done') assertType<Equal<typeof item.data, { total: number }>>();
    }

    for await (const item of client.get('/messages').stream({ json: false })) {
      assertType<Equal<typeof item.data, string>>();
    }

    assert.deepEqual(names, ['tick', 'done']);
  });
});
