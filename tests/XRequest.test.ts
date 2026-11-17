import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import XRequest from '../src/XRequest.js';
import { HttpError } from '../src/errors.js';
import { createFakeFetcher, createFlakyFetcher } from './helpers.js';

describe('XRequest', () => {
  it('отправляет method и url в fetcher', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XRequest(fetcher, 'get', 'https://example.com/users');

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'get');
    assert.equal(calls[0]?.url, 'https://example.com/users');
  });

  it('пробрасывает body, params и headers', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XRequest(fetcher, 'post', 'https://example.com/users')
      .body({ name: 'a' })
      .params({ page: 1 })
      .headers({ Authorization: 'Bearer x' });

    assert.deepEqual(calls[0]?.body, { name: 'a' });
    assert.deepEqual(calls[0]?.params, { page: 1 });
    assert.deepEqual(calls[0]?.headers, { Authorization: 'Bearer x' });
  });

  it('не добавляет body/params/headers, если они не заданы', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XRequest(fetcher, 'get', 'https://example.com');

    assert.ok(!('body' in calls[0]!));
    assert.ok(!('params' in calls[0]!));
    assert.ok(!('headers' in calls[0]!));
  });

  it('возвращает ответ fetcher через await', async () => {
    const { fetcher } = createFakeFetcher({ id: 1 });

    const result = await new XRequest(fetcher, 'get', 'https://example.com');

    assert.deepEqual(result, { id: 1 });
  });

  it('builder-методы возвращают this (цепочка)', () => {
    const { fetcher } = createFakeFetcher();
    const req = new XRequest(fetcher, 'get', 'https://example.com');

    assert.equal(req.body({}), req);
    assert.equal(req.params({}), req);
    assert.equal(req.headers({}), req);
    assert.equal(req.timeout(100), req);
  });

  it('склеивает относительный url с baseUrl', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XRequest(fetcher, 'get', '/users', { baseUrl: 'https://example.com' });

    assert.equal(calls[0]?.url, 'https://example.com/users');
  });

  it('сохраняет путь из baseUrl (/api/v1)', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XRequest(fetcher, 'get', 'users', { baseUrl: 'https://example.com/api/v1/' });

    assert.equal(calls[0]?.url, 'https://example.com/api/v1/users');
  });

  it('ошибка при пустом url', async () => {
    const { fetcher } = createFakeFetcher();

    await assert.rejects(async () => {
      await new XRequest(fetcher, 'get', '');
    });
  });

  it('запрос выполняется один раз при нескольких await', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const req = new XRequest(fetcher, 'get', 'https://example.com');

    await req;
    await req;

    assert.equal(calls.length, 1);
  });

  it('timeout передаётся в fetcher', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XRequest(fetcher, 'get', 'https://example.com').timeout(500);

    assert.equal((calls[0] as { timeout?: number }).timeout, 500);
  });

  describe('retries', () => {
    it('без retries запрос выполняется один раз и ошибка пробрасывается', async () => {
      const { fetcher, calls } = createFlakyFetcher(1);

      await assert.rejects(async () => await new XRequest(fetcher, 'get', 'https://example.com'), /fail #1/);

      assert.equal(calls.length, 1);
    });

    it('повторяет запрос и возвращает результат успешной попытки', async () => {
      const { fetcher, calls } = createFlakyFetcher(2, { data: 42 });

      const result = await new XRequest(fetcher, 'get', 'https://example.com').retries(3, 1);

      assert.deepEqual(result, { data: 42 });
      assert.equal(calls.length, 3);
    });

    it('не делает лишних попыток после успеха', async () => {
      const { fetcher, calls } = createFlakyFetcher(0);

      await new XRequest(fetcher, 'get', 'https://example.com').retries(3, 1);

      assert.equal(calls.length, 1);
    });

    it('после исчерпания попыток бросает последнюю ошибку', async () => {
      const { fetcher, calls } = createFlakyFetcher(10);

      await assert.rejects(
        async () => await new XRequest(fetcher, 'get', 'https://example.com').retries(2, 1),
        /fail #3/,
      );

      assert.equal(calls.length, 3);
    });

    it('ждёт backoff между попытками', async () => {
      const { fetcher } = createFlakyFetcher(2);
      const start = Date.now();

      await new XRequest(fetcher, 'get', 'https://example.com').retries(2, 30);

      assert.ok(Date.now() - start >= 80);
    });

    it('несколько await не запускают ретраи заново', async () => {
      const { fetcher, calls } = createFlakyFetcher(1);
      const req = new XRequest(fetcher, 'get', 'https://example.com').retries(2, 1);

      await req;
      await req;

      assert.equal(calls.length, 2);
    });

    for (const status of [400, 401, 403, 404, 422]) {
      it(`не повторяет запрос при ${status}`, async () => {
        const { fetcher, calls } = createFlakyFetcher(10, undefined, () => new HttpError(status, ''));

        await assert.rejects(
          async () => await new XRequest(fetcher, 'get', 'https://example.com').retries(3, 1),
          (err: unknown) => err instanceof HttpError && err.status === status,
        );

        assert.equal(calls.length, 1);
      });
    }

    for (const status of [429, 500, 503]) {
      it(`повторяет запрос при ${status}`, async () => {
        const { fetcher, calls } = createFlakyFetcher(1, { ok: true }, () => new HttpError(status, ''));

        const result = await new XRequest(fetcher, 'get', 'https://example.com').retries(2, 1);

        assert.deepEqual(result, { ok: true });
        assert.equal(calls.length, 2);
      });
    }

    it('не повторяет запрос при ошибке валидации (нет url)', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await assert.rejects(
        async () => await new XRequest(fetcher, 'get', '').retries(3, 1),
        /The value is missing: url/,
      );

      assert.equal(calls.length, 0);
    });

    it('retries больше maxRetries из конфига бросает ошибку', () => {
      const { fetcher } = createFakeFetcher();
      const req = new XRequest(fetcher, 'get', 'https://example.com', { maxRetries: 2 });

      assert.throws(() => req.retries(3, 1), /maxRetries/);
    });

    it('retries в пределах maxRetries допускается', () => {
      const { fetcher } = createFakeFetcher();
      const req = new XRequest(fetcher, 'get', 'https://example.com', { maxRetries: 2 });

      assert.doesNotThrow(() => req.retries(2, 1));
    });

    it('maxRetries: 0 в конфиге недопустим', () => {
      const { fetcher } = createFakeFetcher();

      assert.throws(
        () => new XRequest(fetcher, 'get', 'https://example.com', { maxRetries: 0 }),
        /maxRetries/,
      );
    });

    it('retries(0) недопустим', () => {
      const { fetcher } = createFakeFetcher();
      const req = new XRequest(fetcher, 'get', 'https://example.com');

      assert.throws(() => req.retries(0, 1), /Retry count/);
    });
  });

  describe('fallback', () => {
    it('возвращает значение фолбека при ошибке', async () => {
      const { fetcher } = createFlakyFetcher(10);

      const result = await new XRequest(fetcher, 'get', 'https://example.com').fallback({ cached: true });

      assert.deepEqual(result, { cached: true });
    });

    it('falsy значения тоже работают как фолбек', async () => {
      for (const value of [0, null, '', false]) {
        const { fetcher } = createFlakyFetcher(10);

        const result = await new XRequest(fetcher, 'get', 'https://example.com').fallback(value);

        assert.equal(result, value);
      }
    });

    it('функция вызывается лениво и получает ошибку', async () => {
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

    it('не вызывается и не нужен при успешном ответе', async () => {
      const { fetcher } = createFlakyFetcher(0, { real: 1 });
      let called = false;

      const result = await new XRequest(fetcher, 'get', 'https://example.com').fallback(() => {
        called = true;

        return { fake: 1 };
      });

      assert.deepEqual(result, { real: 1 });
      assert.equal(called, false);
    });

    it('срабатывает только после исчерпания ретраев', async () => {
      const { fetcher, calls } = createFlakyFetcher(10);

      const result = await new XRequest(fetcher, 'get', 'https://example.com')
        .retries(2, 1)
        .fallback('fallback');

      assert.equal(result, 'fallback');
      assert.equal(calls.length, 3);
    });

    it('успешный ретрай возвращает реальный ответ, а не фолбек', async () => {
      const { fetcher } = createFlakyFetcher(1, 'real');

      const result = await new XRequest(fetcher, 'get', 'https://example.com')
        .retries(2, 1)
        .fallback('fallback');

      assert.equal(result, 'real');
    });

    it('без фолбека ошибка по-прежнему пробрасывается', async () => {
      const { fetcher } = createFlakyFetcher(10);

      await assert.rejects(async () => await new XRequest(fetcher, 'get', 'https://example.com'), /fail #1/);
    });

    it('не скрывает ошибку валидации', async () => {
      const { fetcher } = createFakeFetcher();

      await assert.rejects(
        async () => await new XRequest(fetcher, 'get', '').fallback('x'),
        /The value is missing: url/,
      );
    });

    it('не вызывает onrejected, если фолбек обработал ошибку', async () => {
      const { fetcher } = createFlakyFetcher(10);
      let rejected = false;

      await new XRequest(fetcher, 'get', 'https://example.com')
        .fallback('x')
        .then(undefined, () => {
          rejected = true;
        });

      assert.equal(rejected, false);
    });

    it('повторный await не вызывает фолбек и запрос заново', async () => {
      const { fetcher, calls } = createFlakyFetcher(10);
      const req = new XRequest(fetcher, 'get', 'https://example.com').fallback('x');

      await req;
      await req;

      assert.equal(calls.length, 1);
    });
  });

  describe('url и конфиг', () => {
    it('baseUrl не применяется к абсолютному url', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', 'https://other.com/x', { baseUrl: 'https://api.com' });

      assert.equal(calls[0]?.url, 'https://other.com/x');
    });

    it('baseUrl склеивается без двойных слэшей', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', '//users', { baseUrl: 'https://api.com///' });

      assert.equal(calls[0]?.url, 'https://api.com/users');
    });

    it('timeout(null) не передаёт timeout в fetcher', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', 'https://example.com').timeout(null);

      assert.equal('timeout' in (calls[0] ?? {}), false);
    });

    it('пустой метод или url дают ошибку валидации', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await assert.rejects(
        async () => await new XRequest(fetcher, 'get', ''),
        /The value is missing: url/,
      );
      assert.equal(calls.length, 0);
    });

    it('retries(n) без backoff использует 500 мс по умолчанию и не падает', () => {
      const { fetcher } = createFakeFetcher();

      assert.doesNotThrow(() => new XRequest(fetcher, 'get', 'https://example.com').retries(2));
    });
  });

  describe('path-параметры', () => {
    it('подставляет параметры в url', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', 'https://api.com/companies/{companyId}/users/{userId}')
        .path({ companyId: 1, userId: 'abc' });

      assert.equal(calls[0]?.url, 'https://api.com/companies/1/users/abc');
    });

    it('экранирует значения', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', 'https://api.com/files/{name}').path({ name: 'a/b c?' });

      assert.equal(calls[0]?.url, 'https://api.com/files/a%2Fb%20c%3F');
    });

    it('работает вместе с baseUrl', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', '/users/{id}', { baseUrl: 'https://api.com' }).path({ id: 7 });

      assert.equal(calls[0]?.url, 'https://api.com/users/7');
    });

    it('один параметр может встречаться несколько раз', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', 'https://api.com/{id}/copy/{id}').path({ id: 5 });

      assert.equal(calls[0]?.url, 'https://api.com/5/copy/5');
    });

    it('кидает ошибку, если параметр не передан, и не шлёт запрос', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await assert.rejects(
        async () => await new XRequest(fetcher, 'get', 'https://api.com/users/{id}'),
        /The path parameter is missing: id/,
      );
      assert.equal(calls.length, 0);
    });

    it('фолбек не скрывает отсутствующий path-параметр', async () => {
      const { fetcher } = createFakeFetcher();

      await assert.rejects(
        async () => await new XRequest(fetcher, 'get', 'https://api.com/users/{id}').fallback('x'),
        /The path parameter is missing/,
      );
    });

    it('url без плейсхолдеров не меняется', async () => {
      const { fetcher, calls } = createFakeFetcher();

      await new XRequest(fetcher, 'get', 'https://api.com/users').path({ id: 1 });

      assert.equal(calls[0]?.url, 'https://api.com/users');
    });
  });
});
