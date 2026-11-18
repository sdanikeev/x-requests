# x-requests

Typed, promise-like HTTP client (`@x-requests/core`) plus a codegen CLI (`@x-requests/codegen`).
npm workspaces monorepo: the core lives at the root, the CLI in `packages/codegen`.
Repository: `sdanikeev/x-requests` (GitHub). Both packages are published to npm under the `@x-requests` scope.

## Commands

```bash
npm run lint          # eslint (also covers packages/)
npm run build         # core -> dist/, then packages/codegen -> its dist/
npm test              # core unit + type tests, then codegen tests (type tests are checked by tsc)
npm run test:e2e      # client against a real local HTTP server
npm run coverage      # thresholds: lines 95, branches 90, functions 95 (Node 24 only in CI)
```

Tests are compiled by `tsc` into `.test-build/` and run with `node --test` (no test framework).
Globs are deliberately unquoted in scripts: Node 20 does not expand globs in `node --test`.

## Layout

```
src/
  index.ts              public API (default export `xclient`, errors, types)
  XClient.ts            get/post/put/patch/delete/options, use/onRequest/onResponse
  XRequest.ts           builder: body/params/headers/path/timeout/signal/retries/fallback/result/stream
  Fetch.ts              default Fetcher over global fetch (node-fetch fallback); request() and stream()
  MiddlewareFetcher.ts  decorator that runs the middleware chain around a Fetcher
  middleware.ts         Middleware/Next types and compose()
  sse.ts                SSE parser (parseSse)
  errors.ts             HttpError, NetworkError, TimeoutError, ParseError, AbortError, ValidationError
  middlewares/          built-in middleware: auth, logger, cache, circuitBreaker, rateLimit
  url.ts                originOf() (default key of the circuit breaker and the rate limit)
  headers.ts            case-insensitive hasHeader()
  routes.ts             route typing (RouteDef, RegisteredRoutes, EventOf, ...)
  openapi.ts            FromOpenApi: maps openapi-typescript `paths` to routes
  statusCodes.ts, types.ts
packages/codegen/       CLI `x-requests gen` (`--from/--to`, or `x-requests.config.json`; `--check`, `--watch`) over openapi-typescript
tests/, tests/e2e/      unit/type tests and e2e tests; shared mocks in tests/helpers.ts
examples/               openapi.json + generated_v1.ts (used by tests/openapi.test.ts)
```

## Conventions

- Everything is in English: code, comments, test names, docs.
- Test names follow `it('should ... if ...')`, e.g. `should retry if the status is 503`.
- Comments only where they explain *why* (JSDoc on public API is fine); no comments that restate the code.
- ESM only, strict TS (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). Build uses `types: ["node"]` in the packages.
- Style is enforced by `@stylistic` through eslint (`npm run lint:fix`): 2 spaces, single quotes, semicolons, one statement per line.
- Type-level tests live in `tests/types.test.ts` and `tests/openapi.test.ts` (`assertType<Equal<...>>()` and `@ts-expect-error`); a mistake fails `tsc`, hence `npm test`.
- `examples/generated_v1.ts` is generated: `node packages/codegen/dist/cli.js gen -f examples/openapi.json -t examples/generated_v1.ts` (build first). The diff should only add lines.

## Design decisions

