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
| `--config` | `-c` | Config file with several schemas (default `x-requests.config.json`) |
| `--check` | | Write nothing; exit with `1` if an output file is missing or out of date |
| `--watch` | `-w` | Generate again whenever a local source file changes |

### Several schemas

Without `--from` and `--to`, `gen` reads `x-requests.config.json` from the current folder (or the file given with `--config`):

```json
{
  "schemas": [
    { "from": "./specs/users.json", "to": "./src/api/users.d.ts" },
    { "from": "https://billing.example.com/openapi.json", "to": "./src/api/billing.d.ts" }
  ]
}
```

Relative paths are resolved against the folder of the config. `--from` and `--to` on the command line override the config.
Every schema gets its own output file and its own `FromOpenApi<paths>` type, so use one client per service.

### In CI

`x-requests gen --check` generates in memory and compares with the files on disk. It writes nothing and fails the build
(exit code `1`, with the list of stale files) when someone forgot to regenerate after changing a spec.

### Watch mode

`x-requests gen --watch` generates once and then again each time a source file changes. A broken spec is reported and
the watcher keeps running. Only local files can be watched, so `--watch` with a url fails, as does `--check` together with `--watch`.

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
import Generator, { loadConfig } from '@x-requests/codegen';

const generator = new Generator({ from: './openapi.json', to: './src/api/schema.d.ts' });

await generator.generate();            // write the file
const text = await generator.render(); // the content, without writing
const fresh = await generator.check(); // is the file on disk up to date?

const schemas = await loadConfig('./x-requests.config.json'); // [{ from, to }, ...] with resolved paths
```

## License

[MIT](LICENSE)
