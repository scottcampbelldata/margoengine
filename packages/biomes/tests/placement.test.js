// B5: stored-object placement. Records and decoding; the hard core across tile seams; tile order and tile size
// independence; the lazy rounds equal a brute-force run of Luby's rounds; the unresolved share; exclusions, shade, edges
// and canopy layers; golden digests; and the quality gates of goal G7: global envelope tests (studentised maximum
// deviation, 199 simulations; the extreme rank length with 2,499 when MARGO_NIGHTLY is set) against independent float
// samplers of the target processes, size distributions by Kolmogorov-Smirnov and Anderson-Darling, and the
// size-density frontier inside each preset's self-thinning band. Plus the CPU time budget (G1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuTimer } from '../../../scripts/support/cpu-budget.mjs';
import { readFileSync } from 'node:fs';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { BiomeEditor } from '../dist/editor.js';
import { BiomePlacement } from '../dist/placement.js';
import { presets, presetWorlds } from '../dist/presets.js';
import { createRelief } from '../dist/relief.js';
import {
  andersonDarling,
  globalEnvelope,
  ksTest,
  lFunction,
  nearestG,
  pairCorrelation,
  quantileFit,
} from '../dist/stats.js';
import { random } from './random.js';

const golden = JSON.parse(readFileSync(new URL('./golden/placement.json', import.meta.url), 'utf8'));
const NIGHTLY = !!process.env.MARGO_NIGHTLY;

/** A flat single-biome world holding the given species rules. */
const stand = (plants, extra = {}, size = 512) =>
  BiomeWorld.create({
    size: [size, size],
    seed: extra.seed ?? 7,
    height: { field: () => 100 },
    climate: { coldAir: 0 },
    biomes: [
      defineBiome({ id: 'stand', climate: {}, ground: [{ material: 'grass' }], plants, ...(extra.biome ?? {}) }),
    ],
  });

test('records: 8 bytes each, sorted by species then z then x, decoding inside the tile', async () => {
  const w = await BiomeWorld.create({ size: [1024, 1024], ...presetWorldOptions('temperate') }),
    p = BiomePlacement.attach(w),
    t = await p.tile(1, 1);
  assert.ok(t.count > 500, `objects ${t.count}`);
  assert.equal(t.instances.length, t.count * 8);
  let last = -1;
  for (let k = 0; k < t.count; k++) {
    const at = k * 8,
      key =
        t.instances[at + 4] * 2 ** 32 +
        ((t.instances[at + 3] << 8) | t.instances[at + 2]) * 65536 +
        ((t.instances[at + 1] << 8) | t.instances[at]);
    assert.ok(key > last, 'sorted');
    last = key;
  }
  let n = 0;
  t.forEachInstance((i) => {
    n++;
    assert.ok(i.x >= t.origin[0] && i.x < t.origin[0] + t.size && i.z >= t.origin[1] && i.z < t.origin[1] + t.size);
    assert.ok(i.scale > 0.05 && i.scale < 8 && i.yaw >= 0 && i.yaw < 2 * Math.PI && i.age <= 3);
    assert.ok(t.species.includes(i.key));
  });
  assert.equal(n, t.count);
  assert.deepEqual(
    [...t.species],
    p.species.map((s) => s.key).filter((k) => t.species.includes(k)),
  );
  assert.equal(t.canopy.data.length, 256 * 256);
  assert.ok(t.canopy.data.some((v) => v === 255) && t.canopy.data.some((v) => v === 0));
  assert.deepEqual(
    t.density.map((d) => d.id),
    [...new Set(Object.values(presets).flatMap((b) => (b.details ?? []).map((d) => d.id)))],
  );
  assert.ok(
    t.density.find((d) => d.id === 'grass').data.some((v) => v > 0),
    'temperate grass grows',
  );
});

function presetWorldOptions(id) {
  const pw = presetWorlds[id];
  return {
    biomes: Object.values(presets).filter((b) => b.id !== 'beach'),
    climate: pw.climate,
    height: { relief: pw.relief },
  };
}

