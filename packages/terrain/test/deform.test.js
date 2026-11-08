import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainDeformation } from '../dist/deform.js';
import { Terrain } from '../dist/index.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const terrainOptions = (weights, layers = 5) => ({
  resolution: 8,
  levels: 2,
  size: [32, 32],
  layers: Array.from({ length: layers }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })),
  textures: (device) => {
    const texture = (format, count = 1) => device.createTexture({ size: [4, 4, count], format, usage: 4 });
    return {
      heightmap: texture('r32float'),
      layers: texture('rgba8unorm', layers),
      ...(weights ? { weights: [texture('rgba8unorm'), texture('rgba8unorm')] } : {}),
    };
  },
});
function rig(options = {}, weights = false, layers = 5) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
      stats: { drawCalls: 0 },
      removePlugin() {},
    },
    terrain = new Terrain(terrainOptions(weights, layers)),
    deformation = new TerrainDeformation(terrain, options);
  terrain.setup(engine);
  deformation.setup(engine);
  const run = passes(deformation),
    camera = { position: [0, 2, 0] },
    frame = (delta = 1 / 60) =>
      gpu.record(() => run({ backend: 'webgpu', device: gpu.device, encoder: gpu.encoder, camera, delta }));
  return { gpu, engine, terrain, deformation, frame, camera, lit: terrain.colorSource().code };
}
const named = (log, name) => log.filter((call) => call[0] === name);
const writes = (log) => named(log, 'writeBuffer').map((call) => Buffer.from(call[3], 'hex'));

test('options are checked', () => {
  const terrain = new Terrain(terrainOptions(false));
  for (const options of [
    { size: 63 },
    { size: 2049 },
    { size: 100.5 },
    { texel: 0 },
    { depth: -1 },
    { rim: 1.5 },
    { fade: -1 },
    { softness: 2 },
    { layers: [0.5, 2] },
    { layers: Array.from({ length: 6 }, () => 1) },
    { darken: -0.1 },
    { distance: 0 },
    { steps: 3 },
    { steps: 33 },
    { follow: [0, 0] },
  ])
    assert.throws(() => new TerrainDeformation(terrain, options), RangeError, JSON.stringify(options));
  assert.throws(() => new TerrainDeformation({}, {}), TypeError);
  const d = new TerrainDeformation(terrain, {});
  assert.deepEqual([d.size, d.texel, d.depth], [1024, 0.025, 0.15]);
  assert.throws(() => d.footprint(Number.NaN, 0), RangeError);
  assert.throws(() => d.footprint(0, 0, { length: 0 }), RangeError);
  assert.throws(() => d.footprint(0, 0, { width: 100 }), RangeError, 'wider than a print box');
  assert.throws(() => d.track([0, 0], [1, 1], { depth: -1 }), RangeError);
  assert.throws(() => d.trail('no'), RangeError);
});

