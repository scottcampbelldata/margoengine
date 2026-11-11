// Regression (bug sweep L3a, 2026-11-11, found reading compute/runtime.ts): a CPU-run compute kernel publishes the texels
// it stored into a storage texture by one masked draw per written layer, from two scratch textures it fills a layer at
// a time. Their storage was made only while filling layer 0, which a kernel that writes no texel of layer 0 skips, so
// a kernel that stored only into layer 1 of an array uploaded into textures with no storage: GL refused the uploads
// (INVALID_OPERATION) and the stores never reached the texture. Now the storage is made with the first written layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loggingDevice } from './support/logging-gl.js';

test('a CPU kernel that writes only layer 1 of an array gives its scratch textures storage before uploading', async () => {
  const { gl, device } = await loggingDevice();
  const texture = device.createTexture({
    size: [4, 4, 2],
    format: 'rgba8unorm',
    usage: 0x08 | 0x04 | 0x01, // STORAGE_BINDING | TEXTURE_BINDING | COPY_SRC
  });
  const flags = device.createBuffer({ size: 16, usage: 0x80 | 0x04 }); // STORAGE | COPY_SRC
  // The storage-buffer write and the atomic keep the kernel off the fragment route, on the CPU.
  const module = device.createShaderModule({
    code: `@group(0) @binding(0) var t: texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(1) var<storage, read_write> b: array<atomic<u32>>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  textureStore(t, vec2u(id.xy), 1, vec4f(1.0, 0.5, 0.25, 1.0));
  atomicAdd(&b[0], 1u);
}`,
  });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: texture.createView({ dimension: '2d-array' }) },
      { binding: 1, resource: { buffer: flags } },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(4, 4);
  pass.end();
  const from = gl.calls.length;
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  const calls = gl.calls.slice(from);
  // Follow the texture bound at TEXTURE_2D: every texSubImage2D needs texStorage2D on that texture first.
  const stored = new Set();
  let bound = null,
    uploads = 0;
  for (const [name, ...args] of calls) {
    if (name === 'bindTexture' && args[0] === gl.TEXTURE_2D) bound = args[1];
    else if (name === 'texStorage2D' && args[0] === gl.TEXTURE_2D) stored.add(bound);
    else if (name === 'texSubImage2D' && args[0] === gl.TEXTURE_2D && args[6] !== gl.RGBA_INTEGER) {
      uploads++;
      assert.ok(stored.has(bound), 'an upload into a scratch texture with storage');
    }
  }
  assert.ok(uploads >= 2, `the kernel's layer 1 was published (${uploads} uploads)`);
  device.destroy();
});
