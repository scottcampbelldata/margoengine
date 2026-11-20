// @margoengine/biomes/settlements: villages on flat dry ground near water, roads that follow the terrain (through a
// pass, not over the ridge; one short bridge over a river; none across the sea), houses on dry level lots clear of
// the roads and of each other, and placement exclusions that keep every tree off the roads and the houses. Same world
// and options, same bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld } from '../dist/index.js';
import { BiomePlacement } from '../dist/placement.js';
import { carvePaths, definePath } from '../dist/splines.js';
import { layoutSettlements } from '../dist/settlements.js';

const flat = (h = 10) => ({ bounds: [-1000, -1000, 1000, 1000], heightAt: () => h });
const along = (points, f) => {
  // Samples every metre along a polyline.
  const out = [];
  for (let k = 0; k + 1 < points.length; k++) {
    const [ax, az] = points[k],
      [bx, bz] = points[k + 1],
      n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
    for (let s = 0; s <= n; s++) out.push(f(ax + ((bx - ax) * s) / n, az + ((bz - az) * s) / n));
  }
  return out;
};
const seg2 = (x, z, [ax, az], [bx, bz]) => {
  const dx = bx - ax,
    dz = bz - az,
    t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
};

test('sites: flat, dry, low and near water win; spacing holds; the count is a most', () => {
  // Two flat discs: a low one 120 m from a river and a high dry one; steep ground (grade 0.2) everywhere else.
  const discs = [
    { x: -500, z: 300, h: 12 },
    { x: 500, z: -400, h: 70 },
  ];
  const world = {
    bounds: [-1000, -1000, 1000, 1000],
    heightAt(x, z) {
      let h = Infinity;
      for (const d of discs) h = Math.min(h, d.h + 0.2 * Math.max(0, Math.hypot(x - d.x, z - d.z) - 100));
      return h;
    },
    rivers: [Int32Array.from([-1000000, 420000, 1000000, 420000])],
  };
  const one = layoutSettlements(world, { villages: 1, houses: 0 });
  assert.equal(one.villages.length, 1);
  assert.ok(Math.hypot(one.villages[0].centre[0] + 500, one.villages[0].centre[1] - 300) < 100, 'the low disc by the river');
  const two = layoutSettlements(world, { villages: 5, houses: 0, spacing: 300 });
  assert.equal(two.villages.length, 2, 'only the two discs are flat enough');
  for (const v of two.villages) {
    assert.ok(discs.some((d) => Math.hypot(v.centre[0] - d.x, v.centre[1] - d.z) < 100), `${v.centre} on a disc`);
    assert.equal(v.height, world.heightAt(...v.centre));
  }
  const near = layoutSettlements(world, { villages: 5, houses: 0, spacing: 1500 });
  assert.equal(near.villages.length, 1, 'the discs are 1,280 m apart, under the spacing');
  assert.equal(layoutSettlements(flat(-5), { villages: 3 }).villages.length, 0, 'all sea: no site');
});

test('roads follow the terrain: through the pass, not over the ridge', () => {
  // A 60 m ridge along x = 0, 240 m wide, with a saddle down to the plain at z = 300.
  const world = {
    bounds: [-1000, -1000, 1000, 1000],
    heightAt: (x, z) => 10 + 60 * Math.max(0, 1 - Math.abs(x) / 120) * Math.min(1, Math.abs(z - 300) / 250),
  };
  const sites = [
    [-700, -300],
    [700, -300],
  ];
  const s = layoutSettlements(world, { sites, houses: 0 });
  assert.equal(s.roads.length, 1);
  const top = Math.max(...along(s.roads[0].points, world.heightAt));
  const straight = Math.max(...along(sites, world.heightAt));
  assert.equal(straight, 70, 'the straight way goes over the top');
  assert.ok(top < 22, `the road stays low: ${top.toFixed(1)} m`);
  // Sites snap to the 16 m grid from the world's corner.
  assert.deepEqual(s.villages.map((v) => v.centre), [
    [-696, -296],
    [696, -296],
  ]);
  assert.deepEqual(s.roads[0].points[0], s.villages[0].centre);
  assert.deepEqual(s.roads[0].points.at(-1), s.villages[1].centre);
  // A steeper grade allowed: the road takes a shorter way, higher on the flank.
  const steep = layoutSettlements(world, { sites, houses: 0, maxGrade: 1 });
  const length = (p) => p.slice(1).reduce((sum, q, k) => sum + Math.hypot(q[0] - p[k][0], q[1] - p[k][1]), 0);
  assert.ok(length(steep.roads[0].points) < length(s.roads[0].points));
});

