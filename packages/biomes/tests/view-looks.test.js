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
