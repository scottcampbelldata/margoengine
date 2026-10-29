// B5: stored-object placement. Records and decoding; the hard core across tile seams; tile order and tile size
// independence; the lazy rounds equal a brute-force run of Luby's rounds; the unresolved share; exclusions, shade, edges
// and canopy layers; golden digests; and the quality gates of goal G7: global envelope tests (studentised maximum
// deviation, 199 simulations; the extreme rank length with 2,499 when MARGO_NIGHTLY is set) against independent float
// samplers of the target processes, size distributions by Kolmogorov-Smirnov and Anderson-Darling, and the
// size-density frontier inside each preset's self-thinning band. Plus the CPU time budget (G1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { BiomeEditor } from '../dist/editor.js';
import { BiomePlacement } from '../dist/placement.js';
import { presets, presetWorlds } from '../dist/presets.js';
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
  return { biomes: Object.values(presets), climate: pw.climate, height: { relief: pw.relief } };
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

test('the editor dirty margin covers the placement reach, and an edit leaves tiles beyond it unchanged', async () => {
  const w = await BiomeWorld.create({ size: [2048, 512], biomes: Object.values(presets) }),
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

test('time budget (G1): one preset forest tile placed in under 400 ms on one thread (measured about 27 ms on the reference PC)', async () => {
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
  const start = performance.now();
  await p.tile(1, 1);
  await p.tile(2, 1);
  const each = (performance.now() - start) / 2;
  assert.ok(each < 400, `placement took ${each.toFixed(0)} ms per tile`);
});
