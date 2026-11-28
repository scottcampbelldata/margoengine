// Puddles in JavaScript (the same formulas as the shader) and the hook into core's mesh shader. The real GPU runs the
// WGSL against these functions in browser-check.mjs puddles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PUDDLE_BINDING,
  Puddles,
  puddleLevel,
  puddleMask,
  puddleRelief,
  puddleSurface,
  puddleWGSL,
  validatePuddles,
  puddleFilm,
  dampRoughness,
  puddleWaterRoughness,
} from '../dist/puddles.js';
import { wetColor, wetRoughness } from '../dist/index.js';

const coreShader = readFileSync(new URL('../../core/src/shaders.ts', import.meta.url), 'utf8').split('`')[1];
// Share of flat ground under water on a 200 x 200 grid 0.15 m apart (30 m square, ten puddle widths).
const share = (wetness, o = {}) => {
  let wet = 0;
  for (let i = 0; i < 200; i++)
    for (let j = 0; j < 200; j++) wet += puddleMask(i * 0.15 + 0.05, j * 0.15 + 0.07, 1, wetness, o) > 0.5 ? 1 : 0;
  return wet / 40000;
};

test('the share of flat ground under water at wetness 1 is the coverage asked for', () => {
  for (const coverage of [0.1, 0.3, 0.5, 0.7]) {
    const s = share(1, { coverage });
    // The quantile table was measured on other points; a 30 m square holds about 100 independent relief cells,
    // so its share of a level wanders by a few hundredths around the table's.
    assert.ok(Math.abs(s - coverage) < 0.06, `coverage ${coverage}: ${s}`);
  }
});

test('water stands only above the start wetness, grows with it, and only on flat ground', () => {
  assert.equal(share(0.4), 0, 'at the start wetness nothing stands');
  assert.equal(share(0.2), 0);
  const a = share(0.6),
    b = share(0.8),
    c = share(1);
  assert.ok(a > 0 && a < b && b < c, `${a} < ${b} < ${c}`);
  // Find a point under water on the flat and tilt it.
  let x = 0;
  while (puddleMask(x, 0.3, 1, 1) < 1) x += 0.05;
  assert.equal(puddleMask(x, 0.3, 1, 1), 1);
  assert.ok(puddleMask(x, 0.3, Math.cos((10 * Math.PI) / 180), 1) > 0.9, '10 degrees still holds water');
  assert.equal(puddleMask(x, 0.3, Math.cos((20 * Math.PI) / 180), 1), 0, '20 degrees sheds it');
  assert.equal(puddleMask(x, 0.3, 0, 1), 0, 'walls hold none');
  assert.equal(puddleMask(x, 0.3, -1, 1), 0, 'nor ceilings');
  assert.equal(puddleMask(x, 0.3, 1, 1, { coverage: 0 }), 0);
});

test('the relief is continuous, 0..1, and the level table rises with the share', () => {
  for (let x = -20; x < 20; x += 0.37) {
    const h = puddleRelief(x, x * 0.7);
    assert.ok(h >= 0 && h <= 1);
    assert.ok(Math.abs(puddleRelief(x + 1e-4, x * 0.7) - h) < 1e-3);
  }
  for (let s = 0; s < 0.8; s += 0.01) assert.ok(puddleLevel(s + 0.01) > puddleLevel(s));
  assert.equal(puddleLevel(-1), puddleLevel(0));
  assert.equal(puddleLevel(2), puddleLevel(0.8));
});

test('surface: wet darkens and smooths like wetColor and wetRoughness, water smooths to 0.03 and drops metal', () => {
  const base = { color: [0.4, 0.3, 0.2], roughness: 0.8, metal: 0.5 };
  const dry = puddleSurface(base, 0, 0, 1, 0);
  assert.deepEqual(dry, { color: [0.4, 0.3, 0.2], roughness: 0.8, metal: 0.5, water: 0 });
  const wall = puddleSurface(base, 0, 0, 0, 0.7);
  assert.deepEqual(wall.color, wetColor(base.color, 0.7));
  assert.equal(wall.roughness, dampRoughness(0.8, 0.7, 0.5), 'A wall holds a half film');
  assert.equal(dampRoughness(0.8, 0.7, 1), wetRoughness(0.8, 0.7), 'A whole film smooths as wetRoughness');
  assert.equal(wall.water, 0);
  let x = 0;
  while (puddleMask(x, 0, 1, 1) < 1) x += 0.05;
  const pool = puddleSurface(base, x, 0, 1, 1);
  assert.equal(pool.water, 1);
  assert.ok(Math.abs(pool.roughness - 0.03) < 1e-12);
  assert.equal(pool.metal, 0);
  assert.ok(Math.abs(pool.color[0] - 0.4 * 0.75 * 0.7) < 1e-12);
  const plain = puddleSurface(base, 0, 0, 0, 0.7, { wetSurfaces: false });
  assert.deepEqual(plain.color, [0.4, 0.3, 0.2], 'without wetSurfaces only water changes a surface');
});

