/** Retry and visibility rules shared by the PWA's queued-action synchronizer. */
import { ApiError, NetworkError } from './api.js';

/** Ordinary retries run every fifteen seconds, with server backoff capped at fifteen minutes. */
export const RETRY_MS = 15_000;
const MAX_RETRY_MS = 15 * 60_000;

/**
 * Identify failures that must preserve queued actions for another attempt.
 * @param {unknown} error - Failure returned by the API client.
 * @returns {boolean} Whether a later request may succeed unchanged.
 */
export function isRetryableFailure(error) {
  return error instanceof NetworkError || (error instanceof ApiError && (error.status === 408 || error.status === 429 || error.status >= 500));
}

/**
 * Use the server's backoff without allowing immediate retries or an unbounded pause.
 * @param {{retryAfterMs?: number}} error - Failure with an optional server delay.
 * @returns {number} Retry delay in milliseconds, between fifteen seconds and fifteen minutes.
 */
export function retryDelay(error) {
  const delay = Number(error?.retryAfterMs);
  return Number.isFinite(delay) ? Math.min(MAX_RETRY_MS, Math.max(RETRY_MS, delay)) : RETRY_MS;
}

/**
 * Own one connection while the document is visible, including visibility changes.
 * @param {Document} document - Document whose foreground state controls the connection.
 * @param {() => () => void} connect - Open a connection and return its cleanup function.
 * @returns {() => void} Remove the listener and close the current connection.
 */
export function connectWhileVisible(document, connect) {
  let disconnect = null;
  /** Reconcile the connection once per visibility transition. */
  const update = () => {
    if (document.visibilityState === 'hidden') {
      disconnect?.();
      disconnect = null;
    } else if (!disconnect) {
      disconnect = connect();
    }
  };
  document.addEventListener('visibilitychange', update);
  update();
  /** Release the visibility listener and whichever connection is still open. */
  return () => {
    document.removeEventListener('visibilitychange', update);
    disconnect?.();
    disconnect = null;
  };
}
