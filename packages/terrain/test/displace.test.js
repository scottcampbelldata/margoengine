import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainDisplacement } from '../dist/displace.js';
import { TerrainMaterials } from '../dist/layers-pbr.js';
import { Terrain } from '../dist/index.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const terrainOptions = (weights) => ({
  resolution: 8,
  levels: 2,
  size: [32, 32],
  layers: Array.from({ length: 5 }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })),
  textures: (device) => {
    const texture = (format, layers = 1) => device.createTexture({ size: [4, 4, layers], format, usage: 4 });
    return {
      heightmap: texture('r32float'),
      layers: texture('rgba8unorm', 5),
      ...(weights ? { weights: [texture('rgba8unorm'), texture('rgba8unorm')] } : {}),
    };
  },
});
function rig(weights, options = {}) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
      stats: { drawCalls: 0 },
      removePlugin() {},
    },
    terrain = new Terrain(terrainOptions(weights)),
    materials = new TerrainMaterials(terrain, {
      textures: (device) => ({
        normals: device.createTexture({ size: [4, 4, 5], format: 'rgba8unorm', usage: 4 }),
        surface: device.createTexture({ size: [4, 4, 5], format: 'rgba8unorm', usage: 4 }),
      }),
    }),
    displacement = new TerrainDisplacement(terrain, materials, options);
  terrain.setup(engine);
  const lit = terrain.colorSource().code;
  return { terrain, materials, displacement, engine, lit };
}

test('options are checked', () => {
  const terrain = new Terrain(terrainOptions(false)),
    materials = new TerrainMaterials(terrain, { textures: () => ({}) });
  for (const options of [
    { depth: -0.1 },
    { depth: 2 },
    { layers: [{ depth: 3 }] },
    { layers: Array.from({ length: 6 }, () => ({})) },
    { distance: 0 },
    { steps: 3 },
    { steps: 65 },
    { steps: 8.5 },
    { shadows: 1 },
  ])
    assert.throws(() => new TerrainDisplacement(terrain, materials, options), RangeError, JSON.stringify(options));
  assert.throws(() => new TerrainDisplacement({}, materials, {}), TypeError);
  assert.throws(() => new TerrainDisplacement(terrain, {}, {}), /TerrainMaterials attached/);
});

test('displacement patches the materials shader: the hit point shades, gradients stay the surface', () => {
  for (const weights of [false, true]) {
    const r = rig(weights),
      code = r.displacement.shader(r.materials.shader(r.lit, 1), 1);
    assert.match(
      code,
      /j\.position=terrainDisplace\(i\.position,normalize\(i\.normal\)\);return terrainPbrShade\(j\);/,
    );
    assert.equal(code.split('if(terrainDisplaced){dx=terrainDisplaceDx;dy=terrainDisplaceDy;}').length, 2);
    assert.match(code, /let direct=terrainDisplaceShadow\*\(/);
    assert.match(code, /@group\(1\) @binding\(97\) var<uniform> terrainDisplaceRules:array<vec4f,17>;/);
    assert.equal(code.includes('textureSampleLevel(terrainWeights1'), weights, 'painted weights read when painted');
  }
  const quiet = rig(false, { shadows: false });
  const quietCode = quiet.displacement.shader(quiet.materials.shader(quiet.lit, 1), 1);
  assert.ok(!quietCode.includes('terrainDisplaceSun') && !quietCode.includes('binding(98)'));
  const lit = rig(false),
    code = lit.displacement.shader(lit.materials.shader(lit.lit, 1), 1);
  assert.match(code, /@group\(1\) @binding\(98\) var terrainDisplaceMax:texture_2d_array<f32>;/);
  assert.match(code, /terrainDisplaceShadow=terrainDisplaceSun\(p,normal,depth\);/);
});

test('displacement needs layer materials first and owns its uniform and maximum mipmap', () => {
  const r = rig(false);
  assert.throws(() => r.displacement.shader(r.lit, 1), /TerrainMaterials first/);
  assert.throws(() => r.displacement.setup(r.engine), /attach TerrainMaterials first/);
  r.materials.setup(r.engine);
  const made = [],
    create = r.engine.gpu.createTexture;
  r.engine.gpu.createTexture = (d) => {
    const t = create(d);
    made.push(t);
    return t;
  };
  r.displacement.setup(r.engine);
  const [entry, maxima] = r.displacement.bindings(),
    [texture] = made;
  assert.equal(entry.binding, 97);
  assert.equal(entry.resource.buffer.size, 272);
  assert.equal(maxima.binding, 98);
  assert.equal(made.length, 1);
  assert.equal(texture.format, 'r32float');
  assert.equal(texture.mipLevelCount, 3, 'a 4 texel map has levels of 4, 2 and 1');
  r.displacement.dispose();
  assert.ok(entry.resource.buffer.destroyed);
  assert.ok(texture.destroyed);
  assert.deepEqual(r.displacement.bindings(), []);
  const quiet = rig(false, { shadows: false });
  quiet.materials.setup(quiet.engine);
  quiet.displacement.setup(quiet.engine);
  assert.equal(quiet.displacement.bindings().length, 1, 'no mipmap without shadows');
});

test('shadows refuse surface maps that are not square and a power of two', () => {
  for (const size of [
    [6, 6],
    [4, 8],
  ]) {
    const r = rig(false);
    r.materials.options.textures = (device) => ({
      normals: device.createTexture({ size: [...size, 5], format: 'rgba8unorm', usage: 4 }),
      surface: device.createTexture({ size: [...size, 5], format: 'rgba8unorm', usage: 4 }),
    });
    r.materials.setup(r.engine);
    assert.throws(() => r.displacement.setup(r.engine), /square, power-of-two/);
  }
});
