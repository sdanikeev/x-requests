import type { HttpError, RequestError } from './errors.js';
import type { Body, HeadersData, Method, Params, PathParams } from './types.js';

/**
 * Empty on purpose: extend it with declaration merging to describe the API
 * of the whole application, or pass your own routes to `xclient<Routes>()`.
 *
 * declare module 'x-requests' {
 *   interface RegisteredRoutes extends MyRoutes {}
 * }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RegisteredRoutes { }

/** Description of a single `path + method` pair. */
export type RouteDef = {
  response?: unknown;
  body?: unknown;
  query?: unknown;
  headers?: HeadersData;
  /** Error bodies by status: `{ 404: NotFoundBody; 422: ValidationBody }` */
  errors?: Partial<Record<number, unknown>>;
};

/** `{ '/users/{id}': { get: RouteDef; patch: RouteDef } }` */
export type RoutesConstraint<R> = {
  [P in keyof R]: Partial<Record<Method, RouteDef>>;
};

/** True when no routes are described: the client then accepts any url. */
export type IsUntyped<R> = [keyof R] extends [never] ? true : false;

export type PathsWith<R, M extends Method> = {
  [P in keyof R & string]: M extends keyof R[P] ? P : never;
}[keyof R & string];

export type UrlOf<R, M extends Method> = IsUntyped<R> extends true
  ? string
  : PathsWith<R, M>;

type DefOf<R, P, M extends Method> = P extends keyof R
  ? R[P] extends infer Methods
    ? M extends keyof Methods ? Methods[M] : never
    : never
  : never;

type Field<D, K extends string> = K extends keyof D ? Exclude<D[K], undefined> : never;

/** `'/a/{x}/b/{y}'` -> `'x' | 'y'` */
export type PathParamNames<P extends string>
  = P extends `${string}{${infer Name}}${infer Rest}`
    ? Name | PathParamNames<Rest>
    : never;

export type PathParamsOf<P extends string> = {
  [K in PathParamNames<P>]: string | number;
};

/** Arguments after the url: required path params for typed routes. */
export type PathArgs<R, P extends string> = IsUntyped<R> extends true
  ? [path?: PathParams]
  : [PathParamNames<P>] extends [never]
      ? []
      : [path: PathParamsOf<P>];

/** What a request builder accepts for `.body() / .params() / .headers() / .path()`. */
export type RequestInput = {
  body: unknown;
  query: unknown;
  headers: unknown;
  path: unknown;
};

export type DefaultInput = {
  body: Body;
  query: Params;
  headers: HeadersData;
  path: PathParams;
};

export type InputOf<R, P extends string, M extends Method> = IsUntyped<R> extends true
  ? DefaultInput
  : {
      body: Field<DefOf<R, P, M>, 'body'>;
      query: Field<DefOf<R, P, M>, 'query'>;
      headers: 'headers' extends keyof DefOf<R, P, M> ? Field<DefOf<R, P, M>, 'headers'> : HeadersData;
      path: PathParamsOf<P>;
    };

export type ResponseOf<R, P extends string, M extends Method> = IsUntyped<R> extends true
  ? unknown
  : [Field<DefOf<R, P, M>, 'response'>] extends [never]
      ? unknown
      : Field<DefOf<R, P, M>, 'response'>;

/** `{ ok: true, data }` or `{ ok: false, error }` — see `XRequest.result()`. */
export type Result<T, E> =
  | { ok: true; data: T; error?: undefined }
  | { ok: false; error: E; data?: undefined };

type DeclaredErrors<D> = Field<D, 'errors'> extends infer Errors
  ? [Errors] extends [never]
      ? never
      : { [S in keyof Errors & number]: HttpError<S, Errors[S]> }[keyof Errors & number]
  : never;

/** Declared `HttpError<status, body>`s plus everything else a request may fail with. */
export type ErrorOf<R, P extends string, M extends Method> = IsUntyped<R> extends true
  ? RequestError
  : DeclaredErrors<DefOf<R, P, M>> | RequestError;
