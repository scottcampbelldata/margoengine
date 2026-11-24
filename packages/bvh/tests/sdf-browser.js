// Real GPU check of @margoengine/bvh/sdf, run by bvh-browser.js: a shader samples the uploaded field with a linear sampler
// and must read what the CPU field reads.
import { MeshBVH } from '@margoengine/bvh';
import { bakeSDF } from '@margoengine/bvh/sdf';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const SAMPLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var field: texture_3d<f32>;
@group(0) @binding(1) var linear: sampler;
@group(0) @binding(2) var<storage, read> points: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> values: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&values)) { return; }
  values[id.x] = textureSampleLevel(field, linear, points[id.x].xyz, 0.0).r;
}
`;

function sphere(segments, rings) {
  const positions = [],
    indices = [];
  for (let r = 0; r <= rings; r++)
    for (let s = 0; s <= segments; s++) {
      const phi = (Math.PI * r) / rings,
        theta = (2 * Math.PI * (s % segments)) / segments;
      positions.push(Math.sin(phi) * Math.cos(theta), Math.cos(phi), -Math.sin(phi) * Math.sin(theta));
    }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s,
        b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return { positions, indices };
}

/** Pushes one line into `report.checks`. */
export async function sdfChecks(report) {
  const adapter = await navigator.gpu.requestAdapter();
  assert(adapter, 'no WebGPU adapter');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const sdf = bakeSDF(MeshBVH.build(sphere(32, 24)), { resolution: 20 }),
    texture = sdf.toTexture(device),
    count = 256,
    points = new Float32Array(count * 4),
    expected = [];
  for (let i = 0; i < count; i++) {
    // A sampler reads texel centres and samples sit on grid corners, so inside the grid uvw is (0.5 + cell) / size.
    const share = [((i * 37) % 256) / 256, ((i * 101) % 256) / 256, ((i * 59) % 256) / 256],
      uvw = share.map((value, k) => (0.5 + value * (sdf.size[k] - 1)) / sdf.size[k]),
      world = share.map((value, k) => sdf.min[k] + value * (sdf.max[k] - sdf.min[k]));
    points.set(uvw, i * 4);
    expected.push(sdf.distance(world));
  }
  const input = device.createBuffer({ size: points.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    output = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    read = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: SAMPLE_WGSL }), entryPoint: 'main' },
    }),
    group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
        { binding: 2, resource: { buffer: input } },
        { binding: 3, resource: { buffer: output } },
      ],
    }),
    encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass();
  device.queue.writeBuffer(input, 0, points);
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(count / 64);
  pass.end();
  encoder.copyBufferToBuffer(output, 0, read, 0, count * 4);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const values = new Float32Array(read.getMappedRange().slice(0));
  let worst = 0;
  values.forEach((value, i) => (worst = Math.max(worst, Math.abs(value - expected[i]))));
  const scoped = await device.popErrorScope();
  assert(!scoped, `validation: ${scoped?.message}`);
  // Half floats keep about 0.001 at these sizes, and hardware filtering holds 8 bits of weight.
  assert(worst < 0.02, `worst difference ${worst}`);
  report.checks.push(`sdf: ${count} samples through a linear sampler match the CPU field within ${worst.toFixed(4)}`);
  texture.destroy();
  device.destroy();
  return true;
}
