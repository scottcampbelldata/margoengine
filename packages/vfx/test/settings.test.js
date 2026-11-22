// The particle settings table: every row is a live number or colour the effect reads each frame, defaults leave the
// effect's options exactly as they were, every row at both ends of its range passes the effect's own validation, and
// a panel started from an effect's values (a Fire's flames included) writes them back unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { VFX as BaseVFX } from '../dist/base.js';
import { curves } from '../dist/curves.js';
import { shapes } from '../dist/shapes.js';
import { soft } from '../dist/soft.js';
import { stretch } from '../dist/stretch.js';
import { schedule } from '../dist/schedule.js';
import { snowNight } from '../../sky/dist/scene-kits.js';
import {
  VFX_LIVE_SETTINGS,
  VFX_SETTINGS,
  applyVfxSettings,
  vfxSettingDefaults,
  vfxSettingValues,
} from '../dist/settings.js';

const check = (effect) => effect.validate();
// What an option holds when its rows are at their defaults.
const optionDefault = (key) => {
  const d = vfxSettingDefaults(),
    axes = (name) => ['x', 'y', 'z'].map((c) => d[`${name}.${c}`]);
  return ['velocity', 'gravity', 'emissionExtent'].includes(key)
    ? axes(key)
    : key === 'lifetime'
      ? [d['lifetime.min'], d['lifetime.max']]
      : d[key];
};

test('every row is live; the wind rows follow the weather at null; rate has no weather but may be null', () => {
  assert.equal(VFX_SETTINGS.length, 24);
  assert.deepEqual(VFX_LIVE_SETTINGS, VFX_SETTINGS);
  for (const row of VFX_SETTINGS) {
    assert.ok(row.live && row.about.length > 15 && ['number', 'color'].includes(row.kind), row.name);
    assert.ok(row.kind === 'color' || row.max > row.min, row.name);
    if (row.name.startsWith('wind.'))
      assert.ok(row.nullable && row.default === null && row.weather === 'wind', row.name);
    else if (row.name === 'rate') assert.ok(row.nullable && row.default === null && row.weather === undefined);
    else assert.ok(!row.nullable && row.default !== null, row.name);
  }
});

test("the defaults leave an effect's options exactly as built, and clear what a row set", () => {
  const effect = new VFX({ capacity: 8 });
  applyVfxSettings(effect, {});
  assert.deepEqual(effect.options, { capacity: 8 });
  applyVfxSettings(effect, vfxSettingDefaults());
  assert.deepEqual(effect.options, { capacity: 8 });
  for (const row of VFX_SETTINGS) {
    const e = new VFX({ capacity: 8 }),
      quarter = (row.max - row.min) / 4,
      moved =
        row.kind === 'color'
          ? [0.2, 0.3, 0.4]
          : row.name === 'lifetime.min'
            ? 0.5
            : row.name.startsWith('lifetime')
              ? 6
              : row.name === 'rate'
                ? 40
                : row.default + quarter <= row.max
                  ? row.default + quarter
                  : row.default - quarter;
    applyVfxSettings(e, { [row.name]: moved });
    assert.notDeepEqual(e.options, { capacity: 8 }, `${row.name} writes an option`);
    check(e);
    applyVfxSettings(e, {});
    assert.deepEqual(e.options, { capacity: 8 }, `${row.name} back at its default clears it`);
  }
});

test("the whole range of every row passes the effect's own validation", () => {
  for (const edge of ['min', 'max']) {
    const e = new VFX({ capacity: 8 }),
      values = Object.fromEntries(VFX_SETTINGS.filter((r) => r.kind === 'number').map((r) => [r.name, r[edge]]));
    values['lifetime.min'] = edge === 'min' ? 0.05 : 60;
    values['lifetime.max'] = edge === 'min' ? 0.05 : 120;
    applyVfxSettings(e, { ...values, color: edge === 'min' ? [0, 0, 0] : [1, 1, 1] });
    check(e);
  }
});

