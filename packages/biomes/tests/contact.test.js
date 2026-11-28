// Objects meet the ground: a species' `sink` and `alignToGround` reach its scatters (until 2026-11-28 both were
// declared and ignored, so biome stones stood on the surface and floated downhill, KB-BIOMES-SINK1), and by default
// stones and trunks get a foot and trees less sky light low in the crown, a tree's litter apron follows its crown and
// the grass opens around every foot (it hid the ground's soil ring).
import assert from 'node:assert/strict';
import { test } from 'node:test';

const attach = async (options = {}) => {
  const { BiomeWorld, defineBiome } = await import('../dist/index.js'),
    { BiomePlacement } = await import('../dist/placement.js'),
    { BiomeObjects } = await import('../dist/objects.js'),
    biome = defineBiome({
      id: 'fell',
      climate: {},
      ground: [{ material: 'grass' }],
      details: [{ id: 'tuft', mesh: 'procedural:grass', density: 4 }],
      plants: [
        {
          id: 'fir',
          mesh: 'procedural:conifer',
          density: 100,
          radius: 2,
          sink: 0.27,
          color: { hue: 0.7, value: 0.3 },
          stands: { scale: 60, cover: 0.8 },
        },
      ],
      rocks: [{ id: 'stone', mesh: 'procedural:rock', density: 20, radius: 0.4, sink: 0.12, alignToGround: 0.65 }],
    }),
    dry = defineBiome({
      id: 'dunes',
      climate: {},
      ground: [{ material: 'sand' }],
      rocks: [{ id: 'stone', mesh: 'procedural:rock', density: 20, radius: 0.4 }],
    }),
    world = await BiomeWorld.create({ size: [256, 256], biomes: [biome, dry], height: { field: () => 10 } }),
    attached = [],
    engine = { camera: { position: [0, 0, 0] }, use: (plugin) => attached.push(plugin) },
    placement = BiomePlacement.attach(world),
    objects = await BiomeObjects.attach(engine, placement, {
      heightmap: () => undefined,
      bounds: [-128, -128, 128, 128],
      ...options,
    });
  const species = Object.fromEntries(placement.species.map((s) => [s.key, s]));
  // Casters come species by species in the palette's order, a tree's trunk before its crown, then the snags.
  const parts = {};
  let next = 0;
  for (const s of placement.species) {
    // A conifer is a trunk and a crown; a procedural rock draws eight seeded stones (KB-BIOMES-ROCKSEED1).
    const count = s.mesh === 'procedural:conifer' ? 2 : 8;
    parts[s.key] = objects.casters.slice(next, (next += count)).map((c) => c.options);
  }
  const done = () => {
    objects.dispose();
    placement.dispose?.();
    world.dispose();
  };
  return { species, parts, done, objects, placement };
};

test('a species sink and alignToGround reach its scatters', async () => {
  const { species, parts, done } = await attach();
  assert.equal(species['fell/stone'].sink, 0.12);
  assert.equal(species['fell/stone'].alignToGround, 0.65);
  assert.equal(species['fell/fir'].cover, 0.8);
  assert.equal(species['dunes/stone'].sink, undefined);
  const [stone] = parts['fell/stone'];
  assert.equal(stone.sink, 0.12);
  assert.equal(stone.alignToGround, 0.65);
  for (const part of parts['fell/fir']) assert.equal(part.sink, 0.27);
  assert.equal(parts['dunes/stone'][0].sink, undefined);
  done();
});

test("a species' colour jitter reaches its leaves and stone, never its bark (KB-BIOMES-SPECIESCOLOR1)", async () => {
  const { species, parts, done } = await attach(),
    [trunk, crown] = parts['fell/fir'],
    [stone] = parts['fell/stone'];
  assert.deepEqual(species['fell/fir'].variation, { hue: 0.5, value: 0.3 }, 'a hue past half a turn is half a turn');
  assert.equal(species['fell/stone'].variation, undefined);
  assert.deepEqual(crown.variation, { hue: 0.5, value: 0.3 });
  assert.deepEqual(trunk.variation, { hue: 0.02, value: 0.1 });
  assert.deepEqual(stone.variation, { hue: 0.02, value: 0.1 }, "a rule without a colour keeps the kind's");
  done();
});

test('stones and trunks get a foot and trees keep less sky light low down; contact: false leaves them out', async () => {
  const { parts, done } = await attach(),
    [stone] = parts['fell/stone'],
    [dry] = parts['dunes/stone'],
    [trunk, crown] = parts['fell/fir'];
  assert.deepEqual(stone.base.tint, [0.07, 0.1, 0.03], 'moss at the foot of a stone on grass');
  assert.ok(stone.base.height > 0 && stone.base.height <= 0.25 && stone.base.shade === 0.5);
  assert.equal(dry.base.tint, undefined, 'no moss in dunes');
  assert.equal(stone.skyOcclusion, undefined);
  assert.ok(trunk.base.height > 0 && trunk.base.height <= 0.35);
  assert.deepEqual(trunk.base.tint, [0.1, 0.08, 0.055]);
  assert.equal(crown.base, undefined);
  assert.ok(Math.abs(trunk.skyOcclusion.depth - 0.5 * 0.8) < 1e-12);
  const { crown: inside, ...canopy } = crown.skyOcclusion;
  assert.deepEqual(trunk.skyOcclusion, canopy, 'one tree, one height; wood has no crown of its own to shade it');
  assert.ok(crown.skyOcclusion.height > 2);
  assert.equal(inside.depth, 1.2, 'the foliage shades itself');
  assert.ok(inside.radius > 0.5 && Math.abs(inside.top - 2 * canopy.height) < 1e-9, JSON.stringify(inside));
  done();
  const off = await attach({ contact: false });
  for (const list of Object.values(off.parts))
    for (const part of list) assert.ok(part.base === undefined && part.skyOcclusion === undefined);
  assert.equal(off.parts['fell/stone'][0].sink, 0.12, 'the bedding stays');
  off.done();
});

