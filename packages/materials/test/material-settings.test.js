// The skin and eye slider rows: the shared row shape, defaults that draw as the plain features do, and live eye rows.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MATERIAL_LIVE_SETTINGS,
  MATERIAL_SETTINGS,
  applyEyeSettings,
  eyeFromSettings,
  materialSettingDefaults,
  skinFromSettings,
} from '../dist/settings.js';

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
    ['eye.pupil', 'eye.irisColor', 'eye.wetness'],
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
