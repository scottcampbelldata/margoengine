// Cliffs, overhangs and sea rocks (`@margoengine/terrain/rocks`, `/rock-surface`, `/rock-settings`), CPU side: the
// slope and relief measures, where rock is placed on a coast (a 30 m cliffed headland beside a gentle beach), the shape
// of each piece measured on its own field (overhang, cover of the heightfield, wave-cut notch), closed meshes across
// the polygonizer's blocks, and the slider rows.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boulderField,
  buildBoulder,
  buildCliff,
  buildRocks,
  buildSeaRock,
  cliffField,
  findRockSites,
  localRelief,
  rockGround,
  seaRockField,
} from '../dist/rocks.js';
import { ROCK_LOOK_DEFAULTS, ROCK_TYPES, RockSurface } from '../dist/rock-surface.js';
import {
  ROCK_SETTINGS,
  applyRockSettings,
  rockLookOf,
  rockSettingDefaults,
  rockShapeOf,
} from '../dist/rock-settings.js';
import { heldFromWeather } from '../../shared/settings.js';

const N = 257;
// x from -128 to 128, z likewise. West of x = 50: a plateau 30 m high for z > 10 with a cliff (steepest 72 degrees)
// down to the sea floor, which falls 8 m per 60 m out; east of x = 70: a beach rising 30 m over 170 m. Sea level 0.
function coast() {
  const h = new Float32Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = i - 128,
        z = j - 128,
        cliff = 30 / (1 + Math.exp(-(z - 10) / 2.5)) - 8 * Math.max(0, (10 - z) / 60),
        beach = 30 * Math.min(1, Math.max(0, (z + 20) / 170)) - 3,
        t = Math.min(1, Math.max(0, (x - 50) / 20));
      h[j * N + i] = cliff * (1 - t) + beach * t;
    }
  return { heights: h, resolution: [N, N], origin: [-128, -128], size: [256, 256] };
}
const ground = coast(),
  sites = findRockSites(ground);
// Weld-free edge count of a mesh: a closed surface uses every edge in exactly two triangles.
function openEdges(geometry) {
  const edges = new Map(),
    idx = geometry.indices;
  for (let t = 0; t < idx.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e],
        b = idx[t + ((e + 1) % 3)],
        key = a < b ? a + ',' + b : b + ',' + a;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  let open = 0;
  for (const n of edges.values()) if (n !== 2) open++;
  return { open, edges: edges.size };
}
// The frontmost point of a field along +v at (u, y): the largest v inside the rock.
function front(field, u, y) {
  for (let v = field.hi[2]; v > field.lo[2]; v -= 0.02) if (field.sd(u, y, v) < 0) return v;
  return -Infinity;
}

test('slope is Horn 1981 (exact on a plane, edges included) and relief is the window max less min', () => {
  const n = 33,
    plane = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) plane[j * n + i] = i * 0.5 + 3;
  const s = findRockSites({ heights: plane, resolution: [n, n], size: [16, 16] }, { reliefRadius: 2 });
  // Rise 0.5 m per 0.5 m sample: 45 degrees.
  for (const v of s.slope) assert.ok(Math.abs(v - 45) < 1e-4, 'slope ' + v);
  const random = new Float32Array(41 * 29);
  let seed = 7;
  for (let k = 0; k < random.length; k++)
    random[k] = ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32) * 50;
  const g = { heights: random, resolution: [41, 29], size: [40, 28] },
    r = localRelief(g, 3, 2),
    at = (i, j) => random[Math.min(Math.max(j, 0), 28) * 41 + Math.min(Math.max(i, 0), 40)];
  for (let j = 0; j < 29; j++)
    for (let i = 0; i < 41; i++) {
      let hi = -Infinity,
        lo = Infinity;
      for (let b = -2; b <= 2; b++)
        for (let a = -3; a <= 3; a++) {
          hi = Math.max(hi, at(i + a, j + b));
          lo = Math.min(lo, at(i + a, j + b));
        }
      assert.ok(Math.abs(r[j * 41 + i] - (hi - lo)) < 1e-4, `relief at ${i}, ${j}`);
    }
});

