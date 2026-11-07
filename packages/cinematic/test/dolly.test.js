import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '@margoengine/splines';
import { DollyTrack } from '../dist/dolly.js';
import { VirtualCamera, createPose } from '../dist/brain.js';

const near = (a, b, limit = 1e-9) => assert.ok(Math.abs(a - b) <= limit, `${a} is not ${b} within ${limit}`);
const fixes = (pattern) => (error) => {
  assert.ok(error instanceof RangeError, `${error.name}: ${error.message}`);
  assert.match(error.message, pattern);
  assert.match(error.message, /;/);
  return true;
};
const straight = () => new Spline([[0, 0, 0], [50, 0, 0], [100, 0, 0]], { kind: 'catmull-rom', divisions: 2000 });
const step = (stage, delta) => {
  const pose = createPose();
  stage.update(pose, delta);
  return pose;
};
/** A circle of radius 10 in the XZ plane. */
const ring = () => {
  const points = [];
  for (let i = 0; i < 64; i++) points.push([10 * Math.cos((i / 64) * 2 * Math.PI), 0, 10 * Math.sin((i / 64) * 2 * Math.PI)]);
  return new Spline(points, { closed: true, divisions: 4096 });
};

test('the cart starts level with the subject and keeps pace with it', () => {
  const subject = [30, 5, 8],
    dolly = new DollyTrack(straight(), { target: () => subject });
  near(step(dolly, 1 / 60).position[0], 30, 1e-6);
  subject[0] = 60;
  for (let i = 0; i < 600; i++) step(dolly, 1 / 60);
  near(dolly.position, 60, 1e-6);
});

test('catching up is exponential at the rate and the same at any frame rate', () => {
  const run = (frames) => {
    const subject = [0, 0, 0],
      dolly = new DollyTrack(straight(), { target: () => subject, damping: 3 });
    step(dolly, 0);
    subject[0] = 40;
    for (let i = 0; i < frames; i++) step(dolly, 0.5 / frames);
    return dolly.position;
  };
  near(run(1), 40 * (1 - Math.exp(-1.5)), 1e-5);
  near(run(90), run(1), 1e-5);
});

test('lead stays ahead, and the ends of an open track stop the cart', () => {
  const subject = [20, 0, 0],
    dolly = new DollyTrack(straight(), { target: () => subject, lead: 7 });
  step(dolly, 0);
  near(dolly.position, 27, 1e-6);
  dolly.lead = -5;
  subject[0] = 3;
  dolly.reset();
  step(dolly, 0);
  assert.equal(dolly.position, 0);
  subject[0] = 500;
  dolly.lead = 5;
  dolly.reset();
  near(step(dolly, 0).position[0], 100, 1e-9);
});

test('on a closed track the cart takes the short way round past the seam', () => {
  const track = ring(),
    length = track.length;
  near(length, 2 * Math.PI * 10, 0.01);
  const subject = [10, 0, -0.5],
    dolly = new DollyTrack(track, { target: () => subject, damping: 2 });
  step(dolly, 0);
  const start = dolly.position;
  assert.ok(start > length * 0.9, `just before the seam: ${start}`);
  subject[0] = 9.9;
  subject[2] = 1.4;
  const seen = [];
  for (let i = 0; i < 300; i++) {
    step(dolly, 1 / 60);
    seen.push(dolly.position);
  }
  assert.ok(dolly.position < length * 0.1, `past the seam: ${dolly.position}`);
  assert.ok(seen.every((p) => p < length * 0.1 || p > length * 0.9), 'never the long way round');
});

test('a window keeps the cart on its own leg of a hairpin; without it the cart jumps across', () => {
  const hairpin = () =>
    new Spline(
      [[0, 0, 0], [50, 0, 0], [100, 0, 0], [102, 0, 1], [100, 0, 2], [50, 0, 2], [0, 0, 2]],
      { divisions: 4000 },
    );
  const run = (window) => {
    const subject = [50, 0, 0.2],
      dolly = new DollyTrack(hairpin(), { target: () => subject, window, damping: 50 });
    step(dolly, 0);
    // The subject crosses the middle line, nearer the far leg, as it walks on.
    subject[2] = 1.8;
    subject[0] = 52;
    for (let i = 0; i < 60; i++) step(dolly, 1 / 60);
    return step(dolly, 1 / 60).position[2];
  };
  near(run(10), 0, 0.01);
  near(run(undefined), 2, 0.01);
});

test('the windowed search finds the nearest point as closely as the whole-track search', () => {
  const subject = [33.3, 4, 1],
    whole = new DollyTrack(straight(), { target: () => subject }),
    local = new DollyTrack(straight(), { target: () => subject, window: 20, position: 30, damping: 1e6 });
  step(whole, 0);
  step(local, 1);
  near(local.position, whole.position, 1e-5);
  near(local.position, 33.3, 1e-4);
});

test('with no target the cart stays where it is put, by hand', () => {
  const dolly = new DollyTrack(straight(), { position: 25 });
  near(step(dolly, 1).position[0], 25, 1e-6);
  dolly.position = 70;
  near(step(dolly, 1).position[0], 70, 1e-6);
  dolly.position = 1000;
  near(step(dolly, 1).position[0], 100, 1e-9);
  assert.equal(dolly.position, 100);
  near(dolly.trackLength, 100, 1e-6);
  const wrapped = new DollyTrack(ring());
  wrapped.position = wrapped.trackLength + 1;
  step(wrapped, 0);
  near(wrapped.position, 1, 1e-9);
});

test('lookAlong aims down the track, also at its far end, and leaves the target alone when off', () => {
  const along = new DollyTrack(straight(), { position: 40, lookAlong: true }),
    pose = step(along, 0);
  near(pose.target[0], 41, 1e-3);
  const last = new DollyTrack(straight(), { position: 100, lookAlong: true }),
    end = step(last, 0);
  assert.ok(end.target[0] > end.position[0], 'the far end still looks forward');
  const off = createPose({ target: [1, 2, 3] });
  new DollyTrack(straight(), { position: 40 }).update(off, 0);
  assert.deepEqual([...off.target], [1, 2, 3]);
});

test('works as a stage: the camera reset restarts the cart', () => {
  const subject = [10, 0, 0],
    dolly = new DollyTrack(straight(), { target: () => subject }),
    camera = new VirtualCamera({ stages: [dolly], target: [0, 0, 0] });
  near(camera.update(0).position[0], 10, 1e-6);
  subject[0] = 90;
  camera.update(0);
  near(dolly.position, 10, 1e-6);
  camera.reset();
  near(camera.update(0).position[0], 90, 1e-6);
});

test('errors say what to pass', () => {
  const track = straight();
  assert.throws(() => new DollyTrack(track, { position: NaN }), fixes(/position/));
  assert.throws(() => new DollyTrack(track, { lead: NaN }), fixes(/lead/));
  assert.throws(() => new DollyTrack(track, { damping: 0 }), fixes(/damping/));
  assert.throws(() => new DollyTrack(track, { window: 0 }), fixes(/window/));
  assert.throws(() => new DollyTrack(new Spline([[0, 0, 0], [0, 0, 0]])), fixes(/track/));
  const dolly = new DollyTrack(track);
  dolly.position = NaN;
  assert.throws(() => step(dolly, 0), fixes(/position/));
  assert.throws(() => step(new DollyTrack(track, { target: [NaN, 0, 0] }), 0), fixes(/target/));
});
