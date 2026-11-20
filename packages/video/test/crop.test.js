// KB-VIDEO-CROP1: Video drew the whole picture stretched into `rect`, with no source crop and no way to move the rect
// after construction. `source`, `setRect`, `setSource` and `objectFit` (CSS object-fit, W3C CSS Images Module Level 3,
// section 5.5) close it; crop-browser.mjs proves the pixels on a GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Video, objectFit } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const near = (got, want) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9, `${got} != ${want}`));

test('objectFit gives the rect and source CSS object-fit draws', () => {
  // A 2:1 picture into the left half of a square canvas (the row's repro).
  let f = objectFit('cover', [200, 100], [100, 100], [0, 0, 0.5, 1]);
  near(f.rect, [0, 0, 0.5, 1]);
  near(f.source, [0.375, 0, 0.25, 1]);
  f = objectFit('contain', [200, 100], [100, 100], [0, 0, 0.5, 1]);
  near(f.rect, [0, 0.375, 0.5, 0.25]);
  near(f.source, [0, 0, 1, 1]);
  f = objectFit('fill', [200, 100], [100, 100], [0.1, 0.2, 0.5, 0.5]);
  near(f.rect, [0.1, 0.2, 0.5, 0.5]);
  near(f.source, [0, 0, 1, 1]);
  // none: pixels 1:1, a 40 x 20 picture in a 100 x 100 box is centred whole; a 400 x 50 one is cropped to 100 wide.
  f = objectFit('none', [40, 20], [100, 100]);
  near(f.rect, [0.3, 0.4, 0.4, 0.2]);
  near(f.source, [0, 0, 1, 1]);
  f = objectFit('none', [400, 50], [100, 100]);
  near(f.rect, [0, 0.25, 1, 0.5]);
  near(f.source, [0.375, 0, 0.25, 1]);
  near(objectFit('scale-down', [40, 20], [100, 100]).rect, [0.3, 0.4, 0.4, 0.2]);
  near(objectFit('scale-down', [400, 50], [100, 100]).rect, objectFit('contain', [400, 50], [100, 100]).rect);
  assert.throws(() => objectFit('stretch', [1, 1], [1, 1]), RangeError);
  assert.throws(() => objectFit('cover', [0, 1], [1, 1]), RangeError);
});

test('source crops the picture and setRect / setSource move it on the next frame', () => {
  const h = optionalGPU(),
    dom = new JSDOM('<video></video>'),
    old = globalThis.HTMLVideoElement;
  globalThis.HTMLVideoElement = dom.window.HTMLVideoElement;
  try {
    const element = dom.window.document.querySelector('video');
    Object.defineProperties(element, { videoWidth: { value: 8 }, readyState: { value: 2 } });
    assert.throws(() => new Video(element, { source: [0.6, 0, 0.5, 1] }), RangeError);
    const video = new Video(element, { rect: [0, 0, 0.5, 1], source: [0, 0, 0.5, 1] });
    assert.deepEqual(video.rect, [0, 0, 0.5, 1]);
    assert.deepEqual(video.sourceRect, [0, 0, 0.5, 1]);
    h.engine.use(video);
    const uniform = () => [...new Float32Array(video['uniform'].data)];
    assert.deepEqual(uniform(), [0, 0, 0.5, 1, 0, 0, 0.5, 1]);
    video.setRect([0.5, 0, 0.5, 1]);
    video.setSource([0.5, 0, 0.5, 1]);
    assert.deepEqual(uniform(), [0.5, 0, 0.5, 1, 0.5, 0, 0.5, 1]);
    assert.throws(() => video.setRect([0.5, 0, 0.6, 1]), /setRect needs/);
    assert.deepEqual(video.rect, [0.5, 0, 0.5, 1], 'a refused rect changes nothing');
    video.dispose();
    assert.throws(() => video.setSource([0, 0, 1, 1]), { name: 'MargoError', code: 'disposed' });
  } finally {
    globalThis.HTMLVideoElement = old;
    dom.window.close();
  }
});
