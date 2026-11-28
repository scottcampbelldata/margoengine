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
//   23 cm, tread at least 15 cm; the house here keeps the usual 21 cm and 23 cm; a winding stair's tread is measured
//   30 cm from its narrow end). Tatami of the Edo-ma size, about 0.88 by 1.76 m, laid so no four corners meet.
// - Spiral stairs: International Residential Code 2021, spiral stairways (26 in wide, tread at least 6 3/4 in at 12 in
//   from the narrow edge, riser at most 9 1/2 in, headroom 6 ft 6 in).
// - Winder stairs: International Residential Code 2021 R311.7.4 (the walking line 12 in from the narrow side) and
//   R311.7.5.2.1 (a winder tread at least 10 in on the walking line and 6 in anywhere in the clear width); Order art. 23
//   para. 2 (measured 30 cm from the narrow end).
// - Fixed ladders: US 29 CFR 1910.23 (rungs 10 to 14 in apart, at least 16 in wide, 7 in clear behind, side rails
//   42 in above the landing).
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
import type { BayPlan } from './building-bays.js';

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
  /** A bay window standing out from this opening. */
  bay?: BayPlan;
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
  readonly stairShape: 'auto' | 'winder';
  readonly fixtures: boolean;
  readonly softFurnishings: boolean;
  readonly detail: 'far' | 'mid' | 'near';
}
/**
 * Floor rectangles (building-local) the stair keeps out of: building-plans.ts sets it on a block's options when
 * another block's stair or rooms stand there. With `required`, a stair is still built where nothing else is free.
 */
export const STAIR_AVOID: unique symbol = Symbol('stairAvoid');
export interface StairAvoid {
  readonly rects: readonly { x0: number; x1: number; z0: number; z1: number }[];
  readonly required: boolean;
  /** Floor the stair also keeps out of where it can: before steps to a joined block of other floor levels. */
  readonly soft?: StairAvoid['rects'];
  /**
   * Floor a wall at a join takes from this block (a block of other floor levels comes first there): partition doorways
   * stay on this side of it where the partition leaves room.
   */
  readonly hidden?: StairAvoid['rects'];
  /** Where given, the stair's feet and heads stand in here: a tower's side that opens into the main block. */
  readonly from?: { x0: number; x1: number; z0: number; z1: number };
}
/**
 * On a built building: how many of the `interior` part's first triangles are the outer walls' inside faces, which
 * building-plans.ts cuts as walls where another block joins.
 */
export const WALL_LINING: unique symbol = Symbol('wallLining');
/**
 * On a built building: each window's curtains and rod as runs of two parts' triangles, with the window's middle on the
 * wall (local), so building-plans.ts can take them down with a window another block covers.
 */
export const CURTAINS: unique symbol = Symbol('curtains');
/**
 * Floor (building-local) furniture keeps off, by storey: building-plans.ts sets it on a block's options where steps to
 * a joined block stand or land.
 */
