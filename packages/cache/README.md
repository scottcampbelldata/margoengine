# @margoengine/cache

Import `margoengine/cache` from the `margoengine` package, or `@margoengine/cache` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Opt-in offline asset cache. Heavy GLB, .bin and texture files are kept in IndexedDB, so repeat visits load them
from disk and the viewer keeps working with bad or no Wi-Fi (a factory floor). `cache.fetch` is fetch-compatible and
every loader takes it as its `fetch` option; apps that do not import this package pay nothing for it. About 3.0 kB
min+gzip, no dependencies, no engine needed. Works in windows, Web Workers and service workers.

```ts
import {AssetCache} from 'margoengine/cache';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

const cache = new AssetCache({
  name: 'plant-viewer',    // IndexedDB database name
  version: '2026.10',      // change it to drop every stored file (a new release of the assets)
  maxBytes: 2 ** 30,       // byte budget; least recently used files are evicted beyond it (default 512 MiB)
  persist: true,           // ask the browser not to evict this origin's storage (main thread only)
  freshness: 'http',       // max-age, else Expires, less Age (default); 'max-age' ignores Expires and Age
});
const line = await loadGLTF(engine, '/line-4.glb', {fetch: cache.fetch});

console.log(cache.stats);         // {hits, revalidated, offline, misses, stored, evicted, errors}
console.log(await cache.usage()); // {bytes, files, quota, usage} (quota/usage from navigator.storage.estimate())
await cache.delete('/line-4.glb'); await cache.clear();
```

For a release that drops only the files that changed, `margoengine/cache/hashed` versions each file by its SHA-256:

```ts
import {AssetCache} from 'margoengine/cache';
import {HashedAssets, hashBytes} from 'margoengine/cache/hashed';

const url = 'https://example.com/helmet.glb';
const manifest = {[url]: await hashBytes(new Uint8Array(4))};   // build it when you publish
const assets = new HashedAssets(new AssetCache({name: 'viewer'}), manifest);
const response = await assets.fetch(url);                        // requests url?v=<hash>, and checks the bytes
await assets.update({[url]: 'hash of the next release'});        // drops the old copy
console.log(response.status);
```

`cachedFetch(url, init)` is the same through a shared default cache (`name: 'margo-assets'`, no version). To make a set
of files available offline ahead of time, fetch them once and wait for the writes:
`await Promise.all(urls.map(u => cache.fetch(u).then(r => r.arrayBuffer()))); await cache.flush();`

## Range requests and streaming

`margoengine/cache/ranges` keeps the byte ranges a file is read in, as aligned blocks, so a streamed model (gltf-pro's
`loadGLTFProgressive`, KTX2 streaming, LAS and COPC point clouds) also loads from disk and offline. Only the blocks a
request covers and does not have go to the network; a request whose blocks are all stored is answered 206 with no
request at all.

```ts
import {RangeCache} from 'margoengine/cache/ranges';

const ranges = new RangeCache({
  name: 'plant-viewer-ranges', // its own IndexedDB database
  version: '2026.10',          // change it to drop every stored block
  maxBytes: 2 ** 30,           // byte budget over all files; least recently used files are evicted (default 512 MiB)
  block: 65536,                // ranges are fetched and stored in whole aligned blocks (default 64 KiB)
});
const head = await ranges.fetch('/line-4.glb', {headers: {Range: 'bytes=0-65535'}});
console.log(head.status, head.headers.get('content-range')); // 206, 'bytes 0-65535/<file size>'
await ranges.flush();
console.log(ranges.stats, await ranges.usage()); // {hits, revalidated, offline, partial, misses, ...}, {bytes, files, blocks}
```

Progressive streaming runs its requests in a worker with the global `fetch`, so it reaches the cache through a service
worker. Route every request for a streamed file to the RangeCache (it also answers whole-file requests from its blocks):

```js
// sw.js (module service worker)
import {RangeCache} from 'margoengine/cache/ranges';
const ranges = new RangeCache({name: 'plant-viewer-ranges', version: '2026.10'});
type FetchEvent = Event & {request: Request; respondWith(response: Promise<Response>): void};
self.addEventListener('fetch', e => {
  const event = e as FetchEvent;
  if (/\.(glb|gltf|bin|ktx2|las|laz|copc)$/i.test(new URL(event.request.url).pathname))
    event.respondWith(ranges.fetch(event.request));
});
```

- A miss is asked for widened to whole blocks (`bytes=10-19` becomes `bytes=0-65535`); gltf-pro's 256 KB requests are
  whole blocks already. A request needing blocks that are not stored asks for each run of adjacent missing blocks once.
  A server that ignores `Range` answers 200: the whole file is stored and the request is answered 206 from it.
