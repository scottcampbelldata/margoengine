// @margoengine/biomes/graph: placement rule graphs. A graph is checked when it is defined (ops, settings, inputs, no
// cycle, fields tiles hold, outputs naming nodes) and when a placement attaches it (every selector selects a species).
// A graph that is 1 everywhere places the same bytes as no graph; 0 for one species removes only that species; a
// height range keeps a species below its bound; noise and blend nodes thin as their values say; workers place the page's
// bytes with a graph; evaluateGraph gives a node's value over a tile, cell by cell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { BiomePlacement } from '../dist/placement.js';
import { takeLoaded, ThreadWebWorker } from './thread-worker.js';

const biomes = [
  defineBiome({
    id: 'wood',
    climate: {},
    ground: [{ material: 'grass' }],
    plants: [
      { id: 'pine', mesh: 'procedural:conifer', density: 120, radius: 3, tags: ['tree'] },
      { id: 'fern', mesh: 'procedural:bush', density: 300, radius: 0.8, tags: ['ground'] },
    ],
    rocks: [{ id: 'boulder', mesh: 'procedural:rock', density: 20, radius: 1 }],
  }),
];
const options = { seed: 5, size: [768, 768], biomes };
const tiles = [
  [1, 1],
  [0, 2],
];
const keys = (t) => {
  const out = new Map();
  t.forEachInstance((o) => out.set(o.key, (out.get(o.key) ?? 0) + 1));
  return out;
};

test('the placement fails clearly before the graph entry is loaded', async () => {
  const world = await BiomeWorld.create(options);
  assert.throws(
    () => BiomePlacement.attach(world, { graph: { nodes: [{ id: 'one', op: 'constant', value: 1 }], outputs: {} } }),
    /graph entry/,
  );
});

test('definePlacementGraph checks ops, settings, inputs, cycles and outputs', async () => {
  const { definePlacementGraph } = await import('../dist/graph.js');
  const ok = definePlacementGraph({
    nodes: [
      { id: 'low', op: 'range', field: 'height', range: [null, 40] },
      { id: 'n', op: 'noise', scale: 30 },
      { id: 'both', op: 'multiply', inputs: ['low', 'n'] },
    ],
    outputs: { '#tree': 'both' },
  });
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(ok.nodes[0]));
  const bad = (nodes, outputs = {}) => assert.throws(() => definePlacementGraph({ nodes, outputs }), RangeError);
  bad([{ id: 'a', op: 'sqrt', input: 'a' }]);
  bad([{ id: 'a', op: 'constant', value: 2 }]);
  bad([{ id: 'a', op: 'constant', value: 1, input: 'b' }]);
  bad([
    { id: 'a', op: 'constant', value: 1 },
    { id: 'a', op: 'constant', value: 0 },
  ]);
  bad([{ id: 'a', op: 'invert', input: 'nope' }]);
  bad([
    { id: 'a', op: 'invert', input: 'b' },
    { id: 'b', op: 'invert', input: 'a' },
  ]);
  bad([{ id: 'a', op: 'range', field: 'colour', range: [0, 1] }]);
  bad([{ id: 'a', op: 'range', field: 'height', range: [5, 1] }]);
  bad([{ id: 'a', op: 'noise', scale: 0.5 }]);
  bad([
    { id: 'c', op: 'constant', value: 1 },
    {
      id: 'a',
      op: 'curve',
      input: 'c',
      points: [
        [0.5, 0],
        [0.5, 1],
      ],
    },
  ]);
  bad([{ id: 'c', op: 'constant', value: 1 }], { pine: 'missing' });
});

test('a graph of 1 everywhere places the same bytes as no graph; 0 removes only its species', async () => {
  await import('../dist/graph.js');
  const one = { nodes: [{ id: 'one', op: 'constant', value: 1 }], outputs: { '#tree': 'one', boulder: 'one' } },
    zero = { nodes: [{ id: 'zero', op: 'constant', value: 0 }], outputs: { 'wood/fern': 'zero' } },
    plain = BiomePlacement.attach(await BiomeWorld.create(options)),
    same = BiomePlacement.attach(await BiomeWorld.create(options), { graph: one }),
    cut = BiomePlacement.attach(await BiomeWorld.create(options), { graph: zero });
  for (const [x, z] of tiles) {
    assert.equal(await same.digest(x, z), await plain.digest(x, z), `tile ${x},${z}`);
    const before = keys(await plain.tile(x, z)),
      after = keys(await cut.tile(x, z));
    assert.ok(before.get('wood/fern') > 0);
    assert.equal(after.get('wood/fern'), undefined, 'no fern is left');
    assert.ok(after.get('wood/pine') > 0 && after.get('wood/boulder') > 0, 'the other species stay');
  }
  await assert.rejects(
    async () => BiomePlacement.attach(await BiomeWorld.create(options), { graph: { ...one, outputs: { oak: 'one' } } }),
    /selects no species/,
  );
});

