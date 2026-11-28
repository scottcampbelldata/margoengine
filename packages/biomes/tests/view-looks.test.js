// The ground-material look families of @margoengine/biomes/view: natural keeps every material, animatedFeature is more
// saturated with softer fine detail and more large-scale variation, the table stays a valid `materials` option.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BIOME_LOOKS, MATERIALS, biomeMaterials } from '../dist/view.js';

const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const chroma = (c) => Math.max(...c) - Math.min(...c);

test('natural gives every built-in material back unchanged', () => {
  const out = biomeMaterials('natural');
  assert.deepEqual(Object.keys(out), Object.keys(MATERIALS));
  for (const [key, m] of Object.entries(MATERIALS)) {
    m.color.forEach((c, i) => assert.ok(Math.abs(out[key].color[i] - c) < 1e-12, `${key} colour`));
    assert.equal(out[key].detail, m.detail ?? 0.25);
    assert.equal(out[key].bump, m.bump ?? 0);
    assert.equal(out[key].macro, m.macro ?? 0);
  }
});

test('animatedFeature saturates, softens the fine detail and widens the large-scale variation', () => {
  const out = biomeMaterials('animatedFeature'),
    v = BIOME_LOOKS.animatedFeature;
  assert.ok(v.saturation >= 1.1 && v.saturation <= 1.15, 'saturation up 10 to 15 percent');
  for (const [key, m] of Object.entries(MATERIALS)) {
    const o = out[key];
    if (key !== 'snow' && key !== 'rock')
      assert.ok(chroma(o.color) >= chroma(m.color) - 1e-12, `${key} is not less saturated`);
    assert.ok(Math.abs(luma(o.color) - luma(m.color)) < 0.02, `${key} keeps its luminance (clamping aside)`);
    assert.ok(o.detail < (m.detail ?? 0.25), `${key} softer detail`);
    assert.ok(o.macro >= m.macro && o.macro <= 1, `${key} more macro variation`);
    for (const c of o.color) assert.ok(c >= 0 && c <= 1);
  }
});

test('a table of your own and your own multipliers are accepted, bad ones refused', () => {
  const own = { clay: { color: [0.6, 0.3, 0.2] } };
  const out = biomeMaterials({ saturation: 0, detail: 2, bump: 1, macro: 1 }, own);
  assert.deepEqual(Object.keys(out), ['clay']);
  assert.ok(chroma(out.clay.color) < 1e-12, 'saturation 0 is grey');
  assert.equal(out.clay.detail, 0.5);
  assert.throws(() => biomeMaterials('claymation'), RangeError);
  assert.throws(() => biomeMaterials({ saturation: -1, detail: 1, bump: 1, macro: 1 }), RangeError);
  assert.throws(() => biomeMaterials({ saturation: 1, detail: NaN, bump: 1, macro: 1 }), RangeError);
});

test('regression: the needles and dry-grass grounds are measured litter, not orange', () => {
  // ECOSTRESS Spectral Library 1.0: white fir dry needles VH325 to VH327 and wild oat litter VH354, VH355, through the
  // @margoengine/optics SpectralIntegrator (6504 K, 5 nm). The old needles (0.46, 0.32, 0.18) had blue at 0.15 of red in
  // linear light, the measured litter 0.40; the old dry grass (0.78, 0.67, 0.38) was twice the measured brightness.
  const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  for (const [key, want] of [
    ['needles', [0.2025, 0.1356, 0.0805]],
    ['dry-grass', [0.3476, 0.2394, 0.0983]],
  ]) {
    const got = MATERIALS[key].color.map(linear);
    want.forEach((w, i) =>
      assert.ok(Math.abs(got[i] - w) < 0.002, `${key} linear channel ${i}: ${got[i]} against ${w}`),
    );
  }
  const [r, , b] = MATERIALS.needles.color.map(linear);
  assert.ok(b / r > 0.36 && b / r < 0.44, `needles blue over red ${b / r}`);
});

test('firn is a summer snowfield: visible reflectance 0.7, darker and warmer than fresh snow', () => {
  // Brock, Willis and Sharp 2000 (aged wet snow and firn about 0.5 broadband); Wiscombe and Warren 1980 (the visible
  // stays higher); Warren and Wiscombe 1980 and Painter et al. 2007 (dust lowers and warms the visible).
  const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const firn = MATERIALS.firn.color.map(linear),
    snow = MATERIALS.snow.color.map(linear),
    luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  assert.ok(Math.abs(luma(firn) - 0.68) < 0.02, `firn reflects ${luma(firn)}`);
  assert.ok(luma(snow) > luma(firn) + 0.15, 'fresh snow is brighter');
  assert.ok(firn[0] > firn[2], 'dust warms it');
});
