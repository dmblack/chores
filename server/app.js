import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createStore } from './store.js';
import { registerAuth } from './auth.js';
import { registerRoutes } from './routes.js';
import { registerWatch } from './watch.js';

/** Live-update fan-out to every open /api/stream connection. */
function createHub() {
  const clients = new Set();
  return {
    add: (res) => clients.add(res),
    remove: (res) => clients.delete(res),
    broadcast(seq) {
      const msg = `data: ${JSON.stringify({ seq })}\n\n`;
      for (const res of clients) res.write(msg);
    },
    heartbeat() {
      for (const res of clients) res.write(': ping\n\n');
    },
    closeAll() {
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

export function buildApp({
  dbPath = ':memory:',
  clock = () => new Date(),
  cookieSecure = false,
  staticDir = null,
  trustProxy = false,
  https = null,
  logger = false,
} = {}) {
  const app = Fastify({ logger, trustProxy, ...(https ? { https } : {}) });
  const db = openDb(dbPath);
  const hub = createHub();
  const store = createStore(db, { clock, onChange: (seq) => hub.broadcast(seq) });

  app.register(cookie);
  app.register(async (api) => {
    const auth = registerAuth(api, { store, cookieSecure });
    registerRoutes(api, { store, auth, hub });
    api.register(async (watch) => registerWatch(watch, { store, auth })); // Apple Watch page at /watch
  });

  const heartbeat = setInterval(() => hub.heartbeat(), 25_000);
  heartbeat.unref();
  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    hub.closeAll();
    db.close();
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
