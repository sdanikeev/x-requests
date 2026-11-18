import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AbortError, TimeoutError } from '../src/errors.js';
import Fetch from '../src/Fetch.js';
import XClient from '../src/XClient.js';
import { createFakeFetcher, createFlakyFetcher, hangingFetch } from './helpers.js';

const realFetch = globalThis.fetch;
const realAny = AbortSignal.any;

afterEach(() => {
  globalThis.fetch = realFetch;
  AbortSignal.any = realAny;
});

describe('Fetch with a signal', () => {
  it('should throw AbortError if the signal is aborted while the request is pending', async () => {
    globalThis.fetch = hangingFetch;
    const controller = new AbortController();

    const request = new Fetch().request({ method: 'get', url: 'https://example.com', signal: controller.signal });
    controller.abort();

    await assert.rejects(request, (error: unknown) => error instanceof AbortError && error.kind === 'abort');
  });

  it('should keep the abort reason as cause if the signal is aborted with a reason', async () => {
    globalThis.fetch = hangingFetch;
    const controller = new AbortController();
    const reason = new Error('user left the page');

    const request = new Fetch().request({ method: 'get', url: 'https://example.com', signal: controller.signal });
    controller.abort(reason);

    await assert.rejects(request, (error: unknown) => error instanceof AbortError && error.cause === reason);
  });

  it('should throw AbortError without waiting if the signal is already aborted', async () => {
    globalThis.fetch = hangingFetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com', signal: AbortSignal.abort() }),
      AbortError,
    );
  });

  it('should still throw TimeoutError if both a signal and a timeout are set and the timeout elapses first', async () => {
    globalThis.fetch = hangingFetch;

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com', signal: new AbortController().signal, timeout: 10 }),
      TimeoutError,
    );
  });

  it('should throw AbortError if both a signal and a timeout are set and the signal aborts first', async () => {
    globalThis.fetch = hangingFetch;
    const controller = new AbortController();

    const request = new Fetch().request({
      method: 'get',
      url: 'https://example.com',
      signal: controller.signal,
      timeout: 1000,
    });
    controller.abort();

    await assert.rejects(request, AbortError);
  });

  it('should combine the signal and the timeout without AbortSignal.any if it is not available', async () => {
    globalThis.fetch = hangingFetch;
    // @ts-expect-error simulating a runtime without AbortSignal.any (Node < 20.3)
    AbortSignal.any = undefined;
    const controller = new AbortController();

    const aborted = new Fetch().request({
      method: 'get',
      url: 'https://example.com',
      signal: controller.signal,
      timeout: 1000,
    });
    controller.abort();
    await assert.rejects(aborted, AbortError);

    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com', signal: AbortSignal.abort(), timeout: 1000 }),
      AbortError,
    );
    await assert.rejects(
      new Fetch().request({ method: 'get', url: 'https://example.com', signal: new AbortController().signal, timeout: 10 }),
      TimeoutError,
    );
  });
});

const rejects = (request: PromiseLike<unknown>, expected: Parameters<typeof assert.rejects>[1]) =>
  assert.rejects(Promise.resolve(request), expected);

describe('XRequest.signal()', () => {
  it('should pass the signal to the fetcher if it is set', async () => {
    const { fetcher, calls } = createFakeFetcher();
    const { signal } = new AbortController();

    await new XClient(fetcher).get('https://example.com/a').signal(signal);

    assert.equal(calls[0]?.signal, signal);
  });

  it('should not pass a signal to the fetcher if none is set', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await new XClient(fetcher).get('https://example.com/a');

    assert.equal('signal' in (calls[0] ?? {}), false);
  });

  it('should not call the fetcher if the signal is already aborted', async () => {
    const { fetcher, calls } = createFakeFetcher();

    await rejects(new XClient(fetcher).get('https://example.com/a').signal(AbortSignal.abort()), AbortError);
    assert.equal(calls.length, 0);
  });

  it('should not retry if the request was aborted', async () => {
    const controller = new AbortController();
    const { fetcher, calls } = createFlakyFetcher(10, undefined, () => {
      controller.abort();

      return new AbortError();
    });

    await rejects(
      new XClient(fetcher).get('https://example.com/a').signal(controller.signal).retries(3, 1),
      AbortError,
    );
    assert.equal(calls.length, 1);
  });

  it('should stop waiting for the backoff if the signal is aborted between attempts', async () => {
    const controller = new AbortController();
    const { fetcher, calls } = createFlakyFetcher(10);
    const started = Date.now();

    const request = new XClient(fetcher).get('https://example.com/a').signal(controller.signal).retries(3, 5000);
    setTimeout(() => controller.abort(new Error('stop')), 20);

    await rejects(request, (error: unknown) => error instanceof AbortError && (error.cause as Error).message === 'stop');
    assert.equal(calls.length, 1);
    assert.ok(Date.now() - started < 1000, 'abort must not wait for the backoff');
  });

  it('should not hide the abort behind a fallback if a fallback is set', async () => {
    const { fetcher } = createFakeFetcher();

    await rejects(
      new XClient(fetcher).get('https://example.com/a').signal(AbortSignal.abort()).fallback('default'),
      AbortError,
    );
  });

  it('should return { ok: false } with an AbortError if result() is used and the request is aborted', async () => {
    const { fetcher } = createFakeFetcher();

    const result = await new XClient(fetcher).get('https://example.com/a').signal(AbortSignal.abort()).result();

    assert.equal(result.ok, false);
    assert.ok(result.error instanceof AbortError);
  });

  it('should abort a real request end to end if the signal fires', async () => {
    globalThis.fetch = hangingFetch;
    const controller = new AbortController();

    const request = new XClient(new Fetch()).get('https://example.com/a').signal(controller.signal);
    setTimeout(() => controller.abort(), 10);

    await rejects(request, AbortError);
  });
});