test('hard core: no two objects of a layer (or of two layers) closer than their spacing, across tile seams', async () => {
  const w = await BiomeWorld.create({ size: [768, 768], ...presetWorldOptions('boreal') }),
    p = BiomePlacement.attach(w),
    all = (await p.inspect([w.bounds[0] + 128, w.bounds[1] + 128, w.bounds[0] + 640, w.bounds[1] + 640])).filter(
      (c) => c.fate === 'accepted',
    );
  assert.ok(all.length > 2000, `objects ${all.length}`);
  const cell = 16,
    grid = new Map();
  for (const c of all) {
    const k = `${Math.floor(c.x / cell)},${Math.floor(c.z / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(c);
  }
  let pairs = 0;
  for (const c of all)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const o of grid.get(`${Math.floor(c.x / cell) + dx},${Math.floor(c.z / cell) + dz}`) ?? []) {
          if (o === c) continue;
          const f = o.layer === c.layer ? 0.85 : 0.3,
            d = Math.hypot(o.x - c.x, o.z - c.z);
          pairs++;
          // 1/256 m ticks and Q16 factors: allow one tick of rounding.
          assert.ok(d >= f * (o.spacing + c.spacing) - 2 / 256, `${c.key} and ${o.key} ${d.toFixed(3)} m apart`);
        }
  assert.ok(pairs > 1000);
  // Each object belongs to exactly one tile: the tiles' records add up to the objects of the area.
  let count = 0;
  for (let z = 1; z <= 1; z++) for (let x = 1; x <= 1; x++) count += (await p.tile(x, z)).count;
  assert.equal(
    count,
    all.filter(
      (c) => c.x >= w.bounds[0] + 256 && c.x < w.bounds[0] + 512 && c.z >= w.bounds[1] + 256 && c.z < w.bounds[1] + 512,
    ).length,
  );
});

test('tile order, fresh placements and tile size give the same objects', async () => {
  const options = { size: [1024, 1024], ...presetWorldOptions('temperate') },
    a = BiomePlacement.attach(await BiomeWorld.create(options)),
    b = BiomePlacement.attach(await BiomeWorld.create(options)),
    order = [
      [2, 1],
      [1, 1],
      [0, 0],
      [3, 3],
      [1, 2],
    ];
  const da = [];
  for (const [x, z] of order) da.push(await a.digest(x, z));
  const db = [];
  for (const [x, z] of [...order].reverse()) db.unshift(await b.digest(x, z));
  assert.deepEqual(da, db);
  // 128 m tiles: the four quarters of 256 m tile (1, 1) hold the same objects (world positions and kinds).
  const small = BiomePlacement.attach(await BiomeWorld.create({ ...options, tileSize: 128 })),
    big = await a.tile(1, 1),
    seen = [];
  big.forEachInstance((i) => seen.push(`${i.key}@${i.x.toFixed(4)},${i.z.toFixed(4)}`));
  const quarters = [];
  for (const [x, z] of [
    [2, 2],
    [3, 2],
    [2, 3],
    [3, 3],
  ])
    (await small.tile(x, z)).forEachInstance((i) => quarters.push(`${i.key}@${i.x.toFixed(4)},${i.z.toFixed(4)}`));
  assert.deepEqual(quarters.sort(), seen.sort());
});

/**
 * Brute-force Luby rounds with fixed priorities over candidates (all of one layer). Spacing as placement decides it:
 * in 1/256 m ticks, the factor in Q16, floored.
 */
function luby(cands, rounds, factor = 0.85) {
  const q = Math.round(factor * 65536),
    tick = (v) => Math.round(v * 256),
    conflict = (a, b) => {
      const d = Math.floor((q * (tick(a.spacing) + tick(b.spacing))) / 65536),
        dx = tick(a.x) - tick(b.x),
        dz = tick(a.z) - tick(b.z);
      return dx * dx + dz * dz < d * d;
    };
  const n = cands.length,
    live = new Uint8Array(n).fill(1),
    fate = new Array(n).fill('unresolved'),
    round = new Int32Array(n),
    higher = (a, b) =>
      cands[a].priority > cands[b].priority ||
      (cands[a].priority === cands[b].priority &&
        (cands[a].x > cands[b].x ||
          (cands[a].x === cands[b].x &&
            (cands[a].z > cands[b].z || (cands[a].z === cands[b].z && cands[a].key > cands[b].key))))),
    nb = cands.map((c, i) => cands.map((o, j) => j).filter((j) => j !== i && conflict(c, cands[j])));
  for (let t = 1; t <= rounds; t++) {
    const acc = [];
    for (let i = 0; i < n; i++) if (live[i] && nb[i].every((j) => !live[j] || !higher(j, i))) acc.push(i);
    for (const i of acc) {
      fate[i] = 'accepted';
      round[i] = t;
    }
    for (const i of acc) live[i] = 0;
    for (const i of acc)
      for (const j of nb[i])
        if (live[j]) {
          live[j] = 0;
          fate[j] = 'rejected';
          round[j] = t;
        }
  }
  return { fate, round };
}

test('the lazy rounds equal a brute-force run of Luby rounds (2 and 6 rounds)', async () => {
  for (const rounds of [2, 6]) {
    const w = await stand([
        {
          id: 'tree',
          mesh: 'procedural:broadleaf',
          density: 450,
          radius: 3,
          size: { kind: 'reverse-j', q: 1.4, max: 1.4 },
        },
      ]),
      p = BiomePlacement.attach(w, { rounds }),
      cands = (await p.inspect([-150, -150, 150, 150])).filter((c) => c.layer === 1),
      reach = 2 * rounds * 0.85 * 2 * 3 * 1.4 + 1,
      { fate, round } = luby(cands, rounds);
    let checked = 0;
    cands.forEach((c, i) => {
      if (Math.abs(c.x) > 150 - reach || Math.abs(c.z) > 150 - reach) return;
      checked++;
      assert.equal(c.fate, fate[i], `${rounds} rounds: fate at ${c.x}, ${c.z}`);
      assert.equal(c.round, round[i], `${rounds} rounds: round at ${c.x}, ${c.z}`);
    });
    assert.ok(checked > 100, `checked ${checked}`);
  }
});

test('rounds: almost every candidate settles within 6 rounds in the densest preset stands (under 0.1 % unresolved)', async () => {
  for (const id of ['boreal', 'temperate', 'tropical']) {
    const w = await BiomeWorld.create({ size: [768, 768], ...presetWorldOptions(id) }),
      t = await BiomePlacement.attach(w).tile(1, 1),
      settled = t.stats.rounds.reduce((a, b) => a + b, 0);
    assert.ok(t.stats.unresolved <= settled * 0.001, `${id}: ${t.stats.unresolved} of ${settled} unresolved`);
    assert.ok(t.stats.rounds[0] > settled / 2, `${id}: most settle in round 1 (${[...t.stats.rounds]})`);
  }
});

test('exclusions: nothing stands inside a road or a building, the mask marks them, removing them restores the tile', async () => {
  const w = await BiomeWorld.create({ size: [512, 512], ...presetWorldOptions('temperate') }),
    road = {
      kind: 'line',
      points: [
        [-256, -40],
        [256, 40],
      ],
      width: 8,
      verge: 6,
    },
    house = {
      kind: 'polygon',
      points: [
        [-60, -200],
        [-20, -200],
        [-20, -160],
        [-60, -160],
      ],
    },
    p = BiomePlacement.attach(w, { exclusions: [road, house] }),
    objects = (await p.inspect([-256, -256, 256, 256])).filter((c) => c.fate === 'accepted');
  for (const o of objects) {
    const t = Math.max(0, Math.min(1, ((o.x + 256) * 512 + (o.z + 40) * 80) / (512 * 512 + 80 * 80))),
      d = Math.hypot(o.x - (-256 + 512 * t), o.z - (-40 + 80 * t));
    assert.ok(d >= 4 - 0.01, `object on the road at ${o.x}, ${o.z}`);
    assert.ok(!(o.x > -60 && o.x < -20 && o.z > -200 && o.z < -160), 'object inside the house');
  }
  const t = await p.tile(0, 0);
  assert.equal(t.exclusion.data[(-180 + 256) * 256 + (-40 + 256)], 255);
  assert.equal(t.exclusion.data[(-100 + 256) * 256 + (-200 + 256)], 0);
  const free = BiomePlacement.attach(w);
  assert.ok((await free.tile(0, 0)).count > t.count);
  p.update({ exclusions: [] });
  assert.equal(await p.digest(0, 0), await free.digest(0, 0));
});

test('shade, canopy layers and thinning: shade-intolerant shrubs avoid crowns; closed stands have understory and dead', async () => {
  const w = await stand(
      [
        {
          id: 'oak',
          mesh: 'procedural:broadleaf',
          density: 1500,
          radius: 4,
          shade: 0.1,
          size: { kind: 'reverse-j', q: 1.4, max: 1.5 },
        },
        { id: 'holly', mesh: 'procedural:shrub', density: 2500, radius: 1.5, shade: 0.8 },
        { id: 'fern', mesh: 'procedural:shrub', density: 3000, radius: 0.4, shade: 0.05 },
      ],
      { seed: 3 },
    ),
    p = BiomePlacement.attach(w),
    all = await p.inspect([-200, -200, 200, 200]),
    oaks = all.filter((c) => (c.key === 'stand/oak' || c.key === 'stand/holly') && c.fate === 'accepted'),
    ferns = all.filter((c) => c.key === 'stand/fern' && c.fate === 'accepted');
  let under = 0;
  for (const f of ferns) if (oaks.some((o) => Math.hypot(o.x - f.x, o.z - f.z) < o.spacing)) under++;
  // Without shade a fern would stand under a crown with the crowns' share of the ground (more than half here).
  const t = await p.tile(0, 0),
    cover = t.canopy.data.reduce((a, v) => a + v, 0) / (255 * t.canopy.data.length);
  assert.ok(cover > 0.5, `crown cover ${cover}`);
  assert.ok(under / ferns.length < cover * 0.3, `ferns under crowns ${under} of ${ferns.length}, cover ${cover}`);
  const ages = [0, 0, 0, 0];
  t.forEachInstance((i) => {
    if (i.key !== 'stand/fern') ages[i.age]++;
  });
  assert.ok(ages[0] > 0 && ages[1] > 0 && ages[2] + ages[3] > 0, `ages ${ages}`);
});

test('edges: shrubs are denser near a biome border than inside', async () => {
  const shrub = { id: 'hazel', mesh: 'procedural:shrub', density: 2500, radius: 0.4 },
    a = defineBiome({
      id: 'west',
      climate: { custom: { 'mask/east': [null, 0.5] } },
      ground: [{ material: 'grass' }],
      plants: [shrub],
    }),
    b = defineBiome({
      id: 'east',
      climate: { custom: { 'mask/east': [0.5, null] } },
      ground: [{ material: 'moss' }],
      plants: [shrub],
    }),
    w = await BiomeWorld.create({ size: [512, 256], height: { field: () => 100 }, biomes: [a, b] }),
    mask = new Uint8Array(256 * 256);
  for (let z = 0; z < 256; z++)
    for (let x = 0; x < 256; x++) mask[z * 256 + x] = Math.round(Math.min(1, Math.max(0, (x - 64) / 128)) * 255);
  w.writeLayer('mask/east', 0, 0, mask);
  w.writeLayer('mask/east', 1, 0, new Uint8Array(256 * 256).fill(255));
  const objects = (await BiomePlacement.attach(w).inspect([-256, -128, 0, 128])).filter((c) => c.fate === 'accepted'),
    count = (x0, x1) => objects.filter((o) => o.x >= x0 && o.x < x1).length;
  // The border (mask 0.5) is at x = -128; the ecotone, where the strongest weight is below 1, is a few metres wide
  // (the envelope blend band). Compare an 8 m band on the border with 8 m bands deep inside each biome.
  const border = count(-132, -124),
    inside = (count(-250, -242) + count(-20, -12)) / 2;
  assert.ok(border > inside * 1.1, `border ${border} inside ${inside}`);
});

test('golden digests: placement of preset worlds at seeds 1 and 0xFFFFFFFF', async () => {
  const got = {};
  for (const id of ['temperate', 'boreal', 'alpine', 'savanna', 'desert'])
    for (const seed of [1, 0xffffffff]) {
      const w = await BiomeWorld.create({ seed, size: [512, 512], ...presetWorldOptions(id) });
      got[`${id}-${seed}`] = await BiomePlacement.attach(w).digest(1, 0);
    }
  if (process.env.MARGO_RECORD) console.log(JSON.stringify(got, null, 2));
  for (const [k, v] of Object.entries(got)) assert.equal(v, golden[k], k);
});

// ---- G7: statistics against independent float samplers of the target processes ----

/** Poisson count (a sum of unit-mean draws for large means, so exp(-mu) never underflows). */
function poissonDraw(rng, mu) {
  if (mu > 30) {
    let n = 0;
    for (let left = mu; left > 0; left -= 30) n += poissonDraw(rng, Math.min(30, left));
    return n;
  }
  let k = 0,
    p = Math.exp(-mu),
    s = p;
  const u = rng();
  while (u > s && k < 10000) {
    k++;
    p *= mu / k;
    s += p;
  }
  return k;
}

/** Points of an intensity-thinned Poisson process with a hard core by random priority (greedy), in a window. */
function reference(rng, window, rate, keep, spacing) {
  const [x0, z0, x1, z1] = window,
    n = poissonDraw(rng, rate * (x1 - x0) * (z1 - z0)),
    pts = [];
  for (let i = 0; i < n; i++) {
    const x = x0 + rng() * (x1 - x0),
      z = z0 + rng() * (z1 - z0);
    if (rng() < keep(x, z)) pts.push({ x, z, p: rng() });
  }
  pts.sort((a, b) => b.p - a.p);
  const out = [],
    cell = Math.max(spacing, 1e-6),
    grid = new Map();
  for (const q of pts) {
    const cx = Math.floor(q.x / cell),
      cz = Math.floor(q.z / cell);
    let ok = true;
    for (let dz = -1; dz <= 1 && ok; dz++)
      for (let dx = -1; dx <= 1 && ok; dx++)
        for (const o of grid.get(`${cx + dx},${cz + dz}`) ?? [])
          if (Math.hypot(o.x - q.x, o.z - q.z) < spacing) ok = false;
    if (!ok) continue;
    out.push(q);
    const k = `${cx},${cz}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(q);
  }
  return out;
}

const crop = (pts, w) => {
  const inside = pts.filter((q) => q.x >= w[0] && q.x < w[2] && q.z >= w[1] && q.z < w[3]);
  return { x: inside.map((q) => q.x), z: inside.map((q) => q.z), window: w };
};

async function envelope(observed, simulate, fn, label) {
  const sims = [];
  for (let i = 0; i < (NIGHTLY ? 2499 : 199); i++) sims.push(fn(simulate(i)));
  const mad = globalEnvelope(fn(observed), sims, { type: NIGHTLY ? 'rank' : 'mad' });
  assert.ok(!mad.reject, `${label}: p ${mad.p}`);
  return mad.p;
}

test('G7: a hard-core stand matches sequential random adsorption (L and G, global envelopes)', async () => {
  // 250 per hectare stays below the density where sizes shrink to fit (0.0268 per m^2 for these crowns).
  const w = await stand([{ id: 'tree', mesh: 'procedural:broadleaf', density: 250, radius: 3 }], {}, 768),
    win = [-150, -150, 150, 150],
    objects = (await BiomePlacement.attach(w).inspect(win)).filter((c) => c.fate === 'accepted'),
    observed = { x: objects.map((o) => o.x), z: objects.map((o) => o.z), window: win },
    radii = Float64Array.from({ length: 30 }, (_, i) => 1 + i * 0.6),
    sim = (i) =>
      crop(
        reference(random(1000 + i), [-170, -170, 170, 170], 0.025, () => 1, 5.1),
        win,
      );
  await envelope(observed, sim, (p) => lFunction(p, radii), 'L');
  await envelope(observed, sim, (p) => nearestG(p, radii), 'G');
});

test('G7: Thomas and 2Dt clusters match their Cox process (L and g, global envelopes)', async () => {
  const kinds = [
    {
      cluster: { kind: 'thomas', parents: 10, spread: 8, offspring: 40 },
      kernel: (r2) => Math.exp(-r2 / 128) / (2 * Math.PI * 64),
      reach: 24,
    },
    {
      cluster: { kind: '2dt', parents: 10, spread: 6, offspring: 15, tail: 1 },
      kernel: (r2) => 1 / (Math.PI * 36) / (1 + r2 / 36) ** 2,
      reach: 24,
    },
  ];
  for (const { cluster, kernel, reach } of kinds) {
    const w = await stand([{ id: 'shrub', mesh: 'procedural:shrub', density: 400, radius: 0.3, cluster }], {}, 768),
      win = [-100, -100, 100, 100],
      objects = (await BiomePlacement.attach(w).inspect(win)).filter((c) => c.fate === 'accepted'),
      observed = { x: objects.map((o) => o.x), z: objects.map((o) => o.z), window: win },
      // The same truncated, normalised kernel and cap of 4 times the mean, in floats.
      mass = (() => {
        let s = 0;
        for (let r = 0.005; r < reach; r += 0.01) s += kernel(r * r) * 2 * Math.PI * r * 0.01;
        return s;
      })(),
      rho = cluster.parents / 1e4,
      beta = Math.min(1, (cluster.parents * cluster.offspring) / 400),
      sim = (i) => {
        const rng = random(5000 + i),
          parents = [];
        const np = poissonDraw(rng, rho * 300 * 300);
        for (let k = 0; k < np; k++) parents.push([-150 + rng() * 300, -150 + rng() * 300]);
        const buckets = new Map();
        for (const [px, pz] of parents) {
          const k = `${Math.floor(px / reach)},${Math.floor(pz / reach)}`;
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push([px, pz]);
        }
        const intensity = (x, z) => {
          let s = 0;
          for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++)
              for (const [px, pz] of buckets.get(`${Math.floor(x / reach) + dx},${Math.floor(z / reach) + dz}`) ?? []) {
                const d2 = (x - px) ** 2 + (z - pz) ** 2;
                if (d2 < reach * reach) s += kernel(d2) / mass / rho;
              }
          return 1 - beta + beta * Math.min(4, s);
        };
        const kappa = 1 + 3 * beta;
        return crop(
          reference(rng, [-126, -126, 126, 126], 0.04 * kappa * 1.5, (x, z) => intensity(x, z) / kappa / 1.5, 0.51),
          win,
        );
      },
      radii = Float64Array.from({ length: 24 }, (_, i) => 1 + i);
    await envelope(observed, sim, (p) => lFunction(p, radii), `${cluster.kind} L`);
    await envelope(observed, sim, (p) => pairCorrelation(p, radii, 1.5), `${cluster.kind} g`);
  }
});

