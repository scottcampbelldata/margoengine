// The fuel entry: the surface fuel model of every corner of a world, from the fuel names its species and biomes carry,
// with the northern Rockies conifer presets (the 1910 fires' country) as the real case. Fuel model values are not
// repeated in biomes: the names are checked against FUEL_MODELS of @margoengine/vfx/fire-front, the one table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { canopyCover } from '../dist/cover.js';

import { FUEL_STEP, fuelMap } from '../dist/fuel.js';
import { chaparralPresets, chaparralWorld, presets, rockiesPresets, rockiesWorld } from '../dist/presets.js';
import { pathExclusions } from '../dist/splines.js';

const { FUEL_MODELS, fireBehaviour } = await import('@margoengine/vfx/fire-front');

const pw = rockiesWorld,
  rockies = (size = 2048, extra = {}) =>
    BiomeWorld.create({
      size: [size, size],
      biomes: pw.biomes,
      climate: pw.climate,
      height: { relief: { ...pw.relief, ...extra } },
    });
const nameAt = (m, k) => (m.data[k] ? m.names[m.data[k] - 1] : null);
const tally = (m) => {
  const n = {};
  for (let k = 0; k < m.data.length; k++) n[nameAt(m, k) ?? 'none'] = (n[nameAt(m, k) ?? 'none'] ?? 0) + 1;
  return n;
};
const hash = (m) => createHash('sha256').update(m.data).update(JSON.stringify(m.names)).digest('hex');
/** The region sample at corner (i, j) of a map, clamped inside the world as fuelMap does. */
const cornerSample = (w, m, i, j) =>
  w.sampleRegion(
    Math.min(m.origin[0] + i * m.step, w.bounds[2] - 1),
    Math.min(m.origin[1] + j * m.step, w.bounds[3] - 1),
  );

test('the conifer presets name the species of the northern Rockies and Anderson 1982 fuel models that exist in fire-front', () => {
  const species = Object.values(rockiesPresets).flatMap((b) => b.plants.map((p) => [p.id, p.fuel])),
    fuel = Object.fromEntries(
      Object.values(rockiesPresets)
        .slice(0, 2)
        .flatMap((b) => b.plants.map((p) => [p.id, p.fuel])),
    );
  for (const id of ['western-white-pine', 'western-larch', 'western-red-cedar', 'douglas-fir', 'grand-fir'])
    assert.ok(id in fuel, `${id} is in a conifer preset`);
  // Anderson 1982 (INT-GTR-122): white pine, fir and larch are closed timber litter (8); old-growth Douglas-fir and
  // overmature cedar stands with deadfall are timber with heavy dead-down fuel (10).
  assert.equal(fuel['western-white-pine'], 'FM8');
  assert.equal(fuel['western-larch'], 'FM8');
  assert.equal(fuel['grand-fir'], 'FM8');
  assert.equal(fuel['douglas-fir'], 'FM10');
  assert.equal(fuel['western-red-cedar'], 'FM10');
  assert.equal(rockiesPresets['rockies-dry-forest'].openFuel, 'FM1');
  assert.equal(rockiesPresets['rockies-opening'].openFuel, 'FM1');
  assert.equal(rockiesPresets['rockies-moist-forest'].openFuel, 'FM5');
  const names = new Set([...species.map(([, f]) => f), ...Object.values(rockiesPresets).map((b) => b.openFuel)]);
  names.delete(undefined);
  for (const name of names) assert.ok(FUEL_MODELS[name], `${name} is a fuel model of fire-front`);
  // The nine presets carry no fuel names: their worlds burn nothing until a biome asks.
  for (const b of Object.values(presets)) {
    assert.equal(b.openFuel, undefined, b.id);
    for (const p of b.plants ?? []) assert.equal(p.fuel, undefined, `${b.id}/${p.id}`);
  }
});

test('timber fuel burns as Anderson describes: heavy timber outruns closed litter in the same wind, and grass outruns both', () => {
  const rate = (name) => fireBehaviour(FUEL_MODELS[name], { moisture: 0.06, wind: 4 }).rate;
  assert.ok(rate('FM10') > rate('FM8'), `${rate('FM10')} against ${rate('FM8')}`);
  assert.ok(rate('FM1') > rate('FM10'), 'grass outruns timber');
});

