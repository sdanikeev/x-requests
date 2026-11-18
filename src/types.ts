import type { Middleware } from './middleware.js';

export type RetryOptions = {
  /** Randomize the backoff between 50% and 100% of its value. Defaults to `true`. */
  jitter?: boolean;
  /** A `Retry-After` longer than this (ms) is not waited for: the request fails at once. Defaults to `30000`. */
  maxRetryAfter?: number;
  /** Also retry `POST` and `PATCH` without `.idempotent()`. A retried request may run twice. Defaults to `false`. */
  unsafe?: boolean;
};

export type Config = {
  baseUrl?: string;
  maxRetries?: number;
  /** Defaults for every request; `.retries(count, backoffMs, options)` overrides them. */
  retry?: RetryOptions;
  /** Header used by `.idempotent()`. Defaults to `Idempotency-Key`. */
  idempotencyHeader?: string;
  middleware?: Middleware[];
};

export type RequestData = {
  method: Method;
  headers: HeadersData;
  params: Params;
  path: PathParams;
  body: Body;
  url: string;
};

export type Body = Record<string, unknown> | unknown[] | string | FormData | URLSearchParams | Blob | ArrayBuffer;

export type ResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer';

export type Params = Record<string, unknown> | string;

export type HeadersData = Record<string, string>;

export type PathParams = Record<string, string | number>;

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options';

export type FetcherRequestParams = {
  method: Method;
  url: string;
  body?: Body;
  params?: Params;
  headers?: HeadersData;
  timeout?: number;
  signal?: AbortSignal;
  responseType?: ResponseType;
  /** Set by the client for `.stream()` requests, so middleware can tell a stream from a plain request. */
  stream?: boolean;
};

export type SseEvent<D = unknown, N extends string = string> = {
  event: N;
  data: D;
  id?: string;
  retry?: number;
};

/**
 * Out-parameter of one attempt: a `Fetcher` that can, fills it with what a plain body cannot carry.
 * The status and headers of an error response are set too, before the error is thrown.
 */
export type ResponseContext = {
  status?: number;
  headers?: Headers;
};

export interface Fetcher {
  request<T = unknown>(data: FetcherRequestParams, context?: ResponseContext): Promise<T>;
  stream?(data: FetcherRequestParams, context?: ResponseContext): AsyncIterable<SseEvent<string>>;
}
