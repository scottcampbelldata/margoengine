# @margoengine/cache

Opt-in offline asset cache. Heavy GLB, .bin, texture and STEP files are kept in IndexedDB, so repeat visits load them
from disk and the viewer keeps working with bad or no Wi-Fi (a factory floor). `cache.fetch` is fetch-compatible and
every loader takes it as its `fetch` option; apps that do not import this package pay nothing for it. About 2.4 kB
min+gzip, no dependencies, no engine needed. Works in windows, Web Workers and service workers.

```ts
import {AssetCache} from '@margoengine/cache';
import {loadGLTF} from '@margoengine/gltf-pro';
import {loadCAD} from '@margoengine/machinery/cad';

const cache = new AssetCache({
  name: 'plant-viewer',    // IndexedDB database name
  version: '2026.10',      // change it to drop every stored file (a new release of the assets)
  maxBytes: 2 ** 30,       // byte budget; least recently used files are evicted beyond it (default 512 MiB)
  persist: true,           // ask the browser not to evict this origin's storage (main thread only)
});
const line = await loadGLTF(engine, '/line-4.glb', {fetch: cache.fetch});
const gearbox = await loadCAD(engine, '/gearbox.step', {fetch: cache.fetch});

console.log(cache.stats);         // {hits, revalidated, offline, misses, stored, evicted, errors}
console.log(await cache.usage()); // {bytes, files, quota, usage} (quota/usage from navigator.storage.estimate())
await cache.delete('/line-4.glb'); await cache.clear();
```

`cachedFetch(url, init)` is the same through a shared default cache (`name: 'margo-assets'`, no version). To make a set
of files available offline ahead of time, fetch them once and wait for the writes:
`await Promise.all(urls.map(u => cache.fetch(u).then(r => r.arrayBuffer()))); await cache.flush();`

## Loaders

| Loader | Option | Worker entry with `fetch` |
| --- | --- | --- |
| gltf-pro `loadGLTF`, `parseGLTFAsync` | `fetch` (file, external .bin and images) | `loadGLTFInWorker` runs on the main thread (a function cannot move to the worker); for a GLB use `parseGLTFInWorker(engine, await (await cache.fetch(url)).arrayBuffer())` to keep parsing in the worker |
| fbx `loadFBX`, `parseFBX`, `convertFBX` | `fetch` (file and external textures) | `loadFBXInWorker` / `parseFBXInWorker` run on the main thread; `parseFBXInWorker(engine, bytes)` without `fetch` keeps the worker for embedded textures |
| usdz `loadUSDZ` | `fetch` | `loadUSDZInWorker` downloads through `fetch` here and parses in the worker |
| machinery `loadCAD` (STL, OBJ, STEP, IGES) | `fetch` | download here, STEP/IGES parsing stays in the OCCT worker |
| loaders `fetchBytes`, `load` | `fetch` (already existed) | `parse*InWorker(bytes)` |

The cache itself also works inside your own worker (`new AssetCache(...)` there opens the same database).

## Loading manager

`@margoengine/cache/manager` is a separate entry (about 2 kB gzip, no IndexedDB code) with `LoadingManager`: one
progress, error and abort source for every loader. `manager.fetch` is fetch-compatible, so it goes in the same `fetch`
option as `cache.fetch`, and every file a loader requests through it counts as one item: the model and also the
external buffers, `mtllib` files and textures the loader resolves next to it.

```ts
import type {EngineKernel} from '@margoengine/core';
import {AssetCache} from '@margoengine/cache';
import {LoadingManager} from '@margoengine/cache/manager';
import {loadGLTF} from '@margoengine/gltf-pro';
import {loadOBJ} from '@margoengine/loaders/mtl';

declare const engine: EngineKernel;
declare const dropped: Map<string, File>; // files dropped on the page, by name

const cache = new AssetCache({name: 'plant-viewer'});
const manager = new LoadingManager({
  fetch: cache.fetch, // optional: count cache hits too (default globalThis.fetch)
  onStart: (url, loaded, total) => console.log(`start ${url} (${loaded}/${total})`),
  onProgress: (url, loaded, total, bytes) =>
    console.log(`${loaded}/${total} files, ${bytes.loaded} of ${bytes.total ?? '?'} bytes`),
  onLoad: () => console.log('all loaded'),
  onError: (url, error) => console.warn(url, error),
});
// Every requested URL, siblings included, goes through the modifier: here a dropped folder's files as blob: URLs.
manager.setURLModifier((url) => {
  const file = dropped.get(new URL(url).pathname.split('/').pop() ?? '');
  return file ? URL.createObjectURL(file) : url;
});
const [model, chair] = await Promise.all([
  loadGLTF(engine, 'https://example.com/models/line-4.gltf', {fetch: manager.fetch}),
  loadOBJ(engine, 'https://example.com/models/chair.obj', {fetch: manager.fetch}),
]);

// Work that does not fetch counts too; manager.signal aborts with the manager.
manager.itemStart('bake');
manager.itemEnd('bake'); // or manager.itemError('bake', error)
manager.abort(); // cancels every request in flight (each reports onError); the manager stays usable
```

