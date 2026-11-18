import { compose } from './middleware.js';
import type { Middleware } from './middleware.js';
import type { Fetcher, FetcherRequestParams } from './types.js';

class MiddlewareFetcher implements Fetcher {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly middlewares: readonly Middleware[],
  ) { }

  request<T = unknown>(data: FetcherRequestParams): Promise<T> {
    const run = compose(this.middlewares, _data => this.fetcher.request(_data));

    return run(data) as Promise<T>;
  }
}

export default MiddlewareFetcher;
