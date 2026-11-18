# x-requests

A small, promise-like HTTP client where **the route is the contract**: path params, query, body,
responses and error bodies are typed per route, and retries, timeouts and fallbacks are built in.

```ts
import xclient, { type FromOpenApi, isHttpError } from '@x-requests/core';
import type { paths } from './api/schema'; // generated: npx @x-requests/codegen gen -f openapi.json -t src/api/schema.d.ts

const api = xclient<FromOpenApi<paths>>({ config: { baseUrl: 'https://api.example.com' } });

const result = await api
  .get('/users/{id}', { id: 1 })   // path params are required and checked
  .params({ expand: 'profile' })   // query is typed from the schema
  .timeout(5000)
  .retries(3)                      // exponential backoff, only for errors worth retrying
  .result();                       // never rejects: { ok, data } | { ok, error }

if (result.ok) {
  result.data;                     // typed response
} else if (isHttpError(result.error, 404)) {
  result.error.data;               // typed 404 body
}
```

## Why

| | x-requests | [ky](https://github.com/sindresorhus/ky) | [ofetch](https://github.com/unjs/ofetch) | [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) |
| --- | :---: | :---: | :---: | :---: |
| Types per route from OpenAPI | yes | no | no | yes |
| Typed error bodies per status | yes | no | no | yes |
| Built-in retries with backoff | yes | yes | yes | no |
| Built-in timeout | yes | yes | yes | no |
| `.fallback(value)` | yes | no | no | no |
| Non-throwing `result()` | yes | no | no | yes (default) |

The comparison reflects the default behaviour of each library at the time of writing; the others
can usually do more through hooks or middleware. `x-requests` is the combination: the typing of
`openapi-fetch` with the resilience of `ky`/`ofetch`, in one fluent builder.

## Features

- Fluent, chainable request builder — a request is a thenable, so you simply `await` it.
- Types per route (manual or generated from OpenAPI) for path params, query, body, responses and errors.
- Typed errors (`.result()`, `isHttpError`) and typed error bodies per route.
- Retries with exponential backoff (only for errors that make sense to retry).
- Per-request timeouts, cancellation with `AbortSignal` and `.fallback()`.
- Server-sent events as a typed async iterable with automatic reconnects.
- Automatic JSON handling for request bodies and responses.
- Pluggable `Fetcher` — swap the transport for tests or custom logic.
- Written in TypeScript with strict types; ESM-only.

## Installation

```bash
npm install @x-requests/core
```

The package is ESM-only (`"type": "module"`) and ships its own type declarations.

## Requirements

Node.js with a global `fetch` (Node 18+). If `fetch` is unavailable, the client falls back to `node-fetch`.

## Usage

### Creating a client

```ts
import xclient from '@x-requests/core';

const client = xclient({
  config: {
    baseUrl: 'https://api.example.com', // prepended to relative URLs
    maxRetries: 5,                      // upper limit for .retries()
  },
});
```

Both options are optional. `xclient()` with no arguments is valid.

### Making requests

Available methods: `get`, `post`, `put`, `patch`, `delete`, `options`.

```ts
await client.get('/users');

await client
  .post('/users')
  .headers({ Authorization: 'Bearer <token>' })
  .body({ name: 'Alice' });
```

Absolute URLs (`https://...`) ignore `baseUrl`.

### Path parameters

Use `{name}` placeholders and pass the values as an object — either as the second
argument or via `.path()`:

```ts
await client.get('/companies/{companyId}/users/{userId}', { companyId: 1, userId: 42 });

await client.get('/users/{id}').path({ id: 42 }).timeout(3000);
```

Values are URL-encoded. A missing value throws `The path parameter is missing: <name>`
before any request is sent (and is never replaced by `.fallback()`). Use unique names
(`companyId`, `userId`) rather than repeating `{id}`.

### Request builder

| Method                       | Description                                                       |
| ---------------------------- | ----------------------------------------------------------------- |
| `.path(data)`                | Values for `{name}` placeholders in the URL.                      |
| `.body(data)`                | Request body. Objects are serialized to JSON, strings are sent as-is. |
| `.params(data)`              | Query string parameters. `null` and `undefined` values are skipped. |
| `.headers(data)`             | Request headers.                                                  |
| `.timeout(ms)`               | Abort the request (per attempt) after `ms` milliseconds.          |
| `.retries(count, backoffMs?)`| Retry failed requests up to `count` times. `backoffMs` defaults to `500`. |
| `.fallback(value \| fn)`     | Resolve with `value` (or `fn(error)`) instead of throwing when the request finally fails. |

The request is sent on the first `await` (or `.then`). Awaiting the same
request several times never sends it again — the result is cached.

### Responses

- `application/json` responses are parsed automatically.
- Other content types are returned as text.
- `204` / `205` responses resolve to `undefined`.
- `Content-Type: application/json` is set automatically only when a body is sent.

### Retries

`.retries(3)` means **1 main request + up to 3 retries** (4 requests at most).
The delay between attempts grows exponentially: `backoffMs * 2^attempt`
(500 ms, 1 s, 2 s, ... by default).

Only the following failures are retried:

- network errors and timeouts;
- `5xx` responses;
- `429 Too Many Requests` (see `isRetryableStatus`).

Other `4xx` responses and validation errors are thrown immediately.

`retries` must be at least `1` and cannot exceed `config.maxRetries` if it is set.

### Fallback

`.fallback()` replaces the final error with a default value. It runs only after all
retries are exhausted, and the result type becomes `T | F`.

```ts
const users = await client.get('/users').retries(2).fallback([]);

// a function is treated as a lazy factory and receives the error
const user = await client.get('/me').fallback((error) => ({ guest: true }));
```

Any value works, including `0`, `null`, `''` and `false`. Validation errors (e.g. a
missing URL) are never replaced by the fallback.

### Errors

A request fails with one of four classes, all extending `XRequestError` and
distinguished by a `kind` field:

| Class          | `kind`      | When                                                         |
| -------------- | ----------- | ------------------------------------------------------------ |
| `HttpError`    | `'http'`    | Non-2xx response. Has `status`, raw `body` and parsed `data` (JSON when the response is JSON, otherwise the text). |
| `TimeoutError` | `'timeout'` | `.timeout(ms)` exceeded.                                     |
| `NetworkError` | `'network'` | No response (DNS, connection reset, offline). `cause` holds the original error. |
| `ParseError`   | `'parse'`   | A successful response with invalid JSON.                     |

Programmer mistakes (missing URL, missing path parameter) throw a `ValidationError`
and are not part of this set.

TypeScript types `catch (error)` as `unknown`, so the typed way to handle errors is
`.result()`, which never rejects with a request failure:

```ts
const result = await client.get('/orders/{id}', { id: 1 }).result();

if (result.ok) {
  result.data;                       // typed response
} else if (isHttpError(result.error, 404)) {
  result.error.data.message;         // typed by routes: HttpError<404, NotFound>
} else {
  result.error.kind;                 // 'http' | 'timeout' | 'network' | 'parse'
}
```

`isHttpError(error, status?)` also works in a plain `catch` block (it narrows `unknown`
to `HttpError`). `HttpStatus` provides named constants:

```ts
import { HttpStatus, isHttpError } from '@x-requests/core';

try {
  await client.get('/missing');
} catch (error) {
  if (isHttpError(error, HttpStatus.NOT_FOUND)) {
    console.log(error.status, error.body);
  }
}
```

Declare the error bodies of a route with `errors` to get them typed:

```ts
interface Routes {
  '/orders/{id}': {
    get: {
      response: Order;
      errors: { 404: { message: string }; 422: { fields: string[] } };
    };
  };
}
```

`result.error` is then `HttpError<404, {message: string}> | HttpError<422, {fields: string[]}> | RequestError`:
the server may always answer with an undeclared status, so the generic errors stay in the union.

### Cancellation

Pass an `AbortSignal` to cancel a request, for example when a component unmounts or the user types again:

```ts
const controller = new AbortController();

const result = await client.get('/search').params({ q }).signal(controller.signal).result();

controller.abort(); // result.error is an AbortError (kind: 'abort')
```

- An aborted request is never retried, also during the pause between attempts.
- `.fallback()` does not hide an abort: cancelling means you do not want a value.
- `.signal()` works together with `.timeout()`: whichever fires first wins (`AbortError` or `TimeoutError`).
- The reason passed to `controller.abort(reason)` is available as `error.cause`.

### Server-sent events

`.stream()` opens an SSE connection and returns an async iterable of events:

```ts
interface Routes {
  '/events': { get: { events: { tick: { n: number }; done: { total: number } } } };
}

const client = xclient<Routes>({ config: { baseUrl: 'https://api.example.com' } });

for await (const event of client.get('/events').headers({ Authorization: `Bearer ${token}` }).stream()) {
  if (event.event === 'tick') event.data.n;       // { n: number }
  if (event.event === 'done') event.data.total;   // { total: number }
}
```

- `data` is parsed as JSON. For plain text (or a sentinel like `[DONE]`) use `.stream({ json: false })`: `data` stays a `string`.
- Declare the events of a route with `events: { [name]: DataType }`; without it `data` is `unknown` and `event` is a `string`.
- Any method works (`client.post('/chat').body(...).stream()`), and `.signal()` closes the connection. Breaking out of the loop closes it too.
- **Reconnects:** after a failure (network error, a retryable status) the stream reconnects up to `.retries(n, backoff)` times, sending `Last-Event-ID` and waiting for the `retry:` hint of the server if it sent one. The counter resets when an event arrives. A stream the server closes normally just ends; it is not reconnected.
- `.timeout(ms)` limits only the wait for the connection, not the whole stream.
- Middlewares run once per connection: `onRequest` can add headers, `onResponse` receives the stream.
- A custom `Fetcher` needs a `stream()` method for this; otherwise `.stream()` throws a `ValidationError`.

### Middleware

A middleware wraps every attempt of a request (including retries) and can change the request,
the response, or skip the call altogether:

```ts
const off = client.use(async (req, next) => {
  const started = Date.now();
  const response = await next({ ...req, headers: { ...req.headers, Authorization: `Bearer ${token}` } });

  console.log(req.url, Date.now() - started, 'ms');

  return response;
});

client.onRequest(req => ({ ...req, headers: { ...req.headers, 'X-Trace': id } })); // before
client.onResponse(response => unwrap(response));                                     // after

off(); // remove a middleware
```

Middlewares can also be passed up front: `xclient({ config: { middleware: [...] } })`.

- Order: the first registered middleware is the outermost one, so `onRequest` handlers run in
  registration order and `onResponse` handlers in reverse.
- Middlewares added later apply to the requests made after that; each client has its own list.
- An error thrown by a middleware goes through the same rules as a fetcher error (`NetworkError`, retries).
- A middleware sees the plain request and the raw response (`unknown`), not the types of a route.

### Custom fetcher

Anything implementing the `Fetcher` interface can be used as the transport,
which is handy for tests:

```ts
import xclient, { type Fetcher } from '@x-requests/core';

const fetcher: Fetcher = {
  async request(data) {
    console.log(data.method, data.url);
    return { ok: true } as never;
  },
};

const client = xclient({ fetcher });
```

## Typed routes

Describe your API once and get autocomplete and type checks for urls, path parameters,
`.params()` (query), `.body()` and the response:

```ts
import xclient from '@x-requests/core';

interface Routes {
  '/users': {
    get: { query?: { page?: number }; response: User[] };
    post: { body: CreateUser; response: User };
  };
  '/companies/{companyId}/users/{userId}': {
    get: { response: User };
  };
}

const client = xclient<Routes>({ config: { baseUrl: 'https://api.example.com' } });

const users = await client.get('/users').params({ page: 2 });        // User[]
const user = await client.post('/users').body({ name: 'Alice' });    // User
const one = await client.get('/companies/{companyId}/users/{userId}', {
  companyId: 1,
  userId: 2,
});                                                                  // User
```

What is checked:

- only routes that declare the called method are accepted (`client.post('/ping')` is an error);
- path parameters are required and checked by name, taken from the `{placeholders}`;
- `.body()` / `.params()` accept the declared types and are rejected for routes without them;
- `.fallback(x)` widens the result type to `T | typeof x`.

Route description: `{ [path]: { [method]: { query?, body?, headers?, path?, response?, errors? } } }`.

`path` declares the types of the path parameters (otherwise `string | number`), and
`errors.default` types the body of every status that is not listed explicitly.

Without `Routes` the client stays untyped and accepts any url.

To describe the API once for the whole app, use declaration merging instead of a generic:

```ts
declare module '@x-requests/core' {
  interface RegisteredRoutes extends Routes {}
}

const client = xclient(); // typed
```

### From OpenAPI

Types generated by [`openapi-typescript`](https://openapi-ts.dev) (via `@x-requests/codegen`) can be used directly:

```bash
npm install -D @x-requests/codegen openapi-typescript
npx @x-requests/codegen gen --from ./openapi.yaml --to ./src/api/schema.d.ts
```

`--from` accepts a file path or an `http(s)` url (short flags: `-f`, `-t`). `openapi-typescript`
is an optional peer dependency of `@x-requests/codegen` and has to be installed next to it.

```ts
import xclient, { type FromOpenApi } from '@x-requests/core';
import type { paths } from './api/schema';

const client = xclient<FromOpenApi<paths>>();
```

`FromOpenApi` maps parameters (`query`, `header`, `path`), the JSON request body,
`2xx` responses to `response`, `4xx`/`5xx` responses to `errors[status]` and a `default`
response to `errors.default`. Optional and required parameters keep their optionality.
Not mapped: cookie parameters, `head`/`trace` operations.

A `text/event-stream` response is mapped to `events` (and not to `response`, unless the response also has other content):

- a schema that is a union of `{ event: 'name'; data: ... }` objects declares named events:
  `oneOf: [{ properties: { event: { enum: ['tick'] }, data: ... } }, ...]` becomes `events: { tick: ... }`;
- any other schema describes the `data` of unnamed events and becomes `events: { message: ... }`.

```ts
for await (const event of client.get('/events').stream()) {
  if (event.event === 'tick') event.data; // typed from the schema
}
```

## Packages

- [`@x-requests/core`](.) — the client.
- [`@x-requests/codegen`](packages/codegen) — CLI that turns an OpenAPI document into the `paths` types.

## Scripts

```bash
npm run build    # compile core to dist/ and packages/codegen to its dist/
npm test         # unit + type tests for core and codegen (type tests are checked at compile time)
npm run test:e2e # client against a real local HTTP server
npm run coverage # unit tests with coverage thresholds
npm run lint     # check code style
npm run lint:fix # fix code style automatically
```

## License

[MIT](LICENSE)