test('sizes follow their distributions (Kolmogorov-Smirnov and Anderson-Darling on all candidates)', async () => {
  const rj = { kind: 'reverse-j', q: 1.4, max: 1.6 },
    wb = { kind: 'weibull', shape: 2.5, scale: 1 },
    w = await stand([
      { id: 'a', mesh: 'procedural:broadleaf', density: 200, radius: 3, size: rj },
      { id: 'b', mesh: 'procedural:conifer', density: 200, radius: 3.5, size: wb },
    ]),
    all = await BiomePlacement.attach(w).inspect([-200, -200, 200, 200]),
    umax = 1.6 ** (4 / 3),
    umin = umax / 10,
    a = 10 * Math.log(1.4),
    rjCdf = (u) =>
      u <= umin ? 0 : u >= umax ? 1 : (1 - Math.exp(-a * (u - umin))) / (1 - Math.exp(-a * (umax - umin))),
    wbCdf = (u) => 1 - Math.exp(-((u / 1) ** 2.5));
  const sa = all.filter((c) => c.key === 'stand/a').map((c) => c.size),
    sb = all.filter((c) => c.key === 'stand/b').map((c) => c.size);
  assert.ok(sa.length > 1000 && sb.length > 1000);
  // Sizes are Q16 (1.5e-5 steps): far below what the tests resolve.
  assert.ok(ksTest(sa, rjCdf).p > 0.01, `reverse-j KS p ${ksTest(sa, rjCdf).p}`);
  assert.ok(andersonDarling(sa, rjCdf).p > 0.01, `reverse-j AD p ${andersonDarling(sa, rjCdf).p}`);
  assert.ok(ksTest(sb, wbCdf).p > 0.01, `weibull KS p ${ksTest(sb, wbCdf).p}`);
  assert.ok(andersonDarling(sb, wbCdf).p > 0.01, `weibull AD p ${andersonDarling(sb, wbCdf).p}`);
});

