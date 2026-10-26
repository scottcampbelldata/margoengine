// Look-at and aim constraints (@margoengine/animator addLookAt, addAimConstraint) on an animated skinned skeleton:
// the last bone's axis points at the target every frame, shares spread the turn, maxAngle clamps it, the roll keeps
// the up axis toward world up, weight blends from the animated pose, and the input is checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../packages/gltf-pro/dist/index.js';
import { Animation } from '../packages/animation/dist/index.js';
import { Animator, addAimConstraint, addLookAt } from '../packages/animator/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';

// Joint (node 1) -> Spine (2) -> Neck (3) -> Head (4); the Wave clip turns Spine about z.
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
    { name: 'Spine', translation: [0, 0.2, 0], children: [3] },
    { name: 'Neck', translation: [0, 1, 0], children: [4] },
    { name: 'Head', translation: [0, 0.3, 0] },
  );
  doc.skins[0].joints = [1, 2, 3, 4];
  doc.animations.push({
    name: 'Wave',
    channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }],
    samplers: [
      {
        input: add([0, 1], 'SCALAR'),
        output: add([0, 0, 0, 1, 0, 0, Math.sin(0.2), Math.cos(0.2)], 'VEC4'),
        interpolation: 'LINEAR',
      },
    ],
  });
  return result;
}
async function animated() {
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
  /** World axis `column` (0 x, 1 y, 2 z) of a node, normalised, and its position. */
  const frame = (node) => {
    store.tick(false);
    const m = model.nodes[node].matrix,
      axis = (c) => {
        const v = [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]],
          l = Math.hypot(...v);
        return v.map((x) => x / l);
      };
    return { x: axis(0), y: axis(1), z: axis(2), position: [m[12], m[13], m[14]] };
  };
  return {
    model,
    animator,
    frame,
    release() {
      animator.dispose();
      animation.dispose();
      model.dispose();
      engine.dispose();
    },
  };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const direction = (from, to) => {
  const v = [to[0] - from[0], to[1] - from[1], to[2] - from[2]],
    l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

test('look-at turns the head to face a moving target every frame, spread over the neck and head', async (t) => {
  const f = await animated();
  t.after(() => f.release());
  f.model.root.setPosition([0.5, 0, -1]);
  f.model.root.setQuaternion([0, Math.sin(0.4), 0, Math.cos(0.4)]);
  f.model.root.setScale([2, 2, 2]);
  const look = { joints: [3, 4], target: [3, 2.5, 2], shares: [1, 2] };
  const remove = addLookAt(f.animator, look);
  for (let frame = 0; frame < 20; frame++) {
    look.target[1] = 2.5 + Math.sin(frame / 3);
    f.animator.onPreUpdate(1 / 30);
    const head = f.frame(4);
    assert.ok(dot(head.z, direction(head.position, look.target)) > 1 - 1e-9, `frame ${frame}`);
    // The default roll: the head's +Y lies in the plane of the look direction and world up, on the up side.
    assert.ok(Math.abs(dot(head.y, cross(head.z, [0, 1, 0]))) < 1e-6, `frame ${frame}: rolled`);
    assert.ok(head.y[1] > 0);
  }
  remove();
  look.target = [-5, 0, -5]; // removed: it no longer turns toward a new target
  f.animator.onPreUpdate(0);
  const after = f.frame(4);
  assert.ok(dot(after.z, direction(after.position, look.target)) < 0.5, 'removed: animated again');
});

test('maxAngle clamps the turn, weight blends from the animated pose, null up skips the roll', async (t) => {
  const f = await animated();
  t.after(() => f.release());
  f.animator.onPreUpdate(0.5);
  const animated0 = f.frame(4);
  const look = { joints: [4], target: [0, 1.5, -5], maxAngle: 0.3, up: null };
  addLookAt(f.animator, look);
  f.animator.onPreUpdate(0);
  const clamped = f.frame(4);
  assert.ok(Math.abs(Math.acos(dot(clamped.z, animated0.z)) - 0.3) < 1e-6, 'turned exactly maxAngle');
  // With no roll the head turned about one axis: its x axis moved within the plane of the turn (shortest arc).
  const axis = cross(animated0.z, clamped.z);
  assert.ok(Math.abs(dot(clamped.x, axis) - dot(animated0.x, axis)) < 1e-6);
  look.maxAngle = Math.PI;
  look.weight = 0.5;
  f.animator.onPreUpdate(0);
  const half = f.frame(4),
    full = Math.acos(dot(animated0.z, direction(half.position, look.target)));
  assert.ok(Math.abs(Math.acos(dot(half.z, animated0.z)) - full / 2) < 1e-4, 'half the turn at weight 0.5');
});

test('an aim constraint points one bone and follows later writes to the constraint object', async (t) => {
  const f = await animated();
  t.after(() => f.release());
  const aim = { joint: 3, target: [2, 1, 0], axis: [0, 1, 0], up: [0, 0, 1], worldUp: [0, 0, 1] };
  addAimConstraint(f.animator, aim);
  f.animator.onPreUpdate(0.25);
  let neck = f.frame(3);
  assert.ok(dot(neck.y, direction(neck.position, aim.target)) > 1 - 1e-9);
  aim.target = [-2, 1, 1];
  f.animator.onPreUpdate(0.25);
  neck = f.frame(3);
  assert.ok(dot(neck.y, direction(neck.position, aim.target)) > 1 - 1e-9);
  assert.ok(Math.abs(dot(neck.z, cross(neck.y, [0, 0, 1]))) < 1e-6, 'local +Z rolled toward world +Z');
});

test('look-at input checks', async (t) => {
  const f = await animated();
  t.after(() => f.release());
  assert.throws(() => addLookAt(f.animator, { joints: [], target: [0, 0, 0] }), TypeError);
  assert.throws(() => addLookAt(f.animator, { joints: [9], target: [0, 0, 0] }), RangeError);
  assert.throws(() => addLookAt(f.animator, { joints: [4, 3], target: [0, 0, 0] }), RangeError);
  assert.throws(() => addLookAt(f.animator, { joints: [4], target: [0, 0] }), RangeError);
  assert.throws(() => addLookAt(f.animator, { joints: [4], target: [0, 0, 1], axis: [0, 0, 0] }), RangeError);
  assert.throws(() => addLookAt(f.animator, { joints: [3, 4], target: [0, 0, 1], shares: [0, 0] }), RangeError);
  assert.throws(() => addLookAt(f.animator, { joints: [4], target: [0, 0, 1], weight: 2 }), RangeError);
  assert.throws(() => addAimConstraint(f.animator, null), TypeError);
});
