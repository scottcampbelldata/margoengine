import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROADLEAF_SETTINGS,
  broadleafOptionsFromSettings,
  broadleafSettingDefaults,
} from '../dist/broadleaf-settings.js';
import { broadleafLevels } from '../dist/broadleaves.js';

test('broadleaf slider rows: shared shape, defaults the generator, every row reaches its option', () => {
  for (const row of BROADLEAF_SETTINGS) {
    assert.equal(typeof row.name, 'string');
    assert.equal(row.live, false, `${row.name} rebuilds`);
  }
  const d = broadleafSettingDefaults();
  assert.equal(d.species, 'english-oak');
  assert.equal(d.age, 120);
  assert.equal(d.open, 0.8);
  const { species, options } = broadleafOptionsFromSettings({
    species: 'european-beech',
    age: 40,
    open: 0.3,
    condition: 'bare',
    imposterSize: '128',
    seed: 3,
  });
  assert.equal(species, 'european-beech');
  assert.deepEqual(options, { age: 40, open: 0.3, condition: 'bare', seed: 3, imposterSize: 128 });
  const l = broadleafLevels('black-alder', broadleafOptionsFromSettings({ imposterSize: '128', age: 30 }).options);
  assert.equal(l.textures.baseColor.width, 128);
  assert.deepEqual(broadleafOptionsFromSettings({}), { species: 'english-oak', options: {} });
  assert.throws(() => broadleafOptionsFromSettings({ height: 3 }), TypeError);
  assert.throws(() => broadleafOptionsFromSettings({ age: 0 }), RangeError);
  assert.throws(() => broadleafOptionsFromSettings({ species: 'maple' }), RangeError);
});
