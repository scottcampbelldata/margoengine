// subclip, subclipFrames, makeAdditive and applyAdditiveClip: a cut plays as the source did, a difference adds back up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Skeleton, applyKeyframeClip, createKeyframeClip, sampleKeyframes } from '../dist/index.js';
import { applyAdditiveClip, makeAdditive, subclip, subclipFrames } from '../dist/clip-utils.js';
import { axisAngle, near, sameRotation } from './support/models.js';

const v3 = (time, x, interpolation) => ({ time, value: [x, 0, 0], ...(interpolation ? { interpolation } : {}) });
/** Source and cut agree at `steps` times across the cut. */
function matches(source, cutClip, start, tolerance, steps = 97) {
  for (let t = 0; t < cutClip.tracks.length; t++)
    for (let i = 0; i <= steps; i++) {
      const at = (cutClip.duration * i) / steps;
      near(
        [...sampleKeyframes(cutClip.tracks[t], at)],
        [...sampleKeyframes(source.tracks[t], at + start)],
        tolerance,
        `${cutClip.tracks[t].target} at ${at}`,
      );
    }
}

test('a cut through linear keys plays exactly as the source, starts at 0 and keeps the keys inside it', () => {
  const walk = createKeyframeClip({
      name: 'Walk',
      tracks: [{ target: 'hips', path: 'translation', keys: [v3(0, 0), v3(1, 4), v3(2, 2), v3(3, 9)] }],
    }),
    part = subclip(walk, 0.5, 2.5);
  assert.equal(part.name, 'Walk');
  assert.equal(part.duration, 2);
  assert.deepEqual([...part.tracks[0].times], [0, 0.5, 1.5, 2]);
  matches(walk, part, 0.5, 1e-12);
  assert.equal(subclip(walk, 0, 1, { name: 'Start' }).name, 'Start');
});

test('discrete segments hold through a cut, and a cut on key times copies them as they are', () => {
  const steps = createKeyframeClip({
      tracks: [{ target: 'a', path: 'translation', keys: [v3(0, 1, 'discrete'), v3(1, 2, 'discrete'), v3(2, 3)] }],
    }),
    part = subclip(steps, 0.25, 1.75);
  assert.deepEqual(part.tracks[0].interpolations.slice(0, 2), ['discrete', 'discrete']);
  matches(steps, part, 0.25, 0);
  const exact = subclip(steps, 1, 2);
  assert.deepEqual([...exact.tracks[0].times], [0, 1]);
  assert.equal(exact.tracks[0].interpolations[0], 'discrete');
});

test('an eased segment the cut passes through follows its curve; a whole one keeps its interpolation', () => {
  const eased = createKeyframeClip({
      tracks: [{ target: 'a', path: 'translation', keys: [v3(0, 0, 'easeInOut'), v3(1, 1, 'easeIn'), v3(2, 5)] }],
    }),
    fps = 240,
    part = subclip(eased, 0.3, 2, { fps });
  assert.equal(part.tracks[0].interpolations.at(-2), 'easeIn', 'the whole segment after the cut');
  // Straight keys at 240 per second under a curve whose slope is at most 3 and curvature at most 12.
  matches(eased, part, 0.3, 12 / (8 * fps * fps) + 1e-12);
  const both = subclip(eased, 1, 2);
  matches(eased, both, 1, 1e-12);
});

test('a whole cubic segment keeps its end slope when the next segment is the one cut', () => {
  // Regression: the key starting a cut segment lost its in tangent, bending the whole segment before it.
  const spline = createKeyframeClip({
      tracks: [
        {
          target: 'a',
          path: 'translation',
          keys: [
            { time: 0, value: [0, 0, 0], interpolation: 'cubicSpline', outTangent: [3, 0, 0] },
            { time: 1, value: [1, 0, 0], interpolation: 'cubicSpline', inTangent: [-4, 0, 0], outTangent: [2, 0, 0] },
            { time: 2, value: [0, 0, 0], inTangent: [1, 0, 0] },
          ],
        },
      ],
    }),
    part = subclip(spline, 0, 1.5, { fps: 480 });
  for (let i = 0; i <= 50; i++) {
    const at = i / 50;
    near([...sampleKeyframes(part.tracks[0], at)], [...sampleKeyframes(spline.tracks[0], at)], 1e-12, `whole at ${at}`);
  }
  matches(spline, part, 0, 1e-4);
});

