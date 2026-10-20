// Scene validation, snapshots and voxel traversal of @margoengine/voxel-pathtracer through its public API: attach and
// setScene errors (and that a failed setScene keeps the current scene), dense indexing, palette identities,
// transformed and hidden instances, model reuse by id and revision, and VoxelPathTracer.raycast against a brute-force
// slab-test oracle on random models whose sizes are not multiples of the 8-voxel brick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelPathTracer } from '../dist/index.js';
import { bruteForce, fakeEngine, materials, model, simpleScene, translate } from './support.js';

const attach = (scene, options = {}) => {
  const { engine } = fakeEngine();
  return { tracer: VoxelPathTracer.attach(engine, { scene, ...options }), engine };
};
const isMargo = (code) => (error) => error.name === 'MargoError' && error.code === code;

test('attach rejects malformed options and scenes without attaching anything', () => {
  const { engine, frame } = fakeEngine();
  const cases = [
    [undefined, TypeError],
    [{ scene: null }, TypeError],
    [{ scene: simpleScene(), samplesPerFrame: 0 }, RangeError],
    [{ scene: simpleScene(), samplesPerFrame: 1.5 }, RangeError],
    [{ scene: simpleScene(), maxBounces: 65 }, RangeError],
    [{ scene: simpleScene(), maxSamples: 0 }, RangeError],
    [{ scene: simpleScene(), seed: -1 }, RangeError],
    [{ scene: simpleScene(), resolutionScale: 3 }, RangeError],
    [{ scene: simpleScene(), exposure: 'x' }, TypeError],
    [{ scene: simpleScene(), aperture: -1 }, RangeError],
    [{ scene: simpleScene(), focusDistance: 0 }, RangeError],
    [{ scene: simpleScene(), denoise: 1 }, TypeError],
    [{ scene: simpleScene(), lensBlades: 2 }, RangeError],
    [{ scene: simpleScene(), shutter: 2 }, RangeError],
    [{ scene: simpleScene(), clamp: 0 }, RangeError],
    [{ scene: simpleScene(), toneMapping: 'filmic' }, TypeError],
  ];
  for (const [options, type] of cases)
    assert.throws(() => VoxelPathTracer.attach(engine, options), type, JSON.stringify(options));
  assert.equal(engine.plugins.size, 0);
  assert.deepEqual(frame(), [], 'no pass left behind');
});

