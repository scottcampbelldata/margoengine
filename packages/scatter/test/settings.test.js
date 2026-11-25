// The settings table of @margoengine/scatter/settings: rows are well formed and all live, the defaults written leave a
// Scatter as built, ranges are enforced, the wind is removed at strength 0 and rootShade needs blades. The real-GPU check
// (no objects made over 60 frames, native and the WebGL2 layer) is test/settings.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { Scatter, WIND_THRASH_FROM, windClockRate } from '../dist/index.js';
import { ScatterTiles } from '../dist/tiles.js';
import {
  SCATTER_LIVE_SETTINGS,
  SCATTER_LOOKS,
  SCATTER_SETTINGS,
  applyScatterSettings,
  scatterSettingDefaults,
} from '../dist/settings.js';

test('every row is well formed, live, and its default is what a Scatter uses without the option', () => {
  const names = new Set();
  for (const row of SCATTER_SETTINGS) {
    assert.ok(!names.has(row.name));
    names.add(row.name);
    assert.equal(row.name.slice(0, row.name.indexOf('.')), row.group);
    assert.equal(
      row.live,
      !['blades.translucency', 'variation.hue', 'variation.value', 'variation.clusters'].includes(row.name),
    );
    assert.ok(row.about.length > 20);
  }
  assert.equal(
    SCATTER_LIVE_SETTINGS.length,
    SCATTER_SETTINGS.length - 4,
    'translucency, variation and clusters may build a pipeline',
  );
  const plain = new Scatter(box());
  assert.equal(plain.density, 1);
  assert.deepEqual([...plain.color], [0.12, 0.35, 0.08]);
  assert.equal(plain.wind, undefined);
  const defaults = scatterSettingDefaults();
  assert.equal(defaults['scatter.density'], plain.density);
  assert.deepEqual(defaults['scatter.color'], [...plain.color]);
  assert.equal(new Scatter(box(), { blades: {} }).rootShade, 0.5);
  assert.equal(defaults['blades.rootShade'], 0.5);
  const lit = new Scatter(box(), { blades: {}, material: new PbrMaterial() });
  assert.equal(lit.widen, 1);
  assert.equal(lit.translucencyAmount, 0);
  assert.equal(lit.variationHue, 0);
  assert.equal(lit.variationValue, 0);
  assert.equal(lit.clusters, 0);
  assert.equal(defaults['blades.widen'], 1);
  for (const name of ['blades.translucency', 'variation.hue', 'variation.value', 'variation.clusters'])
    assert.equal(defaults[name], 0);
});

test('applying writes the values the next frame reads, and the defaults leave the uniform as built', () => {
  const built = new Scatter(box(), { blades: {}, wind: [1, 0, 0.5] });
  const plain = new Scatter(box(), { blades: {} });
  const before = Array.from(plain.values);
  applyScatterSettings(plain, scatterSettingDefaults());
  assert.deepEqual(Array.from(plain.values), before);
  assert.equal(plain.wind, undefined);
  applyScatterSettings(plain, { ...SCATTER_LOOKS.dryWindy, 'wind.directionX': 0, 'wind.directionZ': 1 });
  assert.deepEqual(plain.wind, [0, 1, 0.9]);
  assert.equal(Math.fround(plain.values[27]), 1);
  assert.deepEqual(Array.from(plain.values.slice(40, 43)), [0.35, 0.3, 0.1].map(Math.fround));
  assert.equal(plain.values[76], Math.fround(0.35));
  applyScatterSettings(plain, { 'scatter.density': 0.25 });
  assert.equal(plain.values[27], 0.25);
  assert.equal(plain.wind, undefined, 'strength 0 removes the wind');
  assert.deepEqual(built.wind, [1, 0, 0.5]);
});

test('bad values and targets are refused with the row named', () => {
  const s = new Scatter(box());
  assert.throws(() => applyScatterSettings(s, { 'scatter.density': 2 }), {
    name: 'RangeError',
    message: /scatter.density/,
  });
  assert.throws(() => applyScatterSettings(s, { nope: 1 }), TypeError);
  assert.throws(
    () => applyScatterSettings(s, { 'wind.strength': 0.5, 'wind.directionX': 0, 'wind.directionZ': 0 }),
    RangeError,
  );
  assert.throws(() => applyScatterSettings(s, { 'blades.rootShade': 0.2 }), { name: 'TypeError', message: /blades/ });
  assert.throws(() => (s.rootShade = 0.2), { code: 'state' });
  assert.throws(() => (s.color = [1, 2, 0]), RangeError);
  assert.throws(() => (s.wind = [0, 0, 1]), RangeError);
});

