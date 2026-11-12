// Regression (list 5 R6 row 26, Radeon 680M under ANGLE D3D11): a clear of a texture level or layer whose last write
// was a clear was lost (creative test:gpu:targets: cube level 2 face 4 read 0, 0, 0, 0 for its clear to 0, 0, 0, 1).
// The adapter probes once (src/device/fresh-clears.ts); where clears are lost, the colour subresources of float and
// normalized textures with more than one level or layer are cleared by draws. The GPU check is features-browser.mjs
// freshClears (two rounds of clears) and layerView (a zero draw inside a pass keeps the pass viewport).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompatGPU } from '../dist/device.js';
import { loggingContext } from './support/logging-gl.js';

const U = { COPY_SRC: 0x01, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

/** A logging stand-in whose readPixels answers as the probed driver does: level 0 keeps its clear, later levels not. */
function losingContext(lost = true) {
  const gl = loggingContext();
  let level = 0;
  return new Proxy(gl, {
    get(target, key) {
      if (key === 'framebufferTexture2D')
        return (...args) => {
          level = args[4];
          return target.framebufferTexture2D(...args);
        };
      if (key === 'readPixels')
        return (...args) => {
          target.readPixels(...args);
          args[6].set(level === 0 || !lost ? [0, 0, 0, 255] : [0, 0, 0, 0]);
        };
      return target[key];
    },
  });
}

async function device(gl) {
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  return { adapter, device: await adapter.requestDevice() };
}

const named = (calls, ...names) => calls.filter((c) => names.includes(c[0]));

test('a driver that loses those clears is found, and new colour levels and layers are drawn, not cleared, to zero', async () => {
  const gl = losingContext();
  const { adapter, device: d } = await device(gl);
  assert.equal(adapter.drawClears, true);
  const from = gl.calls.length;
  d.createTexture({
    size: [4, 4, 6],
    mipLevelCount: 3,
    format: 'rgba8unorm',
    usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING,
  });
  let calls = gl.calls.slice(from);
  assert.equal(named(calls, 'drawArrays').length, 18, 'one draw for each of 3 levels of 6 layers');
  assert.equal(named(calls, 'clearBufferfv').length, 0, 'no clear');
  // Viewports follow the level sizes.
  assert.deepEqual(
    [...new Set(named(calls, 'viewport').map((c) => c.slice(1).join(',')))],
    ['0,0,4,4', '0,0,2,2', '0,0,1,1'],
  );
  // Integer, depth and stencil formats keep their clears.
  const at = gl.calls.length;
  d.createTexture({ size: [4, 4], format: 'rgba8uint', usage: U.TEXTURE_BINDING });
  d.createTexture({ size: [4, 4], format: 'depth24plus-stencil8', usage: U.RENDER_ATTACHMENT });
  calls = gl.calls.slice(at);
  assert.equal(named(calls, 'drawArrays').length, 0);
  assert.equal(named(calls, 'clearBufferuiv').length, 1);
  assert.equal(named(calls, 'clearBufferfi').length, 1);
});

test('a driver whose clears land, or a context that reads nothing, keeps the clears', async () => {
  for (const gl of [losingContext(false), loggingContext()]) {
    const { adapter, device: d } = await device(gl);
    assert.equal(adapter.drawClears, false);
    const from = gl.calls.length;
    d.createTexture({ size: [4, 4], mipLevelCount: 3, format: 'rgba8unorm', usage: U.TEXTURE_BINDING });
    const calls = gl.calls.slice(from);
    assert.equal(named(calls, 'clearBufferfv').length, 3);
    assert.equal(named(calls, 'drawArrays').length, 0);
  }
});

test('render pass clears of a layer of a 6-layer texture are draws there; a single-level 2D target keeps clearBufferfv', async () => {
  const gl = losingContext();
  const { device: d } = await device(gl);
  const array = d.createTexture({
    size: [4, 4, 6],
    format: 'rgba8unorm',
    usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING,
  });
  const plain = d.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
  const pass = (view, clearValue) => {
    const e = d.createCommandEncoder();
    e.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue }] }).end();
    const from = gl.calls.length;
    d.queue.submit([e.finish()]);
    return gl.calls.slice(from);
  };
  let calls = pass(array.createView({ dimension: '2d', baseArrayLayer: 3, arrayLayerCount: 1 }), [0.25, 0.5, 0.75, 1]);
  assert.equal(named(calls, 'clearBufferfv').length, 0, 'no colour clear');
  assert.equal(named(calls, 'drawArrays').length, 1, 'one draw');
  assert.deepEqual(
    named(calls, 'uniform4f').map((c) => c.slice(2)),
    [[0.25, 0.5, 0.75, 1]],
    'the clear value',
  );
  calls = pass(plain.createView(), [1, 0, 0, 1]);
  assert.equal(named(calls, 'drawArrays').length, 0);
  assert.deepEqual(
    named(calls, 'clearBufferfv').map((c) => c.slice(3)),
    [[[1, 0, 0, 1]]],
  );
});
