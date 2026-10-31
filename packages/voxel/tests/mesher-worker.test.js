// The worker mesher: the built worker script (no eval, as the strict CSP in docs/deploying.md needs, following
// tests/no-eval-workers.test.js), sortQuads against an independent centre-distance oracle, and VoxelMesher on real
// worker_threads (results, priority order, supersede, cancel, dispose).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { VoxelWorld, chunkKey } from '../dist/index.js';
import { QUAD_WORDS, VoxelMesher, decodeQuad, meshChunk, meshInput, sortQuads } from '../dist/mesher.js';
import { GLASS, NodeWebWorker, STONE, WATER, blocks, terrainWorld } from './worker-support.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const same = (a, b, label) => {
  for (const layer of ['opaque', 'cutout', 'translucent'])
    assert.deepEqual([...a[layer]], [...b[layer]], `${label} ${layer}`);
  assert.equal(a.visibility, b.visibility, `${label} visibility`);
};
// Scattered glass, water and stone in one chunk: many small translucent quads to sort.
function glassWorld(seed) {
  const world = new VoxelWorld({ blocks }),
    next = random(seed),
    edits = [];
  for (let i = 0; i < 600; i++) {
    const r = next();
    edits.push((next() * 32) | 0, (next() * 32) | 0, (next() * 32) | 0, r < 0.5 ? GLASS : r < 0.8 ? WATER : STONE);
  }
  world.setBlocks(edits);
  return world;
}
// Each quad's centre from the decoded fields and the geometry in ChunkMesh's documentation.
const AXES = [
  [0, 2, 1],
  [0, 2, 1],
  [1, 0, 2],
  [1, 0, 2],
  [2, 0, 1],
  [2, 0, 1],
]; // normal, u and v axis per face
function centre(words, i) {
  const q = decodeQuad(words, i),
    c = [q.x + 0.5, q.y + 0.5, q.z + 0.5];
  if (q.face < 6) {
    const [n, u, v] = AXES[q.face];
    c[n] += q.face & 1 ? -0.5 : 0.5;
    c[u] += (q.w - 1) / 2;
    c[v] += (q.h - 1) / 2;
  }
  return c;
}
const quads = (words) =>
  Array.from({ length: words.length / QUAD_WORDS }, (_, i) => words.slice(i * 3, i * 3 + 3).join());

