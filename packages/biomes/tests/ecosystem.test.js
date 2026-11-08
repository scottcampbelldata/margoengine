// @margoengine/biomes/ecosystem: a few founders seed a plot full and close its canopy; a dense stand thins itself as
// crowns close (fewer, larger plants); under a closed canopy a shade-tolerant species outlives an intolerant one;
// plants past their lifespan die; seedlings land around their parent at the 2Dt kernel's distances (median the
// dispersal scale) and only inside the bounds and where `where` lets them; the same start gives the same forest; bad
// options fail with a message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { BiomePlacement } from '../dist/placement.js';
import { growEcosystem, plantsFromTile } from '../dist/ecosystem.js';

const birch = { id: 'birch', radius: 3, growth: 0.3, age: 80, shade: 0.1, seeds: 6, dispersal: 8 },
  beech = { id: 'beech', radius: 5, growth: 0.12, age: 250, shade: 0.9, seeds: 3, dispersal: 6 },
  plot = [0, 0, 60, 60];
const mean = (plants) => plants.reduce((s, p) => s + p.radius, 0) / plants.length;

test('a few founders seed the plot full and close the canopy', () => {
  const founders = [10, 30, 50].flatMap((x) => [10, 30, 50].map((z) => ({ species: 'birch', x, z, radius: 1.5 }))),
    run = (years) => growEcosystem({ bounds: plot, species: [birch], plants: founders, years, seed: 4 }),
    early = run(15),
    late = run(60),
    mature = late.plants.filter((p) => p.died === undefined && p.radius >= 0.4 * birch.radius),
    cover = mature.reduce((s, p) => s + Math.PI * p.radius * p.radius, 0) / 3600;
  assert.ok(early.counts.birch > 3 * founders.length, `${early.counts.birch} birches after 15 years`);
  assert.ok(mature.length > 5 * founders.length, `${mature.length} seeding birches after 60 years`);
  assert.ok(cover > 0.6, `crown cover ${cover.toFixed(2)}`);
  for (const p of late.plants) assert.ok(p.radius <= 3 && p.x >= -1 && p.x <= 61, 'crowns stay within the species');
});

test('a dense even-aged stand thins itself as crowns close: fewer, larger plants', () => {
  const planted = [];
  for (let x = 1.5; x < 60; x += 3)
    for (let z = 1.5; z < 60; z += 3) planted.push({ species: 'birch', x, z, radius: 0.2 });
  const alive = (years) =>
      growEcosystem({ bounds: plot, species: [{ ...birch, seeds: 0 }], plants: planted, years, seed: 4 }).plants.filter(
        (p) => p.died === undefined,
      ),
    stages = [10, 20, 40].map(alive);
  for (let i = 1; i < stages.length; i++) {
    assert.ok(stages[i].length < stages[i - 1].length, `${stages[i].length} after ${stages[i - 1].length}`);
    assert.ok(mean(stages[i]) > mean(stages[i - 1]), 'and the survivors are larger');
  }
  assert.ok(stages[2].length < planted.length / 3, `${stages[2].length} of ${planted.length} left`);
});

test('under a closed canopy the shade-tolerant species wins the understorey', () => {
  const canopy = [];
  for (let x = 2; x < 60; x += 4)
    for (let z = 2; z < 60; z += 4) canopy.push({ species: 'beech', x, z, radius: 4.5, age: 60 });
  const seedlings = [];
  for (let x = 1; x < 60; x += 3)
    for (let z = 1; z < 60; z += 3) seedlings.push({ species: (x + z) % 2 ? 'birch' : 'beech', x, z, radius: 0.2 });
  const before = { birch: 0, beech: 0 };
  for (const s of seedlings) before[s.species]++;
  const r = growEcosystem({
      bounds: plot,
      species: [
        { ...birch, seeds: 0 },
        { ...beech, seeds: 0 },
      ],
      plants: [...canopy, ...seedlings],
      years: 20,
      seed: 1,
    }),
    small = (id) => r.plants.filter((p) => p.died === undefined && p.species === id && p.radius < 4).length;
  assert.ok(small('beech') / before.beech > 2 * (small('birch') / before.birch + 0.01), 'tolerant seedlings survive');
});

