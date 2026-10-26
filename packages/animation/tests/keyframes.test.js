// Keyframe clips from raw keys: per-key easing, slerp, segments, skeleton playback and baking to glTF samplers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Skeleton,
  applyKeyframeClip,
  bakeKeyframeClip,
  createKeyframeClip,
  sampleKeyframes,
  sampleTrack,
  segmentTime,
} from '../dist/index.js';

const near = (actual, expected, tolerance = 1e-12, label = '') => {
  for (let i = 0; i < expected.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${label} [${i}] ${actual[i]} != ${expected[i]}`);
};
// x steps by 8 per second; each key names how it moves to the next one.
const rampKeys = [
  { time: 0, value: [0, 0, 0], interpolation: 'easeIn' },
  { time: 1, value: [8, 0, 0], interpolation: 'easeOut' },
  { time: 2, value: [16, 0, 0], interpolation: 'easeInOut' },
  { time: 3, value: [24, 0, 0], interpolation: 'discrete' },
  { time: 4, value: [32, 0, 0] },
  { time: 5, value: [40, 0, 4], interpolation: 'easeIn' },
];
const ramp = createKeyframeClip({ name: 'ramp', tracks: [{ target: 'box', path: 'translation', keys: rampKeys }] });
const sz = (degrees) => [0, 0, Math.sin((degrees * Math.PI) / 360), Math.cos((degrees * Math.PI) / 360)];

test('each key eases to the next by its own interpolation, exactly at boundaries and holding outside the keys', () => {
  const x = (t) => sampleKeyframes(ramp.tracks[0], t)[0];
  assert.equal(ramp.duration, 5);
  assert.equal(ramp.name, 'ramp');
  for (const [t, expected] of [
    [-1, 0],
    [0, 0],
    [0.5, 1], // ease in cubic: 0.5^3
    [1, 8],
    [1.5, 15], // ease out cubic: 1 - 0.5^3
    [2, 16],
    [2.25, 16.5], // ease in-out cubic: 4 * 0.25^3
    [2.5, 20],
    [2.75, 23.5], // 1 - (2 - 1.5)^3 / 2
    [3, 24],
    [3.999, 24], // discrete holds
    [4, 32], // and jumps at the next key
    [4.25, 34], // linear
    [5, 40],
    [9, 40],
  ])
    near([x(t)], [expected], 1e-12, `t=${t}`);
  const out = new Float64Array(3);
  assert.equal(sampleKeyframes(ramp.tracks[0], 5, out), out);
  near(out, [40, 0, 4]);
  assert.throws(() => sampleKeyframes(ramp.tracks[0], Number.NaN), RangeError);
  assert.throws(() => sampleKeyframes(ramp.tracks[0], 1, new Float32Array(3)), TypeError);
});

test('rotations slerp by the eased factor along the shortest path', () => {
  const clip = createKeyframeClip({
    tracks: [
      {
        target: 'arm',
        path: 'rotation',
        keys: [
          { time: 0, value: [0, 0, 0, 2], interpolation: 'easeIn' },
          { time: 1, value: sz(90).map((v) => -v) }, // the same rotation from the other hemisphere
        ],
      },
    ],
  });
  near(clip.tracks[0].values.subarray(0, 4), [0, 0, 0, 1], 0, 'normalised');
  near(sampleKeyframes(clip.tracks[0], 0.5), sz(90 * 0.125), 1e-12);
  near(
    sampleKeyframes(clip.tracks[0], 1),
    sz(90).map((v) => -v),
    1e-12,
  );
});

test('clip input is validated', () => {
  const bad = (track, pattern, name) =>
    assert.throws(() => createKeyframeClip({ tracks: [track] }), { name, message: pattern });
  const key = (time, value = [0, 0, 0], interpolation) => ({ time, value, interpolation });
  bad({ target: 'a', path: 'translation', keys: [key(1), key(1)] }, /key 1 time 1 is invalid/, 'RangeError');
  bad({ target: 'a', path: 'translation', keys: [key(-1)] }, /time -1/, 'RangeError');
  bad({ target: 'a', path: 'translation', keys: [key(0, [0, 0])] }, /needs 3 numbers/, 'TypeError');
  bad({ target: 'a', path: 'scale', keys: [key(0, [0, Number.NaN, 0])] }, /non-finite/, 'RangeError');
  bad({ target: 'a', path: 'rotation', keys: [key(0, [0, 0, 0, 0])] }, /zero quaternion/, 'RangeError');
  bad({ target: 'a', path: 'translation', keys: [key(0, undefined, 'cubic')] }, /interpolation cubic/, 'TypeError');
  bad({ target: 'a', path: 'colour', keys: [key(0)] }, /path colour/, 'TypeError'); // weights is a path now
  bad({ target: '', path: 'scale', keys: [key(0)] }, /target/, 'TypeError');
  bad({ target: 'a', path: 'scale', keys: [] }, /nonempty keys/, 'TypeError');
  const twice = { target: 'a', path: 'scale', keys: [key(0)] };
  assert.throws(() => createKeyframeClip({ tracks: [twice, twice] }), {
    name: 'TypeError',
    message: /repeats a scale/,
  });
  assert.throws(() => createKeyframeClip({}), TypeError);
  assert.equal(createKeyframeClip({ tracks: [] }).duration, 0);
});

test('a clip poses the bones it names on a skeleton and leaves the rest alone', () => {
  const skeleton = new Skeleton([
      { name: 'upper', parent: -1 },
      { name: 'forearm', parent: 0, translation: [0, 1, 0] },
    ]),
    clip = createKeyframeClip({
      tracks: [
        {
          target: 'forearm',
          path: 'rotation',
          keys: [
            { time: 0, value: sz(0) },
            { time: 2, value: sz(90) },
          ],
        },
        {
          target: 'forearm',
          path: 'scale',
          keys: [
            { time: 0, value: [1, 1, 1] },
            { time: 2, value: [3, 3, 3] },
          ],
        },
        { target: 'lamp', path: 'translation', keys: [{ time: 0, value: [9, 9, 9] }] },
      ],
    });
  applyKeyframeClip(clip, skeleton, 1);
  const pose = skeleton.getPose(1);
  near(pose.rotation, sz(45), 1e-12);
  near(pose.scale, [2, 2, 2]);
  near(pose.translation, [0, 1, 0]);
  near(skeleton.getPose(0).translation, [0, 0, 0]);
});

test('segment time loops, holds and reverses with a negative timescale', () => {
  assert.equal(segmentTime(1.5, 2), 1.5);
  assert.equal(segmentTime(3, 2), 2, 'held at the end');
  assert.equal(segmentTime(5, 2, { loop: true }), 1);
  assert.equal(segmentTime(1, 2, { timeScale: 0.5 }), 0.5);
  assert.equal(segmentTime(0.5, 2, { timeScale: -1 }), 1.5);
  assert.equal(segmentTime(3, 2, { timeScale: -1 }), 0, 'held at the start');
  assert.equal(segmentTime(2.5, 2, { timeScale: -2, loop: true }), 1);
  assert.equal(segmentTime(1, 0, { loop: true }), 0);
  assert.throws(() => segmentTime(-1, 2), RangeError);
  assert.throws(() => segmentTime(1, 2, { timeScale: Number.POSITIVE_INFINITY }), RangeError);
});

test('baked samplers are exact at keys and at every baked time, through the glTF sampler', () => {
  const nodes = { box: { name: 'box' }, arm: { name: 'arm' } };
  const clip = createKeyframeClip({
    name: 'Wave',
    tracks: [
      { target: 'box', path: 'translation', keys: rampKeys },
      {
        target: 'box',
        path: 'scale',
        keys: [
          { time: 0, value: [1, 1, 1] },
          { time: 0.3, value: [2, 2, 2] },
        ],
      },
      {
        target: 'arm',
        path: 'rotation',
        keys: [
          { time: 0, value: sz(0), interpolation: 'discrete' },
          { time: 0.5, value: sz(170).map((v) => -v), interpolation: 'discrete' },
          { time: 1, value: sz(-170) },
        ],
      },
      { target: 'ghost', path: 'scale', keys: [{ time: 0, value: [1, 1, 1] }] },
    ],
  });
  const baked = bakeKeyframeClip(clip, 10, (target) => nodes[target]);
  assert.equal(baked.name, 'Wave');
  assert.equal(baked.channels.length, 3, 'unresolved targets are left out');
  const [move, scale, turn] = baked.channels;
  assert.equal(move.node, nodes.box);
  assert.deepEqual([move.interpolation, scale.interpolation, turn.interpolation], ['LINEAR', 'LINEAR', 'STEP']);
  assert.deepEqual(Array.from(scale.times), [0, Math.fround(0.3)], 'linear tracks keep only their keys');
  assert.deepEqual(Array.from(turn.times), [0, 0.5, 1], 'discrete tracks keep only their keys');
  for (let i = 4; i < turn.values.length; i += 4) {
    const dot = [0, 1, 2, 3].reduce((sum, c) => sum + turn.values[i + c] * turn.values[i - 4 + c], 0);
    assert.ok(dot >= 0, 'consecutive rotations share a hemisphere');
  }
  // Eased segments sample every 0.1 s; the discrete one at 3 s holds until one Float32 step before 4 s.
  const times = Array.from(move.times);
  for (const t of [0, 0.1, 0.9, 1, 1.1, 2.9, 3, 4, 5]) assert.ok(times.includes(Math.fround(t)), `baked ${t}`);
  assert.ok(!times.includes(Math.fround(3.5)) && !times.includes(Math.fround(4.5)), 'no frames inside discrete/linear');
  assert.equal(times[times.indexOf(4) - 1], Math.fround(4 - 2 ** -22), 'pre-step before the jump');
  for (const channel of baked.channels) {
    const width = channel.path === 'rotation' ? 4 : 3,
      track = clip.tracks.find((t) => t.target === channel.node.name && t.path === channel.path),
      probe = [...channel.times, ...track.times, 0.15, 0.75];
    for (const t of channel.path === 'translation' ? probe.slice(0, -2) : probe) {
      const glTF = sampleTrack(channel.times, channel.values, width, t, channel.interpolation, width === 4),
        exact = sampleKeyframes(track, t);
      const sign = width === 4 && glTF.reduce((s, v, c) => s + v * exact[c], 0) < 0 ? -1 : 1;
      near(
        glTF.map((v) => v * sign),
        exact,
        1e-5,
        `${channel.path} at ${t}`,
      );
    }
  }
  assert.throws(() => bakeKeyframeClip(clip, 0, () => 1), RangeError);
  assert.throws(() => bakeKeyframeClip(clip, 30), TypeError);
});

test('applyKeyframeClip binds tracks to bones once per clip and skeleton, and a new tracks array binds again', () => {
  const names = Array.from({ length: 64 }, (_, i) => `b${i}`),
    skeleton = new Skeleton(names.map((name, i) => ({ name, parent: i ? 0 : -1 })));
  const clip = createKeyframeClip({
    tracks: names.map((target, i) => ({
      target,
      path: i % 2 ? 'rotation' : 'translation',
      keys: [
        { time: 0, value: i % 2 ? [0, 0, 0, 1] : [0, 0, 0] },
        { time: 1, value: i % 2 ? sz(90) : [i, 0, 0] },
      ],
    })),
  });
  let lookups = 0;
  const index = skeleton.index.bind(skeleton);
  skeleton.index = (name) => (lookups++, index(name));
  for (let k = 0; k <= 10; k++) applyKeyframeClip(clip, skeleton, k / 10);
  // Once per track, not once per track per call (it was a linear name search per track per call: quadratic in bones).
  assert.equal(lookups, names.length);
  near(skeleton.getPose(4).translation, [4, 0, 0]);
  near(skeleton.getPose(5).rotation, sz(90), 1e-12);
  // Same tracks on another skeleton whose bone order differs: bound to that skeleton's indices.
  const other = new Skeleton([...names].reverse().map((name, i) => ({ name, parent: i ? 0 : -1 })));
  applyKeyframeClip(clip, other, 0.5);
  near(other.getPose(other.index('b4')).translation, [2, 0, 0]);
  const fresh = createKeyframeClip({
    tracks: [{ target: 'b7', path: 'scale', keys: [{ time: 0, value: [2, 2, 2] }] }],
  });
  applyKeyframeClip(fresh, skeleton, 0);
  near(skeleton.getPose(7).scale, [2, 2, 2]);
  assert.equal(lookups, names.length + 1);
});

test('Skeleton.index finds every bone by name in constant time and -1 for others, prototype names included', () => {
  const names = ['root', 'toString', '__proto__', 'constructor', 'hasOwnProperty'],
    skeleton = new Skeleton(names.map((name, i) => ({ name, parent: i ? 0 : -1 })));
  names.forEach((name, i) => assert.equal(skeleton.index(name), i));
  for (const name of ['valueOf', 'missing', '', undefined]) assert.equal(skeleton.index(name), -1);
  assert.throws(
    () => skeleton.setPose(1, { translation: [0, NaN, 0] }),
    /Skeleton bone 1 translation has a non-finite/,
  );
  assert.throws(() => skeleton.setPose(2, { rotation: [0, 0, 0] }), /Skeleton bone 2 rotation needs 4 numbers/);
  assert.throws(() => skeleton.setPose(3, { rotation: [0, 0, 0, 0] }), /Skeleton bone 3 rotation is a zero quaternion/);
});
