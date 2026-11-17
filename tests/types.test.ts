import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import XClient from '../src/XClient.js';
import { HttpError, isHttpError } from '../src/errors.js';
import type { NetworkError, ParseError, RequestError, TimeoutError } from '../src/errors.js';
import type { PathParamNames } from '../src/routes.js';
import { createFlakyFetcher } from './helpers.js';
import { createFakeFetcher } from './helpers.js';

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

describe('типизация роутов', () => {
  it('выводит имена path-параметров из строки', () => {
    assertType<Equal<PathParamNames<'/a/{x}/b/{y}'>, 'x' | 'y'>>();
    assertType<Equal<PathParamNames<'/plain'>, never>>();
  });

  it('тип ответа берётся из роута', async () => {
    const { fetcher } = createFakeFetcher([{ id: 1, name: 'A' }]);
    const client = new XClient<Routes>(fetcher);

    const users = await client.get('/users');
    assertType<Equal<typeof users, User[]>>();

    const pong = await client.get('/ping');
    assertType<Equal<typeof pong, 'pong'>>();

    assert.deepEqual(users, [{ id: 1, name: 'A' }]);
  });

  it('предлагает только роуты с нужным методом', () => {
    const { fetcher } = createFakeFetcher();
    const client = new XClient<Routes>(fetcher);

    // /ping имеет только get
    // @ts-expect-error
    void (() => client.post('/ping'));
    // несуществующий путь
    // @ts-expect-error
    void (() => client.get('/nope'));
    // у /users нет delete
    // @ts-expect-error
    void (() => client.delete('/users'));
  });

  it('path-параметры обязательны и проверяются по именам', async () => {
    const { fetcher, calls } = createFakeFetcher({ id: 1, name: 'A' });
    const client = new XClient<Routes>(fetcher);

    const user = await client.get('/companies/{companyId}/users/{userId}', { companyId: 1, userId: 2 });
    assertType<Equal<typeof user, User>>();
    assert.equal(calls[0]?.url, '/companies/1/users/2');

    // @ts-expect-error — параметры не переданы
    void (() => client.get('/companies/{companyId}/users/{userId}'));
    // @ts-expect-error — опечатка в имени
    void (() => client.get('/companies/{companyId}/users/{userId}', { companyId: 1, user: 2 }));
    // @ts-expect-error — не хватает параметра
    void (() => client.get('/companies/{companyId}/users/{userId}', { companyId: 1 }));
    // @ts-expect-error — роут без параметров не принимает их
    void (() => client.get('/users', { id: 1 }));
  });

  it('body типизируется по роуту', async () => {
    const { fetcher, calls } = createFakeFetcher({ id: 1, name: 'A' });
    const client = new XClient<Routes>(fetcher);

    const created = await client.post('/users').body({ name: 'A' });
    assertType<Equal<typeof created, User>>();
    assert.deepEqual(calls[0]?.body, { name: 'A' });

    // @ts-expect-error — неверное поле
    void (() => client.post('/users').body({ title: 'A' }));
    // @ts-expect-error — у get /users нет body
    void (() => client.get('/users').body({ name: 'A' }));
  });

  it('params (query) типизируются по роуту', async () => {
    const { fetcher, calls } = createFakeFetcher([]);
    const client = new XClient<Routes>(fetcher);

    await client.get('/users').params({ page: 2 });
    assert.deepEqual(calls[0]?.params, { page: 2 });

    // @ts-expect-error — page должен быть числом
    void (() => client.get('/users').params({ page: 'two' }));
    // @ts-expect-error — у post /users нет query
    void (() => client.post('/users').params({ page: 1 }));
  });

  it('fallback расширяет тип результата и сохраняет типизацию', async () => {
    const { fetcher } = createFakeFetcher({ id: 1, name: 'A' });
    const client = new XClient<Routes>(fetcher);

    const result = await client.post('/users').body({ name: 'A' }).fallback(null);
    assertType<Equal<typeof result, User | null>>();

    // @ts-expect-error — типизация body не потерялась после fallback
    void (() => client.post('/users').fallback(null).body({ nope: 1 }));
  });

  it('без описанных роутов клиент принимает любой url (как раньше)', async () => {
    const { fetcher, calls } = createFakeFetcher({ any: 1 });
    const client = new XClient(fetcher);

    const result = await client.get('/whatever/{id}', { id: 5 }).body({ free: 'form' });

    assertType<Equal<typeof result, unknown>>();
    assert.equal(calls[0]?.url, '/whatever/5');
  });

  describe('типизация ошибок', () => {
    type NotFound = { message: string };

    it('result() возвращает дискриминируемый union', async () => {
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

    it('error содержит объявленные HttpError и системные ошибки', async () => {
      const { fetcher } = createFlakyFetcher(10, undefined, () => new HttpError(404, '{}', { message: 'nf' }));
      const client = new XClient<Routes>(fetcher);
      const request = client.get('/orders/{id}', { id: 1 });
      type Err = ErrorOfResult<Awaited<ReturnType<typeof request.result>>>;

      // проверки сужения живут в функции, чтобы flow-анализ теста не влиял на типы
      const narrow = (error: Err) => {
        assertType<Equal<typeof error.kind, 'http' | 'timeout' | 'network' | 'parse'>>();

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
      };

      const result = await request.result();

      assert.ok(!result.ok);
      narrow(result.error);
      assert.ok(isHttpError(result.error, 404));
      assert.equal((result.error.data as NotFound).message, 'nf');
    });

    it('роут без errors: HttpError с unknown-данными', async () => {
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

    it('в нетипизированном режиме error = RequestError', async () => {
      const { fetcher } = createFlakyFetcher(10);

      const result = await new XClient(fetcher).get('/x').result();

      if (!result.ok) assertType<Equal<typeof result.error, RequestError>>();
      assert.equal(result.ok, false);
    });

    it('errors сохраняются после .fallback() и других методов цепочки', () => {
      const { fetcher } = createFlakyFetcher(0, { id: 1 });
      const client = new XClient<Routes>(fetcher);

      const request = client.get('/orders/{id}', { id: 1 }).timeout(100).retries(2).fallback(null);
      type Err = Awaited<ReturnType<typeof request.result>> extends infer R
        ? R extends { ok: false; error: infer E } ? E : never
        : never;

      assertType<Equal<Extract<Err, HttpError<404, NotFound>>, HttpError<404, NotFound>>>();
    });

    it('isHttpError на unknown (catch) сужает до HttpError', () => {
      const check = (caught: unknown) => {
        if (isHttpError(caught, 409)) {
          assertType<Equal<typeof caught, HttpError<409>>>();
        }
      };

      check(new HttpError(409, ''));
      assert.ok(isHttpError(new HttpError(409, ''), 409));
    });
  });
});
