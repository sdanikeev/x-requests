import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HttpStatus,
  isClientError,
  isEmptyResponse,
  isRetryableStatus,
  isServerError,
} from '../src/statusCodes.js';

describe('statusCodes', () => {
  it('should match real codes if constants are compared', () => {
    assert.equal(HttpStatus.OK, 200);
    assert.equal(HttpStatus.NO_CONTENT, 204);
    assert.equal(HttpStatus.NOT_FOUND, 404);
    assert.equal(HttpStatus.TOO_MANY_REQUESTS, 429);
    assert.equal(HttpStatus.INTERNAL_SERVER_ERROR, 500);
  });

  it('should exist in node:http STATUS_CODES if every constant is checked', async () => {
    const { STATUS_CODES } = await import('node:http');

    for (const [name, code] of Object.entries(HttpStatus)) {
      assert.ok(STATUS_CODES[code], `${name}=${code} is an unknown code`);
    }
  });

  it('isClientError / isServerError should tell 4xx from 5xx if a status is checked', () => {
    assert.equal(isClientError(404), true);
    assert.equal(isClientError(500), false);
    assert.equal(isServerError(503), true);
    assert.equal(isServerError(499), false);
    assert.equal(isServerError(600), false);
  });

  it('isRetryableStatus should return true only for 429 and 5xx if a status is checked', () => {
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(404), false);
    assert.equal(isRetryableStatus(200), false);
  });

  it('isEmptyResponse should return true only for 204 and 205 if a status is checked', () => {
    assert.equal(isEmptyResponse(204), true);
    assert.equal(isEmptyResponse(205), true);
    assert.equal(isEmptyResponse(200), false);
  });
});