test('scene validation names the problem: shapes are TypeError, values RangeError', () => {
  const base = simpleScene();
  const bad = [
    [{ ...base, revision: 'one' }, TypeError, /revision/],
    [{ ...base, models: {} }, TypeError, /models must be an array/],
    [{ ...base, models: [base.models[0], base.models[0]] }, TypeError, /'m' is used twice/],
    [{ ...base, instances: [base.instances[0], base.instances[0]] }, TypeError, /'a' is used twice/],
    [{ ...base, materials: [...base.materials, ...base.materials] }, TypeError, /id 1 is used twice/],
    [
      { ...base, instances: [{ id: 'a', modelId: 'nope', matrix: translate(0, 0, 0) }] },
      TypeError,
      /'nope' names no model/,
    ],
    [
      { ...base, models: [{ ...base.models[0], voxels: new Uint8Array(10) }] },
      TypeError,
      /has 10 entries; a 8x8x8 model needs 512/,
    ],
    [{ ...base, models: [{ ...base.models[0], voxels: [1, 2] }] }, TypeError, /Uint8Array/],
    [{ ...base, models: [model('m', [257, 1, 1], () => 0)] }, RangeError, /1 to 256/],
    [{ ...base, models: [{ ...base.models[0], size: [8, 0, 8] }] }, RangeError, /1 to 256/],
    [{ ...base, models: [{ ...base.models[0], size: [8, 7.5, 8] }] }, RangeError, /integers/],
    [{ ...base, instances: [{ id: 'a', modelId: 'm', matrix: [1, 0, 0] }] }, TypeError, /16 numbers/],
    [{ ...base, instances: [{ id: 'a', modelId: 'm', matrix: translate(0, NaN, 0) }] }, RangeError, /not finite/],
    [{ ...base, instances: [{ id: 'a', modelId: 'm', matrix: translate(0, 0, 0, 0) }] }, RangeError, /singular/],
    [
      { ...base, instances: [{ id: 'a', modelId: 'm', matrix: [1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] },
      RangeError,
      /not affine/,
    ],
    [{ ...base, instances: [{ id: '', modelId: 'm', matrix: translate(0, 0, 0) }] }, TypeError, /non-empty string/],
    [
      { ...base, materials: [] },
      TypeError,
      /palette index 1 \(128 voxels\) but scene\.materials has no material with id 1/,
    ],
    [{ ...base, materials: [{ id: 0, color: [1, 1, 1], type: 'diffuse' }] }, RangeError, /outside 1 to 255/],
    [{ ...base, materials: [{ id: 1, color: [1, -1, 1], type: 'diffuse' }] }, RangeError, /0 or more/],
    [{ ...base, materials: [{ id: 1, color: [1, 1, 1], type: 'chrome' }] }, TypeError, /unknown/],
    [{ ...base, materials: [{ id: 1, color: [1, 1, 1], type: 'glass', ior: 0.5 }] }, RangeError, /ior/],
    [{ ...base, materials: [{ id: 1, color: [1, 1, 1], type: 'metal', roughness: 2 }] }, RangeError, /roughness/],
    [{ ...base, materials: [{ id: 1, color: [1, 1, 1], type: 'media', anisotropy: 1 }] }, RangeError, /anisotropy/],
    [{ ...base, environment: { sunDirection: [0, 0, 0] } }, RangeError, /sunDirection is zero/],
    [{ ...base, environment: { sunAngularSize: 1 } }, RangeError, /sunAngularSize/],
    [{ ...base, environment: { fadeModels: 1 } }, TypeError, /fadeModels must be true or false/],
    [
      { ...base, environment: { physicalSky: { horizonBelow: 'yes' } } },
      TypeError,
      /horizonBelow must be true or false/,
    ],
    [{ ...base, environment: { map: { width: 2, height: 1, data: new Float32Array(5) } } }, TypeError, /has 5 floats/],
    [
      { ...base, environment: { map: { width: 1, height: 1, data: new Float32Array([1, -1, 1]) } } },
      RangeError,
      /negative or not finite/,
    ],
    [
      { ...base, lights: [{ id: 'l', position: [0, 0, 0], edgeU: [1, 0, 0], edgeV: [2, 0, 0] }] },
      RangeError,
      /no area/,
    ],
    [
      {
        ...base,
        lights: [
          { id: 'l', position: [0, 0, 0], edgeU: [1, 0, 0], edgeV: [0, 0, 1] },
          { id: 'l', position: [0, 0, 0], edgeU: [1, 0, 0], edgeV: [0, 0, 1] },
        ],
      },
      TypeError,
      /'l' is used twice/,
    ],
  ];
  const { tracer } = attach(base);
  for (const [scene, type, message] of bad) {
    assert.throws(
      () => tracer.setScene(scene),
      (error) => error instanceof type && message.test(error.message) && error.message.startsWith('VoxelPathTracer'),
      String(message),
    );
    // The scene in place is untouched: the old model still answers.
    assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0])?.paletteIndex, 1);
    assert.equal(tracer.stats.sceneRevision, 1);
  }
  tracer.dispose();
});

test('a failed setScene keeps the previous scene, its packed models and its accumulation', () => {
  const { tracer } = attach(simpleScene());
  const next = simpleScene({ revision: 2, models: [model('m', [8, 8, 8], (x, y) => (y < 4 ? 1 : 0), 2)] });
  tracer.setScene(next);
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).distance, 16);
  assert.throws(() => tracer.setScene({ ...next, revision: 3, materials: [] }), TypeError);
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).distance, 16);
  assert.equal(tracer.stats.sceneRevision, 2);
  tracer.dispose();
});

