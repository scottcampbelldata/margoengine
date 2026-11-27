// Every storey of a furnished building is reached (limits gap row 19 follow-up, KB-PROC-NOSTAIR1): 42 of 400 random
// plans got no stair, because partitions left no room that held one. A walker's flood fill proves it on a large random
// set: from the foot of the first stair, over each floor's rooms and doorways and off its stair wells, to every stair's
// head and foot and to the middle of every room, storey by storey. Spiral figures are the International Residential
// Code 2021 spiral stairway rules and, in Japan, Order art. 23; ladder figures are US 29 CFR 1910.23.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBuildingPlan } from '@margoengine/procedural/building-plans';
import { BUILDING_STYLES, generateBuilding } from '@margoengine/procedural/building-rules';

const IN = 0.0254;
let state = 1;
const seed = (s) => {
  state = (s * 2654435761) % 4294967296 || 1;
};
const next = () => {
  state = (state ^ (state << 13)) >>> 0;
  state = (state ^ (state >>> 17)) >>> 0;
  state = (state ^ (state << 5)) >>> 0;
  return state / 4294967296;
};
const range = (lo, hi) => lo + next() * (hi - lo);
const pick = (list) => list[Math.floor(next() * list.length)];

/** Random options: mostly house sizes, sometimes the whole allowed range, mixed storeys, walls, bays and doors. */
function randomOptions(i) {
  seed(i + 7);
  const o = { style: pick(BUILDING_STYLES), interior: 'rooms' },
    size = () => (next() < 0.15 ? range(3, 5.5) : next() < 0.9 ? range(5, 17) : range(17, 60));
  o.width = size();
  o.depth = size();
  const floors = 2 + Math.floor(next() ** 3 * 4);
  const storey = range(2.2, 4);
  o.storeys = Array.from({ length: floors }, () => (next() < 0.8 ? storey : range(2.2, next() < 0.9 ? 4.5 : 8)));
  if (next() < 0.2) o.wall = next() < 0.8 ? range(0.08, 0.4) : range(0.4, 1);
  if (next() < 0.2) o.bayWidth = range(1.2, 6);
  if (next() < 0.2) o.storefront = next() < 0.5;
  if (next() < 0.15) o.doors = [0, Math.floor(next() * 3), -1];
  return o;
}

const CELL = 0.1;
/**
 * The walkable cells of floor `k`: inside a room or a doorway, off the flight that leaves the floor (but its ladder or
 * landing end) and off the well it arrives through. Returns the cells a walker of radius `r` reaches from `from`.
 */
