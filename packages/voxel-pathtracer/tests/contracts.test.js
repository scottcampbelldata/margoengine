// Contracts a host builds on: public option and material defaults, standalone validation and reset (no engine or GPU
// needed), geometry reuse by content key and explicit invalidation, and the capture lifecycle (render counts and
// whenIdle after an abort).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTraceMaterial,
  resolveTraceOptions,
  VOXEL_PATHTRACER_DEFAULTS,
  validateTraceMaterial,
  validateTraceOptions,
  VoxelPathTracer,
} from '../dist/index.js';
import { fakeDevice, fakeEngine, materials, model, settle, simpleScene, translate } from './support.js';

const attach = (options = {}, harness = fakeEngine()) => ({
  tracer: VoxelPathTracer.attach(harness.engine, { scene: simpleScene(), ...options }),
  ...harness,
});
async function ready(options = {}) {
  const h = attach(options);
  await h.tracer.ready;
  h.frame();
  await settle();
  return h;
}
// The error setOptions throws for `options`, or undefined.
const setOptionsError = (options) => {
  const { tracer } = attach();
  try {
    tracer.setOptions(options);
  } catch (error) {
    return error;
  } finally {
    tracer.dispose();
  }
};
// The error setScene throws for a scene of one material, or undefined.
const setSceneError = (material, textures) => {
  const { tracer } = attach();
  try {
    // The scene's model uses palette 1: give it a material when the one checked has another id.
    const filler = material?.id === 1 ? [] : materials([1]);
    tracer.setScene(simpleScene({ materials: [material, ...filler], textures }));
  } catch (error) {
    return error;
  } finally {
    tracer.dispose();
  }
};
const texture = { width: 1, height: 1, data: new Uint8Array(4) };

test('defaults: exported, frozen, and what a new tracer runs with', () => {
  const { tracer } = attach();
  assert.ok(Object.isFrozen(VOXEL_PATHTRACER_DEFAULTS));
  assert.deepEqual(tracer.options, { ...VOXEL_PATHTRACER_DEFAULTS });
  assert.deepEqual(resolveTraceOptions({}), { ...VOXEL_PATHTRACER_DEFAULTS });
  const d = VOXEL_PATHTRACER_DEFAULTS;
  assert.equal(d.samplesPerFrame, 1);
  assert.equal(d.maxBounces, 8);
  assert.equal(d.maxSamples, 1024);
  assert.equal(d.denoise, false);
  assert.equal(d.toneMapping, 'neutral');
  assert.equal(d.order, 20);
  assert.equal(d.focusDistance, undefined, 'automatic focus');
  assert.deepEqual(d.fisheye, { mapping: 'equidistant', fov: 180 });
  // The options getter hands out copies: changing one does not reach the tracer.
  tracer.options.fisheye.fov = 10;
  assert.equal(tracer.options.fisheye.fov, 180);
  tracer.dispose();
});

test('resolveTraceOptions resolves over a base like setOptions; null returns focus to automatic', () => {
  const a = resolveTraceOptions({ focusDistance: 12, exposure: 1, bounceLimits: { diffuse: 2 } });
  assert.equal(a.focusDistance, 12);
  assert.equal(a.exposure, 1);
  assert.deepEqual(a.bounceLimits, {
    diffuse: 2,
    specular: undefined,
    scatter: undefined,
    subsurface: undefined,
    internalReflections: undefined,
  });
  const b = resolveTraceOptions({ maxBounces: 4 }, a);
  assert.equal(b.focusDistance, 12, 'left out: kept from the base');
  assert.equal(b.maxBounces, 4);
  assert.deepEqual(b.bounceLimits, a.bounceLimits);
  const c = resolveTraceOptions({ focusDistance: null, bounceLimits: null }, b);
  assert.equal(c.focusDistance, undefined);
  assert.equal(c.bounceLimits, undefined);
  // The same tracer state through setOptions.
  const { tracer } = attach();
  tracer.setOptions({ focusDistance: 12, exposure: 1, bounceLimits: { diffuse: 2 } });
  assert.deepEqual(tracer.options, a);
  tracer.setOptions({ focusDistance: null });
  assert.equal(tracer.options.focusDistance, undefined);
  tracer.dispose();
  // Errors are setOptions' own.
  for (const bad of [{ maxBounces: 0 }, { toneMapping: 'filmic' }, { focusDistance: -1 }, { lensBlades: 2 }]) {
    const expected = setOptionsError(bad);
    assert.throws(
      () => resolveTraceOptions(bad),
      (e) => e.constructor === expected.constructor && e.message === expected.message,
    );
  }
  assert.throws(() => resolveTraceOptions({ scene: simpleScene() }), TypeError);
});

