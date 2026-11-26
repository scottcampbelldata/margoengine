import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromMediaPipe, landmarkStream, OneEuroFilter, startWebcam, webcamLandmarks } from '../dist/landmarks.js';

const results = JSON.parse(readFileSync(new URL('./fixtures/mediapipe-results.json', import.meta.url), 'utf8'));
const empty = (time) => ({ time, faces: [], hands: [], poses: [] });

test('fromMediaPipe maps face, hand and pose results into one frame', () => {
  const frame = fromMediaPipe(results, results.time);
  assert.equal(frame.time, 1000);
  assert.deepEqual(frame.faces[0].blendshapes, {
    eyeBlinkLeft: 0.8,
    jawOpen: 0.35,
  });
  assert.equal(frame.faces[0].landmarks.length, 2);
  assert.equal(frame.faces[0].transform[14], -40);
  // MediaPipe labels hands as mirrored; an unmirrored frame swaps them by default.
  assert.deepEqual(
    frame.hands.map((h) => [h.handedness, h.score]),
    [
      ['right', 0.97],
      ['left', 0.91],
    ],
  );
  assert.equal(fromMediaPipe(results, 0, { mirroredHandedness: false }).hands[0].handedness, 'left');
  assert.equal(frame.poses[0].worldLandmarks[0].y, -0.6);
  assert.throws(() => fromMediaPipe({ face: {} }, 0), TypeError);
  assert.throws(() => fromMediaPipe(results, NaN), TypeError);
});

test('landmarkStream reads pushed frames, keeps the newest for a slow reader and ends on abort', async () => {
  const stream = landmarkStream({ buffer: 2 });
  for (const t of [1, 2, 3]) stream.push(empty(t));
  stream.close();
  const seen = [];
  for await (const frame of stream) seen.push(frame.time);
  assert.deepEqual(seen, [2, 3]);
  assert.throws(() => stream.push(empty(4)), {
    name: 'MargoError',
    code: 'disposed',
  });

  const controller = new AbortController();
  const live = landmarkStream({ signal: controller.signal });
  const reading = live[Symbol.asyncIterator]().next();
  live.push(empty(5));
  assert.equal((await reading).value.time, 5);
  const waiting = live[Symbol.asyncIterator]().next();
  controller.abort();
  assert.equal((await waiting).done, true);
  assert.throws(() => landmarkStream({ buffer: 0 }), RangeError);
  assert.throws(() => landmarkStream().push({ time: 0 }), TypeError);
});

/** A fake camera: getUserMedia returns tracks that record stop(); the video fires frames when `frame()` is called. */
const camera = () => {
  const tracks = [
    {
      stopped: false,
      stop() {
        this.stopped = true;
      },
    },
  ];
  const callbacks = new Map();
  let id = 0;
  const video = {
    srcObject: null,
    muted: false,
    playsInline: false,
    currentTime: 0,
    paused: true,
    play: async () => void (video.paused = false),
    pause: () => void (video.paused = true),
    requestVideoFrameCallback: (cb) => (callbacks.set(++id, cb), id),
    cancelVideoFrameCallback: (h) => callbacks.delete(h),
  };
  const frame = (time, advance = true) => {
    if (advance) video.currentTime += 1 / 30;
    const list = [...callbacks.values()];
    callbacks.clear();
    for (const cb of list) cb(time, { mediaTime: video.currentTime });
  };
  const mediaDevices = {
    getUserMedia: async () => ({ getTracks: () => tracks }),
  };
  return { tracks, video, frame, mediaDevices, pending: () => callbacks.size };
};

test('startWebcam plays the stream, calls onFrame once per new picture and stops every track', async () => {
  const cam = camera();
  const times = [];
  const webcam = await startWebcam({
    video: cam.video,
    mediaDevices: cam.mediaDevices,
    onFrame: (_, t) => times.push(t),
  });
  assert.equal(cam.video.muted && cam.video.playsInline && !cam.video.paused, true);
  cam.frame(10);
  cam.frame(20, false); // same picture again
  cam.frame(30);
  assert.deepEqual(times, [10, 30]);
  webcam[Symbol.dispose]();
  assert.equal(cam.tracks[0].stopped, true);
  assert.equal(cam.video.srcObject, null);
  assert.equal(cam.pending(), 0);

  const aborted = camera(),
    controller = new AbortController();
  await startWebcam({
    video: aborted.video,
    mediaDevices: aborted.mediaDevices,
    signal: controller.signal,
    onFrame() {},
  });
  controller.abort();
  assert.equal(aborted.tracks[0].stopped, true);
  await assert.rejects(startWebcam({ mediaDevices: {} }), {
    code: 'unsupported',
  });
});

test('webcamLandmarks runs the detector per frame and surfaces its error after stopping the camera', async () => {
  const cam = camera();
  const source = await webcamLandmarks({
    video: cam.video,
    mediaDevices: cam.mediaDevices,
    detect: (_, t) =>
      t === 3
        ? null
        : t > 3
          ? (() => {
              throw new Error('model lost');
            })()
          : fromMediaPipe(results, t),
  });
  const it = source[Symbol.asyncIterator]();
  cam.frame(1);
  assert.equal((await it.next()).value.faces.length, 1);
  cam.frame(3);
  cam.frame(4);
  await assert.rejects(it.next(), /model lost/);
  assert.equal(cam.tracks[0].stopped, true);
});

test('OneEuroFilter is a first-order low-pass at rest whose cutoff rises with speed', () => {
  const still = new OneEuroFilter({ minCutoff: 1, beta: 0 });
  assert.equal(still.filter(0, 0), 0);
  const a = 1 / (1 + 1 / (2 * Math.PI * 0.1));
  assert.ok(Math.abs(still.filter(1, 0.1) - a) < 1e-12);
  // Jitter about a still point shrinks.
  const jitter = new OneEuroFilter({ minCutoff: 1, beta: 0.01 });
  let raw = 0,
    out = 0;
  for (let i = 0; i < 300; i++) {
    const v = i % 2 ? 0.01 : -0.01;
    const f = jitter.filter(v, i / 60);
    if (i > 30) (raw += v * v), (out += f * f);
  }
  assert.ok(out < raw * 0.05);
  // A fast ramp lags far less with beta than without.
  const lag = (beta) => {
    const f = new OneEuroFilter({ minCutoff: 1, beta });
    let y = 0;
    for (let i = 0; i <= 60; i++) y = f.filter(i * 2, i / 60);
    return 120 - y;
  };
  assert.ok(lag(0.5) < lag(0) / 4);
  still.reset();
  assert.equal(still.filter(5, 1), 5);
  assert.throws(() => new OneEuroFilter({ minCutoff: 0 }), RangeError);
});

test('a MediaPipe result without landmark arrays says which result to pass', () => {
  assert.throws(() => fromMediaPipe({ face: {} }, 0), /; pass the object the face landmarker returned; see /);
  assert.throws(() => fromMediaPipe({ hands: {} }, 0), /; pass the object the hand landmarker returned; see /);
});
