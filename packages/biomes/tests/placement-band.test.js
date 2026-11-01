// Biomes J2: placement makes its own world tile whole and, of each neighbour, only the band next to it that placement
// can reach (BiomeWorld.tilePart). A part holds the bytes of those cells of the whole tile; a read past a band makes the
// neighbour whole and runs again; so every byte of a placed tile is the one placement with whole neighbours gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { BiomePlacement } from '../dist/placement.js';
import { presets, presetWorlds } from '../dist/presets.js';
import { holdridge, whittaker } from '../dist/zones.js';

/** Every byte of a placed tile: palette, count, stats, records, crown cover, exclusion and density rasters. */
function placedHash(t) {
  const h = createHash('sha256');
  h.update(
    JSON.stringify({
      x: t.x,
      z: t.z,
      origin: t.origin,
      size: t.size,
      count: t.count,
      species: t.species,
      candidates: t.stats.candidates,
      accepted: t.stats.accepted,
      unresolved: t.stats.unresolved,
      rounds: [...t.stats.rounds],
    }),
  );
  h.update(t.instances);
  h.update(t.canopy.data);
  h.update(t.exclusion.data);
  for (const d of t.density) {
    h.update(d.id);
    h.update(d.data);
  }
  return h.digest('hex');
}

/** Small crowns: the placement reach stays well inside a 256 m tile, so neighbours are made as bands. */
const scrub = [
  defineBiome({
    id: 'scrub',
    climate: { slope: [null, 14] },
    ground: [{ material: 'grass' }],
    plants: [{ id: 'gorse', mesh: 'procedural:shrub', density: 900, radius: 0.8, shade: 0.6 }],
    rocks: [{ id: 'stone', mesh: 'procedural:rock', density: 40, radius: 0.5, suitability: { slope: [12, null] } }],
  }),
  defineBiome({
    id: 'heath',
    climate: { slope: [10, null] },
    ground: [{ material: 'rock' }],
    plants: [{ id: 'heather', mesh: 'procedural:shrub', density: 1400, radius: 0.6, shade: 0.5 }],
  }),
];

const scrubWorld = (extra = {}) =>
  BiomeWorld.create({
    seed: 11,
    size: [1024, 1024],
    workers: 0,
    height: { relief: presetWorlds.temperate.relief },
    climate: presetWorlds.temperate.climate,
    biomes: scrub,
    ...extra,
  });

/** Placement of a tile on a world whose 3 x 3 tiles around it are whole in the world's cache (what placement read
 * before bands): the reference bytes. */
async function withWholeNeighbours(world, x, z) {
  for (let tz = z - 1; tz <= z + 1; tz++)
    for (let tx = x - 1; tx <= x + 1; tx++)
      if (tx >= 0 && tz >= 0 && tx < world.tilesX && tz < world.tilesZ) await world.tile(tx, tz);
  return BiomePlacement.attach(world).tile(x, z);
}

