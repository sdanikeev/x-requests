# SCHEMAS — типизация роутов и импорт схем из Express / Fastify / NestJS

Статус: дизайн-документ (ничего из описанного ещё не реализовано).

Цель: чтобы клиент знал, какие у бэкенда есть роуты, и по строке пути выводил типы
параметров, query, body и ответа. Схемы должны «забираться» из популярных
фреймворков без ручного переписывания.

## 1. Главная идея

У трёх фреймворков нет общего формата схем, но у всех трёх есть путь к **OpenAPI**:

| Фреймворк | Где живут схемы                                    | Путь к OpenAPI                                              |
| --------- | -------------------------------------------------- | ----------------------------------------------------------- |
| Fastify   | JSON Schema в опциях роута (`schema: { body, querystring, params, response }`) | `@fastify/swagger` (`fastify.swagger()`)       |
| NestJS    | DTO-классы + декораторы                            | `@nestjs/swagger` (`SwaggerModule.createDocument`)          |
| Express   | Нигде: роуты и хендлеры нетипизированы             | Только через сторонние инструменты (zod-to-openapi, tsoa, swagger-jsdoc и т. п.) |

Поэтому **OpenAPI — промежуточное представление (IR)**, а фреймворки — источники.
Дальше из OpenAPI генерируются TypeScript-типы, и клиент работает уже только с ними.

```
Express ─┐
Fastify ─┼─► OpenAPI 3.x (JSON) ─► codegen ─► schema.d.ts ─► xclient<paths>()
NestJS  ─┘
```

Преимущества: одна точка входа для клиента, любые не-JS источники (Go, Python, готовый
`openapi.json` по URL) работают «бесплатно».

## 2. Не изобретаем генератор типов

Конвертацию OpenAPI → TypeScript уже хорошо делает `openapi-typescript`. Он выдаёт
интерфейс `paths`:

```ts
interface paths {
  '/users/{id}': {
    get: {
      parameters: { path: { id: number }; query?: { expand?: string } };
      responses: { 200: { content: { 'application/json': User } }; 404: { ... } };
    };
  };
  '/users': {
    post: {
      requestBody: { content: { 'application/json': CreateUser } };
      responses: { 201: { content: { 'application/json': User } } };
    };
  };
}
```

Наша ценность — не генерация, а **клиент поверх этих типов**: thenable-билдер,
ретраи, таймауты, фолбеки (близкий аналог — `openapi-fetch`, но без этого набора).
Поэтому каноничный вход клиента — тип `paths` в формате `openapi-typescript`.
Свою схему описания роутов вводить не нужно.

## 3. Слои

1. **Core** (`x-requests`) — клиент. Принимает `paths` как дженерик. Не знает ни про
   какие фреймворки.
2. **Type-утилиты** (внутри core) — вывод типов из `paths`:
   `PathsOf<M>`, `PathParams<P>`, `QueryOf`, `BodyOf`, `ResponseOf`, `ErrorOf<Status>`.
3. **Codegen CLI** (`x-requests gen`) — получает OpenAPI из источника и пишет
   `schema.d.ts` (внутри вызывает `openapi-typescript`).
4. **Source-адаптеры** — умеют достать OpenAPI из конкретного фреймворка.

Адаптеры можно сначала держать как subpath-экспорты (`x-requests/fastify`,
`x-requests/nest`), а в отдельные пакеты выносить, когда появятся тяжёлые peer-зависимости.

## 4. Источники (адаптеры)

### 4.1. Готовый OpenAPI (файл или URL)

Базовый и самый надёжный вариант, нужен с самого начала:

```bash
x-requests gen --from ./openapi.json --out src/api/schema.d.ts
x-requests gen --from http://localhost:3000/docs/json --out src/api/schema.d.ts
```

### 4.2. Fastify

Самый «чистый» источник: схемы уже есть, и это JSON Schema.

- Скрипт поднимает приложение **без `listen`**, регистрирует `@fastify/swagger`
  (до роутов), вызывает `await app.ready()` и забирает `app.swagger()`.
