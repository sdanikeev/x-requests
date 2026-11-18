import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempDir, writeSpec } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const run = (...args: string[]) => runIn(undefined, ...args);

const runIn = (cwd: string | undefined, ...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, [cli, ...args], { ...(cwd && { cwd }) }, (error, stdout, stderr) => {
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

  describe('config', () => {
    const writeConfig = async (schemas: unknown, name = 'x-requests.config.json') => {
      await writeFile(join(dir, name), JSON.stringify({ schemas }));
    };

    it('should generate every schema of x-requests.config.json if gen gets no flags', async () => {
      await writeSpec(dir, 'a.json');
      await writeSpec(dir, 'b.json');
      await writeConfig([{ from: 'a.json', to: 'out/a.d.ts' }, { from: 'b.json', to: 'out/b.d.ts' }]);

      const result = await runIn(dir, 'gen');

      assert.equal(result.code, 0, result.stderr);
      assert.match(await readFile(join(dir, 'out/a.d.ts'), 'utf8'), /export interface paths/);
      assert.match(await readFile(join(dir, 'out/b.d.ts'), 'utf8'), /export interface paths/);
    });

    it('should read the file from --config if it is given', async () => {
      await writeSpec(dir);
      await writeConfig([{ from: 'openapi.json', to: 'custom.d.ts' }], 'my.json');

      const result = await runIn(dir, 'gen', '-c', 'my.json');

      assert.equal(result.code, 0, result.stderr);
      assert.match(await readFile(join(dir, 'custom.d.ts'), 'utf8'), /export interface paths/);
    });

    it('should ignore the config if --from and --to are given', async () => {
      const from = await writeSpec(dir);

      await writeConfig([{ from: 'openapi.json', to: 'from-config.d.ts' }]);

      const result = await runIn(dir, 'gen', '-f', from, '-t', join(dir, 'from-flags.d.ts'));

      assert.equal(result.code, 0, result.stderr);
      await readFile(join(dir, 'from-flags.d.ts'), 'utf8');
      await assert.rejects(readFile(join(dir, 'from-config.d.ts'), 'utf8'), /ENOENT/);
    });

    it('should mention the config in the usage if there are no flags and no config file', async () => {
      const result = await runIn(dir, 'gen');

      assert.equal(result.code, 1);
      assert.match(result.stderr, /Usage: x-requests gen/);
      assert.match(result.stderr, /x-requests\.config\.json/);
    });

    it('should report the problem and exit with 1 if the config is not valid', async () => {
      await writeConfig([]);

      const result = await runIn(dir, 'gen');

      assert.equal(result.code, 1);
      assert.match(result.stderr, /"schemas" must be a non-empty array/);
    });

    it('should exit with 1 if the file from --config does not exist', async () => {
      const result = await runIn(dir, 'gen', '--config', 'missing.json');

      assert.equal(result.code, 1);
      assert.match(result.stderr, /Cannot read the config/);
    });
  });

  describe('--check', () => {
    it('should exit with 0 and write nothing if the output is up to date', async () => {
      const from = await writeSpec(dir);
      const to = join(dir, 'schema.d.ts');

      await run('gen', '-f', from, '-t', to);

      const result = await run('gen', '-f', from, '-t', to, '--check');

      assert.equal(result.code, 0, result.stderr);
    });

    it('should list the file and exit with 1 if the output is out of date', async () => {
      const from = await writeSpec(dir);
      const to = join(dir, 'schema.d.ts');

      await writeFile(to, 'old');

      const result = await run('gen', '-f', from, '-t', to, '--check');

      assert.equal(result.code, 1);
      assert.match(result.stderr, /Out of date: .*schema\.d\.ts/);
      assert.equal(await readFile(to, 'utf8'), 'old');
    });

    it('should exit with 1 if the output does not exist', async () => {
      const from = await writeSpec(dir);

      const result = await run('gen', '-f', from, '-t', join(dir, 'missing.d.ts'), '--check');

      assert.equal(result.code, 1);
    });

    it('should list only the stale files if the config has several schemas', async () => {
      await writeSpec(dir, 'a.json');
      await writeSpec(dir, 'b.json');
      await writeFile(join(dir, 'x-requests.config.json'), JSON.stringify({
        schemas: [{ from: 'a.json', to: 'a.d.ts' }, { from: 'b.json', to: 'b.d.ts' }],
      }));
      await runIn(dir, 'gen');
      await writeFile(join(dir, 'b.d.ts'), 'old');

      const result = await runIn(dir, 'gen', '--check');

      assert.equal(result.code, 1);
      assert.match(result.stderr, /b\.d\.ts/);
      assert.doesNotMatch(result.stderr, /a\.d\.ts/);
    });
  });

  describe('--watch', () => {
    it('should exit with 1 if --check and --watch are used together', async () => {
      const result = await run('gen', '-f', 'a.json', '-t', 'a.d.ts', '--check', '--watch');

      assert.equal(result.code, 1);
      assert.match(result.stderr, /cannot be used together/);
    });

    it('should exit with 1 if the source is a url', async () => {
      const result = await run('gen', '-f', 'https://example.com/openapi.json', '-t', join(dir, 'a.d.ts'), '-w');

      assert.equal(result.code, 1);
      assert.match(result.stderr, /works only with local files/);
    });
  });
});