test('fuelMap of the rockies world: every fuel name is a model, timber dominates, openings and rock take the rest', async () => {
  using w = await rockies();
  const m = fuelMap(w, { models: FUEL_MODELS }),
    n = tally(m),
    cells = m.width * m.depth;
  assert.equal(m.step, FUEL_STEP);
  assert.equal(m.width, 2048 / 16 + 1);
  assert.deepEqual([...m.names].sort(), ['FM1', 'FM10', 'FM2', 'FM5', 'FM8']);
  assert.ok(n.FM8 / cells > 0.1 && n.FM10 / cells > 0.1, `both timber models: ${JSON.stringify(n)}`);
  assert.ok((n.FM8 + n.FM10) / cells > 0.5, `timber is most of the land: ${JSON.stringify(n)}`);
  assert.ok(n.FM5 / cells > 0.05 && n.FM1 / cells > 0.01, `brush and grass openings: ${JSON.stringify(n)}`);
  assert.ok(n.none / cells < 0.2, `little ground without fuel: ${JSON.stringify(n)}`);
  // at() reads the nearest corner and is bound.
  const { at } = m;
  assert.equal(at(m.origin[0], m.origin[1]), nameAt(m, 0));
  assert.equal(at(m.origin[0] - 100, 0), null, 'outside the world');
  assert.equal(at(1e9, 1e9), null);
  const k = Math.floor(m.data.length / 3);
  assert.equal(at(m.origin[0] + (k % m.width) * 16 + 3, m.origin[1] + Math.floor(k / m.width) * 16 - 3), nameAt(m, k));
  // The cover raster is the crown share of the fuel species, 0..255, and timber corners have enough of it.
  for (let i = 0; i < m.data.length; i++)
    if (nameAt(m, i) === 'FM8' || nameAt(m, i) === 'FM10')
      assert.ok(m.cover[i] >= 0.3 * 255 - 1, `corner ${i} cover ${m.cover[i]}`);
});

test('fuelMap: same world and options give the same bytes; a world of other seed gives a different map', async () => {
  using a = await rockies(),
    b = await rockies(),
    c = await BiomeWorld.create({
      seed: 7,
      size: [2048, 2048],
      biomes: pw.biomes,
      climate: pw.climate,
      height: { relief: pw.relief },
    });
  assert.equal(hash(fuelMap(a)), hash(fuelMap(b)));
  assert.notEqual(hash(fuelMap(a)), hash(fuelMap(c)));
});

test('fuelMap reads the same forest as canopyCover: more crown cover where the cover raster is higher', async () => {
  using w = await rockies();
  const m = fuelMap(w),
    cc = canopyCover(w);
  assert.equal(cc.width, m.width);
  let high = 0,
    low = 0,
    nh = 0,
    nl = 0;
  for (let i = 0; i < m.data.length; i++)
    if (cc.data[i] > 200) {
      high += m.cover[i];
      nh++;
    } else if (cc.data[i] < 60) {
      low += m.cover[i];
      nl++;
    }
  assert.ok(nh > 100 && nl > 20, `${nh} dense and ${nl} open corners`);
  assert.ok(high / nh > low / nl + 60, `fuel cover ${high / nh} in dense forest against ${low / nl} in the open`);
});

test('fuelMap: timber decides the open ground, and a world of fuel-less biomes burns nothing', async () => {
  using w = await rockies();
  const loose = tally(fuelMap(w, { timber: 0.05 })),
    tight = tally(fuelMap(w, { timber: 0.95 })),
    open = (n) => (n.FM1 ?? 0) + (n.FM5 ?? 0);
  assert.ok(open(tight) > 2 * open(loose), `${JSON.stringify([loose, tight])}`);
  using none = await BiomeWorld.create({ size: [512, 512], biomes: [presets.temperate] });
  const m = fuelMap(none);
  assert.equal(m.names.length, 0);
  assert.ok(m.data.every((v) => v === 0));
  assert.equal(m.at(0, 0), null);
});

