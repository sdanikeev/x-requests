/**
 * HTTP status codes. `node:http` only has `STATUS_CODES` (code -> text) and no
 * named constants, so we keep our own (this also keeps the library runtime-agnostic).
 */
export const HttpStatus = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  RESET_CONTENT: 205,

  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  GONE: 410,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,

  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;

export type HttpStatusCode = typeof HttpStatus[keyof typeof HttpStatus];

export const isClientError = (status: number): boolean => status >= 400 && status < 500;

export const isServerError = (status: number): boolean => status >= 500 && status < 600;

export const isEmptyResponse = (status: number): boolean =>
  status === HttpStatus.NO_CONTENT || status === HttpStatus.RESET_CONTENT;

export const isRetryableStatus = (status: number): boolean =>
  status === HttpStatus.TOO_MANY_REQUESTS || isServerError(status);
