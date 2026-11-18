import type { FetcherRequestParams } from './types.js';

export type Next = (data: FetcherRequestParams) => Promise<unknown>;
export type Middleware = (data: FetcherRequestParams, next: Next) => Promise<unknown>;

export const compose = (middlewares: readonly Middleware[], last: Next): Next =>
  middlewares.reduceRight<Next>((next, middleware) => data => middleware(data, next), last);