test('fuelMap: no fuel on bare rock, near water or under the sea', async () => {
  using w = await rockies(2048, { rivers: 2 });
  const m = fuelMap(w, { rockSlope: 20, water: 12 }),
    tan20 = Math.tan((20.5 * Math.PI) / 180);
  let steep = 0,
    wet = 0;
  for (let j = 0; j < m.depth; j++)
    for (let i = 0; i < m.width; i++) {
      const s = cornerSample(w, m, i, j);
      if (s.slope > tan20) {
        steep++;
        assert.equal(m.data[j * m.width + i], 0, `steep corner ${i},${j}`);
      }
      if (s.waterDistance < 12) {
        wet++;
        assert.equal(m.data[j * m.width + i], 0, `wet corner ${i},${j}`);
      }
    }
  assert.ok(steep > 20 && wet > 5, `${steep} steep and ${wet} wet corners`);
  const gentle = fuelMap(w, { rockSlope: 60, water: 0 }),
    bare = (map) => map.data.filter((v) => v === 0).length;
  assert.ok(bare(gentle) < bare(m), `${bare(gentle)} against ${bare(m)} corners without fuel`);
  using sea = await BiomeWorld.create({
    size: [1024, 1024],
    biomes: pw.biomes,
    climate: pw.climate,
    height: { relief: { relief: 200, base: 20, coast: 'island' } },
  });
  const s = fuelMap(sea);
  let under = 0;
  for (let j = 0; j < s.depth; j++)
    for (let i = 0; i < s.width; i++)
      if (cornerSample(sea, s, i, j).height * 1000 < sea.climate.sea) {
        under++;
        assert.equal(s.data[j * s.width + i], 0, `sea corner ${i},${j}`);
      }
  assert.ok(under > 50, `${under} corners under the sea`);
});

test('fuelMap: roads and house footprints cut the map, slash patches set their own fuel, in order', async () => {
  using w = await rockies();
  const a = [-800, 0],
    b = [800, 40],
    road = { points: [a, b], width: 6, edge: 2 },
    plain = fuelMap(w),
    cut = fuelMap(w, { bare: pathExclusions([road]) }),
    // Distance of a point to the road's centre line.
    away = (x, z) => {
      const dx = b[0] - a[0],
        dz = b[1] - a[1],
        t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
      return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
    };
  let on = 0,
    off = 0;
  for (let j = 0; j < cut.depth; j++)
    for (let i = 0; i < cut.width; i++) {
      const k = j * cut.width + i,
        d = away(cut.origin[0] + i * 16, cut.origin[1] + j * 16);
      // Half the width plus half a step.
      if (d <= 3 + 8) {
        assert.equal(cut.data[k], 0, `road corner ${i},${j}`);
        on++;
      } else {
        assert.equal(nameAt(cut, k), nameAt(plain, k), `untouched corner ${i},${j}`);
        off++;
      }
    }
  assert.ok(on > 100 && off > 10000, `${on} corners on the road, ${off} off it`);
  assert.ok(
    Array.from(plain.data).some((v, k) => v && !cut.data[k]),
    'the road took fuel the plain map had',
  );
  const house = {
      kind: 'polygon',
      points: [
        [100, 100],
        [140, 100],
        [140, 130],
        [100, 130],
      ],
    },
    square = (x0, z0, x1, z1) => [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ],
    slash = { kind: 'polygon', points: square(-300, -300, -200, -200), fuel: 'FM12' },
    clear = { kind: 'polygon', points: square(-260, -260, -240, -240), fuel: null },
    m = fuelMap(w, { bare: [house], patches: [slash, clear], models: FUEL_MODELS });
  assert.equal(m.at(120, 115), null, 'inside the house');
  assert.equal(m.at(-290, -290), 'FM12', 'cut-over');
  assert.equal(m.at(-250, -250), null, 'a later patch clears the earlier one');
  assert.equal(m.at(-210, -210), 'FM12');
  assert.ok(m.names.includes('FM12'));
  assert.equal(m.at(-215, 300), plain.at(-215, 300), 'fuel is untouched outside the shapes');
});

test('fuelMap: bad options throw before any work, naming the option', async () => {
  using w = await rockies(512);
  const tri = [
    [0, 0],
    [1, 0],
    [1, 1],
  ];
  assert.throws(() => fuelMap(w, { step: 7.5 }), { name: 'RangeError', message: /step/ });
  assert.throws(() => fuelMap(w, { step: 0 }), RangeError);
  assert.throws(() => fuelMap(w, { timber: 2 }), { message: /timber/ });
  assert.throws(() => fuelMap(w, { rockSlope: 5 }), { message: /rockSlope/ });
  assert.throws(() => fuelMap(w, { water: -1 }), { message: /water/ });
  assert.throws(() => fuelMap(w, { bare: [{ kind: 'line', points: [[0, 0]], width: 3 }] }), TypeError);
  assert.throws(
    () =>
      fuelMap(w, {
        bare: [
          {
            kind: 'line',
            points: [
              [0, 0],
              [1, 1],
            ],
            width: 0,
          },
        ],
      }),
    TypeError,
  );
  assert.throws(() => fuelMap(w, { patches: [{ kind: 'polygon', points: tri, fuel: 7 }] }), TypeError);
  assert.throws(() => fuelMap(w, { models: { FM1: {} } }), {
    name: 'RangeError',
    message: /unknown fuel model "FM\d+"/,
  });
  assert.throws(() => fuelMap(w, { models: FUEL_MODELS, patches: [{ kind: 'polygon', points: tri, fuel: 'FM99' }] }), {
    message: /FM99/,
  });
  assert.throws(() => fuelMap(w, null), TypeError);
});

