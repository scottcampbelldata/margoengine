// Node checks of the CPU side of @margoengine/sprites: draw order, snapping maths, the buffer layout and option errors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packSprites, snapToPixel, sortSprites, Sprite, SPRITE_FLOATS, SpriteLayer } from '../dist/index.js';

const camera = { x: 0, y: 0, zoom: 1 };
const pack = (sprites, options = {}) => {
  const data = options.data ?? new Float32Array(sprites.length * SPRITE_FLOATS);
  return { data, ...packSprites(sprites, data, options.camera ?? camera, 16, 16, options.snap ?? true) };
};
const layer = (options = {}) =>
  new SpriteLayer({ atlas: { width: 16, height: 16, data: new Uint8Array(1024) }, ...options });

test('the buffer layout: 12 floats, pivot, size, pivot fractions, turn, tint bytes and the atlas rectangle', () => {
  assert.equal(SPRITE_FLOATS, 12);
  const { data, count } = pack([
    new Sprite({
      x: 10,
      y: 7,
      rect: [4, 8, 2, 3],
      scaleX: 2,
      rotation: 0.5,
      pivotX: 0.5,
      pivotY: 1,
      tint: 0x102030,
      alpha: 1,
    }),
  ]);
  assert.equal(count, 1);
  // Size 4 x 3 with the pivot at (2, 3): the corner (8, 4) is whole, so the pivot stays at (10, 7).
  assert.deepEqual([...data.subarray(0, 7)], [10, 7, 4, 3, 0.5, 1, 0.5]);
  assert.deepEqual([...new Uint8Array(data.buffer, 28, 4)], [0x10, 0x20, 0x30, 0xff], 'red is the low byte');
  assert.deepEqual([...data.subarray(8, 12)], [4, 8, 2, 3]);
});

test('a flip moves the rectangle origin to the far edge and negates its size; the whole atlas is the default', () => {
  const { data } = pack([new Sprite({ flipX: true }), new Sprite({ rect: [1, 2, 3, 4], flipX: true, flipY: true })]);
  assert.deepEqual([...data.subarray(8, 12)], [16, 0, -16, 16]);
  assert.deepEqual([...data.subarray(20, 24)], [4, 6, -3, -4]);
});

test('snapping rounds the corner after the camera, so half-pixel pivots still cover whole pixels', () => {
  assert.equal(snapToPixel(10.4, 0), 10);
  assert.equal(snapToPixel(10.5, 0), 11);
  assert.equal(snapToPixel(-0.6, 0), -1);
  // A 5-wide image pivoted at its middle: pivot 10 means corner 7.5, which rounds to 8; the pivot goes to 10.5.
  assert.equal(snapToPixel(10, 2.5), 10.5);
  const moved = pack([new Sprite({ x: 3.4, y: 2.6, rect: [0, 0, 4, 4] })], {
    camera: { x: 1, y: 1, zoom: 2 },
  });
  // (3.4 - 1) * 2 = 4.8 rounds to 5; (2.6 - 1) * 2 = 3.2 rounds to 3; the camera's zoom scales the size.
  assert.deepEqual([...moved.data.subarray(0, 4)], [5, 3, 8, 8]);
  const free = pack([new Sprite({ x: 3.25, y: 2.75 })], { snap: false });
  assert.deepEqual([...free.data.subarray(0, 2)], [3.25, 2.75]);
});

test('a half-pixel scroll does not move a snapped sprite until it reaches the next pixel', () => {
  const at = (x) => pack([new Sprite({ x: 10 })], { camera: { x, y: 0, zoom: 1 } }).data[0];
  assert.equal(at(0), 10);
  assert.equal(at(0.25), 10);
  assert.equal(at(0.75), 9);
  assert.equal(at(1), 9);
});

test('draw order: z first, then y when asked, then add order, stable through ties', () => {
  const a = new Sprite({ y: 5 }),
    b = new Sprite({ y: 1 }),
    c = new Sprite({ y: 3, z: -1 }),
    d = new Sprite({ y: 1 });
  [a, b, c, d].forEach((sprite, i) => {
    sprite.index = i;
  });
  const list = [a, b, c, d];
  sortSprites(list);
  assert.deepEqual(list, [c, a, b, d]);
  sortSprites(list, true);
  assert.deepEqual(list, [c, b, d, a]);
  a.y = 0;
  sortSprites(list, true);
  assert.deepEqual(list, [c, a, b, d]);
});

