import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import Generator from './Generator.js';
import type { GeneratorOptions } from './Generator.js';
import { isUrl } from './source.js';

export type Watcher = { close(): void };

type Reporter = { log: (message: string) => void; error: (message: string) => void };

const DEBOUNCE_MS = 100;

/**
 * Generates every schema once, then again whenever its source file changes. A failed generation
 * is reported and the watcher keeps running. Only local files can be watched.
 */
export const watchSchemas = async (
  schemas: GeneratorOptions[],
  report: Reporter = { log: console.log, error: console.error },
): Promise<Watcher> => {
  const remote = schemas.find(schema => isUrl(schema.from));

  if (remote) throw new Error(`--watch works only with local files, not ${remote.from}`);

  const regenerate = async (schema: GeneratorOptions) => {
    try {
      await new Generator(schema).generate();
      report.log(`Generated ${schema.to}`);
    } catch (error) {
      report.error(`Failed to generate ${schema.to}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  for (const schema of schemas) await regenerate(schema);

  // one watcher per folder (several on the same one are unreliable); it hands the event to the schemas of that file
  const folders = new Map<string, Map<string, GeneratorOptions[]>>();

  for (const schema of schemas) {
    const source = resolve(schema.from);
    const files = folders.get(dirname(source)) ?? new Map<string, GeneratorOptions[]>();

    files.set(basename(source), [...(files.get(basename(source)) ?? []), schema]);
    folders.set(dirname(source), files);
  }

  const watchers: FSWatcher[] = [];
  const timers = new Map<GeneratorOptions, NodeJS.Timeout>();

  for (const [folder, files] of folders) {
    // the folder is watched, not the file: editors often replace a file instead of changing it
    watchers.push(watch(folder, (_event, name) => {
      for (const schema of files.get(name ?? '') ?? []) {
        clearTimeout(timers.get(schema));
        timers.set(schema, setTimeout(() => {
          timers.delete(schema);
          void regenerate(schema);
        }, DEBOUNCE_MS));
      }
    }));

    for (const name of files.keys()) report.log(`Watching ${resolve(folder, name)}`);
  }

  return {
    close: () => {
      for (const watcher of watchers) watcher.close();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
};
