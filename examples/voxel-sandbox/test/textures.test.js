import assert from 'node:assert/strict';
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
  ])
    assert.ok(
      alphas(layer(name)).every((a) => a === 255),
      `${name} is opaque`,
    );
  for (const name of ['leaves', 'torch', 'tall_grass', 'dandelion', 'poppy']) {
    const a = alphas(layer(name));
    assert.ok(
      a.every((v) => v === 0 || v === 255),
      `${name} keeps alpha 0 or 255 (alpha-tested, coverage-preserving mips)`,
    );
    assert.ok(a.some((v) => v === 0) && a.some((v) => v === 255), `${name} has holes and cover`);
  }
  const holes = alphas(layer('leaves')).filter((v) => v === 0).length / 256;
  assert.ok(holes > 0.2 && holes < 0.5, `leaves are ${(holes * 100).toFixed(0)}% holes`);
  for (const name of ['water', 'glass']) {
    const a = alphas(layer(name));
    assert.ok(
      a.some((v) => v > 0 && v < 255),
      `${name} is translucent`,
    );
  }
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