test('tilePart: every layer of a window equals those cells of the whole tile, byte for byte', async () => {
  const worlds = [
    // Relief, two biomes, interior, edge and corner tiles.
    [
      await scrubWorld(),
      [
        [1, 1],
        [0, 2],
        [3, 3],
      ],
    ],
    // A preset world at 2 m cells.
    [
      await BiomeWorld.create({
        size: [1024, 1024],
        resolution: 2,
        biomes: Object.values(presets).filter((b) => b.id !== 'beach'),
        climate: presetWorlds.boreal.climate,
        height: { relief: presetWorlds.boreal.relief },
      }),
      [
        [1, 2],
        [0, 0],
      ],
    ],
  ];
  // Zone classifiers: their scorers weight each cell from that cell alone, so parts match whole tiles here too. Both
  // worlds mix two biomes in these tiles (alpine and tundra; wetland and temperate).
  for (const [classifier, place] of [
    [whittaker, presetWorlds.tundra],
    [holdridge, presetWorlds.temperate],
  ])
    worlds.push([
      await BiomeWorld.create({
        seed: 5,
        size: [768, 768],
        biomes: Object.values(presets).filter((b) => b.id !== 'beach'),
        classifier,
        climate: place.climate,
        height: { relief: place.relief },
      }),
      [
        [1, 1],
        [2, 0],
      ],
    ]);
  // Paint, a paint mask and a 40 m ecotone (a wide feather that reads across tile and part edges).
  const painted = await BiomeWorld.create({
    size: [768, 768],
    ecotone: 40,
    biomes: [presets.temperate, presets.desert, presets.alpine],
    paint: [{ biome: 'desert', mode: 'replace', mask: 'mask/dunes' }],
    height: { relief: presetWorlds.temperate.relief },
  });
  const stripes = new Uint8Array(256 * 256),
    ramp = new Uint8Array(256 * 256);
  for (let k = 0; k < stripes.length; k++) {
    stripes[k] = (k >> 4) & 1 ? 255 : 0;
    ramp[k] = k & 255;
  }
  painted.writeLayer('paint/desert', 1, 1, stripes);
  painted.writeLayer('paint/desert', 2, 1, ramp);
  painted.writeLayer('mask/dunes', 1, 1, ramp);
  painted.writeLayer('mask/dunes', 1, 2, stripes);
  worlds.push([
    painted,
    [
      [1, 1],
      [2, 2],
      [0, 1],
    ],
  ]);
  for (const [world, tiles] of worlds) {
    const cells = world.tileSize / world.resolution;
    for (const [x, z] of tiles) {
      const windows = [
        [0, 0, cells, 37],
        [cells - 50, 0, cells, cells],
        [0, cells - 1, cells, cells],
        [3, 5, 70, 9],
        [cells - 64, cells - 64, cells, cells],
      ];
      // Parts first: once the world holds the whole tile, tilePart answers with it.
      const parts = [];
      for (const window of windows) parts.push(await world.tilePart(x, z, window));
      const whole = await world.tile(x, z);
      for (const part of parts) {
        const [i0, j0, i1, j1] = part.window;
        assert.deepEqual([...part.layers], [...whole.layers]);
        for (const name of whole.layers) {
          const a = part.layer(name),
            b = whole.layer(name),
            per = name === 'biome' || name === 'biomeWeight' ? 4 : 1;
          assert.equal(a.width, i1 - i0);
          assert.equal(a.depth, j1 - j0);
          for (let j = j0; j < j1; j++)
            assert.deepEqual(
              a.data.subarray((j - j0) * (i1 - i0) * per, (j - j0 + 1) * (i1 - i0) * per),
              b.data.subarray((j * cells + i0) * per, (j * cells + i1) * per),
              `tile ${x},${z} ${name} row ${j} of window ${part.window}`,
            );
        }
      }
      const cached = await world.tilePart(x, z, [0, 0, 1, 1]);
      assert.deepEqual(cached.window, [0, 0, cells, cells], 'a cached whole tile answers whole');
      assert.equal(cached.layer('height').data, whole.layer('height').data);
    }
  }
});

test('tilePart: bad tiles, windows and layer names are RangeErrors; a part is never cached', async () => {
  const w = await scrubWorld();
  await assert.rejects(w.tilePart(4, 0, [0, 0, 1, 1]), RangeError);
  await assert.rejects(w.tilePart(0, 0, [0, 0, 0, 1]), RangeError);
  await assert.rejects(w.tilePart(0, 0, [0, 0, 257, 1]), RangeError);
  await assert.rejects(w.tilePart(0, 0, [-1, 0, 1, 1]), RangeError);
  await assert.rejects(w.tilePart(0, 0, [0.5, 0, 1, 1]), RangeError);
  await assert.rejects(w.tilePart(0, 0, [0, 0, 1, 1], { layers: ['nope'] }), RangeError);
  const part = await w.tilePart(0, 0, [0, 0, 8, 8], { layers: ['height'] });
  assert.deepEqual([...part.layers], ['height']);
  // Not served as the whole tile afterwards.
  assert.equal((await w.tile(0, 0)).layer('height').data.length, 256 * 256);
});

