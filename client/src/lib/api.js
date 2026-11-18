/** An HTTP refusal, including the server's optional retry delay. */
export class ApiError extends Error {
  /**
   * Preserve structured API errors and either form of the Retry-After header.
   * @param {number} status - HTTP response status.
   * @param {object|null} body - Parsed response body, when available.
   * @param {string|null} [retryAfter] - Retry-After response header.
   */
  constructor(status, body, retryAfter = null) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    const bodyDelay = Number(body?.error?.retryAfterMs);
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const headerDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    const delays = [bodyDelay, headerDelay].filter((delay) => Number.isFinite(delay) && delay > 0);
    this.retryAfterMs = delays.length ? Math.max(...delays) : undefined;
  }
}

/** The server couldn't be reached at all (offline, Wi-Fi down, NUC asleep). */
export class NetworkError extends Error {}

/**
 * Send a same-origin request and retain HTTP errors for callers to classify.
 * @param {string} method - HTTP request method.
 * @param {string} url - Same-origin API path.
 * @param {object} [body] - JSON request body.
 * @returns {Promise<object|null>} Parsed JSON response.
 */
async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new NetworkError('Can’t reach the chores server');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty or non-JSON body
  }
  if (!res.ok) {
    throw new ApiError(res.status, data, res.headers.get('Retry-After'));
  }
  return data;
}

export const api = {
  /** Read a same-origin API resource. */
  get: (url) => request('GET', url),
  /** Create or submit a same-origin API resource. */
  post: (url, body = {}) => request('POST', url, body),
  /** Update a same-origin API resource. */
  patch: (url, body = {}) => request('PATCH', url, body),
};
