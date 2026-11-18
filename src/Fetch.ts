import { stringify } from 'fast-stringify';
import { AbortError, HttpError, NetworkError, ParseError, TimeoutError } from './errors.js';
import { parseSse } from './sse.js';
import { isEmptyResponse } from './statusCodes.js';
import type { Fetcher, FetcherRequestParams, SseEvent } from './types.js';

class Fetch implements Fetcher {
  public async request<T = unknown>(
    data: FetcherRequestParams,
  ): Promise<T> {
    const fetch = await this.getFetch();

    const url = this.prepareUrl(data.url, data.params);
    const headers = this.prepareHeaders(data.headers, Boolean(data.body));

    const signal = this.prepareSignal(data.signal, data.timeout);

    let response: Response;

    try {
      response = await fetch(url, {
        method: (data.method ?? 'GET').toUpperCase(),
        headers,
        ...(signal && { signal }),
        ...(data.body && {
          body: typeof data.body === 'string'
            ? data.body
            : stringify(data.body),
        }),
      });
    } catch (error) {
      throw this.toTransportError(error, data.timeout, data.signal);
    }

    return (await this.prepareResult(response)) as T;
  }

  public async* stream(data: FetcherRequestParams): AsyncGenerator<SseEvent<string>> {
    const fetch = await this.getFetch();

    const headers = this.prepareHeaders(data.headers, Boolean(data.body));

    if (!headers.has('Accept')) headers.set('Accept', 'text/event-stream');

    // for a stream the timeout limits only the wait for the connection, not the whole stream
    const controller = new AbortController();
    const state = { timedOut: false };
    const onAbort = () => controller.abort(data.signal?.reason);
    const timer = data.timeout
      ? setTimeout(() => {
          state.timedOut = true;
          controller.abort();
        }, data.timeout)
      : undefined;

    if (data.signal?.aborted) onAbort();
    else data.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      let response: Response;

      try {
        response = await fetch(this.prepareUrl(data.url, data.params), {
          method: (data.method ?? 'GET').toUpperCase(),
          headers,
          signal: controller.signal,
          ...(data.body && {
            body: typeof data.body === 'string' ? data.body : stringify(data.body),
          }),
        });
      } catch (error) {
        throw this.toStreamError(error, data, state.timedOut);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const raw = await response.text();
        const isJson = Boolean(response.headers.get('Content-Type')?.toLowerCase().includes('application/json'));

        throw new HttpError(response.status, raw, this.parseErrorBody(raw, isJson));
      }

      if (!response.body) return;

      try {
        yield* parseSse(response.body as unknown as AsyncIterable<Uint8Array>);
      } catch (error) {
        throw this.toStreamError(error, data, state.timedOut);
      }
    } finally {
      clearTimeout(timer);
      data.signal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }

  private toStreamError(error: unknown, data: FetcherRequestParams, timedOut: boolean) {
    if (data.signal?.aborted) return new AbortError({ cause: data.signal.reason });
    if (timedOut) return new TimeoutError(data.timeout, { cause: error });

    return new NetworkError(error instanceof Error ? error.message : String(error), { cause: error });
  }

  private prepareSignal(signal?: AbortSignal, timeout?: number): AbortSignal | undefined {
    const signals = [signal, timeout ? AbortSignal.timeout(timeout) : undefined]
      .filter((item): item is AbortSignal => item !== undefined);

    if (signals.length < 2) return signals[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);

    const controller = new AbortController();

    for (const item of signals) {
      if (item.aborted) {
        controller.abort(item.reason);
      } else {
        item.addEventListener('abort', () => controller.abort(item.reason), { once: true });
      }
    }

    return controller.signal;
  }

  private toTransportError(error: unknown, timeout?: number, signal?: AbortSignal) {
    if (signal?.aborted) {
      return new AbortError({ cause: signal.reason });
    }

    if (error instanceof Error && error.name === 'TimeoutError') {
      return new TimeoutError(timeout, { cause: error });
    }

    return new NetworkError(error instanceof Error ? error.message : String(error), { cause: error });
  }

  private async getFetch(): Promise<typeof globalThis.fetch> {
    if (typeof globalThis.fetch === 'function') {
      return globalThis.fetch.bind(globalThis);
    }
    const { default: nodeFetch } = await import('node-fetch');
    return nodeFetch as unknown as typeof globalThis.fetch;
  }

  private prepareUrl(rawUrl: string, params: FetcherRequestParams['params']): string {
    const url = new URL(rawUrl);

    if (params && typeof params === 'object') {
      const searchParams = new URLSearchParams(url.search);

      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          searchParams.append(key, String(value));
        }
      }
      url.search = searchParams.toString();
    }

    return url.toString();
  }

  private prepareHeaders(
    rawHeaders: FetcherRequestParams['headers'],
    hasBody: boolean,
  ): Headers {
    const headers = new Headers(rawHeaders as Record<string, string> | undefined);

    if (hasBody && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    return headers;
  }

  private async prepareResult(response: Response) {
    const rawResponse = await response.text();
    const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
    const isJson = contentType.includes('application/json');

    if (!response.ok) {
      throw new HttpError(response.status, rawResponse, this.parseErrorBody(rawResponse, isJson));
    }

    if (isEmptyResponse(response.status)) {
      return undefined;
    }

    if (!isJson) {
      return rawResponse;
    }

    if (!rawResponse.trim()) {
      return rawResponse;
    }

    try {
      return JSON.parse(rawResponse);
    } catch (err) {
      throw new ParseError(rawResponse, { cause: err });
    }
  }

  private parseErrorBody(raw: string, isJson: boolean): unknown {
    if (!isJson || !raw.trim()) return raw;

    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
}

export default Fetch;
