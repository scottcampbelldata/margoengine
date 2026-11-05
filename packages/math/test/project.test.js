// Project and unproject (@margoengine/math/project) against core's real Camera on both depth conventions, its
// orthographic hook, a hand-built matrix, and seeded round trips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { Vector3, projectPoint, unprojectPoint, worldToScreen, screenToWorld } from '../dist/index.js';
import { projectPoint as entryProject } from '@margoengine/math/project';

const near = (a, b, e = 1e-5) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const camera = (webgpu = true, aspect = 2) => {
  const c = new Camera({ position: [0, 0, 10], target: [0, 0, 0], fov: 90, near: 1, far: 100 });
  c.update(aspect, webgpu);
  return c;
};

test('the entry works on its own', () => {
  assert.equal(entryProject(new Vector3(0, 0, 0), camera(), new Vector3()).x, 0);
});

test('projectPoint: the view centre, right edge and top edge', () => {
  const c = camera(),
    out = new Vector3();
  projectPoint(new Vector3(0, 0, 0), c, out);
  near(out.x, 0);
  near(out.y, 0);
  // 90 degree fov at distance 10: half height 10, half width 20 at aspect 2.
  projectPoint(new Vector3(20, 0, 0), c, out);
  near(out.x, 1);
  projectPoint(new Vector3(0, 10, 0), c, out);
  near(out.y, 1);
});

test('projectPoint: WebGPU depth is 1 at near and 0 at far, WebGL -1 and 1', () => {
  const out = new Vector3();
  near(projectPoint(new Vector3(0, 0, 9), camera(true), out).z, 1);
  near(projectPoint(new Vector3(0, 0, -90), camera(true), out).z, 0);
  near(projectPoint(new Vector3(0, 0, 9), camera(false), out).z, -1);
  near(projectPoint(new Vector3(0, 0, -90), camera(false), out).z, 1);
});

test('projectPoint: a point on or behind the camera plane gives null and leaves out alone', () => {
  const c = camera(),
    out = new Vector3(7, 8, 9);
  assert.equal(projectPoint(new Vector3(1, 2, 11), c, out), null);
  assert.equal(projectPoint(new Vector3(1, 2, 10), c, out), null);
  assert.equal(projectPoint(new Vector3(NaN, 0, 0), c, out), null);
  assert.equal(projectPoint(new Vector3(0, 0, Infinity), c, out), null);
  assert.deepEqual(out.toArray(), [7, 8, 9]);
  // Between the camera and near is still in front: it has a place on screen.
  assert.ok(projectPoint(new Vector3(0, 0, 9.5), c, out));
});

test('project and unproject: an out may be its input', () => {
  const c = camera(),
    p = new Vector3(3, 4, -5),
    expected = p.clone();
  projectPoint(p, c, p);
  assert.ok(Math.abs(p.x) < 1 && Math.abs(p.y) < 1);
  unprojectPoint(p, c, p);
  assert.ok(p.distanceTo(expected) < 1e-3, `${p.toArray()}`);
});

test('unprojectPoint: the near and far planes on both depth conventions', () => {
  const out = new Vector3();
  for (const [webgpu, nearZ, farZ] of [
    [true, 1, 0],
    [false, -1, 1],
  ]) {
    const c = camera(webgpu);
    unprojectPoint(new Vector3(0, 0, nearZ), c, out);
    assert.ok(out.distanceTo(new Vector3(0, 0, 9)) < 1e-3, `near ${out.toArray()}`);
    unprojectPoint(new Vector3(0, 0, farZ), c, out);
    assert.ok(out.distanceTo(new Vector3(0, 0, -90)) < 1e-2, `far ${out.toArray()}`);
    unprojectPoint(new Vector3(1, 1, nearZ), c, out);
    assert.ok(out.distanceTo(new Vector3(2, 1, 9)) < 1e-3, `corner ${out.toArray()}`);
  }
});

