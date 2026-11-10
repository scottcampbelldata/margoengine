import test from 'node:test';
import assert from 'node:assert/strict';
import { CompatBindGroupLayout, CompatPipelineLayout, CompatDevice } from '../dist/device.js';
import { checkWGSL } from '../dist/wgsl.js';

const limits = {
  maxBindGroups: 4,
  maxUniformBuffersPerShaderStage: 12,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
};
const shader = (n) => ({ ir: checkWGSL(`
  ${Array.from({ length: n }, (_, i) => `@group(${i % 2}) @binding(${i}) var<storage, read> b${i}: array<u32>;`).join('\n')}
  @compute @workgroup_size(1) fn main() { let sum = ${Array.from({ length: n }, (_, i) => `b${i}[0]`).join(' + ')}; }
`) });
const device = () => ({ limits, errors: [], loadCompute: async () => {}, validationError(message) { this.errors.push(message); } });
const pipeline = (d, descriptor) => CompatDevice.prototype.createComputePipeline.call(d, descriptor);

test('automatic compute layouts enforce the advertised storage limit across groups and recover', () => {
  const d = device();
  const invalid = pipeline(d, { layout: 'auto', compute: { module: shader(9) } });
  assert.match(invalid.failure, /9 bindings exceed maxStorageBuffersPerShaderStage \(8\)/);
  assert.deepEqual(d.errors, [invalid.failure]);
  assert.equal(invalid.ready(), false, 'invalid pipelines never reach any compute route');
  const valid = pipeline(d, { layout: 'auto', compute: { module: shader(8) } });
  assert.equal(valid.failure, null);
  assert.equal(d.errors.length, 1);
});

test('explicit compute layouts count unused visible bindings, every resource kind and sparse group indices', () => {
  const resources = {
    maxStorageBuffersPerShaderStage: { buffer: { type: 'read-only-storage' } },
    maxUniformBuffersPerShaderStage: { buffer: {} },
    maxStorageTexturesPerShaderStage: { storageTexture: { format: 'rgba8unorm' } },
    maxSampledTexturesPerShaderStage: { texture: {} },
    maxSamplersPerShaderStage: { sampler: {} },
  };
  for (const [name, resource] of Object.entries(resources)) {
    for (const extra of [0, 1]) {
      const d = device(), n = limits[name] + extra;
      const entries = Array.from({ length: n }, (_, binding) => ({ binding, visibility: 4, ...resource }));
      // Non-compute bindings do not consume the compute stage's slots.
      entries.push(...Array.from({ length: 3 }, (_, i) => ({ binding: n + i, visibility: 3, ...resource })));
      const layout = new CompatPipelineLayout({ bindGroupLayouts: [
        new CompatBindGroupLayout({ entries: entries.slice(0, 2) }),
        new CompatBindGroupLayout({ entries: entries.slice(2) }),
      ] });
      const p = pipeline(d, { layout, compute: { module: shader(1) } });
      if (extra) assert.match(p.failure, new RegExp(name));
      else assert.equal(p.failure, null, name);
    }
  }
  const p = pipeline(device(), {
    layout: new CompatPipelineLayout({ bindGroupLayouts: [null, null, null, null, new CompatBindGroupLayout({ entries: [] })] }),
    compute: { module: shader(1) },
  });
  assert.match(p.failure, /maxBindGroups/);
});

test('external textures consume four texture, one sampler and one uniform slot', () => {
  const d = device(), entries = Array.from({ length: 5 }, (_, binding) => ({ binding, visibility: 4, externalTexture: {} }));
  const layout = new CompatPipelineLayout({ bindGroupLayouts: [new CompatBindGroupLayout({ entries })] });
  const p = pipeline(d, { layout, compute: { module: shader(1) } });
  assert.match(p.failure, /20 bindings exceed maxSampledTexturesPerShaderStage/);
});

test('asynchronous creation rejects an invalid pipeline without building it', async () => {
  let builds = 0;
  const d = { ...device(), loadCompute: async () => {}, computeRuntime: { build() { builds++; return {}; } } };
  await assert.rejects(CompatDevice.prototype.createComputePipelineAsync.call(d, {
    layout: 'auto', compute: { module: shader(9) },
  }), { name: 'GPUPipelineError', reason: 'validation' });
  assert.equal(builds, 0);
  const good = await CompatDevice.prototype.createComputePipelineAsync.call(d, {
    layout: 'auto', compute: { module: shader(8) },
  });
  assert.equal(good.failure, null);
  assert.equal(builds, 1);
});

test('asynchronous render validation preserves GPUPipelineError instead of assigning a read-only name', async () => {
  const d = { ...device(), gl: {}, ext: { indexed: {} }, enum: () => 0 };
  await assert.rejects(CompatDevice.prototype.createRenderPipelineAsync.call(d, {
    layout: 'auto', vertex: { module: { error: new Error('invalid module') } },
  }), { name: 'GPUPipelineError', reason: 'validation' });
  assert.equal(d.errors.length, 1);
});
