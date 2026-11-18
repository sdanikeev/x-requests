import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type GeneratorOptions = {
  from: string;
  to: string;
};

const isUrl = (source: string) => /^https?:\/\//i.test(source);

const loadOpenApiTs = async () => {
  try {
    return await import('openapi-typescript');
  } catch (err) {
    throw new Error('openapi-typescript is required: npm i -D openapi-typescript', { cause: err });
  }
};

export default class Generator {
  constructor(private readonly options: GeneratorOptions) {}

  async generate(): Promise<void> {
    const { from, to } = this.options;
    const { default: openapiTS, astToString } = await loadOpenApiTs();

    const source = isUrl(from) ? new URL(from) : pathToFileURL(resolve(from));
    const ast = await openapiTS(source);

    await mkdir(dirname(resolve(to)), { recursive: true });
    await writeFile(to, astToString(ast));
  }
}
