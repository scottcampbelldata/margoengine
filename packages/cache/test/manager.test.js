import test from 'node:test';
import assert from 'node:assert/strict';
import { Texture } from '@margoengine/materials';
import { LoadingManager } from '../dist/manager.js';
import { AssetCache } from '../dist/index.js';
import { fetchBytes, LoaderError } from '../../loaders/dist/index.js';
import { loadOBJ } from '../../loaders/dist/mtl.js';
import { loadGLTF } from '../../gltf/dist/index.js';

const bytes = (n, fill = 1) => new Uint8Array(n).fill(fill);
const encode = (text) => new TextEncoder().encode(text);

/** A Response whose body streams `chunks` one read at a time, with Content-Length unless `length` is false. */
function streamed(chunks, { length = true, status = 200, url = '' } = {}) {
  let i = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++]);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const size = chunks.reduce((sum, c) => sum + c.byteLength, 0),
    response = new Response(body, { status, headers: length ? { 'content-length': String(size) } : {} });
  if (url) Object.defineProperty(response, 'url', { value: url });
  return response;
}

/** A fake network over `files` (url -> text or bytes) that records each URL and answers 404 for others. */
function network(files, options) {
  const seen = [];
  const fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input.url ?? String(input));
    seen.push(url);
    const file = files[url];
    if (file === undefined) return new Response('missing', { status: 404 });
    const data = typeof file === 'string' ? encode(file) : file;
    return streamed([data.subarray(0, data.length >> 1), data.subarray(data.length >> 1)], { url, ...options });
  };
  return { fetch, seen };
}

/** Records every manager callback as a flat event list. */
function record(manager) {
  const events = [];
  manager.onStart = (url, loaded, total) => events.push(['start', url, loaded, total]);
  manager.onProgress = (url, loaded, total, b) => events.push(['progress', url, loaded, total, { ...b }]);
  manager.onLoad = () => events.push(['load']);
  manager.onError = (url, error) => events.push(['error', url, error]);
  return events;
}

const OBJ = 'mtllib scene.mtl\nusemtl red\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
const MTL = 'newmtl red\nKd 1 0 0\nmap_Kd red.png\n';
const GLTF = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'mesh.bin', byteLength: 12 }] });
const FILES = {
  'https://example.com/models/scene.obj': OBJ,
  'https://example.com/models/scene.mtl': MTL,
  'https://example.com/models/red.png': bytes(8),
  'https://example.com/models/tank.gltf': GLTF,
  'https://example.com/models/mesh.bin': bytes(12),
};
const textureLoader =
  (calls) =>
  async (url, { fetch, signal, ...options }) => {
    calls.push(url);
    await (await fetch(url, { signal })).arrayBuffer();
    return new Texture({ data: new Uint8Array(4), width: 1, height: 1 }, options);
  };

test('LoadingManager: one manager counts OBJ+MTL+texture and glTF+.bin items across two loaders, onLoad once', async () => {
  const { fetch, seen } = network(FILES),
    manager = new LoadingManager({ fetch }),
    events = record(manager),
    textures = [];
  manager.itemStart('scene');
  const results = await Promise.allSettled([
    loadOBJ({}, 'https://example.com/models/scene.obj', { fetch: manager.fetch, loadTexture: textureLoader(textures) }),
    loadGLTF({}, 'https://example.com/models/tank.gltf', { fetch: manager.fetch }),
  ]);
  // The stand-in engine makes both builds fail after every file was fetched.
  assert.deepEqual(
    results.map((r) => r.status),
    ['rejected', 'rejected'],
  );
  assert.equal(events.filter((e) => e[0] === 'load').length, 0, 'the custom item keeps the batch open');
  manager.itemEnd('scene');
  assert.deepEqual(seen.sort(), Object.keys(FILES).sort());
  assert.deepEqual(textures, ['https://example.com/models/red.png'], 'the texture loader got loadOBJ fetch');
  const started = events.filter((e) => e[0] === 'start').map((e) => e[1]);
  assert.deepEqual(started.sort(), ['scene', ...Object.keys(FILES)].sort());
  assert.deepEqual(events.at(-1), ['load']);
  assert.equal(events.filter((e) => e[0] === 'load').length, 1);
  assert.equal(events.filter((e) => e[0] === 'error').length, 0);
  assert.deepEqual([manager.loaded, manager.total, manager.pending], [6, 6, 0]);
  const size = Object.values(FILES).reduce((sum, f) => sum + (typeof f === 'string' ? encode(f) : f).length, 0);
  assert.equal(manager.bytesLoaded, size);
  assert.equal(manager.bytesTotal, size);
  // A new load after onLoad starts a new batch.
  await fetchBytes('https://example.com/models/mesh.bin', { fetch: manager.fetch });
  assert.deepEqual([manager.loaded, manager.total, manager.bytesLoaded], [1, 1, 12]);
});

