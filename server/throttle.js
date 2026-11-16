// Growing delay after repeated wrong PINs/passwords. A PIN has no username to
// narrow the guess, so misses are counted per device AND per network address;
// clearing cookies on the iPad does not reset the address counter.

export function createThrottle(db, opts = {}) {
  const freeMisses = opts.freeMisses ?? 3;
  const baseMs = opts.baseMs ?? 1_000;
  const maxMs = opts.maxMs ?? 15 * 60_000;
  const forgetAfterMs = opts.forgetAfterMs ?? 60 * 60_000;

  const get = db.prepare('SELECT * FROM login_throttle WHERE key = ?');
  const put = db.prepare(
    `INSERT INTO login_throttle (key, misses, last_miss, locked_until) VALUES (@key, @misses, @last_miss, @locked_until)
     ON CONFLICT(key) DO UPDATE SET misses = @misses, last_miss = @last_miss, locked_until = @locked_until`,
  );
  const del = db.prepare('DELETE FROM login_throttle WHERE key = ?');

  /** Milliseconds the caller must still wait (0 = go ahead). */
  function waitMs(keys, now) {
    let wait = 0;
    for (const key of keys) {
      const row = get.get(key);
      if (row && row.locked_until > now) wait = Math.max(wait, row.locked_until - now);
    }
    return wait;
  }

  function recordMiss(keys, now) {
    let wait = 0;
    for (const key of keys) {
      const row = get.get(key);
      const misses = row && now - row.last_miss < forgetAfterMs ? row.misses + 1 : 1;
      const delay = misses >= freeMisses ? Math.min(baseMs * 2 ** (misses - freeMisses), maxMs) : 0;
      put.run({ key, misses, last_miss: now, locked_until: now + delay });
      wait = Math.max(wait, delay);
    }
    return wait;
  }

  function clear(keys) {
    for (const key of keys) del.run(key);
  }

  return { waitMs, recordMiss, clear };
}