test('wet ground is no mirror: damp crests stay rough, low spots gloss, and rain roughens the puddles (Last Tram)', () => {
  // Regression: every damp surface smoothed by 65 percent and every puddle sat at roughness 0.03 whatever the rain, so a
  // wet night floor reflected the tram like a perfect mirror (Last Tram stills, 2026-11-28).
  const base = { color: [0.2, 0.2, 0.2], roughness: 0.46 };
  const o = { coverage: 0.39, size: 2.6, rain: 0.72, rippleStrength: 0.22 };
  let crest = 1,
    low = 0,
    dampLow = 1,
    dampHigh = 0,
    films = 0,
    n = 0;
  for (let x = 0; x < 30; x += 0.37)
    for (let z = 0; z < 30; z += 0.41) {
      const s = puddleSurface(base, x, z, 1, 0.98, o);
      const f = puddleFilm(x, z, 1, 0.98, o);
      assert.ok(f >= 0 && f <= 1);
      films += f;
      n++;
      crest = Math.min(crest, f);
      low = Math.max(low, f);
      if (s.water === 0) {
        dampLow = Math.min(dampLow, s.roughness);
        dampHigh = Math.max(dampHigh, s.roughness);
      }
    }
  assert.ok(crest < 0.05 && low > 0.95, 'Drained crests and full films both occur');
  assert.ok(films / n > 0.15 && films / n < 0.85, `The film covers part of the ground (${films / n})`);
  assert.ok(dampHigh - dampLow > 0.15, `Damp roughness varies across the ground (${dampLow} to ${dampHigh})`);
  assert.ok(dampHigh > 0.33, 'Drained damp concrete stays rough');
  assert.ok(Math.abs(puddleWaterRoughness(0) - 0.03) < 1e-12, 'Calm water is glassy');
  assert.ok(Math.abs(puddleWaterRoughness(1) - 0.2) < 0.005, 'Full rain with the default rings: 0.2');
  assert.ok(puddleWaterRoughness(0.72, 0.22) > 0.12, 'Rain-struck puddles are no mirror');
  let x = 0;
  while (puddleMask(x, 0, 1, 1, o) < 1) x += 0.05;
  assert.ok(Math.abs(puddleSurface(base, x, 0, 1, 1, o).roughness - puddleWaterRoughness(0.72, 0.22)) < 1e-12);
  assert.equal(puddleFilm(3, 4, 0, 0.9), 0.5, 'Walls hold a half film');
  // The shader computes the same film and water roughness.
  assert.ok(puddleWGSL.includes('fn weather_puddle_film(xz:vec2f, normalY:f32, u:WeatherPuddles)->f32 {'));
  assert.ok(puddleWGSL.includes('let calm=sqrt(0.0009+0.112*clamp(u.a.y,0.0,1.0)*clamp(u.b.w,0.0,1.0));'));
});

test('options are checked by name and range', () => {
  validatePuddles({});
  assert.throws(() => validatePuddles({ coverage: 0.9 }), /coverage must be a number from 0 to 0.8/);
  assert.throws(() => validatePuddles({ size: 0 }), RangeError);
  assert.throws(() => validatePuddles({ wetSurfaces: 1 }), TypeError);
  assert.throws(() => validatePuddles({ weather: {} }), /numeric wetness/);
  assert.throws(() => validatePuddles(null), TypeError);
  assert.throws(() => new Puddles({ rain: 2 }), RangeError);
});

test('the weather sets wetness and rain: a machine by its state, a sky Weather by amount and rain share', () => {
  const p = new Puddles({ weather: { wetness: 0.6, state: { rain: 0.8 } } });
  assert.equal(p.wetness, 0.6);
  assert.equal(p.rain, 0.8);
  p.options.weather = { wetness: 0.2, amount: 0.5, rainShare: 0.4 };
  assert.equal(p.rain, 0.2);
  p.options.weather = { wetness: 0.2, amount: 0.5 };
  assert.equal(p.rain, 0.5);
  p.options.weather = undefined;
  p.options.wetness = 0.3;
  assert.equal(p.wetness, 0.3);
  assert.equal(p.rain, 0);
  p.onPreUpdate(0.5);
  assert.equal(p.time, 0.5);
  assert.throws(() => p.onPreUpdate(-1), RangeError);
  p.dispose();
  assert.throws(
    () => p.onPreUpdate(0.1),
    (e) => e.code === 'disposed',
  );
});

test('the hook rewrites core fragment input once and chains', () => {
  const p = new Puddles();
  const once = p.patch(coreShader);
  assert.notEqual(once, coreShader);
  assert.match(
    once,
    /@fragment fn fragment\(weatherIn:Output,@builtin\(front_facing\) front:bool\)->@location\(0\) vec4f \{var i=weatherIn;\{let s=weather_puddle_surface/,
  );
  // A second surface hook goes after the first, on the same copy.
  const twice = p.patch(once);
  assert.equal(twice.match(/var i=weatherIn;/g).length, 1);
  assert.equal(twice.match(/weather_puddle_surface\(i\./g).length, 2);
  assert.equal(p.patch('@fragment fn other(){}'), '@fragment fn other(){}', 'another shader is left alone');
  assert.match(puddleWGSL, /fn weather_puddle_surface/);
  assert.equal(PUDDLE_BINDING, 160);
  assert.throws(
    () => Puddles.attach({ use: (plugin) => plugin.setup({}) }),
    (e) => e.code === 'unsupported',
  );
});
