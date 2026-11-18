import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { GeneratorOptions } from './Generator.js';
import { isUrl } from './source.js';

export const DEFAULT_CONFIG = 'x-requests.config.json';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rejectUnknownKeys = (value: Record<string, unknown>, allowed: string[], where: string) => {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));

  if (unknown.length > 0) throw new Error(`${where}: unknown key "${unknown[0]}"`);
};

/**
 * Reads `{ "schemas": [{ "from": "<file|url>", "to": "<out.d.ts>" }] }`.
 * Relative paths are resolved against the folder of the config file.
 */
export const loadConfig = async (path: string): Promise<GeneratorOptions[]> => {
  const file = resolve(path);
  let raw: string;

  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read the config ${file}`, { cause: err });
  }

  let config: unknown;

  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  if (!isObject(config)) throw new Error(`${file}: the config must be an object`);

  rejectUnknownKeys(config, ['schemas'], file);

  const { schemas } = config;

  if (!Array.isArray(schemas) || schemas.length === 0) {
    throw new Error(`${file}: "schemas" must be a non-empty array`);
  }

  const base = dirname(file);
  const seen = new Set<string>();

  return schemas.map((schema: unknown, index) => {
    const where = `${file}: schemas[${index}]`;

    if (!isObject(schema)) throw new Error(`${where} must be an object`);

    rejectUnknownKeys(schema, ['from', 'to'], where);

    const { from, to } = schema;

    if (typeof from !== 'string' || from === '') throw new Error(`${where}: "from" must be a non-empty string`);
    if (typeof to !== 'string' || to === '') throw new Error(`${where}: "to" must be a non-empty string`);

    const output = resolve(base, to);

    if (seen.has(output)) throw new Error(`${where}: "to" ${to} is used by another schema`);

    seen.add(output);

    return { from: isUrl(from) ? from : resolve(base, from), to: output };
  });
};
