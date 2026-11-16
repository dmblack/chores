// argon2id hashing for passwords and PINs, using Node's built-in implementation.
// Stored in the standard PHC string format.

import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 };
const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');

export async function hashSecret(secret) {
  const nonce = randomBytes(16);
  const tag = await argon2Async('argon2id', { message: secret, nonce, ...PARAMS });
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(nonce)}$${b64(Buffer.from(tag))}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function verifySecret(secret, phc) {
  const m = typeof phc === 'string' ? PHC.exec(phc) : null;
  if (!m || typeof secret !== 'string') return false;
  const expected = Buffer.from(m[5], 'base64');
  const tag = Buffer.from(
    await argon2Async('argon2id', {
      message: secret,
      nonce: Buffer.from(m[4], 'base64'),
      memory: Number(m[1]),
      passes: Number(m[2]),
      parallelism: Number(m[3]),
      tagLength: expected.length,
    }),
  );
  return tag.length === expected.length && timingSafeEqual(tag, expected);
}
