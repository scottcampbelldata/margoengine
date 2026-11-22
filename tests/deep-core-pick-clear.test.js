// Regression (KB-FX273, 2026-11-15): Firefox 157 clears an integer render target through float32, so core's pick pass,
// which cleared its r32uint id target to 4294967295 for "no mesh", read back 0 (mesh 0) on every empty pixel. The
// pick pass now clears to 0 and writes each id one up. This runs the real GPURenderer.pick on a fake device that clears
// as Firefox does, and checks the shader writes the id one up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GPURenderer } from '../packages/core/dist/renderer.js';
import { FrameGraph } from '../packages/core/dist/plugin.js';
import { Camera } from '../packages/core/dist/camera.js';
import { box } from '../packages/core/dist/geometry.js';

/** A renderer whose pick target holds what a Firefox-style clear leaves, or `drawn` when a mesh covers the pixel. */
function firefoxRenderer(drawn) {
  let target = null;
  const codes = [],
    clears = [],
    pass = new Proxy(
      {},
      { get: (_, key) => (key === 'drawIndexed' ? () => drawn !== null && (target = drawn) : () => {}) },
    ),
    pipeline = { getBindGroupLayout: () => ({}) },
    device = {
      createShaderModule: (d) => (codes.push(d.code), {}),
      createRenderPipeline: () => pipeline,
      createBindGroup: () => ({}),
      createTexture: () => ({ createView: () => ({}), destroy() {} }),
      createBuffer: () => ({
        destroy() {},
        async mapAsync() {},
        getMappedRange: () => new Uint32Array([target]).buffer,
        unmap() {},
      }),
      lost: new Promise(() => {}),
      addEventListener() {},
      destroy() {},
      features: new Set(),
      limits: { maxBufferSize: 1 << 30 },
      queue: { writeBuffer() {}, submit() {} },
      createCommandEncoder: () => ({
        finish: () => ({}),
        beginRenderPass(d) {
          const clear = d.colorAttachments?.[0]?.clearValue;
          if (clear) {
            clears.push(clear[0]);
            // float32, then a cast to u32 that wraps: Firefox 157 read 4294967295 back as 0 (browser matrix, batch 273).
            const f = Math.fround(clear[0]);
            target = f >= 2 ** 32 ? f - 2 ** 32 : f;
          }
          return pass;
        },
        copyTextureToBuffer() {},
      }),
    },
    renderer = new GPURenderer(
      { width: 4, height: 4 },
      device,
      { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) },
      'bgra8unorm',
      pipeline,
      { multisample: { count: 1 }, depthStencil: { format: 'depth32float' }, vertex: {}, fragment: {} },
      pipeline,
    );
  return { renderer, codes, clears };
}

const light = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array(4) };

test('a pick over no mesh is null where integer clears go through float32', async () => {
  const geometry = box(),
    batch = { geometry, instances: new Float32Array(48), count: 1, mask: 1 },
    empty = firefoxRenderer(null);
  empty.renderer.add(geometry, 1);
  assert.equal(await empty.renderer.pick(new Camera(), light, [batch], new FrameGraph(), 1, 1), null);
  // The clear survives float32 exactly, whatever the browser does with it.
  assert.ok(
    empty.clears.every((v) => Math.fround(v) === v && v < 2 ** 24),
    `pick clears ${empty.clears}`,
  );
  // The pick shader writes the id one up, so mesh 0 reads 1 and the clear of 0 means none.
  assert.match(
    empty.codes.find((c) => c.includes('o.id=')),
    /o\.id=u32\(i\.factors\.w\)\+1u;/,
  );
  const covered = firefoxRenderer(1);
  covered.renderer.add(geometry, 1);
  assert.equal(
    await covered.renderer.pick(new Camera(), light, [batch], new FrameGraph(), 1, 1),
    0,
    'mesh 0 under the pixel',
  );
});
