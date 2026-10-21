// Held-key animation for data scenes: transform tracks, topology-changing geometry cels shown by STEP scale, retained
// instance placements and per-frame clock samples, exported as standard glTF channels the Khronos validator accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  animateCels,
  animatePlacements,
  animateTransforms,
  exportGLB,
  frameTimes,
  sampleFrames,
} from '../dist/index.js';
import { accessor, readGLB, validate, validator } from './helpers.js';

const needsValidator = validator ? {} : { skip: 'gltf-validator not installed' };
const box = (size) => ({
  positions: [0, 0, 0, size, 0, 0, size, size, 0, 0, size, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
});
const quarter = (angle) => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];

test('frameTimes: one Float32 time per key plus the held end', () => {
  assert.deepEqual([...frameTimes({ fps: 24, frames: [10, 16, 34], end: 40 })], [0, 0.25, 1, 1.25].map(Math.fround));
  assert.deepEqual([...frameTimes({ fps: 10, frames: [3] })], [0, 0.1].map(Math.fround), 'default end: last + 1');
  assert.throws(() => frameTimes({ fps: 0, frames: [0] }), RangeError);
  assert.throws(() => frameTimes({ fps: 24, frames: [4, 4] }), /strictly increasing/);
  assert.throws(() => frameTimes({ fps: 24, frames: [0.5] }), /whole numbers/);
  assert.throws(() => frameTimes({ fps: 24, frames: [0, 4], end: 4 }), /strictly increasing/);
  assert.throws(() => frameTimes({ fps: 1e-30, frames: [0, 2 ** 52, 2 ** 52 + 1] }), /collapse in Float32/);
  const sampled = sampleFrames(5, 9, 30);
  assert.deepEqual(sampled, { fps: 30, frames: [5, 6, 7, 8, 9], end: 10 });
  assert.throws(() => sampleFrames(0, 5000, 30), /exceeds 4096/);
  assert.equal(sampleFrames(0, 5000, 30, 8192).frames.length, 5001);
});

