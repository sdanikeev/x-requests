import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempDir, writeSpec } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, [cli, ...args], (error, stdout, stderr) => {
    resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
  });
});

describe('cli', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await createTempDir());
  });

  afterEach(() => cleanup());

  it('should generate the schema and exit with 0 if gen gets --from and --to', async () => {
    const from = await writeSpec(dir);
    const to = join(dir, 'schema.d.ts');

    const result = await run('gen', '--from', from, '--to', to);

    assert.equal(result.code, 0);
    assert.match(await readFile(to, 'utf8'), /export interface paths/);
  });

  it('should accept short flags if -f and -t are used', async () => {
    const from = await writeSpec(dir);
    const to = join(dir, 'schema.d.ts');

    const result = await run('gen', '-f', from, '-t', to);

    assert.equal(result.code, 0);
    assert.match(await readFile(to, 'utf8'), /export interface paths/);
  });

  it('should print usage and exit with 1 if --to is missing', async () => {
    const result = await run('gen', '--from', 'openapi.json');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage: x-requests gen/);
  });

  it('should print usage and exit with 1 if --from is missing', async () => {
    const result = await run('gen', '--to', 'schema.d.ts');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage: x-requests gen/);
  });

  it('should name the command and exit with 1 if the command is unknown', async () => {
    const result = await run('foo');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown command "foo"/);
  });

  it('should exit with 1 if no command is given', async () => {
    const result = await run();

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown command ""/);
  });

  it('should exit with 1 without a stack trace if an unknown option is passed', async () => {
    const result = await run('gen', '--nope');

    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });

  it('should exit with 1 and report the error if the source file does not exist', async () => {
    const result = await run('gen', '-f', join(dir, 'missing.json'), '-t', join(dir, 'out.d.ts'));

    assert.equal(result.code, 1);
    assert.notEqual(result.stderr, '');
  });
});
