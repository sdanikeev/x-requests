import { compose } from './middleware.js';
import type { Middleware } from './middleware.js';
import { ValidationError } from './errors.js';
import type { Fetcher, FetcherRequestParams, ResponseContext, SseEvent } from './types.js';

class MiddlewareFetcher implements Fetcher {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly middlewares: readonly Middleware[],
  ) { }

  request<T = unknown>(data: FetcherRequestParams): Promise<T> {
    const context: ResponseContext = {};
    const run = compose(this.middlewares, _data => this.fetcher.request(_data, context), context);

    return run(data) as Promise<T>;
  }

  async* stream(data: FetcherRequestParams): AsyncGenerator<SseEvent<string>> {
    const { fetcher } = this;

    if (!fetcher.stream) throw new ValidationError('The fetcher does not support streaming');

    const context: ResponseContext = {};
    const run = compose(
      this.middlewares,
      async ({ stream: _stream, ..._data }) => fetcher.stream!(_data, context),
      context,
    );

    // the generator returned by `next()` is not started yet: a middleware sees the connection only through this flag
    yield* (await run({ ...data, stream: true })) as AsyncIterable<SseEvent<string>>;
  }
}

export default MiddlewareFetcher;