/** Self-thinning bands of the 95th-percentile frontier slope of log N on log Dq, per preset (Long et al. 2024). */
const BANDS = {
  temperate: [-2.0, -1.4],
  boreal: [-2.0, -1.4],
  tropical: [-2.0, -1.4],
  wetland: [-2.0, -1.4],
  savanna: [-2.0, -1.4],
};

test('self-thinning: the size-density frontier slope of every preset tree lies in its preset band (no universal -3/2)', async () => {
  for (const [id, [lo, hi]] of Object.entries(BANDS))
    for (const tree of presets[id].plants.filter((s) => s.radius >= 2.5)) {
      // Pure stands over a density gradient, as in thinning trials: N per hectare and quadratic mean size per 32 m plot.
      // Plots large enough for several crowns (32 m, or 8 crown radii for the widest trees), 5 trees or more.
      const xs = [],
        ys = [],
        side = Math.max(32, 8 * tree.radius);
      for (const scale of [0.25, 0.5, 1, 2, 4, 8, 16]) {
        const w = await stand([{ ...tree, density: tree.density * scale, cluster: undefined }], { seed: 11 }, 512),
          all = (await BiomePlacement.attach(w).inspect([-224, -224, 224, 224])).filter((c) => c.fate === 'accepted'),
          cells = new Map();
        for (const c of all) {
          const k = `${Math.floor(c.x / side)},${Math.floor(c.z / side)}`;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(c.size);
        }
        for (const sizes of cells.values()) {
          if (sizes.length < 5) continue;
          xs.push(Math.log(Math.sqrt(sizes.reduce((a, u) => a + u * u, 0) / sizes.length)));
          ys.push(Math.log((sizes.length * 1e4) / (side * side)));
        }
      }
      const { slope } = quantileFit(xs, ys, 0.95);
      assert.ok(
        slope >= lo && slope <= hi,
        `${id}/${tree.id}: frontier slope ${slope.toFixed(2)} outside ${lo}..${hi}`,
      );
    }
});