test('a river is crossed once, on a short bridge; the sea is never crossed', () => {
  const river = Int32Array.from([-1000000, 0, 1000000, 0]);
  const s = layoutSettlements({ ...flat(), rivers: [river] }, { sites: [[-300, -500], [200, 500]], houses: 0 });
  const p = s.roads[0].points;
  let crossings = 0;
  for (let k = 0; k + 1 < p.length; k++) if (Math.sign(p[k][1]) !== Math.sign(p[k + 1][1])) crossings++;
  assert.equal(crossings, 1);
  // Two islands with sea between: villages, no road.
  const islands = {
    bounds: [-1000, -1000, 1000, 1000],
    heightAt: (x) => (Math.abs(x) > 300 ? 10 : -5),
    climate: { sea: 0 },
  };
  const apart = layoutSettlements(islands, { sites: [[-600, 0], [600, 0]] });
  assert.equal(apart.villages.length, 2);
  assert.equal(apart.roads.length, 0);
});

test('a network: a spanning tree joins every village, plus a link where the tree detours', () => {
  const sites = [
    [-800, 0],
    [-400, 0],
    [0, 0],
    [400, 0],
    [800, 0],
    [0, 700],
  ];
  const s = layoutSettlements(flat(), { sites, houses: 0, detour: 100 });
  assert.equal(s.roads.length, sites.length - 1, 'a tree');
  const parent = sites.map((_, i) => i),
    find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i]))),
    index = (p) => s.villages.findIndex((v) => v.centre[0] === p[0] && v.centre[1] === p[1]);
  for (const r of s.roads) parent[find(index(r.points[0]))] = find(index(r.points.at(-1)));
  assert.equal(new Set(sites.map((_, i) => find(i))).size, 1, 'connected');
  const ring = layoutSettlements(flat(), { sites: [[-500, 0], [500, 0], [0, 600], [0, -600]], houses: 0 });
  assert.ok(ring.roads.length >= 4, 'a link closes a long detour');
});

test('houses: dry level lots, clear of roads, lanes and each other, facing their lane', () => {
  const river = Int32Array.from([-1000000, 150000, 1000000, 150000]);
  const world = { bounds: [-1000, -1000, 1000, 1000], heightAt: (x, z) => 10 + 0.01 * x + 0.004 * z, rivers: [river] };
  const s = layoutSettlements(world, { sites: [[-400, -100], [400, -100]], houses: 24 });
  const all = s.villages.flatMap((v) => v.houses);
  assert.ok(s.villages.every((v) => v.houses.length >= 12), `houses: ${s.villages.map((v) => v.houses.length)}`);
  for (const h of all) {
    assert.ok(h.corners.every(([, z]) => Math.abs(z - 150) > 8), 'not in the river');
    assert.ok(Math.abs(h.floor - world.heightAt(...h.centre)) < 1e-9);
    for (const r of s.roads)
      for (let k = 0; k + 1 < r.points.length; k++)
        for (const c of [h.centre, ...h.corners])
          assert.ok(seg2(...c, r.points[k], r.points[k + 1]) >= 5.5 - 1e-9, 'off the road and its edge');
    for (const l of s.lanes) for (const c of h.corners) assert.ok(seg2(...c, ...l.points) >= 2.5 - 1e-9, 'off the lanes');
    const [ux, uz] = h.along,
      [a, b] = h.corners;
    assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - h.size[0]) < 1e-9, 'width along the lane');
    assert.ok(Math.abs((b[0] - a[0]) * uz - (b[1] - a[1]) * ux) < 1e-9, 'the front runs along the lane');
  }
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      assert.ok(
        Math.hypot(all[i].centre[0] - all[j].centre[0], all[i].centre[1] - all[j].centre[1]) >=
          Math.hypot(...all[i].size) / 2 + Math.hypot(...all[j].size) / 2,
        'houses apart',
      );
  assert.ok(s.lanes.length > 0);
  assert.equal(s.paths.length, s.roads.length + s.lanes.length);
  assert.equal(s.exclusions.length, s.paths.length + all.length);
});