test('placement makes its own tile whole and only the band of each neighbour it can reach', async () => {
  // On 14e4d813d placement.tile(1, 1) made 9 whole tiles here (9 x 65,536 = 589,824 cells). Now: the own tile
  // whole (65,536 cells) and 8 bands a cells wide, 4 x 256 a + 4 a^2 cells: a = 40 here, 47,360 neighbour cells.
  const world = await scrubWorld(),
    tile = world.tile.bind(world),
    part = world.tilePart?.bind(world),
    whole = [],
    bands = [];
  world.tile = (x, z, o) => {
    whole.push(`${x},${z}`);
    return tile(x, z, o);
  };
  if (part)
    world.tilePart = async (x, z, window, o) => {
      const p = await part(x, z, window, o);
      bands.push({ x, z, window: [...p.window] });
      return p;
    };
  const placement = BiomePlacement.attach(world),
    placed = await placement.tile(1, 1);
  assert.ok(placed.count > 1000, `objects ${placed.count}`);
  assert.deepEqual([...new Set(whole)], ['1,1'], `whole tiles made: ${[...new Set(whole)].join(' ')}`);
  assert.equal(bands.length, 8);
  const cells = 256,
    widths = new Set(),
    seen = new Set();
  let made = 0;
  for (const { x, z, window } of bands) {
    const [i0, j0, i1, j1] = window,
      dx = x - 1,
      dz = z - 1;
    seen.add(`${dx},${dz}`);
    // Each band touches the placed tile and spans the side it shares with it.
    assert.deepEqual([dx < 0 ? i1 : i0, dz < 0 ? j1 : j0], [dx < 0 ? cells : 0, dz < 0 ? cells : 0]);
    if (!dx) assert.deepEqual([i0, i1], [0, cells]);
    if (!dz) assert.deepEqual([j0, j1], [0, cells]);
    if (dx) widths.add(i1 - i0);
    if (dz) widths.add(j1 - j0);
    made += (i1 - i0) * (j1 - j0);
  }
  assert.equal(seen.size, 8);
  assert.equal(widths.size, 1, 'one band width');
  const [a] = widths;
  // The band is sized by the first round's reach, narrower than the reach of all rounds (an upper bound).
  assert.ok(a > 0 && a < placement.reach, `band ${a} cells, reach ${placement.reach} m`);
  assert.equal(made, 4 * cells * a + 4 * a * a);
  assert.ok(made < 2 * cells * cells, `neighbour cells ${made}, under a quarter of 8 whole tiles`);
  // The same bytes as placement with whole neighbours.
  assert.equal(placedHash(placed), placedHash(await withWholeNeighbours(await scrubWorld(), 1, 1)));
});

test('band placement gives every byte that whole neighbours give: interior, edge, corner, 512 m tiles', async () => {
  const cases = [
    [
      () => scrubWorld(),
      [
        [1, 1],
        [2, 1],
        [0, 0],
        [3, 2],
        [0, 3],
      ],
    ],
    // The default biomes on 512 m tiles: their reach (oak crowns, 6 rounds) is wider than a 256 m tile but under 512 m,
    // so these neighbours are bands too.
    [
      () =>
        BiomeWorld.create({
          size: [1536, 1536],
          tileSize: 512,
          workers: 0,
          climate: presetWorlds.temperate.climate,
          height: { relief: presetWorlds.temperate.relief },
        }),
      [
        [1, 1],
        [0, 1],
      ],
    ],
  ];
  for (const [make, tiles] of cases) {
    const world = await make(),
      part = world.tilePart.bind(world);
    let parts = 0;
    world.tilePart = (...args) => {
      parts++;
      return part(...args);
    };
    const banded = BiomePlacement.attach(world);
    assert.ok(banded.reach < world.tileSize, `reach ${banded.reach} m inside a ${world.tileSize} m tile`);
    for (const [x, z] of tiles)
      assert.equal(
        placedHash(await banded.tile(x, z)),
        placedHash(await withWholeNeighbours(await make(), x, z)),
        `tile ${x},${z}`,
      );
    assert.ok(parts > 0, 'neighbours made as bands');
  }
});

