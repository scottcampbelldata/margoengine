// Snow in JavaScript (the same formulas as the shader) and its hooks into core's mesh shader. The real GPU runs the
// WGSL against these functions in browser-check.mjs snow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SNOW_BINDING, Snow, snowAt, snowDepthAt, snowWGSL, validateSnow } from '../dist/snow.js';
import { Puddles } from '../dist/puddles.js';
import { snowWeight } from '../dist/index.js';

const coreShader = readFileSync(new URL('../../core/src/shaders.ts', import.meta.url), 'utf8').split('`')[1];

test('snow covers up-facing surfaces first and steeper ones as the cover grows, with a broken edge', () => {
  for (let x = 0; x < 10; x += 0.7) {
    assert.equal(snowAt(x, 1, 1, 0), 0, 'no cover, no snow');
    assert.equal(snowAt(x, 1, 1, 1), 1, 'floors are white at full cover');
    assert.equal(snowAt(x, 1, 0, 1), 0, 'walls stay bare');
    assert.equal(snowAt(x, 1, -1, 1), 0);
  }
  // The edge moves with the cover as snowWeight's does, within the jitter of 0.05 in normalY.
  let differs = 0;
  for (let x = 0; x < 30; x += 0.13)
    for (const ny of [0.3, 0.55, 0.6, 0.65, 0.9]) {
      const a = snowAt(x, 2, ny, 0.6);
      assert.ok(a >= snowWeight(ny - 0.05, 0.6) - 1e-12 && a <= snowWeight(ny + 0.05, 0.6) + 1e-12);
      if (Math.abs(a - snowWeight(ny, 0.6)) > 0.01) differs++;
    }
  assert.ok(differs > 50, `the edge is broken up: ${differs} points off the plain contour`);
});

test('the depth is depth x cover on flat ground, varied in drifts, and none on walls', () => {
  let low = Infinity,
    high = 0,
    sum = 0,
    n = 0;
  for (let x = 0; x < 80; x += 0.5)
    for (let z = 0; z < 80; z += 0.5) {
      const d = snowDepthAt(x, z, 1, 1, { depth: 0.2 });
      low = Math.min(low, d);
      high = Math.max(high, d);
      sum += d;
      n++;
    }
  // variation 0.4 bounds the thickness to 0.2 x (1 +- 0.4); the noise covers most of that range over 400 drift cells.
  assert.ok(low >= 0.12 - 1e-12 && high <= 0.28 + 1e-12, `${low}..${high}`);
  assert.ok(low < 0.15 && high > 0.25, `drifts vary: ${low}..${high}`);
  assert.ok(Math.abs(sum / n - 0.2) < 0.02, `mean ${sum / n}`);
  assert.equal(snowDepthAt(3, 3, 1, 1, { depth: 0.2, variation: 0 }), 0.2);
  assert.equal(snowDepthAt(3, 3, 1, 0.5, { depth: 0.2, variation: 0 }), 0.1);
  assert.equal(snowDepthAt(3, 3, 0, 1, { depth: 0.2 }), 0, 'walls are not lifted');
  assert.equal(snowDepthAt(3, 3, 1, 0, { depth: 0.2 }), 0);
});

test('options are checked by name and range', () => {
  validateSnow({});
  assert.throws(() => validateSnow({ depth: 3 }), /depth must be a number from 0 to 2/);
  assert.throws(() => validateSnow({ drift: 0 }), RangeError);
  assert.throws(() => validateSnow({ color: [1, 1] }), TypeError);
  assert.throws(() => validateSnow({ weather: { wetness: 1 } }), /numeric snowCover/);
  assert.throws(() => new Snow(null), TypeError);
  const s = new Snow({ weather: { snowCover: 0.7 } });
  assert.equal(s.cover, 0.7);
  s.options.weather = undefined;
  s.options.cover = 0.25;
  assert.equal(s.cover, 0.25);
  s.dispose();
  assert.throws(
    () => s.onPreUpdate(0.1),
    (e) => e.code === 'disposed',
  );
  assert.throws(
    () => Snow.attach({ use: (plugin) => plugin.setup({}) }),
    (e) => e.code === 'unsupported',
  );
});

test('the hooks lift the vertex and change the surface, and chain with puddles', () => {
  const snow = new Snow(),
    once = snow.patch(coreShader);
  assert.match(
    once,
    /var p=model\*vec4f\(i\.position,1\);\{let wn=.*p\.y\+=weather_snow_depth\(p\.xz,wn\.y,weatherSnow\);\}/,
  );
  assert.match(once, /var i=weatherIn;\{let n0=normalize\(i\.normal\);let w=weather_snow_at/);
  const both = new Puddles().patch(once);
  assert.equal(both.match(/var i=weatherIn;/g).length, 1);
  assert.match(both, /weather_puddle_surface/);
  assert.equal(snow.patch('@fragment fn other(){}'), '@fragment fn other(){}');
  assert.match(snowWGSL, /fn weather_snow_depth/);
  assert.equal(SNOW_BINDING, 161);
});