- Stored blocks are revalidated once per RangeCache with a one-byte conditional request (`Range: bytes=0-0` with
  `If-None-Match` / `If-Modified-Since`) unless `Cache-Control: max-age` holds. A response with another ETag,
  Last-Modified or size drops every block of the file and the request is asked again, so blocks of two versions are
  never mixed. Offline, failing or past `timeout` (default 5 s), stored blocks are served (`stats.offline`); a request
  needing a block never fetched fails as the network does.
- A request without `Range` is answered 200 from the blocks (fetching only the missing ones), and a 200 download is
  stored as blocks. Multi-range requests, non-GET and non-HTTP requests, `no-store` and error answers pass through.
- `version` or `block` changed: every block is dropped. `delete(url)`, `clear()`, `dispose()` and `using` work as in
  AssetCache. Without IndexedDB every request goes to the network.

## Loaders

| Loader | Option | Worker entry with `fetch` |
| --- | --- | --- |
| gltf-pro `loadGLTF`, `parseGLTFAsync` | `fetch` (file, external .bin and images) | `loadGLTFInWorker` runs on the main thread (a function cannot move to the worker); for a GLB use `parseGLTFInWorker(engine, await (await cache.fetch(url)).arrayBuffer())` to keep parsing in the worker |
| fbx `loadFBX`, `parseFBX`, `convertFBX` | `fetch` (file and external textures) | `loadFBXInWorker` / `parseFBXInWorker` run on the main thread; `parseFBXInWorker(engine, bytes)` without `fetch` keeps the worker for embedded textures |
| usdz `loadUSDZ` | `fetch` | `loadUSDZInWorker` downloads through `fetch` here and parses in the worker |
| loaders `fetchBytes`, `load` | `fetch` (already existed) | `parse*InWorker(bytes)` |

The cache itself also works inside your own worker (`new AssetCache(...)` there opens the same database).

## Loading manager

`@margoengine/cache/manager` is a separate entry (about 2 kB gzip, no IndexedDB code) with `LoadingManager`: one
progress, error and abort source for every loader. `manager.fetch` is fetch-compatible, so it goes in the same `fetch`
option as `cache.fetch`, and every file a loader requests through it counts as one item: the model and also the
external buffers, `mtllib` files and textures the loader resolves next to it.

```ts
import {AssetCache} from 'margoengine/cache';
import {LoadingManager} from 'margoengine/cache/manager';
import {loadGLTF} from 'margoengine/gltf-pro';
import {loadOBJ} from 'margoengine/loaders/mtl';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const dropped = new Map<string, File>(); // filled by your drop handler: files dropped on the page, by name

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
  const file = dropped.get(new URL(url, location.href).pathname.split('/').pop() ?? '');
  return file ? URL.createObjectURL(file) : url;
});
const [mug, chair] = await Promise.all([
  loadGLTF(engine, '/models/mug_full.gltf', {fetch: manager.fetch}), // its .bin and .png go through the manager too
  loadOBJ(engine, '/models/chair.obj', {fetch: manager.fetch}),
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
- Hit: served without a request while the file is fresh; otherwise revalidated once per AssetCache (one
  per page load in practice) with `If-None-Match` / `If-Modified-Since`. 304: served from the cache. 200: replaces
  the stored copy. Network error, any other status, or no answer within `timeout` (default 5 s): the stored copy is
  served (`stats.offline`). `navigator.onLine === false` skips the request. Aborting your own `signal` still rejects.
- Fresh (`freshness: 'http'`, the default, as RFC 9111 has a private cache do): for `Cache-Control: max-age`, else
  `Expires` minus `Date`, less the age the file already had when it arrived: the larger of its `Age` header plus the
  request's round trip and how far its `Date` lies behind the local clock. A 304 refreshes it the same way.
  `no-cache`, no lifetime, an invalid `Expires` (such as `0`) or a file already older than its lifetime means
  "revalidate". `s-maxage` is for shared caches and is ignored. `freshness: 'max-age'` uses `max-age` alone and
  ignores `Expires` and `Age`, as before 2026-11-07. `RangeCache` computes freshness as `'http'` does.
- `version`: the database stores the version it was filled with; opening with another one deletes every file.
- Range requests (`Range: bytes=a-b`, `a-`, `-n`): a hit is answered 206 from the stored whole file (416 when
  unsatisfiable; a multi-range request gets the whole file). A miss goes to the network unchanged and downloads the
  whole file once in the background, so the next visit (or the offline one) has it. Cold, that costs the range bytes
  plus the whole file. To store only the ranges read, use `margoengine/cache/ranges` (above).

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
`dist/workers/gltf.js` or a decoder runtime) to start offline, add a service worker. The same class works there and
then also covers loads made inside workers:

```js
// sw.js (module service worker)
import {AssetCache} from 'margoengine/cache';
const cache = new AssetCache({name: 'plant-viewer', version: '2026.10', maxBytes: 2 ** 30});
type FetchEvent = Event & {request: Request; respondWith(response: Promise<Response>): void};
self.addEventListener('fetch', e => {
  const event = e as FetchEvent;
  if (/\.(glb|gltf|bin|ktx2|png|jpg|webp|stl|wasm|js)$/i.test(new URL(event.request.url).pathname))
    event.respondWith(cache.fetch(event.request));
});
```

A dedicated PWA tool (Workbox) is a fine alternative for the app shell; keep model files in AssetCache for the byte
budget and revalidation.

## Vary, credentials and signed-in users

By default an entry is keyed by its URL, so one URL is one stored file. When the content depends on the request
(language, encoding, an `Authorization` token, a signed-in user), pass `keys: varyKeys()` from
`margoengine/cache/vary`, and each such request gets its own entry:

```ts
import {AssetCache} from 'margoengine/cache';
import {varyKeys} from 'margoengine/cache/vary';