- A request is a thenable; the request runs once, repeated `await`s reuse the same promise.
- Errors: `.result()` returns `{ ok, data } | { ok: false, error }` and never rejects, except `ValidationError` (programmer mistakes always throw).
- Retries: exponential backoff with jitter (50-100%), only for retryable errors (`HttpError` with 429/5xx, `NetworkError`, `TimeoutError`). Never for `ParseError`, `AbortError` or `CircuitOpenError`. A `Retry-After` of a 429/503 replaces the backoff (over `maxRetryAfter` the request fails at once). `POST`/`PATCH` are retried only with `.idempotent()` or `unsafe: true` (`config.retry` or `.retries()` options); `canRetry()` in `XRequest` holds the whole policy, also for stream reconnects.
- `.fallback()` replaces failures but never hides `ValidationError` or `AbortError`.
- Middleware is an onion around the `Fetcher`, so it runs on **every attempt** of a retried request. `onRequest` runs in registration order, `onResponse` in reverse. Each client owns its own list; `use()` returns an unsubscribe function.
- Cancellation: `.signal(AbortSignal)`; combined with `.timeout()` via `AbortSignal.any` (manual fallback for Node < 20.3). Abort also interrupts the backoff pause.
- Files: `.multipart()` builds a `FormData` (not checked against the route body type); `Fetch` sets no `Content-Type` for `FormData`/`Blob`/`URLSearchParams` so that `fetch` adds the boundary. `.responseType()` only changes how a successful response is read.
- `.idempotent(key?)` creates the key once, so every retry and stream reconnect sends the same `Idempotency-Key` (`Config.idempotencyHeader` renames it). The client does not deduplicate; caching is `cacheMiddleware`.
- `MiddlewareFetcher.stream()` passes `stream: true` to the chain (and strips it before the `Fetcher`), because `next()` of a stream returns a generator that is not started yet. Middleware that must treat streams differently (cache, logger, auth) checks `data.stream`.
- `circuitBreakerMiddleware` counts consecutive failures per origin and throws `CircuitOpenError` (`kind: 'circuit'`); `rateLimitMiddleware` queues requests per origin (sliding window + `maxConcurrent`, abort-aware) and takes a place per attempt, a stream takes it when it is read. Both take injectable `now` (and `schedule`) for tests.
- `ResponseContext` is an out-parameter: `MiddlewareFetcher` creates one per attempt, passes it to the `Fetcher` as the second argument and to every middleware as the third. `Fetch` fills `status`/`headers` (also for error responses); custom fetchers may ignore it, so middleware must work with an empty one.
- `cacheMiddleware` shares one in-flight call per key with its own `AbortController`; a caller's abort ends only its own wait (`join`/`leave`), the call is aborted when the last waiter leaves. `authMiddleware` reconnects a stream on a 401 only before its first event (later it would duplicate events).
- SSE: `.stream()` returns an async generator. `data` is parsed as JSON unless `{ json: false }`. Reconnects after failures up to `.retries(n, backoff)` with `Last-Event-ID` and the server's `retry:` hint; a normally closed stream just ends. `.timeout()` only limits the wait for the connection.
- `FromOpenApi` maps a `text/event-stream` response to `events`: a union of `{ event, data }` objects gives named events, any other schema gives `{ message: ... }`. This is our convention, not an OpenAPI standard (OpenAPI 3.2 `itemSchema` is not supported by openapi-typescript 7.13).
- `openapi-typescript` is an optional peer dependency of the codegen package; it is a devDependency at the root, with an `overrides` entry because it declares `typescript ^5` while the repo uses TS 6.

## Gotchas

- `AbortSignal.timeout()` is unref'd: a test whose only pending work is a mocked, never-resolving fetch lets the event loop exit (fails on Node 22 with "Promise resolution is still pending"). Use `hangingFetch` from `tests/helpers.ts`.
- A mocked fetch must reject immediately if `init.signal` is already aborted, like the real one (`hangingFetch` does this).
- `XRequest` already has a public `.params()` builder, so the internal request builder is called `buildRequest()`.
- macOS has no `timeout` command; to bound a hanging test run use `perl -e 'alarm 60; exec @ARGV' node --test --test-timeout=5000 ...`.
- Adding a member to `RequestError` (e.g. `'abort'` in `kind`) is a public type change: update `tests/types.test.ts`.

## Release

1. Update `CHANGELOG.md` and bump versions: `npm version <patch|minor> --no-git-tag-version --workspaces=false` for the core, `npm version ... -w packages/codegen` for the codegen.
2. `npm run lint && npm run build && npm test && npm run test:e2e && npm pack --dry-run`, commit, push, and wait for CI (Node 20/22/24 + coverage).
3. The user publishes (2FA is required): `npm publish --access public` from the root, then `npm publish -w packages/codegen --access public`. Core first.
4. Tags: `v<core version>` and `codegen-v<codegen version>`.
5. A fresh version can show a "Temporary Holding Version" page for a few minutes and `npm view` can lag; this is npm processing, not a failure. A published version can never be republished: fix forward with a new patch.