test('tundra stores dwarf birch and boulders only: under 60,000 objects per km2 (lichen is detail cover)', async () => {
  // Regression: lichen was a stored shrub at 2,000 per hectare, about 214,000 green blobs per km2 of tundra.
  const w = await BiomeWorld.create({ size: [1024, 1024], ...presetWorldOptions('tundra') }),
    p = BiomePlacement.attach(w),
    species = new Set();
  let count = 0;
  for (let x = 0; x < 4; x++)
    for (let z = 0; z < 4; z++) {
      const t = await p.tile(x, z);
      count += t.count;
      t.forEachInstance((i) => species.add(i.key));
    }
  const perKm2 = count / 1.048576; // float division: test arithmetic
  assert.ok(perKm2 > 5000 && perKm2 < 60000, `tundra objects per km2: ${perKm2.toFixed(0)}`);
  assert.ok(!species.has('tundra/lichen'), 'lichen is not stored');
  assert.equal(p.species.find((s) => s.key === 'tundra/dwarf-birch').mesh, 'procedural:tundra-shrub');
  assert.ok(
    p.details.some((d) => d.id === 'lichen'),
    'lichen is a detail species',
  );
});

/** Temperate and boreal records of a placement tile, with the desert biome weight (0..255) of each record's cell. */
async function forestRecords(world, placement, tx, tz) {
  const desert = world.biomes.findIndex((b) => b.id === 'desert'),
    cells = await world.tile(tx, tz),
    ids = cells.layer('biome').data,
    weights = cells.layer('biomeWeight').data,
    t = await placement.tile(tx, tz),
    out = [];
  t.forEachInstance((i) => {
    if (!i.key.startsWith('temperate/') && !i.key.startsWith('boreal/')) return;
    // The world resolution is 1 m: metres from the tile origin are cell indices.
    const k = Math.floor(i.z - t.origin[1]) * cells.cells + Math.floor(i.x - t.origin[0]);
    let d = 0;
    for (let q = 0; q < 4; q++) if (ids[k * 4 + q] === desert) d = weights[k * 4 + q];
    out.push({ x: i.x, z: i.z, desert: d });
  });
  return out;
}

