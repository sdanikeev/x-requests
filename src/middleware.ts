import type { FetcherRequestParams, ResponseContext } from './types.js';

export type Next = (data: FetcherRequestParams) => Promise<unknown>;

/**
 * `context` is filled by the fetcher while `next` runs, so it is read after `await next(...)`.
 * Fetchers that do not support it leave it empty.
 */
export type Middleware = (data: FetcherRequestParams, next: Next, context: ResponseContext) => Promise<unknown>;

export const compose = (middlewares: readonly Middleware[], last: Next, context: ResponseContext = {}): Next =>
  middlewares.reduceRight<Next>((next, middleware) => data => middleware(data, next, context), last);