test('placement keeps every tree and shrub off the roads and houses; the roads carve the ground', async () => {
  const probe = await BiomeWorld.create({ size: [1024, 1024] });
  // Hilly relief: lots up to a 15 % grade (terraced), sites found by the search.
  const town = layoutSettlements(probe, { villages: 2, spacing: 400, houses: 10, cell: 8, siteGrade: 0.15 });
  assert.equal(town.roads.length, 1);
  const world = await BiomeWorld.create({ size: [1024, 1024], height: carvePaths(town.paths) });
  const p = BiomePlacement.attach(world, { exclusions: town.exclusions }),
    free = BiomePlacement.attach(world);
  const rect = [-512, -512, 512, 512],
    kept = (await p.inspect(rect)).filter((c) => c.fate === 'accepted'),
    all = (await free.inspect(rect)).filter((c) => c.fate === 'accepted');
  const inside = (o, [a, b, , d]) => {
    const u = [b[0] - a[0], b[1] - a[1]],
      v = [d[0] - a[0], d[1] - a[1]],
      s = ((o.x - a[0]) * u[0] + (o.z - a[1]) * u[1]) / (u[0] ** 2 + u[1] ** 2),
      t = ((o.x - a[0]) * v[0] + (o.z - a[1]) * v[1]) / (v[0] ** 2 + v[1] ** 2);
    return s > 0 && s < 1 && t > 0 && t < 1;
  };
  const houses = town.villages.flatMap((v) => v.houses);
  assert.ok(houses.length >= 6, `houses: ${houses.length}`);
  // The road's drawn centre line (a Catmull-Rom curve through the points) and half its width.
  const lines = town.roads.map((r) => {
    const { line } = definePath(r),
      p = [];
    for (let k = 0; k < line.length; k += 2) p.push([line[k] / 1000, line[k + 1] / 1000]);
    return p;
  });
  const onRoad = (o) => lines.some((p) => p.slice(1).some((q, k) => seg2(o.x, o.z, p[k], q) < 2.5 - 0.01));
  assert.ok(all.some(onRoad) && all.some((o) => houses.some((h) => inside(o, h.corners))), 'without them trees stand there');
  for (const o of kept) {
    assert.ok(!houses.some((h) => inside(o, h.corners)), `object inside a house at ${o.x}, ${o.z}`);
    assert.ok(!onRoad(o), `object on the road at ${o.x}, ${o.z}`);
  }
  // Carved: the ground under the road's middle moved toward its bed, the ground well away from it did not.
  const mid = lines[0][lines[0].length >> 1];
  assert.notEqual(world.heightAt(...mid), probe.heightAt(...mid));
  assert.equal(world.heightAt(mid[0] + 60, mid[1] + 60), probe.heightAt(mid[0] + 60, mid[1] + 60));
});

test('same world and options, same bytes; the seed changes the jitter', async () => {
  const world = await BiomeWorld.create({ size: [2048, 2048] });
  const a = JSON.stringify(layoutSettlements(world, { villages: 3, spacing: 500 })),
    b = JSON.stringify(layoutSettlements(world, { villages: 3, spacing: 500 }));
  assert.equal(a, b);
  assert.ok(JSON.parse(a).villages.length >= 2);
  assert.notEqual(JSON.stringify(layoutSettlements(world, { villages: 3, spacing: 500, seed: 7 })), a);
});

test('bad options throw with what is allowed', () => {
  const w = flat();
  assert.throws(() => layoutSettlements({}), TypeError);
  assert.throws(() => layoutSettlements({ bounds: [0, 0, 0, 1], heightAt: () => 0 }), RangeError);
  for (const o of [
    { villages: 65 },
    { villages: 1.5 },
    { spacing: 10 },
    { houses: -1 },
    { cell: 1 },
    { maxGrade: 0 },
    { siteGrade: 2 },
    { bridge: 0.5 },
    { detour: 0.5 },
    { yard: -1 },
    { seed: -1 },
    { sites: [[5000, 0]] },
  ])
    assert.throws(() => layoutSettlements(w, o), RangeError, JSON.stringify(o));
  assert.throws(() => layoutSettlements(w, { road: { points: [] } }), TypeError);
  assert.throws(() => layoutSettlements({ bounds: [0, 0, 1e6, 1e6], heightAt: () => 0 }, { cell: 2 }), /larger cell/);
});

