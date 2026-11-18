import { AbortError, ValidationError } from '../errors.js';
import { hasHeader } from '../headers.js';
import type { Middleware } from '../middleware.js';
import type { FetcherRequestParams, Method, ResponseContext } from '../types.js';

export type CacheOptions = {
  /** How long a successful response is reused, in milliseconds. */
  ttl: number;
  /** Methods that are cached. Defaults to `['get']`. */
  methods?: Method[];
  /** The least recently used entry is dropped above this size. Defaults to `500`. */
  maxEntries?: number;
  /** Header names that are part of the cache key. Defaults to `['authorization']`. */
  vary?: string[];
  /** Replaces the default key (method, url, params and `vary` headers). */
  key?: (data: FetcherRequestParams) => string;
  /** Give every caller its own copy of an object response. Defaults to `true`. */
  clone?: boolean;
  /**
   * Follow the `Cache-Control` of the response: `no-store`, `no-cache` and `max-age=0` skip the cache,
   * `max-age` can only shorten `ttl`. Needs a fetcher that reports headers (`Fetch` does). Defaults to `true`.
   */
  respectCacheControl?: boolean;
  /** Clock, for tests. */
  now?: () => number;
};

export type CacheMiddleware = Middleware & {
  clear(): void;
  /** Drops the entries of the url (as it is sent, without the query string). */
  invalidate(url: string): void;
};

type Entry = {
  key: string;
  value: Promise<unknown>;
  url: string;
  expires: number;
  /** Aborts the shared call once everyone who waits for it has given up. */
  controller: AbortController;
  waiters: number;
};

const canonicalParams = (params: FetcherRequestParams['params']) => {
  if (typeof params === 'string' || params === undefined) return params ?? '';

  return JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
};

/** The lifetime the response allows in ms (`Infinity` if it says nothing), 0 if it must not be stored. */
const lifetimeOf = (headers: Headers | undefined): number => {
  const directives = (headers?.get('cache-control') ?? '').toLowerCase().split(',').map(item => item.trim());

  if (directives.includes('no-store') || directives.includes('no-cache')) return 0;

  const maxAge = directives.find(item => item.startsWith('max-age='));
  const seconds = maxAge === undefined ? Number.NaN : Number(maxAge.slice('max-age='.length).replaceAll('"', ''));

  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Number.POSITIVE_INFINITY;
};

/**
 * Reuses successful responses for `ttl` ms. Identical requests made at the same time share one call,
 * which is cancelled only when every one of them has been aborted. Failures are never cached.
 * A successful request with an uncached unsafe method (POST, PUT, PATCH, DELETE) drops the entries of its url.
 * Streams are not cached.
 *
 * Register it after `authMiddleware`, so that the `Authorization` header is part of the key;
 * otherwise users who share a client would share responses.
 */
export const cacheMiddleware = (options: CacheOptions): CacheMiddleware => {
  const { ttl, maxEntries = 500, vary = ['authorization'], clone = true, respectCacheControl = true } = options;
  const now = options.now ?? Date.now;
  const methods = new Set<Method>(options.methods ?? ['get']);

  if (!(ttl > 0)) throw new ValidationError('The cache ttl must be greater than zero');
  if (!(maxEntries >= 1)) throw new ValidationError('The cache maxEntries must be at least 1');

  const entries = new Map<string, Entry>();

  const keyOf = options.key ?? ((data: FetcherRequestParams) => {
    const headers = Object.fromEntries(
      Object.entries(data.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const varied = vary.map(name => hasHeader(data.headers, name) ? headers[name.toLowerCase()] : null);

    return JSON.stringify([data.method, data.url, canonicalParams(data.params), varied]);
  });

  const copy = (value: unknown) => clone && typeof value === 'object' && value !== null ? structuredClone(value) : value;

  const forget = (entry: Entry) => {
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
  };

  const invalidate = (url: string) => {
    for (const entry of entries.values()) {
      if (entry.url === url) forget(entry);
    }
  };

  const leave = (entry: Entry, reason: unknown) => {
    entry.waiters--;

    if (entry.waiters > 0) return;

    forget(entry);
    entry.controller.abort(reason);
  };

  // A caller waits for the shared call, but its own abort ends only its own wait.
  const join = (entry: Entry, signal: AbortSignal | undefined): Promise<unknown> => {
    if (!signal) {
      entry.waiters++;

      return entry.value;
    }

    if (signal.aborted) return Promise.reject(new AbortError({ cause: signal.reason }));

    entry.waiters++;

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        leave(entry, signal.reason);
        reject(new AbortError({ cause: signal.reason }));
      };

      signal.addEventListener('abort', onAbort, { once: true });
      entry.value
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort));
    });
  };

  const middleware: Middleware = async (data, next, context: ResponseContext) => {
    if (data.stream) return next(data);

    if (!methods.has(data.method)) {
      const result = await next(data);

      if (data.method !== 'get' && data.method !== 'options') invalidate(data.url);

      return result;
    }

    const key = keyOf(data);
    const hit = entries.get(key);

    if (hit && hit.expires > now()) {
      // move to the end: the map order is the recency order
      entries.delete(key);
      entries.set(key, hit);

      return copy(await (Number.isFinite(hit.expires) ? hit.value : join(hit, data.signal)));
    }

    const controller = new AbortController();
    const entry: Entry = {
      key,
      value: next({ ...data, signal: controller.signal }),
      url: data.url,
      expires: Number.POSITIVE_INFINITY,
      controller,
      waiters: 0,
    };

    entries.delete(key);
    entries.set(key, entry);

    while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);

    // registered before anyone else waits, so the expiry is known when the first caller continues
    entry.value.then(
      () => {
        const lifetime = respectCacheControl ? Math.min(ttl, lifetimeOf(context.headers)) : ttl;

        if (lifetime > 0) entry.expires = now() + lifetime;
        else forget(entry);
      },
      () => forget(entry),
    );

    return copy(await join(entry, data.signal));
  };

  return Object.assign(middleware, { clear: () => entries.clear(), invalidate });
};
