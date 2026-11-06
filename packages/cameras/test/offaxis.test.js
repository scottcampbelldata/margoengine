import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../../core/dist/index.js';
import { CameraProjection } from '../dist/index.js';
import { ObliqueNearPlane, OffAxisProjection, obliqueProjection, offAxisFrustum } from '../dist/offaxis.js';

// camera.matrix is float32, so positions agree to about 1e-5 and the checks below allow EPS.
const EPS = 2e-4;
const ndc = (m, p) => {
  const c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
  return c.map((v) => v / c[3]);
};
const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const mul = (a, s) => a.map((v) => v * s);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => mul(a, 1 / Math.hypot(...a));
let seed = 11;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const between = (lo, hi) => lo + rand() * (hi - lo);

// A 2 x 1 screen centred at the origin facing +z.
const wall = { lowerLeft: [-1, -0.5, 0], lowerRight: [1, -0.5, 0], upperLeft: [-1, 0.5, 0] };
// Turns a screen about an axis through the origin by an angle (Rodrigues), then moves it.
const pose = (screen, axis, angle, shift) => {
  const k = unit(axis),
    c = Math.cos(angle),
    s = Math.sin(angle),
    turn = (p) => add(add(add(mul(p, c), mul(cross(k, p), s)), mul(k, dot(k, p) * (1 - c))), shift);
  return { lowerLeft: turn(screen.lowerLeft), lowerRight: turn(screen.lowerRight), upperLeft: turn(screen.upperLeft) };
};

test('frustum bounds of a centred eye are symmetric and move with the eye', () => {
  const a = offAxisFrustum(wall, [0, 0, 2], 1);
  assert.deepEqual([a.left, a.right, a.bottom, a.top, a.distance], [-0.5, 0.5, -0.25, 0.25, 2]);
  assert.deepEqual(a.normal, [0, 0, 1]);
  const b = offAxisFrustum(wall, [1, 0.5, 2], 1);
  assert.deepEqual([b.left, b.right, b.bottom, b.top], [-1, 0, -0.5, 0]);
});

for (const webgpu of [true, false])
  test(`${webgpu ? 'WebGPU' : 'WebGL'}: the screen is a window, whatever the eye and the screen pose`, () => {
    for (let i = 0; i < 60; i++) {
      const screen =
          i % 2
            ? wall
            : pose(wall, [rand() - 0.5, rand() - 0.5, rand() + 0.2], between(-1, 1), [
                between(-3, 3),
                between(-3, 3),
                between(-3, 3),
              ]),
        axes = offAxisFrustum(
          screen,
          add(
            screen.lowerLeft,
            mul(cross(sub(screen.lowerRight, screen.lowerLeft), sub(screen.upperLeft, screen.lowerLeft)), 1e3),
          ),
          1,
        ),
        w = Math.hypot(...sub(screen.lowerRight, screen.lowerLeft)),
        h = Math.hypot(...sub(screen.upperLeft, screen.lowerLeft)),
        centre = add(screen.lowerLeft, add(mul(axes.xAxis, w / 2), mul(axes.yAxis, h / 2))),
        eye = add(
          centre,
          add(
            add(mul(axes.xAxis, between(-2, 2)), mul(axes.yAxis, between(-1.5, 1.5))),
            mul(axes.normal, between(0.8, 6)),
          ),
        );
      const camera = new Camera({ near: 0.1, far: 200, position: [0, 0, 5], target: [0, 0, 0] });
      const p = new OffAxisProjection(screen, eye);
      p.attach(camera);
      camera.update(between(0.5, 3), webgpu); // the canvas aspect must not matter
      for (let k = 0; k < 6; k++) {
        const u = rand(),
          v = rand(),
          onScreen = add(screen.lowerLeft, add(mul(axes.xAxis, u * w), mul(axes.yAxis, v * h))),
          behind = add(onScreen, mul(sub(onScreen, eye), between(0, 4))), // further along the same line of sight
          [x, y, z] = ndc(camera.matrix, behind);
        // A point on the line of sight through (u, v) of the screen shows at (u, v) of the screen.
        assert.ok(Math.abs(x - (2 * u - 1)) < EPS, `x ${x} vs ${2 * u - 1}`);
        assert.ok(Math.abs(y - (2 * v - 1)) < EPS, `y ${y} vs ${2 * v - 1}`);
        assert.ok(webgpu ? z >= 0 && z <= 1 : z >= -1 && z <= 1, 'inside the depth range');
      }
      p.dispose();
    }
  });

