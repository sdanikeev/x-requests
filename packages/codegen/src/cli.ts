#!/usr/bin/env node

import { parseArgs } from 'node:util';

import Generator from './Generator.js';

const USAGE = 'Usage: x-requests gen --from <file|url> --to <out.d.ts>';

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: 'string', short: 'f' },
      to: { type: 'string', short: 't' },
    },
    strict: true,
  });

  const [command] = positionals;

  switch (command) {
    case 'gen': {
      const { from, to } = values;

      if (!from || !to) throw new Error(USAGE);

      await new Generator({ from, to }).generate();

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
