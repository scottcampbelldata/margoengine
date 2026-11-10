import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({
  startPath: '/packages/webgl2-compat/test/compute.html',
  port: 'free',
  compat: false,
});
try {
  const result = await context.page.evaluate(async () => {
    const { createCompatGPU } = await import('/packages/webgl2-compat/dist/device.js');
    const device = await (await createCompatGPU().requestAdapter()).requestDevice();
    const errors = [];
    device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const cases = [];
    try {
      for (const format of ['r8snorm', 'rg8snorm', 'rgba8snorm'])
        for (const dimension of ['2d', '2d-array', '3d']) {
          const channels = format === 'r8snorm' ? 1 : format === 'rg8snorm' ? 2 : 4;
          const w = 32,
            h = 16,
            layers = dimension === '2d' ? 1 : 2,
            depth = dimension === '2d' ? 1 : 4;
          const texture = device.createTexture({
            size: [w * 2, h * 2, depth],
            mipLevelCount: 2,
            dimension: dimension === '3d' ? '3d' : '2d',
            format,
            usage: 15,
          });
          const baseLayer = dimension === '2d-array' ? 1 : 0;
          const seed = new Int8Array(w * h * layers * channels).fill(-64);
          device.queue.writeTexture(
            { texture, mipLevel: 1, origin: [0, 0, baseLayer] },
            seed,
            { bytesPerRow: w * channels, rowsPerImage: h },
            [w, h, layers],
          );
          const values = new Float32Array(w * h * layers * 4);
          // Every signed code, both clamping directions, and nonintegral values on each side of zero.
          const probes = [-2, -1, -0.999, -0.503, -0.499, -0.1, 0, 0.1, 0.499, 0.503, 0.999, 1, 2];
          for (let i = 0; i < values.length; i++)
            values[i] = i < 1024 ? (((Math.floor(i / 4) + (i % 4)) % 256) - 128) / 127 : probes[i % probes.length];
          const input = device.createBuffer({ size: values.byteLength, usage: 136 });
          device.queue.writeBuffer(input, 0, values);
          const coords = dimension === '2d' ? 'vec2u(id.xy)' : dimension === '3d' ? 'id' : 'vec2u(id.xy), id.z';
          const shape = dimension.replace('-', '_');
          const code = `@group(0) @binding(0) var out: texture_storage_${shape}<${format}, write>;
          @group(0) @binding(1) var<storage, read> input: array<vec4f>;
          @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
            if (((id.z * ${h}u + id.y) * ${w}u + id.x) < 256u || (id.x + id.y) % 3u != 0u) { textureStore(out, ${coords}, input[(id.z * ${h}u + id.y) * ${w}u + id.x]); }
          }`;
          const pipeline = await device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
          });
          const view = texture.createView({
            dimension,
            baseMipLevel: 1,
            mipLevelCount: 1,
            ...(dimension === '2d-array' ? { baseArrayLayer: baseLayer, arrayLayerCount: layers } : {}),
          });
          const group = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: view },
              { binding: 1, resource: { buffer: input } },
            ],
          });
          const encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(w, h, layers);
          pass.end();
          const output = device.createBuffer({ size: 256 * h * layers, usage: 9 });
          encoder.copyTextureToBuffer(
            { texture, mipLevel: 1, origin: [0, 0, baseLayer] },
            { buffer: output, bytesPerRow: 256, rowsPerImage: h },
            [w, h, layers],
          );
          device.queue.submit([encoder.finish()]);
          await output.mapAsync(1);
          const bytes = new Int8Array(output.getMappedRange()),
            mismatches = [];
          for (let z = 0; z < layers; z++)
            for (let y = 0; y < h; y++)
              for (let x = 0; x < w; x++)
                for (let c = 0; c < channels; c++) {
                  const i = ((z * h + y) * w + x) * 4 + c;
                  const expected =
                    (z * h + y) * w + x < 256 || (x + y) % 3
                      ? Math.round(Math.max(-1, Math.min(1, values[i])) * 127)
                      : -64;
                  const got = bytes[(z * h + y) * 256 + x * channels + c];
                  if (got !== expected && mismatches.length < 8) mismatches.push({ x, y, z, c, got, expected });
                }
          cases.push({ format, dimension, tier: pipeline.built.tier, mismatches });
          output.unmap();
          output.destroy();
          input.destroy();
          texture.destroy();
        }
      await device.queue.onSubmittedWorkDone();
      return { cases, errors, gl: device.gl.getError() };
    } finally {
      device.destroy();
    }
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.gl, 0);
  assert.equal(result.cases.length, 9);
  for (const entry of result.cases) {
    assert.equal(entry.tier, 'cpu');
    assert.deepEqual(entry.mismatches, [], `${entry.format} ${entry.dimension}`);
  }
  console.log('SNORM storage: exact signed bytes, clamp, masked writes, mip and layer views, 9 cases');
} finally {
  await context.close();
}
