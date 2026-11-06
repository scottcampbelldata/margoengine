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
async function animated(edit = () => {}) {
  const store = await TransformStore.create(16),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    f = skeleton();
  edit(f.doc);
  const model = new PBRModel(engine, new GLTFAsset(f.doc, f.buffers)),
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

// Regression (light keeper P2): a chain whose earlier bone carries the last bone onto the aim point threw
// RangeError('Look-at direction ...') from the frame loop. The neck turns the head half a turn about the neck, so the
// head lands on the target (its antipode), and the head's own share then had no direction to look in.
test('a chain that carries the eye onto the target holds a defined pose instead of throwing', async (t) => {
  const f = await animated();
  t.after(() => f.release());
  f.animator.onPreUpdate(0);
  const neck = f.frame(3).position,
    head = f.frame(4).position,
    look = {
      joints: [3, 4],
      target: [2 * neck[0] - head[0], 2 * neck[1] - head[1], 2 * neck[2] - head[2]],
      shares: [1, 1e-20], // the neck takes the whole turn: 1 + 1e-20 rounds to 1
      axis: [0, 1, 0], // look along the bone, away from the neck
      up: null,
    };
  addLookAt(f.animator, look);
  f.animator.onPreUpdate(0);
  look.target = f.frame(4).position; // where the neck's half turn puts the head, to the last bit
  for (let frame = 0; frame < 3; frame++) {
    assert.doesNotThrow(() => f.animator.onPreUpdate(0), `frame ${frame}`);
    const solved = f.frame(4);
    assert.ok(solved.y.every(Number.isFinite) && solved.position.every(Number.isFinite));
    assert.ok(dot(solved.y, [0, -1, 0]) > 1 - 1e-9, 'the neck still took the half turn');
  }
});

// Regression (light keeper P2): inside 1 mm of the bone the target gives no usable direction. Exactly at the bone the
// solve stopped and the head snapped back to the animated pose; just off it the head swung to wherever the last
// fraction of a millimetre pointed. It now holds the last aim until the target is 1 mm or more away again.
test('a target inside 1 mm of the bone holds the last aim', async (t) => {
  const f = await animated();
  t.after(() => f.release());
  f.animator.onPreUpdate(0.5);
  const pivot = f.frame(4).position,
    toward = [Math.SQRT1_2, 0, Math.SQRT1_2],
    at = (d, v) => [pivot[0] + v[0] * d, pivot[1] + v[1] * d, pivot[2] + v[2] * d],
    look = { joints: [4], target: at(0.01, toward), up: null };
  addLookAt(f.animator, look);
  f.animator.onPreUpdate(0);
  assert.ok(dot(f.frame(4).z, toward) > 1 - 1e-9, 'aims at a target 1 cm away');
  for (const target of [at(0, toward), at(0.0005, [0, 0, -1]), at(0.0009, [-1, 0, 0])]) {
    look.target = target;
    f.animator.onPreUpdate(0);
    assert.ok(dot(f.frame(4).z, toward) > 1 - 1e-9, `holds the last aim at ${target}`);
  }
  look.target = at(0.002, [-1, 0, 0]);
  f.animator.onPreUpdate(0);
  assert.ok(dot(f.frame(4).z, [-1, 0, 0]) > 1 - 1e-9, 'aims again from 1 mm out');
});

test('a fresh look-at with its target inside 1 mm keeps the animated pose until it has an aim', async (t) => {
  const f = await animated();
  t.after(() => f.release());
  f.animator.onPreUpdate(0.5);
  const animated0 = f.frame(4);
  addLookAt(f.animator, { joints: [3, 4], target: animated0.position.map((v) => v + 1e-4) });
  f.animator.onPreUpdate(0);
  assert.ok(dot(f.frame(4).z, animated0.z) > 1 - 1e-12);
});

// `origin` aims from a point in the last bone's space (an eye or a lens off the neck pivot): the ray from that point
// along `axis` passes through the target, at any root scale and in a chain.
test('origin aims the ray from a point off the bone origin through the target', async (t) => {
  const f = await animated();
  t.after(() => f.release());
  f.model.root.setPosition([0.5, 0, -1]);
  f.model.root.setQuaternion([0, Math.sin(0.4), 0, Math.cos(0.4)]);
  f.model.root.setScale([2, 2, 2]);
  const origin = [0.08, 0.05, 0.1],
    look = { joints: [3, 4], target: [3, 2.5, 2], shares: [1, 2], origin };
  addLookAt(f.animator, look);
  const lens = () => {
    const m = f.model.nodes[4].matrix;
    return [0, 1, 2].map((r) => m[r] * origin[0] + m[4 + r] * origin[1] + m[8 + r] * origin[2] + m[12 + r]);
  };
  for (let frame = 0; frame < 20; frame++) {
    look.target[1] = 2.5 + Math.sin(frame / 3);
    look.target[0] = frame % 2 ? 0.9 : 3;
    f.animator.onPreUpdate(1 / 30);
    const head = f.frame(4);
    assert.ok(dot(head.z, direction(lens(), look.target)) > 1 - 1e-9, `frame ${frame}`);
    // The pivot-based aim misses: the lens is off the pivot.
    assert.ok(dot(head.z, direction(head.position, look.target)) < 1 - 1e-6, `frame ${frame}: not the pivot ray`);
  }
});

test('origin: inside the lens orbit the look is defined, and [0, 0, 0] matches no origin', async (t) => {
  const a = await animated(),
    b = await animated();
  t.after(() => {
    a.release();
    b.release();
  });
  a.animator.onPreUpdate(0.5);
  const pivot = a.frame(4).position,
    look = { joints: [4], origin: [0.2, 0, 0], target: [pivot[0], pivot[1] + 0.05, pivot[2] + 0.05] };
  addLookAt(a.animator, look);
  assert.doesNotThrow(() => a.animator.onPreUpdate(0));
  const inside = a.frame(4);
  assert.ok(inside.z.every(Number.isFinite));
  // The nearest the lens ray gets to the target: the ray's point nearest the pivot, turned toward the target.
  const m = a.model.nodes[4].matrix,
    offset = [0, 1, 2].map((r) => m[r] * 0.2),
    lensDir = direction([0, 0, 0], offset);
  assert.ok(dot(lensDir, direction(pivot, look.target)) > 1 - 1e-9, 'lens offset turned toward the target');
  const same = { joints: [3, 4], target: [1, 2, 3], shares: [1, 2] };
  addLookAt(a.animator, { ...same, target: [1, 2, 3], origin: [0, 0, 0] });
  addLookAt(b.animator, same);
  look.weight = 0;
  b.animator.onPreUpdate(0.5);
  a.animator.onPreUpdate(0);
  assert.deepEqual(a.frame(4), b.frame(4));
  assert.throws(() => addLookAt(a.animator, { joints: [4], target: [0, 0, 1], origin: [0, NaN, 0] }), RangeError);
  assert.throws(() => addLookAt(a.animator, { joints: [4], target: [0, 0, 1], origin: [0, 0] }), RangeError);
});

test('look-at takes a scale a little off uniform, as exported rigs have, and refuses a mirrored one', async (t) => {
  // Regression: real rigs carry scales such as 0.9995, 1, 0.9986 (Seed-san's hair) and look-at threw on them.
  const uneven = [0.9995, 1, 0.9986],
    f = await animated((doc) => {
      doc.nodes[3].scale = uneven;
    });
  t.after(() => f.release());
  f.model.root.setScale(uneven);
  const look = { joints: [3, 4], target: [3, 2.5, 2] };
  addLookAt(f.animator, look);
  f.animator.onPreUpdate(1 / 30);
  const head = f.frame(4);
  assert.ok(dot(head.z, direction(head.position, look.target)) > 1 - 1e-5);
  f.model.root.setScale([-1, 1, 1]);
  assert.throws(() => f.animator.onPreUpdate(1 / 30), /positive scales/);
});