test('rotations slerp as the source, and a track with no key in the range holds its value', () => {
  const clip = createKeyframeClip({
      tracks: [
        { target: 'a', path: 'rotation', keys: [{ time: 0, value: axisAngle([0, 0, 1], 0) }, { time: 2, value: axisAngle([0, 0, 1], 120) }] },
        { target: 'b', path: 'translation', keys: [v3(0, 7)] },
        { target: 'c', path: 'translation', keys: [v3(0, 1), v3(2, 2)] },
      ],
    }),
    part = subclip(clip, 0.5, 1.5);
  sameRotation([...sampleKeyframes(part.tracks[0], 0.5)], axisAngle([0, 0, 1], 60), 1e-12);
  near([...sampleKeyframes(part.tracks[1], 0.5)], [7, 0, 0], 0, 'held');
});

test('markers in the range come along re-timed; property tracks stay bound and blend modes stay', () => {
  const lamp = { intensity: 0 };
  let fov = 0;
  const clip = createKeyframeClip({
      tracks: [
        { target: 'a', path: 'translation', blend: 'weighted', keys: [v3(0, 0), v3(2, 2)] },
        { target: lamp, property: 'intensity', keys: [{ time: 0, value: [0] }, { time: 2, value: [4] }] },
        { target: lamp, name: 'fov', set: (v) => (fov = v[0]), get: () => fov, keys: [{ time: 0, value: [10] }, { time: 2, value: [30] }] },
      ],
      markers: [{ time: 0.25, name: 'early' }, { time: 1, name: 'step', data: 7 }, { time: 1.5, name: 'edge' }],
    }),
    part = subclip(clip, 0.5, 1.5);
  assert.deepEqual(part.markers.map((m) => [m.time, m.name]), [[0.5, 'step'], [1, 'edge']]);
  assert.equal(part.markers[0].data, 7);
  assert.equal(part.tracks[0].blend, 'weighted');
  applyKeyframeClip(part, 0.5);
  assert.equal(lamp.intensity, 2);
  assert.equal(fov, 20);
});

test('subclipFrames cuts by frame number', () => {
  const clip = createKeyframeClip({ tracks: [{ target: 'a', path: 'translation', keys: [v3(0, 0), v3(2, 60)] }] }),
    part = subclipFrames(clip, 15, 45);
  assert.equal(part.duration, 1);
  near([...sampleKeyframes(part.tracks[0], 0)], [15, 0, 0], 1e-12);
  assert.equal(subclipFrames(clip, 0, 12, 24, { name: 'Half' }).name, 'Half');
});

test('an additive clip is identity at its reference, and base plus difference is the source between keys too', () => {
  const clip = createKeyframeClip({
      name: 'Nod',
      tracks: [
        { target: 'head', path: 'translation', keys: [v3(0, 1), v3(1, 3)] },
        { target: 'head', path: 'scale', keys: [{ time: 0, value: [2, 2, 2] }, { time: 1, value: [4, 2, 1] }] },
        { target: 'head', path: 'rotation', keys: [{ time: 0, value: axisAngle([0, 1, 0], 30) }, { time: 1, value: axisAngle([0, 1, 0], 90) }] },
      ],
      markers: [{ time: 0.5, name: 'mid' }],
    }),
    additive = makeAdditive(clip);
  assert.equal(additive.name, 'Nod (additive)');
  assert.equal(additive.markers.length, 1);
  near([...sampleKeyframes(additive.tracks[0], 0)], [0, -0, -0].map(() => 0), 1e-12);
  near([...sampleKeyframes(additive.tracks[1], 0)], [1, 1, 1], 1e-12);
  sameRotation([...sampleKeyframes(additive.tracks[2], 0)], [0, 0, 0, 1], 1e-12);
  const skeleton = new Skeleton([{ name: 'head', parent: -1 }]);
  for (const at of [0, 0.3, 0.77, 1]) {
    applyKeyframeClip(clip, skeleton, 0);
    applyAdditiveClip(additive, skeleton, at);
    const added = skeleton.getPose(0);
    applyKeyframeClip(clip, skeleton, at);
    const source = skeleton.getPose(0);
    near(added.translation, source.translation, 1e-12, `translation at ${at}`);
    near(added.scale, source.scale, 1e-12, `scale at ${at}`);
    sameRotation(added.rotation, source.rotation, 1e-12, `rotation at ${at}`);
  }
});