test('the lit shader is wrapped: the fragment shades the shifted ground, the layer colour is darkened', () => {
  const r = rig(),
    code = r.deformation.shader(r.lit, 1);
  assert.equal(code.split('@fragment fn fragment(i:Output)->@location(0) vec4f {').length, 2, 'one entry point');
  assert.match(code, /@fragment fn fragment\(i:Output\)->@location\(0\) vec4f \{return terrainDeformInner\(terrainDeformShift\(i\)\);\}/);
  assert.match(code, /fn terrainDeformInner\(i:Output\)->vec4f \{/);
  assert.match(code, /return terrainColorUndeformed\(position,normal\)\*terrainDeformTint;/);
  assert.match(code, /@group\(1\) @binding\(99\) var<uniform> terrainDeform:TerrainDeformFrame;/);
  assert.match(code, /@group\(1\) @binding\(100\) var terrainDeformMap:texture_2d<f32>;/);
  assert.ok(!code.includes('terrainWeights0,terrainSampler,uv,0.0)'), 'no painted softness without weights');
  assert.equal(r.deformation.shader(r.lit, 1), code, 'cached');
  assert.throws(() => r.deformation.shader('fn nothing(){}', 1), /lit fragment shader/);
  const painted = rig({ layers: [1, 0] }, true),
    paintedCode = painted.deformation.shader(painted.lit, 1);
  assert.match(paintedCode, /textureSampleLevel\(terrainWeights1,terrainSampler,uv,0\.0\)/);
  assert.match(paintedCode, /soft\+=dot\(wv,terrainDeform\.softness\[1\]\);total\+=dot\(wv,terrainDeform\.layers\[1\]\);/);
});

test('the frame uniform holds the settings, per-layer softness and which layers exist', () => {
  const gpu = mockGPU(),
    engine = { gpu: gpu.device, removePlugin() {} },
    terrain = new Terrain(terrainOptions(true, 6)),
    deformation = new TerrainDeformation(terrain, { layers: [0, 0.5], softness: 0.75, rim: 0.5, depth: 0.2, steps: 8 });
  let frame;
  const log = gpu.record(() => deformation.setup(engine));
  for (const bytes of writes(log)) if (bytes.length === 176) frame = new Float32Array(bytes.buffer, bytes.byteOffset, 44);
  assert.deepEqual([...frame.slice(2, 4)], [25.6, 1024].map(Math.fround));
  assert.deepEqual([...frame.slice(4, 8)], [40, 8, 0.25, 0.2].map(Math.fround));
  assert.deepEqual([...frame.slice(8, 10)], [0.1, 0.75].map(Math.fround), 'rim top and default softness');
  assert.deepEqual([...frame.slice(12, 20)], [0, 0.5, 0.75, 0.75, 0.75, 0.75, 0, 0]);
  assert.deepEqual([...frame.slice(28, 36)], [1, 1, 1, 1, 1, 1, 0, 0], 'six layers exist');
  const [uniform, map] = deformation.bindings();
  assert.equal(uniform.binding, 99);
  assert.equal(map.binding, 100);
  deformation.dispose();
  assert.ok(uniform.resource.buffer.destroyed);
  assert.deepEqual(deformation.bindings(), []);
});

test('frames: the first clears, a still frame without fade does nothing, a move and prints dispatch their steps', () => {
  const r = rig({ fade: 0, size: 64, texel: 0.1 });
  const first = r.frame();
  assert.equal(named(first, 'pass.dispatchWorkgroups').length, 2, 'age (clear) and resolve');
  const [window] = writes(first).filter((b) => b.length === 48),
    ints = new Int32Array(window.buffer, window.byteOffset, 12),
    words = new Uint32Array(window.buffer, window.byteOffset, 12);
  assert.deepEqual([...ints.slice(0, 4)], [-32, -32, -32, -32], 'the window centres on the camera');
  assert.equal(words[4], 64);
  assert.equal(words[5], 1, 'first frame clears');
  assert.equal(named(r.frame(), 'pass.dispatchWorkgroups').length, 0, 'nothing changed');
  r.camera.position[0] = 0.25;
  const moved = r.frame(),
    [w2] = writes(moved).filter((b) => b.length === 48),
    i2 = new Int32Array(w2.buffer, w2.byteOffset, 12);
  assert.deepEqual([...i2.slice(0, 4)], [-30, -32, -32, -32], 'new origin, previous origin');
  assert.equal(new Uint32Array(w2.buffer, w2.byteOffset, 12)[5], 0);
  const centre = writes(moved).find((b) => b.length === 8);
  assert.deepEqual([...new Float32Array(centre.buffer.slice(centre.byteOffset, centre.byteOffset + 8))], [0.2, 0].map(Math.fround), 'the shader window centre follows');
  r.deformation.footprint(1, 2, { angle: Math.PI / 2, depth: 1 });
  r.deformation.track([0, 0], [3, 0]);
  assert.equal(r.deformation.pending, 2);
  const printed = r.frame(),
    calls = named(printed, 'pass.dispatchWorkgroups');
  assert.equal(calls.length, 2, 'stamp and resolve (no move, no fade)');
  assert.equal(calls[0][3], 2, 'one workgroup layer a print');
  assert.equal(r.deformation.pending, 0);
  const stamps = writes(printed).find((b) => b.length === 128),
    f = new Float32Array(stamps.buffer, stamps.byteOffset, 32),
    k = new Int32Array(stamps.buffer, stamps.byteOffset, 32);
  assert.deepEqual([f[0], f[1]], [0, Math.fround(0.15)], 'an ellipse, depth clamped to the deepest');
  assert.deepEqual([f[2], f[3]], [0.055, 0.14].map(Math.fround));
  assert.ok(Math.abs(f[8]) < 1e-6 && f[9] === 1, 'heading +Z');
  assert.deepEqual([k[12], k[13]], [Math.floor((1 - 0.238) / 0.1), Math.floor((2 - 0.238) / 0.1)]);
  assert.ok(Math.abs(f[4] - (1 - k[12] * 0.1)) < 1e-6, 'centre relative to its box');
  assert.equal(f[16], 1, 'a track');
  assert.deepEqual([k[28], k[29]], [-3, -3]);
  assert.ok(Math.abs(f[22] - (3 + 0.3)) < 1e-6, 'end relative to its box');
});

test('a long track is split into boxes no wider than a print box, fade runs every frame', () => {
  const r = rig({ fade: 10, size: 64, texel: 0.05 });
  r.frame();
  r.deformation.track([0, 0], [30, 0]);
  assert.equal(r.deformation.pending, 4);
  const log = r.frame(0.5),
    stamps = writes(log).find((b) => b.length === 4 * 64);
  assert.ok(stamps);
  const k = new Int32Array(stamps.buffer, stamps.byteOffset, stamps.length / 4);
  for (let i = 0; i < stamps.length / 64; i++) assert.ok(k[i * 16 + 14] <= 192 && k[i * 16 + 15] <= 192);
  const [window] = writes(log).filter((b) => b.length === 48);
  assert.equal(new Float32Array(window.buffer, window.byteOffset, 12)[6], Math.fround((0.15 * 0.5) / 10), 'depth refilled');
  assert.equal(named(r.frame(), 'pass.dispatchWorkgroups').length, 2, 'fading frames age and resolve');
  r.deformation.clear();
  const cleared = r.frame(),
    [w] = writes(cleared).filter((b) => b.length === 48);
  assert.equal(new Uint32Array(w.buffer, w.byteOffset, 12)[5], 1);
});

test('a map larger than the device allows is refused, and a WebGL engine', () => {
  const gpu = mockGPU();
  gpu.device.limits = { ...gpu.device.limits, maxTextureDimension2D: 256, maxStorageBufferBindingSize: 1 << 27 };
  const terrain = new Terrain(terrainOptions(false));
  assert.throws(() => new TerrainDeformation(terrain, {}).setup({ gpu: gpu.device }), /larger than this device/);
  assert.throws(() => new TerrainDeformation(terrain, {}).setup({}), /requires WebGPU/);
});
