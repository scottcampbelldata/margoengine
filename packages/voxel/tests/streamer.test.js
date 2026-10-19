// VoxelStreamer: exact load and unload sets against a brute-force ring, hysteresis, closest-first order under the
// per-frame cap, store before generator, edited chunks saved on unload and reloaded identical, LRU eviction under the
// memory budget, failures, a camera path that ends with no holes, dispose. Generators run on real worker_threads:
// the built terrain worker (classic) and tests/generator.worker.js (an app module worker on serveVoxelGenerator).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as Thread } from 'node:worker_threads';
import { BlockTypes, VoxelChunk, VoxelWorld, chunkKey } from '../dist/index.js';
import { noiseTerrain } from '../dist/generate.js';
import { MemoryChunkStore, VoxelStreamer } from '../dist/stream.js';
import { NodeWebWorker } from './worker-support.js';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves', 'glass']) blocks.define(name);
const STONE = blocks.id('stone'),
  DIRT = blocks.id('dirt'),
  GLASS = blocks.id('glass');

// A module worker on a Node thread: browser worker globals, and messages held until the module has run (as browsers
// hold them until a module worker's script has run).
const moduleBoot = `
const { parentPort, workerData } = require('node:worker_threads');
globalThis.self = globalThis;
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
const held = [];
parentPort.on('message', (data) => (self.onmessage ? self.onmessage({ data }) : held.push(data)));
import(workerData).then(() => held.splice(0).forEach((data) => self.onmessage({ data })));
`;
class NodeModuleWorker {
  constructor(url) {
    this.thread = new Thread(moduleBoot, { eval: true, workerData: String(url) });
    this.thread.on('message', (data) => this.onmessage?.({ data }));
    this.thread.on('error', (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
  }
  postMessage(data, transfer) {
    this.thread.postMessage(data, transfer);
  }
  terminate() {
    this.thread.terminate();
  }
}
// Installs globalThis.Worker for the test. `started` holds a record per worker (type, URL, terminated), `jobs` the
// chunk key of every job posted to any of them, in order.
function useWorkers(t) {
  const previous = globalThis.Worker,
    started = [],
    jobs = [];
  globalThis.Worker = function Worker(url, options) {
    const worker = options?.type === 'module' ? new NodeModuleWorker(url) : new NodeWebWorker(url),
      record = { type: options?.type ?? 'classic', url: String(url), terminated: false },
      post = worker.postMessage.bind(worker),
      stop = worker.terminate.bind(worker);
    worker.postMessage = (data, transfer) => {
      jobs.push(chunkKey(data.cx, data.cy, data.cz));
      post(data, transfer);
    };
    worker.terminate = () => {
      record.terminated = true;
      stop();
    };
    started.push(record);
    return worker;
  };
  t.after(() => (globalThis.Worker = previous));
  return { started, jobs };
}

// The world's loaded keys, plus every add and removal in order.
function track(world) {
  const loaded = new Set(),
    added = [],
    removed = [];
  world.onChunk((cx, cy, cz, chunk) => {
    const key = chunkKey(cx, cy, cz);
    if (chunk) loaded.add(key), added.push(key);
    else loaded.delete(key), removed.push(key);
  });
  return { loaded, added, removed };
}
// Brute force: chunks within d in x and z (a circle) and v in y of chunk c.
function ring([cx, cy, cz], d, v) {
  const out = new Set();
  for (let x = cx - d; x <= cx + d; x++)
    for (let z = cz - d; z <= cz + d; z++)
      for (let y = cy - v; y <= cy + v; y++) if ((x - cx) ** 2 + (z - cz) ** 2 <= d * d) out.add(chunkKey(x, y, z));
  return out;
}
const chunkOf = (p) => p.map((c) => Math.floor(c / 32));
const sorted = (set) => [...set].sort();
const union = (...sets) => new Set(sets.flatMap((s) => [...s]));
const both = (a, b) => new Set([...a].filter((key) => b.has(key)));
const coords = (key) => key.split(',').map(Number);
const cells = (chunk) => {
  const out = new Uint32Array(32768);
  for (let y = 0; y < 32; y++)
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) out[x | (z << 5) | (y << 10)] = chunk.get(x, y, z);
  return out;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
// Updates until `done` (default: nothing pending) holds after an update.
async function settle(update, done, seconds = 30) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    update();
    if (done()) return;
    await tick();
  }
  throw new Error('the streamer did not settle');
}
const run = (streamer, done = () => streamer.pending === 0) => settle(() => streamer.update(), done);