test('validateTraceOptions lists every invalid option, ok exactly when setOptions accepts', () => {
  const bad = { maxBounces: 0, toneMapping: 'filmic', seed: 1.5 },
    r = validateTraceOptions({ maxBounces: 0, exposure: 1, toneMapping: 'filmic', seed: 1.5, colour: 'red' });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.problems.map((p) => [p.field, p.error.constructor.name]),
    [
      ['maxBounces', 'RangeError'],
      ['toneMapping', 'TypeError'],
      ['seed', 'RangeError'],
    ],
  );
  assert.deepEqual(r.unknown, ['colour']);
  for (const p of r.problems) assert.equal(p.error.message, setOptionsError({ [p.field]: bad[p.field] }).message);
  for (const options of [{}, { exposure: 2, focusDistance: null }, { colour: 'red' }, { grid: null, edges: null }])
    assert.equal(validateTraceOptions(options).ok, setOptionsError(options) === undefined, JSON.stringify(options));
  assert.equal(validateTraceOptions(null).ok, false);
});

test('resetOptions returns options to their defaults; restarts only for sampling options; unknown names throw', async () => {
  const { tracer, frame } = await ready({ focusDistance: 5, exposure: 2, gamma: 2.2 });
  frame();
  assert.ok(tracer.stats.samples > 0);
  tracer.resetOptions(['exposure', 'gamma']);
  assert.equal(tracer.options.exposure, 0);
  assert.equal(tracer.options.gamma, undefined);
  assert.equal(tracer.options.focusDistance, 5);
  assert.ok(tracer.stats.samples > 0, 'display options keep the image');
  tracer.resetOptions(['focusDistance']);
  assert.equal(tracer.options.focusDistance, undefined, 'automatic focus again');
  assert.equal(tracer.stats.samples, 0, 'focus restarts accumulation');
  frame();
  assert.throws(() => tracer.resetOptions(['exposure', 'colour']), TypeError);
  assert.throws(() => tracer.resetOptions('exposure'), TypeError);
  tracer.setOptions({ maxBounces: 3, order: 7, denoise: true });
  tracer.resetOptions();
  assert.deepEqual(tracer.options, { ...VOXEL_PATHTRACER_DEFAULTS });
  tracer.dispose();
  assert.throws(
    () => tracer.resetOptions(),
    (e) => e.name === 'MargoError' && e.code === 'disposed',
  );
});