test('LoadingManager: byte progress follows the reads, with and without Content-Length', async () => {
  for (const length of [true, false]) {
    const chunks = [bytes(3), bytes(4), bytes(5)],
      manager = new LoadingManager({ fetch: async () => streamed(chunks, { length }) }),
      events = record(manager);
    const response = await manager.fetch('https://example.com/a.bin');
    assert.equal(response.headers.get('content-length'), length ? '12' : null);
    assert.equal((await response.arrayBuffer()).byteLength, 12);
    const total = length ? 12 : undefined;
    assert.deepEqual(events, [
      ['start', 'https://example.com/a.bin', 0, 1],
      ['progress', 'https://example.com/a.bin', 0, 1, { itemLoaded: 3, itemTotal: total, loaded: 3, total }],
      ['progress', 'https://example.com/a.bin', 0, 1, { itemLoaded: 7, itemTotal: total, loaded: 7, total }],
      ['progress', 'https://example.com/a.bin', 0, 1, { itemLoaded: 12, itemTotal: total, loaded: 12, total }],
      ['progress', 'https://example.com/a.bin', 1, 1, { itemLoaded: 12, itemTotal: total, loaded: 12, total }],
      ['load'],
    ]);
  }
  // A compressed body's Content-Length is not its decoded size, so it gives no total.
  const manager = new LoadingManager({
    fetch: async () => new Response(bytes(4), { headers: { 'content-length': '2', 'content-encoding': 'gzip' } }),
  });
  await (await manager.fetch('https://example.com/z.bin')).arrayBuffer();
  assert.equal(manager.bytesTotal, undefined);
});

test('LoadingManager: HTTP errors, network failures and custom itemError report onError with the URL', async () => {
  const manager = new LoadingManager({
      fetch: async (url) => {
        if (String(url).endsWith('down')) throw new TypeError('network down');
        return new Response('no', { status: 404 });
      },
    }),
    events = record(manager);
  manager.itemStart('decode');
  await assert.rejects(
    fetchBytes('https://example.com/missing.bin', { fetch: manager.fetch }),
    (e) => e instanceof LoaderError && e.code === 'fetch',
  );
  await assert.rejects(manager.fetch('https://example.com/down'), /network down/);
  manager.itemError('decode', new RangeError('too big'));
  const errors = events.filter((e) => e[0] === 'error');
  assert.deepEqual(
    errors.map((e) => e[1]),
    ['https://example.com/missing.bin', 'https://example.com/down', 'decode'],
  );
  assert.equal(errors[0][2].name, 'MargoError');
  assert.equal(errors[0][2].code, 'failed');
  assert.match(errors[0][2].message, /HTTP 404/);
  assert.deepEqual(events.at(-1), ['load'], 'failed items count as done');
  assert.equal(events.filter((e) => e[0] === 'load').length, 1);
  assert.throws(() => manager.itemEnd('decode'), RangeError);
  assert.throws(() => manager.setURLModifier(42), TypeError);
  assert.throws(() => new LoadingManager({ fetch: 'no' }), TypeError);
});

test('LoadingManager: the URL modifier maps the file and every sibling the loaders resolve from it', async () => {
  // Files dropped into the page: each name maps to a blob: URL, which the network answers with its own url.
  const blobs = Object.fromEntries(Object.keys(FILES).map((url, i) => [url, `blob:https://example.com/${i}`])),
    served = Object.fromEntries(Object.entries(FILES).map(([url, file]) => [blobs[url], file])),
    { fetch, seen } = network(served),
    manager = new LoadingManager({ fetch }).setURLModifier((url) => blobs[url] ?? url),
    events = record(manager),
    textures = [];
  await Promise.allSettled([
    loadOBJ({}, 'https://example.com/models/scene.obj', { fetch: manager.fetch, loadTexture: textureLoader(textures) }),
    loadGLTF({}, 'https://example.com/models/tank.gltf', { fetch: manager.fetch }),
  ]);
  assert.deepEqual(seen.sort(), Object.values(blobs).sort(), 'only blob: URLs reached the network');
  assert.deepEqual(
    events
      .filter((e) => e[0] === 'start')
      .map((e) => e[1])
      .sort(),
    Object.keys(FILES).sort(),
    'callbacks report the requested URLs',
  );
  assert.equal(events.filter((e) => e[0] === 'error').length, 0);
  assert.equal(manager.resolveURL('https://example.com/models/red.png'), blobs['https://example.com/models/red.png']);
  const response = await manager.fetch('https://example.com/models/mesh.bin');
  assert.equal(response.url, 'https://example.com/models/mesh.bin', 'response url is the requested one');
  await response.arrayBuffer();
  manager.setURLModifier(() => 7);
  await assert.rejects(manager.fetch('https://example.com/x'), TypeError);
});

