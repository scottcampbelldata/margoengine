import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { LODSystem } from '../dist/index.js';

// Level-choice vectors (lod-hysteresis spec). Distance steps: [cameraZ, level] or [cameraZ, level, bias] with the
// anchor at z = -10; levels are [distance] or [distance, hysteresis]. Screen steps: [anchorDistance, scale, level].
const sequences = [
  {
    label: 'distance 20/50/100, system hysteresis 0.2',
    options: { hysteresis: 0.2 },
    levels: [[20], [50], [100]],
    steps: [
      [0, 0],
      [10.5, 1],
      [8, 1],
      [6.1, 1],
      [5.9, 0],
      [5, 0],
      [40, 2],
      [39.9, 2],
      [30.1, 2],
      [29.9, 1],
      [50, 2],
      [95, 3],
      [75, 3],
      [71, 3],
      [69.9, 2],
      [0, 0],
      [200, 3],
    ],
  },
  {
    label: 'distance 20/50/100, default hysteresis (0.1)',
    options: {},
    levels: [[20], [50], [100]],
    steps: [
      [0, 0],
      [9.99, 0],
      [10, 1],
      [9, 1],
      [8.01, 1],
      [7.99, 0],
      [39.99, 1],
      [40, 2],
      [35.01, 2],
      [34.99, 1],
      [89.99, 2],
      [90, 3],
      [80.01, 3],
      [79.99, 2],
      [-100, 2],
    ],
  },
  {
    label: 'distance 20/50, hysteresis 0',
    options: { hysteresis: 0 },
    levels: [[20], [50]],
    steps: [
      [0, 0],
      [9.999, 0],
      [10, 1],
      [9.999, 0],
      [40, 2],
      [39.999, 1],
    ],
  },
  {
    label: 'per-level hysteresis: level 1 0.5, level 2 0',
    options: { hysteresis: 0.1 },
    levels: [
      [20, 0.5],
      [50, 0],
    ],
    steps: [
      [0, 0],
      [10, 1],
      [5, 1],
      [0.1, 1],
      [-0.1, 0],
      [40, 2],
      [39.999, 1],
      [10, 1],
      [0.1, 1],
      [-0.1, 0],
    ],
  },
  {
    // Distance 18 with level 2 shown is inside level 2's band [18, inf): this rule keeps 2 (the recorded vector, 0,
    // is the one step the spec leaves free).
    label: 'equal thresholds 20/20',
    options: { hysteresis: 0.1 },
    levels: [[20], [20]],
    steps: [
      [0, 0],
      [10, 2],
      [8, 2],
      [7.9, 0],
      [0, 0],
    ],
  },
  {
    label: 'jump past several levels at once from -1 (first frame far away)',
    options: { hysteresis: 0.25 },
    levels: [[5], [10], [15]],
    steps: [
      [100, 3],
      [-5, 1],
      [0, 2],
      [-9, 0],
    ],
  },
  {
    label: 'bias multiplies the distance; hysteresis 0.2; levels 20/50',
    options: { hysteresis: 0.2 },
    levels: [[20], [50]],
    steps: [
      [0, 0, 1],
      [1, 1, 2],
      [0, 1, 2],
      [-2.1, 0, 2],
      [30, 1, 0.5],
      [31, 1, 0.5],
      [31, 1, 1],
    ],
  },
];
const screenSteps = [
  [3, 1, 0],
  [5.939999893387505, 1, 0],
  [6.059999891233717, 1, 1],
  [5.69999989769508, 1, 1],
  [5.099999908464019, 1, 0],
  [12.119999782467435, 1, 2],
  [12.119999782467435, 2, 1],
  [12.119999782467435, 0.5, 2],
];

async function engine() {
  const store = await TransformStore.create(16),
    renderer = { backend: 'webgpu', gpu: null, add() {}, remove() {}, render() {}, dispose() {} };
  return new Engine(
    { width: 400, height: 200, clientWidth: 400, clientHeight: 200 },
    store,
    renderer,
    { position: [0, 0, 0], target: [0, 0, -1], far: 5000 },
    null,
  );
}

