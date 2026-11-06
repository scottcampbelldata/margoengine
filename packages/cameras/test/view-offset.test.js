import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../../core/dist/index.js';
import { CameraProjection, tileOffsets } from '../dist/index.js';

const ndc = (m, p) => {
  const c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
  return c.map((v) => v / c[3]);
};
// camera.matrix is float32, so positions agree to about 1e-6 of the image size.
const toPixel = ([x, y], w, h) => [((x + 1) / 2) * w, ((1 - y) / 2) * h];
const scene = (mode) => {
  const camera = new Camera({ position: [3, 4, 10], target: [0.5, 0, 0], fov: 50, near: 0.5, far: 200 });
  const p = new CameraProjection({ mode, height: 6 });
  p.attach(camera);
  return { camera, p };
};
const points = [
  [0, 0, 0],
  [2, 1, -1],
  [-3, 2, 1],
  [1.5, -2, 2],
  [-0.5, 0.7, -3],
];

for (const mode of ['perspective', 'orthographic'])
  for (const webgpu of [true, false]) {
    test(`${mode} ${webgpu ? 'WebGPU' : 'WebGL'}: tiles stitch to the full image`, () => {
      const W = 1600,
        H = 900,
        { camera, p } = scene(mode);
      camera.update(W / H, webgpu);
      const full = Array.from(camera.matrix);
      for (const t of tileOffsets(W, H, 640, 360)) {
        p.setViewOffset(t.fullWidth, t.fullHeight, t.x, t.y, t.width, t.height);
        camera.update(t.width / t.height, webgpu); // the canvas aspect is the tile's, the frustum is the image's
        for (const q of points) {
          const f = ndc(full, q),
            [px, py] = toPixel(f, W, H),
            [tx, ty, tz] = ndc(camera.matrix, q);
          assert.ok(Math.abs(((tx + 1) / 2) * t.width + t.x - px) < 2e-3, `x of ${q} in ${t.x},${t.y}`);
          assert.ok(Math.abs(((1 - ty) / 2) * t.height + t.y - py) < 2e-3, `y of ${q} in ${t.x},${t.y}`);
          assert.ok(Math.abs(tz - f[2]) < 1e-4, 'depth does not change');
        }
      }
      p.clearViewOffset();
      camera.update(W / H, webgpu);
      assert.deepEqual(Array.from(camera.matrix), full);
    });
  }

test('the whole image as one offset is the unchanged projection', () => {
  const { camera, p } = scene('perspective');
  camera.update(2, true);
  const base = Array.from(camera.matrix);
  p.setViewOffset(800, 400, 0, 0, 800, 400);
  camera.update(2, true);
  camera.matrix.forEach((v, i) => assert.ok(Math.abs(v - base[i]) < 1e-6));
});

test('a fraction of a pixel moves the picture by that fraction (jitter)', () => {
  const { camera, p } = scene('perspective');
  p.setViewOffset(400, 300, 0, 0, 400, 300);
  camera.update(4 / 3, true);
  const a = toPixel(ndc(camera.matrix, points[1]), 400, 300);
  p.setViewOffset(400, 300, 0.25, -0.5, 400, 300);
  camera.update(4 / 3, true);
  const b = toPixel(ndc(camera.matrix, points[1]), 400, 300);
  assert.ok(Math.abs(a[0] - b[0] - 0.25) < 2e-3 && Math.abs(a[1] - b[1] + 0.5) < 2e-3);
});

test('culling follows the tile: a point in another tile is outside the planes', () => {
  const { camera, p } = scene('perspective');
  camera.update(16 / 9, true);
  const inside = (q) => {
    for (let i = 0; i < 6; i++) {
      const pl = camera.planes.slice(i * 4, i * 4 + 4);
      if (pl[0] * q[0] + pl[1] * q[1] + pl[2] * q[2] + pl[3] < 0) return false;
    }
    return true;
  };
  assert.ok(inside([0, 0, 0]));
  p.setViewOffset(1600, 900, 0, 0, 100, 100); // the top left corner only
  camera.update(1, true);
  assert.ok(!inside([0, 0, 0]));
});

test('tileOffsets covers the image once, edge tiles smaller', () => {
  const tiles = tileOffsets(1000, 700, 400, 300);
  assert.equal(tiles.length, 9);
  assert.equal(
    tiles.reduce((s, t) => s + t.width * t.height, 0),
    700000,
  );
  assert.deepEqual(tiles[8], { fullWidth: 1000, fullHeight: 700, x: 800, y: 600, width: 200, height: 100 });
  assert.equal(tileOffsets(10, 10, 4).length, 9);
  assert.throws(() => tileOffsets(10, 10, 0), /Invalid projection tiles;/);
  assert.throws(() => tileOffsets(10.5, 10, 4), RangeError);
});

test('a bad view offset names its fix; a bad one in options throws on update', () => {
  const { camera, p } = scene('orthographic');
  p.setViewOffset(100, 100, 0, 0, 0, 50);
  assert.throws(
    () => camera.update(1, true),
    (e) => e instanceof RangeError && /Invalid projection view offset;/.test(e.message),
  );
  p.setViewOffset(100, 100, Number.NaN, 0, 50, 50);
  assert.throws(() => camera.update(1, true), /Invalid projection view offset/);
  const q = new CameraProjection({
    viewOffset: { fullWidth: 200, fullHeight: 100, x: 100, y: 0, width: 100, height: 100 },
  });
  const c = new Camera({ position: [0, 0, 5], target: [0, 0, 0] });
  q.attach(c);
  c.update(1, true);
  assert.equal(q.viewOffset.x, 100);
});