/** Mean desert weight (0..1) of the cells of a 1024 m world's tiles whose centres lie lo..hi metres from the origin. */
async function desertShare(world, tiles, lo, hi) {
  const desert = world.biomes.findIndex((b) => b.id === 'desert');
  let sum = 0,
    n = 0;
  for (const [tx, tz] of tiles) {
    const t = await world.tile(tx, tz),
      ids = t.layer('biome').data,
      weights = t.layer('biomeWeight').data;
    for (let z = 0; z < t.cells; z++)
      for (let x = 0; x < t.cells; x++) {
        const r = Math.hypot(-512 + tx * 256 + x + 0.5, -512 + tz * 256 + z + 0.5);
        if (r < lo || r >= hi) continue;
        const k = z * t.cells + x;
        for (let q = 0; q < 4; q++) if (ids[k * 4 + q] === desert) sum += weights[k * 4 + q];
        n++;
      }
  }
  return sum / (255 * n); // float division: test arithmetic
}

test('paint: a full-strength desert dab leaves no forest inside; the smooth falloff thins it by the painted share', async () => {
  // Shot 08 of the biome look review showed trees inside a painted desert patch. A constant-falloff dab paints 255
  // everywhere inside its radius, and no temperate or boreal record may stand where the desert weight is 255.
  const tiles = [
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
    ],
    ring = (records, lo, hi) => records.filter((r) => Math.hypot(r.x, r.z) >= lo && Math.hypot(r.x, r.z) < hi).length,
    count = async (world, placement) => {
      const all = [];
      for (const [x, z] of tiles) all.push(...(await forestRecords(world, placement, x, z)));
      return all;
    };
  const hard = await BiomeWorld.create({ size: [1024, 1024], ...presetWorldOptions('temperate') }),
    hardPlacement = BiomePlacement.attach(hard),
    before = await count(hard, hardPlacement);
  assert.ok(before.filter((r) => Math.hypot(r.x, r.z) < 190).length > 1000, 'a forest stands there before the paint');
  BiomeEditor.attach(hard).paint('desert', { center: [0, 0], radius: 200, falloff: 'constant' });
  const after = await count(hard, hardPlacement),
    full = after.filter((r) => r.desert === 255);
  assert.equal(full.length, 0, `forest records where the desert weight is 255: ${full.length}`);
  // The default 24 m ecotone ramps the edge from about 25 m inside the radius (12 m box, up to 12 m of warp) to 25 m
  // outside: the core is bare, and the forest thins across the band with the ground's weights.
  assert.equal(after.filter((r) => Math.hypot(r.x, r.z) < 170).length, 0, 'nothing of the forest inside the dab');
  const band = ring(after, 180, 220) / ring(before, 180, 220); // float division: test arithmetic
  assert.ok(band > 0.05 && band < 0.95, `the forest thins across the ecotone band: ${band.toFixed(2)} kept`);
  // The default smooth falloff paints about half at half the radius, and the forest there thins with that share: its
  // stems pass the candidate step in proportion to the forest weight. Fewer candidates also meet fewer neighbours in
  // the hard core, so a dense stand keeps somewhat more than its weight (measured 0.75 at a 0.49 desert share).
  const soft = await BiomeWorld.create({ size: [1024, 1024], ...presetWorldOptions('temperate') }),
    softPlacement = BiomePlacement.attach(soft);
  BiomeEditor.attach(soft).paint('desert', { center: [0, 0], radius: 200 });
  const painted = await count(soft, softPlacement),
    kept = (lo, hi) => ring(painted, lo, hi) / ring(before, lo, hi), // float division: test arithmetic
    half = kept(85, 115);
  const desert = await desertShare(soft, tiles, 85, 115);
  assert.ok(desert >= 0.35 && desert <= 0.65, `desert share at half the radius: ${desert.toFixed(2)}`);
  assert.ok(half >= 0.35 && half <= 0.85, `share of the forest kept at half the radius: ${half.toFixed(2)}`);
  assert.ok(kept(40, 60) < half && half < kept(140, 160), 'the forest thins toward the centre of the dab');
});

test('the editor dirty margin covers the placement reach, and an edit leaves tiles beyond it unchanged', async () => {
  const w = await BiomeWorld.create({
      size: [2048, 512],
      biomes: Object.values(presets).filter((b) => b.id !== 'beach'),
    }),
    p = BiomePlacement.attach(w),
    e = BiomeEditor.attach(w);
  assert.ok(e.margin() >= p.reach, `editor ${e.margin()} placement ${p.reach}`);
  const far = await p.digest(0, 0),
    near = await p.digest(7, 1);
  let changed;
  p.onChange((rect) => (changed = rect));
  // Paint 20 m of desert at the east end: tile (0, 0) lies more than the reach away.
  e.paint('desert', { center: [900, 0], radius: 20 });
  assert.ok(changed && changed[0] <= 900 - p.reach - 10 && changed[2] >= 900 + 10, `reported ${changed}`);
  assert.ok(-1024 + 256 < 880 - p.reach, 'tile (0, 0) is beyond the reach');
  assert.equal(await p.digest(0, 0), far);
  assert.notEqual(await p.digest(7, 1), near);
});

test('time budget (G1): one preset forest tile placed in under 150 ms of CPU on one thread (measured about 30 ms on the reference PC)', async () => {
  const w = await BiomeWorld.create({ size: [1024, 1024], ...presetWorldOptions('temperate') }),
    p = BiomePlacement.attach(w);
  await p.tile(0, 0);
  for (const [x, z] of [
    [1, 1],
    [2, 1],
    [1, 2],
  ])
    await w.tile(x, z);
  for (let x = 0; x <= 3; x++) for (let z = 0; z <= 3; z++) await w.tile(x, z);
  const cpu = cpuTimer();
  await p.tile(1, 1);
  await p.tile(2, 1);
  const each = cpu() / 2;
  assert.ok(each < 150, `placement took ${each.toFixed(0)} ms of CPU per tile`);
});

