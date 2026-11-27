// Interiors of rules buildings (limits gap row 19): stairs from storey to storey with open wells and guards, room uses,
// kitchen and bathroom fixtures and soft furnishings. Every bound is a code or trade figure: International Residential
// Code 2021 R311.7 (stair 36 in wide, riser at most 7 3/4 in, tread at least 10 in, headroom 6 ft 8 in), R312 (guard at
// least 36 in) and R307.1 (15 in from a water closet's centre line, 21 in clear in front); Japan's Building Standard Law
// Enforcement Order art. 23 (stair 75 cm wide, riser at most 23 cm, tread at least 15 cm; 1.2 m, 20 cm and 24 cm under
// more than 200 square metres of rooms); Blondel's step rule; tatami laid so no four corners meet. None of these
// existed before this change, so every test fails on the old tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILDING_STYLES, generateBuilding } from '@margoengine/procedural/building-rules';
import { generateBuildingPlan } from '@margoengine/procedural/building-plans';
import { BUILDING_SETTINGS, buildingOptionsFromSettings } from '@margoengine/procedural/building-settings';

const IN = 0.0254;
const MULTI = BUILDING_STYLES.filter((style) => generateBuilding({ style }).floors.length > 1);
const rect = (f) => ({
  x0: f.min[0],
  x1: f.max[0],
  z0: f.min[2] ?? f.min[1],
  z1: f.max[2] ?? f.max[1],
});
const overlap = (a, b, eps = 1e-6) => a.x0 < b.x1 - eps && a.x1 > b.x0 + eps && a.z0 < b.z1 - eps && a.z1 > b.z0 + eps;
/** Horizontal triangles of a part that face up or down: `[y, xs, zs]`. */
function level(g, up) {
  const out = [];
  if (!g) return out;
  for (let t = 0; t < g.indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => g.indices[t + k] * 3);
    if (g.normals[v[0] + 1] * (up ? 1 : -1) < 0.99) continue;
    out.push([g.positions[v[0] + 1], v.map((i) => g.positions[i]), v.map((i) => g.positions[i + 2])]);
  }
  return out;
}
function covers([, xs, zs], x, z) {
  const side = (a, b) => (xs[b] - xs[a]) * (z - zs[a]) - (zs[b] - zs[a]) * (x - xs[a]);
  const s = [side(0, 1), side(1, 2), side(2, 0)];
  return s.every((v) => v >= -1e-9) || s.every((v) => v <= 1e-9);
}

test('every house, shop block and public building has a stair from each storey to the next, to its code', () => {
  assert.deepEqual(MULTI, [
    'japan-2011-house',
    'japan-2011-concrete',
    'western-1910-house',
    'western-1910-false-front',
    'western-1910-brick',
  ]);
  for (const style of MULTI) {
    const b = generateBuilding({ style }),
      japan = style.startsWith('japan'),
      large = style === 'japan-2011-concrete';
    assert.equal(b.stairs.length, b.floors.length - 1, style);
    assert.ok(b.parts.stairs, style);
    for (const s of b.stairs) {
      const storey = b.floors[s.floor + 1] - b.floors[s.floor];
      assert.ok(Math.abs(s.risers * s.rise - storey) < 1e-6, `${style} the risers climb the storey`);
      assert.ok(s.rise <= (large ? 0.2 : japan ? 0.23 : 7.75 * IN) + 1e-6, `${style} rise ${s.rise}`);
      assert.ok(s.tread >= (large ? 0.24 : japan ? 0.15 : 10 * IN) - 1e-6, `${style} tread ${s.tread}`);
      assert.ok(s.width >= (large ? 1.2 : japan ? 0.75 : 36 * IN) - 1e-6, `${style} width ${s.width}`);
      assert.ok(s.guard >= (japan ? 1.1 : 36 * IN) - 1e-6, `${style} guard ${s.guard}`);
      // Blondel: two rises and a going make a walking pace.
      const pace = 2 * s.rise + s.tread;
      assert.ok(pace >= 0.55 && pace <= 0.72, `${style} pace ${pace}`);
      // The footprint lies in one room on both floors and no block stands in it.
      const body = { x0: s.min[0], x1: s.max[0], z0: s.min[1], z1: s.max[1] };
      for (const floor of [s.floor, s.floor + 1]) {
        assert.ok(
          b.rooms.some(
            (r) =>
              r.floor === floor &&
              body.x0 >= r.min[0] &&
              body.x1 <= r.max[0] &&
              body.z0 >= r.min[1] &&
              body.z1 <= r.max[1],
          ),
          `${style} the stair is in a room on floor ${floor}`,
        );
        for (const f of b.furniture.filter((q) => q.floor === floor))
          assert.ok(!overlap(rect(f), body), `${style} ${f.kind} on the stair`);
        for (const d of b.doorways.filter((q) => q.floor === floor)) {
          const [cx, , cz] = d.centre,
            [ex, ez] = d.normal === 'x' ? [0.9, d.width / 2] : [d.width / 2, 0.9];
          assert.ok(
            !overlap(body, {
              x0: cx - ex,
              x1: cx + ex,
              z0: cz - ez,
              z1: cz + ez,
            }),
            `${style} across a doorway`,
          );
        }
      }
    }
  }
});

