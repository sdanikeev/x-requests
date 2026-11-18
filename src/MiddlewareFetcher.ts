import { compose } from './middleware.js';
import type { Middleware } from './middleware.js';
import { ValidationError } from './errors.js';
import type { Fetcher, FetcherRequestParams, SseEvent } from './types.js';

class MiddlewareFetcher implements Fetcher {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly middlewares: readonly Middleware[],
  ) { }

  request<T = unknown>(data: FetcherRequestParams): Promise<T> {
    const run = compose(this.middlewares, _data => this.fetcher.request(_data));

    return run(data) as Promise<T>;
  }

  async* stream(data: FetcherRequestParams): AsyncGenerator<SseEvent<string>> {
    const { fetcher } = this;

    if (!fetcher.stream) throw new ValidationError('The fetcher does not support streaming');

    const run = compose(this.middlewares, async _data => fetcher.stream!(_data));

    yield* (await run(data)) as AsyncIterable<SseEvent<string>>;
  }
}

export default MiddlewareFetcher;