test('defineBiome accepts fuel names and rejects other values', () => {
  const base = { id: 'x', climate: {}, ground: [{ material: 'grass' }] },
    plant = { id: 'p', mesh: 'procedural:conifer', density: 1, radius: 1 };
  assert.equal(defineBiome({ ...base, openFuel: 'FM1', plants: [{ ...plant, fuel: 'FM8' }] }).plants[0].fuel, 'FM8');
  assert.throws(() => defineBiome({ ...base, plants: [{ ...plant, fuel: 8 }] }), TypeError);
  assert.throws(() => defineBiome({ ...base, plants: [{ ...plant, fuel: '' }] }), TypeError);
  assert.throws(() => defineBiome({ ...base, openFuel: 'not a name' }), TypeError);
  assert.throws(() => defineBiome({ ...base, openFuel: 3 }), TypeError);
});

test('the southern California presets: chaparral is model 4, sage scrub and brush gaps model 6, oak litter 9, open oak grass 2 (Anderson 1982)', async () => {
  assert.deepEqual(Object.keys(chaparralPresets), ['chaparral', 'coastal-sage-scrub', 'oak-woodland']);
  const fuel = Object.fromEntries(Object.values(chaparralPresets).flatMap((b) => b.plants.map((p) => [p.id, p.fuel])));
  for (const id of ['chamise', 'bigberry-manzanita', 'hoaryleaf-ceanothus', 'scrub-oak']) assert.equal(fuel[id], 'FM4', id);
  for (const id of ['california-sagebrush', 'black-sage', 'california-buckwheat', 'toyon']) assert.equal(fuel[id], 'FM6', id);
  assert.equal(fuel['coast-live-oak'], 'FM9');
  assert.equal(fuel['blue-oak'], 'FM2');
  assert.equal(chaparralPresets.chaparral.openFuel, 'FM6');
  assert.equal(chaparralPresets['coastal-sage-scrub'].openFuel, 'FM1');
  assert.equal(chaparralPresets['oak-woodland'].openFuel, 'FM1');
  for (const b of Object.values(chaparralPresets)) {
    assert.ok(Object.isFrozen(b) && Object.isFrozen(b.climate), b.id);
    assert.deepEqual(defineBiome(JSON.parse(JSON.stringify(b))), b, `${b.id} round-trips through JSON`);
    for (const name of [b.openFuel, ...b.plants.map((p) => p.fuel)]) assert.ok(FUEL_MODELS[name], `${b.id}: ${name} is a fire-front model`);
  }
  // Anderson's rates at 5 mi/h: chaparral (4) outruns brush (6), and grass (1) outruns oak litter (9).
  const rate = (name) => fireBehaviour(FUEL_MODELS[name], { moisture: 0.06, wind: 2.2352 }).rate;
  assert.ok(rate('FM4') > rate('FM6') && rate('FM1') > rate('FM9'));
  using w = await BiomeWorld.create({
    size: [2048, 2048],
    biomes: chaparralWorld.biomes,
    climate: chaparralWorld.climate,
    height: { relief: chaparralWorld.relief },
  });
  const share = new Map();
  for (let z = -1000; z < 1000; z += 16)
    for (let x = -1000; x < 1000; x += 16) {
      const id = w.sampleRegion(x, z).biomes[0];
      share.set(id, (share.get(id) ?? 0) + 1);
    }
  for (const id of Object.keys(chaparralPresets)) assert.ok(share.get(id) > 40, `${id}: ${share.get(id)} of 15,625 corners`);
  const m = fuelMap(w, { models: FUEL_MODELS }),
    n = tally(m);
  for (const name of ['FM4', 'FM6', 'FM1']) assert.ok(n[name] > 20, `${name} burns somewhere: ${JSON.stringify(n)}`);
});
