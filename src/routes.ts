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
  /** Types of path parameters; names and arity still come from the url placeholders. */
  path?: Record<string, unknown>;
  /**
   * Error bodies by status: `{ 404: NotFoundBody; 422: ValidationBody }`.
   * `default` is the body for every status that is not listed.
   */
  errors?: Partial<Record<number | 'default', unknown>>;
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

/** Path parameter types declared by the route, otherwise `string | number` per placeholder. */
type PathOf<R, P extends string, M extends Method> = DefOf<R, P, M> extends infer D
  ? 'path' extends keyof D
    ? Exclude<D['path'], undefined>
    : PathParamsOf<P>
  : PathParamsOf<P>;

/** Arguments after the url: required path params for typed routes. */
export type PathArgs<R, P extends string, M extends Method> = IsUntyped<R> extends true
  ? [path?: PathParams]
  : [PathParamNames<P>] extends [never]
      ? []
      : [path: PathOf<R, P, M>];

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
      path: PathOf<R, P, M>;
    };

// `undefined` is a legitimate response (204), so it must not be stripped like in `Field`
export type ResponseOf<R, P extends string, M extends Method> = IsUntyped<R> extends true
  ? unknown
  : DefOf<R, P, M> extends infer D
    ? 'response' extends keyof D ? D['response'] : unknown
    : unknown;

/** `{ ok: true, data }` or `{ ok: false, error }` — see `XRequest.result()`. */
export type Result<T, E> =
  | { ok: true; data: T; error?: undefined }
  | { ok: false; error: E; data?: undefined };

type DeclaredErrors<D> = Field<D, 'errors'> extends infer Errors
  ? [Errors] extends [never]
      ? never
      : { [S in keyof Errors & number]: HttpError<S, Errors[S]> }[keyof Errors & number]
  : never;

/** The body of an `errors.default` entry, or `HttpError` with unknown data when not declared. */
type AnyStatusError<D> = Field<D, 'errors'> extends infer Errors
  ? [Errors] extends [never]
      ? HttpError
      : 'default' extends keyof Errors ? HttpError<number, Errors['default']> : HttpError
  : HttpError;

/**
 * Declared `HttpError<status, body>`s, an `HttpError` for any other status
 * (typed by `errors.default` when present) and the non-HTTP failures.
 */
export type ErrorOf<R, P extends string, M extends Method> = IsUntyped<R> extends true
  ? RequestError
  : DeclaredErrors<DefOf<R, P, M>> | AnyStatusError<DefOf<R, P, M>> | Exclude<RequestError, HttpError>;