function walk(b, k, from, r) {
  const rooms = b.rooms.filter((q) => q.floor === k),
    solid = b.stairs
      .filter((s) => s.floor === k || s.floor === k - 1)
      .map((s) => ({ x0: s.min[0], x1: s.max[0], z0: s.min[1], z1: s.max[1] })),
    doors = b.doorways
      .filter((d) => d.floor === k)
      .map((d) => {
        const [x, , z] = d.centre,
          [ex, ez] = d.normal === 'x' ? [0.4 + r, d.width / 2 - r] : [d.width / 2 - r, 0.4 + r];
        return { x0: x - ex, x1: x + ex, z0: z - ez, z1: z + ez };
      });
  // A partition too short for a door and its jambs (0.96 m) is left out, so those two rooms are one space.
  for (const a of rooms)
    for (const c of rooms) {
      const lo = Math.max(a.min[1], c.min[1]),
        hi = Math.min(a.max[1], c.max[1]),
        gap = c.min[0] - a.max[0];
      if (gap > 0 && gap < 0.13 && hi - lo > 0 && hi - lo < 0.96)
        doors.push({ x0: a.max[0] - r, x1: c.min[0] + r, z0: lo + r, z1: hi - r });
    }
  const x0 = Math.min(...rooms.map((q) => q.min[0])),
    z0 = Math.min(...rooms.map((q) => q.min[1])),
    nx = Math.ceil((Math.max(...rooms.map((q) => q.max[0])) - x0) / CELL),
    nz = Math.ceil((Math.max(...rooms.map((q) => q.max[1])) - z0) / CELL),
    free = new Uint8Array(nx * nz),
    mark = (box, inset, value) => {
      const i0 = Math.max(0, Math.ceil((box.x0 + inset - x0) / CELL - 0.5)),
        i1 = Math.min(nx - 1, Math.floor((box.x1 - inset - x0) / CELL - 0.5)),
        j0 = Math.max(0, Math.ceil((box.z0 + inset - z0) / CELL - 0.5)),
        j1 = Math.min(nz - 1, Math.floor((box.z1 - inset - z0) / CELL - 0.5));
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) free[i + j * nx] = value;
    };
  for (const q of rooms) mark({ x0: q.min[0], x1: q.max[0], z0: q.min[1], z1: q.max[1] }, r, 1);
  for (const d of doors) mark(d, 0, 1);
  for (const s of solid) mark(s, -r + CELL / 2, 0);
  const seen = new Uint8Array(nx * nz),
    cell = ([x, z]) => {
      // The nearest free cell within 0.35 m of a point.
      let best = -1,
        d = 0.35;
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < nz; j++) {
          if (!free[i + j * nx]) continue;
          const e = Math.hypot(x0 + (i + 0.5) * CELL - x, z0 + (j + 0.5) * CELL - z);
          if (e < d) {
            d = e;
            best = i + j * nx;
          }
        }
      return best;
    },
    start = cell(from),
    stack = start < 0 ? [] : [start];
  if (start >= 0) seen[start] = 1;
  while (stack.length) {
    const c = stack.pop(),
      i = c % nx;
    for (const q of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, c - nx, c + nx])
      if (q >= 0 && q < free.length && free[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
  }
  /** Whether a room holds floor a walker fits on, and whether any of it was reached. */
  const shut = (q) => {
    let any = false;
    for (let c = 0; c < free.length; c++) {
      const x = x0 + ((c % nx) + 0.5) * CELL,
        z = z0 + (Math.floor(c / nx) + 0.5) * CELL;
      if (!free[c] || x < q.min[0] || x > q.max[0] || z < q.min[1] || z > q.max[1]) continue;
      if (seen[c]) return false;
      any = true;
    }
    return any;
  };
  return { reaches: (p) => cell(p) >= 0 && seen[cell(p)] === 1, started: start >= 0, rooms, shut };
}

/** Walks the building floor by floor; returns what cannot be reached. */
function unreached(b, label) {
  const out = [];
  for (let k = 0; k < b.floors.length; k++) {
    const up = b.stairs.find((s) => s.floor === k),
      down = b.stairs.find((s) => s.floor === k - 1);
    if (k < b.floors.length - 1 && !up) {
      out.push(`${label}: no stair from floor ${k}`);
      continue;
    }
    // On the ground floor the walk starts inside each outer door.
    if (k === 0 && up) {
      const ground = walk(b, 0, up.foot, b.stairs.some((s) => s.kind === 'ladder') ? 0.12 : 0.2),
        inset = b.options.wall + 0.35;
      for (const door of b.openings.filter((o) => o.kind === 'door' && o.floor === 0)) {
        const [x, , z] = door.centre,
          at = [
            [x, z - inset],
            [x - inset, z],
            [x, z + inset],
            [x + inset, z],
          ][door.side];
        // A ladder may stand just inside a door of a building a stride across.
        if (!ground.reaches(at) && Math.min(b.options.width, b.options.depth) - 2 * b.options.wall > 2)
          out.push(`${label}: the door on side ${door.side} does not reach the stair`);
      }
    }
    const from = down ? down.head : up?.foot;
    if (!from) continue;
    const tight = b.stairs.some((s) => s.kind === 'ladder'),
      w = walk(b, k, from, tight ? 0.12 : 0.2);
    if (!w.started) out.push(`${label}: no floor at the stair on floor ${k}`);
    else if (up && down && !w.reaches(up.foot))
      out.push(`${label}: floor ${k} ${down.kind} head does not reach the next foot`);
    else for (const q of w.rooms) if (w.shut(q)) out.push(`${label}: a ${q.use} on floor ${k} is cut off`);
  }
  return out;
}

