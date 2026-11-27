import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_FLOCK_OPTIONS,
  FLOCK_BOID_FLOATS,
  FLOCK_MAX_SUBSTEP,
  GPUFlock,
  MAX_FLOCK_ATTRACTORS,
  MAX_FLOCK_BOIDS,
  MAX_FLOCK_OBSTACLES,
  MAX_FLOCK_PREDATORS,
  createBirdGeometry,
  createFishGeometry,
  createFlockState,
  flockStateHash,
  gridCellsForCount,
  hashCell,
  packFlockGeometry,
  resolveFlockParams,
  stepFlockCPU,
} from '../dist/flocking.js';

const F = FLOCK_BOID_FLOATS;
// WebGPU's buffer usage flags (W3C WebGPU, GPUBufferUsage), for the stand-in device below.
globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
const coded = (err) =>
  err?.name === 'MargoError' && err.code === 'unsupported' && err.message.includes('https://margoengine.com/errors#flocking');

/** A flock state with the given boids: [x, y, z, vx, vy, vz] each, phase and bank 0. */
function stateOf(options, rows) {
  const state = createFlockState({ ...options, count: rows.length });
  rows.forEach((r, i) => state.boids.set([r[0], r[1], r[2], 0, r[3], r[4], r[5], 0], i * F));
  return state;
}

function fakeEngine(overrides = {}) {
  const removed = [];
  const added = [];
  const engine = {
    backend: 'webgpu',
    gpu: {
      limits: {
        maxStorageBufferBindingSize: 128 * 1024 * 1024,
        maxBufferSize: 256 * 1024 * 1024,
        maxComputeWorkgroupsPerDimension: 65535,
      },
      adapterInfo: { vendor: 'test-native' },
    },
    stats: { drawCalls: 0 },
    use(plugin) {
      added.push(plugin);
      plugin.setup?.(engine);
    },
    sceneOf() {
      return { removePlugin: (name) => removed.push(name) };
    },
    ...overrides,
  };
  return { engine, added, removed };
}

/** An engine on the WebGL2 layer's device: buffers are stand-ins, so the CPU twin's route runs in Node. */
function compatEngine() {
  return fakeEngine({
    gpu: {
      limits: {
        maxStorageBufferBindingSize: 128 * 1024 * 1024,
        maxBufferSize: 256 * 1024 * 1024,
        maxComputeWorkgroupsPerDimension: 65535,
      },
      adapterInfo: { vendor: 'margo-webgl2' },
      createBuffer: () => ({ destroy() {} }),
      queue: { writeBuffer() {} },
    },
  });
}

test('built-in bird and fish meshes and a glTF mesh geometry pack with unit normals and valid weights', () => {
  for (const [preset, fn] of [
    ['bird', createBirdGeometry],
    ['fish', createFishGeometry],
  ]) {
    const packed = packFlockGeometry(fn(), preset);
    assert.ok(packed.vertexCount >= 18 && packed.vertexCount % 3 === 0, `${preset} has whole triangles`);
    assert.equal(packed.corners.length, packed.vertexCount * 8);
    let maxWeight = 0;
    for (let i = 0; i < packed.vertexCount; i++) {
      const o = i * 8;
      assert.ok(packed.corners[o + 3] >= 0 && packed.corners[o + 3] <= 1, `${preset} weight in [0, 1]`);
      maxWeight = Math.max(maxWeight, packed.corners[o + 3]);
      const nl = Math.hypot(packed.corners[o + 4], packed.corners[o + 5], packed.corners[o + 6]);
      assert.ok(Math.abs(nl - 1) < 1e-6, `${preset} normal is unit length`);
      assert.ok(Math.hypot(packed.corners[o], packed.corners[o + 1], packed.corners[o + 2]) <= 1 + 1e-6, 'unit radius');
    }
    assert.ok(maxWeight > 0.9, `${preset} animates its extremities`);
  }
  // A core Geometry's layout (six floats a vertex), as model.meshes[i].geometry of a loaded glTF holds it.
  const vertices = new Float32Array([0, 0, 2, 0, 1, 0, -1, 0, -1, 0, 1, 0, 1, 0, -1, 0, 1, 0]);
  const mesh = packFlockGeometry({ vertices, indices: new Uint32Array([0, 1, 2]) }, 'bird');
  assert.equal(mesh.vertexCount, 3);
  assert.deepEqual([...mesh.corners.subarray(0, 8)], [0, 0, 1, 0, 0, 1, 0, 0]);
  assert.equal(mesh.corners[8 + 3], 0.5, 'a wing vertex at |x| = 0.5 of the radius flaps by half');
  assert.throws(() => packFlockGeometry({ positions: [0, 0, 0, 0, 0, 0, 0, 0, 0] }, 'bird'), coded);
  assert.throws(() => packFlockGeometry({ positions: [0, 0, 1, 1, 0, 0, 0, 1, 0], indices: [0, 1, 9] }, 'bird'), coded);
  assert.throws(() => packFlockGeometry({ vertices: [0, 0, 1], indices: [0, 0, 0] }, 'bird'), coded);
});

