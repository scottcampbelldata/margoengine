import assert from 'node:assert/strict';
import test from 'node:test';
import { SciRenderer } from '../dist/index.js';

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8, STORAGE: 128, VERTEX: 32, INDIRECT: 256 };
globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

const IDENTITY = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

function frameFor(view, matrix = IDENTITY) {
  const writes = [],
    device = {
      createBindGroupLayout: () => ({}),
      createBindGroup: () => ({}),
      createBuffer: ({ size }) => ({ size, destroy() {} }),
      queue: { writeBuffer: (_buffer, _offset, data) => writes.push(Float32Array.from(data)) },
    },
    renderer = new SciRenderer();
  let pass;
  renderer.setup({ gpu: device, removePlugin() {} });
  renderer.registerPasses({ add: (p) => (pass = p) });
  renderer.add({ transparent: false, visible: true, restore() {}, center: () => [0, 0, 0], draw() {}, dispose() {} });
  const encoder = { setViewport() {}, setScissorRect() {}, setBindGroup() {}, end() {} };
  try {
    pass.execute({
      backend: 'webgpu',
      camera: { matrix, position: [0, 0, 5] },
      width: 800,
      height: 600,
      format: 'bgra8unorm',
      descriptor: { depthStencil: { format: 'depth24plus' } },
      color: {},
      depth: {},
      encoder: { beginRenderPass: () => encoder },
      view,
    });
  } finally {
    renderer.dispose();
  }
  return writes.at(-1);
}

test('the frame uniform carries the size and origin of the view being drawn', { timeout: 1000 }, () => {
  const full = frameFor(undefined);
  assert.deepEqual([...full.subarray(36, 38)], [800, 600]);
  assert.deepEqual([...full.subarray(40, 42)], [0, 0]);
  const split = frameFor({ id: 'right', index: 1, viewport: [400, 100, 400, 300] });
  // Pixel-sized marks and @builtin(position) rays read the view's own pixels, not the whole target's.
  assert.deepEqual([...split.subarray(36, 38)], [400, 300]);
  assert.deepEqual([...split.subarray(40, 42)], [400, 100]);
});

test('a singular camera matrix rejects with a linked RangeError instead of drawing with a stale inverse', { timeout: 1000 }, () => {
  // A custom Camera.project that flattens depth: view rays cannot be rebuilt from it.
  const flat = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
  assert.throws(
    () => frameFor(undefined, flat),
    (error) => error instanceof RangeError && /invertible.*errors#sciviz/.test(error.message),
  );
  // The inverse written for a valid matrix is that matrix's own inverse.
  const scaled = frameFor(undefined, Float32Array.of(2, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1));
  assert.deepEqual([...scaled.subarray(16, 32)], [0.5, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
});
