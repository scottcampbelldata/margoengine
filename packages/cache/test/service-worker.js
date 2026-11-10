import { RangeCache } from '../dist/ranges.js';
import { prefetchProof, throttleProof } from './browser-prefetch.js';

const ranges = new RangeCache({ name: 'service-worker-ranges', block: 4096 });
const instance = crypto.randomUUID();
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  const work = (async () => {
    try {
      const result =
        event.data === 'prefetch'
          ? await prefetchProof('service-worker-prefetch')
          : event.data === 'identity'
            ? instance
            : event.data === 'flush'
              ? (await ranges.flush(), await ranges.usage())
              : await throttleProof();
      event.ports[0].postMessage({ result });
    } catch (error) {
      event.ports[0].postMessage({ error: error.stack ?? String(error) });
    }
  })();
  event.waitUntil(work);
});
self.addEventListener('fetch', (event) => {
  if (!new URL(event.request.url).pathname.startsWith('/packages/cache/test/sw-files/')) return;
  const response = ranges.fetch(event.request);
  event.respondWith(response);
  event.waitUntil(response.then(() => ranges.flush()));
});