test('VoxelStreamer loads exactly the load range and unloads one chunk past it (hysteresis), per viewer', async () => {
  const world = new VoxelWorld({ blocks }),
    seen = track(world),
    streamer = new VoxelStreamer({ world, distance: 2, verticalDistance: 1, chunksPerFrame: Infinity, workers: 16 }),
    keep = (p) => ring(chunkOf(p), 3, 2);
  let at = [5, 40, -3];
  streamer.viewers = [at];
  await run(streamer);
  assert.deepEqual(sorted(seen.loaded), sorted(ring(chunkOf(at), 2, 1)));
  assert.equal(seen.loaded.size, 13 * 3);

  // One chunk on: the new range loads, the old one stays inside the margin.
  let before = new Set(seen.loaded);
  at = [40, 40, -3];
  streamer.viewers = [at];
  await run(streamer);
  assert.deepEqual(sorted(seen.loaded), sorted(union(ring(chunkOf(at), 2, 1), both(before, keep(at)))));
  assert.equal(seen.removed.length, 0, 'the old range is within one chunk of the new');

  // Back and forth across a chunk border: nothing unloads, nothing loads again.
  const adds = seen.added.length;
  for (let i = 0; i < 8; i++) {
    streamer.viewers = [[i % 2 ? 31.5 : 32.5, 40, -3]];
    await run(streamer);
  }
  assert.equal(seen.removed.length, 0);
  assert.equal(seen.added.length, adds);

  // Far away, and up: what is past the margin of the new place unloads.
  before = new Set(seen.loaded);
  at = [200, 100, -3];
  streamer.viewers = [at];
  await run(streamer);
  assert.deepEqual(sorted(seen.loaded), sorted(union(ring(chunkOf(at), 2, 1), both(before, keep(at)))));
  assert.ok(seen.removed.length > 30 && both(before, keep(at)).size > 0, 'some kept by the margin, the rest gone');

  // Two viewers: the union of their ranges; the far one leaving unloads its range only.
  const other = [-300, -100, 50];
  streamer.viewers = [at, other];
  await run(streamer);
  assert.deepEqual(
    sorted(seen.loaded),
    sorted(union(ring(chunkOf(at), 2, 1), ring(chunkOf(other), 2, 1), both(before, keep(at)))),
  );
  streamer.viewers = [at];
  await run(streamer);
  assert.deepEqual(sorted(seen.loaded), sorted(union(ring(chunkOf(at), 2, 1), both(before, keep(at)))));

  // A smaller distance applies at the next update: the new margin is the old load range.
  streamer.distance = 1;
  streamer.verticalDistance = 0;
  await run(streamer);
  assert.deepEqual(sorted(seen.loaded), sorted(ring(chunkOf(at), 2, 1)));
  await streamer.dispose();
  // The world's y range bounds the chunks: cy 0 and 1 overlap cells 0..40.
  const low = new VoxelWorld({ blocks, minY: 0, maxY: 40 }),
    lows = track(low),
    flat = new VoxelStreamer({ world: low, distance: 1, verticalDistance: 3, chunksPerFrame: Infinity });
  flat.viewers = [[0, 0, 0]];
  await run(flat);
  assert.deepEqual(sorted(lows.loaded), sorted(union(ring([0, 0, 0], 1, 0), ring([0, 1, 0], 1, 0))));
  await flat.dispose();
});

test('VoxelStreamer adds closest first, at most chunksPerFrame per update', async () => {
  const world = new VoxelWorld({ blocks }),
    seen = track(world),
    streamer = new VoxelStreamer({ world, distance: 3, verticalDistance: 1, chunksPerFrame: 2, workers: 1 }),
    frames = [];
  streamer.viewers = [[-40, 70, 10]];
  const centre = chunkOf([-40, 70, 10]);
  await settle(
    () => {
      const n = seen.added.length;
      streamer.update();
      frames.push(seen.added.length - n);
    },
    () => streamer.pending === 0,
  );
  assert.equal(seen.added.length, ring(centre, 3, 1).size);
  assert.ok(Math.max(...frames) === 2 && frames.filter((n) => n === 2).length > 30, 'the cap held chunks back');
  const d = seen.added.map((key) => coords(key).reduce((sum, c, i) => sum + (c - centre[i]) ** 2, 0));
  for (let i = 1; i < d.length; i++)
    assert.ok(d[i] >= d[i - 1], `add ${i} (${seen.added[i]}) is not closer than ${i - 1}`);
  streamer.chunksPerFrame = Infinity;
  assert.throws(() => (streamer.chunksPerFrame = 0), RangeError);
  await streamer.dispose();
});

