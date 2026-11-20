// The settings table of @margoengine/tonemap/settings: rows are well formed, the defaults written leave Tonemap, Grade,
// HueGrade and LocalExposure valid and meaning what they mean with no options, ranges are enforced, the named looks are
// only row values the effects accept, and autoExposure rows build and remove the option object. The real-GPU check (frame
// exact, counted objects, native and the WebGL2 layer) is tests/settings-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Tonemap } from '../dist/index.js';
import { Grade } from '../dist/grade.js';
import { HueGrade } from '../dist/hue.js';
import { LocalExposure } from '../dist/local.js';
import {
  TONEMAP_LIVE_SETTINGS,
  TONEMAP_LOOKS,
  TONEMAP_SETTINGS,
  applyTonemapSettings,
  tonemapSettingDefaults,
} from '../dist/settings.js';

const rig = () => ({
  tonemap: new Tonemap(),
  grade: new Grade(),
  hueGrade: new HueGrade(),
  local: new LocalExposure(),
});
// A new effect built over the options an effect holds runs the effect's own range check (each frame checks the same).
const revalidate = (t) => {
  new Tonemap({ ...t.tonemap.options });
  new Grade({ ...t.grade.options });
  new HueGrade({ ...t.hueGrade.options });
  new LocalExposure({ ...t.local.options });
};

test('every row is well formed: a unique name in its group, a default in range, live a boolean', () => {
  const names = new Set();
  for (const row of TONEMAP_SETTINGS) {
    assert.ok(!names.has(row.name), `${row.name} is listed once`);
    names.add(row.name);
    assert.equal(row.name.slice(0, row.name.indexOf('.')), row.group, `${row.name} sits in its group`);
    assert.equal(typeof row.live, 'boolean', `${row.name} has live`);
    assert.ok(row.about.length > 20, `${row.name} says what it does`);
    if (row.kind === 'number') {
      assert.ok(row.default >= row.min && row.default <= row.max, `${row.name} default in range`);
      assert.ok(row.min < row.max && row.step > 0, `${row.name} has a range and a step`);
    } else if (row.kind === 'color') assert.ok(row.default.every((x) => x >= row.min && x <= row.max), `${row.name} default in range`);
    else assert.ok(row.choices.includes(row.default), `${row.name} default is a choice`);
  }
  // Every option of Tonemap (but source, inputColorSpace and extensions), Grade (but curves), HueGrade (but hueHue) and LocalExposure.
  for (const name of [
    'tonemap.curve', 'tonemap.exposure', 'tonemap.contrast', 'tonemap.whitePoint', 'tonemap.toe', 'tonemap.shoulder', 'tonemap.temperature', 'tonemap.tint', 'tonemap.grain',
    'tonemap.dither', 'tonemap.chromaticAberration', 'vignette.amount', 'vignette.radius', 'vignette.softness',
    'vignette.color', 'vignette.centerX', 'vignette.roundness', 'vignette.blend', 'autoExposure.enabled',
    'autoExposure.min', 'autoExposure.max', 'autoExposure.speed', 'autoExposure.compensation', 'autoExposure.method',
    'autoExposure.percentileLow', 'autoExposure.metering', 'autoExposure.spotRadius', 'grade.shadows', 'grade.midtones',
    'grade.highlights', 'grade.saturationRed', 'grade.saturationMagenta', 'grade.lift', 'grade.gamma', 'grade.gain',
    'grade.saturation', 'hue.shift', 'local.strength', 'local.maxStops', 'local.radius', 'local.edges',
  ])
    assert.ok(TONEMAP_SETTINGS.some((row) => row.name === name), `${name} is a row`);
  assert.deepEqual(
    TONEMAP_SETTINGS.filter((row) => !row.live).map((row) => row.name),
    [
      'tonemap.curve', 'tonemap.whitePoint', 'tonemap.toe', 'tonemap.shoulder', 'tonemap.temperature', 'tonemap.tint', 'tonemap.grain', 'tonemap.dither',
      'tonemap.chromaticAberration', 'vignette.amount', 'autoExposure.enabled', 'grade.lift', 'grade.gamma', 'grade.gain',
      'grade.saturation', 'local.radius',
    ],
  );
  assert.equal(TONEMAP_LIVE_SETTINGS.length, TONEMAP_SETTINGS.length - 16);
});

