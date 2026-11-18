import { HttpError } from '../errors.js';
import { hasHeader } from '../headers.js';
import type { Middleware } from '../middleware.js';
import type { FetcherRequestParams } from '../types.js';

export type AuthOptions = {
  getToken: () => string | undefined | Promise<string | undefined>;
  /**
   * Called when a request fails with 401: returns a new token and should store it, so that `getToken` returns it
   * from now on. Concurrent 401s share one call. The failed request is repeated once.
   */
  refresh?: () => string | Promise<string>;
  /** Prefix of the header value; an empty string sends the bare token. Defaults to `Bearer`. */
  scheme?: string;
  /** Defaults to `Authorization`. */
  header?: string;
};

/**
 * Adds a token to every request and, if `refresh` is given, renews it once on a 401 response.
 * A header with the same name set on the request itself is left alone.
 * A stream that is refused with 401 before its first event is reconnected once with the new token;
 * after the first event a 401 is passed on, because repeating the request would duplicate events.
 */
export const authMiddleware = (options: AuthOptions): Middleware => {
  const { getToken, refresh, scheme = 'Bearer', header = 'Authorization' } = options;

  let refreshing: Promise<string> | undefined;

  const refreshOnce = () => {
    refreshing ??= Promise.resolve().then(refresh).finally(() => {
      refreshing = undefined;
    }) as Promise<string>;

    return refreshing;
  };

  const withToken = (data: FetcherRequestParams, token: string | undefined): FetcherRequestParams =>
    token === undefined
      ? data
      : { ...data, headers: { ...data.headers, [header]: scheme ? `${scheme} ${token}` : token } };

  const isUnauthorized = (error: unknown) => error instanceof HttpError && error.status === 401;

  // another request may have refreshed the token while this one was in flight
  const renew = async (used: string | undefined) => {
    const current = await getToken();

    return current !== undefined && current !== used ? current : refreshOnce();
  };

  return async (data, next) => {
    if (hasHeader(data.headers, header)) return next(data);

    const token = await getToken();

    if (!refresh) return next(withToken(data, token));

    if (data.stream) {
      return (async function* () {
        let started = false;

        try {
          for await (const item of (await next(withToken(data, token))) as AsyncIterable<unknown>) {
            started = true;

            yield item;
          }
        } catch (error) {
          if (started || !isUnauthorized(error)) throw error;

          yield* (await next(withToken(data, await renew(token)))) as AsyncIterable<unknown>;
        }
      })();
    }

    try {
      return await next(withToken(data, token));
    } catch (error) {
      if (!isUnauthorized(error)) throw error;

      return next(withToken(data, await renew(token)));
    }
  };
};
