/**
 * Validated listen and edge settings for local Node and Lambda Web Functions.
 * Web deployments require external persistence and explicit edge credentials.
 * @module runtime
 */
import { validateEdgeOptions } from './edge.js';

/**
 * Resolve deployment settings without contacting AWS or opening a database.
 * @param {NodeJS.ProcessEnv|object} [env] - Process environment.
 * @returns {object} Listen address and buildApp edge options.
 */
export function runtimeConfigFromEnv(env = process.env) {
  const web = !!env.AWS_LAMBDA_HTTP_ENDPOINT;
  const tls = !!env.TLS_CERT && !!env.TLS_KEY;
  if (!!env.TLS_CERT !== !!env.TLS_KEY) throw new Error('TLS_CERT and TLS_KEY must be set together.');
  const edge = { originSecret: env.APP_ORIGIN_SECRET, bootstrapToken: env.BOOTSTRAP_TOKEN, publicOrigin: env.PUBLIC_ORIGIN };
  validateEdgeOptions(edge);
  let host = env.HOST ?? '0.0.0.0';
  let port = Number(env.PORT ?? (tls ? 3443 : 3000));
  if (web) {
    if (env.STORAGE_BACKEND !== 'dynamodb') throw new Error('Lambda Web Functions require STORAGE_BACKEND=dynamodb.');
    if (!edge.originSecret || !edge.bootstrapToken || !edge.publicOrigin) {
      throw new Error('Lambda Web Functions require APP_ORIGIN_SECRET, BOOTSTRAP_TOKEN and PUBLIC_ORIGIN.');
    }
    if (tls) throw new Error('Lambda Web Functions terminate TLS at the AWS endpoint; leave TLS_CERT and TLS_KEY unset.');
    const match = /^(\[[\da-fA-F:]+\]|[a-zA-Z\d.-]+):(\d+)$/.exec(env.AWS_LAMBDA_HTTP_ENDPOINT);
    if (!match) throw new Error('AWS_LAMBDA_HTTP_ENDPOINT must contain the AWS-provided host:port address.');
    host = match[1].replace(/^\[|\]$/g, '');
    port = Number(match[2]);
  }
  if (!Number.isInteger(port) || port < (web ? 1 : 0) || port > 65535) throw new Error('The listening port must be an integer between 1 and 65535.');
  return { ...edge, host, port,
    cookieSecure: web || (env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : tls),
    trustProxy: web || env.TRUST_PROXY === 'true' };
}
