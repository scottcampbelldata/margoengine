// Module worker for offline.html: the same AssetCache (same IndexedDB database) used from a Web Worker. Started while
// online (its own script must load), then asked for files, also while the page is offline.
import { AssetCache } from '/packages/cache/dist/index.js';

self.onmessage = async ({ data: { url, name } }) => {
  const cache = new AssetCache({ name, version: 'check-1', maxBytes: 2 ** 30 });
  try {
    const bytes = await (await cache.fetch(url)).arrayBuffer(),
      hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    self.postMessage({
      bytes: bytes.byteLength,
      sha256: [...hash].map((b) => b.toString(16).padStart(2, '0')).join(''),
      stats: { ...cache.stats },
      onLine: navigator.onLine,
    });
  } catch (error) {
    self.postMessage({ error: String(error) });
  } finally {
    cache.dispose();
  }
};
self.postMessage('ready');
