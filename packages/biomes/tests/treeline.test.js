import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { canopyCover } from '../dist/cover.js';
import { definePlacementGraph, evaluateGraph } from '../dist/graph.js';
import { alpineTreelineGraph } from '../dist/treeline.js';

const options = {
  elevation: 3450,
  mature: ['wood/fir'],
  young: ['wood/young-fir'],
  stunted: ['edge/krummholz'],
  seed: 71,
};

function tile(height, exposure = 50, curvature = 0, x = 0) {
  const cells = 64;
  const layers = { height: height * 1000, exposure, curvature };
  return {
    x,
    z: 0,
    cells,
    resolution: 4,
    layer(name) {
      return { data: new Int32Array(cells * cells).fill(layers[name]) };
    },
  };
}

test('the alpine transition changes from mature forest to patches of shorter trees to bare ground', () => {
  const graph = alpineTreelineGraph(options);
  assert.deepEqual(graph.outputs, {
    'wood/fir': 'mature',
    'wood/young-fir': 'young',
    'edge/krummholz': 'stunted',
  });
  const mask = (role, height, exposure, curvature) => evaluateGraph(graph, role, tile(height, exposure, curvature));
  assert.ok(mask('mature', 3250).every((value) => value === 255));
  assert.ok(mask('stunted', 3250).every((value) => value === 0));
  assert.ok(mask('mature', 3590).every((value) => value === 0));
  assert.ok(mask('young', 3470).some((value) => value > 40));
  const sheltered = mask('stunted', 3480, 50, -40);
  const exposed = mask('stunted', 3480, 224, 40);
  assert.ok(Math.max(...sheltered) - Math.min(...sheltered) > 45, 'one elevation has distinct patches');
  assert.ok(
    sheltered.some((value, i) => value > exposed[i] + 70),
    'hollows shelter trees that an exposed ridge cannot',
  );
  assert.ok(mask('stunted', 3670).every((value) => value === 0));
  const repeated = alpineTreelineGraph(options);
  assert.deepEqual(evaluateGraph(repeated, 'stunted', tile(3480)), mask('stunted', 3480));
  assert.notDeepEqual(
    evaluateGraph(alpineTreelineGraph({ ...options, seed: 99 }), 'stunted', tile(3480)),
    mask('stunted', 3480),
  );
});

test('the alpine transition validates its extents and cohort selectors', () => {
  assert.throws(() => alpineTreelineGraph({ ...options, elevation: Infinity }), RangeError);
  assert.throws(() => alpineTreelineGraph({ ...options, patchSize: 11 }), RangeError);
  assert.throws(() => alpineTreelineGraph({ ...options, mature: [] }), RangeError);
  assert.throws(() => alpineTreelineGraph({ ...options, young: options.mature }), RangeError);
});

test('distant canopy preserves the custom species silhouette and placement density graph', async () => {
  const biome = defineBiome({
    id: 'fir-forest',
    climate: {},
    ground: [{ material: 'grass' }],
    plants: [{ id: 'fir', mesh: 'library:surveyed-tree', canopyKind: 'conifer', density: 150, radius: 3 }],
  });
  const world = await BiomeWorld.create({
    size: [256, 256],
    workers: false,
    biomes: [biome],
    height: { field: () => 120 },
  });
  try {
    const unmasked = canopyCover(world, 16);
    assert.ok(unmasked.kinds[1].some((cell) => cell > 0));
    assert.ok(unmasked.kinds[0].every((cell) => cell === 0));
    const graph = definePlacementGraph({
      nodes: [{ id: 'too-high', op: 'range', field: 'height', range: [null, 80] }],
      outputs: { 'fir-forest/fir': 'too-high' },
    });
    const masked = canopyCover(world, 16, graph);
    assert.ok(masked.data.every((cell) => cell === 0));
    assert.ok(masked.kinds[1].every((cell) => cell === 0));
  } finally {
    world.dispose();
  }
});
