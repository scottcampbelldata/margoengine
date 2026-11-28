// The skin and eye slider rows: the shared row shape, defaults that draw as the plain features do, and live eye rows.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MATERIAL_LIVE_SETTINGS,
  MATERIAL_SETTINGS,
  applyEyeSettings,
  applyInteriorSettings,
  interiorOptionsFromSettings,
  eyeFromSettings,
  materialSettingDefaults,
  skinFromSettings,
} from '../dist/settings.js';
import { interiorMapping } from '../dist/interior-mapping.js';

test('skin and eye slider rows share the row shape and build their features', () => {
  const names = MATERIAL_SETTINGS.map((r) => r.name);
  for (const name of ['skin.melanin', 'skin.hemoglobin', 'skin.thickness', 'eye.pupil', 'eye.irisColor', 'eye.wetness'])
    assert.ok(names.includes(name), name);
  for (const row of MATERIAL_SETTINGS) {
    assert.ok(['number', 'color'].includes(row.kind) && typeof row.about === 'string' && typeof row.live === 'boolean');
    if (row.kind === 'number' && row.default !== null)
      assert.ok(row.default >= row.min && row.default <= row.max, row.name);
  }
  assert.deepEqual(
    MATERIAL_LIVE_SETTINGS.map((r) => r.name),
    [
      'eye.pupil',
      'eye.irisColor',
      'eye.wetness',
      'interior.daylight',
      'interior.lit',
      'interior.lamp',
      'interior.lampColor',
      'interior.variation',
      'interior.furniture',
      'interior.curtains',
      'interior.blinds',
    ],
  );
  const defaults = materialSettingDefaults();
  assert.equal(defaults['skin.melanin'], null);
  // Defaults draw as the plain features do.
  assert.deepEqual(skinFromSettings().serialization(), { unitsPerMeter: 1, thickness: 0.004 });
  assert.deepEqual(skinFromSettings({ 'skin.melanin': 0.3 }).serialization(), {
    unitsPerMeter: 1,
    thickness: 0.004,
    melanin: 0.3,
  });
  const live = eyeFromSettings({ 'eye.pupil': 0.4 });
  assert.equal(live.pupil, 0.4);
  applyEyeSettings(live, { 'eye.wetness': 0.5, 'eye.irisColor': [0.2, 0.1, 0.05] });
  assert.equal(live.wetness, 0.5);
  assert.deepEqual(live.irisColor, [0.2, 0.1, 0.05]);
  assert.equal(live.pupil, 0.3, 'a row left out takes its default');
  assert.throws(() => applyEyeSettings(live, { 'eye.depth': 0.2 }), RangeError);
  assert.throws(() => skinFromSettings({ 'skin.melanin': 0.9 }), RangeError);
  assert.throws(() => skinFromSettings({ 'skin.nose': 1 }), TypeError);
});

test('interior rows build the material and write it live, their defaults its own', () => {
  const made = interiorMapping(interiorOptionsFromSettings({ 'interior.lit': 0.6 }, { depth: 2 }));
  assert.ok(Math.abs(made.uniforms.lit - 0.6) < 1e-6);
  assert.equal(made.uniforms.depth, 2);
  const plain = interiorMapping();
  for (const row of MATERIAL_SETTINGS.filter((r) => r.group === 'interior')) {
    const key = row.name.slice('interior.'.length),
      built = [plain.uniforms[key]].flat().flatMap((v) => (typeof v === 'number' ? [v] : [...v]));
    [row.default].flat().forEach((v, k) => assert.ok(Math.abs(built[k] - v) < 1e-6, row.name));
  }
  applyInteriorSettings(made, { 'interior.daylight': 0.9, 'interior.lampColor': [0.5, 0.5, 1] });
  assert.ok(Math.abs(made.uniforms.daylight - 0.9) < 1e-6);
  assert.deepEqual([...made.uniforms.lampColor], [0.5, 0.5, 1]);
  assert.ok(Math.abs(made.uniforms.lit - 0.15) < 1e-6, 'a row left out takes its default');
  assert.throws(() => applyInteriorSettings(made, { 'interior.lit': 2 }), RangeError);
});