test('resolveTraceMaterial fills in the defaults of each type and fails as setScene does', () => {
  const white = [1, 1, 1];
  const glass = resolveTraceMaterial({ id: 3, type: 'glass', color: white });
  assert.equal(glass.roughness, 0);
  assert.equal(glass.transmission, 1);
  assert.equal(glass.ior, 1.5);
  assert.equal(glass.specular, 1);
  assert.equal(glass.tint, true);
  assert.equal(glass.coat, 'layered');
  assert.equal(glass.texture, undefined);
  const metal = resolveTraceMaterial({ id: 4, type: 'metal', color: [0.9, 0.6, 0.2] });
  assert.equal(metal.metalness, 1);
  assert.equal(metal.roughness, 0.2);
  assert.deepEqual(metal.metalColor, [0.9, 0.6, 0.2]);
  const emit = resolveTraceMaterial({ id: 5, type: 'emit', color: white });
  assert.equal(emit.emission, 1);
  assert.equal(emit.cameraEmission, 1);
  assert.equal(emit.specular, 0);
  assert.deepEqual(emit.emissionColor, white);
  assert.equal(resolveTraceMaterial({ id: 6, type: 'media', color: white }).density, 1);
  assert.equal(resolveTraceMaterial({ id: 7, type: 'diffuse', color: white }).specular, 0);
  assert.equal(resolveTraceMaterial({ id: 8, type: 'plastic', color: white, emission: 2 }).cameraEmission, 2);
  assert.deepEqual(
    resolveTraceMaterial({ id: 9, type: 'diffuse', color: white, texture: 0 }).texture,
    [0, 0, 0, 0, 0, 0],
  );
  // Errors carry setScene's class and fix (setScene names the material by its place in the scene).
  for (const [bad, textures] of [
    [{ id: 1, type: 'glass', color: white, ior: 4 }],
    [{ id: 1, type: 'velvet', color: white }],
    [{ id: 0, type: 'diffuse', color: white }],
    [{ id: 1, type: 'diffuse', color: [1, -1, 1] }],
    [{ id: 1, type: 'glass', color: white, abbe: 3 }],
    [{ id: 1, type: 'diffuse', color: white, texture: 2 }, 1],
  ]) {
    const expected = setSceneError(bad, textures && [texture]);
    assert.ok(expected, JSON.stringify(bad));
    assert.throws(
      () => resolveTraceMaterial(bad, textures),
      (e) =>
        e.constructor === expected.constructor &&
        e.message === expected.message.replace('scene.materials[0]', 'material'),
    );
  }
  assert.doesNotThrow(() => resolveTraceMaterial({ id: 1, type: 'diffuse', color: white, texture: 2 }), 'no count');
});

