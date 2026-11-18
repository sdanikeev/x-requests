# Changelog

## @x-requests/codegen 0.1.1

- Add README to the package.

## 0.1.0 (@x-requests/core, @x-requests/codegen)

- Initial public release of `@x-requests/core`: fluent request builder, retries with backoff,
  timeouts, `.fallback()`, `.result()`, typed routes and typed errors.
- `FromOpenApi` maps `openapi-typescript` output to typed routes.
- `@x-requests/codegen`: `x-requests gen --from <file|url> --to <out.d.ts>`.
