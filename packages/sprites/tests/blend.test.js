import assert from 'node:assert/strict';
import test from 'node:test';
import { BlendLayer, BlendSprite, blendBatches } from '../dist/blend.js';
test('mode runs batch adjacent sprites and preserve z, y and insertion order', () => {
  const a = new BlendSprite({ blendMode: 'screen' }),
    b = new BlendSprite({ blendMode: 'screen' }),
    c = new BlendSprite({ blendMode: 'add', z: 1 });
  a.index = 0;
  b.index = 1;
  c.index = 2;
  assert.deepEqual(blendBatches([c, b, a]), [
    { mode: 'screen', first: 0, count: 2 },
    { mode: 'add', first: 2, count: 1 },
  ]);
  b.blendMode = 'normal';
  assert.equal(blendBatches([a, b, c]).length, 3);
  b.visible = false;
  assert.deepEqual(blendBatches([a, b, c]), [
    { mode: 'screen', first: 0, count: 1 },
    { mode: 'add', first: 1, count: 1 },
  ]);
  assert.throws(() => new BlendSprite({ blendMode: 'other' }), RangeError);
});
test('blend mode mutation retains sprite identity and layer ownership', () => {
  assert.throws(() => new BlendLayer(), /SpriteLayer needs an atlas.*errors#sprite-options/);
  const layer = new BlendLayer({ atlas: { width: 1, height: 1, data: new Uint8Array(4) } }),
    s = layer.addBlend({ blendMode: 'multiply' });
  assert.equal(s.blendMode, 'multiply');
  s.blendMode = 'screen';
  assert.equal(layer.sprites[0], s);
  assert.throws(() => new BlendLayer({ atlas: { width: 1, height: 1, data: new Uint8Array(4) } }).addBlend(s), {
    code: 'attached',
  });
  layer.dispose();
  assert.equal(s.owner, undefined);
  assert.throws(() => layer.addBlend(), { code: 'disposed' });
});
