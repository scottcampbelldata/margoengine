// The video upload fallback materials, points and xr share (packages/shared/copy-external.js, Firefox d).
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyExternal, isVideoSource } from '../packages/shared/copy-external.js';

function withCanvas(run) {
  const drawn = [],
    Original = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      Object.assign(this, { width, height, canvas: true });
    }
    getContext() {
      return { drawImage: (source, x, y) => drawn.push([source, x, y]) };
    }
  };
  try {
    run(drawn);
  } finally {
    globalThis.OffscreenCanvas = Original;
  }
}

test('videos and VideoFrames are video sources; images and canvases are not', () => {
  assert.equal(isVideoSource({ videoWidth: 1 }), true);
  assert.equal(isVideoSource({ displayWidth: 1 }), true);
  for (const s of [{ width: 1 }, { naturalWidth: 1 }, null, undefined, 3]) assert.equal(isVideoSource(s), false);
});

test('a refused video goes through one canvas per source, the queue asked once; a same-size frame reuses it', () =>
  withCanvas((drawn) => {
    const copies = [];
    let asked = 0;
    const device = {
      queue: {
        copyExternalImageToTexture(info, destination, size) {
          if ('videoWidth' in info.source) {
            asked++;
            throw new TypeError('not a source');
          }
          copies.push([info, destination, size]);
        },
      },
    };
    const video = { videoWidth: 8, videoHeight: 4 };
    copyExternal(device, { source: video, flipY: true, origin: [1, 2] }, { texture: 't' }, [8, 4]);
    copyExternal(device, { source: video }, { texture: 't' }, [8, 4]);
    assert.equal(asked, 1);
    assert.equal(copies.length, 2);
    assert.equal(copies[0][0].source, copies[1][0].source, 'one canvas for the source');
    assert.deepEqual([copies[0][0].flipY, copies[0][0].origin, copies[0][2]], [true, [1, 2], [8, 4]]);
    assert.deepEqual(drawn, [
      [video, 0, 0],
      [video, 0, 0],
    ]);
    video.videoWidth = 16;
    copyExternal(device, { source: video }, { texture: 't' }, [16, 4]);
    assert.equal(copies[2][0].source.width, 16, 'a new size gets a new canvas');
  }));

test('a browser that takes videos copies them directly; other errors are thrown', () =>
  withCanvas((drawn) => {
    const copies = [],
      device = { queue: { copyExternalImageToTexture: (info) => copies.push(info.source) } },
      video = { videoWidth: 2, videoHeight: 2 };
    copyExternal(device, { source: video }, { texture: 't' }, [2, 2]);
    assert.deepEqual(copies, [video]);
    assert.deepEqual(drawn, []);
    const failing = {
      queue: {
        copyExternalImageToTexture() {
          throw new RangeError('validation');
        },
      },
    };
    assert.throws(() => copyExternal(failing, { source: video }, { texture: 't' }, [2, 2]), RangeError);
    const typeError = {
      queue: {
        copyExternalImageToTexture() {
          throw new TypeError('bad image');
        },
      },
    };
    assert.throws(() => copyExternal(typeError, { source: { width: 2, height: 2 } }, { texture: 't' }, [2, 2]), TypeError);
  }));