let user = 'guest'; // set it from your sign-in; a page cannot read the cookies a request sends
const cache = new AssetCache({
  name: 'portal',
  keys: varyKeys({
    partition: () => user,       // entries of one user are never served to another (default '')
    headers: ['authorization'],  // request headers that always split entries (default ['authorization'])
  }),
});
const strings = await cache.fetch('/strings.json', {headers: {'Accept-Language': 'fr'}});
console.log(strings.status);
```

- The key covers whether the request sends credentials (`credentials: 'include'`, or `'same-origin'` to the page's own
  origin), the `partition`, the `headers` values and the values of the request headers the stored response's `Vary`
  names (RFC 9111 section 4.1). Values go into keys as SHA-256 hashes: no token or user id is written to storage.
- Each URL and credential set remembers the last `Vary` it was answered with; after a server changes its `Vary`, the
  entries stored under the old one are no longer found and are evicted in time. `Vary: *` is never stored.
- `delete(url)` removes every entry of the URL. Revalidation and the background fill of a range miss send the request's
  own headers, so they land in the same entry. `varyNames(value)` parses a `Vary` value.
- `HashedAssets` and `LoadingManager` work on top unchanged. `RangeCache` (above) is keyed by URL only.

## Eviction index for big caches

By default each write reads every stored file's metadata (not the bytes) to find what to evict: fine for thousands
of files. For tens of thousands (map tiles), pass `eviction: evictionIndex()` from `margoengine/cache/eviction`:
an IndexedDB index on last use and a running byte and file total, kept in the same transaction as every write, so a
write reads the totals and only the files it evicts.

```ts
import {AssetCache} from 'margoengine/cache';
import {evictionIndex} from 'margoengine/cache/eviction';

const tiles = new AssetCache({name: 'map-tiles', maxBytes: 2 ** 30, eviction: evictionIndex()});
const tile = await tiles.fetch('/tiles/12/2048/1361.png');
console.log(tile.status, await tiles.usage()); // usage() reads the totals too: {bytes, files, ...}
```

- Same eviction as the default: least recently used first, never the file being written, a file over `maxBytes` not
  stored, and on `QuotaExceededError` as many more bytes as the new file needs, then one retry.
- It moves the database to IndexedDB version 2. An existing database gets the index and its totals once, on the first
  open. After that, open it with the index every time: an AssetCache without it cannot open a version 2 database and
  goes to the network. Use a new `name` to go back.
- Works with `keys: varyKeys()`, `HashedAssets` and `LoadingManager`.

## Asset bundles with dependencies

`margoengine/cache/bundles` loads a level and the shared assets it needs as one unit. A manifest names each bundle's
files with their SHA-256 and the bundles it depends on; files are stored by content hash (through `HashedAssets`), so a
file two bundles share is downloaded and stored once, and a new release downloads only the files whose hash changed.

```ts
import {AssetCache} from 'margoengine/cache';
import {AssetBundles} from 'margoengine/cache/bundles';
import {hashBytes} from 'margoengine/cache/hashed';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