test('the defaults written leave every effect valid and meaning what it means with no options', () => {
  const t = rig();
  applyTonemapSettings(t, tonemapSettingDefaults());
  revalidate(t);
  const o = t.tonemap.options;
  assert.equal(o.curve, 'neutral');
  assert.equal(o.temperature, 6500);
  assert.equal('autoExposure' in o, false, 'off removes the option');
  assert.deepEqual(o.vignetteCenter, [0.5, 0.5]);
  assert.equal(t.grade.key, 'grade', 'the primaries at their defaults keep the plain grade program');
  assert.equal(t.hueGrade.key, 'grade-hue');
  assert.deepEqual(t.grade.options.hueSaturation, [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(t.local.options, { strength: 0.5, maxStops: 3, radius: 0.02, edges: 1.3 });
  assert.equal(applyTonemapSettings({}, {}), undefined, 'defaults need no target');
});

test('rows write the option they name; autoExposure builds, keeps its mask and is removed by off', () => {
  const t = rig();
  applyTonemapSettings(t, {
    'tonemap.curve': 'agx',
    'tonemap.exposure': 1.5,
    'vignette.amount': 0.4,
    'vignette.centerX': 0.3,
    'vignette.centerY': 0.6,
    'grade.lift': [0.1, 0, 0],
    'grade.saturationBlue': 0.5,
    'hue.shift': 30,
    'local.strength': 0.8,
    'autoExposure.enabled': 'on',
    'autoExposure.metering': 'spot',
    'autoExposure.spotX': 0.2,
    'autoExposure.percentileLow': 0.2,
  });
  const o = t.tonemap.options;
  assert.equal(o.curve, 'agx');
  assert.equal(o.vignette, 0.4);
  assert.deepEqual(o.vignetteCenter, [0.3, 0.6]);
  assert.deepEqual(o.autoExposure.percentiles, [0.2, 0.9]);
  assert.deepEqual(o.autoExposure.spot, { x: 0.2, y: 0.5, radius: 0.05 });
  assert.equal(t.grade.key, 'grade:tone', 'a lift off its default makes the primaries program');
  assert.equal(t.hueGrade.options.hueShift, 30);
  assert.deepEqual(t.hueGrade.options.hueSaturation, [1, 1, 1, 1, 0.5, 1], 'grade rows write the HueGrade too');
  assert.equal(t.local.options.strength, 0.8);
  revalidate(t);
  const mask = { createView() {} },
    object = o.autoExposure;
  object.mask = mask;
  applyTonemapSettings(t, { 'autoExposure.enabled': 'on', 'autoExposure.speed': 3 });
  assert.equal(o.autoExposure, object, 'the object is updated in place');
  assert.equal(o.autoExposure.mask, mask);
  assert.equal(o.autoExposure.speed, 3);
  applyTonemapSettings(t, {});
  assert.equal('autoExposure' in o, false);
  assert.equal(t.grade.key, 'grade');
});

test('a value outside its row throws RangeError, an unknown name TypeError, a missing target TypeError', () => {
  const t = rig();
  for (const row of TONEMAP_SETTINGS.filter((r) => r.kind === 'number')) {
    assert.throws(() => applyTonemapSettings(t, { [row.name]: row.max + row.step }), RangeError, `${row.name} above its max`);
    assert.throws(() => applyTonemapSettings(t, { [row.name]: row.min - row.step }), RangeError, `${row.name} below its min`);
    assert.throws(() => applyTonemapSettings(t, { [row.name]: NaN }), RangeError, `${row.name} NaN`);
  }
  for (const row of TONEMAP_SETTINGS.filter((r) => r.kind === 'choice'))
    assert.throws(() => applyTonemapSettings(t, { [row.name]: 'sideways' }), RangeError, `${row.name} choice`);
  assert.throws(() => applyTonemapSettings(t, { 'grade.gain': [5, 1, 1] }), RangeError);
  assert.throws(() => applyTonemapSettings(t, { 'tonemap.nope': 1 }), TypeError);
  assert.throws(() => applyTonemapSettings(t, { 'autoExposure.min': 2, 'autoExposure.max': 1 }), RangeError, 'min above max');
  assert.throws(() => applyTonemapSettings(t, { 'autoExposure.percentileLow': 0.9 }), RangeError, 'low at or above high');
  assert.throws(() => applyTonemapSettings({}, { 'tonemap.exposure': 1 }), /needs targets.tonemap/);
  assert.throws(() => applyTonemapSettings({ tonemap: t.tonemap }, { 'grade.lift': [0.1, 0, 0] }), /needs targets.grade/);
  assert.throws(() => applyTonemapSettings({ grade: t.grade }, { 'hue.shift': 5 }), /needs targets.hueGrade/);
  assert.throws(() => applyTonemapSettings({ tonemap: t.tonemap }, { 'local.edges': 2 }), /needs targets.local/);
  assert.doesNotThrow(() => applyTonemapSettings({ tonemap: t.tonemap }, { 'local.edges': 1.3 }), 'a default needs no target');
});

test('a refused call writes nothing', () => {
  const t = rig(),
    before = JSON.stringify(t.tonemap.options);
  assert.throws(() => applyTonemapSettings(t, { 'tonemap.exposure': 2, 'local.edges': 99 }), RangeError);
  assert.equal(JSON.stringify(t.tonemap.options), before);
});

test('named looks are only row values, in range, and the effects accept them', () => {
  const index = new Map(TONEMAP_SETTINGS.map((row) => [row.name, row]));
  assert.deepEqual(Object.keys(TONEMAP_LOOKS), ['natural', 'filmic', 'bleach', 'ember', 'animatedFeature']);
  assert.deepEqual(TONEMAP_LOOKS.natural, {});
  for (const [name, look] of Object.entries(TONEMAP_LOOKS)) {
    for (const key of Object.keys(look)) assert.ok(index.has(key), `${name} names the row ${key}`);
    const t = rig();
    applyTonemapSettings(t, look);
    revalidate(t);
  }
});
