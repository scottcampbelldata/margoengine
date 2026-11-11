import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../dist/extension.js';

// Before 2026-11-10 core capped the backbuffer at a fixed 4096 px a side, so a 5120 x 1440 canvas drew at 4096 x 1152
// and was stretched even on a device whose textures go to 8192 or 16384. The cap is now the device's
// maxTextureDimension2D (the canvas, MSAA and depth targets all share it), with the aspect kept when it applies.
async function backbuffer(clientWidth, clientHeight, maxTextureDimension2D) {
  const canvas = { width: 300, height: 150, clientWidth, clientHeight },
    renderer = {
      backend: 'webgl2',
      ...(maxTextureDimension2D ? { gpu: { limits: { maxTextureDimension2D } } } : {}),
      add() {},
      remove() {},
      dispose() {},
      render() {},
    };
  using engine = new Engine(canvas, await TransformStore.create(16), renderer);
  engine.render();
  return [canvas.width, canvas.height];
}

test("the backbuffer follows the device's largest 2D texture, keeping the aspect when it caps", async () => {
  assert.deepEqual(await backbuffer(5120, 1440, 8192), [5120, 1440]);
  assert.deepEqual(await backbuffer(1920, 1080, 8192), [1920, 1080]);
  assert.deepEqual(await backbuffer(10240, 1440, 8192), [8192, 1152]);
  assert.deepEqual(await backbuffer(1440, 10240, 8192), [1152, 8192]);
  assert.deepEqual(await backbuffer(20000, 2000, 16384), [16384, 1638]);
  // A fallback renderer with no WebGPU device keeps the documented 4096 cap.
  assert.deepEqual(await backbuffer(5120, 1440), [4096, 1152]);
});
