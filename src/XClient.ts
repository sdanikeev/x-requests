import type { Config, Fetcher, FetcherRequestParams, Method } from './types.js';
import type {
  ErrorOf,
  InputOf,
  PathArgs,
  RegisteredRoutes,
  ResponseOf,
  RoutesConstraint,
  UrlOf,
} from './routes.js';

import type { Middleware } from './middleware.js';

import MiddlewareFetcher from './MiddlewareFetcher.js';
import XRequest from './XRequest.js';

class XClient<R extends RoutesConstraint<R> = RegisteredRoutes> {
  private readonly middlewares: Middleware[];
  private readonly fetcher: Fetcher;

  constructor(
    fetcher: Fetcher,
    private readonly config?: Config,
  ) {
    this.middlewares = [...(config?.middleware ?? [])];
    this.fetcher = new MiddlewareFetcher(fetcher, this.middlewares);
  }

  public get<P extends UrlOf<R, 'get'> & string>(url: P, ...path: PathArgs<R, P, 'get'>) {
    return this.createXRequest<P, 'get'>('get', url, path);
  }

  public post<P extends UrlOf<R, 'post'> & string>(url: P, ...path: PathArgs<R, P, 'post'>) {
    return this.createXRequest<P, 'post'>('post', url, path);
  }

  public put<P extends UrlOf<R, 'put'> & string>(url: P, ...path: PathArgs<R, P, 'put'>) {
    return this.createXRequest<P, 'put'>('put', url, path);
  }

  public patch<P extends UrlOf<R, 'patch'> & string>(url: P, ...path: PathArgs<R, P, 'patch'>) {
    return this.createXRequest<P, 'patch'>('patch', url, path);
  }

  public delete<P extends UrlOf<R, 'delete'> & string>(url: P, ...path: PathArgs<R, P, 'delete'>) {
    return this.createXRequest<P, 'delete'>('delete', url, path);
  }

  public options<P extends UrlOf<R, 'options'> & string>(url: P, ...path: PathArgs<R, P, 'options'>) {
    return this.createXRequest<P, 'options'>('options', url, path);
  }

  public use(middleware: Middleware): () => void {
    this.middlewares.push(middleware);

    return () => {
      const index = this.middlewares.indexOf(middleware);

      if (index !== -1) this.middlewares.splice(index, 1);
    };
  }

  public onRequest(
    handler: (data: FetcherRequestParams) => FetcherRequestParams | Promise<FetcherRequestParams>,
  ): () => void {
    return this.use(async (data, next) => next(await handler(data)));
  }

  public onResponse(handler: (response: unknown) => unknown): () => void {
    return this.use(async (data, next) => handler(await next(data)));
  }

  private createXRequest<P extends string, M extends Method>(
    method: Method,
    url: string,
    args: unknown[],
  ): XRequest<ResponseOf<R, P, M>, InputOf<R, P, M>, ErrorOf<R, P, M>> {
    const request = new XRequest(this.fetcher, method, url, this.config);
    const [path] = args as [Record<string, string | number> | undefined];

    return (path ? request.path(path) : request) as never;
  }
}

export default XClient;
