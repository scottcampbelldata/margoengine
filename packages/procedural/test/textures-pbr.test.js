import test from 'node:test';
import assert from 'node:assert/strict';
import { createPBRTextureBaker } from '../dist/textures-pbr.js';

function fixture() {
  const textures = [],
    buffers = [],
    dispatches = [],
    writes = [];
  let finish = () => {},
    pending = Promise.resolve(),
    lose;
  const device = {
    limits: { maxTextureDimension2D: 2048 },
    lost: new Promise((r) => (lose = r)),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createTexture: (desc) => {
      const t = {
        desc,
        destroyed: 0,
        destroy() {
          this.destroyed++;
        },
        createView(view) {
          return { texture: this, view };
        },
      };
      textures.push(t);
      return t;
    },
    createBuffer: (desc) => {
      const b = {
        desc,
        destroyed: 0,
        destroy() {
          this.destroyed++;
        },
      };
      buffers.push(b);
      return b;
    },
    createBindGroup: (d) => d,
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups(...d) {
          dispatches.push(d);
        },
        end() {},
      }),
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: (b, o, data) => writes.push(new Uint8Array(data.buffer ?? data).slice()),
      submit() {},
      onSubmittedWorkDone: () => pending,
    },
  };
  return {
    device,
    textures,
    buffers,
    dispatches,
    writes,
    lose: () => lose({}),
    hold() {
      pending = new Promise((r) => (finish = r));
    },
    release() {
      finish();
    },
  };
}
test('complete NPOT mip chain: four maps, independent per-pass uniforms and owned lifecycle', async () => {
  const f = fixture();
  using baker = await createPBRTextureBaker(f.device);
  const set = await baker.bake({ width: 63, height: 47, pattern: 'marble' });
  assert.equal(set.mipLevelCount, 6);
  assert.equal(set.width, 63);
  assert.equal(set.heightPixels, 47);
  assert.equal(f.dispatches.length, 1 + 4 * 5);
  assert.equal(f.buffers.length, 21);
  assert.ok(f.buffers.every((b) => b.destroyed === 1));
  assert.ok(f.textures.every((t) => t.desc.mipLevelCount === 6));
  assert.equal(new Uint32Array(f.writes[1].buffer)[0], 31);
  assert.equal(new Uint32Array(f.writes.at(-1).buffer)[0], 1);
  set.dispose();
  set.dispose();
  assert.ok(f.textures.every((t) => t.destroyed === 1));
  const retained = await baker.bake({ mipmaps: false });
  assert.equal(retained.mipLevelCount, 1);
  baker.dispose();
  assert.ok(f.textures.every((t) => t.destroyed === 1));
  await assert.rejects(baker.bake(), (e) => e.code === 'disposed');
});
test('all patterns, bounded options and pre-aborted calls', async () => {
  const f = fixture();
  using baker = await createPBRTextureBaker({ gpu: f.device });
  for (const pattern of [
    'noise',
    'bricks',
    'tiles',
    'wood',
    'rust',
    'marble',
    'cloud',
    'grass',
    'fire',
    'starfield',
    'road',
  ]) {
    const s = await baker.bake({ pattern, mipmaps: false });
    s.dispose();
  }
  const count = f.textures.length;
  for (const o of [
    null,
    { pattern: 'none' },
    { normalStrength: NaN },
    { heightScale: 2 },
    { roughness: -1 },
    { time: Infinity },
    { mipmaps: 1 },
    { repeat: [3, 3] },
    { width: 2049 },
    { signal: AbortSignal.abort('stop') },
  ])
    await assert.rejects(baker.bake(o));
  assert.equal(f.textures.length, count);
  await assert.rejects(createPBRTextureBaker({}), (e) => e.code === 'unsupported');
});
test('in-flight abort, dispose and device loss release incomplete outputs', async () => {
  for (const kind of ['abort', 'dispose', 'loss']) {
    const f = fixture();
    const baker = await createPBRTextureBaker(f.device),
      controller = new AbortController();
    f.hold();
    const result = baker.bake({ signal: controller.signal });
    if (kind === 'abort') controller.abort('cancelled');
    else if (kind === 'dispose') baker.dispose();
    else f.lose();
    await assert.rejects(result);
    assert.ok(f.textures.every((t) => t.destroyed === 1));
    assert.ok(f.buffers.every((b) => b.destroyed === 1));
    f.release();
    baker.dispose();
    if (kind === 'loss') await assert.rejects(baker.bake());
  }
});
test('concurrent bakes retain distinct uniform data and disposing one preserves the other', async () => {
  const f = fixture();
  using baker = await createPBRTextureBaker(f.device);
  const [a, b] = await Promise.all([baker.bake({ width: 32, seed: 1 }), baker.bake({ width: 64, seed: 2 })]);
  assert.notEqual(a.albedo, b.albedo);
  a.dispose();
  assert.equal(b.albedo.destroyed, 0);
  b.dispose();
});