test('the camera looks into the screen from the eye, and dispose restores it', () => {
  const camera = new Camera({ position: [0, 0, 5], target: [0, 0, 0] });
  camera.up = [1, 0, 0];
  const p = new OffAxisProjection(wall, [0.3, 0.2, 2]);
  p.attach(camera);
  assert.deepEqual(camera.position, [0.3, 0.2, 2]);
  assert.deepEqual(camera.target, [0.3, 0.2, 1]);
  assert.deepEqual(camera.up, [0, 1, 0]);
  p.setEye([1, 1, 3]);
  assert.deepEqual(camera.position, [1, 1, 3]);
  assert.throws(
    () => p.attach(new Camera()),
    (e) => e.code === 'attached',
  );
  assert.throws(
    () => new OffAxisProjection(wall).attach(camera),
    (e) => e.code === 'attached',
  );
  p.dispose();
  assert.equal(camera.project, undefined);
  assert.deepEqual(camera.up, [1, 0, 0]);
  assert.throws(
    () => p.setEye([0, 0, 1]),
    (e) => e.code === 'state',
  );
});

test('off-axis errors say what to pass', () => {
  const says = (re) => (e) => e instanceof RangeError && re.test(e.message) && /;/.test(e.message);
  assert.throws(() => offAxisFrustum(wall, [0, 0, -1], 1), says(/Invalid off-axis eye/));
  assert.throws(() => offAxisFrustum(wall, [0, 0, 0], 1), says(/Invalid off-axis eye/));
  assert.throws(
    () => offAxisFrustum({ ...wall, upperLeft: [-2, -0.5, 0] }, [0, 0, 1], 1),
    says(/Invalid off-axis screen/),
  );
  assert.throws(() => offAxisFrustum(wall, [0, 0, 1], 0), says(/Invalid off-axis screen/));
  assert.throws(() => offAxisFrustum(wall, [0, Number.NaN, 1], 1), says(/Invalid off-axis screen/));
});

// Oblique near plane -----------------------------------------------------------------------------------------------
const scene = (setup) => {
  const eye = [between(-3, 3), between(-2, 2), between(4, 9)],
    camera = new Camera({
      fov: between(40, 80),
      near: 0.1,
      far: 300,
      position: eye,
      target: [between(-1, 1), between(-1, 1), 0],
    });
  setup?.(camera);
  const forward = unit(sub(camera.target, eye)),
    point = add(eye, mul(forward, between(2, 6))),
    normal = unit(add(forward, [between(-0.6, 0.6), between(-0.6, 0.6), between(-0.6, 0.6)]));
  return { camera, point, normal, plane: [...normal, -dot(normal, point)] };
};
for (const webgpu of [true, false])
  for (const kind of ['perspective', 'orthographic'])
    test(`${webgpu ? 'WebGPU' : 'WebGL'} ${kind}: the oblique plane becomes the near plane and the frustum sides stay`, () => {
      const dn = webgpu ? 1 : -1;
      for (let i = 0; i < 40; i++) {
        const s = scene((camera) => {
          if (kind === 'orthographic') new CameraProjection({ height: 8 }).attach(camera);
        });
        s.camera.update(1.6, webgpu);
        const plain = Array.from(s.camera.matrix);
        const oblique = new ObliqueNearPlane(s.plane).attach(s.camera);
        s.camera.update(1.6, webgpu);
        const m = s.camera.matrix;
        // rows 0, 1 and 3 (x, y, w) are those of the plain camera
        for (const c of [0, 1, 2, 3])
          for (const r of [0, 1, 3])
            assert.ok(Math.abs(m[c * 4 + r] - plain[c * 4 + r]) < 1e-5 * Math.max(1, Math.abs(plain[c * 4 + r])));
        // points on the plane reach the near depth wherever they are on it
        const across = unit(cross(s.normal, Math.abs(s.normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])),
          down = cross(s.normal, across);
        for (let k = 0; k < 8; k++) {
          const q = add(s.point, add(mul(across, between(-1.5, 1.5)), mul(down, between(-1.5, 1.5)))),
            [, , z] = ndc(m, q);
          assert.ok(Math.abs(z - dn) < EPS * 5, `on the plane: depth ${z} vs ${dn}`);
          // a point behind the plane (toward the camera) is outside the depth range, one in front is inside it
          const behind = ndc(m, sub(q, mul(s.normal, 0.5))),
            front = ndc(m, add(q, mul(s.normal, 0.5)));
          assert.ok(webgpu ? behind[2] > 1 : behind[2] < -1, `behind the plane: depth ${behind[2]}`);
          assert.ok(webgpu ? front[2] < 1 && front[2] > 0 : front[2] > -1 && front[2] < 1, `in front: ${front[2]}`);
        }
        oblique.dispose();
        s.camera.update(1.6, webgpu);
        assert.deepEqual(Array.from(s.camera.matrix), plain, 'dispose restores the projection');
      }
    });

