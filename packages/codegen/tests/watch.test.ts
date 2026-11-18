import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { watchSchemas } from '../src/watch.js';
import type { Watcher } from '../src/watch.js';
import { createTempDir, spec, waitFor, writeSpec } from './helpers.js';

// the operation id has to be unique, openapi-typescript refuses duplicates
const withPath = (path: string) => JSON.stringify({
  ...spec,
  paths: {
    ...spec.paths,
    [path]: { get: { operationId: `get${path.replace(/\W/g, '')}`, responses: spec.paths['/ping'].get.responses } },
  },
});

describe('watchSchemas', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let watcher: Watcher | undefined;
  let logs: string[];
  let errors: string[];

  const start = async (...args: Parameters<typeof watchSchemas>) => {
    watcher = await watchSchemas(args[0], { log: message => logs.push(message), error: message => errors.push(message) });

    return watcher;
  };

  beforeEach(async () => {
    ({ dir, cleanup } = await createTempDir());
    logs = [];
    errors = [];
  });

  afterEach(async () => {
    watcher?.close();
    await cleanup();
  });

  it('should generate every schema once if the watcher starts', async () => {
    const from = await writeSpec(dir);
    const to = join(dir, 'out.d.ts');

    await start([{ from, to }]);

    assert.match(await readFile(to, 'utf8'), /"\/ping"/);
    assert.ok(logs.some(message => message.startsWith('Watching')));
  });

  it('should generate again if the source file changes', async () => {
    const from = await writeSpec(dir);
    const to = join(dir, 'out.d.ts');

    await start([{ from, to }]);
    await writeFile(from, withPath('/pong'));

    assert.ok(await waitFor(async () => (await readFile(to, 'utf8')).includes('"/pong"')));
  });

  it('should not generate if another file in the same folder changes', async () => {
    const from = await writeSpec(dir);
    const to = join(dir, 'out.d.ts');

    await start([{ from, to }]);
    // fs.watch may still report the write that created the spec just before the watch started
    await new Promise(resolve => setTimeout(resolve, 400));

    const before = logs.filter(message => message.startsWith('Generated')).length;

    await writeFile(join(dir, 'unrelated.json'), '{}');
    await new Promise(resolve => setTimeout(resolve, 400));

    assert.equal(logs.filter(message => message.startsWith('Generated')).length, before);
  });

  it('should report the error and keep watching if a change breaks the source', async () => {
    const from = await writeSpec(dir);
    const to = join(dir, 'out.d.ts');

    await start([{ from, to }]);
    await writeFile(from, '{oops');

    assert.ok(await waitFor(() => errors.length > 0));
    assert.match(errors[0] ?? '', /Failed to generate/);

    await writeFile(from, withPath('/fixed'));

    assert.ok(await waitFor(async () => (await readFile(to, 'utf8')).includes('"/fixed"')));
  });

  it('should report the error and start watching if the first generation fails', async () => {
    const from = join(dir, 'missing.json');

    await start([{ from, to: join(dir, 'out.d.ts') }]);

    assert.equal(errors.length, 1);
  });

  it('should watch every schema if there are several', async () => {
    const a = await writeSpec(dir, 'a.json');
    const b = await writeSpec(dir, 'b.json');
    const toA = join(dir, 'a.d.ts');
    const toB = join(dir, 'b.d.ts');

    await start([{ from: a, to: toA }, { from: b, to: toB }]);
    await writeFile(b, withPath('/only-b'));

    assert.ok(await waitFor(async () => (await readFile(toB, 'utf8')).includes('"/only-b"')));
    assert.ok(!(await readFile(toA, 'utf8')).includes('"/only-b"'));
  });

  it('should refuse a remote source if a url is given', async () => {
    await assert.rejects(
      watchSchemas([{ from: 'https://example.com/openapi.json', to: join(dir, 'out.d.ts') }]),
      /works only with local files/,
    );
  });

  it('should stop generating if the watcher is closed', async () => {
    const from = await writeSpec(dir);
    const to = join(dir, 'out.d.ts');
    const handle = await start([{ from, to }]);

    handle.close();
    await writeFile(from, withPath('/after-close'));
    await new Promise(resolve => setTimeout(resolve, 400));

    assert.ok(!(await readFile(to, 'utf8')).includes('"/after-close"'));
  });

  it('should print to the console if no reporter is given', async (t) => {
    const lines: string[] = [];

    t.mock.method(console, 'log', (line: string) => lines.push(line));

    const from = await writeSpec(dir);

    watcher = await watchSchemas([{ from, to: join(dir, 'out.d.ts') }]);

    assert.ok(lines.some(line => line.startsWith('Generated')));
  });

  it('should generate every output if several schemas share one source', async () => {
    const from = await writeSpec(dir);
    const toA = join(dir, 'a.d.ts');
    const toB = join(dir, 'b.d.ts');

    await start([{ from, to: toA }, { from, to: toB }]);
    await writeFile(from, withPath('/shared'));

    assert.ok(await waitFor(async () => (await readFile(toA, 'utf8')).includes('"/shared"')));
    assert.ok(await waitFor(async () => (await readFile(toB, 'utf8')).includes('"/shared"')));
  });
});
