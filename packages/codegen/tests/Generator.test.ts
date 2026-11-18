import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import Generator from '../src/Generator.js';
import { createTempDir, startSpecServer, writeSpec } from './helpers.js';

describe('Generator', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await createTempDir());
  });

  afterEach(() => cleanup());

  it('should write typescript paths if the source is a local file', async () => {
    const from = await writeSpec(dir);
    const to = join(dir, 'schema.d.ts');

    await new Generator({ from, to }).generate();

    const output = await readFile(to, 'utf8');

    assert.match(output, /export interface paths/);
    assert.match(output, /"\/ping"/);
  });

  it('should create missing directories if the output path is nested', async () => {
    const from = await writeSpec(dir);
    const to = join(dir, 'a', 'b', 'schema.d.ts');

    await new Generator({ from, to }).generate();

    assert.match(await readFile(to, 'utf8'), /export interface paths/);
  });

  it('should load the spec over http if the source is a url', async () => {
    const server = await startSpecServer();
    const to = join(dir, 'schema.d.ts');

    try {
      await new Generator({ from: server.url, to }).generate();
    } finally {
      await server.close();
    }

    assert.match(await readFile(to, 'utf8'), /"\/ping"/);
  });

  it('should reject and not write the output if the source file does not exist', async () => {
    const to = join(dir, 'schema.d.ts');

    await assert.rejects(new Generator({ from: join(dir, 'missing.json'), to }).generate());
    await assert.rejects(readFile(to), { code: 'ENOENT' });
  });

  it('should reject if the server responds with an error status', async () => {
    const server = await startSpecServer(500);

    try {
      await assert.rejects(new Generator({ from: server.url, to: join(dir, 'schema.d.ts') }).generate());
    } finally {
      await server.close();
    }
  });
});