test('a point on the clipped side is culled by the camera planes, one on the kept side is not', () => {
  for (const webgpu of [true, false])
    for (let i = 0; i < 20; i++) {
      const s = scene();
      new ObliqueNearPlane(s.plane).attach(s.camera);
      s.camera.update(1.6, webgpu);
      const inside = (q) => {
        for (let k = 0; k < 6; k++) {
          const pl = s.camera.planes.slice(k * 4, k * 4 + 4);
          if (pl[0] * q[0] + pl[1] * q[1] + pl[2] * q[2] + pl[3] < -1e-4) return false;
        }
        return true;
      };
      assert.ok(inside(add(s.point, mul(s.normal, 0.5))), `${webgpu} kept side`);
      assert.ok(!inside(sub(s.point, mul(s.normal, 0.5))), `${webgpu} clipped side`);
    }
});

test('no plane changes nothing; it wraps OffAxisProjection and gives it back', () => {
  const camera = new Camera({ position: [0, 0, 5], target: [0, 0, 0] });
  camera.update(1.5, true);
  const plain = Array.from(camera.matrix);
  const oblique = new ObliqueNearPlane().attach(camera);
  camera.update(1.5, true);
  assert.deepEqual(Array.from(camera.matrix), plain);
  oblique.dispose();
  const eye = new Camera({ near: 0.1, far: 100, position: [0, 0, 5], target: [0, 0, 0] });
  new OffAxisProjection(wall, [0.5, 0, 3]).attach(eye);
  eye.update(1, true);
  const before = Array.from(eye.matrix);
  // keeps z <= 1: the screen and what is behind it, while the eye at z = 3 is on the clipped side
  const o2 = new ObliqueNearPlane([0, 0, -1, 1]).attach(eye);
  eye.update(1, true);
  assert.notDeepEqual(Array.from(eye.matrix), before);
  o2.dispose();
  eye.update(1, true);
  assert.deepEqual(Array.from(eye.matrix), before);
});

test('oblique errors say what to pass', () => {
  const says = (re) => (e) => e instanceof RangeError && re.test(e.message) && /;/.test(e.message);
  const P = new Float64Array(16);
  P[0] = P[5] = 1;
  P[10] = -1.1;
  P[11] = -1;
  P[14] = -0.2;
  assert.throws(() => obliqueProjection(P, [0, 0, 0, -1], false), says(/Invalid oblique plane/));
  assert.throws(() => obliqueProjection(P, [0, 0, 1, Number.NaN], false), says(/Invalid oblique plane/));
  assert.throws(() => obliqueProjection(P, [0, 0, 1, 2], false), says(/camera must be on the clipped side/));
  assert.throws(() => obliqueProjection(new Float64Array(16), [0, 0, 1, -1], false), says(/cannot be inverted/));
  const camera = new Camera();
  const o = new ObliqueNearPlane().attach(camera);
  assert.throws(
    () => o.attach(camera),
    (e) => e.code === 'attached',
  );
});