test('cliffs stand on the steep high ground, face the sea and span foot to crest', () => {
  assert.ok(sites.cliffs.length >= 6, 'cliffs along the headland: ' + sites.cliffs.length);
  for (const c of sites.cliffs) {
    assert.ok(c.position[0] < 70, 'not on the gentle beach: ' + c.position);
    const g = rockGround(ground),
      [x, , z] = c.position,
      [fx, fz] = c.facing;
    assert.ok(
      g.height(x + fx * 4, z + fz * 4) < g.height(x - fx * 4, z - fz * 4) - 4,
      'faces down the slope: ' + c.facing,
    );
    assert.ok(c.slope >= 50 && c.relief >= 8, `steep and high: ${c.slope}, ${c.relief}`);
    assert.ok(c.top - c.base > 24, `foot to crest: ${c.base} to ${c.top}`);
    assert.ok(Math.abs(c.position[1] - (c.base + c.top) / 2) < 1e-6);
  }
  // Pieces stand 0.75 of a width apart at mid-face: they overlap, never stack.
  let nearest = Infinity;
  for (const a of sites.cliffs)
    for (const b of sites.cliffs)
      if (a !== b)
        nearest = Math.min(nearest, Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]));
  assert.ok(nearest >= 18 - 1e-9, 'nearest pieces ' + nearest);
  assert.equal(findRockSites(ground, { cliffSlope: 80 }).cliffs.length, 0, 'nothing on the coast is 80 degrees steep');
  assert.equal(findRockSites(ground, { cliffRelief: 60 }).cliffs.length, 0, 'nor 60 m of relief within 16 m');
});

test('sea rocks stand in their depth band off the shore, spaced; stacks off the cliffs rise high; boulders lie at the foot', () => {
  const g = rockGround(ground),
    land = [];
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) if (ground.heights[j * N + i] >= 0) land.push([i - 128, j - 128]);
  assert.ok(sites.seaRocks.length >= 10, 'sea rocks: ' + sites.seaRocks.length);
  for (const r of sites.seaRocks) {
    const [x, bed, z] = r.position,
      depth = -bed,
      shore = Math.min(...land.map(([a, b]) => Math.hypot(a - x, b - z)));
    assert.ok(depth >= 1 && depth <= 15, 'depth ' + depth);
    assert.ok(shore <= 80 + 1e-3, 'within reach of the shore: ' + shore);
    assert.ok(Math.abs(g.height(x, z) - bed) < 1e-4);
    if (r.kind === 'stack') assert.ok(r.top >= 2.5 && r.top <= 30, 'stack top ' + r.top);
    else assert.ok(r.top > 0.3 && r.top < 2.6, 'skerry top ' + r.top);
  }
  for (const a of sites.seaRocks)
    for (const b of sites.seaRocks)
      if (a !== b) assert.ok(Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]) >= 14 - 1e-6);
  assert.ok(
    sites.seaRocks.some((r) => r.kind === 'stack'),
    'stacks off the cliffed headland',
  );
  assert.ok(sites.boulders.length >= sites.cliffs.length * 2);
  for (const b of sites.boulders) {
    const c = sites.cliffs[b.cliff],
      out = (b.position[0] - c.foot[0]) * c.facing[0] + (b.position[2] - c.foot[1]) * c.facing[1];
    assert.ok(out >= -1e-6 && out <= (c.top - c.base) * 0.5 + 1e-6, 'in front of the foot: ' + out);
    assert.ok(Math.abs(g.height(b.position[0], b.position[2]) - b.position[1]) < 1e-4, 'on the ground');
    assert.ok(b.radius >= 0.3 && b.radius <= 6);
  }
  assert.deepEqual(findRockSites(ground), sites, 'the same ground and options give the same sites');
  assert.notDeepEqual(findRockSites(ground, { seed: 9 }).seaRocks, sites.seaRocks, 'a new seed picks again');
});