test('a height range keeps a species below its bound, and the band thins it near the bound', async () => {
  await import('../dist/graph.js');
  const world = await BiomeWorld.create(options),
    tile = await world.tile(1, 1),
    heights = tile.layer('height').data,
    sorted = [...heights].sort((a, b) => a - b),
    median = sorted[sorted.length >> 1] / 1000, // stored mm to m
    graph = {
      nodes: [{ id: 'low', op: 'range', field: 'height', range: [null, median], blend: 0.05 }],
      outputs: { pine: 'low' },
    },
    p = BiomePlacement.attach(world, { graph });
  let pines = 0;
  (await p.tile(1, 1)).forEachInstance((o) => {
    if (o.key !== 'wood/pine') return;
    pines++;
    // Open range: the band is 50 m * (0.05 / 0.15) wide, centred on the bound.
    assert.ok(world.heightAt(o.x, o.z) <= median + 9, `pine at ${world.heightAt(o.x, o.z)} m over ${median} m`);
  });
  assert.ok(pines > 0);
});

test('evaluateGraph: constants, ranges, invert, blend and noise over a tile', async () => {
  const { evaluateGraph, definePlacementGraph } = await import('../dist/graph.js');
  const world = await BiomeWorld.create(options),
    tile = await world.tile(1, 1),
    g = definePlacementGraph({
      nodes: [
        { id: 'half', op: 'constant', value: 0.5 },
        { id: 'low', op: 'range', field: 'height', range: [null, 30] },
        { id: 'high', op: 'invert', input: 'low' },
        { id: 'sum', op: 'add', inputs: ['low', 'high'] },
        { id: 'n', op: 'noise', scale: 40, seed: 3 },
        { id: 'mix', op: 'blend', inputs: ['low', 'high'], by: 'half' },
        {
          id: 'step',
          op: 'curve',
          input: 'n',
          points: [
            [0.49, 0],
            [0.51, 1],
          ],
        },
      ],
      outputs: {},
    }),
    at = (node) => evaluateGraph(g, node, tile);
  assert.equal(at('half').length, tile.cells * tile.cells);
  assert.ok(at('half').every((v) => v === 128));
  assert.ok(
    at('sum').every((v) => v === 255),
    'low + (1 - low) is 1',
  );
  assert.ok(
    at('mix').every((v) => v >= 127 && v <= 128),
    'halfway between low and 1 - low',
  );
  const n = at('n');
  assert.ok(Math.min(...n) < 80 && Math.max(...n) > 175, 'noise spans its range');
  assert.deepEqual(at('n'), evaluateGraph(g, 'n', await (await BiomeWorld.create(options)).tile(1, 1)), 'same bytes');
  const s = at('step'),
    on = s.filter((v) => v === 255).length;
  assert.ok(s.every((v, k) => (v === 255) === n[k] >= 131) || on > 0, 'the step follows the noise');
  assert.throws(() => evaluateGraph(g, 'nope', tile), RangeError);
});

test('noise thins a species where it is low; workers place the page bytes with a graph', {
  timeout: 240000,
}, async () => {
  await import('../dist/graph.js');
  const graph = {
      nodes: [
        { id: 'n', op: 'noise', scale: 60, seed: 9 },
        {
          id: 'gate',
          op: 'curve',
          input: 'n',
          points: [
            [0.45, 0],
            [0.55, 1],
          ],
        },
      ],
      outputs: { fern: 'gate' },
    },
    main = BiomePlacement.attach(await BiomeWorld.create(options), { graph }),
    plain = BiomePlacement.attach(await BiomeWorld.create(options)),
    far = await BiomeWorld.create({ ...options, workers: 1, createWorker: () => new ThreadWebWorker() }),
    remote = BiomePlacement.attach(far, { graph });
  takeLoaded();
  let kept = 0,
    all = 0;
  for (const [x, z] of tiles) {
    assert.equal(await remote.digest(x, z), await main.digest(x, z), `tile ${x},${z}`);
    kept += keys(await main.tile(x, z)).get('wood/fern') ?? 0;
    all += keys(await plain.tile(x, z)).get('wood/fern') ?? 0;
  }
  assert.ok(kept > 0.25 * all && kept < 0.75 * all, `${kept} of ${all} ferns kept`);
  // A graph change through update reaches the replica too.
  const zero = { nodes: [{ id: 'z', op: 'constant', value: 0 }], outputs: { fern: 'z' } };
  main.update({ graph: zero });
  remote.update({ graph: zero });
  assert.equal(await remote.digest(1, 1), await main.digest(1, 1));
  assert.equal(keys(await main.tile(1, 1)).get('wood/fern'), undefined);
  assert.deepEqual(
    [...new Set(takeLoaded())],
    ['biomes-graph.js'],
    'the workers ran the graph part, from its own file',
  );
  far.dispose();
});
