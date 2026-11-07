import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_PRESETS } from '../dist/presets.js';
import { PresetScene, SCENE_PRESETS, scenePresetNames } from '../dist/scenes.js';

test('the scene presets pair each day preset with fog, bloom and a grade, frozen', () => {
  assert.deepEqual(scenePresetNames, ['noon', 'goldenHour', 'overcast', 'dawn']);
  assert.deepEqual(Object.keys(SCENE_PRESETS), scenePresetNames);
  for (const name of scenePresetNames) {
    const p = SCENE_PRESETS[name];
    assert.equal(p.day, DAY_PRESETS[name], `${name} uses its day preset`);
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.bloom) && Object.isFrozen(p.tonemap), name);
  }
  // Fog from visibility (Koschmieder: 2% contrast at 3.912 / density): 20 km, 10 km, 2 km and 600 m.
  const visibility = (name) => 3.912 / SCENE_PRESETS[name].fog;
  assert.deepEqual(
    scenePresetNames.map((n) => Math.round(visibility(n))),
    [20000, 10000, 2000, 600],
  );
  // The grade lifts the dimmer scenes back toward noon: more exposure where the presets light the ground less.
  const e = (n) => SCENE_PRESETS[n].tonemap.exposure;
  assert.ok(e('noon') === 0 && e('goldenHour') > 0 && e('overcast') > e('goldenHour') && e('dawn') > e('goldenHour'));
});

test('invalid presets throw before anything is attached', () => {
  const engine = {
    use() {
      throw new Error('nothing may be attached');
    },
  };
  assert.throws(() => PresetScene.attach(engine, 'night'), /Unknown scene preset "night"; use one of noon/);
  assert.throws(() => PresetScene.attach(engine, 'constructor'), /Unknown scene preset/);
  assert.throws(() => PresetScene.attach(engine, { ...SCENE_PRESETS.noon, fog: 2 }), /Invalid scene preset/);
  assert.throws(
    () => PresetScene.attach(engine, { ...SCENE_PRESETS.noon, tonemap: { ...SCENE_PRESETS.noon.tonemap, temperature: 100 } }),
    /Invalid scene preset/,
  );
});
