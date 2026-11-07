// Root motion (@margoengine/animator addRootMotion): the clip's travel moves the character instead of the bone, exactly
// over whole and partial loops, through 1D blend trees and transitions, rotated into the character's frame; yaw root
// motion turns the character; apply: false only reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../packages/gltf-pro/dist/index.js';
import { Animation } from '../packages/animation/dist/index.js';
import { Animator, addRootMotion } from '../packages/animator/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';

const near = (a, b, tolerance = 1e-5) =>
  assert.ok(
    a.every((v, i) => Math.abs(v - b[i]) <= tolerance),
    `[${a.map((v) => v.toFixed(6))}] is not [${b}]`,
  );

// animatedTriangle's Joint (node 1) carries the clips: Move walks +x 0.4 per second; Run +x 1.2 per second with a
// 0.1 bob in y; Turn yaws +90 degrees per second.
function fixture() {
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
      count: data.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type],
      type,
    });
    return doc.accessors.length - 1;
  };
  const times = add([0, 0.5, 1], 'SCALAR'),
    s = Math.sin(Math.PI / 8),
    c = Math.cos(Math.PI / 8);
  doc.animations.push(
    {
      name: 'Run',
      channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
      samplers: [{ input: times, output: add([0, 0, 0, 0.6, 0.1, 0, 1.2, 0, 0], 'VEC3') }],
    },
    {
      name: 'Turn',
      channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
      samplers: [{ input: times, output: add([0, 0, 0, 1, 0, s, 0, c, 0, Math.SQRT1_2, 0, Math.SQRT1_2], 'VEC4') }],
    },
  );
  return result;
}
async function animated(options) {
  const store = await TransformStore.create(16),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    f = fixture(),
    model = new PBRModel(engine, new GLTFAsset(f.doc, f.buffers)),
    animation = new Animation(model),
    animator = new Animator(animation, options);
  engine.use({ name: animation.name, setup() {} });
  engine.use(animator);
  const t = store.transforms,
    position = (node) => [t.x[node.id], t.y[node.id], t.z[node.id]];
  return {
    model,
    animator,
    root: () => position(model.root),
    bone: () => position(model.nodes[1]),
    quaternion: (node) => [t.qx[node.id], t.qy[node.id], t.qz[node.id], t.qw[node.id]],
    release() {
      animator.dispose();
      animation.dispose();
      model.dispose();
      engine.dispose();
    },
  };
}

test('root motion moves the character by the clip travel, exactly across loops, and keeps the bone in place', async (t) => {
  const f = await animated({ initial: 'walk', states: { walk: 'Move' } });
  t.after(() => f.release());
  const motion = addRootMotion(f.animator, { joint: 1 });
  for (let frame = 1; frame <= 11; frame++) {
    f.animator.onPreUpdate(0.3);
    // 0.4 per second: after 0.3 * frame seconds, including the loop wraps at 1, 2 and 3 s.
    near(f.root(), [0.4 * 0.3 * frame, 0, 0]);
    near(f.bone(), [0, 0, 0]);
    near(motion.translation, [0.12, 0, 0]);
  }
  motion.dispose();
  f.animator.onPreUpdate(0.25);
  assert.ok(f.bone()[0] > 0.01, 'after dispose the bone travels again');
  near(f.root(), [0.4 * 3.3, 0, 0]);
});

