import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ARKIT_BLENDSHAPES,
  FaceDriver,
  faceWeightsFromLandmarks,
  headRotation,
  measureFace,
  NEUTRAL_FACE,
} from '../dist/face.js';
import { fromMediaPipe, landmarkStream } from '../dist/landmarks.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-landmarks.json', import.meta.url), 'utf8'));
const results = JSON.parse(readFileSync(new URL('./fixtures/mediapipe-results.json', import.meta.url), 'utf8'));
/** 478 points: the fixture's named ones, every other point at the nose tip. */
const mesh = (...layers) => {
  const named = Object.assign({}, ...layers);
  const at = ([x, y, z]) => ({ x, y, z });
  return Array.from({ length: 478 }, (_, i) => at(named[i] ?? named[1]));
};
const neutral = mesh(fixture.neutral),
  expression = mesh(fixture.neutral, fixture.expression);
const frame = (landmarks, time, extra = {}) => ({ time, faces: [{ landmarks, ...extra }], hands: [], poses: [] });

test('the ARKit list holds the 52 published names once each', () => {
  assert.equal(ARKIT_BLENDSHAPES.length, 52);
  assert.equal(new Set(ARKIT_BLENDSHAPES).size, 52);
});

test('landmark measures give blink, jaw and one-sided smile weights against the neutral face', () => {
  const m = measureFace(neutral);
  assert.ok(Math.abs(m.eyeLeft - 0.263) < 1e-3 && Math.abs(m.mouthWidth - 0.6) < 1e-9);
  const rest = faceWeightsFromLandmarks(neutral, m);
  for (const [name, v] of Object.entries(rest)) assert.ok(v < 1e-9, `${name} is ${v} on the neutral face`);
  const w = faceWeightsFromLandmarks(expression, m);
  assert.equal(w.eyeBlinkLeft, 1);
  assert.equal(w.eyeBlinkRight, 0);
  assert.ok(w.jawOpen > 0.85 && w.jawOpen < 1, `jawOpen ${w.jawOpen}`);
  assert.ok(
    w.mouthSmileLeft > 0.8 && w.mouthSmileLeft - w.mouthSmileRight > 0.4,
    `smile ${w.mouthSmileLeft} ${w.mouthSmileRight}`,
  );
  assert.throws(() => measureFace(neutral.slice(0, 100)), RangeError);
  assert.equal(NEUTRAL_FACE.mouthWidth, 0.6);
});

