// What stands behind a rules building's windows (building-rules.ts): floor slabs, partitions and doorways, stairs with
// their wells and guards, room uses, kitchen and bathroom fixtures, furniture and soft furnishings. Internal to
// @margoengine/procedural; our own code, clean room from:
// - Blondel 1675-1683, Cours d'architecture: the step rule 2 rise + going = a walking pace (about 0.63 m).
// - Merrell, Schkufza, Li, Koltun and Agrawala 2011, "Interactive Furniture Layout Using Interior Design Guidelines",
//   ACM TOG 30(4), https://doi.org/10.1145/2010324.1964982: clearance in front of each piece and circulation left free,
//   used here as hard rules in a fixed placement order instead of their sampled density.
// - Germer and Schwarz 2009, "Procedural Arrangement of Furniture for Real-Time Walkthroughs", Computer Graphics Forum
//   28(8), https://doi.org/10.1111/j.1467-8659.2009.01351.x: pieces placed one at a time against walls or in the middle
//   of a room, each keeping its own clear zone.
// Measured sizes, pinned by test/building-interiors.test.js:
// - US: International Residential Code 2021, R311.7 (stair 36 in wide, riser at most 7 3/4 in, tread at least 10 in,
//   headroom 6 ft 8 in, handrail 34 to 38 in), R312 (guard at least 36 in, openings under a 4 in sphere) and R307.1
//   (15 in from a water closet's centre line to a side obstruction, 21 in clear in front of a fixture).
// - Japan: Building Standard Law Enforcement Order art. 23 (a dwelling's stair at least 75 cm wide, riser at most
//   23 cm, tread at least 15 cm; the house here keeps the usual 21 cm and 23 cm). Tatami of the Edo-ma size, about
//   0.88 by 1.76 m, laid so no four corners meet.
import type {
  BuildingDoorway,
  BuildingFurniture,
  BuildingOpening,
  BuildingPart,
  BuildingRoom,
  BuildingRoomUse,
  BuildingStair,
  BuildingStyle,
  BuildingInterior,
} from './building-rules.js';
import { type MeshBuilder, add, scale, type V3 } from './mesh-builder.js';

/** One side of the footprint: its start corner, run direction, outward normal and length. */
export interface Side {
  start: V3;
  dir: V3;
  out: V3;
  length: number;
}
/** A hole in a side: along it from `a0` to `a1`, from `y0` to `y1`. */
export interface Hole {
  kind: BuildingOpening['kind'];
  side: number;
  floor: number;
  a0: number;
  a1: number;
  y0: number;
  y1: number;
}
interface InteriorOptions {
  readonly style: BuildingStyle;
  readonly width: number;
  readonly depth: number;
  readonly wall: number;
  readonly bayWidth: number;
  readonly storefront: boolean;
  readonly interior: BuildingInterior;
  readonly stairs: boolean;
  readonly fixtures: boolean;
  readonly softFurnishings: boolean;
  readonly detail: 'far' | 'mid' | 'near';
}
export interface Interior {
  rooms: BuildingRoom[];
  furniture: BuildingFurniture[];
  doorways: BuildingDoorway[];
  stairs: BuildingStair[];
}

type Parts = Record<BuildingPart, MeshBuilder>;
/** A floor rectangle in local metres. */
interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
const within = (a: Rect, b: Rect, eps = 1e-9) =>
  a.x0 >= b.x0 - eps && a.x1 <= b.x1 + eps && a.z0 >= b.z0 - eps && a.z1 <= b.z1 + eps;
/** `all` less the hole: up to four rectangles. */
function without(all: Rect, hole?: Rect): Rect[] {
  if (!hole || !overlaps(all, hole)) return [all];
  const x0 = Math.max(all.x0, hole.x0),
    x1 = Math.min(all.x1, hole.x1);
  return [
    { x0: all.x0, x1: x0, z0: all.z0, z1: all.z1 },
    { x0: x1, x1: all.x1, z0: all.z0, z1: all.z1 },
    { x0, x1, z0: all.z0, z1: hole.z0 },
    { x0, x1, z0: hole.z1, z1: all.z1 },
  ].filter((r) => r.x1 - r.x0 > 1e-6 && r.z1 - r.z0 > 1e-6);
}
const box = (b: MeshBuilder, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
  if (x1 - x0 > 1e-6 && y1 - y0 > 1e-6 && z1 - z0 > 1e-6)
    b.box([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2]);
};

// Room widths: two ken (2 x 1.82 m, the Edo-ma module) for the Japanese sets and 12 ft (3.66 m) for the western sets.
// Partition walls are 0.1 m (shoji and fusuma frames) and 0.12 m (a 2 by 4 stud wall with lath and plaster); doorways
// are 0.86 by 1.8 m (fusuma opening) and 32 by 80 in (0.81 by 2.03 m).
const ROOM_WIDTH = { japan: 3.64, western: 3.66 } as const;
const SLAB = 0.2;

interface Opening {
  axis: 'x' | 'z';
  plane: number;
  lo: number;
  hi: number;
  door: boolean;
  hole: Hole;
}
interface Floor {
  rooms: Rect[];
  /** Column and row of each room: rows count from the back. */
  at: { column: number; row: number }[];
  doors: BuildingDoorway[];
  openings: Opening[];
  uses: BuildingRoomUse[];
  /** Floor areas kept free of blocks: the stair, its well and its approach. */
  keep: Rect[];
}

/** The approach in front of a doorway: 0.9 m either side of the partition across its clear width. */
function doorZone(d: BuildingDoorway): Rect {
  const [cx, , cz] = d.centre,
    [ex, ez] = d.normal === 'x' ? [0.9, d.width / 2 + 0.05] : [d.width / 2 + 0.05, 0.9];
  return { x0: cx - ex, x1: cx + ex, z0: cz - ez, z1: cz + ez };
}
/** How far a block stands from an opening's wall, when it overlaps the opening's span (else Infinity). */
function gapTo(r: Rect, s: Opening) {
  const near =
      s.axis === 'z'
        ? Math.min(Math.abs(r.z0 - s.plane), Math.abs(r.z1 - s.plane))
        : Math.min(Math.abs(r.x0 - s.plane), Math.abs(r.x1 - s.plane)),
    [lo, hi] = s.axis === 'z' ? [r.x0, r.x1] : [r.z0, r.z1];
  return lo < s.hi + 0.1 && hi > s.lo - 0.1 ? near : Infinity;
}