test('a cliff face covers the heightfield, leans out by its overhang and closes across polygonizer blocks', () => {
  const site = sites.cliffs[2],
    clean = { strata: 0, joints: 0, roughness: 0 },
    field = cliffField(site, ground),
    g = rockGround(ground),
    [px, , pz] = site.position,
    [fx, fz] = site.facing;
  // Every point of the ground's slope in the middle of the piece lies inside the rock: the smooth slope never shows.
  let inside = 0,
    count = 0;
  for (let u = -6; u <= 6; u += 0.5)
    for (let y = site.base + 1; y <= site.top - 1.5; y += 0.5) {
      // The ground's crossing of y, by bisection along the facing.
      let a = -40,
        b = 40;
      for (let it = 0; it < 40; it++) {
        const m = (a + b) / 2;
        if (g.height(px + fz * u + fx * m, pz - fx * u + fz * m) >= y) a = m;
        else b = m;
      }
      count++;
      if (field.sd(u, y, (a + b) / 2) < 0) inside++;
    }
  assert.ok(inside / count >= 0.98, `the face covers the ground slope: ${inside} of ${count}`);
  // Overhang: the face at 85% of the height stands out by about the overhang against a piece without one.
  const H = site.top - site.base,
    hi = site.base + 0.85 * H,
    lo = site.base + 0.4 * H,
    plain = cliffField(site, ground, { ...clean, overhang: 0 }),
    leaning = cliffField(site, ground, { ...clean, overhang: 4 }),
    big = cliffField(site, ground, { ...clean, overhang: 12 });
  assert.ok(
    front(leaning, 0, hi) - front(plain, 0, hi) > 3.4,
    `overhang 4: ${front(leaning, 0, hi) - front(plain, 0, hi)}`,
  );
  assert.ok(Math.abs(front(leaning, 0, lo) - front(plain, 0, lo)) < 0.05, 'the lower face is where it was');
  assert.ok(
    front(big, 0, hi) > front(big, 0, lo) + 1,
    `a true overhang: the top stands past the face below: ${front(big, 0, hi)} vs ${front(big, 0, lo)}`,
  );
  assert.ok(front(plain, 0, hi) < front(plain, 0, lo), 'without one the face leans back like the ground');
  // Strata ledges: hard beds stand out, so the face steps (its spread along the height grows by about the ledges).
  const spread = (f) => {
    const d = [];
    for (let y = site.base + 4; y < site.top - 4; y += 0.1) d.push(front(f, 0, y) - front(plain, 0, y));
    return Math.max(...d) - Math.min(...d);
  };
  assert.ok(
    spread(cliffField(site, ground, { ...clean, overhang: 0, strata: 1.5, ledges: 0.8 })) > 0.5,
    'ledges step the face',
  );
  // A mesh in blocks (a 0.2 m cell needs over 127 samples up the face): closed, faces out, no seam between blocks.
  const rock = buildCliff(site, ground, { cell: 0.2, roughness: 0.2 }),
    { open, edges } = openEdges(rock.geometry);
  assert.ok((site.top - site.base + 2) / 0.2 > 127, 'the piece spans several blocks');
  assert.equal(open, 0, `closed: ${open} of ${edges} edges are not shared by two triangles`);
  // Normals look out of the rock: the field rises along each vertex normal.
  const v = rock.geometry.vertices,
    big2 = cliffField(site, ground, { cell: 0.2, roughness: 0.2 });
  let out = 0;
  for (let i = 0; i < v.length; i += 6) {
    const local = (x, y, z) => [x * fz - z * fx, y + site.position[1], x * fx + z * fz],
      a = local(v[i] + v[i + 3] * 0.05, v[i + 1] + v[i + 4] * 0.05, v[i + 2] + v[i + 5] * 0.05),
      b = local(v[i] - v[i + 3] * 0.05, v[i + 1] - v[i + 4] * 0.05, v[i + 2] - v[i + 5] * 0.05);
    if (big2.sd(...a) > big2.sd(...b)) out++;
  }
  assert.ok(out / (v.length / 6) > 0.99, `normals look out: ${out} of ${v.length / 6}`);
  const again = buildCliff(site, ground, { cell: 0.2, roughness: 0.2 });
  assert.deepEqual(again.geometry.vertices, rock.geometry.vertices, 'the same site and options give the same mesh');
});