test('cubic keys stay exact: tangents take the same difference', () => {
  const clip = createKeyframeClip({
      tracks: [
        {
          target: 'a',
          path: 'translation',
          keys: [
            { time: 0, value: [1, 0, 0], interpolation: 'cubicSpline', outTangent: [3, 0, 0] },
            { time: 1, value: [2, 0, 0], inTangent: [-1, 0, 0] },
          ],
        },
      ],
    }),
    additive = makeAdditive(clip);
  for (const at of [0.2, 0.5, 0.9]) {
    const expected = sampleKeyframes(clip.tracks[0], at);
    expected[0] -= 1;
    near([...sampleKeyframes(additive.tracks[0], at)], [...expected], 1e-12, `at ${at}`);
  }
});

test('a reference from another clip, weights, a zero scale axis and weighted application', () => {
  const idle = createKeyframeClip({
      tracks: [
        { target: 'a', path: 'translation', keys: [v3(0, 10), v3(1, 20)] },
        { target: 'a', path: 'scale', keys: [{ time: 0, value: [0, 2, 1] }] },
        { target: 'face', path: 'weights', keys: [{ time: 0, value: [0.25, 0.5] }] },
      ],
    }),
    clip = createKeyframeClip({
      tracks: [
        { target: 'a', path: 'translation', keys: [v3(0, 15)] },
        { target: 'a', path: 'scale', keys: [{ time: 0, value: [5, 4, 1] }] },
        { target: 'face', path: 'weights', keys: [{ time: 0, value: [1, 1] }] },
      ],
    }),
    additive = makeAdditive(clip, { clip: idle, time: 0.5, name: 'Lean' });
  assert.equal(additive.name, 'Lean');
  near([...sampleKeyframes(additive.tracks[0], 0)], [0, 0, 0], 1e-12, 'against 15 at half a second');
  near([...sampleKeyframes(additive.tracks[1], 0)], [1, 2, 1], 1e-12, 'a zero reference axis gives 1');
  near([...sampleKeyframes(additive.tracks[2], 0)], [0.75, 0.5], 1e-12);
  const skeleton = new Skeleton([{ name: 'a', parent: -1 }]),
    turn = makeAdditive(
      createKeyframeClip({
        tracks: [
          { target: 'a', path: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: axisAngle([0, 0, 1], 90) }] },
          { target: 'a', path: 'translation', keys: [v3(0, 0), v3(1, 8)] },
          { target: 'nobody', path: 'translation', keys: [v3(0, 0), v3(1, 8)] },
        ],
      }),
    );
  applyAdditiveClip(turn, skeleton, 1, 0);
  near(skeleton.getPose(0).translation, [0, 0, 0], 0, 'weight 0 changes nothing');
  applyAdditiveClip(turn, skeleton, 1, 0.5);
  near(skeleton.getPose(0).translation, [4, 0, 0], 1e-12);
  sameRotation(skeleton.getPose(0).rotation, axisAngle([0, 0, 1], 45), 1e-9, 'half the turn');
});

test('bad input is refused with the fix in the message', () => {
  const clip = createKeyframeClip({ tracks: [{ target: 'a', path: 'translation', keys: [v3(0, 0), v3(1, 1)] }] }),
    other = createKeyframeClip({ tracks: [{ target: 'b', path: 'translation', keys: [v3(0, 0)] }] }),
    skeleton = new Skeleton([{ name: 'a', parent: -1 }]);
  for (const [a, b] of [[-1, 1], [0.5, 0.5], [0.6, 0.2], [0, 2], [NaN, 1]])
    assert.throws(() => subclip(clip, a, b), /use 0 <= start < end/);
  assert.throws(() => subclip(clip, 0, 1, { fps: 0 }), /fps/);
  assert.throws(() => subclipFrames(clip, 0.5, 2), /frames must be integers/);
  assert.throws(() => makeAdditive(clip, { clip: other }), /no translation track for a/);
  assert.throws(() => makeAdditive(clip, { time: -1 }), /reference time/);
  assert.throws(() => applyAdditiveClip(clip, skeleton, 0, -1), /weight/);
});