test('VoxelStreamer stops adding once frameBudget is spent, always adds one, and keeps chunksPerFrame', async (t) => {
  // A clock that only moves when a chunk joins: each add costs exactly 1 ms of streamer time.
  let now = 0;
  const realNow = performance.now;
  performance.now = () => now;
  t.after(() => (performance.now = realNow));
  const world = new VoxelWorld({ blocks }),
    seen = track(world),
    streamer = new VoxelStreamer({ world, distance: 5, verticalDistance: 1, chunksPerFrame: Infinity, workers: 3 }),
    centre = chunkOf([500, 70, 10]);
  assert.equal(streamer.frameBudget, 0.5);
  world.onChunk((cx, cy, cz, chunk) => chunk && (now += 1));
  streamer.viewers = [[500, 70, 10]];
  const frames = (budget, perFrame, count) => {
    streamer.frameBudget = budget;
    streamer.chunksPerFrame = perFrame;
    const out = [];
    return settle(
      () => {
        const n = seen.added.length;
        streamer.update();
        if (seen.added.length > n) out.push(seen.added.length - n);
      },
      () => out.length >= count || streamer.pending === 0,
    ).then(() => out);
  };
  // 2.5 ms: the third chunk ends at 3 ms, so three join and the fourth waits (12 are ready: 4 per worker).
  let added = await frames(2.5, Infinity, 20);
  assert.ok(Math.max(...added) === 3 && added.filter((n) => n === 3).length > 10, `per update: ${added}`);
  // 0: one chunk per update; it never stalls.
  added = await frames(0, Infinity, 20);
  assert.deepEqual(new Set(added), new Set([1]));
  // chunksPerFrame still caps a larger budget.
  added = await frames(100, 2, 20);
  assert.ok(Math.max(...added) === 2 && added.filter((n) => n === 2).length > 10, `per update: ${added}`);
  // Infinity: everything ready joins.
  added = await frames(Infinity, Infinity, Infinity);
  assert.equal(seen.added.length, ring(centre, 5, 1).size);
  assert.ok(Math.max(...added) > 3, `per update: ${added}`);
  assert.throws(() => (streamer.frameBudget = -1), RangeError);
  assert.throws(() => (streamer.frameBudget = Number.NaN), RangeError);
  assert.throws(() => (streamer.frameBudget = '1'), TypeError);
  assert.equal(streamer.frameBudget, Infinity);
  await streamer.dispose();
  const other = new VoxelWorld({ blocks });
  assert.throws(() => new VoxelStreamer({ world: other, frameBudget: -0.5 }), RangeError);
  const zero = new VoxelStreamer({ world: other, frameBudget: 0 });
  assert.equal(zero.frameBudget, 0);
  await zero.dispose();
});

test('VoxelStreamer reads the store before the generator; an app module worker generates the rest; failures', async (t) => {
  const { started, jobs } = useWorkers(t),
    store = new MemoryChunkStore();
  await store.put(0, 0, 0, new VoxelChunk(GLASS));
  const world = new VoxelWorld({ blocks }),
    streamer = new VoxelStreamer({
      world,
      store,
      generator: new URL('./generator.worker.js', import.meta.url),
      distance: 1,
      verticalDistance: 1,
      workers: 2,
      chunksPerFrame: Infinity,
    }),
    errors = [];
  t.after(() => streamer.dispose());
  streamer.onError = (error) => errors.push(error);
  streamer.viewers = [[16, 16, 16]];
  await run(streamer);
  const range = ring([0, 0, 0], 1, 1);
  assert.ok(started.length >= 1 && started.every((w) => w.type === 'module' && w.url.endsWith('generator.worker.js')));
  assert.deepEqual(
    jobs.slice().sort(),
    sorted(range).filter((key) => key !== '0,0,0'),
    'each missing chunk once',
  );
  assert.equal(world.getChunk(0, 0, 0).get(9, 9, 9), GLASS, 'the stored chunk');
  for (const key of range) {
    if (key === '0,0,0') continue;
    const [cx, cy, cz] = coords(key),
      chunk = world.getChunk(cx, cy, cz);
    assert.equal(chunk.get(cx & 31, cy & 31, cz & 31), DIRT, `${key} came from the generator`);
    assert.equal(chunk.get((cx + 1) & 31, cy & 31, cz & 31), cy < 0 ? STONE : 0, `${key} below ground or air`);
  }
  assert.deepEqual(errors, []);

  // The generator throws for column 5, 5: each chunk there fails once, is reported, and is not asked again while in
  // range; it is asked again after leaving the range and coming back.
  const there = [5 * 32 + 3, 16, 5 * 32 + 3],
    failing = ['5,-1,5', '5,0,5', '5,1,5'];
  streamer.viewers = [there];
  await run(streamer);
  for (let i = 0; i < 20; i++) streamer.update(), await tick();
  assert.equal(errors.length, 3);
  assert.ok(errors.every((e) => e instanceof RangeError && /no chunk 5,-?\d,5 here/.test(e.message)));
  assert.deepEqual(
    failing.map((key) => jobs.filter((k) => k === key).length),
    [1, 1, 1],
  );
  assert.equal(world.getChunk(5, 0, 5), undefined, 'a hole, reported');
  streamer.viewers = [[16, 16, 16]];
  await run(streamer);
  streamer.viewers = [there];
  await run(streamer);
  assert.deepEqual(
    failing.map((key) => jobs.filter((k) => k === key).length),
    [2, 2, 2],
  );
  await streamer.dispose();
  assert.ok(
    started.every((w) => w.terminated),
    'dispose stops the workers',
  );
});

