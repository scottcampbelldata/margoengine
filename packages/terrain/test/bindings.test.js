import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../dist/index.js';
import { TerrainMaterials } from '../dist/layers-pbr.js';
import { TerrainDisplacement } from '../dist/displace.js';
import { TerrainImagery } from '../dist/imagery.js';
import { TerrainDeformation } from '../dist/deform.js';
import { TerrainVirtualTexture } from '../dist/rvt.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

// Every terrain entry that adds to the lit shader's lighting group (group 1) owns a fixed range of bindings. They must
// not overlap, or a terrain with two of them fails to compile ("multiple variables that use the same resource binding").
const layers = 4;
function rig(virtual) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
      stats: { drawCalls: 0 },
      removePlugin() {},
      sceneOf: () => undefined,
    },
    texture = (device, format, count = 1) => device.createTexture({ size: [4, 4, count], format, usage: 6 }),
    terrain = new Terrain({
      resolution: 8,
      levels: 2,
      size: [32, 32],
      layers: Array.from({ length: layers }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })),
      textures: (device) => ({ heightmap: texture(device, 'r32float'), layers: texture(device, 'rgba8unorm', layers) }),
    });
  terrain.setup(engine);
  const entries = [];
  if (virtual) {
    const rvt = new TerrainVirtualTexture(terrain, { size: 256, levels: 2 });
    rvt.setup(engine);
    entries.push(rvt);
  } else {
    const materials = new TerrainMaterials(terrain, {
        textures: (device) => ({ normals: texture(device, 'rgba8unorm', layers), surface: texture(device, 'rgba8unorm', layers) }),
      }),
      displacement = new TerrainDisplacement(terrain, materials, {});
    materials.setup(engine);
    displacement.setup(engine);
    entries.push(materials, displacement);
  }
  // Imagery at its most layers (the device allows 16 sampled textures, the terrain and the others take the rest).
  const imagery = new TerrainImagery(terrain, { automatic: false, maxLayers: 7 });
  imagery.setup(engine);
  const photo = texture(gpu.device, 'rgba8unorm');
  for (let i = 0; i < 7; i++) imagery.add({ source: { texture: () => photo }, bounds: [0, 0, 32, 32] });
  const deformation = new TerrainDeformation(terrain, {});
  deformation.setup(engine);
  entries.push(imagery, deformation);
  return { terrain, entries };
}

for (const virtual of [false, true])
  test(`terrain entries in the lit lighting group take distinct bindings (${virtual ? 'virtual texture, imagery on the lit path' : 'layer materials, displacement, imagery on the lit path'}, footprints)`, () => {
    const { terrain } = rig(virtual),
      code = terrain.shader(),
      declared = [...code.matchAll(/@group\(1\) @binding\((\d+)\)/g)].map((m) => Number(m[1])),
      bound = [...terrain.lighting].flatMap((effect) => effect.bindings().map((entry) => entry.binding));
    assert.ok(declared.length >= (virtual ? 14 : 16), `declared: ${declared}`);
    assert.deepEqual(declared.filter((b, i) => declared.indexOf(b) !== i), [], `shader declares a binding twice: ${declared}`);
    assert.deepEqual(bound.filter((b, i) => bound.indexOf(b) !== i), [], `entries bind a slot twice: ${bound}`);
    assert.deepEqual([...bound].sort((a, b) => a - b), [...declared].sort((a, b) => a - b), 'every binding is declared and bound');
  });
