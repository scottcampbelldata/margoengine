// The selectable 'weighted' keyframe blend: (1 - f) a + f b with a held-key copy before any arithmetic. The reference
// below is Margo Voxel Studio's frozen vector-track evaluation (src/editor/animation.ts heldIndex and evaluateDocument,
// position and scale), so the contract is checked against the arithmetic the app saved poses with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyframeClip, sampleKeyframes } from '../dist/index.js';

function heldIndex(keys, frame) {
  let low = 0,
    high = keys.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (keys[middle].frame <= frame) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}
function studioVector(keys, localFrame, interpolation) {
  const index = heldIndex(keys, localFrame),
    key = keys[index],
    next = keys[index + 1];
  if (interpolation === 'LINEAR' && next && localFrame > key.frame) {
    const t = (localFrame - key.frame) / (next.frame - key.frame);
    return key.position.map((value, axis) => (1 - t) * value + t * next.position[axis]);
  }
  return [...key.position];
}
const trackOf = (keys, interpolation, blend) =>
  createKeyframeClip({
    tracks: [
      {
        target: 'model',
        path: 'translation',
        blend,
        keys: keys.map((key) => ({
          time: key.frame,
          value: key.position,
          interpolation: interpolation === 'LINEAR' ? 'linear' : 'discrete',
        })),
      },
    ],
  }).tracks[0];

// Numerical Recipes LCG, as @margoengine/math's createLcgRandom.
let seed = 20261020;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

test("'weighted' reproduces the Studio vector-track evaluation bit for bit, LINEAR and STEP", () => {
  for (let run = 0; run < 200; run++) {
    const keys = [];
    for (let frame = Math.floor(random() * 3); keys.length < 2 + (run % 5); frame += 1 + Math.floor(random() * 9))
      keys.push({ frame, position: [0, 1, 2].map(() => (random() - 0.5) * 10 ** Math.floor(random() * 12 - 4)) });
    const interpolation = run % 3 ? 'LINEAR' : 'STEP',
      track = trackOf(keys, interpolation, 'weighted'),
      last = keys[keys.length - 1].frame;
    for (let k = 0; k < 40; k++) {
      const frame = k < 5 ? keys[k % keys.length].frame : random() * (last + 4) - 2; // key times and fractional frames
      if (frame < 0) continue;
      assert.deepEqual(
        Array.from(sampleKeyframes(track, frame)),
        studioVector(keys, frame, interpolation),
        `run ${run} frame ${frame}`,
      );
    }
  }
});

test("'weighted' stays finite for ±1e308 keys; the default 'delta' keeps its arithmetic", () => {
  const keys = [
    { frame: 0, position: [1e308, -1e308, 1e308] },
    { frame: 4, position: [-1e308, 1e308, 1e308] },
    { frame: 8, position: [1e308, 1e308, -1e308] },
  ];
  const weighted = trackOf(keys, 'LINEAR', 'weighted'),
    delta = trackOf(keys, 'LINEAR', undefined);
  for (let frame = 0; frame <= 10; frame += 0.25) {
    const sample = sampleKeyframes(weighted, frame);
    assert.ok(sample.every(Number.isFinite), `frame ${frame}: ${sample}`);
    assert.deepEqual(Array.from(sample), studioVector(keys, frame, 'LINEAR'), `frame ${frame}`);
  }
  // 'delta' is a + (b - a) f: b - a overflows here, so even the sample at the key is not finite. Unchanged on purpose.
  assert.ok(!Number.isFinite(sampleKeyframes(delta, 0)[0]));
  assert.ok(!Number.isFinite(sampleKeyframes(delta, 2)[0]));
  const ordinary = trackOf(
    [
      { frame: 0, position: [0.1, 3, -7] },
      { frame: 3, position: [0.7, -2, 5] },
    ],
    'LINEAR',
    undefined,
  );
  const f = 1 / 3;
  assert.deepEqual(Array.from(sampleKeyframes(ordinary, 1)), [
    0.1 + (0.7 - 0.1) * f,
    3 + (-2 - 3) * f,
    -7 + (5 - -7) * f,
  ]);
});

test("'weighted' holds keys by copying them before any arithmetic, including -0 and Number.MAX_VALUE", () => {
  const max = Number.MAX_VALUE,
    keys = [
      { frame: 0, position: [-0, max, -max] },
      { frame: 10, position: [-0, max, -max] },
      { frame: 20, position: [5, max * 0.999, -max] },
    ];
  const weighted = trackOf(keys, 'LINEAR', 'weighted');
  for (const frame of [0, 10, 20, 25]) {
    const sample = sampleKeyframes(weighted, frame),
      key = keys[Math.min(2, frame / 10)].position;
    key.forEach((value, c) =>
      assert.ok(Object.is(sample[c], value), `frame ${frame} [${c}] ${sample[c]} is not ${value}`),
    );
  }
  for (let frame = 0; frame <= 20; frame += 0.1)
    assert.ok(sampleKeyframes(weighted, frame).every(Number.isFinite), `frame ${frame}`);
  const step = trackOf(keys, 'STEP', 'weighted');
  assert.ok(Object.is(sampleKeyframes(step, 15)[0], -0), 'a discrete segment holds the key value itself');
});

test('blend is validated, optional, and leaves rotations on the shared slerp', () => {
  assert.throws(
    () =>
      createKeyframeClip({
        tracks: [{ target: 'a', path: 'scale', blend: 'cubic', keys: [{ time: 0, value: [1, 1, 1] }] }],
      }),
    { name: 'TypeError', message: /blend cubic/ },
  );
  const plain = createKeyframeClip({ tracks: [{ target: 'a', path: 'scale', keys: [{ time: 0, value: [1, 1, 1] }] }] });
  assert.equal('blend' in plain.tracks[0], false, 'tracks without a blend are built exactly as before');
  const rotation = (blend) =>
    createKeyframeClip({
      tracks: [
        {
          target: 'arm',
          path: 'rotation',
          blend,
          keys: [
            { time: 0, value: [0, 0, 0, 1] },
            { time: 1, value: [0, Math.sin(1), 0, Math.cos(1)] },
          ],
        },
      ],
    }).tracks[0];
  assert.deepEqual(sampleKeyframes(rotation('weighted'), 0.3), sampleKeyframes(rotation(undefined), 0.3));
  assert.deepEqual(Array.from(sampleKeyframes(rotation('weighted'), 1)), [0, Math.sin(1), 0, Math.cos(1)]);
});