test('VoxelStreamer saves edited and adopted chunks when they unload, and they come back identical, not regenerated', async (t) => {
  const { started, jobs } = useWorkers(t),
    store = new MemoryChunkStore(),
    puts = [],
    put = store.put.bind(store);
  store.put = (cx, cy, cz, chunk) => (puts.push(chunkKey(cx, cy, cz)), put(cx, cy, cz, chunk));
  const terrain = { seed: 9, trees: 0.05 },
    world = new VoxelWorld({ blocks });
  world.setBlock(-200, 3, 7, STONE); // loaded before the streamer: adopted, saved when it unloads
  const streamer = new VoxelStreamer({
      world,
      store,
      generator: terrain,
      distance: 1,
      verticalDistance: 0,
      workers: 2,
      chunksPerFrame: Infinity,
    }),
    fn = noiseTerrain(terrain),
    home = [16, 16, 16];
  t.after(() => streamer.dispose());
  streamer.viewers = [home];
  await run(streamer);
  assert.ok(started.length && started.every((w) => w.type === 'classic' && w.url.includes('workers/terrain.js')));
  for (const key of ring([0, 0, 0], 1, 0)) {
    const [cx, cy, cz] = coords(key),
      expected = new VoxelChunk();
    fn(expected, cx, cy, cz, { blocks: blocks.table });
    assert.deepEqual(cells(world.getChunk(cx, cy, cz)), cells(expected), `${key} is noiseTerrain's chunk`);
  }
  world.setBlock(3, 4, 5, GLASS);
  world.setBlocks([40, 1, 2, GLASS, 41, 1, 2, 0]);
  world.addChunk(9, 0, 9, new VoxelChunk(STONE)); // someone else's chunk
  const edited = new Map(['0,0,0', '1,0,0'].map((key) => [key, cells(world.getChunk(...coords(key)))]));
  const generated = jobs.length;
  streamer.viewers = [[16 + 32 * 10, 16, 16]];
  await run(streamer, () => streamer.pending === 0 && !world.getChunk(0, 0, 0));
  assert.deepEqual(puts.sort(), ['-7,0,0', '0,0,0', '1,0,0', '9,0,9'], 'edited and adopted chunks only');
  streamer.viewers = [home];
  await run(streamer);
  for (const [key, before] of edited)
    assert.deepEqual(cells(world.getChunk(...coords(key))), before, `${key} as edited`);
  const again = jobs.slice(generated);
  assert.ok(!again.includes('0,0,0') && !again.includes('1,0,0'), 'the saved chunks were not generated again');
  assert.ok(again.includes('-1,0,0') && again.includes('0,0,1'), 'the unedited ones were');
  await streamer.dispose();
});

