/**
 * Optional public-deployment boundaries for a trusted HTTPS reverse proxy.
 * Local deployments keep their existing behaviour when these options are unset.
 * @module edge
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compare opaque header secrets without leaking their contents or prefix length.
 * @param {unknown} candidate - Supplied HTTP header; arrays are rejected.
 * @param {string} expected - Configured secret.
 * @returns {boolean} Whether the header matches the configured secret.
 */
export function secretMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || !expected) return false;
  const actualHash = createHash('sha256').update(candidate).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

/**
 * Validate configured credentials and the browser's canonical public origin.
 * @param {object} options - Optional origin, bootstrap and public-origin settings.
 * @returns {void} Throws on incomplete or malformed deployment settings.
 */
export function validateEdgeOptions({ originSecret, bootstrapToken, publicOrigin }) {
  for (const [name, value] of [['APP_ORIGIN_SECRET', originSecret], ['BOOTSTRAP_TOKEN', bootstrapToken]]) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || Buffer.byteLength(value) < 32)) {
      throw new Error(`${name} must contain at least 32 bytes when configured.`);
    }
  }
  if (publicOrigin !== undefined && publicOrigin !== null) {
    const url = new URL(publicOrigin);
    if (url.protocol !== 'https:' || url.origin !== publicOrigin) {
      throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a path or credentials.');
    }
  }
}

/**
 * Reject requests that bypass HAProxy before cookies, routes or static handling.
 * A configured browser origin also protects mutations against foreign origins.
 * @param {object} app - Root Fastify application.
 * @param {object} options - Optional origin secret and canonical public origin.
 * @returns {void} Registers the root request boundary.
 */
export function registerEdge(app, { originSecret, publicOrigin }) {
  app.addHook('onRequest', async (req, reply) => {
    if (originSecret && !secretMatches(req.headers['x-app-origin-secret'], originSecret)) {
      return reply.code(403).header('Cache-Control', 'no-store').send({ error: { code: 'forbidden', message: 'Access denied' } });
    }
    if (publicOrigin && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
        req.headers.origin !== undefined && req.headers.origin !== publicOrigin) {
      return reply.code(403).header('Cache-Control', 'no-store').send({ error: { code: 'forbidden', message: 'Access denied' } });
    }
  });
}
