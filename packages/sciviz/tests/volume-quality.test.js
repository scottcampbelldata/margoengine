import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { QualityVolume } from '../dist/volume-quality.js';
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function fixture() {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 };
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  const resources = [],
    textures = [],
    uploads = [];
  const resource = (desc) => {
    const r = {
      desc,
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      createView() {
        return {};
      },
    };
    resources.push(r);
    return r;
  };
  const data = resource({}),
    transfer = resource({});
  const renderer = {
    device: {
      limits: { maxTextureDimension2D: 8192 },
      createBuffer: resource,
      createTexture: resource,
      createBindGroupLayout: () => ({}),
      createBindGroup: () => ({}),
      createShaderModule: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      queue: {
        writeTexture(target, values) {
          textures.push({ format: target.texture.desc.format, values: values.slice() });
        },
        writeBuffer(_b, _o, v) {
          uploads.push(v.slice());
        },
      },
    },
    remove() {},
  };
  const volume = {
    visible: true,
    valid: true,
    density: 1,
    quality: 2,
    mode: 'composite',
    range: [0, 10],
    dims: [2, 2, 2],
    bounds: [0, 1, 0, 1, 0, 1],
    clip: [],
    model: identity(),
    resources: () => ({ data, transfer, sampler: {} }),
    classificationUniforms: () => [1, 1, 1, 1, 1, 1, 1, 0],
    classificationData: () => ({
      size: [2, 2],
      rgba: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    }),
    center: () => [0.5, 0.5, 0.5],
  };
  const context = {
    encoder: { beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }) },
  };
  return { renderer, volume, context, resources, textures, uploads };
}
test('quality validation precedes allocation and publication; options snapshot and atomic configure', () => {
  for (const options of [
    { blockSize: 1 },
    { blockSize: 33 },
    { refinement: 2 },
    { isovalue: 11 },
    { isovalue: NaN },
    { color: [1, 0, 2] },
    { adaptive: { maxStep: Infinity } },
    { adaptive: { tolerance: 0 } },
  ]) {
    const f = fixture();
    assert.throws(() => new QualityVolume(f.renderer, f.volume, options), RangeError);
    assert.equal(f.resources.length, 2);
    assert.equal(f.volume.visible, true);
  }
  const f = fixture(),
    options = { adaptive: { maxStep: 3 }, isovalue: 4 };
  const layer = new QualityVolume(f.renderer, f.volume, options);
  options.adaptive.maxStep = 15;
  layer.prepare(f.context);
  assert.equal(f.uploads.at(-1)[84], 3);
  assert.ok(Math.abs(f.uploads.at(-1)[82] - 0.4) < 1e-6);
  assert.throws(() => layer.configure({ isovalue: 20 }));
  layer.prepare(f.context);
  assert.equal(f.uploads.at(-1)[84], 3);
  layer.restore();
  layer.prepare(f.context);
  layer.dispose();
  assert.equal(f.volume.visible, true);
  assert.ok(f.resources.slice(2).every((r) => r.destroyed));
});
test('empty-space envelope includes interpolated opacity between sparse classifier samples and every gradient row', () => {
  const f = fixture(),
    layer = new QualityVolume(f.renderer, f.volume);
  layer.prepare(f.context);
  const bounds = f.textures.find((t) => t.format === 'r8unorm').values;
  // An alpha-1 left endpoint and alpha-0 right endpoint produce nonzero alpha everywhere except the right edge.
  assert.equal(bounds[128 * 256 + 128], 255);
  assert.equal(bounds[200 * 256 + 100], 255);
  layer.dispose();
});
test('the generated jitter is a complete permutation with suppressed low spatial frequencies', () => {
  const source = readFileSync(new URL('../src/volume-blue-noise.ts', import.meta.url), 'utf8');
  const values = JSON.parse(source.slice(source.indexOf('['), source.lastIndexOf(']') + 1).replace(/,\s*]/, ']'));
  assert.deepEqual(
    values.slice().sort((a, b) => a - b),
    Array.from({ length: 1024 }, (_, i) => i),
  );
  const power = (fx, fy) => {
    let re = 0,
      im = 0;
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const a = (2 * Math.PI * (fx * x + fy * y)) / 32,
          v = (values[y * 32 + x] + 0.5) / 1024 - 0.5;
        re += v * Math.cos(a);
        im += v * Math.sin(a);
      }
    return re * re + im * im;
  };
  let low = 0,
    high = 0,
    count = 0;
  for (let y = -2; y <= 2; y++)
    for (let x = -2; x <= 2; x++)
      if (x || y) {
        low += power(x, y);
        high += power(x + 10, y + 10);
        count++;
      }
  assert.ok(low < high * 0.1, `low/high spectrum ${(low / high).toFixed(5)} over ${count} modes`);
});