test('VoxelStreamer keeps to memoryBudget: least recently used chunks outside the range go first', async () => {
  // Chunks of 2 states with per-cell light: 36,876 bytes each, all from the store.
  const heavy = () => {
      const chunk = new VoxelChunk(STONE);
      chunk.set(1, 2, 3, 0);
      chunk.setLight(0, 0, 0, 0x50);
      return chunk;
    },
    size = heavy().byteLength,
    store = new MemoryChunkStore();
  assert.equal(size, 36876);
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++) for (let y = -1; y <= 1; y++) await store.put(x, y, z, heavy());
  // Distance 0: the range is the viewer's chunk, the margin its 4 neighbours and the chunks above and below them. X
  // loads first and Y second, X is used again, then Z loads past a budget of 2: Y (least recently used, though loaded
  // after X) goes.
  const world = new VoxelWorld({ blocks }),
    seen = track(world),
    streamer = new VoxelStreamer({ world, store, distance: 0, verticalDistance: 0, memoryBudget: 2 * size }),
    X = [5, 3, 7],
    Y = [37, 3, 7],
    Z = [5, 35, 7];
  for (const at of [X, Y, X]) {
    streamer.viewers = [at];
    await run(streamer);
  }
  assert.deepEqual(sorted(seen.loaded), ['0,0,0', '1,0,0']);
  streamer.viewers = [Z];
  await run(streamer);
  assert.deepEqual(sorted(seen.loaded), ['0,0,0', '0,1,0'], 'Y went, though Z keeps it in the margin');
  await streamer.dispose();

  // A budget smaller than the range: the closest chunks load, then loading stops; more budget loads the rest.
  const small = new VoxelWorld({ blocks }),
    smalls = track(small),
    tight = new VoxelStreamer({
      world: small,
      store,
      distance: 1,
      verticalDistance: 0,
      memoryBudget: 3 * size,
      workers: 1,
    });
  tight.viewers = [[5, 3, 7]];
  for (let i = 0; i < 20; i++) tight.update(), await tick();
  assert.ok(smalls.loaded.has('0,0,0') && smalls.loaded.size < 5 && tight.pending > 0, `${smalls.loaded.size} loaded`);
  tight.memoryBudget = Infinity;
  await run(tight);
  assert.equal(smalls.loaded.size, 5);
  assert.throws(() => (tight.memoryBudget = 0), RangeError);
  await tight.dispose();
});

test('VoxelStreamer.save and failed saves: an edit is never lost', async () => {
  const store = new MemoryChunkStore(),
    put = store.put.bind(store),
    world = new VoxelWorld({ blocks }),
    streamer = new VoxelStreamer({ world, store, distance: 0, verticalDistance: 0 }),
    errors = [];
  let fail = true;
  store.put = (...args) => (fail ? Promise.reject(new Error('disk full')) : put(...args));
  streamer.onError = (error) => errors.push(error);
  streamer.viewers = [[1, 1, 1]];
  await run(streamer);
  world.setBlock(1, 1, 1, GLASS);
  await assert.rejects(streamer.save(), /disk full/);
  fail = false;
  await streamer.save();
  assert.equal((await store.get(0, 0, 0)).get(1, 1, 1), GLASS);
  // A save that fails on unload is reported; the chunk is kept and comes back with its edit, then saves later.
  fail = true;
  world.setBlock(2, 2, 2, GLASS);
  streamer.viewers = [[500, 1, 1]];
  await run(streamer, () => !world.getChunk(0, 0, 0));
  await tick();
  assert.equal(errors.length, 1);
  assert.equal((await store.get(0, 0, 0)).get(2, 2, 2), 0, 'not in the store');
  streamer.viewers = [[1, 1, 1]];
  await run(streamer);
  assert.equal(world.getChunk(0, 0, 0).get(2, 2, 2), GLASS, 'back with its edit');
  fail = false;
  streamer.viewers = [[500, 1, 1]];
  await run(streamer, () => !world.getChunk(0, 0, 0));
  await streamer.dispose();
  assert.equal((await store.get(0, 0, 0)).get(2, 2, 2), GLASS);
});

