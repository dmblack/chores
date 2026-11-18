import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createStorage } from './storage/index.js';
import { createStore } from './store.js';
import { registerAuth } from './auth.js';
import { registerRoutes } from './routes.js';
import { registerWatch } from './watch.js';
import { registerEdge, validateEdgeOptions } from './edge.js';

/** Live-update fan-out to every open /api/stream connection. */
function createHub() {
  const clients = new Set();
  return {
    /** @param {object} res - SSE response. @returns {Set} */
    add: (res) => clients.add(res),
    /** @param {object} res - SSE response. @returns {boolean} */
    remove: (res) => clients.delete(res),
    /** @returns {boolean} Whether cross-process revisions need polling. */
    hasClients: () => clients.size > 0,
    /** @param {number} seq - Committed sequence. @returns {void} */
    broadcast(seq) {
      const msg = `data: ${JSON.stringify({ seq })}\n\n`;
      for (const res of clients) {
        if (res.destroyed || res.writableEnded) clients.delete(res);
        else res.write(msg);
      }
    },
    /** @returns {void} Keep idle streaming connections alive. */
    heartbeat() {
      for (const res of clients) res.write(': ping\n\n');
    },
    /** @returns {void} End streams before HTTP shutdown waits for them. */
    closeAll() {
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

/**
 * Build the HTTP server and await adapter initialization through app.ready().
 * @param {object} [options] - Storage, clock, TLS and HTTP configuration.
 * @returns {import('fastify').FastifyInstance} Configured application.
 */
export function buildApp({
  dbPath = ':memory:',
  storage,
  clock = () => new Date(),
  cookieSecure = false,
  staticDir = null,
  trustProxy = false,
  https = null,
  logger = false,
  originSecret,
  bootstrapToken,
  publicOrigin,
} = {}) {
  validateEdgeOptions({ originSecret, bootstrapToken, publicOrigin });
  const app = Fastify({ logger, trustProxy, ...(https ? { https } : {}) });
  registerEdge(app, { originSecret, publicOrigin });
  const adapter = createStorage(storage ?? { backend: 'sqlite', dbPath });
  const hub = createHub();
  const store = createStore(adapter, { clock, onChange: (seq) => hub.broadcast(seq) });
  let initialized = false;
  let polling = null;

  app.register(cookie);
  app.register(async (api) => {
    await store.initialize();
    initialized = true;
    const auth = registerAuth(api, { store, cookieSecure, bootstrapToken });
    registerRoutes(api, { store, auth, hub });
    api.register(async (watch) => registerWatch(watch, { store, auth })); // Apple Watch page at /watch
  });

  const heartbeat = setInterval(() => hub.heartbeat(), 25_000);
  heartbeat.unref();
  // Poll only while subscribed, so changes from another process reach this hub.
  const revisions = setInterval(() => {
    if (!initialized || polling || !hub.hasClients()) return;
    polling = store.refresh()
      .catch((error) => { app.log.warn({ err: error }, 'Could not refresh storage revision'); })
      .finally(() => { polling = null; });
  }, 2_000);
  revisions.unref();
  app.addHook('preClose', async () => {
    clearInterval(heartbeat);
    clearInterval(revisions);
    hub.closeAll();
  });
  app.addHook('onClose', async () => {
    await polling;
    await store.close();
  });

  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    app.register(fastifyStatic, {
      root: staticDir,
      setHeaders(reply, path) {
        // Hashed bundles never change; index.html, sw.js and the manifest must be re-checked.
        reply.header('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    // Single-page app: unknown non-API paths get index.html.
    app.setNotFoundHandler((req, reply) => {
      if ((req.method === 'GET' || req.method === 'HEAD') && !req.url.startsWith('/api/')) return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
  }

  app.decorate('store', store);
  return app;
}