test('orthographic: the camera.project hook goes through the same functions', () => {
  const c = new Camera({ position: [0, 0, 10], target: [0, 0, 0], near: 1, far: 21 });
  c.project = (P) => {
    P[0] = 1 / 8;
    P[5] = 1 / 4;
    P[10] = 1 / 20;
    P[14] = 21 / 20;
    P[15] = 1;
  };
  c.update(2, true);
  const out = new Vector3();
  projectPoint(new Vector3(8, -4, 0), c, out);
  near(out.x, 1);
  near(out.y, -1);
  near(out.z, 0.55);
  unprojectPoint(new Vector3(0.5, 0.5, 0.55), c, out);
  assert.ok(out.distanceTo(new Vector3(4, 2, 0)) < 1e-4, `${out.toArray()}`);
  // w stays 1, so behind the camera still has a place on an orthographic view.
  assert.ok(projectPoint(new Vector3(0, 0, 50), c, out));
});

test('a plain {matrix} works: float64 round trips hold to float64 precision', () => {
  // Translation by (1, 2, 3): w is 1 everywhere.
  const matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]),
    out = new Vector3();
  assert.deepEqual(projectPoint(new Vector3(1, 1, 1), { matrix }, out).toArray(), [2, 3, 4]);
  assert.deepEqual(unprojectPoint(new Vector3(2, 3, 4), { matrix }, out).toArray(), [1, 1, 1]);
});

test('unprojectPoint: coordinates at infinity give null and leave out alone', () => {
  // Rows of a projective map whose inverse sends z = 1 to homogeneous w = 0: w_out = 1 - z.
  const matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1]),
    out = new Vector3(7, 8, 9);
  assert.equal(unprojectPoint(new Vector3(0, 0, 1), { matrix }, out), null);
  assert.deepEqual(out.toArray(), [7, 8, 9]);
});

test('worldToScreen and screenToWorld: pixels, y down', () => {
  const c = camera(),
    out = new Vector3();
  worldToScreen(new Vector3(0, 0, 0), c, 800, 400, out);
  near(out.x, 400, 1e-3);
  near(out.y, 200, 1e-3);
  worldToScreen(new Vector3(-20, 10, 0), c, 800, 400, out);
  near(out.x, 0, 1e-3);
  near(out.y, 0, 1e-3);
  assert.equal(worldToScreen(new Vector3(0, 0, 20), c, 800, 400, out), null);
  const depth = worldToScreen(new Vector3(5, -2, 3), c, 800, 400, out).z;
  screenToWorld(out.x, out.y, depth, c, 800, 400, out);
  assert.ok(out.distanceTo(new Vector3(5, -2, 3)) < 1e-3, `${out.toArray()}`);
});

test('errors: a missing matrix and a camera not yet updated', () => {
  const out = new Vector3();
  assert.throws(() => projectPoint(new Vector3(), {}, out), TypeError);
  assert.throws(() => unprojectPoint(new Vector3(), { matrix: [1, 0, 0] }, out), TypeError);
  assert.throws(() => projectPoint(new Vector3(), null, out), TypeError);
  assert.throws(() => unprojectPoint(new Vector3(), new Camera(), out), /camera\.update/);
  assert.throws(() => screenToWorld(0, 0, 0.5, new Camera(), 100, 100, out), RangeError);
  // Not updated: all zero, w = 0, so nothing has a place on screen.
  assert.equal(projectPoint(new Vector3(), new Camera(), out), null);
});

test('round trips through core cameras (2,000 seeded points, Float32 matrix)', () => {
  const random = seeded(31),
    ndc = new Vector3(),
    back = new Vector3();
  let worst = 0;
  for (let n = 0; n < 2000; n++) {
    const webgpu = n % 2 === 0,
      c = new Camera({
        position: [random() * 20 - 10, random() * 20 - 10, random() * 20 - 10],
        target: [random(), random(), random()],
        fov: 30 + random() * 90,
        near: 0.1,
        far: 1000,
      });
    c.update(0.5 + random() * 2, webgpu);
    const x = random() * 1.8 - 0.9,
      y = random() * 1.8 - 0.9,
      z = webgpu ? random() : random() * 2 - 1,
      p = unprojectPoint(new Vector3(x, y, z), c, new Vector3());
    if (!p) continue;
    if (!projectPoint(p, c, ndc)) continue;
    // Stay within the visible depth range, where the depth maps one to one.
    assert.ok(Math.abs(ndc.x - x) < 1e-3 && Math.abs(ndc.y - y) < 1e-3, `${ndc.toArray()} vs ${[x, y, z]}`);
    unprojectPoint(ndc, c, back);
    worst = Math.max(worst, back.distanceTo(p) / Math.max(1, p.length()));
  }
  assert.ok(worst < 1e-6, `worst relative round trip ${worst}`);
});
