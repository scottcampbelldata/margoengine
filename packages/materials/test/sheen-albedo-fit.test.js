// The shipped sheen albedo fit (materialLobesSheenAlbedo, from scripts/sheen-albedo-fit.mjs) evaluated in JavaScript
// against a coarse, independent integration of our own sheen BRDF (materialLobesSheenBRDF in lobe-shader.ts).
// scripts/sheen-albedo-gpu-check.js runs the same WGSL on a GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sheen } from '../dist/index.js';

// The fit script measured a maximum error of 0.0109 against min(E, 1) on its validation grid.
const tolerance = 0.015;

function shippedAlbedo() {
  const source = sheen({ colorFactor: [1, 1, 1] }).declarations,
    body = source.match(/fn materialLobesSheenAlbedo\(mu:f32,roughness:f32\)->f32 \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'materialLobesSheenAlbedo is in the sheen declarations');
  // The function uses only let, vec4f, dot, max, exp and clamp, which map one to one onto JavaScript.
  const js = body.replace(/\blet\b/g, 'const').replace(/\bvec4f\(/g, 'vec4(');
  return new Function('vec4', 'dot', 'max', 'exp', 'clamp', `return (mu, roughness) => {${js}};`)(
    (...v) => v,
    (a, b) => a.reduce((s, v, i) => s + v * b[i], 0),
    Math.max,
    Math.exp,
    (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  );
}

// Charlie distribution (alpha = roughness^2) times the Neubelt visibility clamped to 1, as in materialLobesSheenBRDF.
function brdf(roughness, nl, mu, phi) {
  const alpha = Math.max(roughness, 1e-4) ** 2,
    sv = Math.sqrt(1 - mu * mu),
    sl = Math.sqrt(1 - nl * nl),
    tangential = sv * sv + sl * sl + 2 * sv * sl * Math.cos(phi),
    sin2 = tangential / (tangential + (mu + nl) ** 2);
  return (((2 + 1 / alpha) * sin2 ** (0.5 / alpha)) / (2 * Math.PI)) * Math.min(1, 1 / (4 * (nl + mu - nl * mu)));
}

/** Midpoint rule over n.l in [0, 1] and azimuth in [0, pi] (the integrand is even in azimuth). */
function integrate(mu, roughness, n = 400) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const nl = (i + 0.5) / n;
    for (let j = 0; j < n; j++) sum += nl * brdf(roughness, nl, mu, (Math.PI * (j + 0.5)) / n);
  }
  return (2 * sum * Math.PI) / (n * n);
}

test('the coarse integration reproduces the closed form at normal incidence', () => {
  for (const roughness of [0.3, 0.5, 1]) {
    const n = 1 / roughness ** 2;
    assert.ok(Math.abs(integrate(1, roughness) - 2 ** (-n / 2) / (n + 4)) < 1e-4, `roughness ${roughness}`);
  }
});

test('the shipped fit stays within its measured error of the integrated albedo', () => {
  const albedo = shippedAlbedo();
  for (const [mu, roughness] of [
    [1, 1],
    [0.5, 1],
    [0.05, 1],
    [0.7, 0.75],
    [0.3, 0.6],
    [0.9, 0.5],
    [0.5, 0.5],
    [0.15, 0.5],
    [0.3, 0.3],
    [0.6, 0.35],
    [0.2, 0.2],
    [0.12, 0.1],
    [0.08, 0.08],
  ]) {
    const expected = Math.min(1, integrate(mu, roughness)),
      actual = albedo(mu, roughness);
    assert.ok(
      Math.abs(actual - expected) <= tolerance,
      `mu ${mu} roughness ${roughness}: fit ${actual.toFixed(4)}, integral ${expected.toFixed(4)}`,
    );
  }
});

test('the fit is a finite energy fraction that falls from grazing to normal view', () => {
  const albedo = shippedAlbedo();
  for (const roughness of [0, 1e-4, 0.01, 0.1, 0.25, 0.5, 0.75, 1]) {
    let previous = Infinity;
    for (let i = 0; i <= 200; i++) {
      const value = albedo(i / 200, roughness);
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `roughness ${roughness} mu ${i / 200}`);
      assert.ok(value <= previous + 1e-12, `roughness ${roughness} rises at mu ${i / 200}`);
      previous = value;
    }
  }
  // Smooth sheen keeps its full albedo only at grazing views (E(0, r) = 2 for small r, clamped to 1).
  assert.equal(albedo(0, 0), 1);
  assert.ok(albedo(0.01, 0) < 1e-6);
});