test('LoadingManager: abort() cancels requests and bodies in flight, reports each and stays usable', async () => {
  let release;
  const hung = new Promise((resolve) => {
    release = resolve;
  });
  const manager = new LoadingManager({
      // A network that ignores the signal: one request never answers, one body stops after its first chunk.
      fetch: async (url) => {
        if (String(url).endsWith('slow')) return hung;
        let sent = false;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (!sent) controller.enqueue(bytes(4));
              sent = true;
              return new Promise(() => {});
            },
          }),
        );
      },
    }),
    events = record(manager);
  const slow = manager.fetch('https://example.com/slow'),
    body = fetchBytes('https://example.com/body', { fetch: manager.fetch });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(manager.bytesLoaded, 4);
  const signal = manager.signal;
  manager.abort();
  assert.equal(signal.aborted, true);
  assert.notEqual(manager.signal, signal, 'a new signal follows the abort');
  await assert.rejects(slow, (e) => e.name === 'AbortError');
  await assert.rejects(body, LoaderError);
  release(new Response('late'));
  const errors = events.filter((e) => e[0] === 'error');
  assert.deepEqual(errors.map((e) => e[1]).sort(), ['https://example.com/body', 'https://example.com/slow']);
  assert.ok(errors.every((e) => e[2].name === 'AbortError'));
  assert.deepEqual(events.at(-1), ['load']);
  // The loader's own signal still cancels its request.
  const own = new AbortController(),
    late = manager.fetch('https://example.com/slow', { signal: own.signal });
  own.abort();
  await assert.rejects(late, (e) => e.name === 'AbortError');
  assert.equal(manager.pending, 0);
});

test('LoadingManager: composes with AssetCache in both orders', async () => {
  const file = { 'https://example.com/a.glb': bytes(10) };
  // No IndexedDB in Node: the cache answers from its network, as it does when storage is unavailable.
  {
    const { fetch, seen } = network(file),
      cache = new AssetCache({ name: 'manager-test', fetch }),
      manager = new LoadingManager({ fetch: cache.fetch }),
      events = record(manager);
    assert.equal((await fetchBytes('https://example.com/a.glb', { fetch: manager.fetch })).length, 10);
    assert.deepEqual(seen, ['https://example.com/a.glb']);
    assert.equal(cache.stats.misses, 1);
    assert.deepEqual([manager.loaded, manager.bytesLoaded, manager.bytesTotal], [1, 10, 10]);
    assert.deepEqual(events.at(-1), ['load']);
  }
  {
    const { fetch, seen } = network(file),
      manager = new LoadingManager({ fetch }),
      cache = new AssetCache({ name: 'manager-test-2', fetch: manager.fetch }),
      events = record(manager);
    assert.equal((await fetchBytes('https://example.com/a.glb', { fetch: cache.fetch })).length, 10);
    assert.deepEqual(seen, ['https://example.com/a.glb']);
    assert.deepEqual([manager.loaded, manager.bytesLoaded], [1, 10]);
    assert.deepEqual(events.at(-1), ['load']);
  }
});

test('LoadingManager: byte caps still hold through the manager and report the limit error', async () => {
  for (const length of [true, false]) {
    const manager = new LoadingManager({ fetch: async () => streamed([bytes(4), bytes(4), bytes(4)], { length }) }),
      events = record(manager);
    await assert.rejects(
      fetchBytes('https://example.com/big.bin', { fetch: manager.fetch, maxBytes: 6 }),
      (e) => e instanceof LoaderError && e.code === 'limit',
    );
    const errors = events.filter((e) => e[0] === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1], 'https://example.com/big.bin');
    assert.equal(errors[0][2].code, 'limit');
    assert.ok(manager.bytesLoaded <= 8, 'reading stopped at the cap');
    assert.deepEqual(events.at(-1), ['load']);
  }
});
