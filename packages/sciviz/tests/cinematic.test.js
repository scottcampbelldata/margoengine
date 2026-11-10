import assert from 'node:assert/strict';
import test from 'node:test';
import { CinematicVolume } from '../dist/cinematic.js';
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function fixture() {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, COPY_SRC: 4, MAP_READ: 8 };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2, COPY_SRC: 4 };
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  const resources = [],
    uploads = [];
  const resource = () => {
    const r = {
      destroyed: false,
      createView: () => ({}),
      destroy() {
        this.destroyed = true;
      },
    };
    resources.push(r);
    return r;
  };
  let source = resource(),
    transfer = resource();
  const renderer = {
    device: {
      createBuffer: resource,
      createTexture: resource,
      createBindGroupLayout: () => ({}),
      createBindGroup: () => ({}),
      createShaderModule: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      queue: {
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
    mode: 'composite',
    density: 1,
    quality: 2,
    dims: [8, 8, 8],
    model: identity(),
    clip: [],
    bounds: [0, 1, 0, 1, 0, 1],
    classificationUniforms: () => [0, 1, 1, 1, 1 / 7, 1 / 7, 1 / 7, 0],
    resources: () => ({ data: source, transfer, sampler: {} }),
    center: () => [0.5, 0.5, 0.5],
  };
  const context = {
    width: 64,
    height: 64,
    camera: { matrix: identity() },
    encoder: { beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }) },
  };
  return {
    renderer,
    volume,
    context,
    resources,
    uploads,
    replace() {
      transfer = resource();
    },
    replaceSource() {
      source = resource();
    },
  };
}
test('lighting options reject before hiding the volume or allocating resources', () => {
  for (const options of [
    { ambientOcclusion: { radius: -1 } },
    { ambientOcclusion: { directions: 65 } },
    { shadows: { steps: 0 } },
    { pathTracing: { anisotropy: 1 } },
    { pathTracing: { bounces: 0 } },
    { pathTracing: { samples: NaN } },
    { pathTracing: { seed: -1 } },
    { lightDirection: [0, 0, 0] },
    { ambient: [0, Infinity, 0] },
  ]) {
    const f = fixture(),
      count = f.resources.length;
    assert.throws(() => new CinematicVolume(f.renderer, f.volume, options), { name: 'RangeError' });
    assert.equal(f.volume.visible, true);
    assert.equal(f.resources.length, count);
  }
});
test('progressive image resets on camera, classifier, source, model, clips and resize; caps at samples', () => {
  const f = fixture(),
    options = { pathTracing: { samples: 3 } };
  const layer = new CinematicVolume(f.renderer, f.volume, options);
  assert.equal(f.volume.visible, false);
  options.pathTracing.samples = 1;
  for (let i = 0; i < 5; i++) layer.prepare(f.context);
  assert.equal(layer.samples, 3);
  const changes = [
    () => f.context.camera.matrix[12]++,
    () => f.replace(),
    () => f.replaceSource(),
    () => (f.volume.model[0] = 2),
    () => f.volume.clip.push({ normal: [1, 0, 0], offset: -0.2 }),
    () => (f.context.width = 128),
  ];
  for (const change of changes) {
    change();
    layer.prepare(f.context);
    assert.equal(layer.samples, 1);
    layer.prepare(f.context);
    assert.equal(layer.samples, 2);
  }
  assert.throws(() => layer.configure({ shadows: { steps: Infinity } }));
  assert.equal(layer.samples, 2);
  layer.configure({});
  layer.prepare(f.context);
  layer.prepare(f.context);
  assert.equal(layer.samples, 1);
  assert.deepEqual([...f.uploads.at(-1).slice(64, 68)], [0, 0, 0, 0]);
  assert.equal(f.uploads.at(-1)[71], 0);
  assert.equal(f.uploads.at(-1)[87], 0);
  layer.restore();
  assert.equal(layer.samples, 0);
  layer.dispose();
  layer.dispose();
  assert.equal(f.volume.visible, true);
  assert.ok(
    f.resources
      .slice(2)
      .filter((r) => r !== f.volume.resources().data && r !== f.volume.resources().transfer)
      .every((r) => r.destroyed),
  );
  assert.throws(() => layer.configure({}), /disposed/);
});

test('progressive sampling changes shader integration counts without changing source or lighting options', () => {
  const f = fixture();
  const layer = new CinematicVolume(f.renderer, f.volume, {
    ambientOcclusion: { directions: 8, steps: 12 },
    shadows: { steps: 32 },
    pathTracing: { samples: 64, bounces: 4 },
  });
  f.renderer.samplingScale = 0.25;
  layer.prepare(f.context);
  const reduced = f.uploads.at(-1);
  assert.equal(reduced[60], 0.5);
  assert.equal(reduced[63], 64, 'accumulation target retains its meaning');
  assert.equal(reduced[64], 2);
  assert.equal(reduced[66], 3);
  assert.equal(reduced[71], 8);
  assert.equal(reduced[74], 4, 'path bounce depth is unchanged');
  f.renderer.samplingScale = 1;
  layer.prepare(f.context);
  const refined = f.uploads.at(-1);
  assert.equal(refined[60], 2);
  assert.equal(refined[64], 8);
  assert.equal(refined[66], 12);
  assert.equal(refined[71], 32);
  assert.equal(f.volume.quality, 2);
  assert.equal(layer.samples, 1, 'incompatible sample history is discarded');
  layer.dispose();
});
