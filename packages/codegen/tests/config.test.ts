import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadConfig } from '../src/config.js';
import { createTempDir } from './helpers.js';

describe('loadConfig', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await createTempDir());
  });

  afterEach(() => cleanup());

  const write = async (content: unknown) => {
    const path = join(dir, 'x-requests.config.json');

    await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));

    return path;
  };

  it('should resolve paths against the folder of the config if they are relative', async () => {
    const path = await write({ schemas: [{ from: 'specs/a.json', to: 'out/a.d.ts' }] });

    assert.deepEqual(await loadConfig(path), [
      { from: resolve(dir, 'specs/a.json'), to: resolve(dir, 'out/a.d.ts') },
    ]);
  });

  it('should keep a url as is if the source is remote', async () => {
    const path = await write({ schemas: [{ from: 'https://example.com/openapi.json', to: 'a.d.ts' }] });

    assert.equal((await loadConfig(path))[0]?.from, 'https://example.com/openapi.json');
  });

  it('should return every schema in order if there are several', async () => {
    const path = await write({
      schemas: [{ from: 'a.json', to: 'a.d.ts' }, { from: 'b.json', to: 'b.d.ts' }],
    });

    assert.deepEqual((await loadConfig(path)).map(schema => schema.to), [resolve(dir, 'a.d.ts'), resolve(dir, 'b.d.ts')]);
  });

  it('should fail with the path if the file does not exist', async () => {
    await assert.rejects(loadConfig(join(dir, 'nope.json')), /Cannot read the config .*nope\.json/);
  });

  it('should fail if the file is not valid JSON', async () => {
    await assert.rejects(loadConfig(await write('{oops')), /is not valid JSON/);
  });

  it('should fail if the config is not an object', async () => {
    await assert.rejects(loadConfig(await write('[]')), /must be an object/);
  });

  it('should fail if the config has an unknown key', async () => {
    await assert.rejects(loadConfig(await write({ schemas: [], extra: 1 })), /unknown key "extra"/);
  });

  it('should fail if schemas is missing or empty', async () => {
    await assert.rejects(loadConfig(await write({})), /"schemas" must be a non-empty array/);
    await assert.rejects(loadConfig(await write({ schemas: [] })), /"schemas" must be a non-empty array/);
    await assert.rejects(loadConfig(await write({ schemas: 'a' })), /"schemas" must be a non-empty array/);
  });

  it('should fail with the index if a schema is not an object', async () => {
    await assert.rejects(loadConfig(await write({ schemas: ['a.json'] })), /schemas\[0\] must be an object/);
  });

  it('should fail if a schema has an unknown key', async () => {
    const path = await write({ schemas: [{ from: 'a', to: 'b', watch: true }] });

    await assert.rejects(loadConfig(path), /schemas\[0\]: unknown key "watch"/);
  });

  it('should fail with the index if from or to is missing', async () => {
    await assert.rejects(loadConfig(await write({ schemas: [{ to: 'a.d.ts' }] })), /schemas\[0\]: "from" must be/);
    await assert.rejects(
      loadConfig(await write({ schemas: [{ from: 'a.json', to: 'a.d.ts' }, { from: 'b.json', to: '' }] })),
      /schemas\[1\]: "to" must be/,
    );
  });

  it('should fail if two schemas write the same file', async () => {
    const path = await write({
      schemas: [{ from: 'a.json', to: 'out.d.ts' }, { from: 'b.json', to: './out.d.ts' }],
    });

    await assert.rejects(loadConfig(path), /used by another schema/);
  });
});
