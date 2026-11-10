// Accuracy rows of the batch 182 comparison: Margo output against closed-form references.
// Each case runs at two resolutions and requires second-order convergence, not a hand-picked tolerance.
import assert from 'node:assert/strict';
import test from 'node:test';
import { marchingCubes } from '@margoengine/sciviz/fallback';
import { tracePathline } from '@margoengine/sciviz/flow';
import { contour2D } from '../dist/contour2d.js';

async function sphere(n, radius) {
  const field = new Float32Array(n * n * n);
  const at = (i) => -1 + (2 * i) / (n - 1);
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) field[i + n * (j + n * k)] = radius - Math.hypot(at(i), at(j), at(k));
  const { vertices, triangles } = await marchingCubes(field, 0, { dims: [n, n, n] });
  let area = 0,
    volume = 0;
  const p = (t, c) => vertices.subarray((3 * t + c) * 8, (3 * t + c) * 8 + 3).map((x) => 2 * x - 1);
  for (let t = 0; t < triangles; t++) {
    const [a, b, c] = [p(t, 0), p(t, 1), p(t, 2)].map((v) => Array.from(v));
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    area += Math.hypot(...cross) / 2;
    // Divergence theorem: signed tetrahedron volumes against the origin.
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return { triangles, area, volume };
}

test('sphere isosurface area and enclosed volume converge to 4 pi r^2 and 4/3 pi r^3', async () => {
  const r = 0.7,
    area = 4 * Math.PI * r * r,
    volume = (4 / 3) * Math.PI * r ** 3;
  const coarse = await sphere(33, r),
    fine = await sphere(65, r);
  const e = (x, y) => Math.abs(x - y) / y,
    h = 2 / 64;
  // Halving the spacing must cut both relative errors by at least 3 (second order gives 4).
  assert.ok(e(coarse.area, area) > 3 * e(fine.area, area), JSON.stringify({ coarse, fine }));
  assert.ok(e(coarse.volume, volume) > 3 * e(fine.volume, volume), JSON.stringify({ coarse, fine }));
  assert.ok(e(fine.area, area) < 2 * h * h && e(fine.volume, volume) < 2 * h * h, JSON.stringify(fine));
});

const A = Math.sqrt(3),
  B = Math.sqrt(2),
  C = 1;
const abc = (x, y, z) => [
  A * Math.sin(z) + C * Math.cos(y),
  B * Math.sin(x) + A * Math.cos(z),
  C * Math.sin(y) + B * Math.cos(x),
];

function reference(seed, time, steps) {
  let p = [...seed];
  const h = time / steps,
    add = (a, b, s) => a.map((x, i) => x + s * b[i]);
  for (let i = 0; i < steps; i++) {
    const k1 = abc(...p),
      k2 = abc(...add(p, k1, h / 2)),
      k3 = abc(...add(p, k2, h / 2)),
      k4 = abc(...add(p, k3, h));
    p = p.map((x, j) => x + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
  }
  return p;
}

async function abcTrace(n, seed, time) {
  const u = new Float32Array(n ** 3),
    v = new Float32Array(n ** 3),
    w = new Float32Array(n ** 3);
  const at = (i) => (2 * Math.PI * i) / (n - 1);
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const q = i + n * (j + n * k);
        [u[q], v[q], w[q]] = abc(at(i), at(j), at(k));
      }
  const out = await tracePathline(
    { dims: [n, n, n], bounds: [0, 2 * Math.PI, 0, 2 * Math.PI, 0, 2 * Math.PI], frames: [{ time: 0, u, v, w }] },
    seed,
    { from: 0, to: time, step: 0.005 },
  );
  assert.equal(out.stop, 'end');
  return [...out.samples.slice(-4, -1)];
}

test('ABC flow streamline converges to an independent float64 RK4 of the analytic field', async () => {
  // Arnold-Beltrami-Childress flow, a steady Euler solution; the trace samples it on a grid.
  const seed = [Math.PI, Math.PI, Math.PI],
    time = 1,
    exact = reference(seed, time, 20_000);
  const distance = (p) => Math.hypot(p[0] - exact[0], p[1] - exact[1], p[2] - exact[2]);
  const coarse = distance(await abcTrace(33, seed, time)),
    fine = distance(await abcTrace(65, seed, time));
  const h = (2 * Math.PI) / 64;
  assert.ok(coarse > 3 * fine && fine < h * h, JSON.stringify({ coarse, fine, exact }));
});

function isoline(n) {
  const x = Array.from({ length: n }, (_, i) => -1 + (2 * i) / (n - 1));
  const values = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) values[i + n * j] = x[i] * x[i] + x[j] * x[j];
  return contour2D({ x, y: x, values }, { levels: [0.25] });
}

test('isoline of x^2 + y^2 converges to its analytic circle', async () => {
  const error = async (n) => {
    const { lines } = await isoline(n);
    let worst = 0,
      count = 0;
    for (const line of lines)
      for (const [x, y] of line.points) (worst = Math.max(worst, Math.abs(Math.hypot(x, y) - 0.5))), count++;
    return { worst, count, lines: lines.length, closed: lines.every((l) => l.closed) };
  };
  const coarse = await error(33),
    fine = await error(65),
    h = 2 / 64;
  assert.ok(coarse.closed && fine.closed && coarse.lines === 1 && fine.lines === 1);
  assert.ok(coarse.worst > 3 * fine.worst && fine.worst < h * h, JSON.stringify({ coarse, fine }));
});
