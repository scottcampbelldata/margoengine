import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bakeRefractedLightmap as bake,
  cauchy,
  sampleVisibleNormal,
  smithG1,
  wavelengthRgb,
} from '../dist/refracted.js';

const close = (a, b, t = 1e-10) => assert.ok(Math.abs(a - b) <= t, `${a} != ${b} ± ${t}`);
const floor = () => ({ positions: Float32Array.from([-5, 0, -5, -5, 0, 5, 5, 0, 5, 5, 0, -5]) });
function box(y0 = 1, y1 = 2, x0 = -10, x1 = 10, z0 = -10, z1 = 10) {
  return {
    positions: Float32Array.from([
      ...[x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1],
      ...[x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0],
    ]),
    indices: Uint32Array.from([
      0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 3, 5, 0, 5, 4, 1, 7, 6, 1, 6, 2, 0, 4, 7, 0, 7, 1, 3, 2, 6, 3, 6, 5,
    ]),
  };
}
function prism() {
  return {
    positions: Float32Array.from([-1, 2, -1, 1, 2, -1, 0, 1.5, -1, -1, 2, 1, 1, 2, 1, 0, 1.5, 1]),
    indices: Uint32Array.from([0, 1, 2, 3, 5, 4, 0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 3, 2, 3, 0]),
  };
}
const beam = (corner = [-0.5, 3, -0.5]) => ({
  type: 'directional',
  direction: [0, 1, 0],
  aperture: { corner, edgeU: [1, 0, 0], edgeV: [0, 0, 1] },
});
const opts = (volumes, more = {}) => ({
  glassVolumes: volumes,
  emitters: [beam()],
  photons: 8192,
  seed: 27,
  texelsPerUnit: 4,
  maxAtlasSize: 128,
  ...more,
});
const terms = ['deposited', 'escaped', 'absorbed', 'truncated', 'unrefracted', 'blocked', 'masked'];
/** Emitted plus receiver reflection equals the seven terminal terms. */
function ledger(result, t = 1e-8) {
  const d = result.diagnostics;
  for (let c = 0; c < 3; c++)
    close(
      d.emitted[c] + d.reflected[c],
      terms.reduce((s, k) => s + d[k][c], 0),
      t,
    );
}
/** Flux on chart q per channel, and the share of it more than `r` from the floor centre along x. */
function spread(result, q = 0, r = 0.6, channel = 0) {
  const { atlas, irradiance } = result,
    c = atlas.charts[q];
  let sum = 0,
    out = 0,
    x = 0,
    ax = 0;
  for (let j = 0; j < c.height; j++)
    for (let i = 0; i < c.width; i++) {
      const e = irradiance[((c.y + j) * atlas.width + c.x + i) * 3 + channel],
        px = -5 + ((j + 0.5) * 10) / c.height;
      sum += e;
      x += e * px;
      ax += e * Math.abs(px);
      if (Math.abs(px) > r) out += e;
    }
  return { flux: (sum * 100) / (c.width * c.height), outside: out / sum, x: x / sum, ax: ax / sum };
}

test('Smith G1 and visible-normal sampling match the GGX visible normal density by quadrature', () => {
  const alpha = 0.5,
    view = [Math.sin(1), 0, Math.cos(1)],
    n = [0, 0, 1],
    g1 = smithG1(view[2], alpha),
    D = (c) => {
      const t2 = (1 - c * c) / (c * c);
      return (alpha * alpha) / (Math.PI * c ** 4 * (alpha * alpha + t2) ** 2);
    };
  // Integral of the visible normal density over the hemisphere is 1 (Heitz 2018 eq. 2 normalization).
  let total = 0,
    mean = 0;
  const steps = 1000;
  for (let i = 0; i < steps; i++)
    for (let k = 0; k < steps; k++) {
      const th = ((i + 0.5) / steps) * (Math.PI / 2),
        ph = ((k + 0.5) / steps) * 2 * Math.PI,
        m = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)],
        vm = Math.max(0, view[0] * m[0] + view[2] * m[2]),
        w = ((g1 * vm * D(m[2])) / view[2]) * Math.sin(th) * (Math.PI / 2 / steps) * ((2 * Math.PI) / steps);
      total += w;
      mean += w * m[2];
    }
  close(total, 1, 2e-3);
  let sampled = 0;
  const count = 200000;
  for (let i = 0; i < count; i++) {
    const m = sampleVisibleNormal(view, n, alpha, (i + 0.5) / count, (i * 0.6180339887498949) % 1);
    close(Math.hypot(...m), 1, 1e-12);
    assert.ok(view[0] * m[0] + view[2] * m[2] >= -1e-12, 'a sampled normal faces the view');
    sampled += m[2];
  }
  close(sampled / count, mean, 2e-3);
  close(smithG1(1, alpha), 1);
  close(smithG1(0.5, 0), 1);
  assert.equal(smithG1(0, alpha), 0);
  assert.ok(smithG1(0.2, 0.8) < smithG1(0.2, 0.3));
});

test('the Cauchy fit meets the ior at 587.6 nm and the Abbe number; the CIE fit is a rainbow', () => {
  const n = cauchy(1.5, 40);
  close(n(587.6), 1.5, 1e-12);
  close((n(587.6) - 1) / (n(486.1) - n(656.3)), 40, 1e-9);
  assert.ok(n(450) > n(650));
  const [r6, g6, b6] = wavelengthRgb(620),
    [r4, g4, b4] = wavelengthRgb(450),
    [r5, g5, b5] = wavelengthRgb(530);
  assert.ok(r6 > g6 && r6 > b6, 'red at 620 nm');
  assert.ok(b4 > r4 && b4 > g4, 'blue at 450 nm');
  assert.ok(g5 > r5 && g5 > b5, 'green at 530 nm');
  assert.deepEqual(
    wavelengthRgb(300).map((c) => c < 1e-6),
    [true, true, true],
  );
});