test('createFlockState is seeded and stays inside box and sphere bounds', () => {
  const box = { count: 64, seed: 42, bounds: { shape: 'box', center: [2, -1, 3], halfSize: [5, 3, 4] } };
  const a = createFlockState(box);
  assert.deepEqual(a.boids, createFlockState(box).boids);
  assert.notDeepEqual(a.boids, createFlockState({ ...box, seed: 43 }).boids);
  for (let i = 0; i < 64; i++) {
    const o = i * F;
    assert.ok(Math.abs(a.boids[o] - 2) <= 5 && Math.abs(a.boids[o + 1] + 1) <= 3 && Math.abs(a.boids[o + 2] - 3) <= 4);
  }
  const s = createFlockState({ count: 64, seed: 7, bounds: { shape: 'sphere', center: [1, 2, -1], radius: 6 } });
  for (let i = 0; i < 64; i++) {
    const o = i * F;
    assert.ok(Math.hypot(s.boids[o] - 1, s.boids[o + 1] - 2, s.boids[o + 2] + 1) <= 6.0001);
  }
});

test('closed form: a lone boid between its speed limits flies straight at constant speed and flaps at its rate', () => {
  const opts = { bounds: { shape: 'box', halfSize: [100, 100, 100] }, minSpeed: 2, maxSpeed: 8, flapFrequency: 5 };
  const state = stateOf(opts, [[0, 0, 0, 3, 0, 4]]);
  const h = 1 / 60;
  for (let k = 0; k < 120; k++) stepFlockCPU(state, opts, h);
  const t = 120 * h;
  // x = v t; no rule acts, so the velocity, speed 5, never changes and the bank stays 0.
  // f32 rounding: 120 sums, each within half an ulp of 6 (2.4e-7), bound 2.9e-5.
  assert.ok(Math.abs(state.boids[0] - 3 * t) < 1e-4 && Math.abs(state.boids[2] - 4 * t) < 1e-4, `x ${state.boids[0]}`);
  assert.deepEqual([...state.boids.subarray(4, 8)], [3, 0, 4, 0]);
  // phase rate = 2 pi f (0.75 + 0.55 (|v| - min) / (max - min)), wrapped into [0, 2 pi).
  const rate = 2 * Math.PI * 5 * (0.75 + 0.55 * ((5 - 2) / 6));
  const phase = (rate * t) % (2 * Math.PI);
  assert.ok(Math.abs(state.boids[3] - phase) < 1e-4, `phase ${state.boids[3]} against ${phase}`);
});

