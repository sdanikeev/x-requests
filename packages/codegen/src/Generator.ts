import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isUrl } from './source.js';

export { loadConfig } from './config.js';

export type GeneratorOptions = {
  from: string;
  to: string;
};

const loadOpenApiTs = async () => {
  try {
    return await import('openapi-typescript');
  } catch (err) {
    throw new Error('openapi-typescript is required: npm i -D openapi-typescript', { cause: err });
  }
};

export default class Generator {
  constructor(private readonly options: GeneratorOptions) {}

  /** The text of the output file, without writing it. */
  async render(): Promise<string> {
    const { default: openapiTS, astToString, COMMENT_HEADER } = await loadOpenApiTs();
    const { from } = this.options;

    const source = isUrl(from) ? new URL(from) : pathToFileURL(resolve(from));
    const ast = await openapiTS(source);

    return COMMENT_HEADER + astToString(ast);
  }

  async generate(): Promise<void> {
    const { to } = this.options;
    const content = await this.render();

    await mkdir(dirname(resolve(to)), { recursive: true });
    await writeFile(to, content);
  }

  /** Whether the output file exists and is what `generate()` would write now. */
  async check(): Promise<boolean> {
    const content = await this.render();

    try {
      return (await readFile(this.options.to, 'utf8')) === content;
    } catch {
      return false;
    }
  }
}