test('the floor above is open over the stair, with headroom over every step and a guard at the top', () => {
  for (const style of MULTI) {
    const b = generateBuilding({ style }),
      ceiling = [...level(b.parts.interior, false), ...level(b.parts.mats, false), ...level(b.parts.fabric, false)],
      treads = level(b.parts.stairs, true),
      under = level(b.parts.stairs, false);
    for (const s of b.stairs) {
      let sampled = 0;
      const y = b.floors[s.floor + 1],
        mx = (s.min[0] + s.max[0]) / 2,
        mz = (s.min[1] + s.max[1]) / 2;
      for (const part of ['interior', 'mats', 'fabric'])
        for (const t of level(b.parts[part], true))
          assert.ok(!(Math.abs(t[0] - y) < 0.02 && covers(t, mx, mz)), `${style} ${part} floors over the well`);
      // Headroom 6 ft 8 in over the walking surfaces, away from the rails: a grid across the footprint.
      for (let i = 1; i < 12; i++)
        for (let j = 1; j < 12; j++) {
          const x = s.min[0] + ((s.max[0] - s.min[0]) * i) / 12,
            z = s.min[1] + ((s.max[1] - s.min[1]) * j) / 12;
          // What is walked on here: the highest step or landing of this storey's flights.
          let walked = -Infinity;
          for (const t of treads)
            if (t[0] > b.floors[s.floor] && t[0] <= y - 0.01 && covers(t, x, z)) walked = Math.max(walked, t[0]);
          if (walked === -Infinity) continue;
          sampled++;
          let head = Infinity;
          // Only broad faces: balusters and rails are thinner than 0.07 m.
          for (const t of [...ceiling, ...under])
            if (
              t[0] > walked + 0.35 &&
              Math.max(...t[1]) - Math.min(...t[1]) > 0.07 &&
              Math.max(...t[2]) - Math.min(...t[2]) > 0.07 &&
              covers(t, x, z)
            )
              head = Math.min(head, t[0]);
          assert.ok(head - walked >= 80 * IN - 1e-6, `${style} headroom ${(head - walked).toFixed(2)} at ${x},${z}`);
        }
      assert.ok(sampled > 60, `${style} steps sampled ${sampled}`);
    }
    // On the top floor something stands at guard height round the well.
    const last = b.stairs.at(-1),
      top = b.floors.at(-1) + last.guard;
    let guard = 0;
    for (const part of ['stairs', 'metalwork']) {
      const g = b.parts[part];
      if (!g) continue;
      for (let i = 0; i < g.positions.length; i += 3) {
        const [x, py, z] = g.positions.slice(i, i + 3);
        if (
          Math.abs(py - top) < 0.04 &&
          x > last.min[0] - 0.1 &&
          x < last.max[0] + 0.1 &&
          z > last.min[1] - 0.1 &&
          z < last.max[1] + 0.1
        )
          guard++;
      }
    }
    assert.ok(guard > 0, `${style} a guard at the top`);
    // Without stairs the floors are whole.
    const none = generateBuilding({ style, stairs: false }),
      s = b.stairs[0],
      mx = (s.min[0] + s.max[0]) / 2,
      mz = (s.min[1] + s.max[1]) / 2;
    assert.equal(none.stairs.length, 0);
    assert.ok(!none.parts.stairs);
    assert.ok(
      level(none.parts.interior, true).some((t) => Math.abs(t[0] - none.floors[1]) < 1e-5 && covers(t, mx, mz)),
    );
  }
});