test(
  'animated scene: transforms, held cels with shared banks, instances and sampled clocks',
  needsValidator,
  async () => {
    const clip = { fps: 8, frames: [0, 4, 8, 12], end: 16 };
    // Godot-style split: translation on a parent, rotation and scale on the model.
    const poses = [
      { translation: [0, 0, 0], rotation: quarter(0), scale: [1, 1, 1] },
      { translation: [4, 0, 0], rotation: quarter(Math.PI), scale: [2, 1, 1] },
      { translation: [4, 4, 0], rotation: quarter(1.9 * Math.PI), scale: [2, 2, 1] },
      { translation: [0, 4, 0], rotation: quarter(2.1 * Math.PI), scale: [1, 1, 1] },
    ];
    // Three distinct banks: bank 0 shows at two keys, frame 12 shows none (an empty cel).
    const cels = [
        { name: 'Walker_Cel1', geometry: box(1), extras: { margo: { role: 'geometryCel', bank: 0 } } },
        { name: 'Walker_Cel2', geometry: box(2) },
        { name: 'Walker_Cel3' },
      ],
      model = { name: 'Walker', children: cels },
      motion = { name: 'Walker_Motion', children: [model] },
      lamp = { name: 'Lamp', geometry: box(1), extras: { margo: { role: 'sourceInstance' } } },
      spinner = { name: 'Spinner', geometry: box(1) },
      clocked = sampleFrames(0, 7, 8);
    // A retained source instance hidden at frame 4, and a per-frame clock sample.
    const turn = (a, x) => [Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
    const channels = [
      ...animateCels(cels, clip, [0, 1, 0, -1]),
      ...animateTransforms(model, clip, poses, { paths: ['rotation', 'scale'] }),
      ...animateTransforms(motion, clip, poses, { paths: ['translation'], interpolation: 'STEP' }),
      ...animatePlacements(lamp, clip, [turn(0, 1), null, turn(Math.PI / 2, 2), turn(Math.PI, 3)]),
      ...animateTransforms(
        spinner,
        clocked,
        clocked.frames.map((f) => ({ rotation: quarter((f * Math.PI) / 4) })),
        { paths: ['rotation'], interpolation: 'STEP' },
      ),
    ];
    const glb = exportGLB({
        nodes: [motion, lamp, spinner],
        animations: [{ name: 'Clip', channels, extras: { margo: { fps: 8, startFrame: 0, endExclusive: 16 } } }],
      }),
      report = await validate(glb);
    assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
    const { json, bin } = readGLB(glb),
      index = (name) => json.nodes.findIndex((node) => node.name === name),
      track = (name, path) => {
        const animation = json.animations[0],
          channel = animation.channels.find((c) => c.target.node === index(name) && c.target.path === path),
          sampler = animation.samplers[channel.sampler];
        return {
          interpolation: sampler.interpolation,
          times: [...accessor(json, bin, sampler.input)],
          values: [...accessor(json, bin, sampler.output)],
        };
      };
    // Rest pose is the first key: cels other than bank 0 start collapsed; the empty cel has no mesh.
    assert.deepEqual(
      ['Walker_Cel1', 'Walker_Cel2', 'Walker_Cel3'].map((name) => json.nodes[index(name)].scale),
      [
        [1, 1, 1],
        [0, 0, 0],
        [0, 0, 0],
      ],
    );
    assert.equal(json.nodes[index('Walker_Cel3')].mesh, undefined);
    assert.deepEqual(json.nodes[index('Walker_Cel1')].extras, { margo: { role: 'geometryCel', bank: 0 } });
    assert.deepEqual(json.nodes[index('Walker_Motion')].children, [index('Walker')]);
    assert.equal(json.nodes[index('Walker')].translation, undefined, 'translation moved to the motion parent');
    const cel1 = track('Walker_Cel1', 'scale');
    assert.equal(cel1.interpolation, 'STEP');
    assert.deepEqual(cel1.times, [0, 0.5, 1, 1.5, 2]);
    assert.deepEqual(cel1.values, [1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(track('Walker_Cel2', 'scale').values, [0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(json.meshes.length, 4, 'two cel banks, the lamp and the spinner');
    // Rotations stay on one hemisphere so LINEAR keys turn the short way (1.9 pi to 2.1 pi).
    const rotation = track('Walker', 'rotation');
    assert.equal(rotation.interpolation, 'LINEAR');
    for (let k = 1; k < 5; k++) {
      const dot = [0, 1, 2, 3].reduce((sum, c) => sum + rotation.values[k * 4 + c] * rotation.values[k * 4 - 4 + c], 0);
      assert.ok(dot >= 0, `key ${k} on the same hemisphere`);
    }
    const translation = track('Walker_Motion', 'translation');
    assert.equal(translation.interpolation, 'STEP');
    assert.deepEqual(translation.values.slice(-6), [0, 4, 0, 0, 4, 0], 'last key held to the end');
    // The hidden instance key keeps its last placement with zero scale.
    const lampScale = track('Lamp', 'scale');
    assert.deepEqual(lampScale.values, [1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    assert.deepEqual(track('Lamp', 'translation').values.slice(0, 6), [1, 0, 0, 1, 0, 0]);
    const spinTrack = track('Spinner', 'rotation');
    assert.equal(spinTrack.times.length, 9);
    assert.equal(spinTrack.times.at(-1), 1);
    assert.deepEqual(json.animations[0].extras, { margo: { fps: 8, startFrame: 0, endExclusive: 16 } });
  },
);

test('keyframe helpers refuse matrices, shear, missing paths and invisible instances', () => {
  const clip = { fps: 10, frames: [0, 1] },
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.throws(() => animateTransforms({ matrix: identity }, clip, [{}, {}]), /has a matrix/);
  assert.throws(() => animateTransforms({}, clip, [{ translation: [0, 0, 0] }]), /one value per clip key/);
  assert.throws(
    () => animateTransforms({}, clip, [{ translation: [0, 0, 0] }, {}], { paths: ['translation'] }),
    /poses\[1\] has no translation/,
  );
  assert.throws(
    () =>
      animateTransforms({}, clip, [{ rotation: [0, 0, 0, 0] }, { rotation: [0, 0, 0, 1] }], { paths: ['rotation'] }),
    /nonzero/,
  );
  assert.throws(() => animateCels([{}], clip, [0, 1]), /cel index or -1/);
  assert.throws(() => animateCels([], clip, []), /nonempty/);
  const shear = [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.throws(() => animatePlacements({}, clip, [identity, shear]), /shear/);
  assert.throws(() => animatePlacements({}, clip, [null, null]), /never visible/);
  // The rest pose is the first key; a refused call leaves the node as it was.
  const cel = { name: 'Cel' };
  assert.equal(animateCels([cel], clip, [-1, 0]).length, 1);
  assert.deepEqual(cel.scale, [0, 0, 0]);
  const node = { translation: [9, 9, 9] };
  assert.throws(() => animateTransforms(node, clip, [{ translation: [1, 2, 3] }, {}], { paths: ['translation'] }));
  assert.deepEqual(node.translation, [9, 9, 9]);
});
