// The measured materials library (src/measured.ts) against its sources: every metal F0 and n, k from the papers'
// tables, every dielectric IOR and Abbe number from the papers' formulas, every surface albedo from the spectral
// library samples, recomputed from test/fixtures through @margoengine/optics SpectralIntegrator (support-library.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DIELECTRICS,
  METALS,
  SOURCES,
  SURFACES,
  brick,
  copper,
  dielectric,
  iron,
  materialInfo,
  materials,
  metal,
  surface,
} from '../dist/presets.js';
import { albedo, dispersion, metalF0, nkAt } from './support-library.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const optical = fixture('optical-constants.json');
const spectra = fixture('surface-spectra.json');
const pbi = fixture('physicallybased.json');
const close = (got, want, tol, label) => assert.ok(Math.abs(got - want) <= tol, `${label}: ${got} against ${want}`);

test('metals: F0 within 0.002 of the papers\' n and k through the spectral integrator; n, k within 0.1 percent', () => {
  assert.deepEqual(Object.keys(METALS).sort(), Object.keys(optical.metals).sort());
  for (const [name, row] of Object.entries(METALS)) {
    const { points } = optical.metals[name];
    const f0 = metalF0(points).map((v) => Math.min(1, v));
    f0.forEach((v, i) => close(row.color[i], v, 0.002, `${name} F0[${i}]`));
    const [n, k] = nkAt(points);
    n.forEach((v, i) => close(row.n[i], v, Math.abs(v) * 1e-3 + 1e-4, `${name} n[${i}]`));
    k.forEach((v, i) => close(row.k[i], v, Math.abs(v) * 1e-3 + 1e-4, `${name} k[${i}]`));
  }
});

test('metals: known anchors (Johnson and Christy 1972 gold, silver, copper)', () => {
  // Gold reflects far more red than blue and its integrated red leaves sRGB (1.025), so it is clamped to 1.
  assert.equal(METALS.gold.color[0], 1);
  assert.ok(METALS.gold.color[2] < 0.4 && METALS.gold.color[1] > 0.7, String(METALS.gold.color));
  for (const c of METALS.silver.color) assert.ok(c > 0.97, `silver ${METALS.silver.color}`);
  // Copper sits within 0.04 of Hoffman's SIGGRAPH 2013 course figure (0.955, 0.638, 0.538), the old preset.
  [0.955, 0.638, 0.538].forEach((v, i) => close(METALS.copper.color[i], v, 0.04, `copper vs Hoffman [${i}]`));
});

test('dielectrics: IOR within 1e-4 and Abbe number within 0.1 of the papers\' dispersion formulas', () => {
  for (const [name, entry] of Object.entries(optical.dielectrics)) {
    const { nd, abbe } = dispersion(entry.formula);
    close(DIELECTRICS[name].ior, nd, 1e-4, `${name} ior`);
    close(DIELECTRICS[name].abbe, abbe, 0.1, `${name} abbe`);
  }
  // Published anchors: water 1.3330 (20 C), fused silica 1.4585, diamond 2.4175 at the d line.
  close(DIELECTRICS.water.ior, 1.333, 5e-4, 'water');
  close(DIELECTRICS.fusedSilica.ior, 1.4585, 2e-4, 'fused silica');
  close(DIELECTRICS.diamond.ior, 2.4175, 5e-4, 'diamond');
  for (const name of ['pet', 'polypropylene', 'pvc']) assert.equal(DIELECTRICS[name].ior, pbi.rows[name].ior);
});

test('surfaces: albedo within 0.002 of the mean of the named ECOSTRESS samples; database rows unchanged', () => {
  for (const [name, row] of Object.entries(SURFACES)) {
    if (pbi.rows[name]) {
      assert.deepEqual([...row.color], pbi.rows[name].color, name);
      continue;
    }
    const samples = spectra.surfaces[name];
    assert.ok(samples, `${name} has spectra`);
    assert.deepEqual([...row.samples], samples.map((s) => s.sample));
    albedo(samples.map((s) => s.reflectance)).forEach((v, i) => close(row.color[i], v, 0.002, `${name} albedo[${i}]`));
  }
});

test('energy: albedo and F0 in 0..1, dielectric F0 in 0.015..0.18 (diamond 0.172), roughness inside its range', () => {
  for (const row of [...Object.values(METALS), ...Object.values(SURFACES)])
    for (const c of row.color) assert.ok(c >= 0 && c <= 1, String(row.color));
  for (const [name, row] of Object.entries(DIELECTRICS)) {
    const f0 = ((row.ior - 1) / (row.ior + 1)) ** 2;
    assert.ok(f0 > 0.015 && f0 < 0.18, `${name} F0 ${f0}`);
  }
  for (const [name, row] of Object.entries(SURFACES)) {
    assert.ok(row.roughness >= row.roughnessRange[0] && row.roughness <= row.roughnessRange[1], name);
    assert.ok(row.ior >= 1.3 && row.ior <= 1.7, `${name} ior`);
  }
});

test('provenance and citations: every row is measured, derived or art and names a source with a link', () => {
  const counts = { measured: 0, derived: 0, art: 0 };
  for (const row of [...Object.values(METALS), ...Object.values(DIELECTRICS), ...Object.values(SURFACES)]) {
    counts[row.provenance]++;
    assert.ok(SOURCES[row.source], 'source index');
    if (row.provenance !== 'measured') assert.ok(row.note || SOURCES[row.source].includes('physicallybased'), 'non-measured rows say why');
  }
  assert.equal(counts.measured + counts.derived + counts.art, Object.keys(materials).length);
  assert.ok(counts.measured >= 50, JSON.stringify(counts));
  for (const s of SOURCES) assert.match(s, /\(\d{4}\)|https:\/\//, s);
  assert.equal(materialInfo('gold').kind, 'metal');
  assert.match(materialInfo('gold').citation, /Johnson/);
  assert.equal(materialInfo('limestone').provenance, 'measured');
});

test('API: metal, dielectric, surface and materials give PbrMaterial options; named presets use the measured rows', () => {
  assert.deepEqual(metal('gold'), materials.gold);
  assert.deepEqual(metal('gold', { roughness: 0.1 }).roughness, 0.1);
  assert.equal(metal('silver').metalness, 1);
  const glass = dielectric('windowGlass');
  assert.deepEqual([...glass.color], [1, 1, 1, 1]);
  assert.equal(glass.ior, DIELECTRICS.windowGlass.ior);
  assert.equal(surface('snow').metalness, 0);
  assert.ok(Object.isFrozen(materials) && Object.isFrozen(materials.gold));
  assert.throws(() => metal('unobtainium'), RangeError);
  assert.throws(() => surface('brick', { roughness: 1.5 }), RangeError);
  assert.throws(() => materialInfo('nothing'), RangeError);
  // Regression: copper, iron and brick were Hoffman's course figures and an art brick; they are the measured rows now.
  assert.deepEqual(copper, metal('copper'));
  assert.deepEqual(iron, metal('iron'));
  assert.deepEqual(brick, surface('brick'));
});