test('closed form: the speed clamps to maxSpeed and a turn gains at most maxTurnAccel * dt across the heading', () => {
  const fast = { bounds: { shape: 'box', halfSize: [100, 100, 100] }, minSpeed: 2, maxSpeed: 6 };
  const state = stateOf(fast, [[0, 0, 0, 0, 0, 20]]);
  stepFlockCPU(state, fast, 1 / 60);
  assert.ok(Math.abs(Math.hypot(state.boids[4], state.boids[5], state.boids[6]) - 6) < 1e-5);

  const turn = {
    separation: 0,
    alignment: 0,
    cohesion: 5,
    neighborRadius: 10,
    separationRadius: 0.1,
    visionAngle: Math.PI * 2,
    minSpeed: 5,
    maxSpeed: 5,
    maxForce: 50,
    maxTurnAccel: 4,
    bounds: { shape: 'box', halfSize: [50, 50, 50] },
  };
  const pair = stateOf(turn, [
    [0, 0, 0, 0, 0, 5],
    [4, 0, 0, 0, 0, 5],
  ]);
  stepFlockCPU(pair, turn, 0.05);
  // Cohesion asks (25, 0, -25): along the heading -25, across it 25, capped to 4. The new velocity (0.2, 0, 3.75)
  // is below minSpeed and rescales to 5.
  const expected = (4 * 0.05 * 5) / Math.hypot(4 * 0.05, 5 - 25 * 0.05);
  assert.ok(Math.abs(pair.boids[4] - expected) < 1e-5, `turned ${pair.boids[4]} against ${expected}`);
});

test('separation drives close boids apart and the vision cone hides neighbours behind', () => {
  const sep = {
    separation: 4,
    alignment: 0,
    cohesion: 0,
    separationRadius: 2,
    neighborRadius: 3,
    minSpeed: 2,
    maxSpeed: 6,
    bounds: { shape: 'box', halfSize: [40, 40, 40] },
    boundsMargin: 1,
  };
  const state = stateOf(sep, [
    [-0.25, 0, 0, 0, 0, 4],
    [0.25, 0, 0, 0, 0, 4],
  ]);
  for (let k = 0; k < 20; k++) stepFlockCPU(state, sep, 1 / 60);
  assert.ok(state.boids[F] - state.boids[0] > 1, `apart: ${state.boids[F] - state.boids[0]}`);

  const cone = {
    separation: 0,
    alignment: 4,
    cohesion: 0,
    neighborRadius: 5,
    separationRadius: 0.2,
    visionAngle: Math.PI * 0.5,
    minSpeed: 4,
    maxSpeed: 6,
    bounds: { shape: 'box', halfSize: [50, 50, 50] },
  };
  const behind = stateOf(cone, [
    [0, 0, 0, 0, 0, 5],
    [0, 0, -2, 5, 0, 0],
  ]);
  stepFlockCPU(behind, cone, 1 / 30);
  assert.ok(behind.boids[4] === 0, 'a neighbour behind is not seen');
  const ahead = stateOf(cone, [
    [0, 0, 0, 0, 0, 5],
    [0, 0, 2, 5, 0, 0],
  ]);
  stepFlockCPU(ahead, cone, 1 / 30);
  assert.ok(ahead.boids[4] > 0.1, `a neighbour ahead turns it: vx ${ahead.boids[4]}`);
});

