// Wet ground (`@margoengine/terrain/wet-ground`) on the CPU: the drying law, the options' checks, the shader patch's
// shape on a terrain shader, and the slider rows on the shared shape. The pictures are in wet-ground.browser.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WET_GROUND_LIVE_SETTINGS,
  WET_GROUND_SETTINGS,
  WetGround,
  applyWetGroundSettings,
  wetGroundSettingDefaults,
} from '../dist/wet-ground.js';

const terrain = { addLighting: () => () => {} },
  options = { record: () => undefined, origin: [-16, -16], size: [32, 32] };

test("wetness is the record's wet flag times exp(-since / dryTime): 1 under water, 1/e at dryTime", () => {
  const wet = new WetGround(terrain, { ...options, dryTime: 100 });
  assert.equal(wet.wetness(0, 1), 1);
  assert.ok(Math.abs(wet.wetness(100, 1) - 1 / Math.E) < 1e-12);
  assert.ok(wet.wetness(2000, 1) < 3e-9);
  assert.equal(wet.wetness(0, 0), 0, 'never wet is dry');
  assert.deepEqual(new WetGround(terrain, options).look, { darkening: 0.55, gloss: 0.5, dryTime: 10800 });
});

test('the options are checked before anything is drawn', () => {
  assert.throws(() => new WetGround(undefined, options), TypeError);
  assert.throws(() => new WetGround(terrain, { ...options, record: null }), TypeError);
  assert.throws(() => new WetGround(terrain, { ...options, size: [0, 32] }), RangeError);
  assert.throws(() => new WetGround(terrain, { ...options, origin: [Number.NaN, 0] }), RangeError);
  assert.throws(() => new WetGround(terrain, { ...options, darkening: 1.5 }), RangeError);
  assert.throws(() => new WetGround(terrain, { ...options, dryTime: 0 }), RangeError);
  assert.throws(() => new WetGround(terrain, { ...options, binding: 999 }), RangeError);
});

test('the shader patch keeps one terrainColor and one fragment entry, so it composes with other ground effects', () => {
  const source =
      'struct Output {@builtin(position) clip:vec4f,@location(0) position:vec3f,@location(3) material:vec4f}\n' +
      'fn terrainColor(position:vec3f,normal:vec3f)->vec3f {return vec3f(1);}\n' +
      '@fragment fn fragment(i:Output)->@location(0) vec4f {let a=i.material.x*i.material.x;return vec4f(terrainColor(i.position,vec3f(0,1,0)),a);}',
    first = new WetGround(terrain, options).shader(source, 1),
    both = new WetGround(terrain, { ...options, binding: 118 }).shader(first, 1);
  for (const code of [first, both]) {
    assert.equal(code.split('fn terrainColor(position:vec3f,normal:vec3f)->vec3f {').length, 2);
    assert.equal(code.split('@fragment fn fragment(i:Output)->@location(0) vec4f {').length, 2);
  }
  assert.match(first, /@group\(1\) @binding\(116\) var wetRecord_w\d+:texture_2d<f32>;/);
  assert.match(both, /@group\(1\) @binding\(119\) var<uniform> wetLook_w\d+:array<vec4f,2>;/);
  assert.throws(() => new WetGround(terrain, options).shader('fn other(){}', 1), /terrainColor/);
});

test('slider rows: the shared shape, every row live, defaults equal to the look without options', () => {
  assert.deepEqual(
    WET_GROUND_SETTINGS.map((r) => r.name),
    ['wet.darkening', 'wet.gloss', 'wet.dryTime'],
  );
  assert.equal(WET_GROUND_LIVE_SETTINGS.length, WET_GROUND_SETTINGS.length);
  for (const row of WET_GROUND_SETTINGS) {
    assert.equal(row.kind, 'number');
    assert.equal(row.group, 'wet');
    assert.ok(row.min <= row.default && row.default <= row.max && row.step > 0 && row.about.length > 10);
  }
  assert.deepEqual(wetGroundSettingDefaults(), { 'wet.darkening': 0.55, 'wet.gloss': 0.5, 'wet.dryTime': 10800 });
  const wet = new WetGround(terrain, options);
  applyWetGroundSettings(wet, { 'wet.gloss': 0.2, 'wet.dryTime': 60 });
  assert.deepEqual(wet.look, { darkening: 0.55, gloss: 0.2, dryTime: 60 });
  assert.throws(() => applyWetGroundSettings(wet, { 'wet.shine': 1 }), TypeError);
  assert.throws(() => applyWetGroundSettings(wet, { 'wet.gloss': 2 }), RangeError);
  wet.dispose();
  assert.throws(() => wet.setLook({ gloss: 0.1 }), /disposed/);
});