test('validateTraceMaterial lists every invalid field; ok exactly when setScene accepts', () => {
  const r = validateTraceMaterial({
    id: 1,
    type: 'glass',
    color: [1, 1, 1],
    ior: 9,
    roughness: -1,
    tint: 'yes',
    shine: 1,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.problems.map((p) => p.field),
    ['ior', 'roughness', 'tint'],
  );
  assert.deepEqual(r.unknown, ['shine']);
  const s = validateTraceMaterial({ type: 'glass', color: 'red' });
  assert.deepEqual(
    s.problems.map((p) => p.field),
    ['id', 'color'],
  );
  for (const m of [
    { id: 1, type: 'diffuse', color: [1, 1, 1] },
    { id: 2, type: 'blend', color: [1, 1, 1], metalness: 0.5, transmission: 0.5, voxelwise: true },
    { id: 3, type: 'glass', color: [1, 1, 1], abbe: 40, cutout: 0.5 },
    { id: 3, type: 'glass', color: [1, 1, 1], abbe: 4 },
    { id: 300, type: 'diffuse', color: [1, 1, 1] },
  ])
    assert.equal(validateTraceMaterial(m).ok, setSceneError(m) === undefined, JSON.stringify(m));
});

test('contentKey: models reuse packing by key across ids and revisions, never across keys', () => {
  const { tracer } = attach(),
    floor = (y0) => model('m', [8, 8, 8], (x, y) => (y < y0 ? 1 : 0)),
    scene = (models, revision) =>
      simpleScene({
        revision,
        models,
        instances: models.map((m, i) => ({ id: `i${i}`, modelId: m.id, matrix: translate(i * 10, 0, 0) })),
      }),
    k1 = {};
  tracer.setScene(scene([{ ...floor(2), contentKey: k1 }], 2));
  assert.deepEqual([tracer.stats.packedModels, tracer.stats.reusedModels], [1, 0]);
  // Same content under another id and revision (a reopened document): reused, and raycast names the new id.
  tracer.setScene(scene([{ ...floor(2), id: 'n', revision: 9, contentKey: k1 }], 3));
  assert.deepEqual([tracer.stats.packedModels, tracer.stats.reusedModels], [0, 1]);
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).modelId, 'n');
  // Same id and revision, other contents under another key: packed again, never the stale bricks.
  tracer.setScene(scene([{ ...floor(6), id: 'n', revision: 9, contentKey: 'other' }], 4));
  assert.deepEqual([tracer.stats.packedModels, tracer.stats.reusedModels], [1, 0]);
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).distance, 14);
  // Two models of one scene with one key share one packing.
  tracer.setScene(
    scene(
      [
        { ...floor(6), contentKey: 'other' },
        { ...floor(6), id: 'twin', contentKey: 'other' },
      ],
      5,
    ),
  );
  assert.deepEqual([tracer.stats.packedModels, tracer.stats.reusedModels], [0, 2]);
  assert.equal(tracer.raycast([14.5, 20, 4.5], [0, -1, 0]).modelId, 'twin');
  // A model without a key does not reuse one packed under a key, even with the same id, revision and size.
  tracer.setScene(scene([{ ...floor(3), id: 'm', revision: 1, contentKey: 'k' }], 6));
  tracer.setScene(scene([floor(5)], 7));
  assert.deepEqual([tracer.stats.packedModels, tracer.stats.reusedModels], [1, 0]);
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).distance, 15);
  // Without keys, id + revision + size still reuse (documented: the caller promises unchanged contents).
  tracer.setScene(scene([floor(1)], 8));
  assert.deepEqual([tracer.stats.packedModels, tracer.stats.reusedModels], [0, 1]);
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).distance, 15);
  assert.throws(() => tracer.setScene(scene([{ ...floor(1), contentKey: null }], 9)), TypeError);
  tracer.dispose();
});

test('invalidateModels makes the next setScene pack those models again', async () => {
  const { tracer, frame, device } = await ready(),
    a = model('m', [8, 8, 8], (x, y) => (y < 2 ? 1 : 0));
  tracer.setScene(simpleScene({ revision: 2, models: [a] }));
  frame();
  // Same id, revision and size with new voxels: kept (the caller's promise) until invalidated.
  const b = { ...a, voxels: new Uint8Array(512).fill(1) };
  tracer.setScene(simpleScene({ revision: 3, models: [b] }));
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).distance, 18);
  tracer.invalidateModels(['m', 'nothing']);
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).distance, 18, 'the traced scene is unchanged until setScene');
  tracer.setScene(simpleScene({ revision: 4, models: [b] }));
  assert.deepEqual([tracer.stats.packedModels, tracer.stats.reusedModels], [1, 0]);
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).distance, 12);
  // The GPU copy follows: the new bricks are uploaded (a full 8^3 brick of palette 1 is one uniform grid word).
  frame();
  const voxels = device.buffers.filter((x) => x.usage & 128 && !x.destroyed).sort((x, y) => y.size - x.size)[0];
  assert.ok(new Uint32Array(voxels.data).includes(0x80000001));
  tracer.invalidateModels();
  tracer.setScene(simpleScene({ revision: 5, models: [b] }));
  assert.deepEqual([tracer.stats.packedModels, tracer.stats.reusedModels], [1, 0]);
  assert.throws(() => tracer.invalidateModels('m'), TypeError);
  assert.throws(() => tracer.invalidateModels([1]), TypeError);
  tracer.dispose();
  assert.throws(
    () => tracer.invalidateModels(),
    (e) => e.name === 'MargoError' && e.code === 'disposed',
  );
});