test('a tile presses its stones and trunks into the ground it is given, and takes them back', async () => {
  const held = new Map(),
    ground = { set: (key, list) => held.set(key, [...list]), remove: (key) => held.delete(key) },
    { parts, done, objects, placement } = await attach({ ground }),
    // One stone at a quarter of the tile, scale 2 (log scale 160), and one fir at its middle, scale 1.
    record = (x, z, species, scale) => [x & 255, x >> 8, z & 255, z >> 8, species, scale, 0, 0],
    index = (key) => placement.species.findIndex((s) => s.key === key),
    tile = {
      x: 0,
      z: 0,
      origin: [0, 0],
      size: 256,
      count: 2,
      species: placement.species.map((s) => s.key),
      instances: new Uint8Array([
        ...record(16384, 16384, index('fell/stone'), 160),
        ...record(32768, 32768, index('fell/fir'), 128),
      ]),
      density: [],
    };
  assert.ok(parts);
  objects.add(tile);
  const list = held.get('0,0');
  assert.equal(list.length, 8, `two footprints: ${list}`);
  const feet = [list.slice(0, 4), list.slice(4)].sort((a, b) => a[0] - b[0]);
  assert.deepEqual([feet[0][0], feet[0][1], feet[0][3]], [64, 64, 1], 'the stone');
  assert.deepEqual([feet[1][0], feet[1][1], feet[1][3]], [128, 128, 0], 'the trunk');
  assert.ok(feet[0][2] > feet[1][2] && feet[1][2] > 0.02 && feet[1][2] < 1, `radii ${feet[0][2]}, ${feet[1][2]}`);
  objects.remove('0,0');
  assert.equal(held.size, 0);
  done();
});

/** A form of two triangles: wood reaching `trunk` metres at its foot and a crown reaching `crown` metres at 3 m. */
const form = (trunk, crown) =>
  [
    ['bark', trunk, 0],
    ['foliage', crown, 3],
  ].map(([kind, reach, y]) => ({
    kind,
    color: [0.1, 0.1, 0.1],
    geometry: {
      positions: [reach, y, 0, 0, y, 0, 0, y + 0.1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
    },
  }));

test("a tree's footprint is 0.3 of its crown's reach, or its trunk's where that is wider", async () => {
  for (const [trunk, crown, want] of [
    [0.1, 2, 0.6],
    [0.5, 1, 0.5],
  ]) {
    const held = new Map(),
      ground = { set: (key, list) => held.set(key, [...list]), remove: (key) => held.delete(key) },
      { done, objects, placement } = await attach({ ground, meshes: { 'procedural:conifer': form(trunk, crown) } }),
      fir = placement.species.findIndex((s) => s.key === 'fell/fir');
    objects.add({
      x: 0,
      z: 0,
      origin: [0, 0],
      size: 256,
      count: 1,
      species: placement.species.map((s) => s.key),
      instances: new Uint8Array([0, 128, 0, 128, fir, 128, 0, 0]),
      density: [],
    });
    const [, , radius, kind] = held.get('0,0');
    assert.ok(Math.abs(radius - want) < 1e-6, `trunk ${trunk}, crown ${crown}: ${radius}, ${want}`);
    assert.equal(kind, 0);
    done();
  }
});

test("the detail opens around the ground's feet by default; groundCover and a ground without a mask leave it", async () => {
  const ground = { set() {}, remove() {}, mask: () => undefined },
    detail = (objects) => objects.swaying.filter((s) => s.options.densityMap);
  const on = await attach({ ground });
  assert.equal(detail(on.objects).length, 2, 'the grass field and its near layer');
  for (const grass of detail(on.objects)) assert.equal(grass.options.thinning, on.objects.groundCover);
  assert.deepEqual(on.objects.groundCover.look, { thin: 1.4, shorten: 0.6, reach: 0.25 });
  for (const part of on.objects.casters) assert.equal(part.options.thinning, undefined, 'objects are not thinned');
  on.done();
  const look = await attach({ ground, groundCover: { thin: 3 } });
  assert.equal(look.objects.groundCover.look.thin, 3);
  look.done();
  for (const options of [{ ground, groundCover: false }, { ground: { set() {}, remove() {} } }, {}]) {
    const off = await attach(options);
    assert.equal(off.objects.groundCover, undefined);
    for (const grass of detail(off.objects)) assert.equal(grass.options.thinning, undefined);
    off.done();
  }
});