test('regression: two neighbouring cells that share a hash bucket count their boids once', () => {
  const opts = {
    neighborRadius: 2.6,
    separationRadius: 0.5,
    visionAngle: Math.PI * 2,
    bounds: { shape: 'box', halfSize: [400, 400, 400] },
  };
  const mask = gridCellsForCount(3) - 1;
  const offsets = [];
  for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) offsets.push([x, y, z]);
  let found;
  search: for (let cz = -60; cz <= 60; cz++)
    for (let cy = -60; cy <= 60; cy++)
      for (let cx = -60; cx <= 60; cx++) {
        const seen = new Map();
        for (const d of offsets) {
          if (!d[0] && !d[1] && !d[2]) continue;
          const b = hashCell(cx + d[0], cy + d[1], cz + d[2], mask);
          if (b === hashCell(cx, cy, cz, mask)) continue;
          if (seen.has(b)) {
            found = { c: [cx, cy, cz], d1: seen.get(b), d2: d };
            break search;
          }
          seen.set(b, d);
        }
      }
  assert.ok(found, 'a shared bucket among the 26 neighbours exists');
  const cell = 2.6;
  const centre = found.c.map((c) => (c + 0.5) * cell);
  // Each neighbour sits in its cell at the point nearest the first boid, 1 cm inside: at most 1.3 sqrt(3) m away.
  const near = (d) => centre.map((c, a) => c + d[a] * (cell / 2 + 0.01));
  const state = stateOf(opts, [
    [...centre, 0, 0, 5],
    [...near(found.d1), 0, 0, 5],
    [...near(found.d2), 0, 0, 5],
  ]);
  stepFlockCPU(state, { ...opts, debug: { selectedIndex: 0 } }, 1 / 60);
  assert.equal(state.debugData[7], 2, 'two neighbours, each counted once');
});

test('attractors pull boids in, predators scatter them, and sphere obstacles keep them clear', () => {
  const att = {
    count: 16,
    seed: 11,
    separation: 0.2,
    alignment: 0.2,
    cohesion: 0.2,
    bounds: { shape: 'box', halfSize: [30, 30, 30] },
    attractors: [{ position: [12, 0, 0], strength: 6, radius: 0 }],
  };
  const a = createFlockState(att);
  const far = () =>
    [...Array(16).keys()].reduce((s, i) => s + Math.hypot(a.boids[i * F] - 12, a.boids[i * F + 1], a.boids[i * F + 2]), 0) / 16;
  const before = far();
  for (let k = 0; k < 120; k++) stepFlockCPU(a, att, 1 / 60);
  // Measured: 21.8 m to 8.6 m in 2 s; at minSpeed 4 the boids then circle the point.
  assert.ok(far() < before / 2, `toward the attractor: ${before} to ${far()}`);

  const pred = {
    count: 24,
    seed: 19,
    bounds: { shape: 'sphere', radius: 25 },
    predators: [{ position: [0, 0, 0], radius: 14, strength: 18 }],
  };
  const p = createFlockState(pred);
  for (let i = 0; i < 24; i++) p.boids.set([1.5, 0.2 * (i - 12), 0], i * F);
  stepFlockCPU(p, pred, 1 / 30);
  assert.ok(Math.hypot(p.debugData[20], p.debugData[21], p.debugData[22]) > 5, 'the predator push is recorded');
  for (let k = 0; k < 45; k++) stepFlockCPU(p, pred, 1 / 60);
  for (let i = 0; i < 24; i++) {
    const d = Math.hypot(p.boids[i * F], p.boids[i * F + 1], p.boids[i * F + 2]);
    assert.ok(d > 4 && d <= 25.001, `fled and stayed inside: ${d}`);
  }

  const obs = {
    count: 12,
    seed: 23,
    bounds: { shape: 'box', halfSize: [20, 20, 20] },
    obstacles: [{ position: [0, 0, 0], radius: 4, strength: 12 }],
    attractors: [{ position: [0, 0, 0], strength: 4 }],
  };
  const o = createFlockState(obs);
  for (let k = 0; k < 40; k++) stepFlockCPU(o, obs, 1 / 60);
  for (let i = 0; i < 12; i++) assert.ok(Math.hypot(o.boids[i * F], o.boids[i * F + 1], o.boids[i * F + 2]) >= 4);
});

