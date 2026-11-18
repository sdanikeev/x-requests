#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import Generator from './Generator.js';
import type { GeneratorOptions } from './Generator.js';
import { DEFAULT_CONFIG, loadConfig } from './config.js';
import { watchSchemas } from './watch.js';

const USAGE = 'Usage: x-requests gen [--from <file|url> --to <out.d.ts>] [--config <file>] [--check | --watch]';

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: 'string', short: 'f' },
      to: { type: 'string', short: 't' },
      config: { type: 'string', short: 'c' },
      check: { type: 'boolean' },
      watch: { type: 'boolean', short: 'w' },
    },
    strict: true,
  });

  const [command] = positionals;

  switch (command) {
    case 'gen': {
      const { from, to, config, check, watch } = values;

      if (check && watch) throw new Error('--check and --watch cannot be used together');

      let schemas: GeneratorOptions[];

      if (from || to) {
        if (!from || !to) throw new Error(USAGE);

        schemas = [{ from, to }];
      } else {
        const path = resolve(config ?? DEFAULT_CONFIG);

        if (!config && !existsSync(path)) throw new Error(`${USAGE}\nOr create ${DEFAULT_CONFIG}`);

        schemas = await loadConfig(path);
      }

      if (check) {
        const stale: string[] = [];

        for (const schema of schemas) {
          if (!(await new Generator(schema).check())) stale.push(schema.to);
        }

        if (stale.length > 0) {
          throw new Error(`Out of date: ${stale.join(', ')}\nRun "x-requests gen" to update.`);
        }
      } else if (watch) {
        await watchSchemas(schemas);
      } else {
        for (const schema of schemas) await new Generator(schema).generate();
      }

      break;
    }
    default: {
      throw new Error(`Unknown command "${command ?? ''}". ${USAGE}`);
    }
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);

  process.exit(1);
});
