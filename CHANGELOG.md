# Changelog

## @x-requests/core 0.3.0

- Request cancellation: `.signal(AbortSignal)` and `AbortError` (`kind: 'abort'`). Aborted requests are not retried and are not replaced by `.fallback()`.
- Server-sent events: `.stream()` returns an async iterable of events, with typed events (`events` in a route), JSON parsing, reconnects with `Last-Event-ID` and `retry:` support.
- `Fetcher` gets an optional `stream()` method; `RequestError` now includes `AbortError`.

## @x-requests/core 0.2.0

- Middleware — `client.use()`, `client.onRequest()`, `client.onResponse()` and `config.middleware`.

## @x-requests/codegen 0.1.1

- Add README to the package.

## 0.1.0 (@x-requests/core, @x-requests/codegen)

- Initial public release of `@x-requests/core`: fluent request builder, retries with backoff,
  timeouts, `.fallback()`, `.result()`, typed routes and typed errors.
- `FromOpenApi` maps `openapi-typescript` output to typed routes.
- `@x-requests/codegen`: `x-requests gen --from <file|url> --to <out.d.ts>`.
