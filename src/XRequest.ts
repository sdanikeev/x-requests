import { HttpError, ParseError, ValidationError, toRequestError } from './errors.js';
import { isRetryableStatus } from './statusCodes.js';
import type { RequestError } from './errors.js';
import type { DefaultInput, RequestInput, Result } from './routes.js';
import type {
  RequestData,
  Body,
  Params,
  HeadersData,
  PathParams,
  Config as GlobalConfig,
  Method,
  Fetcher,
} from './types.js';

class XRequest<T = unknown, In extends RequestInput = DefaultInput, E = RequestError> implements PromiseLike<T> {
  private readonly globalConfig: GlobalConfig | undefined;
  private readonly fetcher: Fetcher;
  private readonly requestData: Partial<RequestData>;
  private readonly requestConfig: {
    timeout?: number | null;
    retries?: number;
    backoffMs?: number;
  } = {};

  private fallbackHandler: ((error: unknown) => unknown) | undefined;
  private promise: Promise<T> | undefined;

  private static RequiredFields = new Set([
    'url',
    'method',
  ]);

  constructor(fetcher: Fetcher, method: Method, url: string, globalConfig?: GlobalConfig) {
    this.fetcher = fetcher;
    this.globalConfig = globalConfig;
    this.requestData = {
      url,
      method,
    };

    if (this.globalConfig?.maxRetries === 0) {
      throw new Error(`maxRetries cannot be equal to zero.`);
    }
  }

  public body(data: In['body']) {
    this.requestData.body = data as Body;

    return this;
  }

  public path(data: In['path']) {
    this.requestData.path = data as PathParams;

    return this;
  }

  public params(data: In['query']) {
    this.requestData.params = data as Params;

    return this;
  }

  public headers(data: In['headers']) {
    this.requestData.headers = data as HeadersData;

    return this;
  }

  public timeout(ms: number | null) {
    this.requestConfig.timeout = ms;

    return this;
  }

  public fallback<F>(fallback: F | ((error: unknown) => F)): XRequest<T | F, In, E> {
    this.fallbackHandler = typeof fallback === 'function'
      ? fallback as (error: unknown) => F
      : () => fallback;

    return this as unknown as XRequest<T | F, In, E>;
  }

  public retries(retries: number, backoffMs?: number) {
    const maxRetries = this.globalConfig?.maxRetries;

    if (maxRetries !== undefined && retries > maxRetries) {
      throw new Error(`Retry count cannot be greater than maxRetries - ${retries} > ${maxRetries}`);
    }
    if (retries < 1) {
      throw new Error(`Retry count cannot be looser than 1`);
    }

    this.requestConfig.retries = retries;
    this.requestConfig.backoffMs = backoffMs ?? this.requestConfig.backoffMs ?? 500;

    return this;
  }

  then<TResult1 = T, TResult2 = unknown>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    this.promise ??= this.run();

    return this.promise.then(onfulfilled, onrejected);
  }

  /**
   * Like `await`, but never rejects with a request failure: the error is returned
   * as a typed value instead. Programmer mistakes (`ValidationError`) still throw.
   *
   *   const result = await client.get('/users/{id}', { id: 1 }).result();
   *   if (!result.ok) { result.error.kind; }
   */
  public async result(): Promise<Result<T, E>> {
    try {
      return { ok: true, data: await this };
    } catch (error) {
      if (error instanceof ValidationError) throw error;

      return { ok: false, error: toRequestError(error) as E };
    }
  }

  private async run(): Promise<T> {
    this.validate();

    try {
      return await this.executeWithRetries<T>();
    } catch (error) {
      if (!this.fallbackHandler) throw error;

      return this.fallbackHandler(error) as T;
    }
  }

  private validate() {
    for (const [key, value] of Object.entries(this.requestData)) {
      if (
        XRequest.RequiredFields.has(key)
        && ([null, undefined, ''] as unknown[]).includes(value)
      ) {
        throw new ValidationError(`The value is missing: ${key}`);
      }
    }

    this.resolveUrl();
  }

  private execute<T>(): Promise<T> {
    return this.fetcher.request({
      url: this.resolveUrl(),
      method: this.requestData.method!,
      ...(this.requestData.body && {
        body: this.requestData.body,
      }),
      ...(this.requestData.params && {
        params: this.requestData.params,
      }),
      ...(this.requestData.headers && {
        headers: this.requestData.headers,
      }),
      ...(this.requestConfig.timeout && {
        timeout: this.requestConfig.timeout,
      }),
    });
  }

  private async executeWithRetries<T>(): Promise<T> {
    const retries = this.requestConfig.retries ?? 0;
    const backoffMs = this.requestConfig.backoffMs ?? 500;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.execute<T>();
      } catch (error) {
        if (attempt >= retries || !XRequest.isRetryable(error)) {
          throw error;
        }

        await new Promise(resolve => setTimeout(resolve, backoffMs * 2 ** attempt));
      }
    }
  }

  private static isRetryable(error: unknown): boolean {
    if (error instanceof HttpError) {
      return isRetryableStatus(error.status);
    }

    // an invalid response will be just as invalid on the next attempt
    return !(error instanceof ParseError);
  }

  private fillPath(url: string): string {
    return url.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
      const value = this.requestData.path?.[name];

      if (value === undefined || value === null) {
        throw new ValidationError(`The path parameter is missing: ${name}`);
      }

      return encodeURIComponent(String(value));
    });
  }

  private resolveUrl(): string {
    const url = this.fillPath(this.requestData.url!);
    const baseUrl = this.globalConfig?.baseUrl;

    if (!baseUrl || /^[a-z][a-z\d+.-]*:\/\//i.test(url)) return url;

    return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
  }
}

export default XRequest;
