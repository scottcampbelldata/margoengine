import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraNoise, handheld, vehicle, walking } from '../dist/noise.js';
import { createPose, VirtualCamera } from '../dist/brain.js';

const near = (a, b, limit = 1e-9) => assert.ok(Math.abs(a - b) <= limit, `${a} is not ${b} within ${limit}`);
const fixes = (pattern) => (error) => {
  assert.ok(error instanceof RangeError, `${error.name}: ${error.message}`);
  assert.match(error.message, pattern);
  assert.match(error.message, /;/);
  return true;
};
const pose = () => createPose({ position: [0, 0, 10], target: [0, 0, 0] });
const sample = (noise, seconds, rate, axis) => {
  const out = new Float64Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    noise.update(pose(), 1 / rate);
    out[i] = noise.values[axis];
  }
  return out;
};
/** Power by frequency, summed over seeds, by a plain discrete Fourier transform. Rows are [hertz, power]. */
function spectrum(band, seeds = 6, cycles = 96, rate = band.frequency * 16) {
  const n = Math.round((cycles * rate) / band.frequency),
    rows = [];
  for (let k = 1; k < n / 2; k++) rows.push([(k * rate) / n, 0]);
  for (let seed = 0; seed < seeds; seed++) {
    const signal = sample(new CameraNoise({ position: { x: [band] } }, { seed }), n / rate, rate, 0);
    for (let k = 1; k < n / 2; k++) {
      let re = 0,
        im = 0;
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * k * i) / n;
        re += signal[i] * Math.cos(a);
        im -= signal[i] * Math.sin(a);
      }
      rows[k - 1][1] += re * re + im * im;
    }
  }
  return rows;
}
/** The frequency with half the power below it. */
function median(rows) {
  const total = rows.reduce((sum, row) => sum + row[1], 0);
  let below = 0;
  for (const [hertz, power] of rows) if ((below += power) >= total / 2) return hertz;
}
const share = (rows, low, high) =>
  rows.filter(([hertz]) => hertz >= low && hertz <= high).reduce((sum, row) => sum + row[1], 0) /
  rows.reduce((sum, row) => sum + row[1], 0);

test('a band stays within its amplitude, reaches near it and its mean is near zero', () => {
  // The worst case is gradients of 1 and -1 with the point half way between them: 0.5, doubled to the amplitude.
  let peak = 0;
  for (let seed = 0; seed < 12; seed++) {
    const noise = new CameraNoise({ position: { x: [{ frequency: 3, amplitude: 0.5 }] } }, { seed }),
      signal = sample(noise, 300, 60, 0);
    peak = Math.max(peak, ...signal.map(Math.abs));
    near(signal.reduce((a, b) => a + b) / signal.length, 0, 0.01);
  }
  assert.ok(peak <= 0.5, `${peak}`);
  assert.ok(peak > 0.45, `${peak}`);
});

test('a band has its frequency in hertz: half its power lies below it and half above', () => {
  // The middle of 576 cycles of noise, read on a grid of a 96th of the frequency.
  for (const frequency of [0.5, 2, 12]) {
    const rows = spectrum({ frequency, amplitude: 1 });
    near(median(rows) / frequency, 1, 0.15);
    assert.ok(share(rows, frequency / 2, frequency * 2) > 0.8, `${frequency} Hz`);
  }
});

test('the bands of the presets sit in the ranges they name', () => {
  for (const [band, low, high] of [
    [handheld.rotation.pitch[2], 5, 12],
    [handheld.rotation.yaw[2], 5, 12],
    [vehicle.position.y[0], 1, 2],
    [vehicle.rotation.pitch[0], 1, 2],
    [vehicle.position.y[1], 10, 15],
    [vehicle.rotation.pitch[1], 10, 15],
  ]) {
    const middle = median(spectrum(band));
    assert.ok(middle >= low && middle <= high, `${band.frequency} Hz band has its middle at ${middle} Hz`);
  }
});

test('the motion is a function of time: any frame rate, the same seed, the same path; another seed differs', () => {
  const profile = handheld,
    a = new CameraNoise(profile, { seed: 2 }),
    b = new CameraNoise(profile, { seed: 2 }),
    c = new CameraNoise(profile, { seed: 3 });
  a.update(pose(), 1.5);
  for (let i = 0; i < 90; i++) b.update(pose(), 1 / 60);
  c.update(pose(), 1.5);
  for (let i = 0; i < 6; i++) near(a.values[i], b.values[i], 1e-9);
  assert.notEqual(a.values[3], c.values[3]);
});

test('axes do not move together', () => {
  const noise = new CameraNoise(
      { position: { x: [{ frequency: 2, amplitude: 1 }], y: [{ frequency: 2, amplitude: 1 }] } },
      { seed: 1 },
    ),
    x = [],
    y = [];
  for (let i = 0; i < 2000; i++) {
    noise.update(pose(), 1 / 30);
    x.push(noise.values[0]);
    y.push(noise.values[1]);
  }
  const dot = (p, q) => p.reduce((sum, v, i) => sum + v * q[i], 0);
  assert.ok(Math.abs(dot(x, y) / Math.sqrt(dot(x, x) * dot(y, y))) < 0.2);
});