- С type provider (TypeBox / `fastify-type-provider-zod`) схемы одновременно дают типы
  на сервере и корректный OpenAPI.
- Ограничение: приложение нужно собрать так, чтобы его можно было создать
  отдельно от `listen` (фабрика `buildApp()`).

```ts
// scripts/openapi.ts (пример, на стороне бэкенда)
const app = await buildApp();
await app.ready();
writeFileSync('openapi.json', JSON.stringify(app.swagger()));
```

Возможный API адаптера: `x-requests gen --fastify ./src/app.ts#buildApp`.

### 4.3. NestJS

- Скрипт создаёт приложение через `NestFactory.create(AppModule)`, **без `listen`**,
  затем `SwaggerModule.createDocument(app, config)` и сохраняет документ.
- Типы DTO попадают в спецификацию через декораторы `@ApiProperty` или через CLI-плагин
  `@nestjs/swagger` (он выводит свойства из полей класса).
- Нюансы: глобальный префикс (`setGlobalPrefix`) и версионирование должны попасть
  в пути; для enum и вложенных DTO нужны проверки на реальных проектах.

Возможный API: `x-requests gen --nest ./src/app.module.ts#AppModule`.

### 4.4. Express

У Express схем нет, поэтому честно разделяем уровни поддержки:

| Уровень | Что получаем | Как |
| ------- | ------------ | --- |
| A. Только роуты | Автокомплит путей и методов, всё остальное `unknown` | Интроспекция `app.router` (Express 5) или `app._router.stack` (Express 4) |
| B. Через OpenAPI-инструмент | Полные типы | Пользователь подключает `@asteasolutions/zod-to-openapi`, `tsoa` или `swagger-jsdoc`, дальше работаем как с готовым OpenAPI (п. 4.1) |
| C. Contract-first (на будущее) | Полные типы и валидация | Контракт на zod/TypeBox, из него и OpenAPI, и типы клиента |

Уровень A полезен, но ограничен: интроспекция не знает типов. Рекомендуемый
путь для Express — **B**, а в документации давать готовые рецепты.

## 5. Как клиент использует типы

```ts
import xclient from 'x-requests';
import type { paths } from './api/schema';

const client = xclient<paths>({ config: { baseUrl: 'https://api.example.com' } });

const user = await client.get('/users/{id}', { path: { id: 1 } });
//    ^? User

await client.post('/users', { body: { name: 'Alice' } }); // body проверяется
```

### Решение: обязательные входы — аргументом, настройки — цепочкой

Если делать `.path()`, `.body()` цепочкой, придётся кодировать в типах
«конструктор ещё не получил обязательное» и скрывать `then`, пока не всё задано.
Это сложно и плохо читается в ошибках. Проще:

- то, что **определяется схемой** (path, query, body, headers) — вторым аргументом,
  и тип этого объекта выводится из роута (обязательные поля обязательны);
- то, что **не зависит от схемы** (timeout, retries, fallback) — цепочкой.

```ts
await client
  .get('/users/{id}', { path: { id: 1 }, query: { expand: 'profile' } })
  .timeout(5000)
  .retries(3)
  .fallback(null);
```

Текущие методы `.body()`, `.params()`, `.headers()` остаются для нетипизированного
режима (`xclient()` без дженерика, всё `unknown`).

### Синтаксис параметров пути

OpenAPI использует `{id}`, Express/Fastify/Nest — `:id`. Каноничным делаем
`{id}` (так приходит из OpenAPI), `:id` не поддерживаем в типах, чтобы не плодить
два формата. Адаптеры при необходимости нормализуют пути.

### Вывод типов (набросок)

```ts
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options';

// только пути, у которых есть метод M
type PathsWith<P, M extends Method> = {
  [K in keyof P]: M extends keyof P[K] ? K : never;
}[keyof P];

type SuccessResponse<Op> = Op extends { responses: infer R }
  ? { [S in keyof R & (200 | 201 | 202 | 204)]: JsonContent<R[S]> }[keyof R & (200 | 201 | 202 | 204)]
  : unknown;
```