// ---- Grid pattern, house pads and driveways -------------------------------------------------------------------------
// A gentle slope that falls to the sea in the east: sea level 0 along x = 300, a little wave across it.
const coast = {
  bounds: [-1000, -1000, 1000, 1000],
  heightAt: (x, z) => Math.max(-6, (300 - x) * 0.02 + 0.3 * Math.sin(z / 40)),
  climate: { sea: 0 },
};
const gridTown = (extra = {}) =>
  layoutSettlements(coast, { villages: 1, houses: 60, pattern: 'grid', sites: [[-100, 0]], ...extra });
const dist = (p, path) => Math.min(...path.points.slice(1).map((q, k) => seg2(p[0], p[1], path.points[k], q)));
const sat = (a, b) => {
  // Separating axis test of two convex quads: true when they overlap.
  for (const quad of [a, b])
    for (let i = 0; i < 4; i++) {
      const [x0, z0] = quad[i],
        [x1, z1] = quad[(i + 1) % 4],
        nx = z1 - z0,
        nz = x0 - x1;
      const span = (q) => q.map(([x, z]) => x * nx + z * nz);
      const sa = span(a),
        sb = span(b);
      if (Math.max(...sa) <= Math.min(...sb) || Math.max(...sb) <= Math.min(...sa)) return false;
    }
  return true;
};
// Whether two straight two-point paths cross or touch (a T junction counts).
const crosses = (p, q) => {
  const [[ax, az], [bx, bz]] = p.points,
    [[cx, cz], [dx, dz]] = q.points,
    d = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
  if (Math.abs(d) < 1e-9) return false;
  const s = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / d,
    t = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / d;
  return s >= -0.01 && s <= 1.01 && t >= -0.01 && t <= 1.01;
};

test('lanes: the default layout keeps its bytes, and pads and drives are off', async () => {
  const { createHash } = await import('node:crypto');
  const w = { bounds: [-1000, -1000, 1000, 1000], heightAt: (x, z) => 10 + 0.01 * x + 3 * Math.sin(z / 90), climate: { sea: 0 } };
  const out = layoutSettlements(w, { villages: 2, spacing: 400, houses: 24, sites: [[0, 0], [500, 300]] });
  assert.equal(createHash('sha256').update(JSON.stringify(out)).digest('hex').slice(0, 16), 'b50a0b0c41137391');
  assert.equal(out.pads, undefined);
  assert.equal(out.drives, undefined);
  assert.equal(out.villages[0].streets, undefined);
  assert.equal(out.villages[0].houses[0].front, undefined);
});

test('grid: the main street runs to the quay and every street joins it', () => {
  const town = gridTown(),
    v = town.villages[0];
  assert.equal(v.houses.length, 60);
  assert.equal(v.streets.length, town.lanes.length, 'the streets are the lanes of the village');
  const main = v.streets[0];
  // Toward the sea (east, within a few degrees) and out to the shore at x = 300, back west past the village centre.
  const [a, b] = main.points,
    len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  assert.ok((b[0] - a[0]) / len > 0.99, 'runs east');
  assert.ok(b[0] > 270 && b[0] < 315, `quay end at ${b}`);
  assert.ok(a[0] < v.centre[0] - 100, 'and back past the village centre');
  assert.ok(dist(v.centre, main) < 1e-6, 'through the centre');
  for (const s of v.streets) {
    assert.equal(s.points.length, 2, 'straight');
    assert.equal(s.width, 8);
  }
  const seen = new Set([0]);
  for (let grew = true; grew; ) {
    grew = false;
    v.streets.forEach((s, i) => {
      if (!seen.has(i) && [...seen].some((j) => crosses(s, v.streets[j]))) {
        seen.add(i);
        grew = true;
      }
    });
  }
  assert.equal(seen.size, v.streets.length, 'every street joins the main street');
});