test('VoxelStreamer.attach follows the engine camera: a path ends with no holes; dispose saves, flushes, stops', async (t) => {
  const { started } = useWorkers(t),
    store = new MemoryChunkStore(),
    flush = store.flush.bind(store),
    plugins = new Map(),
    engine = {
      camera: { position: [0, 20, 0] },
      onError: (error) => assert.fail(error),
      use(plugin) {
        plugin.setup(this);
        plugins.set(plugin.name, plugin);
        return this;
      },
      removePlugin(name) {
        const plugin = plugins.get(name);
        plugins.delete(name);
        plugin?.dispose?.();
      },
      frame: () => {
        for (const plugin of plugins.values()) plugin.onPreUpdate(1 / 60);
      },
    };
  let flushes = 0;
  store.flush = () => (flushes++, flush());
  const terrain = { seed: 4 },
    world = new VoxelWorld({ blocks }),
    seen = track(world),
    streamer = VoxelStreamer.attach(engine, {
      world,
      store,
      generator: terrain,
      distance: 2,
      verticalDistance: 1,
      workers: 2,
    });
  t.after(() => streamer.dispose());
  assert.equal(plugins.size, 1);
  const path = [
    [0, 20, 0],
    [60, 25, 10],
    [120, 30, 70],
    [150, 10, 160],
    [90, 0, 220],
    [20, 40, 260],
  ];
  for (const position of path) {
    engine.camera.position = position;
    for (let i = 0; i < 4; i++) engine.frame(), await tick();
  }
  await settle(engine.frame, () => streamer.pending === 0);
  const end = chunkOf(path.at(-1)),
    margin = ring(end, 3, 2),
    fn = noiseTerrain(terrain);
  for (const key of ring(end, 2, 1)) {
    const [cx, cy, cz] = coords(key),
      chunk = world.getChunk(cx, cy, cz),
      expected = new VoxelChunk();
    assert.ok(chunk, `no hole at ${key}`);
    fn(expected, cx, cy, cz, { blocks: blocks.table });
    assert.deepEqual(cells(chunk), cells(expected), key);
  }
  for (const key of seen.loaded) assert.ok(margin.has(key), `${key} is within the unload margin`);

  world.setBlock(20, 40, 260, GLASS);
  const disposed = streamer.dispose();
  assert.equal(plugins.size, 0, 'the plugin is removed');
  assert.equal(streamer.dispose(), disposed);
  await disposed;
  assert.equal((await store.get(...end)).get(20 & 31, 40 & 31, 260 & 31), GLASS, 'the edit was saved');
  assert.ok(flushes >= 1, 'the store was flushed');
  assert.ok(started.length === 2 && started.every((w) => w.terminated), 'both workers stopped');
  assert.ok(world.getChunk(...end), 'chunks stay in the world');
  assert.throws(
    () => streamer.update(),
    (error) => error.code === 'disposed',
  );
  await assert.rejects(streamer.save(), (error) => error.code === 'disposed');
});

test('VoxelStreamer arguments: types, ranges, one streamer per world, Web Workers for generators', async (t) => {
  const world = new VoxelWorld({ blocks });
  assert.throws(() => new VoxelStreamer({}), TypeError);
  assert.throws(() => new VoxelStreamer({ world, store: {} }), TypeError);
  assert.throws(() => new VoxelStreamer({ world, distance: 65 }), RangeError);
  assert.throws(() => new VoxelStreamer({ world, distance: 1.5 }), RangeError);
  assert.throws(() => new VoxelStreamer({ world, verticalDistance: -1 }), RangeError);
  assert.throws(() => new VoxelStreamer({ world, chunksPerFrame: 0 }), RangeError);
  assert.throws(() => new VoxelStreamer({ world, workers: 0 }), RangeError);
  assert.throws(() => new VoxelStreamer({ world, workers: Infinity }), RangeError);
  assert.throws(() => new VoxelStreamer({ world, memoryBudget: 0 }), RangeError);
  assert.throws(() => new VoxelStreamer({ world, memoryBudget: '1' }), TypeError);
  assert.throws(() => new VoxelStreamer({ world, distance: '2' }), TypeError);
  useWorkers(t);
  assert.throws(() => new VoxelStreamer({ world, generator: 5 }), TypeError);
  assert.throws(() => new VoxelStreamer({ world, generator: { seed: 0.5 } }), RangeError);
  assert.throws(() => new VoxelStreamer({ world: new VoxelWorld({ blocks: new BlockTypes() }), generator: {} }), {
    name: 'RangeError',
    message: /block "stone" is not defined/,
  });
  const previous = globalThis.Worker;
  globalThis.Worker = undefined;
  assert.throws(
    () => new VoxelStreamer({ world, generator: {} }),
    (error) => error.code === 'unsupported',
  );
  globalThis.Worker = previous;
  const one = new VoxelStreamer({ world });
  assert.throws(
    () => new VoxelStreamer({ world }),
    (error) => error.code === 'attached',
  );
  one.viewers = [[0, Number.NaN, 0]];
  assert.throws(() => one.update(), RangeError);
  one.viewers = [[0, 0]];
  assert.throws(() => one.update(), TypeError);
  assert.throws(() => (one.distance = 100), RangeError);
  await one.dispose();
  await new VoxelStreamer({ world }).dispose(); // the world is free again
});
