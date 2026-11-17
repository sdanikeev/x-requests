import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { components, paths } from '../examples/generated_v1.js';
import type { FromOpenApi } from '../src/codegen/types.js';
import { HttpError, isHttpError } from '../src/errors.js';
import XClient from '../src/XClient.js';
import { createFakeFetcher, createFlakyFetcher } from './helpers.js';

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
  it('сохраняет все пути', () => {
    assertType<Equal<keyof Routes, '/ping' | '/users' | '/users/{id}' | '/companies/{companyId}/users/{userId}'>>();
  });

  it('отбрасывает методы, которых нет (put?: never) и служебный ключ parameters', () => {
    assertType<Equal<keyof Routes['/ping'], 'get'>>();
    assertType<Equal<keyof Routes['/users'], 'get' | 'post'>>();
    assertType<Equal<keyof Routes['/users/{id}'], 'get' | 'patch' | 'delete'>>();
  });

  it('text/plain ответ: берётся единственный content type', () => {
    assertType<Equal<Routes['/ping']['get'], { response: 'pong' }>>();
  });

  it('query и массив в ответе', () => {
    assertType<Equal<Routes['/users']['get'], {
      query?: { page?: number; limit?: number; role?: components['schemas']['Role'] };
      response: User[];
    }>>();
  });

  it('POST: body, ответ 201 и типизированные ошибки', () => {
    assertType<Equal<Routes['/users']['post'], {
      body: CreateUser;
      response: User;
      errors: { 409: ApiError; 422: ValidationError };
    }>>();
  });

  it('параметры path-уровня попадают в операцию, query остаётся необязательным', () => {
    assertType<Equal<Routes['/users/{id}']['get'], {
      query?: { expand?: 'company' | 'orders' };
      path: { id: number };
      response: User;
      errors: { 404: ApiError };
    }>>();
  });

  it('PATCH: body из requestBody', () => {
    assertType<Equal<Routes['/users/{id}']['patch'], {
      body: UpdateUser;
      path: { id: number };
      response: User;
      errors: { 404: ApiError };
    }>>();
  });

  it('DELETE: 204 без content -> response: undefined', () => {
    assertType<Equal<Routes['/users/{id}']['delete'], {
      path: { id: number };
      response: undefined;
      errors: { 404: ApiError };
    }>>();
  });

  it('header-параметры -> headers, path-параметры типизированы, default -> errors.default', () => {
    assertType<Equal<Routes['/companies/{companyId}/users/{userId}']['get'], {
      headers?: { 'X-Request-Id'?: string };
      path: { companyId: number; userId: number };
      response: User;
      errors: { default: ApiError };
    }>>();
  });

  it('обязательность сохраняется: required query и необязательный requestBody', () => {
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

describe('FromOpenApi + клиент', () => {
  const user: User = { id: 1, email: 'a@b.c', role: 'admin' };

  it('xclient выводит типы из сгенерированной схемы', async () => {
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

  it('типы path-параметров берутся из схемы', () => {
    const { fetcher } = createFakeFetcher();
    const client = new XClient<Routes>(fetcher);

    // допустимо: id — number
    void (() => client.get('/users/{id}', { id: 1 }));
    // @ts-expect-error — в схеме id: integer, строка недопустима
    void (() => client.get('/users/{id}', { id: 'abc' }));
    // @ts-expect-error — лишний параметр
    void (() => client.get('/users/{id}', { id: 1, extra: 1 }));
  });

  it('errors.default типизирует тело для остальных статусов', async () => {
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

  it('ошибки типизируются из responses', async () => {
    const { fetcher } = createFlakyFetcher(10, undefined, () => new HttpError(404, '', { message: 'nf' }));
    const client = new XClient<Routes>(fetcher);

    const result = await client.get('/users/{id}', { id: 1 }).result();

    assert.ok(!result.ok);
    assert.ok(isHttpError(result.error, 404));
    assert.equal(result.error.data.message, 'nf');
  });

  it('проверки типов работают на сгенерированных роутах', () => {
    const { fetcher } = createFakeFetcher();
    const client = new XClient<Routes>(fetcher);

    // @ts-expect-error — у /ping нет post
    void (() => client.post('/ping'));
    // @ts-expect-error — email обязателен
    void (() => client.post('/users').body({ name: 'x' }));
    // @ts-expect-error — неверное значение enum в query
    void (() => client.get('/users').params({ role: 'root' }));
    // @ts-expect-error — path-параметр обязателен
    void (() => client.get('/users/{id}'));
  });
});
