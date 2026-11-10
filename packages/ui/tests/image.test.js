import test from 'node:test';
import assert from 'node:assert/strict';
import { makeUi } from './helpers.js';
import { Image, ImageTexture } from '../dist/image.js';
function texture(width = 120, height = 60) {
  const bytes = new Uint8Array(width * height * 4);
  for (let i = 0; i < bytes.length; i += 4) {
    bytes[i] = 255;
    bytes[i + 3] = 255;
  }
  return new ImageTexture(width, height, bytes);
}
function draw(options) {
  const ui = makeUi(),
    image = new Image({ texture: texture(), width: 200, height: 200, anchor: 'top-left', ...options });
  ui.add(image);
  ui.update(0);
  return { ui, image, commands: ui.draw().commands.filter((c) => c.type === 'image') };
}
const bounds = (commands) => ({
  x: Math.min(...commands.map((c) => c.x)),
  y: Math.min(...commands.map((c) => c.y)),
  right: Math.max(...commands.map((c) => c.x + c.width)),
  bottom: Math.max(...commands.map((c) => c.y + c.height)),
});
test('contain preserves aspect, cover crops and fill stretches', () => {
  for (const [fit, expected] of [
    ['contain', { x: 0, y: 50, right: 200, bottom: 150 }],
    ['cover', { x: 0, y: 0, right: 200, bottom: 200 }],
    ['fill', { x: 0, y: 0, right: 200, bottom: 200 }],
  ]) {
    const d = draw({ fit });
    assert.deepEqual(bounds(d.commands), expected);
    if (fit === 'cover')
      assert.equal(
        d.commands.reduce((n, c) => n + c.source.width * c.source.height, 0),
        60 * 60,
      );
    d.ui.dispose();
  }
});
test('atlas crop uses only the cell pixels and clamps its filter gutter', () => {
  const data = new Uint8Array(8 * 4 * 4);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 4;
      data.set(x < 4 ? [255, 0, 0, 255] : [0, 255, 0, 255], i);
    }
  const tex = new ImageTexture(8, 4, data),
    d = draw({ texture: tex, source: { x: 4, y: 0, width: 4, height: 4 }, fit: 'fill' });
  const bitmap = d.commands[0].bitmap;
  for (let i = 0; i < bitmap.data.length; i += 4)
    assert.deepEqual([...bitmap.data.subarray(i, i + 4)], [0, 255, 0, 255]);
  assert.equal(bitmap.width, 6);
  d.ui.dispose();
});
test('nine-slice leaves corners fixed and shrinks borders proportionately in a small target', () => {
  let d = draw({ texture: texture(30, 30), slice: 5, fit: 'fill', width: 100, height: 80 });
  assert.equal(d.commands.length, 9);
  assert.equal(d.commands[0].width, 5);
  assert.equal(d.commands[0].height, 5);
  assert.equal(d.commands[4].width, 90);
  assert.equal(d.commands[4].height, 70);
  d.ui.dispose();
  d = draw({ texture: texture(30, 30), slice: 5, width: 6, height: 4 });
  assert.ok(d.commands.every((c) => c.width >= 0 && c.height >= 0));
  assert.deepEqual(bounds(d.commands), { x: 0, y: 0, right: 6, bottom: 4 });
  assert.equal(d.commands[0].width, 2);
  d.ui.dispose();
});
test('large sources tile with neighbor gutters, premultiplied filtering and immutable pixel copies', () => {
  const data = new Uint8Array(121 * 3 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([200, 100, 50, 128], i);
  const tex = new ImageTexture(121, 3, data);
  data.fill(0);
  const tiles = tex.tiles({ x: 0, y: 0, width: 121, height: 3 });
  assert.equal(tiles.length, 3);
  assert.ok(tiles.every((t) => t.bitmap.width <= 62));
  assert.deepEqual([...tiles[0].bitmap.data.subarray(0, 4)], [100, 50, 25, 128]);
  assert.equal(tiles, tex.tiles({ x: 0, y: 0, width: 121, height: 3 }));
});
test('image options copy mutable source, tint and border arrays', () => {
  const source = { x: 0, y: 0, width: 20, height: 20 },
    tint = [1, 1, 1, 1],
    slice = [2, 2, 2, 2],
    d = draw({ texture: texture(30, 30), source, tint, slice });
  source.width = 999;
  tint[3] = 0;
  slice[0] = 999;
  assert.equal(d.image.source.width, 20);
  assert.equal(d.image.tint[3], 1);
  assert.equal(d.image.slice[0], 2);
  const copy = d.image.slice;
  copy[0] = 999;
  assert.equal(d.image.slice[0], 2);
  assert.throws(() => (d.image.source = { x: 0, y: 0, width: 999, height: 999 }));
  assert.equal(d.image.source.width, 20);
  d.ui.dispose();
});
test('bad dimensions, crop, fit and slice reject without corrupting state', () => {
  assert.throws(() => texture(0, 1));
  assert.throws(() => new Image({ texture: texture(), fit: 'bad' }));
  assert.throws(() => new Image({ texture: texture(), slice: 99 }));
  assert.throws(() => new Image({ texture: texture(), source: { x: 0.5, y: 0, width: 1, height: 1 } }));
  const d = draw({});
  assert.throws(() => (d.image.fit = 'bad'));
  assert.equal(d.image.fit, 'contain');
  assert.throws(() => (d.image.borderScale = Infinity));
  assert.equal(d.image.borderScale, 1);
  d.ui.dispose();
});
