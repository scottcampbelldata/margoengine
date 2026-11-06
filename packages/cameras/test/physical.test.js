import test from 'node:test';
import assert from 'node:assert/strict';
import { DOF } from '../../dof/dist/index.js';
import { Bloom, MotionBlur } from '../../post/dist/index.js';
import { Tonemap } from '../../tonemap/dist/index.js';
import { lensToFov } from '../dist/index.js';
import { PhysicalCamera, ev100 } from '../dist/physical.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test('exposure value: f/1 for 1 s is EV 0, sunny 16 is about 15, ISO and equivalent pairs shift it by whole stops', () => {
  close(ev100(1, 1, 100), 0);
  assert.ok(Math.abs(ev100(16, 1 / 125, 100) - 15) < 0.05, 'sunny 16'); // the rule photographers print
  close(ev100(2.8, 1 / 60, 200), ev100(2.8, 1 / 60, 100) - 1);
  // f/4 at 1/125, f/5.6 at 1/60 and f/8 at 1/30 expose alike when the f-numbers are exact powers of root 2
  const stop = (k) => 2 ** (k / 2);
  for (let k = -3; k <= 12; k++) close(ev100(stop(k), 2 ** (k - 10), 100), ev100(stop(0), 2 ** -10, 100));
});

test('defaults match DOF and MotionBlur and render as 0 stops', () => {
  const c = new PhysicalCamera();
  assert.deepEqual(
    [c.focalLength, c.aperture, c.focusDistance, c.shutterFraction, c.shutterAngle],
    [50, 2.8, 5, 0.5, 180],
  );
  assert.equal(c.exposure, 0);
  assert.equal(c.exposureScale, 1);
});

test('one stop is one stop: aperture, shutter and ISO each move the exposure by the same amount', () => {
  const base = new PhysicalCamera();
  close(new PhysicalCamera({ aperture: 2.8 / Math.SQRT2 }).exposure, 1);
  close(new PhysicalCamera({ aperture: 2.8 * Math.SQRT2 }).exposure, -1);
  close(new PhysicalCamera({ shutter: base.shutter * 2 }).exposure, 1);
  close(new PhysicalCamera({ iso: 400 }).exposure, 2);
  close(new PhysicalCamera({ iso: 400 }).exposureScale, 4);
  // trading a stop of aperture for a stop of shutter leaves the exposure alone, and moves the other two
  const traded = new PhysicalCamera({ aperture: 2.8 * Math.SQRT2, shutter: base.shutter * 2 });
  close(traded.exposure, 0);
  assert.ok(
    traded.depthOfField().far - traded.depthOfField().near > base.depthOfField().far - base.depthOfField().near,
  );
  assert.equal(traded.shutterFraction, 1);
  assert.equal(new PhysicalCamera({ shutter: 1 }).shutterFraction, 1, 'a long exposure is a full frame, not more');
  close(new PhysicalCamera({ shutter: 1 / 240, frameRate: 120 }).shutterFraction, 0.5);
});

test('depth of field: the textbook case, 50 mm at f/8 focused at 5 m with a 0.03 mm circle', () => {
  const c = new PhysicalCamera({ aperture: 8, focusDistance: 5 }),
    d = c.depthOfField(0.03);
  close(d.hyperfocal, 10.4667, 1e-5); // f²/(N c) + f = 2500 / 0.24 + 50 mm
  close(d.near, 3.3894, 1e-4);
  close(d.far, 9.5273, 1e-4);
  assert.equal(new PhysicalCamera({ aperture: 8, focusDistance: 12 }).depthOfField(0.03).far, Infinity);
});

test('the blur disc is the circle of confusion exactly at the near and far limits, and 0 at the focus', () => {
  let seed = 3;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 200; i++) {
    const c = new PhysicalCamera({
        focalLength: 14 + rand() * 200,
        aperture: 1.2 + rand() * 20,
        focusDistance: 1 + rand() * 20,
        filmGauge: 10 + rand() * 40,
      }),
      coc = c.filmGauge / 1500,
      d = c.depthOfField();
    close(c.blurDiameter(c.focusDistance), 0);
    close(c.blurDiameter(d.near), coc, 1e-9);
    if (d.far < Infinity) close(c.blurDiameter(d.far), coc, 1e-9);
    assert.ok(
      c.blurDiameter(d.near * 0.9) > coc && c.blurDiameter((d.near + c.focusDistance) / 2) < coc,
      'sharper inside the range',
    );
  }
});

test('apply writes the same camera to the exposure, the depth of field, the motion blur and the lens', () => {
  const c = new PhysicalCamera({ focalLength: 85, aperture: 1.4, shutter: 1 / 60, iso: 200, focusDistance: 3 });
  const targets = {
    dof: { options: {} },
    motionBlur: { options: {} },
    exposure: { options: {} },
    camera: { fov: 60 },
    projection: {},
    aspect: 1.5,
  };
  c.apply(targets);
  assert.deepEqual(targets.dof.options, { focalDistance: 3, focalLength: 0.085, aperture: 1.4 });
  assert.equal(targets.motionBlur.options.shutter, 1);
  close(targets.exposure.options.exposure, c.exposure);
  close(targets.camera.fov, lensToFov(85, 1.5, { filmGauge: 36 }));
  assert.deepEqual(targets.projection, { focalLength: 85, filmGauge: 36 });
  // opening the aperture moves exposure and depth of field together
  const before = c.exposure;
  c.aperture = 2;
  c.apply(targets);
  assert.ok(targets.exposure.options.exposure < before && targets.dof.options.aperture === 2);
  c.apply({}); // nothing to write to is fine
});

test('physical camera errors say what to pass', () => {
  const says = (e) => e instanceof RangeError && /Invalid physical camera;/.test(e.message);
  assert.throws(() => new PhysicalCamera({ aperture: 0 }), says);
  assert.throws(() => new PhysicalCamera({ iso: Number.NaN }), says);
  assert.throws(() => new PhysicalCamera({ focusDistance: 0.04 }), says);
  assert.throws(() => ev100(2.8, 0), says);
  assert.throws(() => new PhysicalCamera().depthOfField(0), says);
  assert.throws(() => new PhysicalCamera().blurDiameter(0), says);
  const c = new PhysicalCamera();
  c.shutter = -1;
  assert.throws(() => c.exposure, says);
  assert.throws(() => c.apply({}), says);
});

test('apply drives the real DOF, MotionBlur, Tonemap and Bloom options', () => {
  const dof = new DOF({}),
    motionBlur = new MotionBlur({ velocity: () => undefined }),
    tonemap = new Tonemap({}),
    bloom = new Bloom({});
  const c = new PhysicalCamera({ aperture: 1.4, shutter: 1 / 240, iso: 400 });
  for (const exposure of [tonemap, bloom]) c.apply({ dof, motionBlur, exposure });
  assert.equal(dof.options.aperture, 1.4);
  assert.equal(dof.options.focalLength, 0.05);
  assert.equal(motionBlur.options.shutter, 0.25);
  assert.equal(tonemap.options.exposure, c.exposure);
  assert.equal(bloom.options.exposure, c.exposure);
  close(c.exposure, 3); // two stops of aperture, minus one of shutter, plus two of ISO
});