test('homes have a kitchen and a bathroom with their fixtures, offices a toilet on every floor', () => {
  const need = {
    'japan-2011-house': {
      kitchen: ['kitchen counter', 'refrigerator'],
      bathroom: ['bathtub', 'toilet', 'washbasin'],
    },
    'western-1910-house': {
      kitchen: ['range', 'sink', 'icebox'],
      bathroom: ['bathtub', 'toilet', 'washbasin'],
    },
    'western-1910-brick': {
      kitchen: ['range', 'sink'],
      bathroom: ['bathtub', 'toilet', 'washbasin'],
    },
  };
  for (const [style, uses] of Object.entries(need)) {
    const b = generateBuilding({ style });
    for (const [use, kinds] of Object.entries(uses)) {
      const room = b.rooms.find((r) => r.use === use);
      assert.ok(room, `${style} has a ${use}`);
      const inside = b.furniture.filter(
        (f) =>
          f.floor === room.floor &&
          f.min[0] >= room.min[0] &&
          f.max[0] <= room.max[0] &&
          f.min[2] >= room.min[1] &&
          f.max[2] <= room.max[1],
      );
      for (const kind of kinds)
        assert.ok(
          inside.some((f) => f.kind === kind),
          `${style} ${use}: ${kind}`,
        );
    }
    assert.ok(b.parts.fixtures && b.parts.metalwork, style);
  }
  const office = generateBuilding({ style: 'japan-2011-concrete' });
  for (let floor = 0; floor < office.floors.length; floor++) {
    assert.equal(office.rooms.filter((r) => r.floor === floor && r.use === 'toilet').length, 1);
    assert.ok(office.furniture.some((f) => f.floor === floor && f.kind === 'toilet'));
  }
  const plain = generateBuilding({
    style: 'western-1910-house',
    fixtures: false,
  });
  assert.ok(!plain.parts.fixtures);
  assert.deepEqual([...new Set(plain.rooms.map((r) => r.use))].sort(), ['bedroom', 'living']);
});

test('every block keeps to its room, apart from the others, and a water closet has its code clearances', () => {
  let toilets = 0;
  for (const style of BUILDING_STYLES)
    for (const [width, depth] of [
      [undefined, undefined],
      [7.28, 10.92],
      [12, 9],
      [16, 12],
      [5.5, 6],
    ]) {
      const b = generateBuilding({ style, width, depth });
      for (let i = 0; i < b.furniture.length; i++) {
        const f = b.furniture[i];
        assert.ok(
          b.rooms.some(
            (r) =>
              r.floor === f.floor &&
              f.min[0] >= r.min[0] - 1e-9 &&
              f.max[0] <= r.max[0] + 1e-9 &&
              f.min[2] >= r.min[1] - 1e-9 &&
              f.max[2] <= r.max[1] + 1e-9,
          ),
          `${style} ${f.kind} inside a room`,
        );
        for (const g of b.furniture.slice(i + 1))
          if (g.floor === f.floor) assert.ok(!overlap(rect(f), rect(g)), `${style} ${f.kind} meets ${g.kind}`);
        // Nothing taller than a sill stands within half a metre of its window's inner face.
        for (const w of b.openings.filter((o) => o.floor === f.floor && o.kind === 'window')) {
          const sill = w.centre[1] - w.height / 2,
            [along, out] = w.side % 2 === 0 ? [0, 2] : [2, 0],
            beside = f.min[along] < w.centre[along] + w.width / 2 && f.max[along] > w.centre[along] - w.width / 2,
            away = Math.max(f.min[out] - w.centre[out], w.centre[out] - f.max[out]);
          if (f.max[1] > sill + 0.05 && beside)
            assert.ok(away > b.options.wall + 0.5, `${style} ${f.kind} before a window`);
        }
        if (f.kind !== 'toilet') continue;
        toilets++;
        const r = rect(f),
          sx = r.x1 - r.x0,
          sz = r.z1 - r.z0,
          across = Math.abs(sx - 0.78) < 1e-6;
        // 15 in each side of the centre line; the block's other side is its depth.
        assert.ok((across ? sx : sz) >= 30 * IN, `${style} toilet width`);
        // 21 in in front, on the side away from the wall it stands against.
        const room = b.rooms.find(
            (q) => q.floor === f.floor && r.x0 >= q.min[0] && r.x1 <= q.max[0] && r.z0 >= q.min[1] && r.z1 <= q.max[1],
          ),
          back = across ? r.z0 - room.min[1] < room.max[1] - r.z1 : r.x0 - room.min[0] < room.max[0] - r.x1,
          clear = across
            ? {
                x0: r.x0,
                x1: r.x1,
                z0: back ? r.z1 : r.z0 - 21 * IN,
                z1: back ? r.z1 + 21 * IN : r.z0,
              }
            : {
                z0: r.z0,
                z1: r.z1,
                x0: back ? r.x1 : r.x0 - 21 * IN,
                x1: back ? r.x1 + 21 * IN : r.x0,
              };
        for (const g of b.furniture)
          if (g !== f && g.floor === f.floor) assert.ok(!overlap(clear, rect(g)), `${style} ${g.kind} before a toilet`);
      }
    }
  assert.ok(toilets > 20, `${toilets} toilets checked`);
});