const STAIR_CODE = {
  spiral: (s, style) =>
    style === 'japan-2011-concrete'
      ? { rise: 0.2, tread: 0.24, width: 0.9 }
      : style.startsWith('japan')
        ? { rise: 0.23, tread: 0.15, width: 0.75 }
        : { rise: 9.5 * IN, tread: 6.75 * IN, width: 26 * IN },
  // Rungs 10 to 14 in apart, 16 in between the rails.
  ladder: () => ({ rise: 14 * IN, tread: 0, width: 16 * IN }),
};

function check(b, o, label, wrong, kinds) {
  const style = o.style;
  assert.equal(b.stairs.length, b.floors.length - 1, label);
  for (const s of b.stairs) {
    kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    const storey = b.floors[s.floor + 1] - b.floors[s.floor];
    if (Math.abs(s.risers * s.rise - storey) > 1e-6) wrong.push(`${label}: risers do not climb the storey`);
    const code = STAIR_CODE[s.kind]?.(s, style);
    if (code && (s.rise > code.rise + 1e-6 || s.tread < code.tread - 1e-6 || s.width < code.width - 1e-6))
      wrong.push(`${label}: ${s.kind} rise ${s.rise} tread ${s.tread} width ${s.width}`);
    // The flight stands in one room on both its floors, across no doorway, and its ends are outside it and in a room.
    const body = { x0: s.min[0], x1: s.max[0], z0: s.min[1], z1: s.max[1] };
    for (const [floor, end] of [
      [s.floor, s.foot],
      [s.floor + 1, s.head],
    ]) {
      const room = (x0, x1, z0, z1) =>
        b.rooms.some(
          (r) =>
            r.floor === floor &&
            x0 >= r.min[0] - 1e-6 &&
            x1 <= r.max[0] + 1e-6 &&
            z0 >= r.min[1] - 1e-6 &&
            z1 <= r.max[1] + 1e-6,
        );
      if (!room(body.x0, body.x1, body.z0, body.z1)) wrong.push(`${label}: stair crosses a wall on floor ${floor}`);
      if (!room(end[0], end[0], end[1], end[1])) wrong.push(`${label}: stair end outside the rooms on ${floor}`);
      if (end[0] > body.x0 && end[0] < body.x1 && end[1] > body.z0 && end[1] < body.z1)
        wrong.push(`${label}: stair end inside the stair`);
    }
  }
  wrong.push(...unreached(b, label));
}

test('every storey of every random multi-storey building is reached on foot', () => {
  const wrong = [],
    kinds = {};
  for (let i = 0; i < 1500; i++) {
    const o = randomOptions(i),
      b = generateBuilding(o);
    check(b, o, `#${i} ${o.style} ${o.width.toFixed(2)} x ${o.depth.toFixed(2)}`, wrong, kinds);
  }
  assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} failures`);
  // Houses keep ordinary stairs: spirals and ladders are for plans too small for them.
  assert.ok(kinds['dog-leg'] > (kinds.spiral ?? 0) * 5, JSON.stringify(kinds));
  assert.ok(kinds.spiral > 0 && kinds.ladder > 0, JSON.stringify(kinds));
});

test('the smallest and most extreme plans the options allow still have a way up', () => {
  const wrong = [],
    kinds = {};
  for (const style of BUILDING_STYLES)
    for (const [width, depth] of [
      [3, 3],
      [3, 40],
      [40, 3],
      [3.2, 6.4],
      [4.5, 4.5],
      [120, 120],
    ])
      for (const wall of [0.08, 1])
        for (const storeys of [
          [2.2, 2.2, 2.2],
          [8, 2.2],
        ]) {
          const o = { style, width, depth, wall, storeys, interior: 'rooms' };
          check(generateBuilding(o), o, `${style} ${width} x ${depth} wall ${wall} ${storeys}`, wrong, kinds);
        }
  assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} failures`);
});

