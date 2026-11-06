import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../../core/dist/index.js';
import { CameraProjection, fovToLens, lensToFov } from '../dist/index.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
const ndc = (m, p) => {
  const c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
  return c.map((v) => v / c[3]);
};

test('familiar full-frame angles: the horizontal field of view of 24, 35, 50 and 85 mm on 36 mm', () => {
  // aspect 1 makes horizontal and vertical equal: 2·atan(18 / f)
  for (const [f, deg] of [
    [24, 73.7],
    [35, 54.4],
    [50, 39.6],
    [85, 23.9],
  ])
    assert.ok(Math.abs(lensToFov(f, 1) - deg) < 0.05, `${f} mm`); // the angles camera makers print
});

test('auto spans the longer side: landscape sensor width is horizontal, portrait is vertical', () => {
  close(lensToFov(50, 1.5), (360 / Math.PI) * Math.atan(0.36 / 1.5)); // 26.99 vertical
  close(lensToFov(50, 1.5), 26.99146656, 1e-8);
  close(lensToFov(50, 2 / 3), 39.59775271, 1e-8); // portrait: 36 mm is the height
  close(lensToFov(50, 0.5, { sensorFit: 'horizontal' }), (360 / Math.PI) * Math.atan(0.36 / 0.5));
  close(lensToFov(50, 3, { sensorFit: 'vertical', filmGauge: 24 }), (360 / Math.PI) * Math.atan(0.24));
});

test('fovToLens inverts lensToFov for every fit, 500 seeded lenses', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 500; i++) {
    const f = 4 + rand() * 600,
      aspect = 0.3 + rand() * 3,
      options = {
        filmGauge: 5 + rand() * 60,
        sensorFit: ['auto', 'horizontal', 'vertical'][i % 3],
      };
    close(fovToLens(lensToFov(f, aspect, options), aspect, options), f, 1e-9);
  }
});

test('a projection with a focal length draws the lens field of view on a perspective camera', () => {
  const camera = new Camera({ position: [0, 0, 10], target: [0, 0, 0], fov: 90 });
  const p = new CameraProjection({ mode: 'perspective', focalLength: 50 });
  p.attach(camera);
  camera.update(1.5, true);
  // At 10 units a 50 mm lens on 36 mm sees 3.6 units to each side of the centre, and 2.4 up.
  const edge = ndc(camera.matrix, [3.6, 2.4, 0]);
  close(edge[0], 1, 1e-6);
  close(edge[1], 1, 1e-6);
  camera.update(2 / 3, true); // portrait: the 36 mm side is the height
  close(ndc(camera.matrix, [2.4, 3.6, 0])[1], 1, 1e-6);
  p.filmGauge = 24;
  p.sensorFit = 'vertical';
  camera.update(2, true);
  close(ndc(camera.matrix, [0, 2.4, 0])[1], 1, 1e-6);
});

test('fov follows the lens: applyLens and onPreUpdate write camera.fov; no lens leaves it alone', () => {
  const camera = new Camera({ position: [0, 0, 10], target: [0, 0, 0], fov: 90 });
  const p = new CameraProjection({ mode: 'perspective' });
  p.setup({ camera, canvas: { width: 300, height: 200 } });
  p.onPreUpdate(0);
  assert.equal(camera.fov, 90);
  p.focalLength = 50;
  p.onPreUpdate(0);
  close(camera.fov, lensToFov(50, 1.5));
  assert.equal(p.applyLens(2), camera.fov);
  close(camera.fov, lensToFov(50, 2));
  p.setViewOffset(1000, 500, 0, 0, 100, 50); // the frustum is the full image's
  p.onPreUpdate(0);
  close(camera.fov, lensToFov(50, 2));
});

test('orthographic framing and fit use the lens field of view', () => {
  const camera = new Camera({ position: [0, 0, 10], target: [0, 0, 0], fov: 90 });
  const p = new CameraProjection({ focalLength: 85 });
  p.attach(camera);
  camera.update(1.5, true);
  const half = 10 * Math.tan((lensToFov(85, 1.5) * Math.PI) / 360);
  close(ndc(camera.matrix, [0, half, 0])[1], 1, 1e-6);
  p.fit([-1, -1, -1, 1, 1, 1], { aspect: 1.5, duration: 0 });
  close(p.zoom, half / 1.1, 1e-9); // the box outline is 1 half-unit tall, padded 10 percent
});

test('perspective fit with a lens frames the box with the lens fov', () => {
  const camera = new Camera({ position: [0, 0, 50], target: [0, 0, 0], fov: 90 });
  const p = new CameraProjection({ mode: 'perspective', focalLength: 200 });
  p.attach(camera);
  p.fit([-1, -1, -1, 1, 1, 1], { aspect: 1, duration: 0 });
  close(camera.fov, lensToFov(200, 1));
  // a narrow lens needs the camera farther away than the 90 degree fov it replaced
  assert.ok(Math.hypot(...camera.position) > 10);
});

test('lens errors say what to pass', () => {
  for (const call of [
    () => lensToFov(0, 1),
    () => lensToFov(50, 0),
    () => lensToFov(50, 1, { filmGauge: -1 }),
    () => lensToFov(Number.NaN, 1),
    () => lensToFov(50, 1, { sensorFit: 'diagonal' }),
    () => fovToLens(180, 1),
    () => fovToLens(0, 1),
  ])
    assert.throws(call, (e) => e instanceof RangeError && /Invalid projection lens;/.test(e.message));
  const camera = new Camera({ position: [0, 0, 10], target: [0, 0, 0] });
  new CameraProjection({ mode: 'perspective', focalLength: -5 }).attach(camera);
  assert.throws(() => camera.update(1, true), /Invalid projection lens;/);
  assert.throws(
    () => new CameraProjection().applyLens(1),
    (e) => e.code === 'state',
  );
});
