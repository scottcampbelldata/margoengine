import test from 'node:test';
import assert from 'node:assert/strict';
import { ImagePost } from '@margoengine/post/image';
import * as post from '@margoengine/post';

test('@margoengine/post/image exposes the same ImagePost as the package index', () => {
  assert.equal(ImagePost, post.ImagePost);
});

test('ImagePost keeps a defensive options snapshot and validates updates without a GPU', () => {
  const effect = new ImagePost({ toneMapping: 'agx', exposure: 1, bloom: { strength: 0.5 } });
  const snapshot = effect.options;
  snapshot.exposure = 9;
  snapshot.bloom.strength = 4;
  assert.deepEqual(effect.options, { toneMapping: 'agx', exposure: 1, bloom: { strength: 0.5 } });
  assert.throws(() => effect.setOptions({ exposure: 21 }), RangeError);
  assert.throws(() => effect.setOptions({ toneMapping: 'filmic' }), TypeError);
  assert.equal(effect.options.exposure, 1, 'a rejected update keeps the active preset');
  effect.setOptions({ gamma: 2, bloom: { radius: 0.2 } });
  assert.deepEqual(effect.options, { gamma: 2, bloom: { radius: 0.2 } });
});

test('ImagePost refuses to export before it is attached and after it is disposed', async () => {
  const effect = new ImagePost();
  const image = { width: 1, height: 1, data: new Float32Array(4) };
  await assert.rejects(() => effect.renderImage(image), { name: 'MargoError', code: 'unsupported' });
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(() => effect.renderImage(image, { signal: controller.signal }), /stop/);
  effect.dispose();
  effect.dispose();
  await assert.rejects(() => effect.renderImage(image), { name: 'MargoError', code: 'disposed' });
  assert.throws(() => effect.setOptions({}), { name: 'MargoError', code: 'disposed' });
});
