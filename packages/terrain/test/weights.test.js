// TerrainTextures.weights (biomes item 27.4, decision D4): 2 to 4 rgba8unorm textures replace the height and slope
// rules, one per 4 layers, up to 16 layers (biome look plan item 1: the biome view needs 15 for the 8 presets).
// Without them the terrain shader, layout and bind groups are unchanged; examples/package-benchmarks/proofs/
// terrain-ssr.proof.js records that whole GPU call sequence against its golden copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Terrain } from '../dist/index.js';

function rig(weights, count = 5) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
      stats: { drawCalls: 0 },
      removePlugin() {},
    };
  let made;
  const terrain = new Terrain({
    resolution: 8,
    levels: 2,
    size: [32, 32],
    layers: Array.from({ length: count }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })),
    textures: (device) => {
      const texture = (format, layers = 1) =>
        device.createTexture({ size: [4, 4, layers], format, usage: GPUTextureUsage.TEXTURE_BINDING });
      made = {
        heightmap: texture('r32float'),
        layers: texture('rgba8unorm', count),
        ...(weights ? { weights: weights(texture) } : {}),
      };
      return made;
    },
  });
  const log = gpu.record(() => terrain.setup(engine)),
    passes = [];
  terrain.registerPasses({ add: (p) => passes.push(p) });
  passes.sort((a, b) => a.order - b.order);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', shader: '' });
  const frame = () =>
    gpu.record(() => {
      view.begin(0);
      for (const p of passes) p.execute(view.c);
      view.end();
    });
  return { terrain, log, frame, made: () => made };
}
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);

test('weights textures replace the height and slope rules and bind at 6 and 7', () => {
  const r = rig((texture) => [texture('rgba8unorm'), texture('rgba8unorm')]),
    layout = r.log.find((e) => e[0] === 'layout')[2];
  assert.deepEqual(
    layout.entries.map((e) => e.binding),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  const groups = r.log.filter((e) => e[0] === 'group');
  assert.ok(groups.length > 0 && groups.every((g) => g[2].entries.length === 8));
  const code = modules(r.frame()).find((c) => c.includes('@fragment'));
  assert.match(code, /var terrainWeights0:texture_2d<f32>;/);
  assert.match(code, /@binding\(7\) var terrainWeights1:texture_2d<f32>;/);
  assert.doesNotMatch(code, /terrainWeights2/);
  assert.match(code, /let weight=packed\[layer\/4u\]\[layer%4u\];if\(weight<=0\.0\)\{continue;\}/);
  assert.doesNotMatch(code, /let weight=smoothstep/, 'the rule weights are gone');
  assert.equal(code.match(/fn terrainColor\(/g).length, 1, 'one terrainColor, the weighted one');
  const [a, b] = r.made().weights;
  r.terrain.dispose();
  assert.ok(a.destroyed && b.destroyed, 'the terrain owns and frees its weights textures');
});

test('without weights the shader and bindings stay as they were', () => {
  const r = rig(),
    layout = r.log.find((e) => e[0] === 'layout')[2];
  assert.deepEqual(
    layout.entries.map((e) => e.binding),
    [0, 1, 2, 3, 4, 5],
  );
  const code = modules(r.frame()).find((c) => c.includes('@fragment'));
  assert.doesNotMatch(code, /terrainWeight/);
  assert.match(code, /let weight=smoothstep/);
});

test('bad weights textures are rejected', () => {
  assert.throws(() => rig((texture) => [texture('rgba8unorm')]), TypeError);
  assert.throws(() => rig((texture) => [texture('r32float'), texture('rgba8unorm')]), TypeError);
  assert.throws(() => rig((texture) => [texture('rgba8unorm', 2), texture('rgba8unorm')]), TypeError);
});

test('16 layers take 4 weights textures bound at 6 to 9; 17 layers, too few textures or 5 textures are rejected', () => {
  const four = (texture) => [0, 1, 2, 3].map(() => texture('rgba8unorm')),
    r = rig(four, 16),
    layout = r.log.find((e) => e[0] === 'layout')[2];
  assert.deepEqual(
    layout.entries.map((e) => e.binding),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.ok(r.log.filter((e) => e[0] === 'group').every((g) => g[2].entries.length === 10));
  const code = modules(r.frame()).find((c) => c.includes('@fragment'));
  for (let i = 0; i < 4; i++)
    assert.match(code, new RegExp(`@binding\\(${6 + i}\\) var terrainWeights${i}:texture_2d<f32>;`));
  // Every texture is sampled once per fragment, before the layer loop, and indexed by layer.
  for (let i = 0; i < 4; i++)
    assert.equal(
      code.split(`textureSampleLevel(terrainWeights${i},terrainSampler,uv,0)`).length,
      2,
      `texture ${i} once`,
    );
  // The frame tells the shader how many layers to walk.
  assert.equal(r.terrain.rings.length, 2);
  assert.equal(r.terrain.rings[0].values[42], 16);
  const made = r.made().weights;
  r.terrain.dispose();
  assert.ok(made.every((w) => w.destroyed));
  assert.throws(() => rig(four, 17), RangeError, '17 layers is past the limit');
  assert.throws(
    () => rig((texture) => [texture('rgba8unorm'), texture('rgba8unorm')], 9),
    TypeError,
    '9 layers need 3',
  );
  assert.throws(() => rig((texture) => [0, 1, 2, 3, 4].map(() => texture('rgba8unorm')), 16), TypeError);
  // 9 layers in 3 textures: bindings 6 to 8 and no fourth.
  const three = rig((texture) => [0, 1, 2].map(() => texture('rgba8unorm')), 9),
    code3 = modules(three.frame()).find((c) => c.includes('@fragment'));
  assert.match(code3, /@binding\(8\) var terrainWeights2/);
  assert.doesNotMatch(code3, /terrainWeights3/);
  assert.match(code3, /vec4f\(0\)\);/, 'the missing fourth texture weighs 0');
});

test('16 rule layers (no weights) are accepted, 17 rejected', () => {
  const r = rig(undefined, 16);
  r.frame();
  assert.equal(r.terrain.rings[0].values[42], 16);
  assert.throws(() => rig(undefined, 17), RangeError);
  assert.throws(() => rig(undefined, 3), RangeError);
});
