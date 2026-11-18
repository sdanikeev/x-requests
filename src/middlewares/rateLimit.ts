import { AbortError, NetworkError, ValidationError } from '../errors.js';
import type { Middleware } from '../middleware.js';
import type { FetcherRequestParams } from '../types.js';
import { originOf } from '../url.js';

export type RateLimitOptions = {
  /** At most `limit` requests start within any `interval` ms. Needs `interval`. */
  limit?: number;
  interval?: number;
  /** At most this many requests run at the same time (a stream counts until it ends). */
  maxConcurrent?: number;
  /** Requests above the limit wait in a queue of this size; a longer queue fails with a `NetworkError`. Defaults to unlimited. */
  maxQueue?: number;
  /** Requests with the same key share the limits. Defaults to the origin of the url. */
  key?: (data: FetcherRequestParams) => string;
  /** Clock, for tests. */
  now?: () => number;
  /** `setTimeout`, for tests. */
  schedule?: (callback: () => void, ms: number) => void;
};

type Waiter = { admit: () => void };

type Bucket = {
  started: number[];
  running: number;
  queue: Waiter[];
  timerSet: boolean;
};

/**
 * Keeps requests within a rate: the ones above the limit wait their turn (first in, first out) instead of failing.
 * Every attempt of a retried request takes its own place. A request that is aborted while it waits leaves the
 * queue without using the limit. Register it before `circuitBreakerMiddleware`, so that refused requests do not wait.
 */
export const rateLimitMiddleware = (options: RateLimitOptions): Middleware => {
  const {
    limit,
    interval,
    maxConcurrent,
    maxQueue = Number.POSITIVE_INFINITY,
    key = (data: FetcherRequestParams) => originOf(data.url),
    now = Date.now,
    schedule = (callback, ms) => void setTimeout(callback, ms),
  } = options;

  if (limit === undefined && maxConcurrent === undefined) {
    throw new ValidationError('The rate limit needs a limit with an interval, or maxConcurrent');
  }
  if (limit !== undefined && (!(limit >= 1) || !(interval !== undefined && interval > 0))) {
    throw new ValidationError('The limit must be at least 1 and needs an interval greater than zero');
  }
  if (maxConcurrent !== undefined && !(maxConcurrent >= 1)) {
    throw new ValidationError('The maxConcurrent must be at least 1');
  }

  const buckets = new Map<string, Bucket>();

  const bucketOf = (name: string) => {
    let bucket = buckets.get(name);

    if (!bucket) {
      bucket = { started: [], running: 0, queue: [], timerSet: false };
      buckets.set(name, bucket);
    }

    return bucket;
  };

  const drain = (bucket: Bucket) => {
    while (bucket.queue.length > 0) {
      if (maxConcurrent !== undefined && bucket.running >= maxConcurrent) return;

      if (limit !== undefined) {
        const windowStart = now() - interval!;

        while (bucket.started.length > 0 && bucket.started[0]! <= windowStart) bucket.started.shift();

        if (bucket.started.length >= limit) {
          if (!bucket.timerSet) {
            bucket.timerSet = true;
            schedule(() => {
              bucket.timerSet = false;
              drain(bucket);
            }, bucket.started[0]! + interval! - now());
          }

          return;
        }

        bucket.started.push(now());
      }

      bucket.running++;
      bucket.queue.shift()!.admit();
    }
  };

  const acquire = (bucket: Bucket, signal: AbortSignal | undefined) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError({ cause: signal.reason }));

      return;
    }

    const onAbort = () => {
      bucket.queue.splice(bucket.queue.indexOf(waiter), 1);
      reject(new AbortError({ cause: signal?.reason }));
    };
    const waiter: Waiter = {
      admit: () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
    };

    bucket.queue.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
    drain(bucket);

    if (bucket.queue.includes(waiter) && bucket.queue.length > maxQueue) {
      bucket.queue.splice(bucket.queue.indexOf(waiter), 1);
      signal?.removeEventListener('abort', onAbort);
      reject(new NetworkError('The rate limit queue is full'));
    }
  });

  const release = (bucket: Bucket) => {
    bucket.running--;
    drain(bucket);
  };

  return async (data, next) => {
    const bucket = bucketOf(key(data));

    if (data.stream) {
      // the place is taken when the stream is read, so a stream that is never read does not hold it
      return (async function* () {
        await acquire(bucket, data.signal);

        try {
          yield* (await next(data)) as AsyncIterable<unknown>;
        } finally {
          release(bucket);
        }
      })();
    }

    await acquire(bucket, data.signal);

    try {
      return await next(data);
    } finally {
      release(bucket);
    }
  };
};