test('tatami, rugs, curtains and bedding furnish homes; no four tatami corners meet', () => {
  const house = generateBuilding({ style: 'japan-2011-house' }),
    mats = house.parts.mats;
  assert.ok(mats && house.parts.fabric);
  assert.ok(house.furniture.some((f) => f.kind === 'futon' && f.floor === 1));
  for (let floor = 0; floor < 2; floor++) {
    const y = house.floors[floor] + 0.008,
      corners = new Map();
    // Each mat is one box: its top face's two triangles give four corners.
    for (let t = 0; t < mats.indices.length; t += 6) {
      const v = [0, 1, 2, 3, 4, 5].map((k) => mats.indices[t + k] * 3);
      if (mats.normals[v[0] + 1] < 0.99 || Math.abs(mats.positions[v[0] + 1] - y) > 1e-5) continue;
      for (const key of new Set(
        v.map((i) => `${Math.round(mats.positions[i] * 20)}:${Math.round(mats.positions[i + 2] * 20)}`),
      ))
        corners.set(key, (corners.get(key) ?? 0) + 1);
    }
    assert.ok(corners.size > 10, 'mats laid');
    assert.ok(Math.max(...corners.values()) < 4, 'four corners meet');
    const living = house.rooms.find((r) => r.floor === floor && (r.use === 'living' || r.use === 'bedroom'));
    assert.ok(
      level(mats, true).some((q) => Math.abs(q[0] - y) < 1e-5 && covers(q, living.min[0] + 0.2, living.min[1] + 0.2)),
    );
  }
  const western = generateBuilding({ style: 'western-1910-house' }),
    bare = generateBuilding({
      style: 'western-1910-house',
      softFurnishings: false,
    });
  assert.ok(western.parts.fabric);
  assert.ok(!western.parts.mats);
  assert.ok(!bare.parts.fabric);
  // Curtains hang just inside a front window.
  const w = western.openings.find((o) => o.side === 0 && o.kind === 'window' && o.floor === 1),
    inner = western.options.depth / 2 - western.options.wall,
    g = western.parts.fabric;
  let near = 0;
  for (let i = 0; i < g.positions.length; i += 3)
    if (
      Math.abs(g.positions[i + 2] - (inner - 0.07)) < 0.04 &&
      Math.abs(g.positions[i] - w.centre[0]) < w.width / 2 + 0.15 &&
      g.positions[i + 1] > w.centre[1]
    )
      near++;
  assert.ok(near > 8, `curtain vertices ${near}`);
});

test('plans carry the main stair, sliders map the new rows, builds repeat and wrong types throw', () => {
  for (const shape of ['rect', 'L']) {
    const plan = generateBuildingPlan({
      style: 'western-1910-house',
      plan: shape,
    });
    assert.equal(plan.stairs.length, 1, shape);
  }
  for (const name of ['stairs', 'fixtures', 'softFurnishings']) {
    assert.ok(BUILDING_SETTINGS.some((r) => r.name === name));
    assert.equal(buildingOptionsFromSettings({ [name]: 'off' })[name], false);
    assert.throws(() => generateBuilding({ [name]: 'yes' }), TypeError);
  }
  const one = generateBuilding({ style: 'western-1910-brick' }),
    two = generateBuilding({ style: 'western-1910-brick' });
  assert.deepEqual(one.parts, two.parts);
  assert.deepEqual(one.stairs, two.stairs);
});

