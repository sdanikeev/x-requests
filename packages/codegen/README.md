# @x-requests/codegen

CLI that turns an OpenAPI document into TypeScript route types for
[`@x-requests/core`](https://github.com/sdanikeev/x-requests). It uses
[`openapi-typescript`](https://openapi-ts.dev) under the hood.

## Installation

```bash
npm install -D @x-requests/codegen openapi-typescript
```

`openapi-typescript` is an optional peer dependency: it has to be installed next to this package.
If it is missing, the command fails with a message telling you to install it.

## Usage

```bash
npx x-requests gen --from ./openapi.json --to ./src/api/schema.d.ts
npx x-requests gen --from http://localhost:3000/docs/json --to ./src/api/schema.d.ts
```

| Option | Short | Description |
| --- | --- | --- |
| `--from` | `-f` | Path to an OpenAPI file or an `http(s)` url |
| `--to` | `-t` | Output `.d.ts` file; missing directories are created |

The command exits with code `1` and prints a short message on any error (unknown command,
missing option, unreadable source, failed download).

## Using the generated types

```ts
import xclient, { type FromOpenApi } from '@x-requests/core';
import type { paths } from './api/schema';

const client = xclient<FromOpenApi<paths>>();
```

## Programmatic API

```ts
import Generator from '@x-requests/codegen';

await new Generator({ from: './openapi.json', to: './src/api/schema.d.ts' }).generate();
```

## License

[MIT](LICENSE)
