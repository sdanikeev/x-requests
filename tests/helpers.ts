import type { Fetcher, FetcherRequestParams } from '../src/types.js';

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
