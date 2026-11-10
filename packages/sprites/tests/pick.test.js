import assert from 'node:assert/strict';
import test from 'node:test';
import { Sprite } from '../dist/index.js';
import { pickSprite } from '../dist/pick.js';
const atlas = {
  width: 2,
  height: 2,
  data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 128, 255, 255, 255, 255]),
};
test('pixel alpha passes through holes to the top visible underlying sprite; box picking keeps the box', () => {
  const back = new Sprite(),
    front = new Sprite({ z: 1 });
  front.index = 1;
  assert.equal(pickSprite([back, front], 0.5, 0.5, { atlas }).sprite, front);
  assert.equal(pickSprite([back, front], 1.5, 0.5, { atlas }), undefined);
  assert.equal(pickSprite([back, front], 1.5, 0.5, { atlas, mode: 'box' }).sprite, front);
  front.flipX = true;
  assert.equal(pickSprite([back, front], 0.5, 0.5, { atlas }).sprite, back);
  front.visible = false;
  assert.equal(pickSprite([back, front], 0.5, 0.5, { atlas }).sprite, back);
  assert.equal(pickSprite([back], 2, 0.5, { atlas }), undefined);
});
test('rotation, pivot, negative scale, texture flips and source texels follow the rendered transform', () => {
  const s = new Sprite({ x: 10, y: 10, pivotX: 0.5, pivotY: 0.5, rotation: Math.PI / 2, scaleX: 2 });
  const hit = pickSprite([s], 10.5, 8.5, { atlas, snap: false });
  assert.equal(hit.texelX, 0);
  assert.equal(hit.texelY, 0);
  s.flipY = true;
  assert.equal(pickSprite([s], 10.5, 8.5, { atlas, snap: false }).texelY, 1);
  s.rotation = 0;
  s.scaleX = -1;
  s.flipY = false;
  assert.equal(pickSprite([s], 10.5, 9.5, { atlas, snap: false }).texelX, 0);
});
test('camera and snap match SpriteLayer, alpha is quantized like the instance buffer, y sorting is stable', () => {
  const s = new Sprite({ x: 2.4, y: 1, alpha: 0.5 });
  assert.equal(pickSprite([s], 0.2, 0.2, { atlas, camera: { x: 2, y: 1, zoom: 1 } }).sprite, s);
  assert.equal(pickSprite([s], 0.2, 0.2, { atlas, camera: { x: 2, y: 1, zoom: 1 }, snap: false }), undefined);
  assert.equal(pickSprite([s], 2.5, 2.5, { atlas, alphaThreshold: 65 }), undefined);
  const a = new Sprite({ y: 1 }),
    b = new Sprite({ y: 0 });
  b.index = 1;
  assert.equal(pickSprite([a, b], 0.5, 1.5, { atlas, mode: 'box' }).sprite, b);
  assert.equal(pickSprite([a, b], 0.5, 1.5, { atlas, mode: 'box', ySort: true }).sprite, a);
});
test('atlas pages, masks, zero scale and invalid input have explicit behaviour', () => {
  const s = new Sprite({ page: 1 });
  assert.equal(
    pickSprite([s], 1.5, 0.5, { atlas: [atlas, { ...atlas, data: new Uint8Array(16).fill(255) }] }).sprite,
    s,
  );
  s.page = 0;
  assert.equal(pickSprite([s], 0.5, 0.5, { atlas, mask: { rect: [1, 0, 1, 1] } }), undefined);
  assert.equal(pickSprite([s], 0.5, 0.5, { atlas, mask: { circle: [0, 0, 2], outside: true } }), undefined);
  assert.throws(() => pickSprite([s], 0.5, 0.5, { atlas: { width: 2, height: 2 } }), /RGBA8/);
  assert.equal(pickSprite([s], 0.5, 0.5, { atlas: { width: 2, height: 2 }, mode: 'box' }).sprite, s);
  s.scaleX = 0;
  assert.equal(pickSprite([s], 0.5, 0.5, { atlas }), undefined);
  assert.throws(() => pickSprite([], NaN, 0, { atlas }), RangeError);
  assert.throws(() => pickSprite([], 0, 0, { atlas, alphaThreshold: 256 }), RangeError);
});

test('fully transparent sprites need no CPU pixel data and let an underlying page be picked', () => {
  const back = new Sprite(),
    front = new Sprite({ page: 1, z: 1, alpha: 0 });
  const options = { atlas: [atlas, { width: 2, height: 2 }] };
  assert.equal(pickSprite([back, front], 0.5, 0.5, options).sprite, back);
  front.alpha = 0.001;
  assert.equal(pickSprite([back, front], 0.5, 0.5, options).sprite, back);
  assert.throws(() => pickSprite([], 0, 0, { atlas: [atlas, { width: 1, height: 1 }] }), /matching dimensions/);
  assert.throws(
    () => pickSprite([], 0, 0, { atlas: { width: 2, height: 2, data: new Array(16).fill(255) } }),
    RangeError,
  );
});
