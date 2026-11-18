/** Focused PWA tests for temporary request failures and foreground connections. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { api, ApiError, NetworkError } from './api.js';
import { connectWhileVisible, isRetryableFailure, RETRY_MS, retryDelay } from './sync.js';

/** A minimal document substitute that emits real visibility events. */
class VisibilityDocument extends EventTarget {
  /** Construct a document in the requested initial visibility state. */
  constructor(visibilityState = 'visible') {
    super();
    this.visibilityState = visibilityState;
  }

  /** Change visibility and notify connection owners, including repeated events. */
  setVisibility(visibilityState) {
    this.visibilityState = visibilityState;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

/** Exercise the HTTP boundary so temporary proxy and server errors retain their status and delay. */
test('temporary HTTP failures preserve queued actions and their retry hints', async (t) => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'Try again later', retryAfterMs: 45_000 } }), {
      status,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
    }));
    await assert.rejects(api.post('/api/actions', { actions: [{ id: 'stable-action-id' }] }), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      assert.equal(isRetryableFailure(error), true);
      assert.equal(retryDelay(error), 60_000);
      return true;
    });
    t.mock.restoreAll();
  }
});

/** Offline failures remain retryable, while permanent validation failures remain distinguishable. */
test('network failures retry while invalid requests and expired sessions do not', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Offline'); });
  await assert.rejects(api.post('/api/actions'), (error) => error instanceof NetworkError && isRetryableFailure(error));
  for (const status of [400, 401, 403, 404, 409, 413, 422]) {
    assert.equal(isRetryableFailure(new ApiError(status, null)), false);
  }
});

/** Both HTTP-date and JSON backoff instructions influence the next permitted write. */
test('retry hints accept dates and JSON delays with a bounded minimum and maximum', (t) => {
  const now = Date.parse('2026-11-18T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  assert.equal(retryDelay(new ApiError(503, null, 'Wed, 18 Nov 2026 00:02:00 GMT')), 120_000);
  assert.equal(retryDelay(new ApiError(429, { error: { retryAfterMs: 90_000 } }, '60')), 90_000);
  assert.equal(retryDelay(new ApiError(503, null, 'invalid')), RETRY_MS);
  assert.equal(retryDelay(new ApiError(503, null, '1')), RETRY_MS);
  assert.equal(retryDelay(new ApiError(503, null, '3600')), 15 * 60_000);
  assert.equal(retryDelay(new NetworkError('Offline')), RETRY_MS);
});

/** A hidden PWA owns no live stream, and each foreground transition opens exactly one. */
test('visibility transitions close and reopen the live connection without leaking listeners', () => {
  const document = new VisibilityDocument('hidden');
  let opened = 0;
  let closed = 0;
  const cleanup = connectWhileVisible(document, () => {
    opened += 1;
    return () => { closed += 1; };
  });
  assert.equal(opened, 0);
  document.setVisibility('visible');
  document.setVisibility('visible');
  assert.equal(opened, 1);
  document.setVisibility('hidden');
  assert.equal(closed, 1);
  document.setVisibility('visible');
  assert.equal(opened, 2);
  cleanup();
  assert.equal(closed, 2);
  document.setVisibility('hidden');
  document.setVisibility('visible');
  assert.equal(opened, 2);
});

/** Pages already visible at mount connect immediately and release the stream on unmount. */
test('visible pages connect immediately and clean up on unmount', () => {
  const document = new VisibilityDocument();
  let connected = false;
  const cleanup = connectWhileVisible(document, () => {
    connected = true;
    return () => { connected = false; };
  });
  assert.equal(connected, true);
  cleanup();
  assert.equal(connected, false);
});
