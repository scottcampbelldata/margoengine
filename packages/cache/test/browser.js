// RangeCache and the eviction index on a real browser's IndexedDB and fetch. Run by scripts/test-browser.js, which
// serves the files, counts the requests that reach the server and takes the browser offline between calls.
import { AssetCache } from '../dist/index.js';
import { evictionIndex } from '../dist/eviction.js';
import { RangeCache } from '../dist/ranges.js';

const query = new URLSearchParams(location.search);

/** Records handed out by get, getAll and cursors of the real IndexedDB, as the Node stand-in counts them. */
const counts = { reads: 0 };
for (const proto of [IDBObjectStore.prototype, IDBIndex.prototype])
  for (const [name, records] of [
    ['get', (result) => (result === undefined ? 0 : 1)],
    ['getAll', (result) => result.length],
    ['openCursor', (result) => (result ? 1 : 0)],
  ]) {
    const original = proto[name];
    proto[name] = function (...args) {
      const request = original.apply(this, args);
      request.addEventListener('success', () => (counts.reads += records(request.result)));
      return request;
    };
  }

const hex = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
const read = async (response) => new Uint8Array(await response.arrayBuffer());

/** gltf-pro's progressive streaming code (the half that runs in its worker) with the global fetch answered by `ranges`. */
async function stream(ranges, url) {
  const { GLTFStream } = await import(query.get('stream'));
  const saved = globalThis.fetch;
  globalThis.fetch = ranges.fetch;
  try {
    return await new Promise((resolve, reject) => {
      const s = new GLTFStream(
        new URL(url, location.href),
        (message) => {
          if (message.type === 'doc') queueMicrotask(() => s.setOrder([...s.needs.keys()]));
          if (message.type === 'done') resolve(message.buffers);
          if (message.type === 'error') reject(Object.assign(new Error(message.error.message), message.error));
        },
        new AbortController().signal,
      );
      s.run();
    });
  } finally {
    globalThis.fetch = saved;
  }
}

window.cacheChecks = {
  /** Loads the streaming code, so a later offline call needs no module from the server. */
  async preload() {
    await import(query.get('stream'));
    return true;
  },

  /** Streams `url` through a RangeCache named `name`; the digest of each final buffer, the stats and the usage. */
  async streamRanges(name, url) {
    const ranges = new RangeCache({ name }),
      buffers = await stream(ranges, url);
    await ranges.flush();
    return {
      buffers: await Promise.all(buffers.map((b) => hex(b))),
      stats: { ...ranges.stats },
      usage: await ranges.usage(),
    };
  },

  /** A covered range, then a range half outside what is stored; what each response holds. */
  async rangeOf(name, url, range) {
    const ranges = new RangeCache({ name }),
      response = await ranges.fetch(url, { headers: { Range: range } });
    const body = await read(response);
    await ranges.flush();
    return {
      status: response.status,
      contentRange: response.headers.get('content-range'),
      digest: await hex(body),
      stats: { ...ranges.stats },
    };
  },

  /** a, b, a, c, then a file over the 250-byte budget, with the index: what is evicted and what is left. */
  async evictionOrder(name) {
    const cache = new AssetCache({ name, maxBytes: 250, eviction: evictionIndex() });
    for (const file of ['a', 'b', 'a', 'c', 'huge']) {
      await read(await cache.fetch(`/cache-files/${file}`));
      await cache.flush();
      await tick();
    }
    const usage = await cache.usage();
    const offline = new AssetCache({
        name,
        maxBytes: 250,
        eviction: evictionIndex(),
        fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      }),
      a = await read(await offline.fetch('/cache-files/a')),
      b = await offline.fetch('/cache-files/b').then(
        () => 'served',
        (error) => error.name,
      );
    return { evicted: cache.stats.evicted, usage: { bytes: usage.bytes, files: usage.files }, a: a.length, b };
  },

  /** `count` files of 10 bytes under a 20,000-byte budget, then `extra` more: the records the extra writes read. */
  async evictionReads(name, indexed, count, extra) {
    const cache = new AssetCache({ name, maxBytes: 20_000, ...(indexed && { eviction: evictionIndex() }) });
    for (let i = 0; i < count; i++) await read(await cache.fetch(`/cache-files/tile/${i}`));
    await cache.flush();
    const before = counts.reads;
    for (let i = count; i < count + extra; i++) {
      await read(await cache.fetch(`/cache-files/tile/${i}`));
      await cache.flush();
    }
    const reads = counts.reads - before,
      usage = await cache.usage();
    return { reads, evicted: cache.stats.evicted, files: usage.files, bytes: usage.bytes };
  },
};
window.cacheReady = true;
