import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { paintBlockTextures, TEXTURE_NAMES, textureLayer, WATER_FRAMES } from '../src/textures.ts';

const alphas = ({ data }) => Array.from({ length: 256 }, (_, i) => data[i * 4 + 3]);

test('every texture is a 16 x 16 RGBA8 layer, painted the same on every call', () => {
  const a = paintBlockTextures(),
    b = paintBlockTextures();
  assert.equal(a.length, TEXTURE_NAMES.length);
  assert.ok(a.length <= 256, 'BlockTextures holds at most 256 layers');
  for (const [i, p] of a.entries()) {
    assert.equal(p.width, 16);
    assert.equal(p.height, 16);
    assert.equal(p.data.length, 1024);
    assert.deepEqual(p.data, b[i].data, `${TEXTURE_NAMES[i]} is deterministic`);
  }
});

test('solid blocks are opaque, cutouts are all-or-nothing, water and glass are see-through', () => {
  const images = paintBlockTextures(),
    layer = (name) => images[textureLayer(name)];
  for (const name of [
    'stone',
    'dirt',
    'grass_top',
    'grass_side',
    'sand',
    'planks',
    'cobblestone',
    'bricks',
    'glowstone',
    'heart_red',
    'sandstone',
    'marble',
    'slate',
    'plaster',
    'walnut_planks',
    'roof_tiles',
    'gravel',
    'moss',
    'tin_ore',
    'silver_ore',
    'malachite_ore',
    'opal',
  ])
    assert.ok(
      alphas(layer(name)).every((a) => a === 255),
      `${name} is opaque`,
    );
  for (const name of ['leaves', 'torch', 'tall_grass', 'dandelion', 'poppy', 'glow_cap']) {
    const a = alphas(layer(name));
    assert.ok(
      a.every((v) => v === 0 || v === 255),
      `${name} keeps alpha 0 or 255 (alpha-tested, coverage-preserving mips)`,
    );
    assert.ok(a.some((v) => v === 0) && a.some((v) => v === 255), `${name} has holes and cover`);
  }
  const holes = alphas(layer('leaves')).filter((v) => v === 0).length / 256;
  assert.ok(holes > 0.2 && holes < 0.5, `leaves are ${(holes * 100).toFixed(0)}% holes`);
  for (const name of ['water', 'glass', 'amber']) {
    const a = alphas(layer(name));
    assert.ok(
      a.some((v) => v > 0 && v < 255),
      `${name} is translucent`,
    );
  }
});

test('new types only append: every older layer keeps its pixels', () => {
  // SHA-256 of the 26 layers before the Plaza's blocks, in layer order. A new painter goes at the end of PAINTERS; a
  // deliberate repaint changes this with its reason.
  const images = paintBlockTextures().slice(0, 26),
    hash = createHash('sha256');
  for (const { data } of images) hash.update(data);
  assert.equal(TEXTURE_NAMES[25], 'heart_red');
  assert.equal(hash.digest('hex'), '1912a596b6764113adf1a227fc98027c71f7ba2c9e4fd96a6b81b0d004b7f458');
});

test('water frames are consecutive layers that differ from each other', () => {
  const images = paintBlockTextures(),
    first = textureLayer('water');
  for (let i = 1; i < WATER_FRAMES; i++) {
    assert.equal(TEXTURE_NAMES[first + i], `water_${i}`);
    assert.notDeepEqual(images[first + i].data, images[first + i - 1].data);
  }
  assert.throws(() => textureLayer('lava'), RangeError);
});