test('captures: renders counts queued and running work; whenIdle waits for an aborted one to drain', async () => {
  const { tracer, device, frame } = await ready(),
    controller = new AbortController();
  frame();
  const bytes = tracer.stats.gpuBytes;
  let release;
  device.mapGate = new Promise((r) => {
    release = r;
  });
  const first = tracer.capture({ width: 8, height: 8, samples: 4 }),
    second = tracer.renderImage({ width: 8, height: 8, samples: 4, signal: controller.signal });
  assert.equal(tracer.stats.renders, 2);
  let idle = false;
  const waiting = tracer.whenIdle().then(() => {
    idle = true;
  });
  // The GPU finishes submitted work only when the test says so.
  let drained;
  device.queue.onSubmittedWorkDone = () =>
    new Promise((r) => {
      drained = r;
    });
  controller.abort(new DOMException('stop', 'AbortError'));
  release();
  await first;
  // The aborted render rejects once stopped; its buffers are already released when it does.
  await assert.rejects(second, (e) => {
    assert.equal(tracer.stats.gpuBytes, bytes, 'released before the rejection');
    return e.name === 'AbortError';
  });
  // whenIdle then waits for the GPU's queue.
  await settle();
  assert.equal(tracer.stats.renders, 0);
  assert.equal(idle, false, 'waiting for submitted work');
  drained();
  await waiting;
  assert.equal(idle, true);
  tracer.dispose();
});

test('whenIdle never rejects: after dispose it resolves once pending captures have rejected', async () => {
  const { tracer, device } = await ready();
  let release;
  device.mapGate = new Promise((r) => {
    release = r;
  });
  const job = tracer.capture({ width: 8, height: 8, samples: 2 });
  await settle();
  tracer.dispose();
  release();
  await assert.rejects(job, (e) => e.name === 'MargoError' && e.code === 'disposed');
  await tracer.whenIdle();
  assert.equal(tracer.stats.renders, 0);
});

test('model material tables: a scene holds more than 255 distinct materials; equal tables are stored once', async () => {
  const h = fakeEngine(),
    palette = (shift) =>
      Array.from({ length: 255 }, (_, k) => ({ id: k + 1, type: 'diffuse', color: [(k + shift) / 600, 0.5, 0.25] })),
    a = { ...model('a', [8, 8, 8], (x, y, z) => 1 + ((x + 8 * z) % 255)), materials: palette(0) },
    b = { ...model('b', [8, 8, 8], (x, y, z) => 1 + ((x + 8 * z) % 255)), materials: palette(300) },
    // Equal in content to a's table, another array: stored once.
    c = { ...model('c', [8, 8, 8], () => 7), materials: palette(0) },
    // No table of its own: scene.materials.
    d = model('d', [8, 8, 8], () => 1),
    scene = simpleScene({
      models: [a, b, c, d],
      instances: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, modelId: id, matrix: translate(i * 10, 0, 0) })),
    }),
    tracer = VoxelPathTracer.attach(h.engine, { scene });
  await tracer.ready;
  // The first frame starts compiling the kernels that read model tables (TABLES) and traces nothing meanwhile.
  assert.deepEqual(h.frame(), []);
  let passes = [];
  for (let k = 0; k < 5 && !passes.length; k++) {
    await settle();
    passes = h.frame();
  }
  const pipeline = passes[0].commands.find((c) => c[0] === 'setPipeline')[1];
  assert.equal(pipeline.compute.entryPoint, 'trace');
  assert.deepEqual(pipeline.compute.constants, { TABLES: 1 }, 'traced with the TABLES kernel');
  // A scene without model tables goes back to the base kernel.
  tracer.setScene(simpleScene());
  const base = h.frame()[0].commands.find((c) => c[0] === 'setPipeline')[1];
  assert.equal(base.compute.constants, undefined);
  tracer.setScene(scene);
  h.frame();
  const FLOATS = 32,
    storage = h.device.buffers.filter((x) => !x.destroyed && x.usage & 128),
    tables = storage.find((x) => x.size === 3 * 256 * FLOATS * 4);
  assert.ok(tables, 'three tables: scene.materials, a (and c), b');
  const f = new Float32Array(tables.data);
  // Slot = table << 8 | palette index; colour in the first three floats.
  assert.ok(Math.abs(f[(1 * 256 + 5) * FLOATS] - 4 / 600) < 1e-6, "a's palette 5");
  assert.ok(Math.abs(f[(2 * 256 + 5) * FLOATS] - 304 / 600) < 1e-6, "b's palette 5");
  assert.ok(Math.abs(f[(0 * 256 + 1) * FLOATS] - 0.5) < 1e-6, 'scene.materials palette 1');
  // Model records carry their table (word 7, as table << 8): a 1, b 2, c 1 (shared with a), d 0.
  const scene4 = storage.find((x) => {
    const w = new Uint32Array(x.data);
    return w.length > 4 + 4 * 12 && [8, 8, 8].every((v, k) => w[4 + k] === v) && w[4 + 7] === 1 << 8;
  });
  assert.ok(scene4, 'scene buffer');
  const w = new Uint32Array(scene4.data);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => w[4 + i * 12 + 7] >> 8),
    [1, 2, 1, 0],
  );
  // Picks still name palette indices.
  assert.equal(tracer.raycast([10.5, 20, 0.5], [0, -1, 0]).paletteIndex, 1);
  tracer.dispose();
});