export const KEEP_CLEAR: unique symbol = Symbol('keepClear');
export type KeepClear = readonly { floor: number; x0: number; x1: number; z0: number; z1: number }[];
export interface CurtainRun {
  readonly part: 'fabric' | 'metalwork';
  readonly from: number;
  readonly to: number;
  readonly window: V3;
}
export interface Interior {
  curtains: CurtainRun[];
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
export const SLAB = 0.2;
/** A ramp's slope, the most one run of it climbs and a landing between runs: 1 in 12, 30 in and 60 in (IBC 2021 1012). */
export const RAMP = { slope: 1 / 12, rise: 0.762, landing: 1.525 } as const;
/** Height of a doorway through a wall: a fusuma opening, 1.8 m, or an 80 in door. */
export const doorHeight = (style: BuildingStyle) => (style.startsWith('japan') ? 1.8 : 2.03);

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
export function stairRule(style: BuildingStyle, area: number): StairRule {
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
  /** Risers a flight (a dog-leg's two flights have this many each). */
  count: number;
  rise: number;
  /** Going: at the walking line of a spiral, 0 for a ladder. */
  tread: number;
  /** A spiral flight's turn from one tread to the next, rad. */
  angle: number;
}
interface StairShape {
  kind: BuildingStair['kind'];
  /** Plan length and breadth of the stair itself. */
  length: number;
  breadth: number;
  /** Floor kept clear before the stair (u below 0) and past its far end. */
  before: number;
  after: number;
  rule: StairRule;
  flights: Flight[];
  /** Plan length of the sloped run. */
  run: number;
  /**
   * A winder stair's half turn: how many equal winder treads, the radius of the well they turn about, and their depth
   * on the walking line and at the well.
   */
  turn?: { count: number; inner: number; walk: number; narrow: number };
}
interface StairPlan extends StairShape {
  place: Place;
}

const storeyHeights = (floors: number[]) => floors.slice(1).map((f, k) => f - floors[k]);
const approachOf = (width: number) => Math.max(0.8, width);

/** A dog-leg (two flights and a half landing, so storeys stack) or, between two floors only, one straight flight. */
function framedShapes(rule: StairRule, floors: number[]): StairShape[] {
  const heights = storeyHeights(floors),
    w = rule.width,
    approach = approachOf(w),
    kinds: StairShape['kind'][] = heights.length === 1 ? ['dog-leg', 'straight'] : ['dog-leg'];
  return kinds.map((kind) => {
    const dog = kind === 'dog-leg',
      counts = heights.map((h) => {
        const n = Math.ceil(h / ((dog ? 2 : 1) * rule.maxRise) - 1e-9);
        return { n, rise: h / ((dog ? 2 : 1) * n) };
      }),
      run = Math.max(...counts.map((c) => (c.n - 1) * goingOf(rule, c.rise)));
    return {
      kind,
      length: dog ? run + w : run,
      breadth: dog ? 2 * w + WELL_GAP : w,
      before: approach,
      after: dog ? 0 : approach,
      rule,
      flights: counts.map((c) => ({ count: c.n, rise: c.rise, tread: run / (c.n - 1), angle: 0 })),
      run,
    };
  });
}

/** A straight tread's going for a rise: Blondel's step rule within the code's tread and a comfortable most. */
const goingOf = (rule: StairRule, rise: number) => Math.min(0.32, Math.max(rule.minTread, 0.63 - 2 * rise));

/**
 * Winder stairs, for plans a dog-leg does not fit: two flights whose half landing is a half turn of equal winder treads
 * about the end of the well. The well is wide enough for the code's narrow end (6 in in the United States), and a
 * storey takes one riser more where that makes both flights alike. Smallest plan first.
 */
function winderShapes(style: BuildingStyle, rule: StairRule, floors: number[]): StairShape[] {
  const japan = style.startsWith('japan'),
    // Where the code measures a winder from the narrow side, its least depth there and anywhere.
    offset = japan ? 0.3 : 0.305,
    walkMin = style === 'japan-2011-concrete' ? 0.24 : japan ? 0.15 : 0.254,
    narrowMin = japan ? 0 : 0.1524,
    w = rule.width;
  return [6, 4, 3]
    .flatMap((count): StairShape[] => {
      const chord = 2 * Math.sin(Math.PI / (2 * count)),
        inner = Math.max(0.05, narrowMin / chord + 1e-6),
        walk = (inner + offset) * chord;
      if (walk < walkMin) return [];
      const flights = storeyHeights(floors).map((h) => {
        let n = Math.ceil(h / rule.maxRise - 1e-9);
        if ((n - 1 - count) % 2) n++;
        return { count: n, rise: h / n, straight: (n - 1 - count) / 2 };
      });
      const run = Math.max(...flights.map((f) => f.straight * goingOf(rule, f.rise)));
      return [
        {
          kind: 'winder',
          length: run + inner + w,
          breadth: 2 * (w + inner),
          before: approachOf(w),
          after: 0,
          rule,
          flights: flights.map((f) => ({
            count: f.count,
            rise: f.rise,
            tread: run / f.straight,
            angle: Math.PI / count,
          })),
          run,
          turn: { count, inner, walk, narrow: inner * chord },
        },
      ];
    })
    .sort((a, b) => a.length * a.breadth - b.length * b.breadth);
}

/** A spiral flight's last quarter turn is the landing at the floor above, so every flight starts and ends alike. */
const SPIRAL_LANDING = Math.PI / 2;

/**
 * A spiral stair in a square shaft, for plans a framed stair does not fit. Each flight turns whole turns less the
 * landing quarter, and as many turns as leave headroom between them.
 */
function spiralShapes(style: BuildingStyle, framed: StairRule, floors: number[]): StairShape[] {
  const heights = storeyHeights(floors),
    japan = style.startsWith('japan'),
    concrete = style === 'japan-2011-concrete',
    // Where the tread is measured from the narrow edge, the widest walking line and the code's tread and riser.
    walk = japan ? 0.3 : 0.305,
    walkMax = japan ? Infinity : 0.622,
    minTread = concrete ? 0.24 : japan ? 0.15 : 0.1715,
    codeRise = concrete ? 0.2 : japan ? 0.23 : 0.241,
    // 2.02 m of the lowest storey stays above a step's rise, so mixed storeys keep headroom too.
    maxRise = Math.min(concrete ? 0.18 : japan ? 0.21 : 0.22, Math.max(0.17, Math.min(...heights) - 2.02)),
    width = japan ? framed.width : 0.7,
    rule: StairRule = { ...framed, maxRise, minTread, width, solid: concrete };
  let radius = walk + 0.05;
  const flights = heights.map((h) => {
    const turns = Math.max(1, Math.floor(((1.5 * h) / 2.2 + 0.5) / 2)),
      turn = 2 * Math.PI * turns - SPIRAL_LANDING;
    let count = Math.ceil(h / maxRise - 1e-9);
    if ((minTread * (count - 1)) / turn > walkMax) count = Math.floor((turn * walkMax) / minTread) + 1;
    const angle = turn / (count - 1);
    radius = Math.max(radius, minTread / angle);
    return { count, rise: h / count, tread: 0, angle };
  });
  // A storey whose one turn cannot hold its steps within both the riser and the walking line gets no spiral.
  if (flights.some((f) => f.rise > codeRise)) return [];
  for (const f of flights) f.tread = radius * f.angle;
  const outer = radius - walk + width;
  return [approachOf(width), 0.6].map((before) => ({
    kind: 'spiral' as const,
    length: 2 * outer,
    breadth: 2 * outer,
    before,
    after: 0,
    rule,
    flights,
    run: radius,
  }));
}

/** A ladder through a hatch: 16 in between the rails, rungs at most 0.3 m apart, 0.55 m of hatch. */
const HATCH = { length: 0.55, width: 0.46, clear: 0.41 } as const;
/** The last resort, for a building too small for any stair. Over two storeys the hatches take turns side by side. */
function ladderShapes(framed: StairRule, floors: number[]): StairShape[] {
  const flights = storeyHeights(floors).map((h) => {
    const count = Math.ceil(h / 0.3 - 1e-9);
    return { count, rise: h / count, tread: 0, angle: 0 };
  });
  return [0.6, 0.4].map((before) => ({
    kind: 'ladder' as const,
    length: HATCH.length,
    breadth: HATCH.width * Math.min(2, flights.length),
    before,
    after: 0,
    rule: { ...framed, width: HATCH.clear },
    flights,
    run: 0,
  }));
}

/** How a stair may stand: clear of outer doors by `door`, of windows by `window`, and off every doorway's approach. */
type Clearance = readonly [door: number, window: number, doorways: boolean];
// Clear of the windows where the plan allows it, else passing one, as a stair window does.
const CLEAR: Clearance[] = [
  [1.2, 0.3, true],
  [1.2, -1, true],
];
const TIGHT: Clearance[] = [...CLEAR, [0.6, -1, true], [-1, -1, true], [-1, -1, false]];

/** Whether a stair spans a room from wall to wall and leaves floor on both sides of it, `pass` wide or more. */
function divides(room: Rect, body: Rect, pass: number) {
  const low = [body.x0 - room.x0, body.z0 - room.z0],
    high = [room.x1 - body.x1, room.z1 - body.z1];
  return [0, 1].some((a) => low[a] < pass && high[a] < pass && low[1 - a] >= pass - 1e-9 && high[1 - a] >= pass - 1e-9);
}

type KeepOut = Pick<StairAvoid, 'rects' | 'from' | 'hidden'>;
/** What a join leaves of a room: the largest part of it clear of every hidden rectangle. */
const visible = (room: Rect, hidden: KeepOut['hidden'] = []) =>
  hidden.reduce((r, h) => {
    const area = (q: Rect) => (q.x1 - q.x0) * (q.z1 - q.z0);
    return without(r, h).sort((a, b) => area(b) - area(a))[0] ?? r;
  }, room);
/** Whether every flight's foot and head stand within `from`. */
const entered = (plan: StairPlan, from?: StairAvoid['from']) =>
  !from ||
  plan.flights.every((_, k) =>
    flightEnds(plan, k).every(([x, z]) => x > from.x0 && x < from.x1 && z > from.z0 && z < from.z1),
  );

/**
 * The first place for one of the shapes that fits every storey: the footprint and its approach lie in one room on every
 * floor, with a way past, as `clearances` allow. `rooms` are tried in turn. Undefined when none of them holds one.
 */
function planStair(
  shapes: StairShape[],
  rooms: Rect[],
  layout: Floor[],
  clearances: Clearance[],
  keepOut: KeepOut,
): StairPlan | undefined {
  for (const [[byDoor, byWindow, doorways], shape] of clearances.flatMap((c) => shapes.map((s) => [c, s] as const))) {
    const { length, breadth } = shape,
      pass = shape.kind === 'ladder' ? 0.4 : 0.55,
      u0 = -shape.before,
      u1 = length + shape.after;
    for (const room of rooms)
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
              const clear =
                !keepOut.rects.some((r) => overlaps(whole, r)) &&
                entered({ ...shape, place }, keepOut.from) &&
                layout.every(
                  (f) =>
                    f.rooms.some((q) => {
                      // The way past is judged on what of the room a join leaves.
                      const r = visible(q, keepOut.hidden);
                      return within(whole, r) && !divides(r, body, pass);
                    }) &&
                    !(doorways && f.doors.some((d) => overlaps(body, doorZone(d)))) &&
                    !f.openings.some((s) => gapTo(body, s) < (s.door ? byDoor : byWindow)),
                );
              if (clear) return { ...shape, place };
            }
        }
  }
  return undefined;
}

