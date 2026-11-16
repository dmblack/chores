// Local cache on the iPad (IndexedDB). It can be unavailable or cleared, so
// every call fails soft and the app falls back to memory for the session.

import { del, get, set } from 'idb-keyval';

const memory = new Map();

export async function load(key) {
  try {
    const v = await get(key);
    return v === undefined ? memory.get(key) : v;
  } catch {
    return memory.get(key);
  }
}

export async function save(key, value) {
  memory.set(key, value);
  try {
    await set(key, value);
  } catch {
    // keep the in-memory copy
  }
}

export async function remove(key) {
  memory.delete(key);
  try {
    await del(key);
  } catch {
    // nothing to do
  }
}
