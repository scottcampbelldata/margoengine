// Building and harbour slider rows (sheet row 14): rows follow the shared shape, none is live (each rebuilds), the
// defaults are the generators' own, and the option builders map rows onto generator options.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILDING_SETTINGS,
  HARBOUR_SETTINGS,
  buildingOptionsFromSettings,
  buildingSettingDefaults,
  harbourOptionsFromSettings,
  harbourSettingDefaults,
} from '@margoengine/procedural/building-settings';
import { generateBuilding, resolveBuildingOptions } from '@margoengine/procedural/building-rules';
import { generateFishingBoat, generateSeaWall } from '@margoengine/procedural/harbour';

test('rows follow the shared shape and are all rebuild rows', () => {
  for (const r of [...BUILDING_SETTINGS, ...HARBOUR_SETTINGS]) {
    assert.equal(r.live, false, r.name);
    assert.ok(typeof r.about === 'string' && r.about.length > 5);
    if (r.kind === 'number') assert.ok(r.default >= r.min && r.default <= r.max, r.name);
    else assert.ok(r.choices.includes(r.default), r.name);
  }
  // The building row defaults are the default style's options.
  const d = resolveBuildingOptions(),
    v = buildingSettingDefaults();
  for (const k of ['width', 'depth', 'plinth', 'pitch', 'overhang', 'wall', 'reveal', 'bayWidth', 'sill', 'balcony'])
    assert.equal(v[k], d[k], k);
  assert.equal(v.storeys, d.storeys.length);
  assert.equal(v.storeyHeight, d.storeys[0]);
  assert.deepEqual([v.windowWidth, v.windowHeight], d.window);
  assert.equal(v.roof, d.roof);
  assert.equal(harbourSettingDefaults()['seaWall.crest'], generateSeaWall().crest);
  assert.equal(harbourSettingDefaults()['boat.length'], generateFishingBoat().length);
});

test('values map onto generator options; left-out rows keep the style', () => {
  const o = buildingOptionsFromSettings({ style: 'western-1910-house', storeys: 1, chimney: 'off', windowHeight: 1.4 });
  assert.deepEqual(o.storeys, [2.95]);
  assert.equal(o.chimney, false);
  assert.deepEqual(o.window, [0.81, 1.4]);
  const b = generateBuilding(o);
  assert.equal(b.floors.length, 1);
  assert.equal(b.options.roof, 'gable', 'the style roof holds');
  assert.equal(b.chimney, undefined);
  assert.throws(() => buildingOptionsFromSettings({ pitch: 90 }), RangeError);
  assert.throws(() => buildingOptionsFromSettings({ spire: 1 }), TypeError);
  const h = harbourOptionsFromSettings({ 'seaWall.crest': 8, 'seaWall.recurve': 'off', 'boat.lamps': 'on' });
  assert.deepEqual(h.seaWall, { crest: 8, recurve: false });
  assert.equal(generateSeaWall(h.seaWall).crest, 8);
  assert.equal(h.boat.lamps, true);
});