/** The most divided floor's rooms first (they are the smallest), back rows first, then right to left. */
const roomOrder = (layout: Floor[]) =>
  layout
    .map((f, k) => ({ f, k }))
    .sort((a, b) => b.f.rooms.length - a.f.rooms.length || b.k - a.k)
    .flatMap(({ f }) =>
      f.rooms
        .map((r, i) => ({ r, at: f.at[i] }))
        .sort((a, b) => a.at.row - b.at.row || b.at.column - a.at.column)
        .map((e) => e.r),
    );

/** A block of grid cells taken as one room, the partitions inside it left out: a stair hall. */
interface Hall {
  i0: number;
  i1: number;
  r0: number;
  r1: number;
}
/** Every hall of two or more cells, up to five columns wide: the smallest first, back rows first, right to left. */
function halls(columns: number, rows: number): Hall[] {
  const out: Hall[] = [];
  for (let wide = 1; wide <= Math.min(5, columns); wide++)
    for (let deep = 1; deep <= rows; deep++)
      if (wide * deep > 1)
        for (let r0 = 0; r0 + deep <= rows; r0++)
          for (let i0 = columns - wide; i0 >= 0; i0--) out.push({ i0, i1: i0 + wide - 1, r0, r1: r0 + deep - 1 });
  const cells = (h: Hall) => (h.i1 - h.i0 + 1) * (h.r1 - h.r0 + 1);
  return out.sort((a, b) => cells(a) - cells(b) || a.r0 - b.r0 || b.i0 - a.i0);
}