`client.get` принимает только `PathsWith<P, 'get'>`, так что автокомплит
подсказывает лишь существующие GET-роуты.

## 6. Фолбеки

Вписываются после ретраев: сначала повторы, потом фолбек.

- `.fallback(value | (error) => value)` — значение по умолчанию при финальной ошибке;
  тип результата становится `T | F`.
- Решить отдельно: фолбек срабатывает на **любую** ошибку или только на те, что
  прошли политику ретраев (`5xx`, `429`, сеть)? Предложение: по умолчанию на всё,
  но с опцией `{ on: (error) => boolean }`.
- Запасной источник (второй хост) — отдельная фича, не смешивать с `fallback`.

## 7. Структура вывода кодогенерации

```
src/api/
  schema.d.ts        # сгенерировано, не править руками, коммитить
  client.ts          # xclient<paths>(...) — пишет пользователь
```

Конфиг `x-requests.config.ts` (опционально):

```ts
export default {
  sources: [
    { name: 'main', from: './openapi.json', out: 'src/api/main.d.ts' },
    { name: 'billing', from: 'http://localhost:4000/docs/json', out: 'src/api/billing.d.ts' },
  ],
};
```

Несколько источников — несколько независимых `paths`, на каждый свой клиент.

## 8. Риски и открытые вопросы

- **Express** без схем даёт неполную картину; нужно честно писать об этом в README.
- **OpenAPI 3.0 vs 3.1.** `openapi-typescript` поддерживает оба, но Nest исторически
  отдаёт 3.0; проверить на реальных документах.
- **Несколько статусов ответа.** Решить, как `await` типизируется: успешный
  2xx как значение, а ошибки — как `HttpError<404, NotFoundBody>` в `catch`
  (в TypeScript `catch` нетипизирован, поэтому, возможно, нужен хелпер `isHttpError(e, 404)`).
- **Даты и бинарные данные.** В JSON даты — строки; не выдавать `Date`, пока нет
  runtime-преобразования.
- **Content-Type.** Сейчас клиент говорит только про JSON. `multipart/form-data`,
  загрузки файлов и стримы — отдельная задача.
- **Пути с префиксами/версиями** (Nest `setGlobalPrefix`, Fastify `prefix`) —
  убедиться, что `baseUrl` + путь из схемы не дублируют префикс.
- **Рантайм-валидация ответов.** Типы без проверки — это обещание, а не гарантия.
  Опциональная валидация через ajv по схемам из OpenAPI — задача на потом.
- **Свой формат vs чужой.** Если когда-то понадобится contract-first (п. 4.4 С),
  вводить его как ещё один *источник*, который тоже выдаёт OpenAPI, а не как второй
  вход клиента.

## 9. Дорожная карта

0. **Починить базовые типы.** Тип `JSON` в `Body`/`Headers` (это глобальный
   объект, не JSON-значение), переименовать `Headers`, заменить метод `update`
   на `put`/`delete`. Всё остальное строится на этих типах.
1. **Type core.** Дженерик `xclient<paths>()`, вывод path/query/body/response,
   перегрузки для нетипизированного режима. Проверка типов тестами (`tsd` или
   `// @ts-expect-error` в тестах).
2. **Метод `.fallback()`.**
3. **Codegen CLI** (`gen --from file|url`) поверх `openapi-typescript`.
4. **Fastify-адаптер** (проще всего, схемы уже в JSON Schema).
5. **Nest-адаптер.**
6. **Express:** уровень A (интроспекция) + документация с рецептами для zod-to-openapi / tsoa.
7. **Опционально:** `watch`-режим, рантайм-валидация, несколько источников.

## 10. Решения, которые нужно принять до старта

1. Каноничный формат — `paths` из `openapi-typescript` (рекомендуется) или свой?
2. Обязательные входы аргументом (рекомендуется) или цепочкой?
3. Синтаксис путей: только `{id}` (рекомендуется) или поддерживать и `:id`?
4. Адаптеры — subpath-экспорты в одном пакете или отдельные пакеты?
