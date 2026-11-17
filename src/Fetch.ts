import { stringify } from 'fast-stringify';
import { HttpError, NetworkError, ParseError, TimeoutError } from './errors.js';
import { isEmptyResponse } from './statusCodes.js';
import type { Fetcher, FetcherRequestParams } from './types.js';

class Fetch implements Fetcher {
  public async request<T = unknown>(
    data: FetcherRequestParams,
  ): Promise<T> {
    const fetch = await this.getFetch();

    const url = this.prepareUrl(data.url, data.params);
    const headers = this.prepareHeaders(data.headers, Boolean(data.body));

    let response: Response;

    try {
      response = await fetch(url, {
        method: (data.method ?? 'GET').toUpperCase(),
        headers,
        ...(data.timeout && {
          signal: AbortSignal.timeout(data.timeout),
        }),
        ...(data.body && {
          body: typeof data.body === 'string'
            ? data.body
            : stringify(data.body),
        }),
      });
    } catch (error) {
      throw this.toTransportError(error, data.timeout);
    }

    return (await this.prepareResult(response)) as T;
  }

  private toTransportError(error: unknown, timeout?: number) {
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

  /** JSON error bodies are parsed so they can be typed; anything else stays raw text. */
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
