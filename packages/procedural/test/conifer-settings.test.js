import test from 'node:test';
import assert from 'node:assert/strict';
import { CONIFER_SETTINGS, coniferOptionsFromSettings, coniferSettingDefaults } from '../dist/conifer-settings.js';
import { coniferLevels } from '../dist/conifers.js';

test('conifer slider rows: shared shape, defaults the generator, every row reaches its option', () => {
  for (const row of CONIFER_SETTINGS) {
    assert.equal(typeof row.name, 'string');
    assert.equal(row.live, false, `${row.name} rebuilds`);
  }
  const d = coniferSettingDefaults();
  assert.equal(d.species, 'douglas-fir');
  assert.equal(d.age, 100);
  const { species, options } = coniferOptionsFromSettings({ species: 'western-larch', age: 40, condition: 'burnt', imposterSize: '128', seed: 3, basalArea: 20 });
  assert.equal(species, 'western-larch');
  assert.deepEqual(options, { age: 40, basalArea: 20, condition: 'burnt', seed: 3, imposterSize: 128 });
  const l = coniferLevels('grand-fir', coniferOptionsFromSettings({ imposterSize: '64' }).options);
  assert.equal(l.textures.baseColor.width, 64);
  assert.deepEqual(coniferOptionsFromSettings({}), { species: 'douglas-fir', options: {} });
  assert.throws(() => coniferOptionsFromSettings({ height: 3 }), TypeError);
  assert.throws(() => coniferOptionsFromSettings({ age: 0 }), RangeError);
  assert.throws(() => coniferOptionsFromSettings({ species: 'spruce' }), RangeError);
});