test('caller arrays are never changed; the scene is a copy', () => {
  const scene = simpleScene(),
    voxels = scene.models[0].voxels.slice(),
    matrix = scene.instances[0].matrix.slice();
  const { tracer } = attach(scene);
  assert.deepEqual(scene.models[0].voxels, voxels);
  assert.deepEqual(scene.instances[0].matrix, matrix);
  // Changing the caller's arrays afterwards does not change what is traced.
  scene.instances[0].matrix[13] = 100;
  scene.models[0].voxels.fill(0);
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).distance, 18);
  tracer.dispose();
});

test('dense indexing: index = x + sx * (z + sz * y), y up, every cell found with its palette index', () => {
  const size = [5, 7, 3],
    cells = [];
  for (let y = 0; y < 7; y++) for (let z = 0; z < 3; z++) for (let x = 0; x < 5; x++) cells.push([x, y, z]);
  const { tracer } = attach(simpleScene({ models: [model('m', [5, 7, 3], () => 0)], materials: materials([1]) }));
  for (const [i, cell] of cells.entries()) {
    if (i % 7) continue;
    const voxels = new Uint8Array(5 * 7 * 3);
    voxels[cell[0] + 5 * (cell[2] + 3 * cell[1])] = 1;
    tracer.setScene(simpleScene({ revision: i, models: [{ id: 'm', revision: i, size, voxels }] }));
    // From above: lands on top of the cell.
    const hit = tracer.raycast([cell[0] + 0.5, 50, cell[2] + 0.5], [0, -1, 0]);
    assert.deepEqual(hit.cell, cell);
    assert.deepEqual(hit.normal, [0, 1, 0]);
    assert.deepEqual(hit.adjacent, [cell[0], cell[1] + 1, cell[2]]);
    assert.equal(hit.distance, 50 - cell[1] - 1);
    // From +x: lands on its +x face.
    const side = tracer.raycast([40, cell[1] + 0.5, cell[2] + 0.5], [-1, 0, 0]);
    assert.deepEqual(side.cell, cell);
    assert.deepEqual(side.normal, [1, 0, 0]);
    assert.equal(side.distance, 40 - cell[0] - 1);
  }
  tracer.dispose();
});

test('palette identities: all 255 occupied indices come back unchanged', () => {
  const m = model('p', [255, 1, 1], (x) => x + 1),
    { tracer } = attach({
      revision: 1,
      models: [m],
      instances: [{ id: 'i', modelId: 'p', matrix: translate(0, 0, 0) }],
      materials: Array.from({ length: 255 }, (_, k) => ({ id: k + 1, color: [k / 255, 0, 0], type: 'diffuse' })),
    });
  for (let x = 0; x < 255; x++) assert.equal(tracer.raycast([x + 0.5, 9, 0.5], [0, -1, 0]).paletteIndex, x + 1);
  tracer.dispose();
});

