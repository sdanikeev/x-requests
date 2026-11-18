export class XRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class HttpError<S extends number = number, D = unknown> extends XRequestError {
  public readonly kind = 'http' as const;

  /**
   * @param status HTTP status code
   * @param body raw response body
   * @param data parsed body (JSON when the response is JSON, otherwise the raw text)
   * @param headers response headers, set by fetchers that report them (`Fetch` does)
   */
  constructor(
    public readonly status: S,
    public readonly body: string,
    public readonly data: D = body as D,
    public readonly headers?: Headers,
  ) {
    super(`HTTP error! Status: ${status}. Body: ${body}`);
  }
}

export class TimeoutError extends XRequestError {
  public readonly kind = 'timeout' as const;

  constructor(public readonly timeoutMs: number | undefined, options?: ErrorOptions) {
    super(`Request timed out${timeoutMs ? ` after ${timeoutMs} ms` : ''}`, options);
  }
}

export class AbortError extends XRequestError {
  public readonly kind = 'abort' as const;

  constructor(options?: ErrorOptions) {
    super('Request aborted', options);
  }
}

export class NetworkError extends XRequestError {
  public readonly kind = 'network' as const;
}

export class ParseError extends XRequestError {
  public readonly kind = 'parse' as const;

  constructor(public readonly body: string, options?: ErrorOptions) {
    super(`Failed to parse JSON in http response: ${options?.cause}`, options);
  }
}

/** Thrown by `circuitBreakerMiddleware` instead of calling a service that keeps failing. */
export class CircuitOpenError extends XRequestError {
  public readonly kind = 'circuit' as const;

  constructor(public readonly retryAfterMs: number, options?: ErrorOptions) {
    super(`The circuit is open, the service is not called. Try again in ${retryAfterMs} ms`, options);
  }
}

export class ValidationError extends Error {
  public readonly kind = 'validation' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export type RequestError = HttpError | TimeoutError | NetworkError | ParseError | AbortError | CircuitOpenError;

export const toRequestError = (error: unknown): RequestError => {
  if (error instanceof XRequestError) return error as RequestError;

  return new NetworkError(error instanceof Error ? error.message : String(error), { cause: error });
};

type ExactHttp<E, S extends number> = E extends HttpError<infer St, infer D>
  ? [number] extends [St] ? never : S extends St ? HttpError<S, D> : never
  : never;

type WideHttp<E, S extends number> = E extends HttpError<infer St, infer D>
  ? [number] extends [St] ? HttpError<S, D> : never
  : never;

type NarrowHttp<E, S extends number> = unknown extends E
  ? HttpError<S>
  : number extends S
    ? Extract<E, HttpError<number, unknown>>
    : [ExactHttp<E, S>] extends [never] ? WideHttp<E, S> : ExactHttp<E, S>;

export const isHttpError = <E, S extends number = number>(
  error: E | NoInfer<NarrowHttp<E, S>>,
  status?: S,
): error is NarrowHttp<E, S> =>
  error instanceof HttpError && (status === undefined || error.status === status);