test('sea level: no species stands on ground below the sea, and inland objects do not move', async () => {
  // Regression: placement read climate fields only, so the wetland coast had alders, willows, oaks and hazels standing
  // on the sea floor under the view's water (5,524 of 11,573 records on these four coast tiles). No species is aquatic,
  // so none grows below `climate.seaLevel`: stored objects and detail cover alike. Removing the submerged candidates
  // only frees room for plants within a few metres of the shore (they were killed by phantom trees in the water).
  const { createHash } = await import('node:crypto'),
    // The presets now keep woody plants off the shore themselves (dry land, Scott's S4); placement must hold without it.
    options = presetWorldOptions('wetland'),
    w = await BiomeWorld.create({
      size: [2048, 2048],
      ...options,
      biomes: options.biomes.map((b) => ({
        ...b,
        plants: b.plants?.map(({ suitability, stands, ...p }) =>
          p.size ? { ...p, size: { ...p.size, max: 1.6 } } : p,
        ),
      })),
    }),
    p = BiomePlacement.attach(w),
    sea = w.climate.sea,
    side = w.tileSize, // 256 cells of 1 m
    heights = new Map();
  for (let tz = 1; tz <= 4; tz++)
    for (let tx = 2; tx <= 5; tx++) heights.set(`${tx},${tz}`, (await w.tile(tx, tz)).layer('height').data);
  // Summed submerged cells over the 4 x 4 tiles around the coast tiles, to ask "any sea within 30 m?" per record.
  const n = 4 * side,
    sum = new Int32Array((n + 1) * (n + 1));
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const h = heights.get(`${2 + (x >> 8)},${1 + (z >> 8)}`)[(z & 255) * side + (x & 255)];
      sum[(z + 1) * (n + 1) + x + 1] =
        (h < sea ? 1 : 0) + sum[z * (n + 1) + x + 1] + sum[(z + 1) * (n + 1) + x] - sum[z * (n + 1) + x];
    }
  const wetNear = (gx, gz, r) => {
    const x0 = Math.max(0, gx - r),
      z0 = Math.max(0, gz - r),
      x1 = Math.min(n, gx + r + 1),
      z1 = Math.min(n, gz + r + 1);
    return sum[z1 * (n + 1) + x1] - sum[z0 * (n + 1) + x1] - sum[z1 * (n + 1) + x0] + sum[z0 * (n + 1) + x0] > 0;
  };
  let below = 0,
    land = 0,
    wetDetail = 0;
  const inland = [];
  for (const [tx, tz] of [
    [3, 2],
    [4, 2],
    [3, 3],
    [4, 3],
  ]) {
    const h = heights.get(`${tx},${tz}`),
      t = await p.tile(tx, tz);
    for (const d of t.density) for (let k = 0; k < d.data.length; k++) if (h[k] < sea && d.data[k]) wetDetail++;
    let r = 0;
    t.forEachInstance((i) => {
      const cx = Math.floor(i.x - t.origin[0]),
        cz = Math.floor(i.z - t.origin[1]),
        at = r++ * 8;
      if (h[cz * side + cx] < sea) below++;
      else {
        land++;
        // Grid position in the 4 x 4 tile block (tile 2, 1 is its corner).
        if (!wetNear((tx - 2) * side + cx, (tz - 1) * side + cz, 30))
          inland.push(`${i.key}:${[...t.instances.subarray(at, at + 8)].join(',')}`);
      }
    });
  }
  assert.equal(below, 0, 'records on ground below sea level');
  assert.equal(wetDetail, 0, 'detail cover on submerged cells');
  // Land objects: the 6,049 of the unfixed placement, plus a few on the shore line where water candidates blocked them.
  assert.ok(land >= 6049 && land <= 6049 * 1.01, `land objects ${land}`);
  const digest = createHash('sha256').update(inland.join('\n')).digest('hex');
  if (process.env.MARGO_RECORD) console.log('wetland-coast-inland', inland.length, digest);
  assert.equal(
    digest,
    golden['wetland-coast-inland'],
    'objects more than 30 m from the sea are those of the unfixed placement',
  );
});

test('preset woody plants: none near a river line or the shore, forest trees grow past 1.6', async () => {
  const relief = { seed: 3, relief: 300, base: 60, rivers: 2, coast: 'south' },
    lines = createRelief(relief).rivers,
    w = await BiomeWorld.create({
      biomes: [presets.temperate],
      climate: presetWorlds.temperate.climate,
      height: { relief },
    }),
    p = BiomePlacement.attach(w),
    woody = new Set(presets.temperate.plants.map((s) => `temperate/${s.id}`)),
    near = (i, reach) => {
      for (const line of lines)
        for (let s = 0; s + 3 < line.length; s += 2) {
          const ax = line[s] / 1000, // float division
            az = line[s + 1] / 1000, // float division
            bx = line[s + 2] / 1000 - ax, // float division
            bz = line[s + 3] / 1000 - az, // float division
            t = Math.max(0, Math.min(1, ((i.x - ax) * bx + (i.z - az) * bz) / (bx * bx + bz * bz))); // float division
          if (Math.hypot(i.x - ax - bx * t, i.z - az - bz * t) < reach) return true;
        }
      return false;
    };
  let checked = 0,
    largest = 0,
    close = 0,
    low = 0;
  for (let tz = 0; tz < w.tilesZ; tz += 2)
    for (let tx = 0; tx < w.tilesX; tx += 2) {
      const t = await p.tile(tx, tz);
      t.forEachInstance((i) => {
        if (!woody.has(i.key)) return;
        checked++;
        if (i.scale > largest) largest = i.scale;
        // The rule keeps 50 m from the region cells on the line, which lie up to 16 m off it.
        if (near(i, 34)) close++;
        if (w.heightAt(i.x, i.z) < 2.5) low++;
      });
    }
  assert.ok(checked > 1000, `woody plants ${checked}`);
  assert.equal(close, 0, 'nothing woody stands by a river');
  assert.equal(low, 0, 'nothing woody stands on the shore');
  assert.ok(largest > 1.6, `trees past the old 1.6: ${largest}`);
  w.dispose();
});

