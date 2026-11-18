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
export type { Config, Fetcher, FetcherRequestParams } from './types.js';
export type { Middleware, Next } from './middleware.js';
