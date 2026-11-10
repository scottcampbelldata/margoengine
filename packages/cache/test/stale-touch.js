// The same delayed-hit races run against the CPU stand-in and real browser IndexedDB.
import { AssetCache } from '../dist/index.js';
import { evictionIndex } from '../dist/eviction.js';
import { base, bytes, read, server } from './support.js';

export async function staleTouch(mode, indexed) {
  const files = { '/a': { body: bytes(100), etag: '"a"' }, '/b': { body: bytes(100, 2), etag: '"b"' } };
  const network = server(files),
    gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  let hold = false;
  const options = {
    name: `stale-touch-${mode}-${indexed}`,
    maxBytes: 150,
    ...(indexed && { eviction: evictionIndex() }),
    fetch: async (input, init) => {
      const request = new Request(input, init),
        response = await network(request);
      if (hold && request.url === base + 'a' && request.headers.has('if-none-match')) {
        entered.resolve();
        await gate.promise;
      }
      return response;
    },
  };
  const warm = new AssetCache(options);
  await read(await warm.fetch(base + 'a'));
  warm.dispose();
  await warm.flush();
  const cache = new AssetCache(options);
  hold = true;
  const pending = cache.fetch(base + 'a');
  const usage = async () => {
    const { bytes, files } = await cache.usage();
    return { bytes, files };
  };
  try {
    await entered.promise;
    if (mode === 'evict') {
      await read(await cache.fetch(base + 'b'));
      await cache.flush();
    } else {
      files['/a'] = {
        body: bytes(80, 9),
        etag: '"new"',
        headers: { 'content-type': 'application/new', 'cache-control': 'max-age=600' },
      };
      const writer = new AssetCache({ ...options, fetch: network });
      await read(await writer.fetch(base + 'a'));
      writer.dispose();
      await writer.flush();
    }
    const before = await usage();
    hold = false;
    gate.resolve();
    const oldBody = await read(await pending);
    await cache.flush();
    const after = await usage();
    if (mode === 'evict') {
      await read(await cache.fetch(base + 'a'));
      await cache.flush();
      network.offline = true;
      const b = await cache.fetch(base + 'b').then(
        () => 'served',
        (error) => error.name,
      );
      return { before, after, old: [oldBody.length, oldBody[0]], b, restored: await usage() };
    }
    network.offline = true;
    const observer = new AssetCache({ ...options, fetch: network });
    try {
      const response = await observer.fetch(base + 'a'),
        body = await read(response);
      return {
        before,
        after,
        old: [oldBody.length, oldBody[0]],
        current: [body.length, body[0]],
        etag: response.headers.get('etag'),
        type: response.headers.get('content-type'),
      };
    } finally {
      observer.dispose();
      await observer.flush();
    }
  } finally {
    hold = false;
    gate.resolve();
    cache.dispose();
    await cache.flush();
  }
}
