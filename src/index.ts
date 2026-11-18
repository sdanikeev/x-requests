import type { Config, Fetcher } from './types.js';
import type { RegisteredRoutes, RoutesConstraint } from './routes.js';

import XClient from './XClient.js';
import Fetch from './Fetch.js';

const xclient = <R extends RoutesConstraint<R> = RegisteredRoutes>(config?: {
  config?: Config;
  fetcher?: Fetcher;
}): XClient<R> => {
  const fetch = config?.fetcher ?? new Fetch();

  return new XClient<R>(fetch, config?.config);
};

export default xclient;

export {
  AbortError,
  CircuitOpenError,
  HttpError,
  NetworkError,
  ParseError,
  TimeoutError,
  ValidationError,
  XRequestError,
  isHttpError,
} from './errors.js';
export type { RequestError } from './errors.js';
export { HttpStatus } from './statusCodes.js';
export type { HttpStatusCode } from './statusCodes.js';
export type { Result } from './routes.js';
export type { FromOpenApi } from './openapi.js';
export type { RegisteredRoutes, RouteDef } from './routes.js';
export type { Config, Fetcher, FetcherRequestParams, ResponseContext, RetryOptions, SseEvent } from './types.js';
export type { Middleware, Next } from './middleware.js';
export { authMiddleware } from './middlewares/auth.js';
export type { AuthOptions } from './middlewares/auth.js';
export { loggerMiddleware } from './middlewares/logger.js';
export type { LogEntry, LoggerOptions } from './middlewares/logger.js';
export { cacheMiddleware } from './middlewares/cache.js';
export type { CacheMiddleware, CacheOptions } from './middlewares/cache.js';
export { circuitBreakerMiddleware } from './middlewares/circuitBreaker.js';
export type { CircuitBreakerMiddleware, CircuitBreakerOptions, CircuitState } from './middlewares/circuitBreaker.js';
export { rateLimitMiddleware } from './middlewares/rateLimit.js';
export type { RateLimitOptions } from './middlewares/rateLimit.js';