test('a list in order is left untouched: a still scene never sorts', () => {
  const list = [new Sprite(), new Sprite()];
  list[1].index = 1;
  list.sort = () => assert.fail('sorted a list already in order');
  sortSprites(list);
});

test('packing reports only the floats that changed, and hidden sprites are left out', () => {
  const sprites = [new Sprite({ x: 1 }), new Sprite({ x: 2 }), new Sprite({ x: 3 })],
    data = new Float32Array(sprites.length * SPRITE_FLOATS);
  const first = pack(sprites, { data });
  assert.equal(first.start, 0);
  const still = pack(sprites, { data });
  assert.deepEqual([still.start, still.end, still.count], [0, 0, 3], 'nothing changed, nothing to upload');
  sprites[1].x = 9;
  const moved = pack(sprites, { data });
  assert.deepEqual([moved.start, moved.end], [12, 13], 'only the one float');
  sprites[1].tint = 0xff0000;
  const tinted = pack(sprites, { data });
  assert.deepEqual([tinted.start, tinted.end], [19, 20], 'the tint bits are compared as bits');
  sprites[0].visible = false;
  assert.equal(pack(sprites, { data }).count, 2);
  assert.equal(data[0], 9, 'the next visible sprite moved up');
});

test('a tint whose bytes read as a NaN float does not count as changed every frame', () => {
  const sprite = new Sprite({ tint: 0xffffff }),
    data = new Float32Array(SPRITE_FLOATS);
  pack([sprite], { data });
  const again = pack([sprite], { data });
  assert.equal(again.end, 0);
});

test('tints: numbers and hex strings, and clear errors', () => {
  assert.equal(new Sprite({ tint: '#ff8000' }).tint, 0xff8000);
  assert.equal(new Sprite({ tint: '#f80' }).tint, 0xff8800);
  assert.equal(new Sprite().tint, 0xffffff);
  assert.throws(() => new Sprite({ tint: 'red' }), TypeError);
  assert.throws(() => new Sprite({ tint: 0x1000000 }), RangeError);
});

test('invalid sprites and cameras throw a RangeError that links its fix', () => {
  for (const bad of [
    { x: Number.NaN },
    { rotation: Infinity },
    { alpha: 2 },
    { rect: [0, 0, 0, 1] },
    { rect: [15, 0, 2, 1] },
    { rect: [0.5, 0, 1, 1] },
  ])
    assert.throws(() => pack([new Sprite(bad)]), /margoengine\.com\/errors#sprite-options/, JSON.stringify(bad));
  assert.throws(() => pack([new Sprite()], { camera: { x: 0, y: 0, zoom: 0 } }), RangeError);
});

test('SpriteLayer: options are checked, sprites come and go, a sprite belongs to one layer', () => {
  assert.throws(() => new SpriteLayer({}), TypeError);
  assert.throws(() => layer({ capacity: 0 }), RangeError);
  assert.throws(() => layer({ order: Number.NaN }), RangeError);
  assert.throws(() => layer({ layers: -1 }), RangeError);
  assert.throws(() => layer({ clear: [0, 0, 0] }), RangeError);
  const one = layer(),
    other = layer();
  assert.notEqual(one.name, other.name);
  const sprite = one.add({ x: 4 });
  assert.equal(sprite.x, 4);
  assert.equal(one.add(new Sprite()).index, 1);
  assert.throws(() => other.add(sprite), /already in a layer/);
  assert.equal(other.remove(sprite), false);
  assert.equal(one.remove(sprite), true);
  assert.equal(one.sprites.length, 1);
  assert.equal(other.add(sprite), sprite);
  other.clearSprites();
  assert.equal(other.sprites.length, 0);
  other.dispose();
  assert.throws(
    () => other.add(),
    (error) => error.code === 'disposed',
  );
});
