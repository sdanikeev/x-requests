# Changelog

## @x-requests/core 0.4.0

- Files: `.multipart(object | FormData)` for `multipart/form-data`, `FormData`, `Blob`, `URLSearchParams` and `ArrayBuffer` bodies, and `.responseType('blob' | 'arrayBuffer' | 'text')` for binary and raw responses.
- `.idempotent(key?)` sends an `Idempotency-Key` (a random UUID unless given) that is the same on every retry and stream reconnect; `Config.idempotencyHeader` renames the header.
- Built-in middleware: `authMiddleware` (token, single-flight refresh on 401, also reconnects a stream refused with 401), `loggerMiddleware` (per-attempt entries, status of successful responses, header redaction) and `cacheMiddleware` (TTL cache for GET following `Cache-Control`, deduplication of parallel requests that survives the abort of one of them, invalidation by mutations, LRU).
- `Fetcher.request()` and `stream()` take an optional `context` (`ResponseContext`: `status`, `headers`) that the fetcher fills; middleware receives it as its third argument. `Fetch` fills it, also for error responses.
- Middleware can tell a stream from a plain request by `FetcherRequestParams.stream`; the flag is not passed on to the `Fetcher`.
- `Fetcher` gets `responseType` in `FetcherRequestParams`; `Content-Type: application/json` is no longer set for non-JSON bodies.

## @x-requests/core 0.3.0

- Request cancellation: `.signal(AbortSignal)` and `AbortError` (`kind: 'abort'`). Aborted requests are not retried and are not replaced by `.fallback()`.
- Server-sent events: `.stream()` returns an async iterable of events, with typed events (`events` in a route), JSON parsing, reconnects with `Last-Event-ID` and `retry:` support.
- `FromOpenApi` maps `text/event-stream` responses to typed `events` (a union of `{ event, data }` objects, or `message` events for a plain schema).
- `Fetcher` gets an optional `stream()` method; `RequestError` now includes `AbortError`.

## @x-requests/core 0.2.0

- Middleware — `client.use()`, `client.onRequest()`, `client.onResponse()` and `config.middleware`.

## @x-requests/codegen 0.1.2

- The generated file starts with the same `auto-generated` banner as the official `openapi-typescript` CLI.

## @x-requests/codegen 0.1.1

- Add README to the package.

## 0.1.0 (@x-requests/core, @x-requests/codegen)

- Initial public release of `@x-requests/core`: fluent request builder, retries with backoff,
  timeouts, `.fallback()`, `.result()`, typed routes and typed errors.
- `FromOpenApi` maps `openapi-typescript` output to typed routes.
- `@x-requests/codegen`: `x-requests gen --from <file|url> --to <out.d.ts>`.
