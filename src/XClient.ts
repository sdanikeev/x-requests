import type { Config, Fetcher, Method } from './types.js';
import type {
  ErrorOf,
  InputOf,
  PathArgs,
  RegisteredRoutes,
  ResponseOf,
  RoutesConstraint,
  UrlOf,
} from './routes.js';

import XRequest from './XRequest.js';

class XClient<R extends RoutesConstraint<R> = RegisteredRoutes> {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly config?: Config,
  ) { }

  public get<P extends UrlOf<R, 'get'> & string>(url: P, ...path: PathArgs<R, P>) {
    return this.createXRequest<P, 'get'>('get', url, path);
  }

  public post<P extends UrlOf<R, 'post'> & string>(url: P, ...path: PathArgs<R, P>) {
    return this.createXRequest<P, 'post'>('post', url, path);
  }

  public put<P extends UrlOf<R, 'put'> & string>(url: P, ...path: PathArgs<R, P>) {
    return this.createXRequest<P, 'put'>('put', url, path);
  }

  public patch<P extends UrlOf<R, 'patch'> & string>(url: P, ...path: PathArgs<R, P>) {
    return this.createXRequest<P, 'patch'>('patch', url, path);
  }

  public delete<P extends UrlOf<R, 'delete'> & string>(url: P, ...path: PathArgs<R, P>) {
    return this.createXRequest<P, 'delete'>('delete', url, path);
  }

  public options<P extends UrlOf<R, 'options'> & string>(url: P, ...path: PathArgs<R, P>) {
    return this.createXRequest<P, 'options'>('options', url, path);
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
