/**
 * A keyed map persisted to chrome.storage in hashed buckets, so saving after a
 * batch rewrites only the buckets that batch touched rather than one key
 * holding every row.
 */

const BUCKETS = 32;

export function bucketOf(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % BUCKETS;
}

export function createRowStore(prefix) {
  const rows = new Map();
  const dirty = new Set();
  const bucketKeys = Array.from({ length: BUCKETS }, (_, bucket) => `${prefix}:${bucket}`);
  const metaKey = `${prefix}:meta`;
  let indexedAt = 0;
  let loaded = false;

  return {
    prefix,
    async load() {
      if (loaded) return;
      const stored = await chrome.storage.local.get([...bucketKeys, metaKey]);
      for (const key of bucketKeys) {
        for (const [rowKey, row] of Object.entries(stored[key] || {})) rows.set(rowKey, row);
      }
      indexedAt = Number(stored[metaKey]?.indexedAt) || 0;
      loaded = true;
    },
    get: (key) => rows.get(key),
    has: (key) => rows.has(key),
    entries: () => rows.entries(),
    keys: () => rows.keys(),
    get size() { return rows.size; },
    get indexedAt() { return indexedAt; },
    set(key, row) {
      rows.set(key, row);
      dirty.add(bucketOf(key));
    },
    delete(key) {
      if (rows.delete(key)) dirty.add(bucketOf(key));
    },
    /** Swap in a freshly indexed set of rows. */
    replace(next) {
      rows.clear();
      for (const [key, row] of next) rows.set(key, row);
      for (let bucket = 0; bucket < BUCKETS; bucket++) dirty.add(bucket);
      indexedAt = Date.now();
    },
    async persist() {
      if (dirty.size === 0) return;
      const buckets = Array.from({ length: BUCKETS }, () => ({}));
      for (const [key, row] of rows) buckets[bucketOf(key)][key] = row;
      const writes = { [metaKey]: { indexedAt } };
      for (const bucket of dirty) writes[bucketKeys[bucket]] = buckets[bucket];
      dirty.clear();
      await chrome.storage.local.set(writes);
    },
    async remove() {
      rows.clear();
      dirty.clear();
      indexedAt = 0;
      await chrome.storage.local.remove([...bucketKeys, metaKey]);
    },
  };
}