test('determinism: the same seed gives the same state hash, also after a snapshot and restore', () => {
  const opts = { count: 2000, seed: 5, predators: [{ position: [3, 0, 0], radius: 6 }] };
  const run = (steps, from) => {
    const s = createFlockState(opts);
    if (from) s.boids.set(from);
    for (let k = 0; k < steps; k++) stepFlockCPU(s, opts, 1 / 60);
    return s;
  };
  const whole = flockStateHash(run(90).boids);
  assert.equal(flockStateHash(run(90).boids), whole);
  const snapshot = run(45).boids.slice();
  assert.equal(flockStateHash(run(45, snapshot).boids), whole, 'restored and stepped the rest');
  assert.notEqual(flockStateHash(run(90, undefined).boids), flockStateHash(run(89).boids));
  // A long dt runs as equal steps of at most 0.05 s: 0.1 s is exactly two steps of 0.05.
  const one = createFlockState(opts);
  const two = createFlockState(opts);
  assert.equal(stepFlockCPU(one, opts, 0.1), 2);
  stepFlockCPU(two, opts, FLOCK_MAX_SUBSTEP);
  stepFlockCPU(two, opts, FLOCK_MAX_SUBSTEP);
  assert.equal(flockStateHash(one.boids), flockStateHash(two.boids));
});

test('a 16,384-boid flock stays finite, inside its bounds and within its speed limits', () => {
  const opts = { count: 16_384, seed: 3, predators: [{ position: [0, 0, 0], radius: 7, strength: 18 }] };
  const s = createFlockState(opts);
  for (let k = 0; k < 30; k++) stepFlockCPU(s, opts, 1 / 30);
  const p = resolveFlockParams(opts);
  for (let i = 0; i < opts.count; i++) {
    const o = i * F;
    for (let a = 0; a < 3; a++) assert.ok(Math.abs(s.boids[o + a]) <= p.boundsHalf[a] + 1e-4);
    const speed = Math.hypot(s.boids[o + 4], s.boids[o + 5], s.boids[o + 6]);
    assert.ok(Number.isFinite(speed) && speed <= p.maxSpeed * 1.35 + 1e-4, `speed ${speed}`);
  }
});

test('every bad option throws a coded MargoError that links its help', () => {
  for (const bad of [
    { count: 0 },
    { count: MAX_FLOCK_BOIDS + 1 },
    { count: 1.5 },
    { seed: 0.5 },
    { preset: 'bat' },
    { bounds: { shape: 'cone' } },
    { bounds: { shape: 'box', halfSize: [1, 0, 1] } },
    { bounds: { shape: 'sphere', radius: -1 } },
    { neighborRadius: 0 },
    { visionAngle: 7 },
    { maxNeighbors: 129 },
    { minSpeed: 10, maxSpeed: 4 },
    { attractors: Array(MAX_FLOCK_ATTRACTORS + 1).fill({ position: [0, 0, 0] }) },
    { predators: Array(MAX_FLOCK_PREDATORS + 1).fill({ position: [0, 0, 0] }) },
    { obstacles: Array(MAX_FLOCK_OBSTACLES + 1).fill({ position: [0, 0, 0], radius: 1 }) },
    { obstacles: [{ position: [0, 0, 0] }] },
    { predators: [{ position: [0, Number.NaN, 0] }] },
    { lightDirection: [0, 0, 0] },
    { color: 'not a colour' },
    { ambient: 2 },
    { debug: { selectedIndex: 10 }, count: 10 },
  ])
    assert.throws(() => resolveFlockParams(bad), coded, JSON.stringify(bad));
  const state = createFlockState({ count: 4 });
  for (const dt of [-1, 1.5, Number.NaN]) assert.throws(() => stepFlockCPU(state, {}, dt), coded);
});

