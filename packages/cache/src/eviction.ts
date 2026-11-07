import type { AssetCacheEntry, AssetCacheEviction } from './index.js';

const USED = 'used',
  TOTAL = '\0bytes',
  FILES = '\0files';
const isEntry = (value: unknown): value is AssetCacheEntry =>
  typeof (value as AssetCacheEntry | null)?.size === 'number';
const count = (value: unknown) => (typeof value === 'number' ? value : 0);

/**
 * Eviction for caches of tens of thousands of files (map tiles): an IndexedDB index on each entry's last use and a
 * running byte and file total, kept in the same transaction as every write. A write reads the total, the entry it
 * replaces and, in last-use order, only the entries it evicts, where the default reads every entry's metadata first.
 * Pass it as AssetCache's `eviction`. It moves the database to version 2; opening an existing database builds the index
 * and the totals once. A database moved to version 2 then needs the index every time: an AssetCache without it cannot
 * open the database and goes to the network.
 */
export function evictionIndex(): AssetCacheEviction {
  return {
    version: 2,
    upgrade(meta, old) {
      if (old >= 2) return;
      meta.createIndex(USED, USED);
      // Files stored before the index: count them once.
      meta.getAll().onsuccess = (event) => {
        const entries = ((event.target as IDBRequest<unknown[]>).result ?? []).filter(isEntry);
        meta.put(
          entries.reduce((sum, e) => sum + e.size, 0),
          TOTAL,
        );
        meta.put(entries.length, FILES);
      };
    },
    write(meta, data, entry, blob, limit, squeeze, done) {
      const total = meta.get(TOTAL),
        files = meta.get(FILES),
        old = meta.get(entry.url);
      old.onsuccess = () => {
        const replaced = isEntry(old.result) ? old.result.size : 0;
        let others = count(total.result) - replaced,
          stored = count(files.result) - (isEntry(old.result) ? 1 : 0),
          evicted = 0;
        const room = squeeze ? Math.min(limit, others) : limit,
          cursor = meta.index(USED).openCursor();
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (at && others + entry.size > room) {
            if (at.primaryKey !== entry.url && isEntry(at.value)) {
              others -= at.value.size;
              stored--;
              evicted++;
              data.delete(at.primaryKey);
              at.delete();
            }
            at.continue();
            return;
          }
          data.put(blob, entry.url);
          meta.put(entry, entry.url);
          meta.put(others + entry.size, TOTAL);
          meta.put(stored + 1, FILES);
          done(evicted);
        };
      };
    },
    remove(meta, data, key) {
      const old = meta.get(key),
        total = meta.get(TOTAL),
        files = meta.get(FILES);
      files.onsuccess = () => {
        if (isEntry(old.result)) {
          meta.put(count(total.result) - old.result.size, TOTAL);
          meta.put(count(files.result) - 1, FILES);
        }
        meta.delete(key);
        data.delete(key);
      };
    },
    usage(meta, done) {
      const total = meta.get(TOTAL),
        files = meta.get(FILES);
      files.onsuccess = () => done(count(total.result), count(files.result));
    },
  };
}