test('model material tables are validated and named in errors; a scene without them packs as before', () => {
  const { tracer } = attach(),
    // A new id: 'm' with its revision and size would reuse the attached scene's packing (the caller's promise).
    m = (materials) =>
      simpleScene({
        models: [{ ...model('p', [8, 8, 8], () => 2), materials }],
        instances: [{ id: 'i', modelId: 'p', matrix: translate(0, 0, 0) }],
      });
  assert.throws(
    () => tracer.setScene(m('red')),
    (e) => e instanceof TypeError && /models\[0\]\.materials must be/.test(e.message),
  );
  assert.throws(
    () =>
      tracer.setScene(
        m([
          { id: 2, type: 'diffuse', color: [1, 1, 1] },
          { id: 2, type: 'diffuse', color: [1, 1, 1] },
        ]),
      ),
    (e) => e instanceof TypeError && /scene\.models\[0\]\.materials\[1\]\.id 2 is used twice/.test(e.message),
  );
  assert.throws(
    () => tracer.setScene(m([{ id: 3, type: 'diffuse', color: [1, 1, 1] }])),
    (e) => e instanceof TypeError && /model 'p'\.materials has no material with id 2/.test(e.message),
  );
  assert.throws(
    () => tracer.setScene(m([{ id: 2, type: 'glass', color: [1, 1, 1], ior: 9 }])),
    (e) => e instanceof RangeError && /scene\.models\[0\]\.materials\[0\]\.ior/.test(e.message),
  );
  // The failed scenes changed nothing.
  assert.equal(tracer.stats.sceneRevision, 1);
  tracer.dispose();
  // Tables over the binding size are refused before anything changes.
  const small = fakeEngine(fakeDevice({ maxStorageBufferBindingSize: 64 << 10 })),
    t2 = VoxelPathTracer.attach(small.engine, { scene: simpleScene() }),
    two = (k) => ({ ...model(`m${k}`, [8, 8, 8], () => 1), materials: materials([1], { color: [k / 10, 0, 0] }) });
  t2.setScene(simpleScene({ models: [two(1)], instances: [{ id: 'i', modelId: 'm1', matrix: translate(0, 0, 0) }] }));
  assert.throws(
    () =>
      t2.setScene(
        simpleScene({
          models: [two(1), two(2)],
          instances: [{ id: 'i', modelId: 'm1', matrix: translate(0, 0, 0) }],
        }),
      ),
    (e) => e instanceof RangeError && /3 material tables need 98304 bytes/.test(e.message),
  );
  t2.dispose();
});

