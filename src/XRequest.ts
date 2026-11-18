import { AbortError, CircuitOpenError, HttpError, ParseError, ValidationError, toRequestError } from './errors.js';
import { hasHeader } from './headers.js';
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
  FetcherRequestParams,
  ResponseType,
  RetryOptions,
  SseEvent,
} from './types.js';

type MultipartScalar = string | number | boolean | Blob;

export type MultipartValue = MultipartScalar | readonly MultipartScalar[] | null | undefined;

class XRequest<
  T = unknown,
  In extends RequestInput = DefaultInput,
  E = RequestError,
  Ev = SseEvent,
> implements PromiseLike<T> {
  private readonly globalConfig: GlobalConfig | undefined;
  private readonly fetcher: Fetcher;
  private readonly requestData: Partial<RequestData>;
  private readonly requestConfig: {
    timeout?: number | null;
    retries?: number;
    backoffMs?: number;
    signal?: AbortSignal;
    responseType?: ResponseType;
    idempotencyKey?: string;
    retryOptions?: RetryOptions;
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

  /**
   * Sends `multipart/form-data`. An object is converted to `FormData`: arrays repeat the field,
   * `null` and `undefined` are skipped, a `File` keeps its name, other values are stringified.
   *
   *   client.post('/upload').multipart({ file: new File([bytes], 'a.png'), tags: ['x', 'y'] });
   */
  public multipart(data: FormData | Record<string, MultipartValue>) {
    this.requestData.body = data instanceof FormData ? data : XRequest.toFormData(data);

    return this;
  }

  private static toFormData(fields: Record<string, MultipartValue>): FormData {
    const form = new FormData();

    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;

      for (const item of Array.isArray(value) ? value as MultipartScalar[] : [value as MultipartScalar]) {
        if (item instanceof Blob) form.append(name, item);
        else form.append(name, String(item));
      }
    }

    return form;
  }

  /**
   * Reads the response as binary (`'blob'`, `'arrayBuffer'`) or as raw `'text'`, bypassing JSON parsing.
   *
   *   const file = await client.get('/report').responseType('blob');
   */
  public responseType(kind: 'blob'): XRequest<Blob, In, E, Ev>;
  public responseType(kind: 'arrayBuffer'): XRequest<ArrayBuffer, In, E, Ev>;
  public responseType(kind: 'text'): XRequest<string, In, E, Ev>;
  public responseType(kind: ResponseType): XRequest<unknown, In, E, Ev> {
    this.requestConfig.responseType = kind;

    return this as unknown as XRequest<unknown, In, E, Ev>;
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

  public signal(signal: AbortSignal) {
    this.requestConfig.signal = signal;

    return this;
  }

  /**
   * Sends an idempotency key (`Idempotency-Key` by default, see `Config.idempotencyHeader`) so that
   * the server can tell a retry from a new request. The key is created once, so every attempt of
   * this request (retries, stream reconnects) carries the same one. Meant for POST and PATCH.
   * A header of the same name set with `.headers()` wins.
   *
   *   await client.post('/payments').body(order).idempotent().retries(3);
   */
  public idempotent(key?: string) {
    if (key !== undefined && key.trim() === '') {
      throw new ValidationError('The idempotency key must not be empty');
    }

    this.requestConfig.idempotencyKey = key ?? crypto.randomUUID();

    return this;
  }

  public fallback<F>(fallback: F | ((error: unknown) => F)): XRequest<T | F, In, E, Ev> {
    this.fallbackHandler = typeof fallback === 'function'
      ? fallback as (error: unknown) => F
      : () => fallback;

    return this as unknown as XRequest<T | F, In, E, Ev>;
  }

  /**
   * Retries a failed request up to `retries` times with exponential backoff (randomized, see `jitter`).
   * A `Retry-After` of a 429/503 response replaces the backoff. `POST` and `PATCH` are retried only after
   * `.idempotent()` (or with `unsafe: true`), because the first attempt may have reached the server.
   */
  public retries(retries: number, backoffMs?: number, options?: RetryOptions) {
    const maxRetries = this.globalConfig?.maxRetries;

    if (maxRetries !== undefined && retries > maxRetries) {
      throw new Error(`Retry count cannot be greater than maxRetries - ${retries} > ${maxRetries}`);
    }
    if (retries < 1) {
      throw new Error(`Retry count cannot be looser than 1`);
    }

    this.requestConfig.retries = retries;
    this.requestConfig.backoffMs = backoffMs ?? this.requestConfig.backoffMs ?? 500;

    if (options) this.requestConfig.retryOptions = options;

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

  /**
   * Opens a server-sent events stream. `data` is parsed as JSON unless `{ json: false }` is passed.
   * After a failure the stream reconnects up to `retries` times, sending `Last-Event-ID`.
   * A stream that the server closes normally just ends.
   *
   *   for await (const event of client.get('/events').stream()) { event.data; }
   */
  public stream(): AsyncGenerator<Ev, void, undefined>;
  public stream(options: { json: false }): AsyncGenerator<SseEvent<string>, void, undefined>;
  public stream(options?: { json?: boolean }): AsyncGenerator<unknown, void, undefined> {
    return this.streamEvents(options?.json !== false);
  }

  private async* streamEvents(json: boolean): AsyncGenerator<unknown, void, undefined> {
    this.validate();

    if (!this.fetcher.stream) {
      throw new ValidationError('The fetcher does not support streaming');
    }

    const retries = this.requestConfig.retries ?? 0;
    const backoffMs = this.requestConfig.backoffMs ?? 500;

    let failures = 0;
    let lastId: string | undefined;
    let retryHint: number | undefined;

    for (;;) {
      this.throwIfAborted();

      try {
        const headers = lastId === undefined
          ? undefined
          : { ...this.requestData.headers, 'Last-Event-ID': lastId };

        for await (const event of this.fetcher.stream(this.buildRequest(headers))) {
          failures = 0;
          lastId = event.id ?? lastId;
          retryHint = event.retry ?? retryHint;

          yield json ? XRequest.parseEvent(event) : event;
        }

        return;
      } catch (error) {
        if (failures >= retries || !this.canRetry(error)) throw error;

        await this.sleep(retryHint ?? this.retryDelay(error, failures, backoffMs));
        failures++;
      }
    }
  }

  private static parseEvent(event: SseEvent<string>): SseEvent {
    if (event.data.trim() === '') return event;

    try {
      return { ...event, data: JSON.parse(event.data) as unknown };
    } catch (error) {
      throw new ParseError(event.data, { cause: error });
    }
  }

  private async run(): Promise<T> {
    this.validate();

    try {
      return await this.executeWithRetries<T>();
    } catch (error) {
      if (!this.fallbackHandler || error instanceof AbortError) throw error;

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
    return this.fetcher.request(this.buildRequest());
  }

  private withIdempotencyKey(headers: HeadersData | undefined): HeadersData | undefined {
    const key = this.requestConfig.idempotencyKey;

    if (key === undefined) return headers;

    const name = this.globalConfig?.idempotencyHeader ?? 'Idempotency-Key';

    return hasHeader(headers, name) ? headers : { ...headers, [name]: key };
  }

  private buildRequest(rawHeaders = this.requestData.headers): FetcherRequestParams {
    const headers = this.withIdempotencyKey(rawHeaders);

    return {
      url: this.resolveUrl(),
      method: this.requestData.method!,
      ...(this.requestData.body && {
        body: this.requestData.body,
      }),
      ...(this.requestData.params && {
        params: this.requestData.params,
      }),
      ...(headers && {
        headers,
      }),
      ...(this.requestConfig.timeout && {
        timeout: this.requestConfig.timeout,
      }),
      ...(this.requestConfig.signal && {
        signal: this.requestConfig.signal,
      }),
      ...(this.requestConfig.responseType && {
        responseType: this.requestConfig.responseType,
      }),
    };
  }

  private async executeWithRetries<T>(): Promise<T> {
    const retries = this.requestConfig.retries ?? 0;
    const backoffMs = this.requestConfig.backoffMs ?? 500;

    for (let attempt = 0; ; attempt++) {
      this.throwIfAborted();

      try {
        return await this.execute<T>();
      } catch (error) {
        if (attempt >= retries || !this.canRetry(error)) {
          throw error;
        }

        await this.sleep(this.retryDelay(error, attempt, backoffMs));
      }
    }
  }

  private throwIfAborted() {
    const { signal } = this.requestConfig;

    if (signal?.aborted) throw new AbortError({ cause: signal.reason });
  }

  private sleep(ms: number): Promise<void> {
    const { signal } = this.requestConfig;

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortError({ cause: signal?.reason }));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private retrySettings(): Required<RetryOptions> {
    return {
      jitter: true,
      maxRetryAfter: 30_000,
      unsafe: false,
      ...this.globalConfig?.retry,
      ...this.requestConfig.retryOptions,
    };
  }

  private canRetry(error: unknown): boolean {
    if (!XRequest.isRetryable(error)) return false;

    const { unsafe, maxRetryAfter } = this.retrySettings();
    const isUnsafe = this.requestData.method === 'post' || this.requestData.method === 'patch';

    if (isUnsafe && !unsafe && this.requestConfig.idempotencyKey === undefined) return false;

    const wait = XRequest.retryAfter(error);

    return wait === undefined || wait <= maxRetryAfter;
  }

  private retryDelay(error: unknown, attempt: number, backoffMs: number): number {
    const wait = XRequest.retryAfter(error);

    if (wait !== undefined) return wait;

    const backoff = backoffMs * 2 ** attempt;

    return this.retrySettings().jitter ? backoff * (0.5 + Math.random() * 0.5) : backoff;
  }

  /** The delay a 429/503 response asks for, in ms (`Retry-After` is seconds or an HTTP date). */
  private static retryAfter(error: unknown): number | undefined {
    if (!(error instanceof HttpError) || (error.status !== 429 && error.status !== 503)) return undefined;

    const value = error.headers?.get('retry-after')?.trim();

    if (!value) return undefined;

    const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();

    return Number.isNaN(ms) ? undefined : Math.max(ms, 0);
  }

  private static isRetryable(error: unknown): boolean {
    // retrying an open circuit would only wait for nothing
    if (error instanceof AbortError || error instanceof CircuitOpenError) return false;

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