test('grid: each house is a dry level lot that fronts a street, off every street and every other house', () => {
  const town = gridTown(),
    v = town.villages[0];
  const used = new Set();
  for (const h of v.houses) {
    const street = v.streets[h.street];
    assert.ok(street, 'a street index');
    used.add(h.street);
    assert.ok(Math.abs(Math.hypot(...h.front) - 1) < 1e-12, 'unit front');
    // Centre to its street's centre line: half the depth, the setback (4) and half the street (4).
    assert.ok(Math.abs(dist(h.centre, street) - (h.size[1] / 2 + 4 + 4)) < 1e-6, `${dist(h.centre, street)}`);
    const d = h.size[1] / 2 + 8;
    assert.ok(dist([h.centre[0] + h.front[0] * d, h.centre[1] + h.front[1] * d], street) < 1e-6, 'front faces the street');
    assert.ok(Math.abs(h.along[0] * h.front[0] + h.along[1] * h.front[1]) < 1e-12, 'frontage is square to the front');
    for (const [x, z] of [h.centre, ...h.corners]) assert.ok(coast.heightAt(x, z) > 0, `dry at ${x}, ${z}`);
    for (const s of v.streets)
      for (const c of h.corners) assert.ok(dist(c, s) >= 4.99, `corner ${dist(c, s)} from a street`);
  }
  assert.ok(used.size >= 4, `houses on ${used.size} streets`);
  for (let i = 0; i < v.houses.length; i++)
    for (let j = i + 1; j < v.houses.length; j++)
      assert.ok(!sat(v.houses[i].corners, v.houses[j].corners), `houses ${i} and ${j} overlap`);
  const reach = v.houses.map((h) => Math.hypot(h.centre[0] - v.centre[0], h.centre[1] - v.centre[1]));
  assert.ok(v.radius >= Math.max(...reach));
  assert.equal(town.exclusions.length, town.roads.length + town.lanes.length + town.drives.length + 60);
});

test('grid: pads level the ground under each house and drives run from its front to its street', async () => {
  const probe = await BiomeWorld.create({ size: [1024, 1024] });
  const town = layoutSettlements(probe, { villages: 1, houses: 30, cell: 8, pattern: 'grid', siteGrade: 0.15 });
  const v = town.villages[0];
  assert.equal(v.houses.length, 30);
  assert.equal(town.pads.length, 30);
  assert.equal(town.drives.length, 30);
  assert.equal(town.paths.length, town.roads.length + town.lanes.length + 60);
  const carved = await BiomeWorld.create({ size: [1024, 1024], height: carvePaths(town.paths) });
  let moved = 0;
  v.houses.forEach((h, n) => {
    for (const [x, z] of [h.centre, ...h.corners])
      assert.ok(Math.abs(carved.heightAt(x, z) - h.floor) < 0.05, `house ${n} ground ${carved.heightAt(x, z)} floor ${h.floor}`);
    if (Math.abs(probe.heightAt(...h.corners[0]) - h.floor) > 0.05) moved++;
    const drive = town.drives[n],
      [p0, p1] = drive.points,
      street = v.streets[h.street];
    assert.ok(Math.abs(Math.hypot(p0[0] - h.centre[0], p0[1] - h.centre[1]) - (h.size[1] / 2 - 0.5)) < 1e-6, 'starts inside the front');
    assert.ok(Math.abs(dist(p1, street) - (4 - 0.5)) < 1e-6, 'ends half a metre into the street edge');
    assert.equal(drive.width, 3);
    assert.equal(drive.mask, 'roads');
  });
  assert.ok(moved > 3, 'the pads change the ground on a slope');
  assert.equal(town.pads[0].carve.mode, 'flatten');
});

test('lanes with pads and drives: each house gets both, its floor is the pad level, its drive meets the lane', () => {
  const w = { bounds: [-1000, -1000, 1000, 1000], heightAt: (x, z) => 10 + 0.02 * x + 0.5 * Math.sin(z / 30), climate: { sea: 0 } };
  const plain = layoutSettlements(w, { villages: 1, houses: 12, sites: [[0, 0]] });
  const town = layoutSettlements(w, { villages: 1, houses: 12, sites: [[0, 0]], pads: true, drives: true });
  const houses = town.villages[0].houses;
  assert.equal(houses.length, plain.villages[0].houses.length, 'the same lots');
  assert.ok(houses.length > 0);
  assert.equal(town.pads.length, houses.length);
  assert.equal(town.drives.length, houses.length);
  houses.forEach((h, n) => {
    const [[ax, az], [bx, bz]] = town.pads[n].points;
    assert.ok(Math.abs(h.floor - (w.heightAt(ax, az) + w.heightAt(bx, bz)) / 2) < 1e-9, 'floor is the pad level');
    const [p0, p1] = town.drives[n].points,
      lane = town.lanes.find((l) => dist(p1, l) < 1.5) ?? town.roads.find((r) => dist(p1, r) < 3.5);
    assert.ok(lane, `drive ${n} ends on its lane or road edge`);
    assert.ok(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > 2.9);
  });
});