test('plans that had no room for a stair get a stair hall', () => {
  // 13.0 x 6.9 brick: four columns of about 3.1 m in two rows held no dog-leg; a column's two rows taken together do.
  const b = generateBuilding({ style: 'western-1910-brick', width: 13, depth: 6.9 });
  assert.equal(b.stairs[0]?.kind, 'dog-leg');
  const inner = b.options.depth - 2 * b.options.wall;
  assert.ok(
    b.rooms.some((r) => r.floor === 1 && r.max[1] - r.min[1] > inner - 0.01),
    'two rooms made one',
  );
});

test('partitions that cross meet in a post', () => {
  const b = generateBuilding({ style: 'western-1910-house', width: 12, depth: 9, stairs: false }),
    upper = b.rooms.filter((r) => r.floor === 1),
    xs = [...new Set(upper.map((r) => r.max[0]))].sort((a, c) => a - c).slice(0, -1),
    zs = [...new Set(upper.map((r) => r.max[1]))].sort((a, c) => a - c).slice(0, -1);
  assert.ok(xs.length >= 2 && zs.length === 1, `${xs} ${zs}`);
  const { positions, indices, normals } = b.parts.interior,
    level = upper[0].level + 1;
  for (const x of xs) {
    // The wall faces of the post: a vertical face crossing height `level` inside the 0.12 m square of the junction.
    const cx = x + 0.06,
      cz = zs[0] + 0.06;
    let faces = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const v = [0, 1, 2].map((q) => indices[t + q] * 3);
      if (Math.abs(normals[v[0] + 1]) > 0.1) continue;
      const px = v.map((q) => positions[q]),
        py = v.map((q) => positions[q + 1]),
        pz = v.map((q) => positions[q + 2]);
      if (Math.min(...py) > level || Math.max(...py) < level) continue;
      if (px.every((q) => Math.abs(q - cx) < 0.061) && pz.every((q) => Math.abs(q - cz) < 0.061)) faces++;
    }
    assert.ok(faces >= 4, `no post at ${cx}, ${cz}`);
  }
});

/**
 * Walks floor level `y` of a plan on its own meshes: floor where an upward face of the `interior` part lies at `y`,
 * less everything within `r` of a wall face at 1 m up and the stairs' footprints. Floods from `seeds`.
 */