// KB-PROC-FLOORFIGHT1: the foundation was one box topped at the floor level, in the same plane as the ground floor slab,
// so every ground floor flickered between the two materials.
test('the foundation never shares the plane of the ground floor', () => {
  for (const style of BUILDING_STYLES)
    for (const interior of ['rooms', 'cells', 'none']) {
      const b = generateBuilding({ style, interior }),
        y = b.floors[0],
        floor = level(b.parts.interior, true).filter((t) => Math.abs(t[0] - y) < 1e-4),
        under = level(b.parts.base, true).filter((t) => Math.abs(t[0] - y) < 1e-4);
      const inner = [b.options.width / 2 - b.options.wall - 0.05, b.options.depth / 2 - b.options.wall - 0.05];
      let both = 0,
        sampled = 0;
      for (let i = -4; i <= 4; i++)
        for (let j = -4; j <= 4; j++) {
          const x = (inner[0] * i) / 4,
            z = (inner[1] * j) / 4;
          if (!floor.some((t) => covers(t, x, z))) continue;
          sampled++;
          if (under.some((t) => covers(t, x, z))) both++;
        }
      assert.ok(sampled > 20, `${style} floor sampled`);
      assert.equal(both, 0, `${style} ${interior}: the foundation lies in the floor's plane`);
      assert.ok(under.length > 0, `${style} the foundation still shows a ledge under the walls`);
    }
});

/** The highest upward face of the named parts at (x, z) no higher than `most`. */
function treadAt(b, x, z, most) {
  let best = -Infinity;
  for (const name of ['stairs', 'interior']) {
    const { positions: p, indices, normals } = b.parts[name];
    for (let t = 0; t < indices.length; t += 3) {
      const [i, j, k] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
      if (normals[i + 1] < 0.99 || p[i + 1] > most || p[i + 1] <= best) continue;
      const side = (a, c) => (p[c] - p[a]) * (z - p[a + 2]) - (p[c + 2] - p[a + 2]) * (x - p[a]),
        s = [side(i, j), side(j, k), side(k, i)];
      if (s.every((v) => v >= -1e-9) || s.every((v) => v <= 1e-9)) best = p[i + 1];
    }
  }
  return best;
}

test('a winder stair climbs its walking line one riser at a time from floor to floor', () => {
  for (const style of ['japan-2011-house', 'japan-2011-concrete', 'western-1910-house', 'western-1910-brick']) {
    const b = generateBuilding({ style, stairShape: 'winder' });
    assert.equal(b.stairs.length, b.floors.length - 1, style);
    for (const s of b.stairs) {
      assert.equal(s.kind, 'winder', style);
      // Across the stair runs from the foot to the head; along it runs from them into the footprint.
      const gap = Math.hypot(s.head[0] - s.foot[0], s.head[1] - s.foot[1]),
        v = [(s.head[0] - s.foot[0]) / gap, (s.head[1] - s.foot[1]) / gap],
        centre = [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2],
        inward = [Math.abs(v[1]), Math.abs(v[0])].map((a, i) => a * Math.sign(centre[i] - s.foot[i])),
        size = [s.max[0] - s.min[0], s.max[1] - s.min[1]],
        length = size[0] * Math.abs(inward[0]) + size[1] * Math.abs(inward[1]),
        breadth = size[0] * Math.abs(v[0]) + size[1] * Math.abs(v[1]),
        inner = breadth / 2 - s.width,
        run = length - inner - s.width,
        // Where the entry edge's first corner is, on the foot's side.
        origin = [0, 1].map((i) => centre[i] - (inward[i] * length) / 2 - (v[i] * breadth) / 2),
        radius = inner + (style.startsWith('japan') ? 0.3 : 0.305),
        at = (u, w) => [0, 1].map((i) => origin[i] + inward[i] * u + v[i] * w),
        path = [];
      for (let u = -0.15; u < run; u += 0.01) path.push(at(u, breadth / 2 - radius));
      for (let a = 0.002; a < Math.PI; a += 0.005 / radius)
        path.push(at(run + radius * Math.sin(a), breadth / 2 - radius * Math.cos(a)));
      for (let u = run - 0.001; u > -0.15; u -= 0.01) path.push(at(u, breadth / 2 + radius));
      const base = b.floors[s.floor];
      let y = base,
        steps = 0;
      for (const [x, z] of path) {
        const next = treadAt(b, x, z, y + s.rise + 1e-4);
        if (next > y + 1e-4) {
          assert.ok(Math.abs(next - y - s.rise) < 1e-4, `${style} a step of ${next - y} for ${s.rise}`);
          y = next;
          steps++;
        } else assert.ok(next > y - 1e-4, `${style} a hole in the walking line at ${x}, ${z}: ${next} under ${y}`);
      }
      assert.equal(steps, s.risers, style);
      assert.ok(Math.abs(y - b.floors[s.floor + 1]) < 1e-4, style);
    }
  }
});