test('transformed instances share one model and keep their identity', () => {
  const m = model('m', [4, 4, 4], (x, y, z) => (x === 0 && y === 0 && z === 0 ? 7 : 0)),
    rot = (a) => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1],
    scaled = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0.5, 0, 10, 0, 0, 1],
    mirrored = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -10, 0, 0, 1],
    rotated = rot(Math.PI / 2).map((v, i) => (i === 12 ? 20 : v));
  const { tracer } = attach({
    revision: 1,
    models: [m],
    instances: [
      { id: 'scaled', modelId: 'm', matrix: scaled },
      { id: 'mirrored', modelId: 'm', matrix: mirrored },
      { id: 'rotated', modelId: 'm', matrix: rotated },
      { id: 'hidden', modelId: 'm', matrix: translate(30, 0, 0), visible: false },
    ],
    materials: materials([7]),
  });
  // Scaled: voxel 0 covers x 10..12, y 0..3, z 0..0.5.
  let hit = tracer.raycast([11, 10, 0.25], [0, -1, 0]);
  assert.equal(hit.instanceId, 'scaled');
  assert.equal(hit.modelId, 'm');
  assert.deepEqual(hit.cell, [0, 0, 0]);
  assert.ok(Math.abs(hit.distance - 7) < 1e-9, hit.distance);
  assert.deepEqual(hit.normal, [0, 1, 0]);
  // Mirrored in x: voxel 0 covers x -11..-10.
  hit = tracer.raycast([-10.5, 10, 0.5], [0, -1, 0]);
  assert.equal(hit.instanceId, 'mirrored');
  assert.ok(Math.abs(hit.point[1] - 1) < 1e-9);
  hit = tracer.raycast([-20, 0.5, 0.5], [1, 0, 0]);
  assert.equal(hit.instanceId, 'mirrored');
  assert.deepEqual(hit.normal, [1, 0, 0], 'the face toward the ray in model space (+x is world -x)');
  assert.ok(Math.abs(hit.distance - 9) < 1e-9);
  // Rotated 90 degrees about y and moved to x 20: model z runs along world x, model x along world -z.
  hit = tracer.raycast([20.5, 10, -0.5], [0, -1, 0]);
  assert.equal(hit.instanceId, 'rotated');
  assert.deepEqual(hit.cell, [0, 0, 0]);
  // Hidden instances are not traced.
  assert.equal(tracer.raycast([30.5, 10, 0.5], [0, -1, 0]), null);
  tracer.dispose();
});

test('empty scenes trace nothing and raycast finds nothing', () => {
  const { tracer } = attach({ revision: 0, models: [], instances: [], materials: [] });
  assert.equal(tracer.raycast([0, 0, 0], [0, 0, -1]), null);
  tracer.setScene({
    revision: 1,
    models: [model('e', [3, 3, 3], () => 0)],
    instances: [{ id: 'i', modelId: 'e', matrix: translate(0, 0, 0) }],
    materials: [],
  });
  assert.equal(tracer.raycast([1.5, 10, 1.5], [0, -1, 0]), null);
  tracer.dispose();
});

test('models are reused by id, revision and size; a new revision is packed again', () => {
  const a = model('m', [8, 8, 8], (x, y) => (y < 2 ? 1 : 0)),
    { tracer } = attach(simpleScene({ models: [a] }));
  // Same id and revision with different voxels: documented as unchanged content, so the packed copy is kept.
  tracer.setScene(simpleScene({ revision: 2, models: [{ ...a, voxels: new Uint8Array(512).fill(1) }] }));
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).distance, 18);
  tracer.setScene(simpleScene({ revision: 3, models: [{ ...a, revision: 2, voxels: new Uint8Array(512).fill(1) }] }));
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).distance, 12);
  tracer.dispose();
});