test('the default biomes on 256 m tiles (R16 and the presets) read bands, though the full reach is wider', async () => {
  // Oak crowns over 6 rounds bound the reach above a 256 m tile; the first round's reach makes 128-cell bands.
  const world = await BiomeWorld.create({ size: [768, 768], workers: 0 }),
    placement = BiomePlacement.attach(world),
    tile = world.tile.bind(world),
    part = world.tilePart.bind(world),
    whole = new Set(),
    widths = new Set();
  world.tile = (x, z, o) => {
    whole.add(`${x},${z}`);
    return tile(x, z, o);
  };
  world.tilePart = (x, z, window, o) => {
    widths.add(x === 1 ? window[3] - window[1] : window[2] - window[0]);
    return part(x, z, window, o);
  };
  assert.ok(placement.reach > world.tileSize, `reach ${placement.reach} m`);
  const placed = await placement.tile(1, 1);
  assert.deepEqual([...whole], ['1,1']);
  assert.deepEqual([...widths], [128]);
  assert.equal(
    placedHash(placed),
    placedHash(await withWholeNeighbours(await BiomeWorld.create({ size: [768, 768], workers: 0 }), 1, 1)),
  );
});

test('a neighbour the world already holds whole is read whole, not made again as a band', async () => {
  const world = await scrubWorld(),
    placement = BiomePlacement.attach(world),
    part = world.tilePart.bind(world),
    windows = new Map();
  world.tilePart = async (x, z, window, o) => {
    const p = await part(x, z, window, o);
    windows.set(`${x},${z}`, [...p.window]);
    return p;
  };
  await placement.tile(1, 1);
  assert.equal(windows.size, 8, 'an isolated tile reads bands');
  windows.clear();
  // Placing (1, 1) made that world tile whole, and the world keeps it: placing (2, 1) reads it whole.
  const placed = await placement.tile(2, 1);
  assert.deepEqual(windows.get('1,1'), [0, 0, 256, 256]);
  assert.deepEqual(windows.get('3,1'), [0, 0, 40, 256], 'a neighbour not yet made is a band');
  assert.equal(placedHash(placed), placedHash(await withWholeNeighbours(await scrubWorld(), 2, 1)));
});

test('a read past a band makes the neighbour whole, with the same bytes', async () => {
  // Parts one cell wide: every neighbour read past that cell must load the whole neighbour and run again.
  const world = await scrubWorld(),
    tile = world.tile.bind(world),
    part = world.tilePart.bind(world),
    cells = 256,
    whole = new Set();
  world.tile = (x, z, o) => {
    whole.add(`${x},${z}`);
    return tile(x, z, o);
  };
  world.tilePart = (x, z, [i0, j0, i1, j1], o) =>
    part(
      x,
      z,
      [i0 === 0 ? 0 : i1 - 1, j0 === 0 ? 0 : j1 - 1, i1 === cells ? cells : i0 + 1, j1 === cells ? cells : j0 + 1],
      o,
    );
  const placed = await BiomePlacement.attach(world).tile(2, 1);
  assert.ok(whole.size > 1, `the fallback made whole neighbours: ${[...whole].join(' ')}`);
  assert.equal(placedHash(placed), placedHash(await withWholeNeighbours(await scrubWorld(), 2, 1)));
});

test('inspect still reads whole tiles and agrees with band placement', async () => {
  const world = await scrubWorld(),
    placement = BiomePlacement.attach(world),
    placed = await placement.tile(1, 2),
    [x0, z0] = placed.origin,
    accepted = (await placement.inspect([x0, z0, x0 + 256, z0 + 256])).filter((c) => c.fate === 'accepted');
  assert.equal(accepted.length, placed.count);
});