test('plants past their lifespan die; snags stand for their years and are gone', () => {
  const r = growEcosystem({
    bounds: plot,
    species: [{ ...birch, age: 10, seeds: 0 }],
    plants: [{ species: 'birch', x: 30, z: 30, radius: 3, age: 9 }],
    years: 40,
    snags: 5,
  });
  assert.equal(r.counts.birch ?? 0, 0);
  assert.equal(r.plants.length, 0, 'the snag fell');
  const died = r.history.findIndex((h) => h.died === 1) + 1;
  assert.ok(died > 0 && died < 30, `died in year ${died}`);
});

test('seedlings land around the parent, inside the bounds and where `where` allows', () => {
  const r = growEcosystem({
      bounds: [0, 0, 200, 200],
      species: [{ ...beech, seeds: 50, dispersal: 10, maturity: 0 }],
      plants: [{ species: 'beech', x: 100, z: 100, radius: 5, age: 50 }],
      years: 1,
      seed: 7,
      where: (x) => (x < 100 ? 1 : 0),
    }),
    kids = r.plants.slice(1);
  assert.ok(kids.length > 10, `${kids.length} seedlings`);
  assert.ok(
    kids.every((p) => p.x < 100 && p.age === 0),
    'only west of the parent',
  );
  const d = kids.map((p) => Math.hypot(p.x - 100, p.z - 100)).sort((a, b) => a - b);
  assert.ok(d[d.length >> 1] > 5 && d[d.length >> 1] < 20, `median distance ${d[d.length >> 1]} m, scale 10 m`);
});

test('the same start gives the same forest; another seed another one', () => {
  const o = {
    bounds: plot,
    species: [birch, beech],
    plants: [
      { species: 'birch', x: 20, z: 20, radius: 2 },
      { species: 'beech', x: 40, z: 40, radius: 3 },
    ],
    years: 30,
    seed: 2,
  };
  assert.equal(JSON.stringify(growEcosystem(o)), JSON.stringify(growEcosystem(o)));
  assert.notEqual(JSON.stringify(growEcosystem(o)), JSON.stringify(growEcosystem({ ...o, seed: 3 })));
});

test('a placed tile gives founders; bad options fail with a message', async () => {
  const world = await BiomeWorld.create({
      seed: 3,
      size: [512, 512],
      biomes: [
        defineBiome({
          id: 'wood',
          climate: {},
          ground: [{ material: 'grass' }],
          plants: [{ id: 'oak', mesh: 'procedural:broadleaf', density: 80, radius: 4 }],
        }),
      ],
    }),
    p = BiomePlacement.attach(world),
    founders = plantsFromTile(p, await p.tile(0, 0));
  assert.ok(founders.length > 10 && founders.every((f) => f.species === 'wood/oak' && f.radius > 0));
  const r = growEcosystem({
    bounds: world.bounds.slice(0, 2).concat([world.bounds[0] + 256, world.bounds[1] + 256]),
    species: [{ id: 'wood/oak', radius: 8 }],
    plants: founders,
    years: 5,
  });
  assert.ok(r.counts['wood/oak'] > 0);
  const bad = (o) => assert.throws(() => growEcosystem({ bounds: plot, species: [birch], years: 1, ...o }));
  bad({ bounds: [0, 0, 0, 10] });
  bad({ species: [] });
  bad({ species: [birch, birch] });
  bad({ years: 1.5 });
  bad({ plants: [{ species: 'oak', x: 0, z: 0 }] });
  bad({ species: [{ ...birch, radius: 100 }] });
  bad({ species: [{ ...birch, seeds: 65 }] });
  bad({ bounds: [0, 0, 200000, 10] });
  bad({ plants: [{ species: 'birch', x: -100001, z: 0 }] });
  bad({ plants: [null] });
});
