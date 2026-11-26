import assert from 'node:assert/strict';
import test from 'node:test';
import { PbrMaterial } from '@margoengine/core';
import {
  AGEING_EXPOSURE_WORDS,
  AGEING_YEAR,
  atmosphericMetalLoss,
  MaterialAgeingSolver,
  weatheringFilm,
  writeAgeingExposure,
} from '@margoengine/physics/ageing';
import { PhysicsWorld } from '../dist/world.js';

function near(a, b, tolerance) {
  assert.ok(Math.abs(a - b) <= tolerance, `expected ${b} ± ${tolerance}, got ${a}`);
}

test('ISO 9223 steel and copper first-year fits use deposition, RH percentage, and the two temperature branches', () => {
  const exposure = { temperature: 278.15, relativeHumidity: 0.8, sulphurDioxide: 5, chloride: 20 };
  const steel =
    1e-6 * (1.77 * 5 ** 0.52 * Math.exp(0.02 * 80 - 0.15 * 5) + 0.102 * 20 ** 0.62 * Math.exp(0.033 * 80 + 0.04 * 5));
  near(atmosphericMetalLoss('steel', exposure), steel, 5e-20);
  const copper =
    1e-6 *
    (0.0053 * 5 ** 0.26 * Math.exp(0.059 * 80 - 0.08 * 5) + 0.01025 * 20 ** 0.27 * Math.exp(0.036 * 80 + 0.049 * 15));
  near(atmosphericMetalLoss('copper', { ...exposure, temperature: 288.15 }), copper, 5e-20);
  assert.equal(atmosphericMetalLoss('steel', { sulphurDioxide: 0, chloride: 0 }), 0);
  assert.throws(() => atmosphericMetalLoss('wood'), /steel or copper/);
});

test('Kubelka–Munk finite layers approach the measured semi-infinite reflectance and conserve flux', () => {
  const clear = weatheringFilm(100, 200, 0);
  near(clear.reflectance, 0, 0);
  near(clear.transmittance, 1, 0);
  const pureScatter = weatheringFilm(0, 100, 0.04);
  near(pureScatter.reflectance, 0.8, 0);
  near(pureScatter.transmittance, 0.2, 0);
  const pureAbsorb = weatheringFilm(100, 0, 0.04);
  near(pureAbsorb.reflectance, 0, 0);
  near(pureAbsorb.transmittance, Math.exp(-4), 1e-16);
  const a = 1.5;
  const b = Math.sqrt(a * a - 1);
  const semiInfinite = 1 / (a + b);
  const deep = weatheringFilm(100, 200, 1);
  near(deep.reflectance, semiInfinite, 2e-16);
  assert.ok(deep.transmittance < 1e-96);
  for (const thickness of [1e-12, 1e-7, 1e-4, 0.01]) {
    const layer = weatheringFilm(100, 200, thickness);
    const x = b * 200 * thickness;
    const denom = a * Math.sinh(x) + b * Math.cosh(x);
    near(layer.reflectance, Math.sinh(x) / denom, 4e-16);
    near(layer.transmittance, b / denom, 4e-16);
    assert.ok(layer.reflectance + layer.transmittance <= 1);
  }
});

test('Ageing fields validate layout and expose real metal and coating values to PBR materials', () => {
  const solver = new MaterialAgeingSolver();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  world.add(solver, { timeScale: AGEING_YEAR, patches: [{ material: 'copper' }] });
  const material = new PbrMaterial(solver.appearance(0));
  const initial = Array.from(material.data);
  world.advance(600);
  const after = solver.appearance(0);
  material.set(after);
  assert.notDeepEqual(Array.from(material.data), initial);
  assert.equal(material.data[5], Math.fround(after.metalness));
  assert.ok(after.roughness > initial[4] && after.metalness < initial[5]);
  assert.throws(() => solver.read(-1), /patch from index/);
  const row = new Float64Array(AGEING_EXPOSURE_WORDS);
  writeAgeingExposure(row, { submerged: 0.6 });
  assert.equal(row[4], 0.6);
  assert.throws(() => writeAgeingExposure(row, { rainPh: -1 }), /rain pH/);
  assert.throws(() => writeAgeingExposure(row, {}, 5), /row that fits/);
});