test('the built mesher worker is a classic script without eval and meshes exactly as meshChunk with code generation from strings disabled', async () => {
  const code = readFileSync(new URL('../dist/workers/mesher.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /\beval\s*\(|new Function|\bFunction\s*\(/);
  assert.doesNotMatch(code, /^\s*(import|export)\s/m, 'a classic script');
  assert.doesNotMatch(code, /import\.meta|document|new Worker/, 'the worker client is not bundled into the worker');
  const posted = [],
    scope = { postMessage: (data, transfer) => posted.push({ data, transfer }) };
  scope.self = scope;
  const context = vm.createContext(scope, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(code, context);
  // Typed arrays must be the worker realm's own, as a structured clone delivers them.
  const into = vm.runInContext(
    `(function copy(v) {
      if (ArrayBuffer.isView(v)) return new globalThis[v.constructor.name](v);
      if (Array.isArray(v)) return v.map(copy);
      if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = copy(v[k]); return o; }
      return v;
    })`,
    context,
  );
  const { world, keys } = terrainWorld(2, 7),
    glass = glassWorld(3),
    eye = [5.5, 40, -3];
  const cases = [...keys.map((key) => [meshInput(world, key), undefined]), [meshInput(glass, '0,0,0'), eye]];
  for (const [i, [input, at]] of cases.entries()) {
    await scope.onmessage({ data: into({ input, eye: at }) });
    const { data, transfer } = posted[i],
      expected = meshChunk(input);
    if (at) sortQuads(expected.translucent, at);
    assert.equal(data.error, undefined, data.error?.message);
    same(data.result, expected, `job ${i}`);
    assert.equal(transfer.length, 3, 'the three layer arrays move back');
  }
  assert.ok(
    cases.at(-1)[0] && meshChunk(cases.at(-1)[0]).translucent.length > 300,
    'the glass chunk has quads to sort',
  );
  await scope.onmessage({ data: into({ input: { chunk: null } }) });
  assert.equal(posted.at(-1).data.error.name, 'TypeError', 'a bad job gets an error reply');
});

test('sortQuads orders quads back to front by centre distance, stable, as a permutation', () => {
  for (const seed of [1, 2, 3]) {
    const mesh = meshChunk(meshInput(glassWorld(seed), '0,0,0')),
      next = random(seed + 10),
      eye = [next() * 60 - 14, next() * 60 - 14, next() * 60 - 14],
      before = mesh.translucent.slice(),
      sorted = sortQuads(mesh.translucent, eye);
    assert.equal(sorted, mesh.translucent, 'in place');
    assert.deepEqual(quads(sorted).sort(), quads(before).sort(), 'same quads');
    const distance = (words, i) => centre(words, i).reduce((sum, c, axis) => sum + (c - eye[axis]) ** 2, 0),
      position = new Map(quads(before).map((q, i) => [q, i]));
    for (let i = 1; i < sorted.length / 3; i++) {
      const a = distance(sorted, i - 1),
        b = distance(sorted, i);
      assert.ok(a >= b, `seed ${seed}: quad ${i} is farther than quad ${i - 1}`);
      if (a === b) assert.ok(position.get(quads(sorted)[i - 1]) < position.get(quads(sorted)[i]), 'ties keep order');
    }
  }
  // A row of glass blocks along x seen from +x: the farthest block's faces come first.
  const row = new VoxelWorld({ blocks });
  for (let x = 0; x < 8; x += 2) row.setBlock(x, 0, 0, GLASS);
  const words = sortQuads(meshChunk(meshInput(row, '0,0,0')).translucent, [30, 0.5, 0.5]);
  assert.equal(decodeQuad(words, 0).x, 0);
  assert.equal(decodeQuad(words, words.length / 3 - 1).face, 0, 'the nearest +x face last');
  assert.equal(decodeQuad(words, words.length / 3 - 1).x, 6);
  assert.throws(() => sortQuads([1, 2, 3], [0, 0, 0]), TypeError);
  assert.throws(() => sortQuads(new Uint32Array(4), [0, 0, 0]), RangeError);
  assert.throws(() => sortQuads(new Uint32Array(3), [0, Number.NaN, 0]), RangeError);
  assert.throws(() => sortQuads(new Uint32Array(3), [0, 0]), TypeError);
});

test('VoxelMesher.warm starts every worker before any job, the jobs use those, and one that fails to start is replaced', async (t) => {
  const previous = globalThis.Worker,
    started = [];
  globalThis.Worker = class extends NodeWebWorker {
    constructor(url) {
      super(url);
      started.push(this);
    }
    addEventListener(type, listener) {
      if (type === 'error') this.fail = listener;
    }
  };
  t.after(() => (globalThis.Worker = previous));
  const mesher = new VoxelMesher({ workers: 2 });
  t.after(() => mesher.dispose());
  assert.equal(started.length, 0, 'nothing starts by itself');
  mesher.warm();
  mesher.warm();
  assert.equal(started.length, 2, 'warm starts the pool, once');
  started[1].fail(); // the download of this one failed: it leaves, and warm or a job starts another
  const { world, keys } = terrainWorld(2);

  const meshes = await Promise.all(keys.slice(0, 2).map((key) => mesher.mesh(world, key)));
  assert.ok(meshes.every((mesh) => mesh));
  assert.equal(started.length, 3, 'the two jobs took the one left and one new worker');
  mesher.dispose();
  const unused = new VoxelMesher({ workers: 1 });
  unused.warm();
  const last = started.at(-1);
  let ended = false;
  const terminate = last.terminate.bind(last);
  last.terminate = () => {
    ended = true;
    terminate();
  };
  unused.dispose();
  assert.equal(ended, true, 'dispose stops a worker no job took');
});

test('VoxelMesher on worker_threads: same meshes as meshChunk, lowest priority first, newest call per key wins', async (t) => {
  const previous = globalThis.Worker;
  globalThis.Worker = NodeWebWorker;
  t.after(() => (globalThis.Worker = previous));
  const { world, keys } = terrainWorld(3, 5),
    mesher = new VoxelMesher({ workers: 1 });
  t.after(() => mesher.dispose());
  assert.equal(mesher.workers, 1);

  // Results equal the pure mesher's, with and without an eye.
  const eye = [40, 30, 20];
  const meshes = await Promise.all(keys.map((key) => mesher.mesh(world, key)));
  for (const [i, key] of keys.entries()) same(meshes[i], meshChunk(meshInput(world, key)), key);
  const [cx, cy, cz] = keys[4].split(',').map(Number),
    sorted = meshChunk(meshInput(world, keys[4]));
  sortQuads(sorted.translucent, [eye[0] - cx * 32, eye[1] - cy * 32, eye[2] - cz * 32]);
  same(await mesher.mesh(world, keys[4], 0, eye), sorted, 'with eye');

  // One worker: the first job starts at once, the rest wait and run lowest priority first.
  const order = [];
  await Promise.all(
    [
      [keys[0], 0],
      [keys[3], 3],
      [keys[1], 1],
      [keys[2], 2],
      [keys[5], -1],
    ].map(([key, priority]) => mesher.mesh(world, key, priority).then(() => order.push(key))),
  );
  assert.deepEqual(order, [keys[0], keys[5], keys[1], keys[2], keys[3]]);

  // Superseding: a queued job (keys[2]) and a running one (keys[1], edited after its call) resolve null; only the
  // newest call's mesh arrives, and it holds the edit.
  const running = mesher.mesh(world, keys[1]),
    queued = mesher.mesh(world, keys[2]),
    newest2 = mesher.mesh(world, keys[2]);
  world.setBlock(40, 31, 8, STONE);
  const newest1 = mesher.mesh(world, keys[1], 0);
  assert.equal(await running, null);
  assert.equal(await queued, null);
  same(await newest2, meshChunk(meshInput(world, keys[2])), 'newest of keys[2]');
  const edited = await newest1;
  same(edited, meshChunk(meshInput(world, keys[1])), 'newest of keys[1]');
  assert.notDeepEqual([...edited.opaque], [...meshes[1].opaque], 'the edit is in the delivered mesh');

  // cancel, an unloaded chunk, arguments, dispose.
  const busy = mesher.mesh(world, keys[0]),
    cancelled = mesher.mesh(world, keys[3]);
  mesher.cancel(keys[3]);
  mesher.cancel('9,9,9'); // nothing pending: no effect
  assert.equal(await cancelled, null);
  assert.ok(await busy);
  assert.equal(await mesher.mesh(world, chunkKey(9, 9, 9)), null, 'a chunk that is not loaded');
  assert.throws(() => mesher.mesh(world, '1,2'), RangeError);
  assert.throws(() => mesher.mesh(world, 5), TypeError);
  assert.throws(() => mesher.mesh({}, keys[0]), TypeError);
  assert.throws(() => mesher.mesh(world, keys[0], Number.NaN), RangeError);
  assert.throws(() => mesher.mesh(world, keys[0], 0, [1, 2]), TypeError);
  const pending = [mesher.mesh(world, keys[6]), mesher.mesh(world, keys[7])];
  mesher.dispose();
  assert.deepEqual(await Promise.all(pending), [null, null]);
  assert.throws(
    () => mesher.mesh(world, keys[0]),
    (error) => error.code === 'disposed',
  );
  assert.throws(() => new VoxelMesher({ workers: 0 }), RangeError);
  globalThis.Worker = undefined;
  assert.throws(
    () => new VoxelMesher(),
    (error) => error.code === 'unsupported',
  );
});
