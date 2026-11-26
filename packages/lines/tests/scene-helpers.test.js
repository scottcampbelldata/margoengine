import test from 'node:test';
import assert from 'node:assert/strict';
import { LightProbeHelper, PositionalAudioHelper, shIrradiance } from '../dist/scene-helpers.js';

const close = (a, b, e = 1e-5, m = '') => assert.ok(Math.abs(a - b) <= e, `${m} expected ${b}, got ${a}`);
const point = (line, i) => [line.points[i * 4], line.points[i * 4 + 1], line.points[i * 4 + 2]];
const color = (line, i) => [line.colors[i * 4], line.colors[i * 4 + 1], line.colors[i * 4 + 2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('shIrradiance evaluates L2 coefficients and the Ramamoorthi-Hanrahan convolution', () => {
  // Constant radiance L projects to c0 = L * sqrt(4 pi); its irradiance over pi is L in every direction.
  const sh = new Float32Array(27);
  sh[0] = sh[1] = sh[2] = 2 * Math.sqrt(4 * Math.PI);
  for (const n of [
    [0, 1, 0],
    [1, 0, 0],
    [0, 0, -1],
  ])
    close(shIrradiance(sh, n, true)[0], 2, 1e-5, 'constant');
  // A linear band (l=1, m=0 along z): radiance coefficient c scaled by 2/3 when convolved.
  const z = new Float32Array(12);
  z[2 * 3] = 1;
  close(shIrradiance(z, [0, 0, 1])[0], 0.488602512, 1e-7, 'plain');
  close(shIrradiance(z, [0, 0, 1], true)[0], (0.488602512 * 2) / 3, 1e-7, 'band 1 factor');
});

test('LightProbeHelper shades a wire sphere by the probe irradiance', () => {
  // Light from +y only (an l=1, m=-1 term on top of a constant): the top is bright, the bottom dark, red only.
  const sh = new Float32Array(27);
  sh[0] = 1;
  sh[3] = 0.282094792 / 0.488602512; // band 1 along y, so the bottom is exactly 0
  const helper = new LightProbeHelper(sh, { position: [1, 2, 3], size: 0.5 });
  assert.equal(helper.count, (7 * 24 + 12 * 16) * 2, '7 rings and 12 meridians');
  let top = null,
    bottom = null;
  for (let i = 0; i < helper.count; i++) {
    const p = point(helper, i);
    close(dist(p, [1, 2, 3]), 0.5, 1e-5, 'on the sphere');
    if (Math.abs(p[1] - 2.5) < 1e-5) top = color(helper, i);
    if (Math.abs(p[1] - 1.5) < 1e-5) bottom = color(helper, i);
  }
  assert.deepEqual(top, [1, 0, 0], "brightest point scaled to 1, the probe's colour");
  bottom.forEach((v) => close(v, 0, 1e-6, 'no light from below'));

  // A function source (LightProbes.irradianceAt or Environment.irradianceAt) and a fixed exposure.
  const f = new LightProbeHelper((n) => [0.25, 0.5 * (n[1] > 0), 0], {
    exposure: 2,
  });
  const version = f.version;
  f.update();
  assert.equal(f.version, version, 'unchanged source: no rebuild');
  f.position[0] = 4;
  f.update();
  assert.ok(f.version > version, 'moved: rebuilt');
  close(dist(point(f, 0), [4, 0, 0]), 0.25, 1e-5, 'default size 0.25 about the new position');
  assert.equal(color(f, 0)[0], 0.5);
  assert.throws(() => new LightProbeHelper(new Float32Array(5)), /12 or 27 SH coefficients.*errors#scene-helpers/);
  assert.throws(() => new LightProbeHelper(sh, { size: 0 }), RangeError);
});

test('PositionalAudioHelper draws the Web Audio cones and distances and follows the sound', () => {
  const audio = {
    worldPosition: new Float64Array([0, 1, 0]),
    worldDirection: new Float64Array([0, 0, 1]),
    refDistance: 2,
    maxDistance: 10000,
    panner: { coneInnerAngle: 60, coneOuterAngle: 180 },
  };
  const helper = new PositionalAudioHelper(audio);
  // Two cones (8 lines + 32-segment rim each) and the ref sphere (3 circles); maxDistance 10000 is the unset default.
  assert.equal(helper.count, (8 + 32) * 2 * 2 + 3 * 32 * 2);
  // Inner cone generator: half of the whole 60 degree angle, at length refDistance.
  const tip = point(helper, 1);
  close(dist(tip, [0, 1, 0]), 2, 1e-5, 'cone length = refDistance');
  close(Math.acos((tip[2] - 0) / 2), Math.PI / 6, 1e-5, 'half the cone angle about the direction');
  assert.notDeepEqual(color(helper, 0), color(helper, 80), 'inner and outer cones in their own colours');
  // Outer cone of 180 degrees lies flat across the direction.
  close(point(helper, 80 + 1)[2], 0, 1e-6, '180 degree cone is a disc');

  audio.panner.coneInnerAngle = 360;
  audio.panner.coneOuterAngle = 360;
  audio.maxDistance = 20;
  helper.update();
  assert.equal(helper.count, 2 * 3 * 32 * 2, 'no cones; ref and max spheres');
  let far = 0;
  for (let i = 0; i < helper.count; i++) far = Math.max(far, dist(point(helper, i), [0, 1, 0]));
  close(far, 20, 1e-4, 'max distance sphere');
  const v = helper.version;
  helper.update();
  assert.equal(helper.version, v, 'unchanged: no rebuild');
  assert.throws(() => new PositionalAudioHelper({}), /errors#scene-helpers/);
  assert.throws(() => new PositionalAudioHelper(audio, { length: -1 }), RangeError);
  helper[Symbol.dispose]();
});