// The voxel buffer and the scene buffer a tracer uploads for `scene` (first frame).
async function uploads(scene) {
  const h = fakeEngine(),
    tracer = VoxelPathTracer.attach(h.engine, { scene });
  await tracer.ready;
  h.frame();
  await settle();
  h.frame();
  const storage = h.device.buffers.filter((x) => !x.destroyed && x.usage & 128).sort((x, y) => y.size - x.size);
  return { tracer, voxels: new Uint32Array(storage[0].data), device: h.device };
}

test('blocks: sparse contents pack exactly as the same voxels given densely', async () => {
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / 16777216,
    size = [40, 20, 30],
    dense = model('m', size, (x, y, z) => (y < 6 + 4 * Math.sin(x * 0.3) ? 1 : random() < 0.02 ? 2 : 0)),
    // The same cells as three blocks (the last overlapping the second, with the same values) and empty gaps.
    block = (o, n) => {
      const voxels = new Uint8Array(n[0] * n[1] * n[2]);
      for (let y = 0; y < n[1]; y++)
        for (let z = 0; z < n[2]; z++)
          for (let x = 0; x < n[0]; x++)
            voxels[x + n[0] * (z + n[2] * y)] = dense.voxels[o[0] + x + size[0] * (o[2] + z + size[2] * (o[1] + y))];
      return { origin: o, size: n, voxels };
    },
    sparse = {
      id: 'm',
      revision: 1,
      size,
      blocks: [block([0, 0, 0], [40, 10, 30]), block([0, 10, 0], [40, 10, 15]), block([0, 10, 10], [40, 10, 20])],
    },
    mats = materials([1, 2]),
    a = await uploads(simpleScene({ models: [dense], materials: mats })),
    b = await uploads(simpleScene({ models: [sparse], materials: mats }));
  assert.deepEqual(b.voxels, a.voxels, 'identical voxel buffers');
  for (const [o, d] of [
    [
      [5.5, 30, 5.5],
      [0, -1, 0],
    ],
    [
      [-5, 3.5, 12.2],
      [1, 0, 0.01],
    ],
    [
      [20, 12, -9],
      [0.1, -0.2, 1],
    ],
  ])
    assert.deepEqual(b.tracer.raycast(o, d), a.tracer.raycast(o, d));
  a.tracer.dispose();
  b.tracer.dispose();
});