test('head rotation follows a turned face', () => {
  // Turn the fixture 20 degrees about the vertical through its middle, in the y-up frame headRotation uses.
  const a = (20 * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const turned = neutral.map(({ x, y, z }) => {
    const px = x - 0.5,
      pz = -z;
    return { x: 0.5 + c * px + s * pz, y, z: -(-s * px + c * pz) };
  });
  const q0 = headRotation(neutral),
    q1 = headRotation(turned);
  // q1 * inverse(q0) is the turn: about +y by 20 degrees.
  const [x0, y0, z0, w0] = [-q0[0], -q0[1], -q0[2], q0[3]],
    [x1, y1, z1, w1] = q1;
  const d = [
    w1 * x0 + x1 * w0 + y1 * z0 - z1 * y0,
    w1 * y0 - x1 * z0 + y1 * w0 + z1 * x0,
    w1 * z0 + x1 * y0 - y1 * x0 + z1 * w0,
    w1 * w0 - x1 * x0 - y1 * y0 - z1 * z0,
  ];
  const sign = d[3] < 0 ? -1 : 1;
  assert.ok(Math.abs(d[0]) < 1e-9 && Math.abs(d[2]) < 1e-9, `turn axis ${d}`);
  assert.ok(Math.abs(sign * d[1] - Math.sin(a / 2)) < 1e-9 && Math.abs(sign * d[3] - Math.cos(a / 2)) < 1e-9);

  const driver = new FaceDriver({ smoothing: false }).calibrate(frame(neutral, 0));
  const r = driver.update(frame(turned, 33)).rotation;
  assert.ok(Math.abs(Math.abs(r[1]) - Math.sin(a / 2)) < 1e-9);
});

test('the driver writes ARKit weights to named morph targets through the name map', () => {
  const model = {
    primitives: [
      { targetNames: ['EyeBlinkLeft', 'jawOpen', 'Mouth_Smile_L', 'Belly'], weights: new Float32Array([0, 0, 0, 0.5]) },
    ],
  };
  using driver = new FaceDriver({ smoothing: false, names: { mouthSmileLeft: 'Mouth_Smile_L' } });
  driver.calibrate(frame(neutral, 0));
  const state = driver.update(frame(expression, 33));
  assert.equal(state.tracked, true);
  driver.apply(model);
  const [blink, jaw, smile, belly] = model.primitives[0].weights;
  assert.equal(blink, 1);
  assert.ok(Math.abs(jaw - state.weights.jawOpen) < 1e-6 && jaw > 0.85);
  assert.ok(smile > 0.8);
  assert.equal(belly, 0.5);
  // Mirrored: the closed eye is the picture's left, so the subject's right.
  const mirrored = new FaceDriver({ smoothing: false, mirror: true }).calibrate(frame(neutral, 0));
  assert.equal(mirrored.update(frame(expression, 33)).weights.eyeBlinkRight, 1);
});

test('detector blendshape scores are used when given, calibrated on the neutral face', () => {
  const mp = fromMediaPipe(results, 1000);
  const driver = new FaceDriver({ smoothing: false });
  const state = driver.update(mp);
  assert.equal(state.weights.eyeBlinkLeft, 0.8);
  assert.equal(state.weights.jawOpen, 0.35);
  assert.deepEqual(
    state.rotation.map((v) => Math.round(v * 1e9) / 1e9),
    [0, 0, 0, 1],
  );
  // A resting face that scores jawOpen 0.2 reads 0 there and rescales the rest of the range.
  const rest = {
    time: 0,
    faces: [
      { landmarks: [], blendshapes: { jawOpen: 0.2 }, transform: results.face.facialTransformationMatrixes[0].data },
    ],
    hands: [],
    poses: [],
  };
  driver.calibrate(rest);
  assert.ok(Math.abs(driver.update(mp).weights.jawOpen - 0.15 / 0.8) < 1e-12);
  assert.throws(() => new FaceDriver({ source: 'blendshapes' }).update(frame(neutral, 0)), { code: 'state' });
});

test('low confidence holds the last good weights, then eases to neutral; smoothing lags a step', () => {
  const driver = new FaceDriver({ smoothing: false, hold: 0.5 }).calibrate(frame(neutral, 0));
  const good = driver.update(frame(expression, 0)).weights.jawOpen;
  assert.equal(driver.update(frame(neutral, 100, { score: 0.1 })).weights.jawOpen, good);
  assert.equal(driver.update({ time: 400, faces: [], hands: [], poses: [] }).tracked, true);
  const lost = driver.update({ time: 700, faces: [], hands: [], poses: [] });
  assert.equal(lost.tracked, false);
  assert.equal(lost.weights.jawOpen, undefined);

  const smooth = new FaceDriver().calibrate(frame(neutral, 0));
  smooth.update(frame(neutral, 0));
  const step = smooth.update(frame(expression, 33)).weights.jawOpen;
  assert.ok(step > 0 && step < good, `smoothed ${step} vs raw ${good}`);
});

test('drive() reads a source, applies every frame and stops on abort; dispose ends the driver', async () => {
  const model = { primitives: [{ targetNames: ['jawOpen'], weights: [0] }] };
  const driver = new FaceDriver({ smoothing: false }).calibrate(frame(neutral, 0));
  const source = landmarkStream({ buffer: 4 });
  source.push(frame(neutral, 0));
  source.push(frame(expression, 33));
  source.close();
  const seen = [];
  await driver.drive(source, model, { onUpdate: (s) => seen.push(s.time) });
  assert.deepEqual(seen, [0, 33]);
  assert.ok(model.primitives[0].weights[0] > 0.85);

  const controller = new AbortController(),
    live = landmarkStream();
  const running = driver.drive(live, model, { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  driver.dispose();
  assert.throws(() => driver.update(frame(neutral, 0)), { code: 'disposed' });
  assert.throws(() => new FaceDriver({ minScore: 2 }), RangeError);
});

test('a NaN or Infinity score or point leaves the previous weight and rotation', () => {
  const model = { primitives: [{ targetNames: ['jawOpen', 'eyeBlinkLeft'], weights: [0, 0] }] };
  const scores = (jaw, time) => ({
    time,
    faces: [
      {
        landmarks: [],
        blendshapes: { jawOpen: jaw, eyeBlinkLeft: 0.5 },
        transform: results.face.facialTransformationMatrixes[0].data,
      },
    ],
    hands: [],
    poses: [],
  });
  const driver = new FaceDriver();
  driver.update(scores(0.4, 0));
  driver.apply(model);
  const state = driver.update(scores(Number.NaN, 33));
  assert.equal(state.weights.jawOpen, 0.4);
  driver.apply(model);
  assert.ok(Math.abs(model.primitives[0].weights[0] - 0.4) < 1e-12);
  assert.ok(Number.isFinite(driver.update(scores(Number.POSITIVE_INFINITY, 66)).weights.jawOpen));

  const marks = new FaceDriver({ smoothing: false }).calibrate(frame(neutral, 0));
  const good = marks.update(frame(expression, 33));
  const broken = expression.map((p, i) => (i === 14 || i === 33 ? { x: Number.NaN, y: p.y, z: p.z } : p));
  const held = marks.update(frame(broken, 66));
  assert.equal(held.weights.jawOpen, good.weights.jawOpen);
  assert.deepEqual(held.rotation, good.rotation);
});

test('calibrating on a frame without a face says what frame to pass', () => {
  using driver = new FaceDriver();
  assert.throws(() => driver.calibrate({ time: 0, faces: [], hands: [], poses: [] }), {
    code: 'state',
    message: /; pass a frame the detector found a face in; see /,
  });
});