// Stairs.
interface StairRule {
  maxRise: number;
  minTread: number;
  width: number;
  guard: number;
  handrail: number;
  solid: boolean;
}
function stairRule(style: BuildingStyle, area: number): StairRule {
  // Order art. 23: a stair under more than 200 square metres of rooms is at least 1.2 m wide, a smaller one 0.75 m.
  if (style === 'japan-2011-concrete')
    return {
      maxRise: 0.18,
      minTread: 0.26,
      width: area > 200 ? 1.2 : 0.9,
      guard: 1.1,
      handrail: 0.85,
      solid: true,
    };
  if (style.startsWith('japan'))
    return {
      maxRise: 0.21,
      minTread: 0.23,
      width: 0.78,
      guard: 1.1,
      handrail: 0.85,
      solid: false,
    };
  // IRC R311.7: 7 3/4 in, 10 in and 36 in; R312: a 36 in guard.
  return {
    maxRise: 0.196,
    minTread: 0.254,
    width: 0.915,
    guard: 0.95,
    handrail: 0.9,
    solid: false,
  };
}
const WELL_GAP = 0.05;
/** A stair's place: its local origin, the unit run direction `u` and the unit cross direction `v` in plan. */
interface Place {
  o: readonly [number, number];
  u: readonly [number, number];
  v: readonly [number, number];
}
const planPoint = (p: Place, u: number, v: number): [number, number] => [
  p.o[0] + p.u[0] * u + p.v[0] * v,
  p.o[1] + p.u[1] * u + p.v[1] * v,
];
function planRect(p: Place, u0: number, u1: number, v0: number, v1: number): Rect {
  const a = planPoint(p, u0, v0),
    b = planPoint(p, u1, v1);
  return {
    x0: Math.min(a[0], b[0]),
    x1: Math.max(a[0], b[0]),
    z0: Math.min(a[1], b[1]),
    z1: Math.max(a[1], b[1]),
  };
}
interface Flight {
  /** Risers a flight. */
  count: number;
  rise: number;
  tread: number;
}
interface StairPlan {
  kind: BuildingStair['kind'];
  place: Place;
  /** Plan length and breadth of the stair itself. */
  length: number;
  breadth: number;
  rule: StairRule;
  flights: Flight[];
  /** Plan length of the sloped run. */
  run: number;
}

/**
 * A stair shaft that fits every storey: a dog-leg (two flights and a half landing, so storeys stack) or, between two
 * floors only, one straight flight. The footprint and its approach lie in one room on every floor, clear of doorway
 * approaches and 1.2 m off outer doors, and 0.3 m off windows where a room allows that. Undefined when no room holds
 * one.
 */
function planStair(rule: StairRule, floors: number[], layout: Floor[]): StairPlan | undefined {
  const heights = floors.slice(1).map((f, k) => f - floors[k]),
    w = rule.width,
    approach = Math.max(0.8, w),
    going = (rise: number) => Math.min(0.32, Math.max(rule.minTread, 0.63 - 2 * rise));
  const shapes: StairPlan['kind'][] = heights.length === 1 ? ['dog-leg', 'straight'] : ['dog-leg'];
  // Rooms to try: the most divided floor first (its rooms are the smallest), back rows first, then right to left.
  const order = layout
    .map((f, k) => ({ f, k }))
    .sort((a, b) => b.f.rooms.length - a.f.rooms.length || b.k - a.k)
    .flatMap(({ f }) =>
      f.rooms
        .map((r, i) => ({ r, at: f.at[i] }))
        .sort((a, b) => a.at.row - b.at.row || b.at.column - a.at.column)
        .map((e) => e.r),
    );
  // Clear of the windows where the plan allows it, else passing one, as a stair window does.
  for (const [byWindow, kind] of [0.3, -1].flatMap((gap) => shapes.map((kind) => [gap, kind] as const))) {
    const dog = kind === 'dog-leg',
      counts = heights.map((h) => {
        const n = Math.ceil(h / ((dog ? 2 : 1) * rule.maxRise) - 1e-9);
        return { n, rise: h / ((dog ? 2 : 1) * n) };
      }),
      run = Math.max(...counts.map((c) => (c.n - 1) * going(c.rise))),
      flights = counts.map((c) => ({
        count: c.n,
        rise: c.rise,
        tread: run / (c.n - 1),
      })),
      length = dog ? run + w : run,
      breadth = dog ? 2 * w + WELL_GAP : w,
      u0 = -approach,
      u1 = dog ? length : length + approach;
    for (const room of order)
      for (const u of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const)
        for (const side of [1, -1]) {
          const v = [-u[1] * side, u[0] * side] as const,
            unplaced = planRect({ o: [0, 0], u, v }, u0, u1, 0, breadth);
          // The footprint with its approach, 2 cm off two walls of the room, else slid along it in 0.2 m steps.
          const spots = (lo: number, hi: number) => {
            if (hi < lo) return [];
            const at = [lo, hi, Math.min(hi, lo + 0.35), Math.max(lo, hi - 0.35)];
            for (let t = lo + 0.2; t < hi; t += 0.2) at.push(t);
            return at;
          };
          for (const dx of spots(room.x0 + 0.02 - unplaced.x0, room.x1 - 0.02 - unplaced.x1))
            for (const dz of spots(room.z0 + 0.02 - unplaced.z0, room.z1 - 0.02 - unplaced.z1)) {
              const place: Place = { o: [dx, dz], u, v },
                whole = planRect(place, u0, u1, 0, breadth),
                body = planRect(place, 0, length, 0, breadth);
              const clear = layout.every(
                (f) =>
                  f.rooms.some((r) => within(whole, r)) &&
                  !f.doors.some((d) => overlaps(body, doorZone(d))) &&
                  !f.openings.some((s) => gapTo(body, s) < (s.door ? 1.2 : byWindow)),
              );
              if (clear) return { kind, place, length, breadth, rule, flights, run };
            }
        }
  }
  return undefined;
}

/** Posts, a top rail and balusters under a 4 in sphere along a straight edge, level or sloped. */
function railing(
  posts: MeshBuilder,
  a: V3,
  b: V3,
  height: number,
  fine: boolean,
  baseA: number = a[1],
  baseB: number = b[1],
) {
  const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
  if (L < 0.05) return;
  posts.beam([a[0], a[1] + height, a[2]], [b[0], b[1] + height, b[2]], 0.05, 0.045);
  const post = (t: number, half: number) => {
    const x = a[0] + (b[0] - a[0]) * t,
      z = a[2] + (b[2] - a[2]) * t,
      foot = baseA + (baseB - baseA) * t,
      top = a[1] + (b[1] - a[1]) * t + height;
    box(posts, x - half, x + half, foot, top, z - half, z + half);
  };
  post(0, 0.04);
  post(1, 0.04);
  // 0.012 m half section on 0.11 m centres at most: openings of 8.6 cm, under the 4 in (10.2 cm) sphere.
  const n = fine ? Math.ceil(L / 0.11) : Math.ceil(L / 1.1);
  for (let i = 1; i < n; i++) post(i / n, 0.012);
}