/**
 * A stair that reaches every floor: a framed stair in a room, else in a stair hall made by taking partitions down, else
 * a winder stair, else a spiral the same two ways, else a ladder. `plan(hall)` builds the floors with that hall. Undefined only when
 * `keepOut` leaves no room for any.
 */
function placeStair(
  style: BuildingStyle,
  rule: StairRule,
  floors: number[],
  columns: number,
  rows: number,
  plan: (hall?: Hall) => Floor[],
  keepOut: KeepOut,
  winderFirst: boolean,
): { stair: StairPlan; hall?: Hall } | undefined {
  const base = plan(),
    order = roomOrder(base),
    framed: [StairShape[], Clearance[]][] = [
      [framedShapes(rule, floors), CLEAR],
      [winderShapes(style, rule, floors), CLEAR],
    ];
  const sets: [StairShape[], Clearance[]][] = [
    ...(winderFirst ? framed.reverse() : framed),
    [spiralShapes(style, rule, floors), CLEAR],
    [ladderShapes(rule, floors), TIGHT],
  ];
  for (const [shapes, clearances] of sets) {
    const stair = planStair(shapes, order, base, clearances, keepOut);
    if (stair) return { stair };
    for (const hall of halls(columns, rows)) {
      const layout = plan(hall),
        // The hall is the one room these floors have that the plain plan lacks.
        made = layout.flatMap((f, k) =>
          f.rooms.filter((r) => !base[k].rooms.some((q) => within(r, q) && within(q, r))),
        );
      if (!made.length) continue;
      const found = planStair(shapes, made.slice(0, 1), layout, clearances, keepOut);
      if (found) return { stair: found, hall };
    }
  }
  return undefined;
}

