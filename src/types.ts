export type Config = {
  baseUrl?: string;
  maxRetries?: number;
};

export type RequestData = {
  method: Method;
  headers: HeadersData;
  params: Params;
  path: PathParams;
  body: Body;
  url: string;
};

export type Body = Record<string, unknown> | unknown[] | string;

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
};

export interface Fetcher {
  request<T = unknown>(data: FetcherRequestParams): Promise<T>;
}