test('widen, translucency, variation and clusters write the values the next frame reads', () => {
  const material = new PbrMaterial();
  const field = new Scatter(box(), { blades: { widen: 1 }, material, lod: [30, 60, 120] });
  const built = new Scatter(box(), {
    blades: { widen: 3, translucency: 0.4 },
    material,
    lod: [30, 60, 120],
    variation: { hue: 0.1, value: 0.2 },
    clusters: 0.5,
  });
  applyScatterSettings(field, {
    'blades.widen': 3,
    'blades.translucency': 0.4,
    'variation.hue': 0.1,
    'variation.value': 0.2,
    'variation.clusters': 0.5,
  });
  assert.equal(field.values[77], built.values[77], 'widen reaches the frame uniform as the constructor writes it');
  assert.equal(field.values[35], built.values[35], 'the cull reach follows the widest blades');
  assert.equal(field.values[75], 0.5);
  assert.equal(field.translucencyAmount, 0.4);
  assert.equal([field.variationHue, field.variationValue].join(), '0.1,0.2');
  applyScatterSettings(field, {});
  assert.equal(
    field.values[35],
    new Scatter(box(), { blades: {}, material, lod: [30, 60, 120] }).values[35],
    'the defaults restore the reach',
  );
  assert.equal(field.clusters, 0);
});

test('a widen moved on a tile mesh that shares its culling updates the shared reach', () => {
  const leader = new ScatterTiles(box(0.1, 1, 0.1), { bounds: [0, 0, 64, 64], blades: {} });
  const follower = new ScatterTiles(box(0.1, 1, 0.1), { bounds: [0, 0, 64, 64], blades: {}, share: leader });
  const reach = leader.values[35];
  follower.widen = 6;
  assert.ok(leader.values[35] > reach, 'a wider follower widens the shared reach');
  follower.widen = 1;
  assert.equal(leader.values[35], reach, 'and narrowing it brings the reach back');
});

test('these rows need what they shade through, and bad values are refused', () => {
  const bare = new Scatter(box());
  for (const name of ['blades.widen', 'blades.translucency', 'variation.hue', 'variation.value', 'variation.clusters'])
    assert.throws(() => applyScatterSettings(bare, { [name]: name === 'blades.widen' ? 2 : 0.2 }), {
      name: 'TypeError',
      message: new RegExp(name),
    });
  assert.throws(() => (bare.widen = 2), { code: 'state' });
  assert.throws(() => (bare.translucencyAmount = 0.2), { code: 'state' });
  assert.throws(() => (bare.variationHue = 0.2), { code: 'state' });
  assert.throws(() => (bare.clusters = 2), { code: 'state' });
  const lit = new Scatter(box(), { blades: {}, material: new PbrMaterial() });
  assert.throws(() => applyScatterSettings(lit, { 'blades.widen': 11 }), RangeError);
  assert.throws(() => (lit.widen = -1), RangeError);
  assert.throws(() => (lit.variationHue = 0.6), RangeError);
  assert.throws(() => (lit.clusters = 1e6), RangeError);
});

test('Beaufort thrash: a wind speed runs the sway clock speed / 5.4 times as fast past force 3, and none keeps it as built', () => {
  assert.equal(WIND_THRASH_FROM, 5.4, 'the top of Beaufort 3, gentle breeze (WMO)');
  assert.equal(windClockRate(0), 1);
  assert.equal(windClockRate(5.4), 1);
  assert.ok(Math.abs(windClockRate(17.2) - 17.2 / 5.4) < 1e-12, 'a force 8 gale: 3.2 times');
  assert.throws(() => windClockRate(-1), RangeError);
  const plain = new Scatter(box(), { wind: [1, 0, 0.5] }),
    breeze = new Scatter(box(), { wind: [1, 0, 0.5, 4] }),
    gale = new Scatter(box(), { wind: [1, 0, 1, 17.2] });
  for (const s of [plain, breeze, gale]) for (let i = 0; i < 60; i++) s.advanceTime(1 / 60);
  assert.equal(plain.windTime, plain.time, 'no speed: the wind clock is the clock, bit for bit');
  assert.equal(breeze.windTime, breeze.time, 'below force 4 the plants keep their own sway');
  assert.ok(Math.abs(gale.windTime - 17.2 / 5.4) < 1e-9 && Math.abs(gale.time - 1) < 1e-9, `gale ${gale.windTime}`);
  // A storm that drops back to a breeze slows the clock again without a jump.
  gale.wind = [1, 0, 0.3, 3];
  const at = gale.windTime;
  gale.advanceTime(0.5);
  assert.ok(Math.abs(gale.windTime - at - 0.5) < 1e-12);
  assert.deepEqual(gale.wind, [1, 0, 0.3, 3]);
  assert.throws(() => (gale.wind = [1, 0, 0.3, -2]), RangeError);
  assert.throws(() => new Scatter(box(), { wind: [1, 0, 0.3, 200] }), RangeError);
  const s = new Scatter(box());
  applyScatterSettings(s, { 'wind.strength': 0.8, 'wind.speed': 24.5 });
  assert.deepEqual(s.wind, [1, 0, 0.8, 24.5], 'the slider row writes the speed');
  applyScatterSettings(s, { 'wind.strength': 0.8 });
  assert.deepEqual(s.wind, [1, 0, 0.8], 'speed 0 writes the three-number wind');
});