function buildStair(
  parts: Parts,
  plan: StairPlan,
  floors: number[],
  layout: Floor[],
  detail: InteriorOptions['detail'],
) {
  const body = planRect(plan.place, 0, plan.length, 0, plan.breadth);
  const { place, rule, run, length, breadth, kind } = plan,
    w = rule.width,
    wood = parts.stairs,
    rails = rule.solid ? parts.metalwork : parts.stairs,
    fine = detail !== 'far',
    p = (u: number, v: number, y: number): V3 => {
      const [x, z] = planPoint(place, u, v);
      return [x, y, z];
    },
    slab = (b: MeshBuilder, u0: number, u1: number, v0: number, v1: number, y0: number, y1: number) => {
      const r = planRect(place, Math.min(u0, u1), Math.max(u0, u1), v0, v1);
      box(b, r.x0, r.x1, y0, y1, r.z0, r.z1);
    };
  plan.flights.forEach((f, k) => {
    const { count: m, rise, tread } = f,
      base = floors[k],
      // Where a shorter storey's wider treads start so every flight meets the landing at `run`.
      flight = (v0: number, from: number, dir: 1 | -1, y0: number) => {
        const v1 = v0 + w;
        // m risers and m - 1 treads: the last riser lands on the landing or the floor.
        for (let i = 1; i < m; i++) {
          const a = from + dir * (i - 1) * tread,
            b = from + dir * i * tread,
            y = y0 + i * rise;
          if (rule.solid) slab(wood, a, b, v0, v1, y - rise - 0.1, y);
          else {
            slab(wood, a - dir * 0.025, b, v0, v1, y - 0.035, y);
            slab(wood, a, a + dir * 0.02, v0 + 0.045, v1 - 0.045, y - rise, y - 0.035);
          }
        }
        const end = from + dir * (m - 1) * tread;
        slab(wood, end, end + dir * 0.02, v0, v1, y0 + (m - 1) * rise - 0.035, y0 + m * rise - 0.035);
        // Stringers (or the concrete waist) under the nosing line.
        const lo = y0 + rise - (rule.solid ? 0.26 : 0.17),
          hi = y0 + m * rise - (rule.solid ? 0.26 : 0.17);
        for (const v of rule.solid ? [v0 + w / 2] : [v0 + 0.022, v1 - 0.022])
          wood.beam(p(from, v, lo), p(end, v, hi), rule.solid ? w : 0.044, rule.solid ? 0.12 : 0.24);
      };
    // A handrail over the nosing line, its balusters footed one riser lower, in the treads.
    const handrail = (v: number, from: number, to: number, y0: number) => {
      const a = p(from, v, y0 + rise),
        b = p(to, v, y0 + m * rise);
      railing(rails, a, b, rule.handrail, fine, a[1] - rise, b[1] - rise);
    };
    // Flight A from this floor's approach to the half landing (or straight to the floor above).
    flight(0, 0, 1, base);
    if (kind === 'dog-leg') {
      const mid = base + m * rise;
      slab(wood, run, length, 0, breadth, mid - (rule.solid ? 0.18 : 0.06), mid);
      for (const v of [0.05, breadth - 0.05]) slab(wood, length - 0.1, length, v - 0.045, v + 0.045, base, mid - 0.06);
      flight(w + WELL_GAP, run, -1, mid);
      for (const [v, from, to, y0] of [
        [w - 0.04, 0, run, base],
        [w + WELL_GAP + 0.04, run, 0, mid],
      ] as const)
        handrail(v, from, to, y0);
    } else handrail(w - 0.04, 0, run, base);
  });
  // Guards round each well on the floor above; the arrival edge stays open, and so does the next flight's foot.
  for (let k = 1; k < floors.length; k++) {
    const y = floors[k],
      top = k === floors.length - 1,
      edges: [V3, V3][] = [
        [p(0, 0, y), p(length, 0, y)],
        [p(0, breadth, y), p(length, breadth, y)],
      ];
    if (kind === 'dog-leg') {
      edges.push([p(length, 0, y), p(length, breadth, y)]);
      if (top) edges.push([p(0, 0, y), p(0, w, y)]);
    } else edges.push([p(0, 0, y), p(0, breadth, y)]);
    // An edge against a wall needs no guard.
    const room = layout[k].rooms.find((r) => within(body, r))!,
      walled = (a: V3, b: V3) =>
        (['x0', 'x1'] as const).some((s) => Math.abs(a[0] - room[s]) < 0.06 && Math.abs(b[0] - room[s]) < 0.06) ||
        (['z0', 'z1'] as const).some((s) => Math.abs(a[2] - room[s]) < 0.06 && Math.abs(b[2] - room[s]) < 0.06);
    for (const [a, b] of edges) if (!walled(a, b)) railing(rails, a, b, rule.guard, fine);
  }
}

/** Room uses: which rooms of a home are the kitchen and bathroom, of an office the toilet. */
function assignUses(o: InteriorOptions, layout: Floor[], use: 'home' | 'office' | 'store', plan?: StairPlan) {
  let bathroom = false;
  layout.forEach((f, k) => {
    const shop = k === 0 && o.storefront,
      base: BuildingRoomUse = use === 'store' ? 'store' : use === 'office' ? 'office' : 'living',
      level = o.storefront ? k - 1 : k;
    f.uses = f.rooms.map(() => (shop ? 'shop' : use === 'home' && level > 0 ? 'bedroom' : base));
    if (!o.fixtures || use === 'store' || shop || f.rooms.length < 2) return;
    // Service rooms go to the back, right to left, in rooms the stair leaves free where there are any.
    const body = plan && planRect(plan.place, 0, plan.length, 0, plan.breadth),
      stairIn = (i: number) => (body && overlaps(body, f.rooms[i]) ? 1 : 0),
      order = f.rooms
        .map((_, i) => i)
        .sort((a, b) => stairIn(a) - stairIn(b) || f.at[a].row - f.at[b].row || f.at[b].column - f.at[a].column);
    if (use === 'office') f.uses[order[0]] = 'toilet';
    else if (level === 0) {
      f.uses[order[0]] = 'kitchen';
      if (f.rooms.length >= 3) {
        f.uses[order[1]] = 'bathroom';
        bathroom = true;
      }
    } else if (!bathroom) {
      f.uses[order[0]] = 'bathroom';
      bathroom = true;
    }
  });
}

/** A block against a wall, in the wall's terms: `a` along it from the block's middle, `b` out from it into the room. */
interface Frame {
  box(m: MeshBuilder, a0: number, a1: number, y0: number, y1: number, b0: number, b1: number): void;
  point(a: number, y: number, b: number): V3;
}