function walkMesh(b, y, seeds, solids, r) {
  const meshes = [b.parts.interior, b.parts.walls].filter(Boolean),
    xs = b.blocks.flatMap((q) => q.footprint.map((c) => c[0])),
    zs = b.blocks.flatMap((q) => q.footprint.map((c) => c[1])),
    x0 = Math.min(...xs) - 1,
    z0 = Math.min(...zs) - 1,
    nx = Math.ceil((Math.max(...xs) + 1 - x0) / CELL),
    nz = Math.ceil((Math.max(...zs) + 1 - z0) / CELL),
    floor = new Uint8Array(nx * nz),
    wall = new Uint8Array(nx * nz),
    cells = (ax, bx, az, bz, f) => {
      const i1 = Math.min(nx - 1, Math.floor((bx - x0) / CELL)),
        j1 = Math.min(nz - 1, Math.floor((bz - z0) / CELL));
      for (let i = Math.max(0, Math.floor((ax - x0) / CELL)); i <= i1; i++)
        for (let j = Math.max(0, Math.floor((az - z0) / CELL)); j <= j1; j++)
          f(i + j * nx, x0 + (i + 0.5) * CELL, z0 + (j + 0.5) * CELL);
    },
    H = y + 1;
  for (const g of meshes) {
    const { positions: p, indices, normals } = g;
    for (let t = 0; t < indices.length; t += 3) {
      const v = [0, 1, 2].map((q) => indices[t + q] * 3),
        pts = v.map((q) => [p[q], p[q + 1], p[q + 2]]),
        ny = normals[v[0] + 1];
      if (ny > 0.99 && Math.abs(pts[0][1] - y) < 1e-3) {
        const px = pts.map((q) => q[0]),
          pz = pts.map((q) => q[2]);
        cells(Math.min(...px), Math.max(...px), Math.min(...pz), Math.max(...pz), (c, x, z) => {
          if (covers(px, pz, x, z)) floor[c] = 1;
        });
      } else if (Math.abs(ny) < 0.3) {
        // The segment where the face crosses the walker's height.
        const cut = [];
        for (let e = 0; e < 3; e++) {
          const a = pts[e],
            c = pts[(e + 1) % 3];
          if (a[1] <= H !== c[1] <= H) {
            const s = (H - a[1]) / (c[1] - a[1]);
            cut.push([a[0] + (c[0] - a[0]) * s, a[2] + (c[2] - a[2]) * s]);
          }
        }
        if (cut.length < 2) continue;
        const [[ax, az], [bx, bz]] = cut,
          dx = bx - ax,
          dz = bz - az,
          l = dx * dx + dz * dz;
        cells(Math.min(ax, bx) - r, Math.max(ax, bx) + r, Math.min(az, bz) - r, Math.max(az, bz) + r, (c, x, z) => {
          const s = l > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l)) : 0;
          if (Math.hypot(x - ax - dx * s, z - az - dz * s) < r) wall[c] = 1;
        });
      }
    }
  }
  for (const s of solids)
    cells(s.min[0], s.max[0], s.min[1], s.max[1], (c, x, z) => {
      if (x > s.min[0] - r / 2 && x < s.max[0] + r / 2 && z > s.min[1] - r / 2 && z < s.max[1] + r / 2) wall[c] = 1;
    });
  const free = floor.map((f, c) => (f && !wall[c] ? 1 : 0)),
    seen = new Uint8Array(nx * nz),
    near = ([x, z]) => {
      let best = -1,
        d = 0.4;
      cells(x - d, x + d, z - d, z + d, (c, cx, cz) => {
        const e = Math.hypot(cx - x, cz - z);
        if (free[c] && e < d) {
          d = e;
          best = c;
        }
      });
      return best;
    },
    stack = [];
  for (const s of seeds) {
    const c = near(s);
    if (c >= 0 && !seen[c]) {
      seen[c] = 1;
      stack.push(c);
    }
  }
  while (stack.length) {
    const c = stack.pop(),
      i = c % nx;
    for (const q of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, c - nx, c + nx])
      if (q >= 0 && q < free.length && free[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
  }
  return {
    reaches: (p) => near(p) >= 0 && seen[near(p)] === 1,
    /** A room with floor to stand on, none of it reached. */
    shut: (q) => {
      let any = false,
        got = false;
      cells(q.min[0], q.max[0], q.min[1], q.max[1], (c) => {
        any ||= free[c] === 1;
        got ||= seen[c] === 1;
      });
      return any && !got;
    },
  };
}
function covers(xs, zs, x, z) {
  const side = (a, b) => (xs[b] - xs[a]) * (z - zs[a]) - (zs[b] - zs[a]) * (x - xs[a]);
  const s = [side(0, 1), side(1, 2), side(2, 0)];
  return s.every((v) => v >= -1e-9) || s.every((v) => v <= 1e-9);
}