test('models up to 2048 per axis: a sparse 2048 x 64 x 2048 world, emitters past cell 255, limits', async () => {
  const lamp = { origin: [1500, 40, 1800], size: [2, 2, 2], voxels: new Uint8Array(8).fill(2) },
    floor = { origin: [0, 0, 0], size: [64, 1, 64], voxels: new Uint8Array(64 * 64).fill(1) },
    world = { id: 'w', revision: 1, size: [2048, 64, 2048], blocks: [floor, lamp] },
    scene = simpleScene({
      models: [world],
      instances: [{ id: 'w', modelId: 'w', matrix: translate(0, 0, 0) }],
      materials: [...materials([1]), { id: 2, type: 'emit', color: [1, 0.9, 0.7], emission: 4 }],
    }),
    { tracer, voxels, device } = await uploads(scene);
  // The brick grid (256 x 8 x 256 words) and a few bricks, in a buffer with room to spare (twice the words): what the
  // blocks hold, not 2048^2 x 64 cells (67 million words of bricks).
  assert.ok(voxels.length <= 2 * (256 * 8 * 256 + 64 * 128) + (1 << 16), `${voxels.length} words`);
  const hit = tracer.raycast([1500.5, 60, 1800.5], [0, -1, 0]);
  assert.deepEqual([hit.cell, hit.paletteIndex], [[1500, 41, 1800], 2]);
  assert.equal(tracer.raycast([30.5, 10, 30.5], [0, -1, 0]).paletteIndex, 1);
  // Emissive faces store x | y << 16 and z | face << 16: the lamp's faces keep their coordinates past 255.
  const scene0 = device.buffers.find((x) => !x.destroyed && x.usage & 128 && new Uint32Array(x.data)[4] === 2048),
    w = new Uint32Array(scene0.data),
    first = w[4 + 8],
    count = w[4 + 9];
  assert.equal(count, 24, 'a 2 x 2 x 2 lamp has 24 outer faces');
  const cells = new Set();
  for (let k = 0; k < count; k++) {
    const c0 = w[first + k * 3],
      c1 = w[first + k * 3 + 1];
    cells.add(`${c0 & 0xffff},${c0 >>> 16},${c1 & 0xffff}`);
    assert.ok(c1 >>> 16 < 6);
  }
  assert.deepEqual([...cells].sort(), [
    '1500,40,1800',
    '1500,40,1801',
    '1500,41,1800',
    '1500,41,1801',
    '1501,40,1800',
    '1501,40,1801',
    '1501,41,1800',
    '1501,41,1801',
  ]);
  tracer.dispose();
  // Over 2048, a brick grid over the binding, blocks outside the model or of the wrong length: refused.
  const t = attach().tracer,
    one = (m) => simpleScene({ models: [m], instances: [{ id: 'i', modelId: m.id, matrix: translate(0, 0, 0) }] });
  assert.throws(() => t.setScene(one({ id: 'x', revision: 1, size: [2049, 1, 1], blocks: [] })), RangeError);
  assert.throws(
    () =>
      t.setScene(
        one({
          id: 'x',
          revision: 1,
          size: [8, 8, 8],
          blocks: [{ origin: [4, 0, 0], size: [5, 1, 1], voxels: new Uint8Array(5) }],
        }),
      ),
    (e) => e instanceof RangeError && /outside the 8x8x8 model/.test(e.message),
  );
  assert.throws(
    () =>
      t.setScene(
        one({
          id: 'x',
          revision: 1,
          size: [8, 8, 8],
          blocks: [{ origin: [0, 0, 0], size: [2, 2, 2], voxels: new Uint8Array(7) }],
        }),
      ),
    (e) => e instanceof TypeError && /blocks\[0\]\.voxels has 7 entries/.test(e.message),
  );
  assert.throws(
    () => t.setScene(one({ id: 'x', revision: 1, size: [8, 8, 8], voxels: new Uint8Array(512), blocks: [] })),
    (e) => e instanceof TypeError && /both voxels and blocks/.test(e.message),
  );
  assert.throws(() => t.setScene(one({ id: 'x', revision: 1, size: [8, 8, 8], blocks: 'none' })), TypeError);
  // Later blocks win where they overlap, zeros included.
  t.setScene(
    one({
      id: 'x',
      revision: 1,
      size: [8, 8, 8],
      blocks: [
        { origin: [0, 0, 0], size: [8, 2, 8], voxels: new Uint8Array(128).fill(1) },
        { origin: [0, 1, 0], size: [4, 1, 8], voxels: new Uint8Array(32) },
      ],
    }),
  );
  assert.equal(t.raycast([1.5, 9, 1.5], [0, -1, 0]).cell[1], 0, 'cleared by the later block');
  assert.equal(t.raycast([6.5, 9, 1.5], [0, -1, 0]).cell[1], 1);
  t.dispose();
  const small = fakeEngine(fakeDevice({ maxStorageBufferBindingSize: 1 << 20 })),
    t2 = VoxelPathTracer.attach(small.engine, { scene: simpleScene() });
  assert.throws(
    () => t2.setScene(one({ id: 'x', revision: 1, size: [2048, 64, 2048], blocks: [] })),
    (e) => e instanceof RangeError && /brick grid/.test(e.message),
  );
  t2.dispose();
});
