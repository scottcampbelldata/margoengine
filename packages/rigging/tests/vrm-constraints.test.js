import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateVRMConstraint, readVRMConstraints, addVRMConstraints } from '../dist/vrm-constraints.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import { Animation } from '../../animation/dist/index.js';
import { Animator } from '../../animator/dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
const reference = JSON.parse(
  readFileSync(new URL('../../../docs/whitepaper/results/batch213-constraint-public-values.json', import.meta.url)),
);
const identity = [0, 0, 0, 1],
  turn = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
function close(actual, expected, epsilon = 1e-12) {
  const sign = actual.reduce((sum, v, k) => sum + v * expected[k], 0) < 0 ? -1 : 1;
  actual.forEach((value, k) => assert.ok(Math.abs(value * sign - expected[k]) < epsilon, `${actual} != ${expected}`));
}
for (const row of reference.rows)
  test(`public constraint ${row.kind} ${row.axis} rest ${row.seed} weight ${row.weight}`, () => {
    const original = structuredClone(row);
    close(evaluateVRMConstraint(row, { ...row, sourceRotation: row.sourceCurrent }), row.expected);
    assert.deepEqual(row, original);
  });
const extension = (kind, source, extra = {}) => ({
  VRMC_node_constraint: { specVersion: '1.0', constraint: { [kind]: { source, ...extra } } },
});
test('reader owns independent live weights, immutable references and no source mutation', () => {
  const document = { nodes: [{}, { extensions: extension('rotation', 0) }] },
    before = structuredClone(document),
    constraints = readVRMConstraints(document);
  assert.equal(constraints[0].weight, 1);
  constraints[0].weight = 0.5;
  assert.throws(() => (constraints[0].source = 1), TypeError);
  assert.deepEqual(document, before);
  assert.deepEqual(readVRMConstraints({}), []);
  document.nodes[1].extensions.VRMC_node_constraint.constraint.extras = { author: 'retained metadata' };
  assert.equal(readVRMConstraints(document).length, 1);
  document.nodes[1].extensions.VRMC_node_constraint.constraint.rotation.weight = null;
  assert.throws(() => readVRMConstraints(document), RangeError);
});
test('reader rejects invalid versions, kinds, references, weights, axes and hierarchy before attachment', () => {
  const invalid = [
    null,
    { nodes: 2 },
    { nodes: [null] },
    { nodes: [{ children: 2 }] },
    { nodes: [{ children: [1] }, { children: [0] }] },
    { nodes: [{ children: [2] }, { children: [2] }, {}] },
  ];
  for (const change of [
    (e) => (e.specVersion = '2.0'),
    (e) => (e.constraint = {}),
    (e) => (e.constraint.aim = { source: 0, aimAxis: 'PositiveX' }),
    (e) => (e.constraint.rotation.source = 1),
    (e) => (e.constraint.rotation.source = 3),
    (e) => (e.constraint.rotation.weight = NaN),
    (e) => (e.constraint.rotation.weight = -1),
    (e) => (e.constraint = { roll: { source: 0, rollAxis: 'PositiveX' } }),
    (e) => (e.constraint = { aim: { source: 0, aimAxis: 'X' } }),
  ]) {
    const doc = { nodes: [{}, { extensions: extension('rotation', 0) }] };
    change(doc.nodes[1].extensions.VRMC_node_constraint);
    invalid.push(doc);
  }
  for (const doc of invalid) assert.throws(() => readVRMConstraints(doc));
});
test('direct and parent-mediated constraint cycles reject independently of declaration order', () => {
  assert.throws(
    () =>
      readVRMConstraints({
        nodes: [{ extensions: extension('rotation', 1) }, { extensions: extension('rotation', 0) }],
      }),
    /circular/,
  );
  assert.throws(
    () =>
      readVRMConstraints({ nodes: [{ children: [1], extensions: extension('aim', 1, { aimAxis: 'PositiveX' }) }, {}] }),
    /circular/,
  );
});
test('singular aim holds rest and pure half-turn swing has a finite deterministic zero twist', () => {
  const frame = {
    sourceRest: identity,
    destinationRest: identity,
    sourceRotation: identity,
    sourceWorldPosition: [1, 2, 3],
    destinationWorldPosition: [1, 2, 3],
  };
  close(evaluateVRMConstraint({ kind: 'aim', axis: 'PositiveX', weight: 1 }, frame), identity);
  close(
    evaluateVRMConstraint({ kind: 'roll', axis: 'X', weight: 1 }, { ...frame, sourceRotation: [0, 1, 0, 0] }),
    identity,
  );
  close(
    evaluateVRMConstraint({ kind: 'roll', axis: 'X', weight: 1 }, { ...frame, sourceRotation: [1e-17, 1, 0, 1e-17] }),
    [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  );
  assert.throws(
    () => evaluateVRMConstraint({ kind: 'rotation', weight: 1 }, { ...frame, sourceRotation: [0, 0, 0, 0] }),
    /nonzero/,
  );
});
async function fixture(secondary = false) {
  const gpu = optionalGPU(),
    store = await TransformStore.create(64),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  const data = animatedTriangle();
  delete data.doc.skins;
  delete data.doc.nodes[0].skin;
  data.doc.nodes.push(
    { rotation: identity, extensions: extension('rotation', 0) },
    { rotation: identity, extensions: extension('rotation', 4) },
    { rotation: identity, extensions: extension('rotation', 2) },
  );
  data.doc.scenes = [{ nodes: [0, 2, 3, 4] }];
  const rotations = new Float32Array([...identity, ...turn]),
    buffer = data.buffers.length,
    view = data.doc.bufferViews.length,
    accessor = data.doc.accessors.length;
  data.buffers.push(rotations);
  data.doc.buffers.push({ byteLength: rotations.byteLength });
  data.doc.bufferViews.push({ buffer, byteLength: rotations.byteLength });
  data.doc.accessors.push({ bufferView: view, componentType: 5126, count: 2, type: 'VEC4' });
  data.doc.animations[0].channels[0].target = { node: 0, path: 'rotation' };
  data.doc.animations[0].samplers[0].output = accessor;
  const owner = secondary ? engine.createScene('avatar') : engine.scene;
  let model;
  owner.use({
    name: 'fixture-loader',
    setup() {
      model = parseGLTF(engine, data.doc, data.buffers);
    },
  });
  return { engine, model, owner };
}
function local(node) {
  node.syncRotation();
  const t = node.engine.store.transforms,
    i = node.id;
  return [t.qx[i], t.qy[i], t.qz[i], t.qw[i]];
}
test('runtime resolves reversed chains in one update and validates all weights before writing', async () => {
  const f = await fixture(),
    handle = addVRMConstraints(f.model);
  try {
    f.model.nodes[0].setQuaternion(turn);
    handle.update();
    for (const i of [2, 3, 4]) close(local(f.model.nodes[i]), turn, 1e-7);
    handle.constraints[2].weight = NaN;
    f.model.nodes[0].setQuaternion(identity);
    assert.throws(() => handle.update(), /weight/);
    close(local(f.model.nodes[2]), turn, 1e-7);
    handle.constraints[2].weight = 1;
    handle.dispose();
    close(local(f.model.nodes[2]), identity);
    assert.equal(f.model.disposed, false);
    assert.throws(() => handle.update(), /disposed/);
  } finally {
    f.engine.dispose();
  }
});
test('controller registers in the model scene and model-first disposal detaches it', async () => {
  const f = await fixture(true);
  const handle = addVRMConstraints(f.model);
  assert.ok([...f.owner.plugins.keys()].some((name) => name.startsWith('vrm-constraints:')));
  assert.ok(![...f.engine.scene.plugins.keys()].some((name) => name.startsWith('vrm-constraints:')));
  assert.equal(handle.disposed, false);
  f.model.dispose();
  assert.equal(handle.disposed, true);
  handle.dispose();
  f.engine.dispose();
});
test('Animator evaluates constraints after its clip and disposal works after Animator disposal', async () => {
  const f = await fixture(),
    animation = Animation.attach(f.model),
    animator = Animator.attach(animation, { states: { idle: animation.clips[0].name }, initial: 'idle' }),
    handle = addVRMConstraints(f.model, { animator });
  try {
    animator.onPreUpdate(0.25);
    assert.ok(Math.abs(local(f.model.nodes[0])[2]) > 0.1, 'clip advanced before constraints');
    close(local(f.model.nodes[2]), local(f.model.nodes[0]), 1e-7);
    animator.dispose();
    handle.dispose();
    assert.equal(handle.disposed, true);
  } finally {
    f.engine.dispose();
  }
});
