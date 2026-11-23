import test from 'node:test';
import assert from 'node:assert/strict';
import { createSwimRig, sampleSwimPose, swimCadence } from '../dist/swim.js';
import { multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';

function frames(rig, stroke, out) {
  const pose = sampleSwimPose(rig, stroke, out);
  const position = new Float64Array(rig.stations.length * 3);
  let rotation = [0, 0, 0, 1],
    origin = [0, 0, 0];
  for (let i = 0; i < rig.stations.length; i++) {
    const span = rotateByQuaternion(pose.slice(i * 10, i * 10 + 3), rotation);
    origin = origin.map((value, axis) => value + span[axis]);
    position.set(origin, i * 3);
    rotation = multiplyQuaternions(rotation, pose.slice(i * 10 + 3, i * 10 + 7));
  }
  return { position };
}

for (const species of ['reef-fish', 'reef-shark', 'bottlenose-dolphin', 'humpback-whale']) {
  test(species + ' preserves link lengths and establishes a species-specific stroke plane', () => {
    const rig = createSwimRig(species, { length: 2.4, segments: 32 });
    const plane = species.includes('reef') ? 0 : 1;
    const last = (rig.stations.length - 1) * 3;
    let low = 0,
      high = 0;
    for (let n = 0; n < 48; n++) {
      const { position } = frames(rig, { phase: n / 48 });
      low = Math.min(position[last + plane], low);
      high = Math.max(position[last + plane], high);
      assert.ok(Math.abs(position[last + 1 - plane]) < 1e-6);
      for (let i = 3; i < position.length; i += 3)
        assert.ok(
          Math.abs(
            Math.hypot(
              position[i] - position[i - 3],
              position[i + 1] - position[i - 2],
              position[i + 2] - position[i - 1],
            ) -
              2.4 / 32,
          ) < 1e-6,
        );
    }
    assert.ok(high > 0.13 && low < -0.13, `${low} to ${high}`);
    assert.ok(swimCadence(rig, 2) > swimCadence(rig, 1));
  });
}

test('coasting is neutral and opposite turns mirror while preserving a continuous pose', () => {
  const rig = createSwimRig('humpback-whale', { length: 11, stations: [0, 0.25, 0.51, 0.71, 0.85, 0.93, 1] });
  assert.deepEqual(sampleSwimPose(rig, { phase: 100, effort: 0 }), rig.rest);
  const right = frames(rig, { phase: 0.35, effort: 0, turn: 0.5 }).position;
  const left = frames(rig, { phase: 0.35, effort: 0, turn: -0.5 }).position;
  assert.ok(Math.abs(right.at(-3)) > 0.2);
  assert.ok(Math.abs(right.at(-3) + left.at(-3)) < 1e-6);
  assert.equal(right.at(-2), 0);
  assert.equal(right.at(-1), left.at(-1));
  const start = sampleSwimPose(rig, { phase: 0, effort: 0.7, turn: 0.1 });
  const loop = sampleSwimPose(rig, { phase: 1, effort: 0.7, turn: 0.1 });
  assert.deepEqual(start, loop);
});

test('a dense swim rig can reuse an output buffer without altering rest', () => {
  const rig = createSwimRig('bottlenose-dolphin', { length: 3, segments: 1207 });
  const before = Float32Array.from(rig.rest);
  const out = new Float32Array(before.length);
  assert.equal(sampleSwimPose(rig, { phase: -2.1, effort: 0.65, turn: -0.4 }, out), out);
  assert.equal(out.length, 12080);
  assert.ok(out.every(Number.isFinite));
  assert.ok(Math.abs(frames(rig, { phase: 0 }).position.at(-2)) > 0.1);
  assert.deepEqual(rig.rest, before);
  assert.throws(() => sampleSwimPose(rig, { phase: 0 }, rig.rest), RangeError);
  assert.throws(() => createSwimRig('reef-shark', { length: 2, stations: [0, 0.1, 0.5, 0.5, 1] }), RangeError);
  assert.throws(() => sampleSwimPose(rig, { phase: 0, effort: NaN }), RangeError);
});

test('ray fin hinges carry a delayed stroke without flexing the head', () => {
  const rig = createSwimRig('bluespotted-ray', {
    length: 0.5,
    pectorals: [
      { position: [0.026, 0.011, -0.03], distal: [0.14, 0.009, -0.1], roll: 0.68 },
      { position: [-0.026, 0.011, -0.03], distal: [-0.14, 0.009, -0.1], roll: 0.68 },
    ],
  });
  const root = rig.names.indexOf('pectoral-L'),
    tip = rig.names.indexOf('pectoral-tip-L');
  assert.equal(rig.parents[tip], root);
  assert.ok(Math.abs(rig.rest[tip * 10] - 0.114) < 1e-6);
  const p0 = sampleSwimPose(rig, { phase: 0.08 });
  const p1 = sampleSwimPose(rig, { phase: 0.58 });
  assert.deepEqual(p0.slice(0, 10), p1.slice(0, 10));
  assert.ok(Math.abs(p0[tip * 10 + 5] - p1[tip * 10 + 5]) > 0.3);
  for (const pose of [p0, p1])
    for (const joint of [root, tip])
      assert.ok(Math.abs(Math.hypot(...pose.slice(joint * 10 + 3, joint * 10 + 7)) - 1) < 1e-6);
});