test('traversal matches a brute-force slab test on random models across brick boundaries', () => {
  let seed = 12345;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
  for (const [size, density] of [
    [[13, 9, 21], 0.04],
    [[1, 1, 1], 1],
    [[17, 33, 8], 0.03],
    [[40, 3, 40], 0.02],
    [[9, 9, 9], 0.3],
  ]) {
    const m = model('r', size, () => (random() < density ? 1 + Math.floor(random() * 5) : 0)),
      { tracer } = attach({
        revision: 1,
        models: [m],
        instances: [{ id: 'i', modelId: 'r', matrix: translate(0, 0, 0) }],
        materials: materials([1, 2, 3, 4, 5]),
      });
    let hits = 0;
    for (let k = 0; k < 400; k++) {
      // Origins outside, inside and on the box; directions random, axis-aligned or grazing.
      const o = size.map((s) => (random() * 1.6 - 0.3) * s),
        kind = k % 4,
        d =
          kind === 0
            ? [random() - 0.5, random() - 0.5, random() - 0.5]
            : kind === 1
              ? [
                  [1, 0, 0],
                  [0, -1, 0],
                  [0, 0, 1],
                ][k % 3]
              : [random() - 0.5, 1e-4 * (random() - 0.5), random() - 0.5];
      if (kind === 3) o[k % 3] = Math.floor(o[k % 3]) + 0.5;
      const length = Math.hypot(...d),
        unit = d.map((v) => v / length),
        expected = bruteForce(m, o, unit),
        hit = tracer.raycast(o, unit);
      if (!expected) {
        assert.equal(hit, null, `${size} ray ${k}: ${o} ${unit} found ${JSON.stringify(hit)}`);
        continue;
      }
      hits++;
      assert.ok(hit, `${size} ray ${k}: missed ${JSON.stringify(expected)}`);
      assert.ok(Math.abs(hit.distance - expected.t) < 1e-6, `${size} ray ${k}: t ${hit.distance} vs ${expected.t}`);
      // Ties (a ray through an edge or corner) may report either cell; the distance must agree.
      const v = m.voxels[hit.cell[0] + size[0] * (hit.cell[2] + size[2] * hit.cell[1])];
      assert.ok(v > 0, `${size} ray ${k}: reported an empty cell ${hit.cell}`);
      assert.equal(hit.paletteIndex, v);
    }
    assert.ok(hits > 20, `${size}: only ${hits} rays hit`);
    tracer.dispose();
  }
});

test('setScene, setOptions, reset and raycast throw MargoError disposed after dispose; dispose repeats safely', () => {
  const { tracer, engine } = attach(simpleScene());
  tracer.dispose();
  tracer.dispose();
  assert.equal(engine.plugins.size, 0);
  assert.throws(() => tracer.setScene(simpleScene()), isMargo('disposed'));
  assert.throws(() => tracer.setOptions({ exposure: 1 }), isMargo('disposed'));
  assert.throws(() => tracer.reset(), isMargo('disposed'));
  assert.throws(() => tracer.raycast([0, 0, 0], [0, 1, 0]), isMargo('disposed'));
  assert.equal(tracer.status, 'disposed');
});

test('scenes over the device storage binding limit are rejected before anything changes', () => {
  const { engine } = fakeEngine(),
    big = model('big', [256, 64, 256], (x, y, z) => ((x ^ y ^ z) & 1 ? 1 : 0));
  const tracer = VoxelPathTracer.attach(engine, { scene: simpleScene() });
  // 32 x 8 x 32 mixed bricks of 512 bytes = 4 MiB; a device that binds 1 MiB refuses it.
  engine.gpu.limits.maxStorageBufferBindingSize = 1 << 20;
  tracer.onDeviceRestored(engine);
  assert.throws(
    () =>
      tracer.setScene(
        simpleScene({
          revision: 2,
          models: [big],
          instances: [{ id: 'a', modelId: 'big', matrix: translate(0, 0, 0) }],
        }),
      ),
    (error) => error instanceof RangeError && /binds at most 1048576/.test(error.message),
  );
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).distance, 18);
  // An environment map whose texels need more than 1 MiB, and emissive faces whose tables do, are refused too.
  assert.throws(
    () =>
      tracer.setScene(
        simpleScene({ environment: { map: { width: 300, height: 256, data: new Float32Array(300 * 256 * 3) } } }),
      ),
    (error) => error instanceof RangeError && /pass a smaller map/.test(error.message),
  );
  const glow = model('glow', [64, 64, 64], (x, y, z) => ((x ^ y ^ z) & 1 ? 1 : 0));
  assert.throws(
    () =>
      tracer.setScene(
        simpleScene({
          models: [glow],
          instances: [{ id: 'a', modelId: 'glow', matrix: translate(0, 0, 0) }],
          materials: [{ id: 1, color: [1, 1, 1], type: 'emit' }],
        }),
      ),
    (error) => error instanceof RangeError && /786432 emissive voxel faces/.test(error.message),
  );
  assert.equal(tracer.raycast([4.5, 20, 4.5], [0, -1, 0]).distance, 18);
  tracer.dispose();
});
