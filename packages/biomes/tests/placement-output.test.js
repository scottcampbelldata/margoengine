// Every byte of placed tiles, locked: the preset worlds and seeds of the placement goldens, an interior and an edge tile
// of a 3 x 3 preset world, 512 m tiles of the default biomes, a world of small plants (interior, edge and corner) and
// two R16 tiles beside the G1 bench tiles. The hashes were recorded from 14e4d813d, before placement stopped making
// whole neighbour tiles (biomes J2); a change to how placement reads its neighbours must leave every one of them.
// MARGO_RECORD=1 prints the hashes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { BiomePlacement } from '../dist/placement.js';
import { R16, presets, presetWorlds } from '../dist/presets.js';

const golden = JSON.parse(readFileSync(new URL('./golden/placed-tiles.json', import.meta.url), 'utf8'));

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
      canopy: [t.canopy.width, t.canopy.depth],
      exclusion: [t.exclusion.width, t.exclusion.depth],
      density: t.density.map((d) => [d.id, d.mesh, d.density]),
    }),
  );
  h.update(t.instances);
  h.update(t.canopy.data);
  h.update(t.exclusion.data);
  for (const d of t.density) h.update(d.data);
  return h.digest('hex');
}

const presetOptions = (id) => ({
  biomes: Object.values(presets).filter((b) => b.id !== 'beach'),
  climate: presetWorlds[id].climate,
  height: { relief: presetWorlds[id].relief },
});

/** Small crowns: the placement reach stays well inside a 256 m tile. */
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

/** [key prefix, world options, tiles]. */
const cases = [
  ...['temperate', 'boreal', 'alpine', 'savanna', 'desert'].flatMap((id) =>
    [1, 0xffffffff].map((seed) => [`${id}-${seed}`, { seed, size: [512, 512], ...presetOptions(id) }, [[1, 0]]]),
  ),
  [
    'temperate-768',
    { size: [768, 768], ...presetOptions('temperate') },
    [
      [1, 1],
      [1, 0],
    ],
  ],
  [
    'default-512m-tiles',
    {
      size: [1536, 1536],
      tileSize: 512,
      climate: presetWorlds.temperate.climate,
      height: { relief: presetWorlds.temperate.relief },
    },
    [
      [1, 1],
      [0, 1],
    ],
  ],
  [
    'scrub',
    {
      seed: 11,
      size: [1024, 1024],
      height: { relief: presetWorlds.temperate.relief },
      climate: presetWorlds.temperate.climate,
      biomes: scrub,
    },
    [
      [1, 1],
      [2, 0],
      [3, 3],
    ],
  ],
  [
    'R16',
    { seed: R16.seed, origin: R16.origin, size: R16.size, height: { relief: R16.relief }, climate: R16.climate },
    [
      [40, 30],
      [41, 30],
    ],
  ],
];

test('placed tiles: every byte matches the hashes recorded before band loading', async () => {
  const got = {};
  for (const [key, options, tiles] of cases) {
    const world = await BiomeWorld.create({ workers: 0, ...options }),
      placement = BiomePlacement.attach(world);
    for (const [x, z] of tiles) got[`${key} ${x},${z}`] = placedHash(await placement.tile(x, z));
    world.dispose();
  }
  if (process.env.MARGO_RECORD) console.log(JSON.stringify(got, null, 2));
  assert.deepEqual(Object.keys(got), Object.keys(golden));
  for (const [k, v] of Object.entries(got)) assert.equal(v, golden[k], k);
});
