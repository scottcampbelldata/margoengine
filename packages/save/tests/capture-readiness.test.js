import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the scene-state browser capture observes deferred GPU work before its final frame', async () => {
  const source = readFileSync(new URL('./browser/engine-check.mjs', import.meta.url), 'utf8');
  const match = /const picture = (async \(engine\) => \{[\s\S]*?\n    \});/.exec(source);
  assert.ok(match, 'exercise the real browser capture helper');
  const canvas = { version: 0 };
  let submitted = 0;
  let ready = false;
  const engine = {
    canvas,
    gpu: {
      queue: {
        onSubmittedWorkDone: async () => {
          canvas.version = submitted;
          ready = true;
        },
      },
    },
    render() {
      submitted++;
      if (ready) canvas.version = submitted;
    },
  };
  class Canvas {
    getContext() {
      let version;
      return {
        drawImage(bitmap) {
          version = bitmap.version;
        },
        getImageData() {
          return { data: new Uint8ClampedArray([version]) };
        },
      };
    }
  }
  const picture = new Function(
    'requestAnimationFrame',
    'createImageBitmap',
    'OffscreenCanvas',
    `return (${match[1]});`,
  )(
    (callback) => queueMicrotask(callback),
    async (image) => ({ version: image.version, close() {} }),
    Canvas,
  );
  assert.deepEqual(await picture(engine), new Uint8ClampedArray([2]));
});
