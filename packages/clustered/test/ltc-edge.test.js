// The polygon edge term of clustered's area lights (WGSL areaEdge): the ltc-edge vectors, a float32 emulation of the
// shader's formula over the whole range of a.b, and an independent quadrature of the clamped cosine over polygons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { edge, formFactor } from './ltc-reference.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/ltc-edge.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/area.ts', import.meta.url), 'utf8');

// The WGSL areaEdge step by step, every operation rounded to float32 (atan2 taken as correctly rounded).
const f = Math.fround;
function shaderEdge(a, b) {
  [a, b] = [a.map(f), b.map(f)];
  const n = [
    f(f(a[1] * b[2]) - f(a[2] * b[1])),
    f(f(a[2] * b[0]) - f(a[0] * b[2])),
    f(f(a[0] * b[1]) - f(a[1] * b[0])),
  ];
  const top = Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2]));
  if (top <= 0) return 0;
  const k = n.map((v) => f(v / top)),
    s = f(Math.sqrt(f(f(f(k[0] * k[0]) + f(k[1] * k[1])) + f(k[2] * k[2])))),
    d = f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
  return f(f(f(k[2] / s) * f(Math.atan2(f(top * s), d))) * f(0.15915494));
}

test('the shader carries the atan2 edge term', () => {
  assert.ok(source.includes('fn areaEdge(a:vec3f,b:vec3f)->f32 {'));
  assert.ok(source.includes('atan2(top*s,dot(a,b))*0.15915494'));
});

test('ltc-edge vectors: edges within max(1e-4 relative, 1e-6) in float64 and float32, quads within 1e-4', () => {
  for (const { a, b, edge: want } of vectors.edges) {
    const tolerance = Math.max(1e-4 * Math.abs(want), 1e-6);
    assert.ok(Math.abs(edge(a, b) - want) <= tolerance, `float64 ${a} ${b}: ${edge(a, b)} vs ${want}`);
    if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > -0.999)
      assert.ok(Math.abs(shaderEdge(a, b) - want) <= tolerance, `float32 ${a} ${b}: ${shaderEdge(a, b)} vs ${want}`);
  }
  for (const { height, offsetX, formFactor: want } of vectors.quads) {
    const square = [
      [offsetX - 0.5, -0.5, height],
      [offsetX + 0.5, -0.5, height],
      [offsetX + 0.5, 0.5, height],
      [offsetX - 0.5, 0.5, height],
    ];
    const got = formFactor(square);
    assert.ok(Math.abs(got / want - 1) < 1e-4, `quad h ${height} x ${offsetX}: ${got} vs ${want}`);
  }
});

test('float32 shader edge stays within 1e-5 relative of float64 for a.b from 1 down to -0.999999', () => {
  let worst = 0;
  for (let i = 0; i <= 4000; i++) {
    // Angles from 1e-6 to just short of pi, spaced in log scale near both ends.
    const t = i / 4000,
      theta =
        t < 0.5 ? 1e-6 * (Math.PI / 2 / 1e-6) ** (2 * t) : Math.PI - 1.5e-3 * (Math.PI / 2 / 1.5e-3) ** (2 * (1 - t)),
      tilt = 0.3 + 0.6 * Math.sin(i),
      a = [1, 0, 0],
      b = [Math.cos(theta), Math.sin(theta) * Math.cos(tilt), Math.sin(theta) * Math.sin(tilt)];
    const exact = edge(a, b),
      got = shaderEdge(a, b),
      error = Math.abs(got - exact) / Math.abs(exact);
    worst = Math.max(worst, error);
  }
  assert.ok(worst < 1e-5, `worst relative error ${worst}`);
  assert.equal(shaderEdge([0, 0, 0], [0, 0, 0]), 0, 'the unclipped horizon chord');
  assert.equal(shaderEdge([0, 0, 1], [0, 0, 1]), 0);
  assert.ok(Number.isFinite(shaderEdge([1, 0, 0], [-1, 1e-30, 0])));
});

// Independent reference: (1/pi) * integral over the planar polygon of max(cos, 0) * cos_light / r^2, midpoint rule.
function quadrature(points, k = 1200) {
  // Polygons here are planar quads given as corner, edge u, edge v (a parallelogram).
  const [o, u, v] = points,
    nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
    area = Math.hypot(...nrm);
  let sum = 0;
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) {
      const s = (i + 0.5) / k,
        t = (j + 0.5) / k,
        q = [0, 1, 2].map((c) => o[c] + u[c] * s + v[c] * t),
        r2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2],
        r = Math.sqrt(r2),
        cosine = q[2] / r;
      if (cosine <= 0) continue;
      sum += (cosine * Math.abs((q[0] * nrm[0] + q[1] * nrm[1] + q[2] * nrm[2]) / (r * area))) / r2;
    }
  return (sum * area) / (k * k) / Math.PI;
}

test('edge sum equals brute-force cosine quadrature for tilted quads above the horizon', () => {
  for (const [o, u, v] of [
    [
      [-0.5, -0.5, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0.3, -0.4, 0.6],
      [0.8, 0.1, 0.5],
      [-0.2, 1.1, 0.3],
    ],
    [
      [-2, 0.2, 0.4],
      [0.5, 0, 0.9],
      [0, 0.7, 0],
    ],
  ]) {
    const corners = [o, o.map((c, i) => c + u[i]), o.map((c, i) => c + u[i] + v[i]), o.map((c, i) => c + v[i])],
      // Counter-clockwise from +z gives a positive sum; the sign of either orientation's sum is its winding.
      exact = Math.abs(formFactor(corners)),
      reference = quadrature([o, u, v]);
    assert.ok(Math.abs(exact / reference - 1) < 1e-4, `${exact} vs ${reference}`);
  }
});
