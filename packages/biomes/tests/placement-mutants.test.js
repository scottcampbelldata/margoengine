// Mutation testing (scripts/mutation.mjs, `node scripts/mutation.mjs biomes placement`) found parts of src/placement.ts
// that the placement goldens never reach: the validation limits of size distributions, clusters and exclusions, every
// cluster kind and size distribution together, line and polygon exclusions with verges (segment ends included), the
// tile cache (size limit, least-recently-used order, bounds) and a dense run that grows the candidate tables. Limits are
// checked on both sides of each boundary; outputs by digest, with invariants asserted beside them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { BiomePlacement } from '../dist/placement.js';
import { presetWorlds } from '../dist/presets.js';

const climate = presetWorlds.temperate.climate,
  relief = presetWorlds.temperate.relief;

function placedHash(t) {
  const h = createHash('sha256');
  h.update(
    JSON.stringify({
      x: t.x,
      z: t.z,
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
  for (const d of t.density) h.update(d.data);
  return h.digest('hex').slice(0, 24);
}

const biome = (plants, rocks = []) => [
  defineBiome({ id: 'only', climate: {}, ground: [{ material: 'grass' }], plants, rocks }),
];
const plant = (extra = {}) => ({ id: 'p', mesh: 'procedural:shrub', density: 300, radius: 0.8, ...extra });

async function world(biomes, size = 256) {
  return BiomeWorld.create({ workers: 0, seed: 21, size: [size, size], biomes, climate, height: { relief } });
}

/** Attaches a placement for the biome list; resolves to the error, or undefined when it was accepted. */
async function attachError(plants, options) {
  const w = await world(biome(plants));
  try {
    BiomePlacement.attach(w, options).dispose();
    return undefined;
  } catch (error) {
    return error;
  } finally {
    w.dispose();
  }
}

const accepts = async (plants, options) => assert.equal(await attachError(plants, options), undefined);
const rejects = async (plants, options, pattern) => {
  const error = await attachError(plants, options);
  assert.ok(error instanceof RangeError || error instanceof TypeError, `expected a throw, got ${error}`);
  if (pattern) assert.match(error.message, pattern);
};

test('size distributions: reverse-j and weibull limits are inclusive where documented and exclusive at the open end', async () => {
  const rj = (q, max) => [plant({ size: { kind: 'reverse-j', q, max } })];
  await accepts(rj(1.5, 1));
  await accepts(rj(10, 8));
  await accepts(rj(2, 0.5));
  await rejects(rj(1, 1), undefined, /reverse-j/);
  await rejects(rj(10.5, 1), undefined, /reverse-j/);
  await rejects(rj(2, 0.4), undefined, /reverse-j/);
  await rejects(rj(2, 8.5), undefined, /reverse-j/);
  const wb = (shape, scale) => [plant({ size: { kind: 'weibull', shape, scale } })];
  await accepts(wb(2, 1));
  await accepts(wb(0.5, 4));
  await accepts(wb(10, 0.5));
  await rejects(wb(0.4, 1), undefined, /weibull/);
  await rejects(wb(10.5, 1), undefined, /weibull/);
  await rejects(wb(2, 0), undefined, /weibull/);
  await rejects(wb(2, 4.5), undefined, /weibull/);
  await rejects([plant({ size: { kind: 'normal' } })], undefined, /size distribution/);
});

test('clusters: kinds, parents 0..10,000, spread 0..500, offspring above 0 and tail 0.5..8 are limited as documented', async () => {
  const cl = (extra) => [plant({ cluster: { kind: 'thomas', parents: 10, spread: 5, ...extra } })];
  await accepts(cl({}));
  await accepts(cl({ kind: 'matern' }));
  await accepts(cl({ kind: '2dt' }));
  await accepts(cl({ parents: 10000, spread: 500 }));
  await accepts(cl({ kind: '2dt', tail: 0.5 }));
  await accepts(cl({ kind: '2dt', tail: 8 }));
  await accepts(cl({ offspring: 0.001 }));
  await rejects(cl({ kind: 'poisson' }), undefined, /cluster/);
  await rejects(cl({ parents: 0 }), undefined, /cluster/);
  await rejects(cl({ parents: 10001 }), undefined, /cluster/);
  await rejects(cl({ spread: 0 }), undefined, /cluster/);
  await rejects(cl({ spread: 501 }), undefined, /cluster/);
  await rejects(cl({ offspring: 0 }), undefined, /offspring/);
  await rejects(cl({ kind: '2dt', tail: 0.4 }), undefined, /offspring|tail/);
  await rejects(cl({ kind: '2dt', tail: 8.5 }), undefined, /offspring|tail/);
});

test('exclusions: shapes need points, a line needs a width above 0, a polygon three points, a verge 0 or more', async () => {
  const w = await world(biome([plant()]));
  const line = (extra) => ({
    kind: 'line',
    points: [
      [10, 10],
      [200, 10],
    ],
    width: 4,
    ...extra,
  });
  const ok = (exclusions) => BiomePlacement.attach(w, { exclusions }).dispose();
  ok([line({})]);
  ok([line({ verge: 0 })]);
  ok([
    {
      kind: 'polygon',
      points: [
        [0, 0],
        [50, 0],
        [0, 50],
      ],
    },
  ]);
  assert.throws(() => ok([line({ width: 0 })]), RangeError);
  assert.throws(() => ok([line({ verge: -1 })]), RangeError);
  assert.throws(
    () =>
      ok([
        {
          kind: 'polygon',
          points: [
            [0, 0],
            [50, 0],
          ],
        },
      ]),
    RangeError,
  );
  assert.throws(() => ok([{ kind: 'line', points: [[0, 0]], width: 2 }]), TypeError);
  assert.throws(
    () =>
      ok([
        {
          kind: 'circle',
          points: [
            [0, 0],
            [1, 1],
          ],
        },
      ]),
    TypeError,
  );
  assert.throws(() => ok([{ kind: 'line', points: [[0, 0], [1]], width: 2 }]), TypeError);
  assert.throws(
    () =>
      ok([
        {
          kind: 'line',
          points: [
            [0, 0],
            [1, NaN],
          ],
          width: 2,
        },
      ]),
    TypeError,
  );
  w.dispose();
});

const RICH = [
  defineBiome({
    id: 'rich',
    climate: {},
    ground: [{ material: 'grass' }],
    plants: [
      {
        id: 'oak',
        mesh: 'procedural:broadleaf',
        density: 60,
        radius: 3.2,
        size: { kind: 'reverse-j', q: 1.8, max: 2 },
        stands: { scale: 90, cover: 0.6 },
        shade: 0.3,
      },
      {
        id: 'gorse',
        mesh: 'procedural:shrub',
        density: 700,
        radius: 0.9,
        size: { kind: 'weibull', shape: 2, scale: 0.8 },
        cluster: { kind: 'thomas', parents: 40, spread: 6 },
        shade: 0.8,
      },
      {
        id: 'fern',
        mesh: 'procedural:shrub',
        density: 1500,
        radius: 0.5,
        cluster: { kind: 'matern', parents: 120, spread: 4 },
        shade: 0.9,
      },
      {
        id: 'moss',
        mesh: 'procedural:shrub',
        density: 900,
        radius: 0.4,
        cluster: { kind: '2dt', parents: 80, spread: 3, tail: 2 },
        stands: { scale: 60, cover: 0.5 },
      },
    ],
    rocks: [{ id: 'stone', mesh: 'procedural:rock', density: 80, radius: 0.6 }],
  }),
];

const SHAPES = (o) =>
  [
    {
      kind: 'line',
      points: [
        [20, 30],
        [120, 60],
        [230, 200],
      ],
      width: 10,
      verge: 6,
    },
    {
      kind: 'line',
      points: [
        [200, 20],
        [200, 20.5],
      ],
      width: 6,
    },
    {
      kind: 'polygon',
      points: [
        [130, 150],
        [190, 140],
        [210, 230],
        [140, 220],
      ],
      verge: 5,
    },
    {
      kind: 'polygon',
      points: [
        [20, 190],
        [60, 190],
        [40, 240],
      ],
    },
  ].map((e) => ({ ...e, points: e.points.map(([x, z]) => [x + o, z + o]) }));

const EXPECT = {
  rich: 'a76bdeaf87366cb1cfc9a991 7e6e1629c1093120af0b8481',
  richRounds: '88a688328f6f1883b5b8b986 103d8b84d915f6ed5e212f49',
  richConflicts: '53a897c51f749533f49cd213 c7af38fb6cc26a3f3f961e03',
  richExclusions: '6ac334f0a75efd73fa12b46a 7e6e1629c1093120af0b8481',
  dense: '5b797d0248bf4ae09e996b3f',
};

async function digestOf(
  options,
  attach,
  tiles = [
    [0, 0],
    [1, 1],
  ],
) {
  const w = await BiomeWorld.create({
      workers: 0,
      seed: 33,
      size: [512, 512],
      biomes: RICH,
      climate,
      height: { relief },
    }),
    p = BiomePlacement.attach(w, attach),
    out = [];
  for (const [x, z] of tiles) out.push(placedHash(await p.tile(x, z, options)));
  w.dispose();
  return out.join(' ');
}

for (const [name, attach] of [
  ['rich', {}],
  ['richRounds', { rounds: 2 }],
  ['richConflicts', { conflicts: { 'oak|gorse': 0.2, 'fern|moss': 1.4 } }],
  ['richExclusions', { exclusions: SHAPES(-256) }],
])
  test(`placement of a world with every size, cluster and stand kind: ${name} is locked`, async () => {
    const got = await digestOf({}, attach);
    if (process.env.PRINT_DIGESTS) console.log(`DIGEST ${name} ${got}`);
    else assert.equal(got, EXPECT[name], `${name}: placement changed`);
  });

test('exclusions remove objects: a shape clears its tile area and leaves the rest as it was', async () => {
  const w = await BiomeWorld.create({
    workers: 0,
    seed: 33,
    size: [512, 512],
    biomes: RICH,
    climate,
    height: { relief },
  });
  const plain = BiomePlacement.attach(w),
    cut = BiomePlacement.attach(w, { exclusions: SHAPES(-256) });
  const a = await plain.tile(0, 0),
    b = await cut.tile(0, 0),
    far = await cut.tile(1, 1),
    far0 = await plain.tile(1, 1);
  assert.ok(b.count < a.count, `${b.count} < ${a.count}`);
  assert.equal(placedHash(far), placedHash(far0), 'a tile no shape touches is unchanged');
  w.dispose();
});

test('the tile cache returns the same tile, evicts the least recently used past 64 tiles and keeps 64', async () => {
  const w = await BiomeWorld.create({
    workers: 0,
    seed: 5,
    size: [256 * 9, 256 * 8],
    biomes: [defineBiome({ id: 'bare', climate: {}, ground: [{ material: 'grass' }] })],
    climate,
    height: { relief },
  });
  const p = BiomePlacement.attach(w);
  assert.equal(w.tilesX, 9);
  assert.equal(w.tilesZ, 8);
  const first = await p.tile(0, 0);
  assert.equal(await p.tile(0, 0), first, 'cached');
  const all = [];
  for (let k = 1; k < 64; k++) all.push([k % 9, Math.floor(k / 9)]);
  const got = [];
  for (const [x, z] of all) got.push(await p.tile(x, z));
  const second = got[0];
  assert.equal(await p.tile(0, 0), first, '64 tiles are kept');
  // touching tile (0,0) made it the most recent; the oldest is now (1,0). A 65th tile evicts it, not (0,0).
  await p.tile(8, 7);
  assert.equal(await p.tile(0, 0), first, 'a hit moves to the end: not evicted');
  assert.notEqual(await p.tile(1, 0), second, 'the least recently used tile was evicted');
  // bounds
  for (const [x, z] of [
    [-1, 0],
    [0, -1],
    [9, 0],
    [0, 8],
    [0.5, 0],
    [0, 1.5],
    [NaN, 0],
  ])
    await assert.rejects(p.tile(x, z), RangeError, `${x},${z}`);
  await p.tile(8, 7);
  await p.tile(8, 0);
  await p.tile(0, 7);
  await assert.rejects(p.tile(0, 0, { ahead: 'no' }), TypeError);
  await assert.rejects(p.tile(0, 0, { signal: AbortSignal.abort(new Error('stop')) }), /stop/);
  p.dispose();
  p.dispose();
  await assert.rejects(async () => p.tile(0, 0));
  w.dispose();
});

test('update() and onChange(): changed options drop the cache and tell listeners the world rectangle', async () => {
  const w = await world(biome([plant()]), 512);
  const p = BiomePlacement.attach(w);
  const t = await p.tile(0, 0);
  const seen = [];
  const off = p.onChange((rect) => seen.push([...rect]));
  p.update({
    exclusions: [
      {
        kind: 'polygon',
        points: [
          [0, 0],
          [30, 0],
          [0, 30],
        ],
      },
    ],
  });
  assert.notEqual(await p.tile(0, 0), t);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], [...w.bounds]);
  off();
  p.update({ conflicts: {} });
  assert.equal(seen.length, 1, 'unsubscribed');
  assert.throws(() => p.update(null), TypeError);
  assert.throws(() => p.onChange(1), TypeError);
  p.dispose();
  w.dispose();
});

test('a very dense run grows the candidate tables and keeps every invariant', async () => {
  const dense = [
    defineBiome({
      id: 'dense',
      climate: {},
      ground: [{ material: 'grass' }],
      plants: [
        {
          id: 'a',
          mesh: 'procedural:shrub',
          density: 12000,
          radius: 0.4,
          cluster: { kind: 'thomas', parents: 900, spread: 5 },
        },
        { id: 'b', mesh: 'procedural:shrub', density: 9000, radius: 0.45, stands: { scale: 70, cover: 0.7 } },
      ],
    }),
  ];
  const w = await BiomeWorld.create({
      workers: 0,
      seed: 44,
      size: [256, 256],
      biomes: dense,
      climate,
      height: { relief },
    }),
    p = BiomePlacement.attach(w),
    t = await p.tile(0, 0);
  assert.ok(t.count > 2000, `${t.count} objects`);
  assert.equal(t.stats.accepted, t.count);
  const got = placedHash(t);
  if (process.env.PRINT_DIGESTS) console.log(`DIGEST dense ${got}`);
  else assert.equal(got, EXPECT.dense);
  w.dispose();
});