test('position moves along the camera axes with the view, rotation turns the view about the camera', () => {
  const moved = new CameraNoise({ position: { x: [{ frequency: 1, amplitude: 1 }] } }, { seed: 5 }),
    p = pose();
  moved.update(p, 0.3);
  const x = moved.values[0];
  assert.notEqual(x, 0);
  near(p.position[0], x);
  near(p.position[1], 0);
  near(p.position[2], 10);
  near(p.target[0], x, 1e-9);

  const turned = new CameraNoise({ rotation: { yaw: [{ frequency: 1, amplitude: 0.2 }] } }, { seed: 5 }),
    q = pose();
  turned.update(q, 0.3);
  assert.deepEqual([...q.position], [0, 0, 10]);
  near(Math.hypot(q.target[0], q.target[1], q.target[2] - 10), 10);
  // A positive yaw turns left: from -Z toward -X.
  near(q.target[0], -10 * Math.sin(turned.values[4]));

  const pitched = new CameraNoise({ rotation: { pitch: [{ frequency: 1, amplitude: 0.2 }] } }, { seed: 5 }),
    r = pose();
  pitched.update(r, 0.3);
  // A positive pitch looks up.
  near(r.target[1], 10 * Math.sin(pitched.values[3]));

  const rolled = new CameraNoise({ rotation: { roll: [{ frequency: 1, amplitude: 0.2 }] } }, { seed: 5 }),
    s = pose();
  s.roll = 1;
  rolled.update(s, 0.3);
  near(s.roll, 1 + rolled.values[5]);
});

test('gain scales and 0 stops it, speed scales time and 0 holds it', () => {
  const profile = { position: { y: [{ frequency: 1, amplitude: 1 }] } },
    a = new CameraNoise(profile, { seed: 1 }),
    b = new CameraNoise(profile, { seed: 1, gain: 2 }),
    c = new CameraNoise(profile, { seed: 1, speed: 2 });
  a.update(pose(), 0.6);
  b.update(pose(), 0.6);
  c.update(pose(), 0.3);
  near(b.values[1], a.values[1] * 2);
  near(c.values[1], a.values[1]);
  a.gain = 0;
  const p = pose();
  a.update(p, 0.1);
  assert.deepEqual([...p.position], [0, 0, 10]);
  c.speed = 0;
  const before = c.time;
  c.update(pose(), 5);
  assert.equal(c.time, before);
  a.time = 0.6;
  a.gain = 1;
  a.update(pose(), 0);
  near(a.values[1], b.values[1] / 2);
});

test('the presets are plain JSON data and move the camera a little', () => {
  for (const profile of [handheld, walking, vehicle]) {
    assert.deepEqual(JSON.parse(JSON.stringify(profile)), profile);
    const noise = new CameraNoise(profile),
      p = pose();
    for (let i = 0; i < 100; i++) noise.update(p, 1 / 60);
    assert.ok(Math.abs(noise.values[1]) + Math.abs(noise.values[3]) > 0);
    assert.ok(noise.values.every((v) => Math.abs(v) < 0.05));
  }
});

test('a view along up, a view of no length and an empty profile do no harm', () => {
  const noise = new CameraNoise(handheld),
    p = createPose({ position: [0, 5, 0], target: [0, 0, 0] });
  noise.update(p, 1);
  assert.ok(p.target.every(Number.isFinite));
  const q = createPose({ position: [1, 1, 1], target: [1, 1, 1] });
  noise.update(q, 1);
  assert.deepEqual([...q.position], [1, 1, 1]);
  const none = pose();
  new CameraNoise({}).update(none, 1);
  assert.deepEqual([...none.position], [0, 0, 10]);
});

test('works as a stage of a virtual camera, leaving the base alone', () => {
  const camera = new VirtualCamera({ position: [0, 0, 10], target: [0, 0, 0], stages: [new CameraNoise(handheld)] });
  camera.update(0.7);
  assert.notEqual(camera.pose.position[0], 0);
  assert.equal(camera.base.position[0], 0);
});

test('errors say what to pass', () => {
  const band = (b) => ({ position: { x: [b] } });
  assert.throws(() => new CameraNoise(band({ frequency: 0, amplitude: 1 })), fixes(/band/));
  assert.throws(() => new CameraNoise(band({ frequency: 1, amplitude: -1 })), fixes(/band/));
  assert.throws(() => new CameraNoise(handheld, { gain: -1 }), fixes(/noise/));
  assert.throws(() => new CameraNoise(handheld, { speed: NaN }), fixes(/noise/));
  assert.throws(() => new CameraNoise(handheld, { seed: NaN }), fixes(/noise/));
  const noise = new CameraNoise(handheld);
  noise.gain = -1;
  assert.throws(() => noise.update(pose(), 0), fixes(/noise/));
});
