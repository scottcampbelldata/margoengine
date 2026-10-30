// TerrainLayer.bump and macro (biome look plan round 2, item 3): compiled in only when a layer sets one. Leaving them
// out, or setting them to 0, keeps the shader text, the 8-float rules and so every GPU call as before
// (examples/package-benchmarks/proofs/terrain-ssr.proof.js records the whole sequence); test/bump.browser.mjs measures
// the pixels on a real GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Terrain } from '../dist/index.js';

function rig(layer = {}, { weights = false, count = 4 } = {}) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
      stats: { drawCalls: 0 },
      removePlugin() {},
    };
  const terrain = new Terrain({
    resolution: 8,
    levels: 2,
    size: [32, 32],
    layers: Array.from({ length: count }, (_, i) => ({
      height: [-10, 10],
      slope: [0, 1],
      scale: 0.25 * (i + 1),
      ...layer,
    })),
    textures: (device) => {
      const texture = (format, layers = 1) =>
        device.createTexture({ size: [4, 4, layers], format, usage: GPUTextureUsage.TEXTURE_BINDING });
      return {
        heightmap: texture('r32float'),
        layers: texture('rgba8unorm', count),
        ...(weights ? { weights: [texture('rgba8unorm'), texture('rgba8unorm')] } : {}),
      };
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
  // The rules: the one storage upload of 8 or 12 floats a layer.
  const rules = log
    .filter((e) => e[0] === 'writeBuffer')
    .map((e) => new Float32Array(new Uint8Array(Buffer.from(e[3], 'hex')).buffer))
    .find((f) => f.length === count * 8 || f.length === count * 12);
  const code = modules(frame()).find((c) => c.includes('@fragment'));
  return { terrain, log, rules, code, frame };
}
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);

test('leaving bump and macro out, or 0, keeps the shader and the 8-float rules', () => {
  for (const weights of [false, true]) {
    const before = rig({}, { weights }),
      zero = rig({ bump: 0, macro: 0 }, { weights });
    assert.equal(zero.code, before.code, 'the same shader text');
    assert.deepEqual(zero.log, before.log, 'the same setup calls, rules included');
    assert.equal(before.rules.length, 32);
    assert.doesNotMatch(before.code, /terrainBump|terrainSurface|surface:vec4f/);
    assert.match(before.code, /let n=normalize\(i\.normal\);let base=terrainColor\(i\.position,n\);/);
  }
});

test('bump and macro add the surface rules and the bumped shading normal', () => {
  for (const weights of [false, true]) {
    const r = rig({ bump: 0.5, macro: 0.25 }, { weights });
    assert.equal(r.rules.length, 48, '12 floats a layer');
    for (let i = 0; i < 4; i++) {
      const scale = 0.25 * (i + 1),
        surface = Array.from(r.rules.subarray(i * 12 + 8, i * 12 + 12));
      // Bump: half a repeat per unit of luma, times bump; macro; the macro sample's scale (1/24 of the layer's).
      assert.deepEqual(surface, Array.from(new Float32Array([(0.5 * 0.5) / scale, 0.25, scale / 24, 0])));
    }
    assert.match(r.code, /struct Layer \{heightSlope:vec4f,params:vec4f,surface:vec4f\}/);
    assert.match(
      r.code,
      /let terrainN=normalize\(i\.normal\);let base=terrainColor\(i\.position,terrainN\);let n=terrainBump\(i\.position,terrainN\);/,
    );
    assert.equal(r.code.match(/fn terrainColor\(/g).length, 1);
    assert.match(r.code, /terrainRelief=/);
  }
});

test('bump and macro outside 0..1 are rejected', () => {
  for (const bad of [{ bump: -0.1 }, { bump: 1.5 }, { bump: Number.NaN }, { macro: 2 }, { macro: -1 }, { bump: '1' }])
    assert.throws(() => rig(bad), {
      name: 'RangeError',
      message: 'Invalid terrain layer bump or macro; give each a number from 0 to 1 (default 0).',
    });
  assert.doesNotThrow(() => rig({ bump: 1, macro: 1 }));
});
