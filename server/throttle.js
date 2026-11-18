/**
 * Shared login throttling inside the same atomic storage unit of work as auth.
 * Device and address counters retain the original exponential backoff policy.
 * @module throttle
 */

/**
 * Bind throttle operations to an isolated transaction.
 * @param {object} tx - Portable unit of work.
 * @param {object} [options] - Backoff parameters.
 * @returns {object} Awaitable wait, miss and clear operations.
 */
export function createThrottle(tx, options = {}) {
  const freeMisses = options.freeMisses ?? 3;
  const baseMs = options.baseMs ?? 1_000;
  const maxMs = options.maxMs ?? 15 * 60_000;
  const forgetAfterMs = options.forgetAfterMs ?? 60 * 60_000;
  return {
    /** @param {string[]} keys - Device/address keys. @param {number} now - Time in ms. @returns {Promise<number>} Remaining delay. */
    async waitMs(keys, now) {
      let wait = 0;
      for (const key of keys) {
        const row = await tx.throttle(key);
        if (row?.locked_until > now) wait = Math.max(wait, row.locked_until - now);
      }
      return wait;
    },
    /** @param {string[]} keys - Device/address keys. @param {number} now - Time in ms. @returns {Promise<number>} New delay. */
    async recordMiss(keys, now) {
      let wait = 0;
      for (const key of keys) {
        const row = await tx.throttle(key);
        const misses = row && now - row.last_miss < forgetAfterMs ? row.misses + 1 : 1;
        const delay = misses >= freeMisses ? Math.min(baseMs * 2 ** (misses - freeMisses), maxMs) : 0;
        tx.throttles.set(key, { key, misses, last_miss: now, locked_until: now + delay });
        wait = Math.max(wait, delay);
      }
      return wait;
    },
    /** @param {string[]} keys - Counter identities. @returns {void} */
    clear(keys) { for (const key of keys) tx.throttles.set(key, null); },
  };
}
