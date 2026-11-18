import type { Fetcher, FetcherRequestParams, SseEvent } from '../src/types.js';

export const createFakeFetcher = (response: unknown = { ok: true }) => {
  const calls: FetcherRequestParams[] = [];
  const fetcher: Fetcher = {
    async request<T>(data: FetcherRequestParams) {
      calls.push(data);
      return response as T;
    },
  };
  return { fetcher, calls };
};

export const createFlakyFetcher = (
  failTimes: number,
  response: unknown = { ok: true },
  makeError: (attempt: number) => Error = attempt => new Error(`fail #${attempt}`),
) => {
  const calls: FetcherRequestParams[] = [];
  const fetcher: Fetcher = {
    async request<T>(data: FetcherRequestParams) {
      calls.push(data);

      if (calls.length <= failTimes) {
        throw makeError(calls.length);
      }

      return response as T;
    },
  };

  return { fetcher, calls };
};

// A fetch that never responds and rejects once its signal is aborted (immediately if it already is, like the real one).
// AbortSignal.timeout() is unref'd, so the pending timer alone would let the event loop exit.
export const hangingFetch = ((_url: string, init: RequestInit) =>
  new Promise((_resolve, reject) => {
    if (init.signal?.aborted) return reject(init.signal.reason);

    const keepAlive = setTimeout(() => {}, 1000);

    init.signal?.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(init.signal?.reason);
    });
  })) as typeof fetch;

type Connection = (SseEvent<string> | Error)[];

// Every call of stream() consumes the next connection: events are yielded, an Error is thrown.
export const createStreamFetcher = (connections: Connection[]) => {
  const calls: FetcherRequestParams[] = [];
  const fetcher: Fetcher = {
    async request<T>() {
      return undefined as T;
    },
    async* stream(data: FetcherRequestParams) {
      calls.push(data);

      for (const item of connections[calls.length - 1] ?? []) {
        if (item instanceof Error) throw item;

        yield item;
      }
    },
  };

  return { fetcher, calls };
};

export const event = (data: string, extra: Partial<SseEvent<string>> = {}): SseEvent<string> => ({
  event: 'message',
  data,
  ...extra,
});
