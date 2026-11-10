// Batch 161 job 5 (row 10.2, parse + attach): the CPU work Animation does when it is made and set up, counted on
// RobotExpressive. Each channel used to search the model's primitives for its node's morph width and check its key
// order with a closure; each skinned primitive built one 16-float view per joint of its inverse binds (and, for a skin
// with no inverse binds, an array per joint). Now the node grouping answers the width, the key order is a loop, and
// the inverse binds stay one array read at joint offsets; clips, binds and palettes come out the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { invertMatrixStable, multiplyMatrices } from '@margoengine/math/mat4';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Animation } from '../dist/index.js';
import { engine, model } from './support/models.js';
import { animatorGLB } from '../../../tests/support/animator-rig.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const robot = new URL('../../../examples/assets/robot-expressive.glb', import.meta.url),
  typed = Object.getPrototypeOf(Float32Array.prototype),
  identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Runs `run` with counters: finds over `primitives`, typed-array closures, 16-float views, per-joint arrays. */
function counted(primitives, run) {
  const saved = { find: Array.prototype.find, flatMap: Array.prototype.flatMap, from: Array.from },
    savedTyped = { some: typed.some, subarray: typed.subarray },
    counts = { finds: 0, some: 0, views16: 0, flatMaps: 0, jointArrays: 0 };
  Array.prototype.find = function (...args) {
    if (this === primitives) counts.finds++;
    return saved.find.apply(this, args);
  };
  Array.prototype.flatMap = function (...args) {
    counts.flatMaps++;
    return saved.flatMap.apply(this, args);
  };
  Array.from = function (source, ...rest) {
    if (source instanceof Float32Array && source.length === 16) counts.jointArrays++;
    return saved.from.call(this, source, ...rest);
  };
  typed.some = function (...args) {
    counts.some++;
    return savedTyped.some.apply(this, args);
  };
  typed.subarray = function (...args) {
    const view = savedTyped.subarray.apply(this, args);
    if (view instanceof Float32Array && view.length === 16) counts.views16++;
    return view;
  };
  try {
    return { result: run(), counts };
  } finally {
    Array.prototype.find = saved.find;
    Array.prototype.flatMap = saved.flatMap;
    Array.from = saved.from;
    typed.some = savedTyped.some;
    typed.subarray = savedTyped.subarray;
  }
}
async function gpuEngine(t) {
  const gpu = optionalGPU(),
    store = await TransformStore.create(256),
    e = new Engine(
      { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  t.after(() => {
    e.dispose();
    gpu.cleanup();
  });
  return { e, store, device: gpu.engine.gpu };
}
/** The palette the parent computed: inverse(node) x joint x (16-float view of joint i's inverse bind). */
function reference(animation, r) {
  const inverse = new Float32Array(16),
    joint = new Float32Array(16),
    product = new Float32Array(16),
    palette = new Float32Array(r.joints.length * 16);
  assert.ok(invertMatrixStable(r.primitive.node.matrix, inverse, new Float64Array(52)));
  for (let i = 0; i < r.joints.length; i++) {
    multiplyMatrices(animation.model.nodes[r.joints[i]].matrix, r.inverseBind.subarray(i * 16, i * 16 + 16), joint);
    multiplyMatrices(inverse, joint, product);
    palette.set(product, i * 16);
  }
  return palette;
}

test('making an Animation searches no primitives and runs no closure per channel', async () => {
  const e = await engine(1024),
    m = model(e, animatorGLB(robot)),
    { result: a, counts } = counted(m.primitives, () => new Animation(m)),
    channels = a.clips.reduce((sum, clip) => sum + clip.tracks.length, 0);
  assert.ok(channels > 100, `${channels} channels`);
  // The parent: one find over the primitives and one `some` over the key times per channel.
  assert.equal(counts.finds, 0, 'primitive searches');
  assert.equal(counts.some, 0, 'key-order closures');
  // The same clips as the accessors give: names, durations, targets, widths and the very key arrays.
  const doc = m.asset.doc;
  a.clips.forEach((clip, c) => {
    const def = doc.animations[c];
    assert.equal(clip.name, def.name ?? 'Animation ' + c);
    assert.ok(Object.is(clip.duration, Math.max(...clip.tracks.map((t) => t.times.at(-1)))));
    clip.tracks.forEach((track, k) => {
      const channel = def.channels[k],
        sampler = def.samplers[channel.sampler];
      assert.equal(track.node, channel.target.node);
      assert.equal(track.path, channel.target.path);
      assert.equal(track.times, m.asset.accessor(sampler.input, 'SCALAR'));
      const first = m.primitives.find((p) => p.nodeIndex === track.node);
      assert.equal(
        track.width,
        track.path === 'rotation' ? 4 : track.path === 'weights' ? first.weights.length : 3,
        `clip ${c} track ${k} width`,
      );
    });
  });
  // Key-order errors are unchanged: a negative and a repeated key time throw, a NaN one passes the check as before.
  const times = a.clips[0].tracks[0].times;
  for (const [at, value, throws] of [
    [0, -1, true],
    [1, times[0], true],
    [1, Number.NaN, false],
  ]) {
    const saved = times[at];
    times[at] = value;
    try {
      if (throws) assert.throws(() => new Animation(m), /keyframe times must be >= 0 and strictly increasing/);
      else new Animation(m);
    } finally {
      times[at] = saved;
    }
  }
  m.dispose();
  e.dispose();
});

for (const [label, strip] of [
  ['with inverse bind matrices', false],
  ['whose skins give no inverse binds', true],
])
  test(`setting up RobotExpressive ${label} makes no array per joint and the same palettes`, async (t) => {
    const { e, store, device } = await gpuEngine(t),
      { doc, buffers } = animatorGLB(robot),
      edited = strip ? { ...doc, skins: doc.skins.map(({ inverseBindMatrices, ...skin }) => skin) } : doc,
      m = new PBRModel(e, new GLTFAsset(edited, buffers));
    e.use(m);
    const a = new Animation(m),
      { counts } = counted(m.primitives, () => e.use(a)),
      skinned = a['resources'].filter((r) => r.joints.length);
    assert.equal(skinned.length, 4, 'four skinned primitives');
    // The parent: 43 views a skinned primitive (172), and without inverse binds a flatMap and 43 arrays a primitive.
    assert.equal(counts.views16, 0, '16-float views');
    assert.equal(counts.flatMaps, 0, 'flatMap calls');
    assert.equal(counts.jointArrays, 0, 'arrays per joint');
    for (const r of skinned) {
      assert.ok(r.inverseBind instanceof Float32Array);
      assert.equal(r.inverseBind.length, r.joints.length * 16);
      const skin = edited.skins[edited.nodes[r.primitive.nodeIndex].skin],
        expected = strip
          ? Float32Array.from({ length: r.joints.length * 16 }, (_, i) => identity[i % 16])
          : m.asset.accessor(skin.inverseBindMatrices, 'MAT4');
      assert.deepEqual(r.inverseBind, expected);
    }
    a.play('Walking');
    const context = { backend: 'webgpu', device, encoder: device.createCommandEncoder() };
    for (const time of [0.4, 0.5, 0.1]) {
      a.seek(time);
      store.tick(false);
      assert.ok(a['upload'](context));
      for (const r of skinned) {
        const bones = new Uint8Array(r.slot.page.bones.buffer.data, r.slot.bones.offset * 64, r.joints.length * 64);
        assert.deepEqual(bones, new Uint8Array(reference(a, r).buffer), `palette of ${r.primitive.node.name} at ${time}`);
      }
    }
    a.dispose();
  });