for (const { label, options, levels, steps } of sequences)
  test(`hysteresis vectors: ${label}`, async () => {
    const e = await engine(),
      lods = new LODSystem(options);
    e.use(lods);
    const anchor = e.createMesh().setPosition([0, 0, -10]);
    const lod = lods.add(anchor, [
      { object: null },
      ...levels.map(([distance, hysteresis]) => ({ object: null, distance, hysteresis })),
    ]);
    steps.forEach(([z, level, bias = 1], k) => {
      lods.bias = bias;
      e.camera.position = [0, 0, z];
      e.camera.target = [0, 0, z - 1];
      lods.update();
      assert.equal(lod.level, level, `step ${k}: camera z ${z}`);
    });
    e.dispose();
  });

test('hysteresis vectors: screen levels 0.5/0.25, box(2,2,2) radius, hysteresis 0.1', async () => {
  const e = await engine(),
    lods = new LODSystem({ hysteresis: 0.1 });
  e.use(lods);
  const anchor = e.createMesh(),
    lod = lods.add(anchor, [{ object: box(2, 2, 2) }, { object: null, screen: 0.5 }, { object: null, screen: 0.25 }]);
  const at = (distance, scale) => {
    anchor.setPosition([0, 0, -distance]).setScale(scale);
    e.store.tick(false);
    lods.update();
    return lod.level;
  };
  screenSteps.forEach(([distance, scale, level], k) =>
    assert.equal(at(distance, [scale, scale, scale]), level, `step ${k}`),
  );
  assert.equal(at(17.999999676931832, [1, 1.6, 1]), 2, 'non-uniform scale uses the largest axis');
  e.dispose();
});

test('the shown level holds without writes for a fixed metric and never oscillates', async () => {
  const e = await engine(),
    lods = new LODSystem({ hysteresis: 0.3 });
  e.use(lods);
  const anchor = e.createMesh().setPosition([0, 0, -10]);
  const lod = lods.add(anchor, [
    { object: null },
    { object: null, distance: 10 },
    { object: null, distance: 12 },
    { object: null, distance: 30, hysteresis: 0.9 },
  ]);
  let writes = 0;
  const show = lods.show;
  lods.show = function (...args) {
    writes++;
    return show.apply(this, args);
  };
  // Sweep out and back: every level change is one write, repeated updates at one spot add none.
  for (const d of [0, 5, 10, 11, 12, 20, 29, 30, 40, 30, 20, 4, 3.5, 2.9, 1, 12, 9]) {
    e.camera.position = [0, 0, d - 10];
    lods.update();
    const level = lod.level,
      before = writes;
    for (let k = 0; k < 3; k++) lods.update();
    assert.equal(lod.level, level, `distance ${d} is stable`);
    assert.equal(writes, before, `distance ${d} makes no extra writes`);
  }
  // Level 3's 0.9 band keeps it down to 3 world units (3.1 here), then the plain pick applies.
  e.camera.position = [0, 0, 40 - 10];
  lods.update();
  e.camera.position = [0, 0, 3.1 - 10];
  lods.update();
  assert.equal(lod.level, 3);
  e.camera.position = [0, 0, 2.9 - 10];
  lods.update();
  assert.equal(lod.level, 0);
  e.dispose();
});

test('an object exactly at an authored switch distance takes the coarser level', async () => {
  const e = await engine(),
    lods = new LODSystem({ hysteresis: 0 });
  e.use(lods);
  // sqrt(5) rounds up to float32, above the distance an object at exactly sqrt(5) has.
  e.camera.position = [0, 0, 0];
  e.camera.target = [0, 0, -1];
  const far = lods.add(e.createMesh().setPosition([1, 2, 0]), [{ object: null }, { object: null, distance: Math.sqrt(5) }]);
  lods.update();
  assert.equal(far.level, 1, 'distance sqrt(5): equality counts');
  assert.ok(Math.fround(Math.sqrt(5)) > Math.sqrt(5));
  e.dispose();
});

test('a single level always picks 0', async () => {
  const e = await engine(),
    lods = new LODSystem();
  e.use(lods);
  const anchor = e.createMesh().setPosition([0, 0, -10]);
  const single = lods.add(anchor, [{ object: null }]);
  e.camera.position = [0, 0, 1e9];
  lods.update();
  assert.equal(single.level, 0);
  e.dispose();
});
