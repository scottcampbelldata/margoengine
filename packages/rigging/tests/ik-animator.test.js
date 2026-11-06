// addIKChain on an Animator: a FABRIK chain with a pole reaches a moving target every frame on an animated skinned
// skeleton under a moved, turned and scaled model root, and the elbow stays on the pole's side.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Animation } from '../../animation/dist/index.js';
import { Animator } from '../../animator/dist/index.js';
import { addIKChain } from '../dist/ik.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';

// Joint (node 1) -> Upper (2) -> Lower (3) -> Hand (4); the Wave clip turns Upper about z.
function skeleton() {
  const result = animatedTriangle(),
    { doc, buffers } = result;
  const add = (values, type) => {
    const data = new Float32Array(values);
    buffers.push(data);
    doc.buffers.push({ byteLength: data.byteLength });
    doc.bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    doc.accessors.push({
      bufferView: doc.bufferViews.length - 1,
      componentType: 5126,
      count: data.length / { SCALAR: 1, VEC4: 4 }[type],
      type,
    });
    return doc.accessors.length - 1;
  };
  doc.nodes[1].children = [2];
  doc.nodes.push(
    { name: 'Upper', translation: [0, 0.2, 0], children: [3] },
    { name: 'Lower', translation: [0, 1, 0], children: [4] },
    { name: 'Hand', translation: [0, 1, 0] },
  );
  doc.skins[0].joints = [1, 2, 3, 4];
  doc.animations.push({
    name: 'Wave',
    channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }],
    samplers: [
      {
        input: add([0, 1], 'SCALAR'),
        output: add([0, 0, 0, 1, 0, 0, Math.sin(0.3), Math.cos(0.3)], 'VEC4'),
        interpolation: 'LINEAR',
      },
    ],
  });
  return result;
}

test('addIKChain reaches a moving target with the elbow toward the pole', async (t) => {
  const store = await TransformStore.create(16),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    f = skeleton(),
    model = new PBRModel(engine, new GLTFAsset(f.doc, f.buffers)),
    animation = new Animation(model),
    animator = new Animator(animation, { initial: 'wave', states: { wave: 'Wave' } });
  engine.use({ name: animation.name, setup() {} });
  engine.use(animator);
  t.after(() => {
    animator.dispose();
    animation.dispose();
    model.dispose();
    engine.dispose();
  });
  model.root.setPosition([1, 0.5, -2]);
  model.root.setScale([1.5, 1.5, 1.5]);
  model.root.setQuaternion([0, Math.sin(0.3), 0, Math.cos(0.3)]);
  const world = (node) => {
    store.tick(false);
    return Array.from(model.nodes[node].matrix.subarray(12, 15));
  };
  const results = [],
    chain = { joints: [2, 3, 4], target: [2, 2.5, -1.2], pole: [1, 2, 2], onSolve: (r) => results.push({ ...r }) };
  const remove = addIKChain(animator, chain);
  for (let frame = 0; frame < 30; frame++) {
    chain.target[0] = 2 + 0.3 * Math.sin(frame / 5);
    animator.onPreUpdate(1 / 60);
    const hand = world(4),
      gap = Math.hypot(hand[0] - chain.target[0], hand[1] - chain.target[1], hand[2] - chain.target[2]);
    assert.ok(gap <= 1e-3, `frame ${frame}: ${gap}`);
    assert.equal(results.at(-1).reached, true);
    // The elbow lies on the pole's side of the shoulder-target line.
    const shoulder = world(2),
      elbow = world(3),
      axis = chain.target.map((v, i) => v - shoulder[i]),
      toPole = chain.pole.map((v, i) => v - shoulder[i]),
      toElbow = elbow.map((v, i) => v - shoulder[i]),
      along = (v) => {
        const k = (v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2]) / (axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2);
        return v.map((x, i) => x - axis[i] * k);
      },
      a = along(toPole),
      b = along(toElbow);
    assert.ok(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > 0, `frame ${frame}: elbow on the pole side`);
  }
  remove();
  chain.weight = 2;
  assert.throws(() => addIKChain(animator, chain), RangeError);
  assert.throws(() => addIKChain(animator, { joints: [2, 4], target: [0, 0, 0] }), RangeError);
});

test('addIKChain takes a scale a little off uniform, as exported rigs have, and refuses a mirrored one', async (t) => {
  // Regression: real rigs carry scales such as 0.9995, 1, 0.9986 (Seed-san's hair) and the chain threw on them.
  const store = await TransformStore.create(16),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    f = skeleton();
  for (const node of [1, 2, 3]) f.doc.nodes[node].scale = [0.9995, 1, 0.9986];
  const model = new PBRModel(engine, new GLTFAsset(f.doc, f.buffers)),
    animation = new Animation(model),
    animator = new Animator(animation, { initial: 'wave', states: { wave: 'Wave' } });
  engine.use({ name: animation.name, setup() {} });
  engine.use(animator);
  t.after(() => {
    animator.dispose();
    animation.dispose();
    model.dispose();
    engine.dispose();
  });
  const chain = { joints: [2, 3, 4], target: [0.8, 1.5, 0.3], pole: [0, 1, 2] };
  addIKChain(animator, chain);
  for (let frame = 0; frame < 3; frame++) animator.onPreUpdate(1 / 60);
  store.tick(false);
  const m = model.nodes[4].matrix,
    gap = Math.hypot(m[12] - chain.target[0], m[13] - chain.target[1], m[14] - chain.target[2]);
  assert.ok(gap < 5e-3, `the hand lands within the 0.14% stretch of two bones: ${gap}`);
  model.root.setScale([-1, 1, 1]);
  assert.throws(() => animator.onPreUpdate(1 / 60), /positive scales/);
});
