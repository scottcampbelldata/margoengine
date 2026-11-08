// B7: worker replicas give the page's bytes. A world with workers makes tiles, placements and view tiles in Node
// worker threads running the built worker script (dist/workers/biomes.js, the file browsers load); every digest equals
// the same world on the main thread, after paint writes, updates and placement changes too; an aborted job leaves the
// queue and a retry gives the same bytes; a crashed worker rejects its job with MargoError 'failed' and the next job
// runs on a fresh replica. The worker file holds one copy of each module and leaves out the digest and presets
// entries.
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { BiomePlacement } from '../dist/placement.js';
import { presets } from '../dist/presets.js';
import { groundMaterials, overviewWeights, VIEW_LAYERS, viewTile } from '../dist/view.js';
import { BiomeWorkers, defaultWorkers } from '../dist/workers.js';
import { whittaker } from '../dist/zones.js';
import { ThreadWebWorker } from './thread-worker.js';

const options = { seed: 11, size: [1024, 1024] };
const both = async (extra = {}) => [
  await BiomeWorld.create({ ...options, ...extra, workers: false }),
  await BiomeWorld.create({ ...options, ...extra, workers: 2, createWorker: () => new ThreadWebWorker() }),
];

test('worker options: none by default without Web Workers, validated counts, a field height stays on this thread', async () => {
  assert.equal(defaultWorkers(), 0, 'Node has no Web Worker global');
  assert.equal((await BiomeWorld.create(options)).workers, undefined);
  await assert.rejects(BiomeWorld.create({ ...options, workers: 99 }), RangeError);
  await assert.rejects(BiomeWorld.create({ ...options, cache: 0 }), RangeError);
  const field = await BiomeWorld.create({
    ...options,
    height: { field: (x, z) => 50 + x * 0.01 + z * 0.02 },
    workers: 2,
    createWorker: () => new ThreadWebWorker(),
  });
  assert.equal(field.workers, undefined, 'a function cannot reach a worker');
  const remote = await BiomeWorld.create({ ...options, workers: 1, createWorker: () => new ThreadWebWorker() });
  assert.ok(remote.workers instanceof BiomeWorkers);
  assert.equal(remote.workers.size, 1);
  remote.dispose();
});

test('worker tiles, placements and view tiles are the main thread bytes', { timeout: 240000 }, async () => {
  const [main, remote] = await both();
  assert.equal(main.workers, undefined);
  assert.ok(remote.workers);
  for (const [x, z] of [
    [1, 1],
    [2, 1],
    [0, 3],
  ])
    assert.equal(await remote.digest(x, z), await main.digest(x, z), `fields ${x},${z}`);
  const p = BiomePlacement.attach(main),
    q = BiomePlacement.attach(remote);
  for (const [x, z] of [
    [1, 1],
    [2, 2],
  ]) {
    assert.equal(await q.digest(x, z), await p.digest(x, z), `placement ${x},${z}`);
    const t = await q.tile(x, z);
    assert.ok(t.groups.length > 0);
    assert.equal(
      t.groups.reduce((n, g) => n + g.records.length / 8, 0),
      t.count,
      'the groups hold every record once',
    );
    const views = [];
    t.forEachInstance((i) => views.push(i.key));
    assert.equal(views.length, t.count);
  }
  const materials = groundMaterials(main.biomes),
    local = viewTile(main, await main.tile(1, 2, { layers: VIEW_LAYERS }), materials, 2),
    sent = await remote.workers.run({ op: 'view', x: 1, z: 2, materials, step: 2 });
  assert.deepEqual(sent.heights, local.heights);
  assert.deepEqual(sent.weights[0], local.weights[0]);
  assert.deepEqual(sent.weights[1], local.weights[1]);
  remote.dispose();
});

test('paint writes, updates and placement changes reach the replicas in order', { timeout: 240000 }, async () => {
  const [main, remote] = await both();
  const paint = new Uint8Array(256 * 256).fill(200);
  for (const w of [main, remote]) w.writeLayer('paint/wetland', 1, 1, paint);
  assert.equal(await remote.digest(1, 1), await main.digest(1, 1), 'after paint');
  for (const w of [main, remote])
    w.update({ biomes: [presets.temperate, presets.desert, presets.wetland, presets.boreal] });
  assert.equal(await remote.digest(2, 1), await main.digest(2, 1), 'after new biomes');
  for (const w of [main, remote]) w.update({ classifier: whittaker });
  assert.equal(await remote.digest(1, 2), await main.digest(1, 2), 'after the Whittaker classifier');
  const p = BiomePlacement.attach(main),
    q = BiomePlacement.attach(remote),
    road = {
      exclusions: [
        {
          kind: 'line',
          points: [
            [-400, -400],
            [100, 100],
          ],
          width: 10,
          verge: 4,
        },
      ],
    };
  p.update(road);
  q.update(road);
  assert.equal(await q.digest(1, 1), await p.digest(1, 1), 'after an exclusion');
  remote.dispose();
});