/** Posts, a top rail and balusters under a 4 in sphere along a straight edge, level or sloped. */
export function railing(
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

/** The floor area flight `k` takes: the whole stair, or a ladder's own hatch. */
function flightRect(plan: StairPlan, k: number): Rect {
  if (plan.kind !== 'ladder') return planRect(plan.place, 0, plan.length, 0, plan.breadth);
  const v = plan.flights.length > 1 ? (k % 2) * HATCH.width : 0;
  return planRect(plan.place, 0, plan.length, v, v + HATCH.width);
}
/** Where a person steps on at the floor flight `k` starts from, and off at the floor above. */
function flightEnds(plan: StairPlan, k: number): [[number, number], [number, number]] {
  const { place, rule, kind } = plan,
    back = -Math.min(0.4, plan.before / 2),
    at = (u: number, v: number) => planPoint(place, u, v);
  if (kind === 'ladder') {
    const v = (plan.flights.length > 1 ? (k % 2) * HATCH.width : 0) + HATCH.width / 2;
    return [at(back, v), at(back, v)];
  }
  if (kind === 'spiral') return [at(back, plan.breadth / 2), at(back, plan.breadth / 2)];
  const w = rule.width;
  if (kind === 'straight') return [at(back, w / 2), at(plan.length - back, w / 2)];
  return [at(back, w / 2), at(back, plan.breadth - w / 2)];
}

/** An edge against a wall of the room around the stair needs no guard. */
function guardEdges(rails: MeshBuilder, edges: [V3, V3][], floor: Floor, body: Rect, height: number, fine: boolean) {
  const room = floor.rooms.find((r) => within(body, r))!,
    walled = (a: V3, b: V3) =>
      (['x0', 'x1'] as const).some((s) => Math.abs(a[0] - room[s]) < 0.06 && Math.abs(b[0] - room[s]) < 0.06) ||
      (['z0', 'z1'] as const).some((s) => Math.abs(a[2] - room[s]) < 0.06 && Math.abs(b[2] - room[s]) < 0.06);
  for (const [a, b] of edges) if (!walled(a, b)) railing(rails, a, b, height, fine);
}

/** Treads winding round a post, a handrail round the outside and a landing quarter at each floor above. */
function buildSpiral(
  wood: MeshBuilder,
  rails: MeshBuilder,
  plan: StairPlan,
  floors: number[],
  layout: Floor[],
  fine: boolean,
) {
  const { place, rule, breadth } = plan,
    outer = breadth / 2,
    pole = Math.max(0.05, outer - rule.width),
    at = (u: number, v: number, y: number): V3 => {
      const [x, z] = planPoint(place, u, v);
      return [x, y, z];
    },
    // The turn starts toward the approach (u below the centre) and runs toward v = 0.
    around = (r: number, a: number, y: number) => at(outer - r * Math.cos(a), outer - r * Math.sin(a), y);
  const top = floors[floors.length - 1];
  wood.slab(
    Array.from({ length: 8 }, (_, i) => around(pole, (i * Math.PI) / 4, top + rule.guard)),
    top + rule.guard - floors[0],
    [0, 1, 0],
  );
  plan.flights.forEach((f, k) => {
    const base = floors[k],
      edge = outer - 0.005;
    for (let i = 1; i < f.count; i++) {
      const a = (i - 1) * f.angle,
        b = i * f.angle,
        y = base + i * f.rise;
      wood.slab(
        [
          around(pole * 0.9, a, y),
          around(edge, a, y),
          around(edge, (a + b) / 2, y),
          around(edge, b, y),
          around(pole * 0.9, b, y),
        ],
        0.035,
        [0, 1, 0],
      );
      // A board under the front edge leaves openings under the 4 in sphere.
      const drop = f.rise - 0.035 - 0.095;
      if (drop > 0) {
        const mid = y - 0.035 - drop / 2;
        wood.beam(around(pole, a + 0.02, mid), around(edge - 0.01, a + 0.02, mid), 0.02, drop);
      }
      const r = outer - 0.04,
        high = (t: number) => base + f.rise * (1 + t / f.angle) + rule.handrail;
      rails.beam(around(r, a, high(a)), around(r, b, high(b)), 0.05, 0.045);
      const n = fine ? Math.max(1, Math.ceil((r * f.angle) / 0.11)) : 1;
      for (let j = 0; j < n; j++) {
        const t = a + ((j + 0.5) * f.angle) / n,
          [x, , z] = around(r, t, 0);
        box(rails, x - 0.012, x + 0.012, y, high(t), z - 0.012, z + 0.012);
      }
    }
    // The landing at the floor above: the corner quarter between the last step and the next flight's first.
    const r = planRect(place, 0, outer, outer, breadth);
    box(wood, r.x0, r.x1, floors[k + 1] - 0.06, floors[k + 1], r.z0, r.z1);
  });
  const body = flightRect(plan, 0);
  for (let k = 1; k < floors.length; k++) {
    const y = floors[k],
      edges: [V3, V3][] = [
        [at(breadth, 0, y), at(breadth, breadth, y)],
        [at(0, 0, y), at(breadth, 0, y)],
        [at(0, breadth, y), at(breadth, breadth, y)],
        [at(0, 0, y), at(0, outer, y)],
      ];
    // At the top no flight leaves the landing, so its open side is guarded too.
    if (k === floors.length - 1) edges.push([at(0, outer, y), at(outer - pole, outer, y)]);
    guardEdges(rails, edges, layout[k], body, rule.guard, fine);
  }
}

/** Two rails and rungs against the back of a hatch, the rails 42 in above the floor they reach, guards round it. */
function buildLadder(metal: MeshBuilder, plan: StairPlan, floors: number[], layout: Floor[], fine: boolean) {
  const { place, rule } = plan,
    at = (u: number, v: number, y: number): V3 => {
      const [x, z] = planPoint(place, u, v);
      return [x, y, z];
    };
  plan.flights.forEach((f, k) => {
    const base = floors[k],
      top = floors[k + 1],
      v0 = plan.flights.length > 1 ? (k % 2) * HATCH.width : 0,
      v1 = v0 + HATCH.width,
      u = HATCH.length - 0.18,
      side = (HATCH.width - HATCH.clear) / 2;
    for (const v of [v0 + side / 2, v1 - side / 2]) {
      const [x, , z] = at(u, v, 0);
      box(metal, x - side / 2, x + side / 2, base, top + 1.07, z - side / 2, z + side / 2);
    }
    for (let j = 1; j <= f.count; j++) {
      const y = base + j * f.rise - 0.0125;
      metal.beam(at(u, v0 + side, y), at(u, v1 - side, y), 0.025, 0.025);
    }
    const edges: [V3, V3][] = [
      [at(HATCH.length, v0, top), at(HATCH.length, v1, top)],
      [at(0, v0, top), at(HATCH.length, v0, top)],
      [at(0, v1, top), at(HATCH.length, v1, top)],
    ];
    guardEdges(metal, edges, layout[k + 1], flightRect(plan, k), rule.guard, fine);
  });
}

/**
 * A winder stair's half turn up from the tread at height `from`: equal treads about the end of the well out to the
 * stair's outer rectangle, a riser board under each front edge, the handrail round the well and posts under the outer
 * corners.
 */
function buildWinders(
  wood: MeshBuilder,
  rails: MeshBuilder,
  plan: StairPlan,
  base: number,
  from: number,
  rise: number,
  fine: boolean,
) {
  const { place, rule, run, length, breadth } = plan,
    { count, inner } = plan.turn!,
    middle = breadth / 2,
    outer = inner + rule.width,
    step = Math.PI / count,
    at = (r: number, a: number, y: number): V3 => {
      const [x, z] = planPoint(place, run + r * Math.sin(a), middle - r * Math.cos(a));
      return [x, y, z];
    },
    // How far the ray at `a` runs from the well's middle to the stair's outer rectangle.
    edge = (a: number) => outer / Math.max(Math.sin(a), Math.abs(Math.cos(a)));
  for (let i = 0; i < count; i++) {
    const a = i * step,
      b = a + step,
      y = from + (i + 1) * rise,
      corners = [Math.PI / 4, (3 * Math.PI) / 4].filter((c) => c > a + 1e-6 && c < b - 1e-6),
      rim = [a, ...corners, b].map((t) => at(edge(t), t, y));
    wood.slab([at(inner, a, y), ...rim, at(inner, b, y)], rule.solid ? rise + 0.1 : 0.035, [0, 1, 0]);
    if (!rule.solid) {
      // The first winder's riser is the top one of the flight below it; each later one stands just behind its front
      // edge, so its top is under the tread.
      const mid = y - 0.035 - (rise - 0.035) / 2,
        behind = (r: number): V3 => {
          const [x, , z] = at(r, a, mid),
            [dx, dz] = planPoint({ o: [0, 0], u: place.u, v: place.v }, Math.cos(a), Math.sin(a));
          return [x + 0.012 * dx, mid, z + 0.012 * dz];
        };
      if (i > 0) wood.beam(behind(inner), behind(edge(a) - 0.03), 0.02, rise - 0.035);
      // A stringer board under the outer edge, inside the walls.
      const low = [a, ...corners, b].map((t) => at(edge(t) - 0.025, t, y - 0.11));
      for (let k = 0; k + 1 < low.length; k++) wood.beam(low[k], low[k + 1], 0.044, 0.15);
    }
    // The handrail round the well climbs evenly from the lower flight's rail to the upper one's.
    const r = inner + 0.04,
      high = (t: number) => from + rise * (1 + (t / Math.PI) * count) + rule.handrail;
    rails.beam(at(r, a, high(a)), at(r, b, high(b)), 0.05, 0.045);
    const n = fine ? Math.max(1, Math.ceil((r * step) / 0.11)) : 1;
    for (let j = 0; j < n; j++) {
      const t = a + ((j + 0.5) * step) / n,
        [x, , z] = at(r, t, 0);
      box(rails, x - 0.012, x + 0.012, y, high(t), z - 0.012, z + 0.012);
    }
  }
  // Posts under the two outer corners, up to the winder that crosses each.
  for (const [v, corner] of [
    [0.05, Math.PI / 4],
    [breadth - 0.05, (3 * Math.PI) / 4],
  ] as const) {
    const under = from + (Math.floor(corner / step) + 1) * rise - 0.035,
      r = planRect(place, length - 0.1, length, v - 0.045, v + 0.045);
    box(wood, r.x0, r.x1, base, under, r.z0, r.z1);
  }
}

function buildStair(
  parts: Parts,
  plan: StairPlan,
  floors: number[],
  layout: Floor[],
  detail: InteriorOptions['detail'],
) {
  const { place, rule, run, length, breadth, kind } = plan,
    w = rule.width,
    wood = parts.stairs,
    rails = rule.solid ? parts.metalwork : parts.stairs,
    fine = detail !== 'far';
  if (kind === 'spiral') return buildSpiral(wood, rails, plan, floors, layout, fine);
  // A ladder is in the stairs part, so a building that has one has stairs there.
  if (kind === 'ladder') return buildLadder(wood, plan, floors, layout, fine);
  const body = planRect(plan.place, 0, plan.length, 0, plan.breadth),
    p = (u: number, v: number, y: number): V3 => {
      const [x, z] = planPoint(place, u, v);
      return [x, y, z];
    },
    slab = (b: MeshBuilder, u0: number, u1: number, v0: number, v1: number, y0: number, y1: number) => {
      const r = planRect(place, Math.min(u0, u1), Math.max(u0, u1), v0, v1);
      box(b, r.x0, r.x1, y0, y1, r.z0, r.z1);
    };
  const { turn } = plan,
    // The v where the second flight starts.
    other = breadth - w;
  plan.flights.forEach((f, k) => {
    const { rise, tread } = f,
      // Risers of one flight: a winder stair's turn takes its own out of the storey's.
      m = turn ? (f.count - 1 - turn.count) / 2 + 1 : f.count,
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
    if (kind !== 'straight') {
      // The second flight starts from the half landing, or from the last winder.
      const mid = base + (turn ? m - 1 + turn.count : m) * rise;
      if (turn) buildWinders(wood, rails, plan, base, base + (m - 1) * rise, rise, fine);
      else {
        slab(wood, run, length, 0, breadth, mid - (rule.solid ? 0.18 : 0.06), mid);
        for (const v of [0.05, breadth - 0.05])
          slab(wood, length - 0.1, length, v - 0.045, v + 0.045, base, mid - 0.06);
      }
      flight(other, run, -1, mid);
      for (const [v, from, to, y0] of [
        [w - 0.04, 0, run, base],
        [other + 0.04, run, 0, mid],
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
    if (kind !== 'straight') {
      edges.push([p(length, 0, y), p(length, breadth, y)]);
      if (top) edges.push([p(0, 0, y), p(0, w, y)]);
    } else edges.push([p(0, 0, y), p(0, breadth, y)]);
    guardEdges(rails, edges, layout[k], body, rule.guard, fine);
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
  avoid?: StairAvoid,
  clear?: KeepClear,
): Interior {
  const out: Interior = { curtains: [], rooms: [], furniture: [], doorways: [], stairs: [] };
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
    dh = doorHeight(o.style),
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
  // The plan of every floor: partitions on bay lines, doorways through them. A hall takes some partitions down.
  const open = (k: number) => use === 'store' || (k === 0 && o.storefront),
    count = Math.max(1, Math.round((x1 - x0) / ROOM_WIDTH[japan ? 'japan' : 'western'])),
    // Partition lines across `lo` to `hi`: one within 1.2 m of the wall of a block this one joins moves to the nearer
    // clear side, else is left out.
    clearOfJoins = (lines: number[], axis: Opening['axis'], lo: number, hi: number) => {
      const spans = (avoid?.rects ?? [])
          .flatMap((r) => (axis === 'z' ? [r.x0, r.x1] : [r.z0, r.z1]))
          .map((t) => [t - 1.2, t + 1.2]),
        near = (t: number) => spans.find(([a, b]) => t > a + 1e-9 && t < b - 1e-9),
        out = [lo];
      for (const line of lines) {
        const join = near(line),
          at = join
            ? [...join]
                .sort((a, b) => Math.abs(a - line) - Math.abs(b - line))
                .find((t) => !near(t) && t - out[out.length - 1] > 1.2 && hi - t > 1.2)
            : line;
        if (at !== undefined && (!join || at > out[out.length - 1])) out.push(at);
      }
      out.push(hi);
      return out;
    };
  const even: number[] = [x0];
  for (let j = 1; j < count; j++) {
    // A partition on a bay line where one is close, so none stands behind a window.
    const at = x0 + (j * (x1 - x0)) / count,
      snap = -W / 2 + bw * Math.round((at + W / 2) / bw);
    even.push(Math.abs(snap - at) < 0.6 && snap - even[j - 1] > 2.4 && x1 - snap > 2.4 ? snap : at);
  }
  const columnLines = clearOfJoins(even.slice(1), 'z', x0, x1),
    columns = columnLines.length - 1,
    rowLines = clearOfJoins(z1 - z0 > 6 ? [z1 - 0.55 * (z1 - z0)] : [], 'x', z0, z1);
  type Wall = [number, number, number, number, number, number];
  // The longest stretch from `lo` to `hi` of the partition at `line` that no join takes, if a doorway fits in it.
  const shown = (axis: Opening['axis'], line: number, lo: number, hi: number): [number, number] => {
    let out: [number, number] = [lo, hi];
    for (const r of avoid?.hidden ?? []) {
      const [at0, at1, h0, h1] = axis === 'z' ? [r.z0, r.z1, r.x0, r.x1] : [r.x0, r.x1, r.z0, r.z1];
      if (line <= at0 || line >= at1 || h0 >= out[1] || h1 <= out[0]) continue;
      const below = h0 - out[0],
        above = out[1] - h1;
      if (Math.max(below, above) >= dw + 0.1) out = below > above ? [out[0], h0] : [h1, out[1]];
    }
    return out;
  };
  const floorPlan = (fy: number, k: number, walls: Wall[], hall?: Hall): Floor => {
    const cy = ceilingOf(k),
      xs = open(k) ? [x0, x1] : columnLines,
      zs = open(k) ? [z0, z1] : rowLines,
      merge = open(k) ? undefined : hall,
      doors: BuildingDoorway[] = [],
      // Whether the partition left of column `j` in row `r`, or behind the front row in column `i`, stands.
      across = (j: number, r: number) => !(merge && j > merge.i0 && j <= merge.i1 && r >= merge.r0 && r <= merge.r1),
      along = (i: number) => !(merge && merge.r1 > merge.r0 && i >= merge.i0 && i <= merge.i1);
    const openings = holes.filter((h) => h.floor === k).map(span),
      // A partition that would run into an outer door stops 1.2 m short of that wall, leaving an entry.
      intoDoor = (axis: Opening['axis'], plane: number, line: number) =>
        openings.some(
          (s) =>
            s.door &&
            s.axis === axis &&
            Math.abs(s.plane - plane) < 1e-6 &&
            line > s.lo - pt / 2 - 0.05 &&
            line < s.hi + pt / 2 + 0.05,
        ),
      entry = (x: number, z: number, width: number, normal: 'x' | 'z') =>
        doors.push({ floor: k, centre: [x, fy + dh / 2, z], width, height: dh, normal });
    for (let j = 1; j < xs.length - 1; j++)
      for (let r = 0; r + 1 < zs.length; r++) {
        if (!across(j, r)) continue;
        const x = xs[j];
        let za = zs[r] + (r > 0 ? pt / 2 : 0),
          zb = zs[r + 1] - (r + 1 < zs.length - 1 ? pt / 2 : 0);
        if (r === 0 && intoDoor('z', z0, x)) {
          entry(x, za + Math.min(1.2, zb - za) / 2, Math.min(1.2, zb - za), 'x');
          za += 1.2;
        }
        if (r === zs.length - 2 && intoDoor('z', z1, x) && zb > za) {
          entry(x, zb - Math.min(1.2, zb - za) / 2, Math.min(1.2, zb - za), 'x');
          zb -= 1.2;
        }
        // Too short for a door and its jambs: no partition, so no room is shut off.
        if (zb - za < dw + 0.1) continue;
        const [va, vb] = shown('x', x, za, zb),
          d0 = va + Math.min(0.3, (vb - va - dw) / 2),
          d1 = d0 + dw;
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
    if (zs.length === 3) {
      const z = zs[1];
      for (let i = 0; i + 1 < xs.length; i++) {
        if (!along(i)) continue;
        let xa = xs[i] + (i > 0 ? pt / 2 : 0),
          xb = xs[i + 1] - (i + 1 < xs.length - 1 ? pt / 2 : 0);
        if (i === 0 && intoDoor('x', x0, z)) {
          entry(xa + Math.min(1.2, xb - xa) / 2, z, Math.min(1.2, xb - xa), 'z');
          xa += 1.2;
        }
        if (i === xs.length - 2 && intoDoor('x', x1, z) && xb > xa) {
          entry(xb - Math.min(1.2, xb - xa) / 2, z, Math.min(1.2, xb - xa), 'z');
          xb -= 1.2;
        }
        // Too short for a door and its jambs: no partition.
        if (xb - xa < dw + 0.1) continue;
        const [va, vb] = shown('z', z, xa, xb),
          c = (va + vb) / 2;
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
      // The post where partitions meet: each stops half a wall short of the crossing.
      for (let j = 1; j < xs.length - 1; j++)
        if (across(j, 0) || across(j, 1) || along(j - 1) || along(j))
          walls.push([xs[j] - pt / 2, xs[j] + pt / 2, fy, cy, z - pt / 2, z + pt / 2]);
    }
    const floor: Floor = {
      rooms: [],
      at: [],
      doors,
      openings,
      uses: [],
      keep: [],
    };
    for (let i = 0; i + 1 < xs.length; i++)
      for (let r = 0; r + 1 < zs.length; r++) {
        let i1 = i,
          r1 = r;
        if (merge && i >= merge.i0 && i <= merge.i1 && r >= merge.r0 && r <= merge.r1) {
          if (i > merge.i0 || r > merge.r0) continue;
          i1 = merge.i1;
          r1 = merge.r1;
        }
        floor.rooms.push({
          x0: xs[i] + (i > 0 ? pt / 2 : 0),
          x1: xs[i1 + 1] - (i1 + 1 < xs.length - 1 ? pt / 2 : 0),
          z0: zs[r] + (r > 0 ? pt / 2 : 0),
          z1: zs[r1 + 1] - (r1 + 1 < zs.length - 1 ? pt / 2 : 0),
        });
        floor.at.push({ column: i, row: r });
      }
    return floor;
  };
  const planFloors = (walls: Wall[], hall?: Hall) =>
    o.interior !== 'rooms' ? [] : floors.map((fy, k) => floorPlan(fy, k, walls, hall));
  const rule = stairRule(o.style, (x1 - x0) * (z1 - z0));
  let chosen: ReturnType<typeof placeStair>;
  if (o.interior === 'rooms' && o.stairs && floors.length > 1) {
    const find = (keepOut: KeepOut) =>
      placeStair(
        o.style,
        rule,
        floors,
        columns,
        rowLines.length - 1,
        (hall) => planFloors([], hall),
        keepOut,
        o.stairShape === 'winder',
      );
    chosen =
      (avoid?.soft?.length ? find({ ...avoid, rects: [...avoid.rects, ...avoid.soft] }) : undefined) ??
      find(avoid ?? { rects: [] }) ??
      (avoid?.required ? (find({ rects: [], hidden: avoid.hidden }) ?? find({ rects: [] })) : undefined);
  }
  const walls: Wall[] = [],
    layout = planFloors(walls, chosen?.hall),
    plan = chosen?.stair,
    /** The opening in floor `k`, over the flight that arrives there. */
    well = (k: number) => (plan && k > 0 && k < floors.length ? flightRect(plan, k - 1) : undefined);
  // The floors above the first are open over the stair.
  levels.forEach((fy, k) => {
    for (const r of without(all, well(k))) box(m, r.x0, r.x1, fy - SLAB, fy, r.z0, r.z1);
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
  for (const r of clear ?? []) layout[r.floor]?.keep.push(r);
  if (plan) {
    buildStair(parts, plan, floors, layout, o.detail);
    const whole = planRect(plan.place, -plan.before, plan.length + plan.after, 0, plan.breadth);
    for (const f of layout) f.keep.push(whole);
    plan.flights.forEach((flight, k) => {
      const body = flightRect(plan, k),
        [foot, head] = flightEnds(plan, k);
      out.stairs.push({
        floor: k,
        kind: plan.kind,
        min: [body.x0, body.z0],
        max: [body.x1, body.z1],
        foot,
        head,
        risers: flight.count * (plan.kind === 'dog-leg' ? 2 : 1),
        rise: flight.rise,
        tread: flight.tread,
        width: plan.rule.width,
        guard: plan.rule.guard,
        ...(plan.turn && { winders: { count: plan.turn.count, walk: plan.turn.walk, narrow: plan.turn.narrow } }),
      });
    });
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
        for (const q of without(r, well(k))) box(b, q.x0, q.x1, fy + y0, fy + y1, q.z0, q.z1);
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
            normal: V3 = s.axis === 'z' ? [0, 0, sign] : [sign, 0, 0],
            rod = metal.triangles,
            drape = cloth.triangles;
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
          const window = point(middle, (h.y0 + h.y1) / 2, 0);
          out.curtains.push({ part: 'metalwork', from: rod, to: metal.triangles, window });
          out.curtains.push({ part: 'fabric', from: drape, to: cloth.triangles, window });
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
