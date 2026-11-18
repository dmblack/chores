/**
 * Start the same HTTP application locally or on AWS Lambda Web Functions.
 * Lambda supplies its listen address and terminates upstream HTTPS itself.
 * @module server/index
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { storageConfigFromEnv } from './storage/index.js';
import { runtimeConfigFromEnv } from './runtime.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const { port, host, ...runtime } = runtimeConfigFromEnv(env);
const https = env.TLS_CERT && env.TLS_KEY ? { cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) } : null;

const app = buildApp({
  storage: storageConfigFromEnv(env, join(root, 'data', 'chores.db')),
  staticDir: join(root, 'client', 'dist'),
  ...runtime,
  https,
  logger: { level: env.LOG_LEVEL ?? 'info',
    // Signed proxy requests can carry temporary AWS session tokens; redact them with app credentials.
    redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-amz-security-token"]',
      'req.headers["x-app-origin-secret"]', 'req.headers["x-bootstrap-token"]'] },
});

await app.listen({ port, host });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