test('a sea stack has its wave-cut notch at the sea surface, a rounded top and a closed mesh', () => {
  const stack = { kind: 'stack', position: [0, -6, 0], radius: 4, top: 14, seaLevel: 0 },
    clean = { lobes: 0, strata: 0, joints: 0, roughness: 0 },
    radius = (f, y) => {
      for (let r = 8; r > 0; r -= 0.01) if (f.sd(r, y, 0) < 0) return r;
      return 0;
    },
    notched = seaRockField(stack, { ...clean, notchDepth: 1.2 }),
    smooth = seaRockField(stack, { ...clean, notchDepth: 0 });
  const cut = (y) => radius(smooth, y) - radius(notched, y);
  assert.ok(cut(0.1) > 1.1, 'the notch is cut at the sea surface: ' + cut(0.1));
  assert.ok(cut(2.5) < 0.05 && cut(-2.5) < 0.05, `and not far above or below: ${cut(2.5)}, ${cut(-2.5)}`);
  assert.ok(radius(notched, 0.1) < radius(notched, 2.5) - 0.8, 'the rock above overhangs the notch');
  assert.ok(radius(smooth, 13.5) < radius(smooth, 10), 'the top is rounded');
  for (const kind of ['stack', 'skerry']) {
    const rock = buildSeaRock({ ...stack, kind, top: kind === 'stack' ? 14 : 1.5 });
    assert.equal(openEdges(rock.geometry).open, 0, kind + ' mesh is closed');
    let low = Infinity;
    for (let i = 1; i < rock.geometry.vertices.length; i += 6) low = Math.min(low, rock.geometry.vertices[i]);
    assert.ok(low < -0.8 && low > -1.3, kind + ' reaches 1 m into the bed: ' + low);
  }
  assert.ok(
    Math.abs(
      radius(notched, 0.1) - radius(seaRockField({ ...stack, seaLevel: 5 }, { ...clean, notchDepth: 1.2 }), 5.1),
    ) < 0.25,
    'the notch follows the sea level',
  );
});

test('a boulder is a closed, faceted block partly buried in the ground', () => {
  const site = { kind: 'boulder', position: [3, 2, -1], radius: 1.5, cliff: 0 },
    rock = buildBoulder(site),
    v = rock.geometry.vertices;
  assert.equal(openEdges(rock.geometry).open, 0);
  let low = Infinity,
    far = 0;
  for (let i = 0; i < v.length; i += 6) {
    low = Math.min(low, v[i + 1] + rock.position[1]);
    far = Math.max(far, Math.hypot(v[i], v[i + 1], v[i + 2]));
  }
  assert.ok(low < site.position[1] - 0.2, 'partly buried: lowest ' + low);
  assert.ok(far < 1.5 * 1.3, 'within its size: ' + far);
  // Facets: the field is flat between edges, so most surface normals cluster on the planes (not a sphere).
  const f = boulderField(site, { roughness: 0 });
  assert.ok(f.sd(0, 0, 0) < -0.9, 'solid inside');
  const all = buildRocks(
    {
      ...sites,
      cliffs: sites.cliffs.slice(0, 1),
      seaRocks: sites.seaRocks.slice(0, 2),
      boulders: sites.boulders.slice(0, 2),
    },
    ground,
  );
  assert.equal(all.length, 5);
});

test('fallen boulders keep a broad bearing face and seeded fracture profiles', () => {
  const site = { kind: 'boulder', position: [3, 2, -1], radius: 2, cliff: 0 };
  const fields = [1, 17, 27, 1234].map((seed) => boulderField(site, { seed, roughness: 0, rounding: 0 }));
  for (const { sd } of fields) {
    for (const [x, z] of [
      [0, 0],
      [-0.4, 0.3],
      [0.4, -0.3],
    ]) {
      assert.ok(Math.abs(sd(x, -1.68, z)) < 1e-7, 'the same bedding plane lies under the whole footprint');
      assert.ok(sd(x, -1.58, z) < 0 && sd(x, -1.78, z) > 0);
    }
  }
  const profiles = fields.map(({ sd }) =>
    [
      [0.45, 1.25, 0],
      [-0.45, 1.25, 0],
    ]
      .map((p) => sd(...p))
      .join('/'),
  );
  assert.equal(new Set(profiles).size, fields.length);
});

