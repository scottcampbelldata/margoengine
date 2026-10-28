// TerrainTextures.weights (biomes item 27.4, decision D4): two rgba8unorm textures replace the height and slope rules.
// Without them the terrain shader, layout and bind groups are unchanged; examples/package-benchmarks/proofs/
// terrain-ssr.proof.js records that whole GPU call sequence against its golden copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Terrain } from '../dist/index.js';

function rig(weights) {
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
    layers: Array.from({ length: 5 }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })),
    textures: (device) => {
      const texture = (format, layers = 1) =>
        device.createTexture({ size: [4, 4, layers], format, usage: GPUTextureUsage.TEXTURE_BINDING });
      made = {
        heightmap: texture('r32float'),
        layers: texture('rgba8unorm', 5),
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
  assert.match(code, /fn terrainWeight\(layer:u32,p:vec3f\)->f32/);
  assert.match(code, /let weight=terrainWeight\(layer,position\);/);
  assert.doesNotMatch(code, /let weight=smoothstep/, 'the rule weights are gone');
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