// Build the manifest when you publish; here it is made from the files themselves.
const hash = async (url: string) => hashBytes(await (await fetch(url)).arrayBuffer());
const manifest = {
  version: '2026.11',
  bundles: {
    shared: {files: {'/shared/rock.glb': await hash('/shared/rock.glb')}},
    level1: {files: {'/level1/map.glb': await hash('/level1/map.glb')}, deps: ['shared']},
  },
};
const bundles = new AssetBundles(new AssetCache({name: 'game'}), manifest);
await bundles.load('level1', {onProgress: ({loaded, total}) => console.log(`${loaded}/${total} files`)});
const level = await loadGLTF(engine, '/level1/map.glb', {fetch: bundles.fetch}); // offline from now on
const {changed} = await bundles.update(manifest); // the next release's manifest: [] here, nothing changed
console.log(level.bounds, changed);
```

- `load(name, {signal, onProgress, concurrency})` fetches (or finds stored) every file of the bundle and its
  dependencies, dependencies first and 4 at a time by default, checks each against its hash and waits for the cache
  writes. A file with other bytes (MargoError `'failed'`, its copy dropped) or an HTTP error status fails the load;
  files already stored stay stored.
- `update(manifest)` drops the stored files whose hash changed or that are gone and returns `{dropped, changed}`:
  the bundles whose files, or whose dependencies' files, changed. An invalid manifest throws and the old one stays.
- `order(name)` and `files(name)` list what a load covers. Relative file URLs resolve against `base` (default the
  page). A missing dependency, a cycle, one URL with two hashes or a hash that is not SHA-256 hex throws a TypeError.
- `bundles.fetch` answers a listed file from its hashed copy, so loaders resolve a .gltf's buffers and images through
  it; unlisted URLs pass through to the cache.

## Prefetching the next level

`margoengine/cache/prefetch` fetches the files the app will need next (the next level, the area ahead) in idle time,
highest priority first and a few at a time, so they are in the cache before they are asked for. `throttle` caps the
bandwidth it takes.

```ts
import {AssetCache} from 'margoengine/cache';
import {Prefetcher, throttle} from 'margoengine/cache/prefetch';

const cache = new AssetCache({name: 'game'}); // the app's own loads, at full speed
// Prefetching goes through a second AssetCache on the same database, with its network capped at 2 MB/s.
const background = new AssetCache({name: 'game', fetch: throttle(fetch, {bytesPerSecond: 2_000_000})});
const prefetch = new Prefetcher({
  fetch: background.fetch, // so every prefetched file is stored
  concurrency: 2,          // files at once (default 2)
  idleTimeout: 2000,       // longest wait for idle time before a request starts anyway, ms (default 2000)
});

const next = prefetch.add(['/level2/map.glb', '/level2/props.glb'], {group: 'level2', priority: 1});
prefetch.add({url: '/level2/boss.glb', priority: 5, group: 'level2'}); // goes first
await prefetch.hold(cache.fetch('/level1/map.glb')); // a foreground load: no new prefetch starts until it ends
console.log(await next, prefetch.stats); // [{url, status: 'done', bytes}, ...], {queued, active, done, ...}
prefetch.cancel('level2'); // the player turned back: drop what waits, abort what is in flight
```

- Each request starts in an idle callback (`requestIdleCallback`; the next task where there is none, as in workers),
  so prefetching does not compete with a frame. `idle: false` starts them at once.
- `add` resolves when its files have ended, each `{url, status: 'done' | 'failed' | 'cancelled', bytes, error?}`; an
  HTTP error status fails with MargoError `'failed'`. A URL is fetched once per Prefetcher: adding it again while it
  waits only raises its priority; a cancelled one may be added again.
- `pause()` and `resume()`, `hold(promise)` for foreground loads, `settle()` to wait for the queue, `dispose()` (or
  `using`, or the `signal` option) to cancel everything.
- `throttle(fetch, {bytesPerSecond, burst})` reads response bodies no faster than the rate, over every request made
  through it; the browser's buffers and TCP flow control then slow the download itself. Give it to the prefetching
  AssetCache only, as above, so the app's own loads keep the full bandwidth.

## Limits

- Keyed by URL unless `keys: varyKeys()` is set (above); `RangeCache` is keyed by URL only.
- Cross-origin files: `ETag` is readable only when the server exposes it (`Access-Control-Expose-Headers: ETag`);
  `Last-Modified` is always readable. Without either, a stale file is downloaded again on each visit (offline still
  works). `Age` and `Date` are not CORS-safelisted: unless the server exposes them, a cross-origin file is taken as
  new when it arrives and `Expires` is counted from the local clock.
- A miss is read fully before the loader gets it (all Margo loaders read whole files anyway).
- Eviction reads every entry's metadata (not the bytes) before each write unless `eviction: evictionIndex()` is set
  (above): fine for thousands of files.
- Prefetcher and throttle: proved in Node with stand-in servers and a stand-in `requestIdleCallback`; not yet run in a
  browser. `throttle` paces how fast bodies are read, so the bytes already in the browser's buffers when the limit
  applies arrive at full speed.
- RangeCache: proved in Node with gltf-pro's real streaming code, an in-memory IndexedDB and a stand-in server; not yet
  run in a browser or service worker, and not timed. Eviction reads every file's record (one per file, not per block)
  before each write. Two requests in flight at once that share a block both fetch it (it is stored once).
- Measured in a real browser (DamagedHelmet, the earlier test model, and a 62 MB GLB, online, throttled and DevTools offline):
  `examples/package-benchmarks/cache/offline-gpu.mjs`, results in `examples/package-benchmarks/cache/results.json`.