test('bad input throws RangeError with the README section', () => {
  assert.throws(() => findRockSites({ heights: [0], resolution: [1, 1], size: [1, 1] }), RangeError);
  assert.throws(() => findRockSites(ground, { cliffSlope: 10 }), /Cliffs, overhangs and sea rocks/);
  assert.throws(() => findRockSites(ground, { seaRockDepth: [5, 1] }), RangeError);
  assert.throws(() => buildCliff(sites.seaRocks[0], ground), RangeError);
  assert.throws(() => buildCliff(sites.cliffs[0], ground, { overhang: -1 }), RangeError);
  assert.throws(() => buildSeaRock(sites.seaRocks[0], { notchHeight: 0 }), RangeError);
  assert.throws(() => buildBoulder(sites.boulders[0], { facets: 3 }), RangeError);
});

test('rock look: types, defaults and checks', () => {
  const surface = new RockSurface();
  assert.deepEqual({ ...surface.look }, { ...ROCK_LOOK_DEFAULTS });
  assert.equal(surface.name.startsWith('terrain:rocks:'), true, 'the weather drive finds it by name');
  surface.setLook({ bump: 2, mossColor: [0.2, 0.22, 0.16] });
  assert.equal(surface.look.bump, 2);
  assert.throws(() => surface.setLook({ bump: 4 }), RangeError);
  assert.throws(() => surface.setLook({ shine: 1 }), TypeError);
  assert.throws(() => new RockSurface({ rain: 2 }), RangeError);
  for (const t of Object.values(ROCK_TYPES))
    assert.ok(
      t.color.every((c) => c > 0 && c < 0.8),
      'albedo of real rock',
    );
  assert.ok(ROCK_TYPES.basalt.color[0] < ROCK_TYPES.chalk.color[0] / 5);
});

test('rock settings: the shared row shape, live look rows, shape rows for the builders, rain follows the weather', () => {
  for (const row of ROCK_SETTINGS) {
    assert.ok(row.name && row.group && row.kind && row.about, row.name);
    assert.equal(typeof row.live, 'boolean');
    if (row.kind === 'number' && row.default !== null)
      assert.ok(row.default >= row.min && row.default <= row.max, row.name);
  }
  const rain = ROCK_SETTINGS.find((r) => r.name === 'wet.rain');
  assert.equal(rain.default, null);
  assert.equal(rain.nullable, true);
  assert.equal(rain.weather, 'rainRate');
  const surface = new RockSurface(),
    defaults = rockSettingDefaults();
  // Every live row at its default draws the look RockSurface starts from.
  const look = rockLookOf(
    Object.fromEntries(Object.entries(defaults).filter(([k]) => ROCK_SETTINGS.find((r) => r.name === k).live)),
  );
  for (const [k, v] of Object.entries(look)) assert.deepEqual(v, ROCK_LOOK_DEFAULTS[k], k);
  applyRockSettings(surface, { 'detail.bump': 1.5, 'wet.rain': 0.4 });
  assert.equal(surface.look.bump, 1.5);
  assert.equal(surface.look.rain, 0.4);
  assert.equal(heldFromWeather(surface.look, 'rain'), true, 'a set rain holds against the weather');
  applyRockSettings(surface, { 'wet.rain': null });
  assert.equal(heldFromWeather(surface.look, 'rain'), false, 'null hands it back');
  assert.deepEqual(rockShapeOf({ 'cliff.overhang': 6, 'sea.notchDepth': 1, 'detail.bump': 1 }), {
    cliff: { overhang: 6 },
    seaRock: { notchDepth: 1 },
  });
  // Every shape row is an option of its builder: building with all of them at their defaults gives the default mesh.
  const shape = rockShapeOf(Object.fromEntries(ROCK_SETTINGS.filter((r) => !r.live).map((r) => [r.name, r.default])));
  assert.deepEqual(
    buildCliff(sites.cliffs[0], ground, shape.cliff).geometry.vertices,
    buildCliff(sites.cliffs[0], ground).geometry.vertices,
  );
  assert.deepEqual(
    buildSeaRock(sites.seaRocks[0], shape.seaRock).geometry.vertices,
    buildSeaRock(sites.seaRocks[0]).geometry.vertices,
  );
  assert.throws(() => applyRockSettings(surface, { 'detail.shine': 1 }), TypeError);
  assert.throws(() => applyRockSettings(surface, { 'detail.bump': 9 }), RangeError);
});
