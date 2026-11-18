import { HttpError } from '../errors.js';
import type { Middleware } from '../middleware.js';
import type { FetcherRequestParams, ResponseContext } from '../types.js';

export type LogEntry = {
  method: string;
  url: string;
  headers: Record<string, string>;
  durationMs: number;
  ok: boolean;
  /** The HTTP status, when the fetcher reports it (`Fetch` does) or the error is an `HttpError`. */
  status?: number;
  error?: unknown;
  /** For a stream the entry is written when it ends, so `durationMs` is the lifetime of the stream. */
  stream: boolean;
};

export type LoggerOptions = {
  /** Defaults to one line per attempt in `console.info`. */
  log?: (entry: LogEntry) => void;
  /** Header names (case-insensitive) whose value is replaced with `[redacted]`. */
  redactHeaders?: string[];
};

const DEFAULT_REDACTED = ['authorization', 'cookie', 'set-cookie', 'proxy-authorization'];

const statusOf = (context: ResponseContext, error: unknown) =>
  context.status ?? (error instanceof HttpError ? error.status : undefined);

const defaultLog = (entry: LogEntry) => {
  const failure = entry.error instanceof Error ? entry.error.message : 'error';
  const outcome = entry.status ?? (entry.ok ? 'ok' : failure);

  console.info(`${entry.method} ${entry.url} ${outcome} ${entry.durationMs}ms${entry.stream ? ' (stream)' : ''}`);
};

/**
 * Logs every attempt of a request (retries are logged one by one). Bodies are never logged.
 */
export const loggerMiddleware = (options: LoggerOptions = {}): Middleware => {
  const { log = defaultLog, redactHeaders = DEFAULT_REDACTED } = options;
  const redacted = new Set(redactHeaders.map(name => name.toLowerCase()));

  const redact = (headers: FetcherRequestParams['headers']) =>
    Object.fromEntries(
      Object.entries(headers ?? {}).map(([name, value]) => [name, redacted.has(name.toLowerCase()) ? '[redacted]' : value]),
    );

  const entryOf = (
    data: FetcherRequestParams,
    context: ResponseContext,
    started: number,
    failure?: { error: unknown },
  ): LogEntry => {
    const status = statusOf(context, failure?.error);

    return {
      method: data.method.toUpperCase(),
      url: data.url,
      headers: redact(data.headers),
      durationMs: Date.now() - started,
      ok: failure === undefined,
      stream: data.stream === true,
      ...(failure && { error: failure.error }),
      ...(status !== undefined && { status }),
    };
  };

  return async (data, next, context) => {
    const started = Date.now();

    if (data.stream) {
      const source = await next(data) as AsyncIterable<unknown>;

      return (async function* () {
        let failure: { error: unknown } | undefined;

        try {
          yield* source;
        } catch (error) {
          failure = { error };

          throw error;
        } finally {
          log(entryOf(data, context, started, failure));
        }
      })();
    }

    try {
      const result = await next(data);

      log(entryOf(data, context, started));

      return result;
    } catch (error) {
      log(entryOf(data, context, started, { error }));

      throw error;
    }
  };
};
