import { AbortError, CircuitOpenError, HttpError, NetworkError, TimeoutError, ValidationError } from '../errors.js';
import type { Middleware } from '../middleware.js';
import type { FetcherRequestParams } from '../types.js';
import { originOf } from '../url.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export type CircuitBreakerOptions = {
  /** Consecutive failures that open the circuit. Defaults to `5`. */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial request is let through, in ms. Defaults to `30000`. */
  resetTimeout?: number;
  /** Requests with the same key share a circuit. Defaults to the origin of the url. */
  key?: (data: FetcherRequestParams) => string;
  /** What counts as a failure. Defaults to network errors, timeouts and HTTP 5xx. */
  isFailure?: (error: unknown) => boolean;
  /** Clock, for tests. */
  now?: () => number;
};

export type CircuitBreakerMiddleware = Middleware & {
  state(key: string): CircuitState;
  /** Closes the circuit of the key, or of every key if none is given. */
  reset(key?: string): void;
};

type Circuit = { failures: number; openedAt: number | undefined; probing: boolean };

const isServiceFailure = (error: unknown) =>
  error instanceof NetworkError
  || error instanceof TimeoutError
  || (error instanceof HttpError && error.status >= 500);

/**
 * Stops calling a service that keeps failing: after `failureThreshold` failures in a row every request fails at once
 * with a `CircuitOpenError` (not retried, `.fallback()` can replace it). After `resetTimeout` one trial request
 * goes through: if it succeeds the circuit closes, otherwise it opens again.
 *
 * A 4xx, a parse error or any other answer means the service is alive and resets the counter; an abort changes nothing.
 * A stream is refused while the circuit is open, but its own outcome is not counted.
 */
export const circuitBreakerMiddleware = (options: CircuitBreakerOptions = {}): CircuitBreakerMiddleware => {
  const {
    failureThreshold = 5,
    resetTimeout = 30_000,
    key = (data: FetcherRequestParams) => originOf(data.url),
    isFailure = isServiceFailure,
    now = Date.now,
  } = options;

  if (!(failureThreshold >= 1)) throw new ValidationError('The failureThreshold must be at least 1');
  if (!(resetTimeout > 0)) throw new ValidationError('The resetTimeout must be greater than zero');

  const circuits = new Map<string, Circuit>();

  const circuitOf = (name: string) => {
    let circuit = circuits.get(name);

    if (!circuit) {
      circuit = { failures: 0, openedAt: undefined, probing: false };
      circuits.set(name, circuit);
    }

    return circuit;
  };

  const stateOf = (circuit: Circuit | undefined): CircuitState => {
    if (circuit?.openedAt === undefined) return 'closed';

    return now() - circuit.openedAt < resetTimeout ? 'open' : 'half-open';
  };

  const close = (circuit: Circuit) => {
    circuit.failures = 0;
    circuit.openedAt = undefined;
    circuit.probing = false;
  };

  const middleware: Middleware = async (data, next) => {
    const circuit = circuitOf(key(data));
    const state = stateOf(circuit);

    if (state === 'open') throw new CircuitOpenError(resetTimeout - (now() - circuit.openedAt!));
    if (state === 'half-open' && circuit.probing) throw new CircuitOpenError(resetTimeout);
    if (data.stream) return next(data);

    const isProbe = state === 'half-open';

    circuit.probing = isProbe;

    try {
      const result = await next(data);

      close(circuit);

      return result;
    } catch (error) {
      if (error instanceof AbortError) {
        circuit.probing = false;
      } else if (isFailure(error)) {
        circuit.failures++;
        circuit.probing = false;

        if (isProbe || circuit.failures >= failureThreshold) circuit.openedAt = now();
      } else {
        close(circuit);
      }

      throw error;
    }
  };

  return Object.assign(middleware, {
    state: (name: string) => stateOf(circuits.get(name)),
    reset: (name?: string) => {
      if (name === undefined) circuits.clear();
      else circuits.delete(name);
    },
  });
};