test('an aborted job leaves the queue and a retry gives the same bytes; height samples move to the workers', {
  timeout: 240000,
}, async () => {
  const width = 129,
    samples = new Float32Array(width * width).map((_, i) => 80 + 40 * Math.sin(i * 0.013) + (i % width) * 0.3);
  const [main, remote] = await both({ height: { samples, width, depth: width } });
  const p = BiomePlacement.attach(main),
    q = BiomePlacement.attach(remote),
    controller = new AbortController();
  // Fill the queues, then abort one queued tile.
  const busy = [q.tile(0, 0), q.tile(3, 3), q.tile(0, 3), q.tile(3, 0)],
    aborted = q.tile(2, 2, { signal: controller.signal });
  controller.abort(new Error('stale tile'));
  await assert.rejects(aborted, /stale tile/);
  await Promise.all(busy);
  assert.equal(await q.digest(2, 2), await p.digest(2, 2));
  assert.equal(await remote.digest(3, 1), await main.digest(3, 1));
  remote.dispose();
  await assert.rejects(remote.tile(1, 1), { code: 'disposed' });
});

// Regression: the view learns what a send costs only from sends that reached a worker; a job queued behind a busy
// worker costs microseconds, and counting those let its estimate fade until a send that woke a worker started late in
// a frame (flythrough-check, stalled workers). `posts` tells the two apart.
test('posts counts the messages that reached a worker: a job queued behind a busy worker leaves it as it was', async () => {
  const sent = [];
  let worker;
  const world = await BiomeWorld.create({
      ...options,
      workers: 1,
      createWorker: () => (worker = { postMessage: (message) => sent.push(message), terminate() {} }),
    }),
    pool = world.workers;
  assert.equal(pool.posts, 0, 'no worker before the first job');
  const first = pool.run({ op: 'tile', x: 0, z: 0, layers: ['height'] });
  assert.equal(pool.posts, 2, 'a new worker gets its replica, then the job');
  const second = pool.run({ op: 'tile', x: 1, z: 0, layers: ['height'] });
  assert.equal(pool.posts, 2, 'the second job waits behind the busy worker');
  worker.onmessage({ data: { id: sent[1].id, result: 'a' } });
  assert.equal(pool.posts, 3, 'it goes when the worker replies');
  worker.onmessage({ data: { id: sent[2].id, result: 'b' } });
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
  world.dispose();
});

// Regression (review of a4ba40aa4): a worker placing a block made bands of neighbours it then placed whole (one worker:
// 1,465 ms per km2 instead of 1,119). A placement job now names the tiles the same replica places after it there.
test('a placement job carries the tiles its worker places after it, as ahead', async () => {
  const sent = [];
  let worker;
  const world = await BiomeWorld.create({
      ...options,
      workers: 1,
      createWorker: () => (worker = { postMessage: (message) => sent.push(message), terminate() {} }),
    }),
    pool = world.workers,
    jobs = [
      pool.run({ op: 'place', pid: 7, x: 1, z: 1 }),
      pool.run({ op: 'place', pid: 7, x: 2, z: 1 }),
      pool.run({ op: 'place', pid: 8, x: 3, z: 1 }),
      pool.run({ op: 'tile', x: 0, z: 0 }),
      pool.run({ op: 'place', pid: 7, x: 2, z: 2 }),
    ];
  // The first job left at once, before the others were queued.
  assert.deepEqual(sent[1].ahead, []);
  worker.onmessage({ data: { id: sent[1].id, result: 1 } });
  assert.deepEqual([sent[2].x, sent[2].ahead], [2, [[2, 2]]], 'placement 7 places (2, 2) after (2, 1) on this worker');
  worker.onmessage({ data: { id: sent[2].id, result: 2 } });
  assert.deepEqual(sent[3].ahead, [], 'placement 8 has nothing after it');
  worker.onmessage({ data: { id: sent[3].id, result: 3 } });
  assert.equal(sent[4].ahead, undefined, 'a tile job has no ahead');
  worker.onmessage({ data: { id: sent[4].id, result: 4 } });
  worker.onmessage({ data: { id: sent[5].id, result: 5 } });
  assert.deepEqual(await Promise.all(jobs), [1, 2, 3, 4, 5]);
  world.dispose();
});

test('a crashed worker rejects its job with failed and a fresh replica takes the next', {
  timeout: 240000,
}, async () => {
  let made = 0;
  const main = await BiomeWorld.create({ ...options, workers: false }),
    remote = await BiomeWorld.create({
      ...options,
      workers: 1,
      createWorker: () => {
        const w = new ThreadWebWorker();
        if (made++ === 0) {
          // The first worker dies on its first tile job.
          const post = w.postMessage.bind(w);
          w.postMessage = (m, t) => {
            post(m, t);
            if (m.op === 'tile') setTimeout(() => w.onerror?.({ message: 'simulated crash', preventDefault() {} }), 0);
          };
        }
        return w;
      },
    });
  await assert.rejects(remote.tile(1, 1), (error) => error.code === 'failed' && /simulated crash/.test(error.message));
  assert.equal(await remote.digest(1, 1), await main.digest(1, 1));
  assert.equal(made, 2);
  remote.dispose();
});