/** Objects per 50 m cell of a 1,024 m square, and the positions, for a species rule on a flat world. */
async function counts(rule, seed = 7) {
  const p = BiomePlacement.attach(await stand([{ id: 'tree', mesh: 'procedural:broadleaf', ...rule }], { seed }, 1024)),
    cells = new Int32Array(20 * 20);
  let total = 0;
  const bytes = [];
  for (let tz = 0; tz < 4; tz++)
    for (let tx = 0; tx < 4; tx++) {
      const t = await p.tile(tx, tz);
      bytes.push(Buffer.from(t.instances.subarray(0, t.count * 8)).toString('base64'));
      t.forEachInstance((i) => {
        const cx = Math.floor((i.x + 512) / 51.2),
          cz = Math.floor((i.z + 512) / 51.2);
        cells[cz * 20 + cx]++;
        total++;
      });
    }
  let sum2 = 0;
  for (const c of cells) sum2 += c * c;
  const mean = total / cells.length;
  return { total, cells, bytes, cv: Math.sqrt(sum2 / cells.length - mean * mean) / mean };
}

const RULE = { density: 100, radius: 2 };

test('stands: a forest gathers into stands and clearings, the total stays, the same bytes every time', async () => {
  const even = await counts(RULE),
    stands = await counts({ ...RULE, stands: { scale: 200, cover: 0.5 } }),
    again = await counts({ ...RULE, stands: { scale: 200, cover: 0.5 } });
  assert.ok(stands.cv > 2 * even.cv, `coefficient of variation ${stands.cv} against ${even.cv} with no stands`);
  const ratio = stands.total / even.total;
  assert.ok(Math.abs(ratio - 1) <= 0.15, `total ${stands.total} against ${even.total}`);
  assert.deepEqual(stands.bytes, again.bytes);
  // Clearings hold nothing: about the uncovered share of cells is empty (with no stands none is).
  const empty = (r) => r.cells.filter((c) => c === 0).length / r.cells.length;
  assert.ok(empty(stands) > 0.2, `empty cells ${empty(stands)}`);
  assert.equal(empty(even), 0);
});

test('stands: `cover` is the share of the ground over many seeds, and the mean density stays', async () => {
  // Small crowns, so the hard core does not cap the density inside a stand (with 2 m crowns at cover 0.25 it does).
  const small = { density: 50, radius: 0.5 };
  for (const cover of [0.25, 0.5, 0.75]) {
    let total = 0,
      even = 0,
      used = 0,
      cells = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const r = await counts({ ...small, stands: { scale: 100, cover } }, seed);
      total += r.total;
      even += (await counts(small, seed)).total;
      // Patches much wider than the 51 m count cells, so few cells straddle an edge.
      const wide = await counts({ ...small, stands: { scale: 500, cover } }, seed);
      used += wide.cells.filter((c) => c > 0).length;
      cells += wide.cells.length;
    }
    assert.ok(Math.abs(total / even - 1) < 0.08, `cover ${cover}: total ${total} against ${even}`);
    assert.ok(Math.abs(used / cells - cover) < 0.15, `cover ${cover}: used ${used / cells}`);
  }
});

test('stands: cover 1 gives the bytes of no rule, tile size does not matter, species with one scale share clearings', async () => {
  assert.deepEqual((await counts({ ...RULE, stands: { scale: 300, cover: 1 } })).bytes, (await counts(RULE)).bytes);
  const two = (a, b) => [
    { id: 'a', mesh: 'procedural:broadleaf', ...RULE, stands: a },
    { id: 'b', mesh: 'procedural:conifer', ...RULE, stands: b },
  ];
  const overlap = async (a, b) => {
    const p = BiomePlacement.attach(await stand(two(a, b), {}, 1024)),
      cells = { a: new Int32Array(400), b: new Int32Array(400) };
    for (let tz = 0; tz < 4; tz++)
      for (let tx = 0; tx < 4; tx++)
        (await p.tile(tx, tz)).forEachInstance((i) => {
          cells[i.key.endsWith('/a') ? 'a' : 'b'][
            Math.floor((i.z + 512) / 51.2) * 20 + Math.floor((i.x + 512) / 51.2)
          ]++;
        });
    let both = 0,
      either = 0;
    for (let k = 0; k < 400; k++) {
      if (cells.a[k] && cells.b[k]) both++;
      if (cells.a[k] || cells.b[k]) either++;
    }
    return both / either;
  };
  const shared = await overlap({ scale: 200, cover: 0.5 }, { scale: 200, cover: 0.5 }),
    apart = await overlap({ scale: 200, cover: 0.5 }, { scale: 230, cover: 0.5 });
  assert.ok(shared > apart + 0.2, `one scale overlaps ${shared}, two scales ${apart}`);
  for (const stands of [
    { scale: 49, cover: 0.5 },
    { scale: 2001, cover: 0.5 },
    { scale: 200, cover: 0.09 },
    { scale: 200, cover: 1.1 },
    {},
    null,
  ])
    assert.throws(
      () =>
        defineBiome({
          id: 'x',
          climate: {},
          ground: [{ material: 'grass' }],
          plants: [{ id: 'a', mesh: 'm', ...RULE, stands }],
        }),
      /stands rule/,
    );
});