/** Random plans: every shape and tower corner, tower storeys, and wings given by hand, taller, lower or apart. */
function randomPlan(i) {
  seed(i + 5001);
  const style = pick(['japan-2011-house', 'japan-2011-concrete', 'western-1910-house', 'western-1910-brick']),
    storey = range(2.4, 3.2),
    levels = 1 + Math.floor(next() * 3),
    o = {
      style,
      interior: 'rooms',
      plan: pick(['rect', 'L', 'T', 'U', 'cross']),
      wingSide: pick(['front', 'back']),
      width: range(6, 18),
      depth: range(5, 12),
      storeys: Array(levels).fill(storey),
      tower: pick(['none', 'front-left', 'front-right', 'back-left', 'back-right']),
      towerSize: range(3, 6),
      towerStoreys: Math.floor(next() * 3),
    };
  let tallest = levels + (o.tower === 'none' ? 0 : o.towerStoreys);
  if (next() < 0.25) {
    const apart = next() < 0.3,
      wide = range(4, 7),
      n = 1 + Math.floor(next() * 4);
    o.wings = [
      {
        at: [apart ? o.width / 2 + wide : o.width / 2 + wide / 2 - range(1.5, 3), 0],
        width: wide,
        depth: range(4, 8),
        storeys: Array(n).fill(storey),
        ...(apart ? { doors: [0] } : {}),
      },
    ];
    tallest = Math.max(tallest, n);
  }
  return { o, tallest };
}

/** Points either side of an outer door; the walk starts from those with floor indoors. */
const inward = ({ centre: [x, , z] }) =>
  [0.45, 0.7].flatMap((d) => [
    [x, z - d],
    [x - d, z],
    [x, z + d],
    [x + d, z],
  ]);

test('every storey of every random plan, towers and wings too, is reached on foot', () => {
  const wrong = [];
  let towers = 0,
    upper = 0;
  for (let i = 0; i < 500; i++) {
    const { o, tallest } = randomPlan(i),
      b = generateBuildingPlan(o),
      wing = o.wings ? ` wing ${o.wings[0].storeys.length} at ${o.wings[0].at[0].toFixed(1)}` : '',
      label = `#${i} ${o.style} ${o.plan} ${o.tower}+${o.towerStoreys} ${o.width.toFixed(2)} x ${o.depth.toFixed(2)}${wing}`,
      r = b.stairs.some((s) => s.kind === 'ladder') ? 0.12 : 0.18;
    if (o.tower !== 'none' && o.towerStoreys > 0) towers++;
    let y = generateBuilding({ style: o.style }).floors[0],
      seeds = b.openings.filter((d) => d.kind === 'door' && d.floor === 0).flatMap(inward);
    for (let k = 0; k < tallest; k++) {
      const solids = b.stairs.filter((s) => s.floor === k || s.floor === k - 1),
        w = walkMesh(b, y, seeds, solids, r);
      for (const q of b.rooms.filter((c) => c.floor === k && Math.abs(c.level - y) < 0.01)) {
        if (k > 0) upper++;
        if (w.shut(q)) wrong.push(`${label}: a ${q.use} on floor ${k} at ${q.min.map((v) => v.toFixed(1))} is cut off`);
      }
      const up = b.stairs.filter((s) => s.floor === k && w.reaches(s.foot));
      if (k + 1 < tallest && !up.length) {
        wrong.push(`${label}: nothing climbs from floor ${k}`);
        break;
      }
      seeds = up.map((s) => s.head);
      // A tower's extra storeys are at most 3.2 m, and these are all lower.
      y += o.storeys[0];
    }
  }
  assert.deepEqual(wrong.slice(0, 25), [], `${wrong.length} failures`);
  assert.ok(towers > 100 && upper > 500, `${towers} towers, ${upper} upper rooms`);
});

// KB-PROC-TOWERSIZE1: a tower side under 3 m passed the plan's own check, then threw about a building width.
test('the smallest tower the options accept builds, and a smaller one is refused by name', () => {
  assert.ok(generateBuildingPlan({ tower: 'front-left', towerSize: 3 }).blocks.length > 1);
  assert.throws(() => generateBuildingPlan({ tower: 'front-left', towerSize: 2.9 }), /towerSize/);
});