/** The interior of a building: slabs in every case, and rooms, cells or nothing behind the windows. */
export function buildInterior(
  parts: Parts,
  o: InteriorOptions,
  sides: Side[],
  holes: Hole[],
  floors: number[],
  eaves: number,
  pitched: boolean,
): Interior {
  const out: Interior = { rooms: [], furniture: [], doorways: [], stairs: [] };
  const W = o.width,
    D = o.depth,
    th = o.wall,
    all: Rect = {
      x0: -W / 2 + th,
      x1: W / 2 - th,
      z0: -D / 2 + th,
      z1: D / 2 - th,
    },
    { x0, x1, z0, z1 } = all,
    japan = o.style.startsWith('japan'),
    use =
      o.style === 'japan-2011-warehouse' || o.style === 'western-1910-depot'
        ? 'store'
        : o.style === 'japan-2011-concrete'
          ? 'office'
          : 'home',
    ceilingOf = (k: number) => (k + 1 < floors.length ? floors[k + 1] : eaves) - SLAB,
    m = parts.interior,
    // Interior floors: one slab per storey (and a ceiling under a pitched roof).
    levels = pitched ? [...floors, eaves] : floors;
  const pt = japan ? 0.1 : 0.12,
    dw = japan ? 0.86 : 0.81,
    dh = japan ? 1.8 : 2.03,
    bays = Math.max(1, Math.round(W / o.bayWidth)),
    bw = W / bays;
  // Each opening on the inner wall face, in local terms: the wall plane and the span along it.
  const span = (h: Hole): Opening => {
    const door = h.kind === 'door' || h.kind === 'balcony-door',
      on = (axis: 'x' | 'z', plane: number, lo: number, hi: number) => ({
        axis,
        plane,
        lo,
        hi,
        door,
        hole: h,
      });
    if (h.side === 0) return on('z', z1, -W / 2 + h.a0, -W / 2 + h.a1);
    if (h.side === 2) return on('z', z0, W / 2 - h.a1, W / 2 - h.a0);
    if (h.side === 1) return on('x', x1, D / 2 - h.a1, D / 2 - h.a0);
    return on('x', x0, -D / 2 + h.a0, -D / 2 + h.a1);
  };
  // The plan of every floor: partitions on bay lines, doorways through them.
  const walls: [number, number, number, number, number, number][] = [];
  const layout: Floor[] =
    o.interior !== 'rooms'
      ? []
      : floors.map((fy, k) => {
          const cy = ceilingOf(k),
            open = use === 'store' || (k === 0 && o.storefront),
            n = open ? 1 : Math.max(1, Math.round((x1 - x0) / ROOM_WIDTH[japan ? 'japan' : 'western'])),
            xs = [x0];
          for (let j = 1; j < n; j++) {
            // A partition on a bay line where one is close, so none stands behind a window.
            const even = x0 + (j * (x1 - x0)) / n,
              snap = -W / 2 + bw * Math.round((even + W / 2) / bw);
            xs.push(Math.abs(snap - even) < 0.6 && snap - xs[xs.length - 1] > 2.4 && x1 - snap > 2.4 ? snap : even);
          }
          xs.push(x1);
          const zs = !open && z1 - z0 > 6 ? [z0, z1 - 0.55 * (z1 - z0), z1] : [z0, z1],
            doors: BuildingDoorway[] = [];
          for (let j = 1; j < xs.length - 1; j++)
            for (let r = 0; r + 1 < zs.length; r++) {
              const za = zs[r] + (r > 0 ? pt / 2 : 0),
                zb = zs[r + 1] - (r + 1 < zs.length - 1 ? pt / 2 : 0),
                d0 = za + 0.3,
                d1 = d0 + dw,
                x = xs[j];
              if (d1 > zb - 0.1) {
                walls.push([x - pt / 2, x + pt / 2, fy, cy, za, zb]);
                continue;
              }
              walls.push([x - pt / 2, x + pt / 2, fy, cy, za, d0]);
              walls.push([x - pt / 2, x + pt / 2, fy, cy, d1, zb]);
              walls.push([x - pt / 2, x + pt / 2, fy + dh, cy, d0, d1]);
              doors.push({
                floor: k,
                centre: [x, fy + dh / 2, (d0 + d1) / 2],
                width: dw,
                height: dh,
                normal: 'x',
              });
            }
          if (zs.length === 3)
            for (let i = 0; i + 1 < xs.length; i++) {
              const xa = xs[i] + (i > 0 ? pt / 2 : 0),
                xb = xs[i + 1] - (i + 1 < xs.length - 1 ? pt / 2 : 0),
                c = (xa + xb) / 2,
                z = zs[1];
              walls.push([xa, c - dw / 2, fy, cy, z - pt / 2, z + pt / 2]);
              walls.push([c + dw / 2, xb, fy, cy, z - pt / 2, z + pt / 2]);
              walls.push([c - dw / 2, c + dw / 2, fy + dh, cy, z - pt / 2, z + pt / 2]);
              doors.push({
                floor: k,
                centre: [c, fy + dh / 2, z],
                width: dw,
                height: dh,
                normal: 'z',
              });
            }
          const floor: Floor = {
            rooms: [],
            at: [],
            doors,
            openings: holes.filter((h) => h.floor === k).map(span),
            uses: [],
            keep: [],
          };
          for (let i = 0; i + 1 < xs.length; i++)
            for (let r = 0; r + 1 < zs.length; r++) {
              floor.rooms.push({
                x0: xs[i] + (i > 0 ? pt / 2 : 0),
                x1: xs[i + 1] - (i + 1 < xs.length - 1 ? pt / 2 : 0),
                z0: zs[r] + (r > 0 ? pt / 2 : 0),
                z1: zs[r + 1] - (r + 1 < zs.length - 1 ? pt / 2 : 0),
              });
              floor.at.push({ column: i, row: r });
            }
          return floor;
        });
  const rule = stairRule(o.style, (x1 - x0) * (z1 - z0)),
    plan = o.interior === 'rooms' && o.stairs && floors.length > 1 ? planStair(rule, floors, layout) : undefined,
    well = plan && planRect(plan.place, 0, plan.length, 0, plan.breadth);
  // The floors above the first are open over the stair.
  levels.forEach((fy, k) => {
    for (const r of without(all, k > 0 && k < floors.length ? well : undefined))
      box(m, r.x0, r.x1, fy - SLAB, fy, r.z0, r.z1);
  });
  if (o.interior === 'none') return out;
  if (o.interior === 'cells') {
    // One cell per window: back wall, floor, ceiling and two sides, facing in: the room cell of van Dongen 2008.
    for (const h of holes) {
      if (h.kind === 'door' || h.kind === 'transom') continue;
      const s = sides[h.side],
        fy = floors[h.floor],
        cy = ceilingOf(h.floor),
        a0 = Math.max(th, h.a0 - 0.6),
        a1 = Math.min(s.length - th, h.a1 + 0.6),
        depth = Math.min(3.6, ((h.side % 2 === 0 ? D : W) - 2 * th) / 2),
        p = (a: number, y: number, off: number): V3 =>
          add(add(s.start, scale(s.dir, a)), [s.out[0] * off, y, s.out[2] * off]),
        i0 = -th,
        i1 = -th - depth,
        g = fy + 0.005;
      m.poly([p(a0, fy, i1), p(a1, fy, i1), p(a1, cy, i1), p(a0, cy, i1)], s.out);
      m.poly([p(a0, g, i0), p(a1, g, i0), p(a1, g, i1), p(a0, g, i1)], [0, 1, 0]);
      m.poly([p(a0, cy, i0), p(a1, cy, i0), p(a1, cy, i1), p(a0, cy, i1)], [0, -1, 0]);
      m.poly([p(a0, fy, i0), p(a0, fy, i1), p(a0, cy, i1), p(a0, cy, i0)], s.dir);
      m.poly([p(a1, fy, i0), p(a1, fy, i1), p(a1, cy, i1), p(a1, cy, i0)], scale(s.dir, -1));
    }
    return out;
  }
  for (const [a, b, c, d, e, g] of walls) box(m, a, b, c, d, e, g);
  assignUses(o, layout, use, plan);
  if (plan) {
    buildStair(parts, plan, floors, layout, o.detail);
    const approach = Math.max(0.8, plan.rule.width),
      whole = planRect(
        plan.place,
        -approach,
        plan.kind === 'dog-leg' ? plan.length : plan.length + approach,
        0,
        plan.breadth,
      );
    for (const f of layout) f.keep.push(whole);
    plan.flights.forEach((flight, k) =>
      out.stairs.push({
        floor: k,
        kind: plan.kind,
        min: [well!.x0, well!.z0],
        max: [well!.x1, well!.z1],
        risers: flight.count * (plan.kind === 'dog-leg' ? 2 : 1),
        rise: flight.rise,
        tread: flight.tread,
        width: plan.rule.width,
        guard: plan.rule.guard,
      }),
    );
  }
  const f = parts.furniture,
    china = parts.fixtures,
    metal = parts.metalwork,
    cloth = parts.fabric,
    soft = o.softFurnishings;
  layout.forEach((floor, k) => {
    const fy = floors[k],
      cy = ceilingOf(k);
    out.doorways.push(...floor.doors);
    floor.rooms.forEach((room, index) => {
      const { x0: rx0, x1: rx1, z0: rz0, z1: rz1 } = room,
        mx = (rx0 + rx1) / 2,
        mz = (rz0 + rz1) / 2,
        roomUse = floor.uses[index];
      out.rooms.push({
        floor: k,
        use: roomUse,
        min: [rx0, rz0],
        max: [rx1, rz1],
        level: fy,
        height: cy - fy,
        area: (rx1 - rx0) * (rz1 - rz0),
      });
      const placed: BuildingFurniture[] = [],
        /** Clear zones in front of fixtures: blocks keep out of them, they may share floor. */
        fronts: Rect[] = [];
      // A block fits when it is inside the room, clear of the others, of the stair, of every doorway's approach (0.9 m
      // each side) and of each outer door (1.2 m), and lower than the sill of any window it stands within 0.9 m of.
      const fits = (r: Rect, top: number) => {
        if (r.x0 < rx0 + 0.02 || r.x1 > rx1 - 0.02 || r.z0 < rz0 + 0.02 || r.z1 > rz1 - 0.02) return false;
        for (const q of placed)
          if (
            overlaps(r, {
              x0: q.min[0],
              x1: q.max[0],
              z0: q.min[2],
              z1: q.max[2],
            })
          )
            return false;
        for (const q of fronts) if (overlaps(r, q)) return false;
        for (const q of floor.keep) if (overlaps(r, q)) return false;
        for (const d of floor.doors) if (overlaps(r, doorZone(d))) return false;
        for (const s of floor.openings)
          if (gapTo(r, s) < (s.door ? 1.2 : 0.9) && (s.door || top > s.hole.y0 - 0.05)) return false;
        return true;
      };
      const take = (kind: string, r: Rect, h: number) =>
        placed.push({
          kind,
          floor: k,
          min: [r.x0, fy, r.z0],
          max: [r.x1, fy + h, r.z1],
        });
      const put = (kind: string, cx: number, cz: number, sx: number, sz: number, h: number, pieces?: () => void) => {
        const r = {
          x0: cx - sx / 2,
          x1: cx + sx / 2,
          z0: cz - sz / 2,
          z1: cz + sz / 2,
        };
        if (!fits(r, fy + h)) return false;
        if (pieces) pieces();
        else box(f, r.x0, r.x1, fy, fy + h, r.z0, r.z1);
        take(kind, r, h);
        return true;
      };
      /**
       * A block `w` along a wall, `d` out from it and `h` high, with `front` metres kept clear before it: each wall of
       * the room at its middle, then toward its ends.
       */
      const wallBlock = (
        kind: string,
        w: number,
        d: number,
        h: number,
        front: number,
        pieces?: (frame: Frame) => void,
      ) => {
        for (const t of [0.5, 0.25, 0.75, 0.05, 0.95]) {
          // [wall point at t along it, along axis, outward-into-room axis]
          const spots: [[number, number], [number, number], [number, number]][] = [
            [
              [rx0 + 0.03, rz0 + (rz1 - rz0) * t],
              [0, 1],
              [1, 0],
            ],
            [
              [rx1 - 0.03, rz0 + (rz1 - rz0) * t],
              [0, 1],
              [-1, 0],
            ],
            [
              [rx0 + (rx1 - rx0) * t, rz0 + 0.03],
              [1, 0],
              [0, 1],
            ],
            [
              [rx0 + (rx1 - rx0) * t, rz1 - 0.03],
              [1, 0],
              [0, -1],
            ],
          ];
          for (const [wallAt, along, into] of spots) {
            // Near the ends, slide the block so it stays within the wall.
            const length = along[0] ? rx1 - rx0 : rz1 - rz0,
              lo = along[0] ? rx0 : rz0,
              mid = along[0] ? wallAt[0] : wallAt[1],
              slid = Math.min(Math.max(mid, lo + w / 2 + 0.03), lo + length - w / 2 - 0.03),
              origin: [number, number] = along[0] ? [slid, wallAt[1]] : [wallAt[0], slid],
              place: Place = { o: origin, u: along, v: into },
              r = planRect(place, -w / 2, w / 2, 0, d);
            if (!fits(r, fy + h)) continue;
            if (front > 0) {
              const zone = planRect(place, -w / 2, w / 2, d, d + front);
              if (
                !within(zone, room) ||
                placed.some((q) =>
                  overlaps(zone, {
                    x0: q.min[0],
                    x1: q.max[0],
                    z0: q.min[2],
                    z1: q.max[2],
                  }),
                )
              )
                continue;
              fronts.push(zone);
            }
            if (pieces)
              pieces({
                box: (b, a0, a1, y0, y1, b0, b1) => {
                  const q = planRect(place, a0, a1, b0, b1);
                  box(b, q.x0, q.x1, fy + y0, fy + y1, q.z0, q.z1);
                },
                point: (a, y, b) => {
                  const [x, z] = planPoint(place, a, b);
                  return [x, fy + y, z];
                },
              });
            else box(f, r.x0, r.x1, fy, fy + h, r.z0, r.z1);
            take(kind, r, h);
            return true;
          }
        }
        return false;
      };
      const legs = (cx: number, cz: number, hx: number, hz: number, top: number, leg: number) => {
        for (const [sx, sz] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ])
          box(f, cx + sx * hx - leg, cx + sx * hx + leg, fy, top, cz + sz * hz - leg, cz + sz * hz + leg);
      };
      const table = (kind: string, cx: number, cz: number, sx: number, sz: number, h: number) =>
        put(kind, cx, cz, sx, sz, h, () => {
          box(f, cx - sx / 2, cx + sx / 2, fy + h - 0.04, fy + h, cz - sz / 2, cz + sz / 2);
          legs(cx, cz, sx / 2 - 0.06, sz / 2 - 0.06, fy + h - 0.04, 0.03);
        });
      /** A round part standing on the floor of a wall block. */
      const post = (b: MeshBuilder, at: Frame, a: number, d: number, y0: number, y1: number, r0: number, r1 = r0) =>
        b.frustum(at.point(a, y0, d), at.point(a, y1, d), r0, r1, o.detail === 'near' ? 12 : 6);
      /** An open bowl or tub: a floor and four sides. */
      const basin = (
        b: MeshBuilder,
        at: Frame,
        a0: number,
        a1: number,
        y0: number,
        y1: number,
        b0: number,
        b1: number,
        t: number,
      ) => {
        at.box(b, a0, a1, y0, y0 + t, b0, b1);
        at.box(b, a0, a0 + t, y0 + t, y1, b0, b1);
        at.box(b, a1 - t, a1, y0 + t, y1, b0, b1);
        at.box(b, a0 + t, a1 - t, y0 + t, y1, b0, b0 + t);
        at.box(b, a0 + t, a1 - t, y0 + t, y1, b1 - t, b1);
      };
      const tap = (at: Frame, a: number, y: number) => {
        post(metal, at, a, 0.06, y, y + 0.22, 0.015);
        at.box(metal, a - 0.012, a + 0.012, y + 0.2, y + 0.22, 0.06, 0.2);
      };
      /** Kitchen and bathroom fixtures. */
      const kitchen = () => {
        if (japan) {
          // A fitted kitchen 0.84 high: cabinets, a steel top with its bowl cut in, a three ring hob; with the wall
          // cupboard and hood where the wall has no window.
          const counter = (tall: boolean) => (at: Frame) => {
            const w = 2.1;
            at.box(f, -w / 2, w / 2, 0.08, 0.66, 0.02, 0.58);
            at.box(f, -w / 2, w / 2, 0, 0.08, 0.02, 0.52);
            at.box(f, -w / 2, -0.85, 0.66, 0.8, 0.02, 0.58);
            at.box(f, -0.15, w / 2, 0.66, 0.8, 0.02, 0.58);
            basin(metal, at, -0.85, -0.15, 0.66, 0.84, 0.1, 0.52, 0.012);
            at.box(metal, -w / 2, -0.85, 0.8, 0.84, 0, 0.62);
            at.box(metal, -0.15, w / 2, 0.8, 0.84, 0, 0.62);
            at.box(metal, -0.85, -0.15, 0.8, 0.84, 0, 0.1);
            at.box(metal, -0.85, -0.15, 0.8, 0.84, 0.52, 0.62);
            tap(at, -0.5, 0.84);
            for (const [a, b, r] of [
              [0.4, 0.22, 0.09],
              [0.72, 0.22, 0.07],
              [0.56, 0.45, 0.06],
            ])
              post(metal, at, a, b, 0.84, 0.86, r);
            if (!tall) return;
            at.box(f, -w / 2, -0.05, 1.45, 2.1, 0, 0.35);
            at.box(metal, 0.2, 0.95, 1.65, 1.85, 0, 0.5);
            at.box(metal, 0.45, 0.7, 1.85, cy - fy - 0.01, 0, 0.25);
          };
          if (!wallBlock('kitchen counter', 2.1, 0.62, cy - fy - 0.01, 0.8, counter(true)))
            wallBlock('kitchen counter', 2.1, 0.62, 0.84, 0.8, counter(false));
          wallBlock('refrigerator', 0.66, 0.7, 1.78, 0.6, (at) => {
            at.box(china, -0.33, 0.33, 0.02, 1.78, 0, 0.66);
            at.box(china, -0.32, 0.32, 0.04, 0.68, 0.66, 0.69);
            at.box(china, -0.32, 0.32, 0.7, 1.76, 0.66, 0.69);
            for (const [y0, y1] of [
              [0.4, 0.62],
              [0.8, 1.2],
            ])
              at.box(metal, 0.22, 0.25, y0, y1, 0.69, 0.7);
          });
        } else {
          // A cast iron range with its flue, a legged enamel sink and an ice box.
          const range = (flue: boolean) => (at: Frame) => {
            for (const a of [-0.42, 0.42]) for (const b of [0.12, 0.58]) post(metal, at, a, b, 0, 0.22, 0.025, 0.04);
            at.box(metal, -0.48, 0.48, 0.22, 0.76, 0.08, 0.64);
            at.box(metal, -0.5, 0.5, 0.76, 0.8, 0.05, 0.68);
            at.box(metal, -0.4, 0.0, 0.32, 0.66, 0.64, 0.66);
            at.box(metal, 0.1, 0.38, 0.5, 0.68, 0.64, 0.66);
            for (const a of [-0.25, 0.2]) post(metal, at, a, 0.4, 0.8, 0.815, 0.11);
            // The flue rises to the ceiling, or leaves through the wall behind where a window is over the range.
            if (flue) post(metal, at, 0.34, 0.16, 0.8, cy - fy - 0.01, 0.075);
            else at.box(metal, 0.27, 0.41, 0.56, 0.7, 0, 0.08);
          };
          if (!wallBlock('range', 1.0, 0.7, cy - fy - 0.01, 0.8, range(true)))
            wallBlock('range', 1.0, 0.7, 0.82, 0.8, range(false));
          wallBlock('sink', 1.1, 0.56, 0.84, 0.6, (at) => {
            basin(china, at, -0.55, 0.55, 0.64, 0.84, 0.02, 0.56, 0.035);
            for (const a of [-0.5, 0.5]) for (const b of [0.08, 0.5]) post(metal, at, a, b, 0, 0.64, 0.025);
            tap(at, 0, 0.84);
          });
          wallBlock('icebox', 0.76, 0.5, 1.2, 0.5, (at) => {
            for (const a of [-0.33, 0.33]) for (const b of [0.06, 0.42]) post(f, at, a, b, 0, 0.12, 0.03);
            at.box(f, -0.38, 0.38, 0.12, 1.2, 0, 0.47);
            at.box(f, -0.34, 0.34, 0.16, 0.7, 0.47, 0.49);
            at.box(f, -0.34, 0.34, 0.76, 1.16, 0.47, 0.49);
            for (const y of [0.45, 0.95]) at.box(metal, 0.24, 0.29, y, y + 0.1, 0.49, 0.5);
          });
        }
      };
      const toilet = () => {
        // IRC R307.1: 15 in (0.38 m) each side of the centre line and 21 in (0.53 m) clear in front.
        const high = !japan,
          h = high ? 2.2 : 0.82;
        return wallBlock('toilet', 0.78, 0.72, h, 0.55, (at) => {
          post(china, at, 0, 0.45, 0, 0.3, 0.12, 0.15);
          post(china, at, 0, 0.47, 0.3, 0.4, 0.16, 0.2);
          at.box(china, -0.1, 0.1, 0.2, 0.4, 0.14, 0.32);
          post(high ? f : china, at, 0, 0.47, 0.4, 0.43, 0.2);
          if (!high) at.box(china, -0.22, 0.22, 0.4, 0.82, 0, 0.18);
          else {
            at.box(f, -0.28, 0.28, 1.85, 2.2, 0, 0.2);
            post(metal, at, 0, 0.1, 0.4, 1.85, 0.022);
            post(metal, at, 0.2, 0.22, 1.3, 1.85, 0.006);
          }
        });
      };
      const washbasin = () => {
        const stand = (mirror: boolean) => (at: Frame) => {
          if (japan) at.box(f, -0.38, 0.38, 0.08, 0.64, 0, 0.5);
          else post(china, at, 0, 0.24, 0, 0.64, 0.14, 0.09);
          basin(china, at, -0.36, 0.36, 0.64, 0.8, 0.02, 0.5, 0.03);
          tap(at, 0, 0.8);
          if (mirror) at.box(parts.glass, -0.3, 0.3, 1.15, 1.85, 0, 0.02);
        };
        if (!wallBlock('washbasin', 0.76, 0.52, 1.85, 0.55, stand(true)))
          wallBlock('washbasin', 0.76, 0.52, 0.8, 0.55, stand(false));
      };
      const bathtub = () => {
        if (japan)
          return wallBlock('bathtub', 1.6, 0.8, 0.56, 0.55, (at) => basin(china, at, -0.8, 0.8, 0, 0.56, 0, 0.8, 0.07));
        // A footed tub of 60 by 30 in.
        return wallBlock('bathtub', 1.54, 0.78, 0.62, 0.55, (at) => {
          for (const a of [-0.62, 0.62]) for (const b of [0.14, 0.64]) post(metal, at, a, b, 0, 0.15, 0.045, 0.06);
          basin(china, at, -0.76, 0.76, 0.14, 0.6, 0.02, 0.76, 0.05);
          at.box(china, -0.77, 0.77, 0.6, 0.62, 0.01, 0.07);
          at.box(china, -0.77, 0.77, 0.6, 0.62, 0.71, 0.77);
          tap(at, -0.55, 0.4);
        });
      };
      /** A floor covering from `y0` to `y1` over the floor, open over the stair well. */
      const covering = (b: MeshBuilder, r: Rect, y0: number, y1: number) => {
        for (const q of without(r, k > 0 ? well : undefined)) box(b, q.x0, q.x1, fy + y0, fy + y1, q.z0, q.z1);
      };
      /** Tatami over the whole floor: mats of two squares in staggered rows, each edged along its long sides. */
      const tatami = () => {
        const alongX = rx1 - rx0 >= rz1 - rz0,
          long = alongX ? rx1 - rx0 : rz1 - rz0,
          short = alongX ? rz1 - rz0 : rx1 - rx0,
          units = Math.max(2, Math.round(long / 0.88)),
          rows = Math.max(1, Math.round(short / 0.88)),
          du = long / units,
          dv = short / rows,
          lay = (m2: MeshBuilder, a0: number, a1: number, b0: number, b1: number, y0: number, y1: number) =>
            covering(
              m2,
              alongX
                ? { x0: rx0 + a0, x1: rx0 + a1, z0: rz0 + b0, z1: rz0 + b1 }
                : { x0: rx0 + b0, x1: rx0 + b1, z0: rz0 + a0, z1: rz0 + a1 },
              y0,
              y1,
            );
        for (let j = 0; j < rows; j++)
          for (let i = j % 2 ? -1 : 0; i < units; i += 2) {
            const a0 = Math.max(0, i) * du + 0.003,
              a1 = Math.min(units, i + 2) * du - 0.003,
              b0 = j * dv + 0.003,
              b1 = (j + 1) * dv - 0.003;
            lay(parts.mats, a0, a1, b0, b1, 0, 0.008);
            for (const b of [b0, b1 - 0.028]) lay(cloth, a0, a1, b, b + 0.028, 0.008, 0.01);
          }
      };
      /** A pair of pleated curtains on a rod inside each window of this room. */
      const curtains = () => {
        for (const s of floor.openings) {
          const h = s.hole;
          if (h.kind !== 'window' && h.kind !== 'balcony-door') continue;
          const middle = (s.lo + s.hi) / 2,
            inward = s.plane + (s.plane > 0 ? -1 : 1) * 0.1,
            [px, pz] = s.axis === 'z' ? [middle, inward] : [inward, middle];
          if (px < rx0 || px > rx1 || pz < rz0 || pz > rz1) continue;
          const sign = s.plane > 0 ? -1 : 1,
            lo = Math.max(s.axis === 'z' ? rx0 : rz0, s.lo - 0.12),
            hi = Math.min(s.axis === 'z' ? rx1 : rz1, s.hi + 0.12),
            width = Math.min(0.35, (s.hi - s.lo) * 0.28),
            top = Math.min(h.y1 + 0.08, cy - 0.02),
            bottom = h.kind === 'balcony-door' ? fy + 0.03 : Math.max(fy + 0.03, h.y0 - 0.15),
            point = (a: number, y: number, off: number): V3 =>
              s.axis === 'z' ? [a, y, s.plane + sign * off] : [s.plane + sign * off, y, a],
            normal: V3 = s.axis === 'z' ? [0, 0, sign] : [sign, 0, 0];
          metal.beam(point(lo, top, 0.07), point(hi, top, 0.07), 0.02, 0.02);
          for (const [from, to] of [
            [lo, lo + width],
            [hi - width, hi],
          ]) {
            const folds = o.detail === 'near' ? 10 : 6;
            for (let i = 0; i < folds; i++) {
              const a0 = from + ((to - from) * i) / folds,
                a1 = from + ((to - from) * (i + 1)) / folds,
                d0 = i % 2 ? 0.1 : 0.05,
                d1 = i % 2 ? 0.05 : 0.1,
                quad = [point(a0, bottom, d0), point(a1, bottom, d1), point(a1, top, d1), point(a0, top, d0)];
              // Seen from the room and from the street.
              cloth.poly(quad, normal);
              cloth.poly(
                quad.map((q) => add(q, scale(normal, -0.002))),
                scale(normal, -1),
              );
            }
          }
        }
      };
      const dwelling = roomUse === 'living' || roomUse === 'bedroom';
      if (soft && use === 'home' && dwelling) {
        if (japan) tatami();
        curtains();
      }
      if (roomUse === 'store') {
        // Crates stacked two high in rows across the back half, 1.2 m cubes on 1.8 m centres.
        for (let cx = rx0 + 1.2; cx + 1.2 < rx1; cx += 1.8)
          for (let cz = rz0 + 1.2; cz < mz; cz += 1.8)
            put('crates', cx, cz, 1.2, 1.2, 2.4, () => {
              box(f, cx - 0.6, cx + 0.6, fy, fy + 1.2, cz - 0.6, cz + 0.6);
              box(f, cx - 0.55, cx + 0.55, fy + 1.2, fy + 2.4, cz - 0.55, cz + 0.55);
            });
      } else if (roomUse === 'shop') {
        // A shop counter across the floor and shelving against a wall.
        put('counter', mx, rz0 + 0.45 * (rz1 - rz0), Math.max(1.2, rx1 - rx0 - 2.4), 0.6, 0.95);
        wallBlock('shelves', Math.min(3, (rx1 - rx0) * 0.5), 0.4, 2.2, 0);
      } else if (roomUse === 'office') {
        put('desk', mx, mz, 1.4, 0.7, 0.72, () => {
          box(f, mx - 0.7, mx + 0.7, fy + 0.69, fy + 0.72, mz - 0.35, mz + 0.35);
          box(f, mx + 0.25, mx + 0.68, fy, fy + 0.69, mz - 0.33, mz + 0.33);
          box(f, mx - 0.68, mx - 0.64, fy, fy + 0.69, mz - 0.33, mz + 0.33);
        });
        put('chair', mx, mz - 0.7, 0.5, 0.5, 0.95);
        wallBlock('cabinet', 0.9, 0.45, 1.8, 0);
      } else if (roomUse === 'toilet') {
        toilet();
        washbasin();
      } else if (roomUse === 'bathroom') {
        bathtub();
        toilet();
        washbasin();
      } else {
        // A kitchen of its own, or one along a wall of a floor's only living room.
        const only = o.fixtures && use === 'home' && floor.rooms.length === 1 && k === (o.storefront ? 1 : 0);
        if (roomUse === 'kitchen' || only) kitchen();
        if (roomUse === 'kitchen') table('table', mx, mz, 0.9, 0.7, 0.76);
        else if (japan && roomUse === 'bedroom') {
          const futon = (at: Frame) => {
            // A floor mattress, the quilt over its foot and a pillow at the wall.
            at.box(cloth, -0.5, 0.5, 0.008, 0.08, 0.03, 2.03);
            at.box(cloth, -0.55, 0.55, 0.08, 0.15, 0.65, 2.05);
            at.box(cloth, -0.24, 0.24, 0.08, 0.17, 0.1, 0.4);
          };
          wallBlock('futon', 1.1, 2.05, 0.18, 0, futon);
          wallBlock('tansu', 1.0, 0.45, 1.1, 0);
        } else if (japan) {
          if (table('low table', mx, mz, 0.9, 0.9, 0.33) && soft)
            for (const sx of [-1, 1]) {
              const cx = mx + sx * 0.8;
              put('cushion', cx, mz, 0.55, 0.55, 0.08, () =>
                box(cloth, cx - 0.27, cx + 0.27, fy + 0.008, fy + 0.08, mz - 0.27, mz + 0.27),
              );
            }
          wallBlock('tansu', 1.0, 0.45, 1.1, 0);
        } else if (roomUse === 'living') {
          if (table('table', mx, mz, 1.2, 0.8, 0.76) && soft) {
            // A rug under the table, short of the walls.
            const hx = Math.min(1.5, (rx1 - rx0) / 2 - 0.25),
              hz = Math.min(1.1, (rz1 - rz0) / 2 - 0.25);
            covering(cloth, { x0: mx - hx, x1: mx + hx, z0: mz - hz, z1: mz + hz }, 0, 0.008);
          }
          for (const sx of [-1, 1]) {
            const cx = mx + sx * 0.85;
            put('chair', cx, mz, 0.45, 0.45, 0.9, () => {
              box(f, cx - 0.22, cx + 0.22, fy + 0.42, fy + 0.46, mz - 0.22, mz + 0.22);
              box(f, cx + sx * 0.2 - 0.02, cx + sx * 0.2 + 0.02, fy + 0.46, fy + 0.9, mz - 0.2, mz + 0.2);
              legs(cx, mz, 0.19, 0.19, fy + 0.42, 0.02);
            });
          }
          wallBlock('sideboard', 1.2, 0.5, 0.9, 0);
        } else {
          const bed = (head: number) => (at: Frame) => {
            for (const a of [-0.67, 0.67])
              for (const b of [0.04, 1.91]) at.box(f, a - 0.03, a + 0.03, 0, 0.42, b - 0.03, b + 0.03);
            at.box(f, -0.7, 0.7, 0.24, 0.34, 0.01, 1.94);
            at.box(f, -0.7, 0.7, 0.34, head, 0.01, 0.07);
            if (!soft) return;
            at.box(cloth, -0.66, 0.66, 0.34, 0.5, 0.08, 1.9);
            // The blanket over the lower part, hanging down the sides, and two pillows.
            at.box(cloth, -0.69, 0.69, 0.5, 0.54, 0.6, 1.93);
            for (const a of [-0.7, 0.68]) at.box(cloth, a, a + 0.02, 0.3, 0.52, 0.6, 1.93);
            for (const a of [-0.34, 0.34]) at.box(cloth, a - 0.27, a + 0.27, 0.5, 0.6, 0.12, 0.46);
          };
          // A tall headboard where the wall allows it, else a low one under the sill.
          if (!wallBlock('bed', 1.42, 1.95, 1.05, 0, bed(1.05))) wallBlock('bed', 1.42, 1.95, 0.6, 0, bed(0.6));
          wallBlock('wardrobe', 1.0, 0.6, 1.9, 0);
        }
      }
      out.furniture.push(...placed);
    });
  });
  return out;
}