test('root motion follows the blend tree, keeps height with xz, rotates into the character frame and can only report', async (t) => {
  const f = await animated({
    initial: 'move',
    parameters: { speed: 0.5 },
    states: {
      move: {
        parameter: 'speed',
        samples: [
          { value: 0, clip: 'Move' },
          { value: 1, clip: 'Run' },
        ],
      },
    },
  });
  t.after(() => f.release());
  // The character faces -x after a quarter turn about +Y: the clip's +x travel becomes world -z.
  f.model.root.setQuaternion([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  const motion = addRootMotion(f.animator, { joint: 1 });
  f.animator.onPreUpdate(0.5);
  // Half Move (0.2) and half Run (0.6) over 0.5 s: 0.4 along the clip's +x.
  near(f.root(), [0, 0, -0.4]);
  near(motion.translation, [0, 0, -0.4]);
  // xz keeps the blended bob (half of Run's 0.1) on the bone and none on the character.
  near(f.bone(), [0, 0.05, 0]);
  motion.dispose();
  const report = addRootMotion(f.animator, { joint: 1, axes: 'xyz', apply: false });
  f.animator.onPreUpdate(0.25);
  near(f.root(), [0, 0, -0.4], 1e-5);
  near(report.translation, [0, -0.025, -0.2]);
  near(f.bone(), [0, 0, 0]);
});

test('a transition starts the new state travel from its start', async (t) => {
  const f = await animated({ initial: 'walk', states: { walk: 'Move', run: 'Run' } });
  t.after(() => f.release());
  addRootMotion(f.animator, { joint: 1 });
  f.animator.onPreUpdate(0.5);
  near(f.root(), [0.2, 0, 0]);
  f.animator.transition('run', 0);
  f.animator.onPreUpdate(0.25);
  near(f.root(), [0.2 + 0.3, 0, 0]);
});

test('yaw root motion turns the character and unwinds the bone', async (t) => {
  const f = await animated({ initial: 'turn', states: { turn: 'Turn' } });
  t.after(() => f.release());
  const motion = addRootMotion(f.animator, { joint: 1, rotation: true });
  for (let frame = 0; frame < 6; frame++) f.animator.onPreUpdate(0.5);
  // 90 degrees per second for 3 s: 270 degrees about +Y.
  assert.ok(Math.abs(motion.yaw - Math.PI / 4) < 1e-5);
  const q = f.quaternion(f.model.root),
    expected = [0, Math.sin((3 * Math.PI) / 4), 0, Math.cos((3 * Math.PI) / 4)],
    same = Math.abs(q.reduce((sum, v, i) => sum + v * expected[i], 0));
  assert.ok(same > 1 - 1e-6, `character turned 270 degrees: ${q}`);
  const bone = f.quaternion(f.model.nodes[1]);
  assert.ok(Math.abs(Math.abs(bone[3]) - 1) < 1e-6, `bone unwound to no yaw: ${bone}`);
});

test('smoothing takes the journey and leaves the surge in the pose, and a lap still travels a whole lap', async (t) => {
  // Hips that surge: 1 m a lap plus a wobble that is 0 at the lap's ends, keyed finely enough to average.
  const result = animatedTriangle(),
    { doc, buffers } = result,
    count = 121,
    surge = (time) => [time + 0.05 * Math.sin(4 * Math.PI * time), 0, 0],
    add = (values, type) => {
      const data = new Float32Array(values);
      buffers.push(data);
      doc.buffers.push({ byteLength: data.byteLength });
      doc.bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
      doc.accessors.push({ bufferView: doc.bufferViews.length - 1, componentType: 5126, count: data.length / (type === 'VEC3' ? 3 : 1), type });
      return doc.accessors.length - 1;
    },
    times = Array.from({ length: count }, (_, i) => i / (count - 1));
  doc.animations.push({
    name: 'Surge',
    channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
    samplers: [{ input: add(times, 'SCALAR'), output: add(times.flatMap(surge), 'VEC3') }],
  });
  const store = await TransformStore.create(16),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    model = new PBRModel(engine, new GLTFAsset(doc, buffers)),
    animation = new Animation(model),
    animator = new Animator(animation, { initial: 'surge', states: { surge: 'Surge' } });
  engine.use({ name: animation.name, setup() {} });
  engine.use(animator);
  t.after(() => {
    animator.dispose();
    animation.dispose();
    model.dispose();
    engine.dispose();
  });
  // 0.5 s is one period of the wobble, so the journey is straight: a steady 1 m/s.
  const motion = addRootMotion(animator, { joint: 1, target: model.root, smoothing: 0.5 }),
    bone = model.nodes[1].id,
    transforms = store.transforms,
    step = 1 / 120;
  let fastest = 0,
    slowest = Infinity,
    kept = 0;
  for (let i = 0; i < 300; i++) {
    animator.onPreUpdate(step);
    if (i > 0) {
      const speed = motion.translation[0] / step;
      fastest = Math.max(fastest, speed);
      slowest = Math.min(slowest, speed);
    }
    kept = Math.max(kept, Math.abs(transforms.x[bone]));
  }
  assert.ok(fastest < 1.01 && slowest > 0.99, `the character ran from ${slowest} to ${fastest} m/s`);
  assert.ok(Math.abs(kept - 0.05) < 2e-3, `the pose kept ${kept} of the 0.05 surge`);
  assert.ok(Math.abs(transforms.x[model.root.id] - 2.5) < 0.01, `moved ${transforms.x[model.root.id]} in 2.5 s`);
});

test('smoothing must be 0 seconds or more', async (t) => {
  const f = await animated({ initial: 'walk', states: { walk: 'Move' } });
  t.after(() => f.release());
  assert.throws(() => addRootMotion(f.animator, { joint: 1, smoothing: -1 }), /smoothing must be 0 seconds or more/);
  assert.throws(() => addRootMotion(f.animator, { joint: 1, smoothing: NaN }), /smoothing/);
});

test('root motion input checks', async (t) => {
  const f = await animated({ initial: 'walk', states: { walk: 'Move' } });
  t.after(() => f.release());
  assert.throws(() => addRootMotion(f.animator, { joint: 9 }), RangeError);
  assert.throws(() => addRootMotion(f.animator, { joint: 1, axes: 'y' }), RangeError);
  assert.throws(() => addRootMotion(f.animator, { joint: 1, rotation: 'yes' }), TypeError);
  const motion = addRootMotion(f.animator, { joint: 1 });
  motion[Symbol.dispose]();
  motion.dispose();
});
