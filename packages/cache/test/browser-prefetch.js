import { AssetCache } from '../dist/index.js';
import { Prefetcher, throttle } from '../dist/prefetch.js';

export async function prefetchProof(name) {
  const network = throttle(fetch, { bytesPerSecond: 8 * 2 ** 20, burst: 0 });
  const cache = new AssetCache({ name, fetch: network });
  const order = [];
  const prefetch = new Prefetcher({
    concurrency: 1,
    fetch: async (...args) => {
      order.push(new URL(args[0], location.href).pathname);
      return cache.fetch(...args);
    },
  });
  prefetch.pause();
  const cancelled = prefetch.add({ url: '/cache-files/never', group: 'cancelled' });
  prefetch.cancel('cancelled');
  const queued = prefetch.add([
    { url: '/cache-files/a', priority: 0 },
    { url: '/cache-files/b', priority: 1 },
    { url: '/cache-files/c', priority: 2 },
    { url: '/cache-files/chair.glb', priority: -1 },
  ]);
  const duplicate = prefetch.add('/cache-files/a');
  const paused = { ...prefetch.stats, started: order.length };
  prefetch.resume();
  try {
    const outcomes = await queued;
    await prefetch.settle();
    await cache.flush();
    const stored = new AssetCache({
      name,
      fetch: async () => {
        throw new Error('prefetched bytes were not persisted');
      },
    });
    try {
      const body = await (await stored.fetch('/cache-files/chair.glb')).arrayBuffer();
      return {
        paused,
        order,
        outcomes,
        duplicate: await duplicate,
        cancelled: await cancelled,
        stats: prefetch.stats,
        sha: await digest(body),
        usage: await cache.usage(),
        idleAPI: typeof requestIdleCallback,
      };
    } finally {
      stored.dispose();
    }
  } finally {
    prefetch.dispose();
    cache.dispose();
  }
}

const digest = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');

// Observe rate arithmetic with real network bodies and a controlled clock. No elapsed-time budget is asserted.
export async function throttleProof() {
  const clock = Object.getOwnPropertyDescriptor(performance, 'now');
  const timer = globalThis.setTimeout,
    delays = [],
    chunks = [];
  Object.defineProperty(performance, 'now', { configurable: true, value: () => 0 });
  globalThis.setTimeout = (callback, delay, ...args) => {
    delays.push(delay);
    return timer(callback, 0, ...args);
  };
  const network = throttle(
    async (...args) => {
      const response = await fetch(...args),
        reader = response.body.getReader();
      return new Response(
        new ReadableStream(
          {
            async pull(controller) {
              const next = await reader.read();
              if (next.done) controller.close();
              else {
                chunks.push(next.value.byteLength);
                controller.enqueue(next.value);
              }
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: response.headers },
      );
    },
    { bytesPerSecond: 1024, burst: 0 },
  );
  try {
    const values = [];
    for (const path of ['a', 'b'])
      values.push([...new Uint8Array(await (await network(`/cache-files/${path}`)).arrayBuffer())]);
    let total = 0;
    return {
      delays,
      expected: chunks.map((bytes) => {
        total += bytes;
        return (total * 1000) / 1024;
      }),
      values,
    };
  } finally {
    globalThis.setTimeout = timer;
    if (clock) Object.defineProperty(performance, 'now', clock);
    else delete performance.now;
  }
}