test('editing on a world with workers: brush strokes, undo and the tiles they dirty match the main thread', {
  timeout: 240000,
}, async () => {
  const { BiomeEditor } = await import('../dist/editor.js'),
    [main, remote] = await both(),
    p = BiomePlacement.attach(main),
    q = BiomePlacement.attach(remote);
  // Tiles made before the edit, so the workers must drop and remake them.
  assert.equal(await q.digest(2, 2), await p.digest(2, 2));
  for (const w of [main, remote]) {
    const editor = BiomeEditor.attach(w);
    editor.stroke(() => {
      editor.paint('wetland', { center: [60, 40], radius: 70 });
      editor.paint('wetland', { center: [110, 60], radius: 50, strength: 0.6, falloff: 'linear' });
    });
    editor.paint('boreal', { center: [-30, 20], radius: 40, mode: 'set', strength: 0.8 });
    editor.undo();
  }
  for (const [x, z] of [
    [2, 2],
    [2, 1],
  ]) {
    assert.equal(await remote.digest(x, z), await main.digest(x, z), `fields ${x},${z} after the stroke`);
    assert.equal(await q.digest(x, z), await p.digest(x, z), `placement ${x},${z} after the stroke`);
  }
  remote.dispose();
});

test('overview bands made on the workers are the main thread overview bytes, spread over the workers', {
  timeout: 240000,
}, async () => {
  // BiomeView.attach sends one band of overview rows per worker (biome look L5 made the overview 450 ms of the page's
  // thread). The replicas hold other cached tiles than the page; the bytes must not depend on that.
  let made = 0;
  const main = await BiomeWorld.create({ ...options, workers: false }),
    remote = await BiomeWorld.create({
      ...options,
      workers: 2,
      createWorker: () => (made++, new ThreadWebWorker()),
    });
  await remote.digest(1, 1);
  assert.equal(made, 1, 'one tile, one worker');
  const keys = groundMaterials(main.biomes),
    whole = overviewWeights(main, keys, 2),
    joined = whole.weights.map((w) => new Uint8Array(w.length)),
    posts = [];
  const n = remote.workers.size,
    bands = await Promise.all(
      Array.from({ length: n }, (_, b) => {
        const v0 = Math.floor((b * whole.depth) / n),
          v1 = Math.floor(((b + 1) * whole.depth) / n);
        posts.push([v0, v1]);
        return remote.workers.run({ op: 'overview', materials: keys, texel: 2, v0, v1 });
      }),
    );
  for (const band of bands) band.weights.forEach((w, i) => joined[i].set(w, band.v0 * whole.width * 4));
  assert.deepEqual(joined, whole.weights);
  assert.deepEqual(
    bands.map((b) => [b.v0, b.v1]),
    posts,
  );
  assert.equal(made, 2, 'bands about no tile go to the least loaded worker, not all to the first');
  main.dispose();
  remote.dispose();
});

test('stands: worker placements are the main thread bytes', { timeout: 240000 }, async () => {
  const biomes = [
    defineBiome({
      id: 'stand',
      climate: {},
      ground: [{ material: 'grass' }],
      plants: [
        { id: 'oak', mesh: 'procedural:broadleaf', density: 150, radius: 4, stands: { scale: 200, cover: 0.5 } },
      ],
    }),
  ];
  const [main, remote] = await both({ biomes }),
    p = BiomePlacement.attach(main),
    q = BiomePlacement.attach(remote);
  let total = 0;
  for (const [x, z] of [
    [1, 1],
    [2, 2],
  ]) {
    assert.equal(await q.digest(x, z), await p.digest(x, z), `placement ${x},${z}`);
    total += (await q.tile(x, z)).count;
  }
  assert.ok(total > 0);
  remote.dispose();
});

test('the worker file holds one copy of each module, without the digest and presets entries', () => {
  // Regression: the package-name imports (toolkit, splines, relief, erosion) resolved to dist, which added a second
  // copy of the integer helpers (and a second object per hook); the worker never makes a digest, and the page sends its
  // world's biomes, so the default ones are dead weight.
  const code = readFileSync(new URL('../dist/workers/biomes.js', import.meta.url), 'utf8'),
    count = (text) => code.split(text).length - 1;
  assert.equal(count('isqrt needs an integer'), 1, 'one copy of fixed.ts');
  assert.equal(count('Biome digests need Web Crypto'), 0, 'no digest entry');
  assert.equal(count('procedural:fern'), 0, 'no presets');
});