// A window another block stands over is cut out with its wall; its curtains used to hang on in the middle of the room.
test('no curtain hangs where a joined block took the window away', () => {
  const o = { style: 'western-1910-house', plan: 'L', interior: 'rooms', tower: 'front-left', towerSize: 4 },
    b = generateBuildingPlan(o),
    { positions: p, indices } = b.parts.fabric,
    kept = b.openings.filter((q) => q.kind === 'window' || q.kind === 'balcony-door'),
    walls = b.blocks.filter((q) => q.kind !== 'dormer');
  let hung = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => indices[t + k] * 3),
      mean = (a) => (p[v[0] + a] + p[v[1] + a] + p[v[2] + a]) / 3,
      [x, y, z] = [mean(0), mean(1), mean(2)];
    // Curtains hang above the sills; rugs and bedding lie lower.
    const storey = b.rooms.map((r) => r.level).reduce((a, l) => (l <= y ? Math.max(a, l) : a), 0);
    if (y - storey < 1.4) continue;
    hung++;
    // Every high piece of cloth is beside a window that is still there.
    assert.ok(
      kept.some((q) => Math.hypot(q.centre[0] - x, q.centre[2] - z) < q.width / 2 + 0.5),
      `cloth at ${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)} has no window by it (${walls.length} blocks)`,
    );
  }
  assert.ok(hung > 100, `${hung} curtain triangles`);
});

// A wing flush with the main block's side shares that wall: it keeps a face toward the street and one toward the rooms.
test('a wall two blocks share keeps both its faces', () => {
  const b = generateBuildingPlan({ style: 'western-1910-house', plan: 'L', interior: 'rooms', wingSide: 'front' }),
    o = generateBuilding({ style: 'western-1910-house' }).options,
    outer = -o.width / 2,
    inner = outer + o.wall,
    y = b.rooms[0].level + 0.5;
  // Points along the shared side, in the part of the main block the wing covers: wall or window, both sides alike.
  let samples = 0;
  const bare = { interior: 0, walls: 0 };
  for (let z = o.depth / 2 - 0.5; z > 0.4; z -= 0.17) {
    samples++;
    for (const [plane, part, facing] of [
      [inner, 'interior', 1],
      [outer, 'walls', -1],
    ]) {
      const { positions: p, indices, normals } = b.parts[part];
      let faces = 0;
      for (let t = 0; t < indices.length; t += 3) {
        const v = [0, 1, 2].map((k) => indices[t + k] * 3);
        if (normals[v[0]] * facing < 0.9 || Math.abs(p[v[0]] - plane) > 0.02) continue;
        if (
          covers(
            v.map((k) => p[k + 1]),
            v.map((k) => p[k + 2]),
            y,
            z,
          )
        )
          faces++;
      }
      if (!faces) bare[part]++;
    }
  }
  // A window may stand somewhere along it, but most of the run is wall.
  assert.ok(samples > 12, `${samples}`);
  for (const [part, n] of Object.entries(bare)) assert.ok(n < samples / 2, `${part}: ${n} of ${samples} bare`);
});

test('a front door in front of a partition opens into an entry, and the result lists nothing private', () => {
  // This front door stood on the middle partition, which ran into it.
  const o = {
      style: 'western-1910-house',
      interior: 'rooms',
      width: 7.100846874527633,
      depth: 10.053647399879992,
      storeys: [2.615700040198863, 2.615700040198863],
      bayWidth: 2.7054830007255077,
    },
    b = generateBuilding(o),
    door = b.openings.find((q) => q.kind === 'door' && q.floor === 0),
    front = b.options.depth / 2 - b.options.wall;
  const { positions: p, indices } = b.parts.interior;
  for (let t = 0; t < indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => indices[t + k] * 3),
      inRange = (axis, lo, hi) => v.every((i) => p[i + axis] > lo && p[i + axis] < hi);
    assert.ok(
      !(
        inRange(0, door.centre[0] - door.width / 2 + 0.01, door.centre[0] + door.width / 2 - 0.01) &&
        inRange(1, b.floors[0] + 0.1, b.floors[0] + 1.8) &&
        inRange(2, front - 1, front - 0.01)
      ),
      'a partition stands inside the front door',
    );
  }
  assert.ok(!('curtains' in b));
});
