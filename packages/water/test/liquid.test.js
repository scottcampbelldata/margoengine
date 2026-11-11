import test from 'node:test';
import assert from 'node:assert/strict';
import { ParticleLiquid, MAX_LIQUID_PARTICLES } from '../dist/liquid.js';
import { narrowRangeFilter, narrowRangePass } from './liquid-reference.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128, VERTEX: 32 };
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

test('ParticleLiquid validates its options and particle source before allocating GPU resources', () => {
  assert.throws(() => new ParticleLiquid(), { code: 'state' });
  assert.throws(() => new ParticleLiquid({}), { code: 'state' });
  assert.throws(() => new ParticleLiquid({ particles: {} }), { code: 'state' });
  assert.throws(
    () => new ParticleLiquid({ particles: { positions: {} } }),
    { code: 'state' },
    'GPU source needs count',
  );
  for (const [key, values] of Object.entries({
    radius: [0, 0.0009, 101, NaN],
    ior: [0.99, 3.01],
    smoothing: [0, 101],
    maxFilterRadius: [0, 65, 2.5],
    filterRange: [0, -1, Infinity],
    thicknessScale: [-1, 1001],
    shininess: [0, 100001],
    resolutionScale: [0.25, 2],
    absorption: [[-1, 0, 0], [0, 0], [0, NaN, 0], [101, 0, 0], 'blue'],
    color: [[11, 0, 0]],
    skyHorizon: [[0, 0, 101]],
    skyZenith: [[0, -1, 0]],
  }))
    for (const value of values)
      assert.throws(
        () => new ParticleLiquid({ particles: { positions }, [key]: value }),
        RangeError,
        `${key}: ${value}`,
      );
  assert.throws(() => new ParticleLiquid({ particles: { positions }, radius: 0.1, filterClamp: 1.01 }), RangeError);
  assert.throws(() => new ParticleLiquid({ particles: { positions, stride: 2 } }), RangeError);
  assert.throws(() => new ParticleLiquid({ particles: { positions, count: 4 } }), RangeError, 'count past the array');
  assert.throws(
    () => new ParticleLiquid({ particles: { positions: {}, count: MAX_LIQUID_PARTICLES + 1 } }),
    RangeError,
  );
  assert.throws(
    () => new ParticleLiquid({ particles: { positions: new Float32Array([0, NaN, 0]) } }),
    /particle 0 has a non-finite position/,
  );
  assert.throws(() => new ParticleLiquid({ particles: { positions }, enabled: 1 }), { code: 'state' });
  assert.throws(() => new ParticleLiquid({ particles: { positions }, environment: {} }), { code: 'state' });
  // Counts default to whole centres that fit after the offset.
  assert.equal(new ParticleLiquid({ particles: { positions } }).particleCount, 3);
  assert.equal(new ParticleLiquid({ particles: { positions, stride: 4 } }).particleCount, 2);
  assert.equal(new ParticleLiquid({ particles: { positions, offset: 3 } }).particleCount, 2);
  assert.equal(new ParticleLiquid({ particles: { positions: new Float32Array(2) } }).particleCount, 0);
});

test('ParticleLiquid joins one PostStack once and disposes idempotently', () => {
  const effect = new ParticleLiquid({ particles: { positions } });
  assert.throws(() => effect.setup({ gpu: {} }), { code: 'state' });
  assert.equal(effect.joinStack({}).kind, 'hdr');
  assert.throws(() => effect.joinStack({}), { code: 'attached' });
  assert.throws(() => effect.setup({}), { code: 'unsupported' });
  effect.dispose();
  effect.dispose();
  assert.throws(() => effect.joinStack({}), { code: 'disposed' });
  assert.throws(() => effect.update(), { code: 'disposed' });
});

// A recording stand-in for a WebGPU device: counts passes, draws, bind groups and uploaded bytes.
function fakeDevice() {
  const log = { passes: 0, draws: [], groups: 0, bytes: 0, buffers: 0, textures: 0 };
  let id = 0;
  const texture = (d) => ({
    ...d,
    width: d.size[0],
    height: d.size[1],
    id: id++,
    createView: () => ({ texture: d }),
    destroy() {},
  });
  const device = {
    log,
    createBuffer: (d) => (log.buffers++, { ...d, id: id++, destroy() {}, getMappedRange() {} }),
    createTexture: (d) => (log.textures++, texture(d)),
    createSampler: () => ({}),
    createShaderModule: (d) => d,
    createRenderPipeline: (d) => ({ ...d, getBindGroupLayout: () => ({}) }),
    createBindGroup: (d) => (log.groups++, d),
    queue: {
      writeBuffer: (buffer, offset, data, start = 0, size) => {
        log.bytes += (size ?? data.length - start) * (data.BYTES_PER_ELEMENT ?? 1);
      },
    },
  };
  const encoder = {
    beginRenderPass: () => (
      log.passes++,
      {
        setPipeline() {},
        setBindGroup() {},
        setViewport() {},
        setScissorRect() {},
        draw: (vertices, instances = 1) => log.draws.push([vertices, instances]),
        end() {},
      }
    ),
  };
  return { device, encoder };
}

const input = { input: true },
  output = { view: {}, format: 'rgba8unorm', multisample: { count: 1 }, hdr: false };