test('unknown names throw TypeError, bad values RangeError, null only where nullable, a life that ends before it starts', () => {
  const e = new VFX({ capacity: 8 });
  assert.throws(() => applyVfxSettings(e, { speed: 3 }), TypeError);
  for (const bad of [
    { size: 0 },
    { size: 21 },
    { bounce: 1.5 },
    { turbulence: -1 },
    { 'velocity.y': null },
    { color: [2, 0, 0] },
    { color: [1, 0] },
    { intensity: 1001 },
    { 'wind.x': 101 },
    { rate: -1 },
    { alpha: NaN },
  ])
    assert.throws(() => applyVfxSettings(e, bad), RangeError, JSON.stringify(bad));
  assert.throws(() => applyVfxSettings(e, { 'lifetime.min': 5, 'lifetime.max': 2 }), RangeError);
  assert.deepEqual(e.options, { capacity: 8 }, 'a refused write changes nothing');
});

test('wind: both null leaves the option to the weather, either one given sets it, [x, z] in m/s', () => {
  const e = new VFX({ capacity: 8 });
  applyVfxSettings(e, { 'wind.x': 4 });
  assert.deepEqual(e.options.wind, [4, 0]);
  applyVfxSettings(e, { 'wind.x': 4, 'wind.z': -2 });
  assert.deepEqual(e.options.wind, [4, -2]);
  check(e);
  applyVfxSettings(e, { 'wind.x': null, 'wind.z': null });
  assert.equal('wind' in e.options, false);
});

test("a panel started from an effect's values writes them back unchanged, a Fire's flames, embers and steam included", () => {
  const plain = new VFX({
    capacity: 8,
    velocity: [0, 5, 0],
    size: 0.3,
    wind: [2, 1],
    lifetime: [0.5, 2],
    color: [0.1, 0.2, 0.3, 0.4],
    rate: 12,
    emissionExtent: [1, 2, 3],
  });
  const before = structuredClone(plain.options);
  const values = vfxSettingValues(plain);
  assert.equal(values['velocity.y'], 5);
  assert.deepEqual(values.color, [0.1, 0.2, 0.3]);
  assert.equal(values.alpha, 0.4);
  applyVfxSettings(plain, values);
  assert.deepEqual(plain.options, before);
  const { fire, embers, steam } = snowNight().hearth;
  for (const data of [fire, embers, steam]) {
    const effect = new BaseVFX(
        { ...structuredClone(data), position: [0, 0.2, 0] },
        { curves, emitter: shapes, soft, stretch, schedule },
      ),
      start = structuredClone(effect.options),
      read = vfxSettingValues(effect);
    applyVfxSettings(effect, { ...read, 'velocity.y': read['velocity.y'] + 0.5 });
    check(effect);
    assert.equal(effect.options.velocity[1], start.velocity[1] + 0.5);
    assert.deepEqual(effect.options.curves, start.curves, 'the structured options are not touched');
    applyVfxSettings(effect, read);
    // Back as it was, except that an option written at its default value is left unset (it does the same).
    for (const key of Object.keys(start))
      if (!(key in effect.options))
        assert.deepEqual(start[key], optionDefault(key), `${key} was dropped but is not at its default`);
      else assert.deepEqual(effect.options[key], start[key], key);
    assert.deepEqual(vfxSettingValues(effect), read);
  }
});

test('a wind row given a value is held from the weather drive; null hands it back (applyVfxSettings, applySmokeSettings, applySandSettings)', async () => {
  const { heldFromWeather } = await import('../../shared/settings.js');
  const { applyVfxSettings, applySmokeSettings, applySandSettings } = await import('../dist/settings.js');
  for (const apply of [applyVfxSettings, applySmokeSettings]) {
    const target = { options: {} };
    apply(target, { 'wind.x': 3 });
    assert.equal(heldFromWeather(target.options, 'wind'), true, `${apply.name} holds a given wind`);
    apply(target, {});
    assert.equal(heldFromWeather(target.options, 'wind'), false, `${apply.name} releases it at null`);
  }
  const sand = { options: {} };
  applySandSettings(sand, { 'wind.speed': 9, fog: 0.01 });
  assert.equal(heldFromWeather(sand.options, 'wind'), true);
  assert.equal(heldFromWeather(sand.options, 'fog'), true);
  applySandSettings(sand, {});
  assert.equal(heldFromWeather(sand.options, 'wind'), false);
  assert.equal(heldFromWeather(sand.options, 'fog'), false);
});