test('roughness 0 and no dispersion reproduce the smooth bake exactly', async () => {
  const smooth = await bake(floor(), opts([prism()])),
    zero = await bake(floor(), opts([{ ...prism(), roughness: 0, dispersion: 0 }], { bounces: 0 }));
  assert.deepEqual(zero.irradiance, smooth.irradiance);
  assert.deepEqual(zero.diagnostics, smooth.diagnostics);
  assert.deepEqual(smooth.diagnostics.masked, [0, 0, 0]);
  assert.deepEqual(smooth.diagnostics.reflected, [0, 0, 0]);
  assert.equal(smooth.diagnostics.bounced, 0);
});

test('rough glass spreads the beam, loses only masked power and accounts for every watt', async () => {
  const slab = { ...box(), ior: 1.5 },
    smooth = await bake(floor(), opts([slab])),
    rough = await bake(floor(), opts([{ ...slab, roughness: 0.5 }])),
    rougher = await bake(floor(), opts([{ ...slab, roughness: 0.9 }]));
  ledger(smooth);
  ledger(rough);
  ledger(rougher);
  // A slab at normal incidence keeps the 1 x 1 footprint; microfacets scatter light outside it.
  assert.ok(spread(smooth).outside < 1e-12);
  assert.ok(spread(rough).outside > 0.15, `rough outside ${spread(rough).outside}`);
  assert.ok(spread(rougher).outside > spread(rough).outside);
  assert.ok(rough.diagnostics.masked[0] > 0 && rough.diagnostics.masked[0] < 0.2);
  assert.ok(rougher.diagnostics.masked[0] > rough.diagnostics.masked[0]);
  close(spread(rough).x, 0, 0.05);
  assert.equal(rough.diagnostics.photons, 8192);
});

test('dispersion splits white light by wavelength; white in, white out through index-matched glass', async () => {
  const flat = await bake(floor(), opts([{ ...box(), ior: 1, dispersion: 0.5 }], { photons: 4096 }));
  ledger(flat);
  for (let c = 0; c < 3; c++) {
    close(flat.diagnostics.emitted[c], 1, 1e-12);
    close(flat.diagnostics.deposited[c], 1, 1e-9);
  }
  // A strongly dispersive prism: blue bends more than red, toward the prism's apex side.
  const glass = { ...prism(), ior: 1.6, dispersion: 20 / 15 },
    plain = await bake(floor(), opts([{ ...prism(), ior: 1.6 }])),
    split = await bake(floor(), opts([glass]));
  ledger(split);
  const red = spread(split, 0, 0.6, 0),
    blue = spread(split, 0, 0.6, 2),
    white = spread(plain, 0, 0.6, 0);
  close(spread(plain, 0, 0.6, 0).ax, spread(plain, 0, 0.6, 2).ax, 1e-9);
  // The facets bend light across the axis before the floor, and blue (higher index) bends further.
  assert.ok(blue.ax > red.ax + 0.01, `blue ${blue.ax} red ${red.ax}`);
  assert.ok(white.flux > 0);
  // Dispersion with the same seed is reproducible.
  assert.deepEqual((await bake(floor(), opts([glass]))).irradiance, split.irradiance);
});

test('light bounces off receivers after glass: albedo-weighted, with every watt accounted', async () => {
  const quads = { ...floor(), albedo: Float32Array.from([1, 0.5, 0, 1]) },
    once = await bake(quads, opts([{ ...box(), ior: 1 }], { bounces: 1 })),
    none = await bake(quads, opts([{ ...box(), ior: 1 }], { bounces: 0 }));
  ledger(once);
  ledger(none);
  // Index-matched glass: all of the beam lands, the floor returns albedo times it, and the rest leaves the scene.
  for (let c = 0; c < 3; c++) {
    close(once.diagnostics.deposited[c], 1, 1e-9);
    close(once.diagnostics.reflected[c], [1, 0.5, 0][c], 1e-9);
    close(once.diagnostics.escaped[c], [1, 0.5, 0][c], 1e-9);
  }
  assert.equal(once.diagnostics.bounced, 8192);
  assert.deepEqual(once.irradiance, none.irradiance);
  // A wall beside the floor catches the bounced light only when bounces are on.
  const wall = {
      positions: Float32Array.from([
        ...[-5, 0, -5, -5, 0, 5, 5, 0, 5, 5, 0, -5],
        ...[3, 0, -5, 3, 0, 5, 3, 5, 5, 3, 5, -5],
      ]),
    },
    lit = await bake(wall, opts([{ ...box(1, 2, -2.9, 2.9, -2, 2), ior: 1.5 }], { bounces: 2 })),
    dark = await bake(wall, opts([{ ...box(1, 2, -2.9, 2.9, -2, 2), ior: 1.5 }]));
  ledger(lit);
  assert.ok(spread(lit, 1).flux > 0.01, `wall flux ${spread(lit, 1).flux}`);
  assert.equal(spread(dark, 1).flux, 0);
  assert.ok(lit.diagnostics.bounced > 0);
});

test('rough, dispersive and bounce options are checked before work', async () => {
  for (const [volume, more] of [
    [{ ...box(), roughness: -0.1 }, {}],
    [{ ...box(), roughness: 1.5 }, {}],
    [{ ...box(), roughness: Number.NaN }, {}],
    [{ ...box(), dispersion: -1 }, {}],
    [box(), { bounces: 5 }],
    [box(), { bounces: 1.5 }],
  ])
    await assert.rejects(bake(floor(), opts([volume], more)), RangeError);
});