test('grid options: toward, above, block, lot and street, and a land with no water', () => {
  const north = gridTown({ grid: { toward: [0, 1] } }).villages[0];
  const [a, b] = north.streets[0].points;
  assert.ok(Math.abs(b[0] - a[0]) < 1e-9 && b[1] > a[1], 'the main street runs along +z');
  const high = gridTown({ grid: { above: 5 }, houses: 20 }).villages[0];
  assert.ok(high.houses.length > 0);
  for (const h of high.houses) for (const [x, z] of h.corners) assert.ok(coast.heightAt(x, z) >= 5, 'five metres over the sea');
  const sized = gridTown({ grid: { block: [80, 50], street: 12, lot: 20, setback: 6 }, houses: 20 }).villages[0];
  assert.ok(sized.houses.length > 0);
  assert.ok(sized.streets.every((s) => s.width === 12));
  for (const h of sized.houses) assert.ok(Math.abs(dist(h.centre, sized.streets[h.street]) - (h.size[1] / 2 + 6 + 6)) < 1e-6);
  const opts = { villages: 1, houses: 20, pattern: 'grid', sites: [[0, 0]] };
  const dryLand = layoutSettlements(flat(10), opts);
  assert.equal(dryLand.villages[0].houses.length, 20, 'a seeded direction without water');
  assert.equal(JSON.stringify(dryLand), JSON.stringify(layoutSettlements(flat(10), opts)));
  const none = layoutSettlements(coast, { villages: 1, houses: 0, pattern: 'grid', sites: [[-100, 0]] });
  assert.deepEqual([none.villages[0].houses.length, none.villages[0].streets.length], [0, 0]);
});

test('grid: same world and options, same bytes; the seed changes the house sizes', () => {
  const a = JSON.stringify(gridTown());
  assert.equal(a, JSON.stringify(gridTown()));
  assert.notEqual(a, JSON.stringify(gridTown({ seed: 9 })));
});

test('grid: bad settings throw with what is allowed', () => {
  const w = flat();
  for (const o of [
    { pattern: 'spiral' },
    { pads: 1 },
    { drives: 'yes' },
    { grid: { block: [4, 40] } },
    { grid: { block: [40] } },
    { grid: { street: 1 } },
    { grid: { lot: 100 } },
    { grid: { setback: -1 } },
    { grid: { above: -1 } },
    { grid: { toward: [0, 0] } },
    { grid: { toward: [1] } },
  ])
    assert.throws(() => layoutSettlements(w, o), RangeError, JSON.stringify(o));
  assert.throws(() => layoutSettlements(w, { grid: null }), TypeError);
  assert.throws(() => layoutSettlements(w, { drive: { points: [] } }), TypeError);
});

// `avoid` (timber-valley, scenes plan push 13): the grid town on a mountain valley floor laid lots across the rail line
// and the creek, which layoutSettlements did not know of. A house whose footprint touches an avoided line or polygon is
// not built, in both patterns; the same layout without it still crosses the line.
test('avoid keeps every house footprint off the given lines and polygons, in both patterns', () => {
  const rail = { kind: 'line', points: [[-1000, 20], [1000, 20]], width: 10, verge: 1 },
    yard = { kind: 'polygon', points: [[-160, -80], [-120, -80], [-120, -40], [-160, -40]] },
    touches = (h) => {
      const pts = [...h.corners, h.centre];
      for (let i = 0; i < 4; i++) {
        const a = h.corners[i],
          b = h.corners[(i + 1) % 4];
        pts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      }
      return pts.some(
        ([x, z]) => Math.abs(z - 20) <= 6 || (x >= -160 && x <= -120 && z >= -80 && z <= -40),
      );
    };
  for (const [name, layout] of [
    ['grid', (extra) => gridTown(extra)],
    ['lanes', (extra) => layoutSettlements(flat(), { villages: 1, houses: 40, sites: [[-100, 0]], ...extra })],
  ]) {
    const before = layout({}).villages.flatMap((v) => v.houses),
      after = layout({ avoid: [rail, yard] }).villages.flatMap((v) => v.houses);
    assert.ok(before.some(touches), `${name}: without avoid some house touches the line or the yard`);
    assert.ok(after.length > 0, `${name}: houses are still built`);
    assert.deepEqual(after.filter(touches), [], `${name}: no house touches the line or the yard`);
  }
  for (const bad of [{}, [{ kind: 'line', points: [[0, 0]], width: 4 }], [{ kind: 'line', points: [[0, 0], [1, 1]] }], [{ kind: 'ring', points: [] }]])
    assert.throws(() => gridTown({ avoid: bad }), TypeError, JSON.stringify(bad));
});