test('GPUFlock lifecycle, setters, limits, Symbol.dispose and coded errors', () => {
  assert.equal(DEFAULT_FLOCK_OPTIONS.count, 4096);
  assert.equal(gridCellsForCount(4096), 16384);
  assert.equal(gridCellsForCount(40000), 65536);

  const { engine, added, removed } = fakeEngine();
  const flock = GPUFlock.attach(engine, { count: 128 });
  assert.equal(added.length, 1);
  assert.equal(flock.stats.backend, 'webgpu');
  flock.setDebug({ enabled: true, selectedIndex: 10 });
  assert.deepEqual(flock.getDebug(), {
    enabled: true,
    velocities: true,
    grid: true,
    perception: true,
    vectors: true,
    selectedIndex: 10,
  });
  assert.throws(() => flock.setDebug({ selectedIndex: 128 }), coded);
  assert.equal(flock.getDebug().selectedIndex, 10, 'a refused setting changes nothing');
  flock.setPreset('fish');
  assert.equal(flock.options.preset, 'fish');
  assert.throws(() => flock.setPreset('bat'), coded);
  flock.setAttractors([{ position: [1, 2, 3], strength: 3 }]);
  flock.setPredators([{ position: [0, 0, 0], radius: 5, strength: 10 }]);
  flock.setObstacles([{ position: [3, 0, 0], radius: 2 }]);
  assert.throws(() => flock.setObstacles([{ position: [3, 0, 0], radius: 0 }]), coded);
  assert.equal(flock.options.obstacles.length, 1);
  assert.throws(() => flock.restore({ count: 64, steps: 0, boids: new Float32Array(64 * F) }), coded);
  flock.reset(999);
  assert.equal(flock.options.seed, 999);

  flock[Symbol.dispose]();
  assert.deepEqual(removed, [flock.name]);
  assert.throws(
    () => flock.setDebug({ enabled: false }),
    (err) => err?.name === 'MargoError' && err.code === 'disposed' && err.message.includes('errors#disposed'),
  );
  assert.throws(
    () => new GPUFlock({ count: 8 }).step(0.1),
    (err) => err?.name === 'MargoError' && err.code === 'state',
  );
  const preview = fakeEngine({ backend: 'webgl2', gpu: null });
  assert.throws(
    () => GPUFlock.attach(preview.engine, { count: 32 }),
    (err) => err?.name === 'MargoError' && err.code === 'unsupported' && err.message.includes('errors#webgpu'),
  );
  const tiny = fakeEngine({
    gpu: {
      limits: { maxStorageBufferBindingSize: 1024, maxBufferSize: 1024, maxComputeWorkgroupsPerDimension: 65535 },
      adapterInfo: { vendor: 'test-native' },
    },
  });
  assert.throws(
    () => GPUFlock.attach(tiny.engine, { count: 100 }),
    (err) => err?.name === 'MargoError' && err.code === 'unsupported' && err.message.includes('errors#unsupported'),
  );
});

test('on the WebGL2 layer GPUFlock steps its CPU twin: snapshot and restore repeat the same steps', async () => {
  const { engine } = compatEngine();
  const opts = { count: 500, seed: 21, predators: [{ position: [0, 0, 0], radius: 6 }] };
  const flock = GPUFlock.attach(engine, opts);
  assert.equal(flock.stats.backend, 'webgl2-compat');
  for (let k = 0; k < 30; k++) flock.step(1 / 60);
  const mid = await flock.snapshot();
  assert.equal(mid.steps, 30);
  for (let k = 0; k < 30; k++) flock.step(1 / 60);
  const end = flockStateHash((await flock.snapshot()).boids);
  const twin = createFlockState(opts);
  for (let k = 0; k < 60; k++) stepFlockCPU(twin, opts, 1 / 60);
  assert.equal(end, flockStateHash(twin.boids), 'the flock is its CPU twin');
  flock.restore(mid);
  assert.equal(flock.stats.steps, 30);
  for (let k = 0; k < 30; k++) flock.step(1 / 60);
  assert.equal(flockStateHash((await flock.snapshot()).boids), end, 'restored, the same steps repeat');
  flock.reset();
  assert.equal(flockStateHash((await flock.snapshot()).boids), flockStateHash(createFlockState(opts).boids));
  flock.dispose();
});
