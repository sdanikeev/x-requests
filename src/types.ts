import type { Middleware } from './middleware.js';

export type Config = {
  baseUrl?: string;
  maxRetries?: number;
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