- Items and batches: a batch starts when an item starts while none is pending; `onStart` and `onProgress` get the
  batch's finished and started item counts, and `onLoad` fires once when the last one finishes. A failed item (network
  error, HTTP error status, abort, a loader's byte cap) calls `onError` and then counts as done. `manager.loaded`,
  `total`, `pending`, `bytesLoaded` and `bytesTotal` read the same counts.
- Bytes: the response body is passed through one chunk at a time as the loader reads it (no copy, no read-ahead), so
  `onProgress` reports bytes as they stream and every loader's own byte cap still applies. `bytes.itemTotal` and
  `bytes.total` come from Content-Length and are undefined when a response has none (or a compressed body).
- URL modifier: callbacks report the requested URL. When the modifier changes a URL, the response's `url` is the
  requested one, so a loader resolves sibling files against the model's own URL and not against the blob: URL.
  `manager.resolveURL(url)` applies it for your own requests.
- Cache order: `new LoadingManager({fetch: cache.fetch})` counts every request, hits included;
  `new AssetCache({fetch: manager.fetch})` counts only what reaches the network (and the cache's background fills).
- Loaders that run in a worker cannot take a function: with `fetch` they load on the main thread (see the table above).
  `loadOBJ` and `createMTLMaterials` hand their `fetch` to the texture loader, so textures are counted too.

## How a request is answered

- GET over HTTP(S) only; anything else goes straight to the network. Keyed by URL (fragment dropped).
- Miss: network, then the 200 body is stored in the background (`cache.flush()` waits for it). `Cache-Control:
  no-store` and non-200 responses are not stored. A redirected response keeps its final URL, so relative URIs in a
  .gltf still resolve.
- Hit: served without a request while `Cache-Control: max-age` holds; otherwise revalidated once per AssetCache (one
  per page load in practice) with `If-None-Match` / `If-Modified-Since`. 304: served from the cache. 200: replaces
  the stored copy. Network error, any other status, or no answer within `timeout` (default 5 s): the stored copy is
  served (`stats.offline`). `navigator.onLine === false` skips the request. Aborting your own `signal` still rejects.
- `version`: the database stores the version it was filled with; opening with another one deletes every file.
- Range requests (`Range: bytes=a-b`, `a-`, `-n`): a hit is answered 206 from the stored whole file (416 when
  unsatisfiable; a multi-range request gets the whole file). A miss goes to the network unchanged and downloads the
  whole file once in the background, so the next visit (or the offline one) has it. Cold, that costs the range bytes
  plus the whole file.

## Budget, quota and failures

- `maxBytes` (default 512 MiB): before each write the least recently used files are evicted until the new one fits; a
  file larger than `maxBytes` is not stored. Every hit refreshes its file's last-used time.
- Browser quota: a write that fails with `QuotaExceededError` evicts as many more bytes as the new file needs and
  tries once more; if that fails too the file is simply not stored (`stats.errors`). `usage()` reports
  `navigator.storage.estimate()`; `persist: true` calls `navigator.storage.persist()` (the browser may say no).
- No IndexedDB (missing, blocked, some private modes) or any read/write error: every request goes to the network as
  if there were no cache. Loading never fails because of the cache.
- Writes run one at a time; `dispose()` (or `using`) closes the database after them.

## Full offline (service worker)

The asset cache covers model files. For the app itself (HTML, JS, worker scripts such as gltf-pro's
`dist/workers/gltf.js` or the OCCT runtime) to start offline, add a service worker. The same class works there and
then also covers loads made inside workers:

```js
// sw.js (module service worker)
import {AssetCache} from '@margoengine/cache';
const cache = new AssetCache({name: 'plant-viewer', version: '2026.10', maxBytes: 2 ** 30});
self.addEventListener('fetch', event => {
  if (/\.(glb|gltf|bin|ktx2|png|jpg|webp|step|stp|iges|igs|stl|wasm|js)$/i.test(new URL(event.request.url).pathname))
    event.respondWith(cache.fetch(event.request));
});
```

A dedicated PWA tool (Workbox) is a fine alternative for the app shell; keep model files in AssetCache for the byte
budget and revalidation.

## Limits

- Keyed by URL only: no `Vary`, and credentials or request headers do not split entries.
- Cross-origin files: `ETag` is readable only when the server exposes it (`Access-Control-Expose-Headers: ETag`);
  `Last-Modified` is always readable. Without either, a stale file is downloaded again on each visit (offline still
  works). `Expires` and `Age` are ignored; `no-cache` and missing `max-age` mean "revalidate".
- A miss is read fully before the loader gets it (all Margo loaders read whole files anyway).
- Eviction reads every entry's metadata (not the bytes) before each write: fine for thousands of files.
- Measured in a real browser (DamagedHelmet and a 62 MB GLB, online, throttled and DevTools offline):
  `examples/package-benchmarks/cache/offline-gpu.mjs`, results in `examples/package-benchmarks/cache/results.json`.
