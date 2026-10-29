// Working memory of tile jobs. A worker made each tile with megabytes of fresh arrays it threw away (a placement tile
// about 23 MB with its neighbours made, a view tile 4.6 MB), and the view job made its world tile a second time with
// other layers than the placement job of the same tile. On a laptop APU (Ryzen 7 7735HS, Radeon 680M) four workers
// churning fresh memory slowed the page's own frames in the same process and the flythrough check failed. Tile making
// and placement now reuse their working arrays; this counts the bytes of typed arrays made per job, and checks that the
// reused arrays give the same bytes as fresh ones whatever ran before.
import test from 'node:test';
import assert from 'node:assert/strict';

// Count every typed array made with a length (fresh memory) while `counting` is on. Installed before the package loads.
let counting = false,
  made = 0;
for (const name of [
  'Int8Array',
  'Uint8Array',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
]) {
  const Type = globalThis[name];
  globalThis[name] = new Proxy(Type, {
    construct(target, args, newTarget) {
      const array = Reflect.construct(target, args, newTarget === globalThis[name] ? target : newTarget);
      if (counting && typeof args[0] === 'number') made += array.byteLength;
      return array;
    },
  });
}
const { BiomeWorld } = await import('../dist/index.js');
const { BiomePlacement } = await import('../dist/placement.js');
const { groundMaterials, viewTile } = await import('../dist/view.js');

/** Bytes of fresh typed arrays `job` makes. */
async function bytes(job) {
  made = 0;
  counting = true;
  try {
    await job();
  } finally {
    counting = false;
  }
  return made;
}

test('a worker job reuses its working arrays: placement and view tiles make a small part of the memory they did', async () => {
  // As in a worker: a world without workers of its own, its cache as the worker's, one placement replica.
  const world = await BiomeWorld.create({ workers: false, cache: 36 }),
    placement = BiomePlacement.attach(world),
    materials = groundMaterials(world.biomes);
  // The view job: the world tile with the default layers (shared with placement), then what the view draws.
  const view = async (x, z) => viewTile(world, await world.tile(x, z), materials, 2);
  await placement.tile(5, 5);
  await view(5, 5);
  // The next tile along: its own column of neighbours is new (three world tiles made), the rest are cached.
  const place = await bytes(() => placement.tile(6, 5)),
    drawn = await bytes(() => view(6, 5));
  // Before: 24.0 MB for the placement (10.5 MB of candidate tables, three world tiles of 4 MB working fields each) and
  // 4.6 MB for the view tile made again with the view's layers. Now about 2.1 MB and 0.2 MB, nearly all of it output
  // (the view tile's three textures, the placed tile's records and maps, the new world tiles' layers).
  assert.ok(place < 4e6, `placing a tile made ${(place / 1e6).toFixed(1)} MB of fresh arrays`);
  assert.ok(drawn < 0.5e6, `a view tile made ${(drawn / 1e6).toFixed(1)} MB of fresh arrays`);
  placement.dispose();
  world.dispose();
});

test('reused working arrays give the bytes of fresh ones, whatever was made before', async () => {
  const layers = (t) => Object.fromEntries(t.layers.map((name) => [name, [...t.layer(name).data]]));
  // One world makes tiles of every shape in turn (unclassified fields without a margin, classified with one, the
  // optional curvature layers) so each reuses arrays a different shape left; a fresh world makes each alone.
  const shared = await BiomeWorld.create({ workers: false }),
    requests = [
      [3, 4, { layers: ['height', 'slope'] }],
      [4, 4, {}],
      [2, 7, { layers: ['height', 'profile', 'plan'] }],
      [5, 1, { layers: ['moisture', 'biome'] }],
      [3, 5, { layers: ['tpi'] }],
    ];
  for (const [x, z, options] of requests) {
    const fresh = await BiomeWorld.create({ workers: false });
    assert.deepEqual(
      layers(await shared.tile(x, z, options)),
      layers(await fresh.tile(x, z, options)),
      `tile ${x},${z}`,
    );
    fresh.dispose();
  }
  // Placement: tiles placed one after another (pools reused, grown or not) against each placed alone.
  const placement = BiomePlacement.attach(shared);
  for (const [x, z] of [
    [2, 2],
    [6, 1],
    [2, 3],
  ]) {
    const world = await BiomeWorld.create({ workers: false }),
      alone = BiomePlacement.attach(world),
      a = await placement.tile(x, z),
      b = await alone.tile(x, z);
    assert.deepEqual([...a.instances], [...b.instances], `placed tile ${x},${z}`);
    assert.deepEqual(
      a.density.map((d) => [...d.data]),
      b.density.map((d) => [...d.data]),
    );
    assert.deepEqual([...a.canopy.data], [...b.canopy.data]);
    alone.dispose();
    world.dispose();
  }
  placement.dispose();
  shared.dispose();
});

test('a view tile reuses its ground weights array and gives the bytes of a fresh one, also for a cell with no biome weight', async () => {
  const world = await BiomeWorld.create({ workers: false }),
    materials = groundMaterials(world.biomes),
    bytes = (t) => [[...t.heights], [...t.weights[0]], [...t.weights[1]]],
    first = bytes(viewTile(world, await world.tile(4, 4), materials, 2));
  // A cell whose four biome weights are all 0 goes wholly to the first material: once, it left the other seven bytes
  // as they were, so the reused array (and the view's overview, which reuses its 8 bytes per sample) kept old weights.
  const n = 4,
    flat = {
      cells: 2,
      layer: (name) =>
        name === 'biome' || name === 'biomeWeight'
          ? { data: new Uint8Array(n * 4) }
          : { data: new Int32Array(n), scale: 0.001 },
    };
  viewTile(world, await world.tile(6, 2), materials, 2);
  const zero = viewTile(world, flat, materials, 1);
  for (let k = 0; k < n; k++) {
    assert.deepEqual([...zero.weights[0].subarray(k * 4, k * 4 + 4)], [255, 0, 0, 0]);
    assert.deepEqual([...zero.weights[1].subarray(k * 4, k * 4 + 4)], [0, 0, 0, 0]);
  }
  assert.deepEqual(bytes(viewTile(world, await world.tile(4, 4), materials, 2)), first);
  world.dispose();
});
