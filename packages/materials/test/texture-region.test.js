// Texture.update(region): only the painted rectangle uploads, into the rows a full upload would use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Texture } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

function device() {
  const h = optionalGPU(),
    gpu = h.engine.gpu,
    uploads = [];
  gpu.limits.maxTextureDimension2D = 8192;
  // Skips the 1x1 default textures that mip generation creates.
  gpu.queue.writeTexture = (destination, data, layout, size) =>
    destination.texture.width > 1 && uploads.push({ destination, data, layout, size });
  gpu.queue.copyExternalImageToTexture = (source, destination, size) => uploads.push({ source, destination, size });
  gpu.queue.submit = () => {};
  let mips = 0;
  gpu.createCommandEncoder = () => ({
    beginRenderPass() {
      mips++;
      return { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
    },
    finish() {},
  });
  return { gpu, uploads, mips: () => mips };
}

test('a raw-data region writes only its rows at the same rows as the full upload, flipY or not', () => {
  for (const flipY of [false, true]) {
    const d = device(),
      data = new Uint8Array(4 * 4 * 4),
      texture = new Texture({ data, width: 4, height: 4 }, { flipY, mipmaps: false });
    texture.bind(d.gpu, true);
    assert.deepEqual(d.uploads[0].size, [4, 4]);
    const full = d.uploads[0].destination.texture;
    texture.update({ x: 1, y: 2, width: 2, height: 1 });
    texture.bind(d.gpu, true);
    assert.equal(d.uploads.length, 2);
    const { destination, layout, size } = d.uploads[1];
    assert.equal(destination.texture, full, 'same texture, so the same format and colour space');
    assert.deepEqual(destination.origin, [1, 2], 'data row 2 stays texture row 2');
    assert.deepEqual(layout, { offset: (2 * 4 + 1) * 4, bytesPerRow: 16 });
    assert.deepEqual(size, [2, 1]);
    assert.equal(d.mips(), 0, 'without mipmaps nothing else runs');
    texture.bind(d.gpu, true);
    assert.equal(d.uploads.length, 2, 'a region uploads once');
  }
});

test('an external-source region flips its destination rows with flipY and regenerates the mip chain', () => {
  const d = device(),
    canvas = { width: 8, height: 4 },
    flipped = new Texture(canvas),
    upright = new Texture(canvas, { flipY: false });
  flipped.bind(d.gpu, true);
  upright.bind(d.gpu, true);
  const before = d.mips();
  assert.equal(before, 6, 'three mip levels below 8x4 for each texture');
  flipped.update({ x: 2, y: 0, width: 3, height: 1 });
  upright.update({ x: 2, y: 0, width: 3, height: 1 });
  flipped.bind(d.gpu, true);
  upright.bind(d.gpu, true);
  const [a, b] = d.uploads.slice(2);
  assert.deepEqual([a.source.origin, a.source.flipY, a.destination.origin, a.size], [[2, 0], true, [2, 3], [3, 1]]);
  assert.deepEqual([b.source.origin, b.source.flipY, b.destination.origin], [[2, 0], false, [2, 0]]);
  assert.equal(d.mips() - before, 6, 'each region regenerates its whole chain');
});

test('regions between uses merge, a full update supersedes them, and bounds are checked', () => {
  const d = device(),
    texture = new Texture({ data: new Uint8Array(64 * 4), width: 8, height: 8 }, { mipmaps: false });
  texture.update({ x: 0, y: 0, width: 1, height: 1 }); // before the first upload: the full upload covers it
  texture.bind(d.gpu, false);
  texture.update({ x: 1, y: 1, width: 1, height: 1 });
  texture.update({ x: 5, y: 3, width: 2, height: 4 });
  texture.bind(d.gpu, false);
  assert.equal(d.uploads.length, 2);
  assert.deepEqual(
    [d.uploads[1].destination.origin, d.uploads[1].size],
    [
      [1, 1],
      [6, 6],
    ],
    'bounding rectangle',
  );
  texture.update({ x: 0, y: 0, width: 2, height: 2 });
  texture.update();
  texture.bind(d.gpu, false);
  assert.deepEqual(d.uploads[2].size, [8, 8], 'update() keeps the full re-upload');
  assert.equal(d.uploads[2].destination.origin, undefined);
  texture.bind(d.gpu, false);
  assert.equal(d.uploads.length, 3, 'the pending region was dropped by the full upload');
  for (const region of [
    { x: 7, y: 0, width: 2, height: 1 },
    { x: 0, y: -1, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0.5, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 1, height: Number.NaN },
  ])
    assert.throws(() => texture.update(region), RangeError);
  assert.throws(() => texture.update(null), TypeError);
  assert.throws(() => texture.update(4), TypeError);
});

test('a video the browser refuses as an upload source (Firefox: TypeError) is copied through a canvas, whole and by region', () => {
  const d = device(),
    drawn = [],
    OriginalCanvas = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      Object.assign(this, { width, height, canvas: true });
    }
    getContext() {
      return { drawImage: (source, x, y) => drawn.push([source, x, y]) };
    }
  };
  try {
    const refused = [],
      accepted = d.gpu.queue.copyExternalImageToTexture;
    d.gpu.queue.copyExternalImageToTexture = (info, destination, size) => {
      if ('videoWidth' in info.source) {
        refused.push(info.source);
        throw new TypeError("'source' member of GPUCopyExternalImageSourceInfo could not be converted");
      }
      accepted(info, destination, size);
    };
    const video = { videoWidth: 8, videoHeight: 4, readyState: 4, currentTime: 0 },
      texture = new Texture(video);
    texture.bind(d.gpu, true);
    assert.equal(refused.length, 1, 'the browser is asked once');
    assert.equal(d.uploads.length, 1);
    assert.equal(d.uploads[0].source.source.canvas, true, 'the frame arrives as a canvas');
    assert.deepEqual([d.uploads[0].source.source.width, d.uploads[0].source.source.height], [8, 4]);
    assert.deepEqual(drawn, [[video, 0, 0]]);
    texture.update({ x: 2, y: 0, width: 3, height: 1 });
    texture.bind(d.gpu, true);
    assert.equal(refused.length, 1, 'a queue that refused a video is not asked again');
    assert.equal(drawn.length, 2, 'every upload draws the current frame');
    assert.deepEqual(d.uploads.at(-1).source.origin, [2, 0]);
    // A TypeError for anything but a video source is still an error.
    const image = new Texture({ width: 4, height: 4, naturalWidth: 4, naturalHeight: 4 });
    d.gpu.queue.copyExternalImageToTexture = () => {
      throw new TypeError('bad');
    };
    assert.throws(() => image.bind(d.gpu, true), TypeError);
  } finally {
    globalThis.OffscreenCanvas = OriginalCanvas;
  }
});
