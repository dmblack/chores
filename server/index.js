// Starts the chores server on the home network.
//
//   PORT=3000 HOST=0.0.0.0 DB_PATH=./data/chores.db node server/index.js
//
// HTTPS (needed for the iPads to install it and work offline):
//   TLS_CERT=/path/cert.pem TLS_KEY=/path/key.pem node server/index.js

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const https = env.TLS_CERT && env.TLS_KEY ? { cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) } : null;

const app = buildApp({
  dbPath: resolve(env.DB_PATH ?? join(root, 'data', 'chores.db')),
  staticDir: join(root, 'client', 'dist'),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : !!https,
  trustProxy: env.TRUST_PROXY === 'true',
  https,
  logger: { level: env.LOG_LEVEL ?? 'info' },
});

const port = Number(env.PORT ?? (https ? 3443 : 3000));
await app.listen({ port, host: env.HOST ?? '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
