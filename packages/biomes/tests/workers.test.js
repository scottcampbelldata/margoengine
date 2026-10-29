// B7: worker replicas give the page's bytes. A world with workers makes tiles, placements and view tiles in Node
// worker threads running the built worker script (dist/workers/biomes.js, the file browsers load); every digest equals
// the same world on the main thread, after paint writes, updates and placement changes too; an aborted job leaves the
// queue and a retry gives the same bytes; a crashed worker rejects its job with MargoError 'failed' and the next job
// runs on a fresh replica.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld } from '../dist/index.js';
import { BiomePlacement } from '../dist/placement.js';
import { presets } from '../dist/presets.js';
import { groundMaterials, VIEW_LAYERS, viewTile } from '../dist/view.js';
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