function frame(liquid, device, encoder, host) {
  const camera = {
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.01, -1, 0, 0, 1, 5]),
    position: [0, 0, 5],
    target: [0, 0, 0],
    fov: 60,
  };
  const stage = liquid.stage;
  stage.render({ backend: 'webgpu', device, encoder, camera, width: 64, height: 32 }, input, output);
  return host;
}

test('a steady ParticleLiquid frame records six passes and six draws, creates no bind group and uploads only its uniform', () => {
  const { device, encoder } = fakeDevice();
  const data = new Float32Array(3000);
  const liquid = new ParticleLiquid({ particles: { positions: data } });
  const host = { depthTexture: { createView: () => ({}) } };
  liquid.stage = liquid.joinStack(host);
  liquid.setup({
    gpu: device,
    sceneOf: () => undefined,
    lighting: { direction: [0, 1, 0, 1], radiance: [1, 1, 1], ambient: [0, 0, 0] },
  });
  device.log.bytes = 0;
  frame(liquid, device, encoder, host);
  assert.equal(device.log.passes, 6);
  assert.deepEqual(device.log.draws, [
    [6, 1000],
    [3, 1],
    [3, 1],
    [3, 1],
    [6, 1000],
    [3, 1],
  ]);
  assert.equal(device.log.groups, 6);
  assert.equal(device.log.bytes, 320 + 12000, 'first frame uploads the uniform and the centres');
  assert.deepEqual({ ...liquid.frameStats }, { passes: 6, draws: 6, bytes: 12320, particles: 1000, groups: 6 });
  Object.assign(device.log, { passes: 0, draws: [], groups: 0, bytes: 0, buffers: 0, textures: 0 });
  frame(liquid, device, encoder, host);
  assert.deepEqual(
    {
      passes: device.log.passes,
      groups: device.log.groups,
      bytes: device.log.bytes,
      buffers: device.log.buffers,
      textures: device.log.textures,
    },
    { passes: 6, groups: 0, bytes: 320, buffers: 0, textures: 0 },
  );
  liquid.update();
  frame(liquid, device, encoder, host);
  assert.equal(liquid.frameStats.bytes, 320 + 12000, 'update() uploads the centres once');
  liquid.update({ positions: data, count: 10 });
  frame(liquid, device, encoder, host);
  assert.equal(liquid.frameStats.bytes, 320 + 120);
  assert.equal(liquid.frameStats.particles, 10);
  liquid.options.enabled = false;
  device.log.passes = 0;
  frame(liquid, device, encoder, host);
  assert.equal(device.log.passes, 1, 'disabled: only the pass-through composite');
  assert.deepEqual({ ...liquid.frameStats }, { passes: 1, draws: 1, bytes: 320, particles: 0, groups: 0 });
  liquid.dispose();
});

test('a GPU particle source is bound as it stands and checked against its count', () => {
  const { device, encoder } = fakeDevice();
  const buffer = device.createBuffer({ size: 16 * 100 });
  const liquid = new ParticleLiquid({ particles: { positions: { buffer }, count: 100, stride: 4 } });
  const host = { depthTexture: { createView: () => ({}) } };
  liquid.stage = liquid.joinStack(host);
  liquid.setup({
    gpu: device,
    sceneOf: () => undefined,
    lighting: { direction: [0, 1, 0, 1], radiance: [1, 1, 1], ambient: [0, 0, 0] },
  });
  device.log.bytes = 0;
  frame(liquid, device, encoder, host);
  assert.equal(liquid.frameStats.bytes, 320, 'no copy of GPU-resident centres');
  liquid.update({ positions: buffer, count: 101, stride: 4 });
  assert.throws(() => frame(liquid, device, encoder, host), { code: 'state', message: /1600 bytes; 1612 are needed/ });
  liquid.dispose();
});

test('the narrow-range oracle keeps a flat surface flat, rounds a lone drop and never filters across a depth gap', () => {
  const p = { sigma: 0.1, delta: 0.5, mu: 0.05, maxRadius: 8, tanHalfFov: Math.tan(Math.PI / 6) };
  const w = 24,
    h = 16;
  const flat = new Float64Array(w * h).fill(3);
  const out = narrowRangeFilter(flat, w, h, p);
  for (let y = 4; y < h - 4; y++) for (let x = 6; x < w - 6; x++) assert.ok(Math.abs(out[y * w + x] - 3) < 1e-12);
  // Background at 5, a foreground block at 2: the block's edge curves back by at most mu, the background never moves
  // toward the block (bias correction).
  const scene = new Float64Array(w * h).fill(5);
  for (let y = 4; y < 12; y++) for (let x = 8; x < 16; x++) scene[y * w + x] = 2;
  const f = narrowRangePass(scene, w, h, [1, 0], p);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (scene[i] === 5) assert.equal(f[i], 5, `background ${x},${y}`);
      else assert.ok(f[i] >= 2 && f[i] <= 2 + p.mu, `foreground ${x},${y}: ${f[i]}`);
    }
  assert.ok(f[8 * w + 8] > 2, 'edge pixel bends away');
  assert.equal(f[8 * w + 3], 5);
  // Empty pixels stay empty.
  const gap = new Float64Array(w * h);
  gap[5 * w + 5] = 4;
  const g = narrowRangeFilter(gap, w, h, p);
  assert.equal(g.filter((v) => v !== 0).length, 1);
});
