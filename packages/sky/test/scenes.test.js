import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_PRESETS } from '../dist/day-presets.js';
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
    () =>
      PresetScene.attach(engine, {
        ...SCENE_PRESETS.noon,
        tonemap: { ...SCENE_PRESETS.noon.tonemap, temperature: 100 },
      }),
    /Invalid scene preset/,
  );
});

test('KB-SCENES-NIGHTSUN1: sunScene keeps the sun where it is and gives a night below the horizon', async () => {
  const { sunScene } = await import('../dist/scenes.js');
  const high = sunScene(200, 55),
    low = sunScene(260, 8),
    night = sunScene(330, -25);
  assert.deepEqual([high.day.azimuth, high.day.elevation], [200, 55]);
  assert.deepEqual(high.tonemap, SCENE_PRESETS.noon.tonemap, 'a high sun has the noon grade');
  assert.deepEqual([low.day.azimuth, low.day.elevation], [260, 8]);
  assert.deepEqual(low.tonemap, SCENE_PRESETS.goldenHour.tonemap, 'a low sun has the golden-hour grade');
  assert.deepEqual(
    [night.day.azimuth, night.day.elevation],
    [330, -25],
    'the night sun is not lifted above the horizon',
  );
  assert.ok(night.tonemap.temperature < SCENE_PRESETS.noon.tonemap.temperature, 'the night grade is cooler');
  assert.ok(night.tonemap.exposure > 0, 'the night grade opens up to read the moonlit ground');
  assert.ok(Object.isFrozen(night) && Object.isFrozen(night.day));
  assert.throws(() => sunScene(0, 91), RangeError);
  assert.throws(() => sunScene(Number.NaN, 0), RangeError);
});
