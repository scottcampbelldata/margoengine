// Where two blocks of a joined plan have floors at different levels (building-plans.ts): a change of one riser stays an
// open step; a larger one is walled, with a doorway and a flight of steps wherever one fits with headroom, so no floor
// ends in an open ledge and no change of level is left without a way up. Internal to @margoengine/procedural; our own
// code, clean room from:
// - International Residential Code 2021: R311.7 (stair at least 36 in wide, riser at most 7 3/4 in, tread at least
//   10 in, headroom 6 ft 8 in), R311.7.6 (a landing at the top and bottom as wide as the stair), R311.7.8 (a handrail
//   from four risers), R312.1.1 (a guard where the side is more than 30 in above the floor).
// - Japan: Building Standard Law Enforcement Order art. 23 (riser at most 23 cm, tread at least 15 cm, 75 cm wide).
// - Lopes, R., Tutenel, T., Smelik, R. M., de Kraker, K. J., Bidarra, R. 2010, "A constrained growth method for
//   procedural floor plan generation", Proc. GAME-ON 2010, https://graphics.tudelft.nl/~rafa/myPapers/bidarra.GAMEON10.pdf:
//   every room of a generated plan, on every floor, must be reachable, repaired where it is not.
import type { Building, BuildingDoorway, BuildingStyle } from './building-rules.js';
import { doorHeight, railing, SLAB, stairRule } from './building-interiors.js';
import { MeshBuilder, type V3 } from './mesh-builder.js';

/**
 * A flight of steps through the join of two blocks whose floors differ, in plan-local metres: from `foot` on the lower
 * floor (height `from`) to `head` on the upper one (`to`).
 */
export interface BuildingJoinStep {
  /** Floor index of the lower floor in its own block. */
  readonly floor: number;
  readonly from: number;
  readonly to: number;
  /** The flight's footprint `[x, z]`. */
  readonly min: readonly [number, number];
  readonly max: readonly [number, number];
  readonly foot: readonly [number, number];
  readonly head: readonly [number, number];
  /** Risers of height `rise`; one tread of depth `tread` fewer, the upper floor being the last. */
  readonly risers: number;
  readonly rise: number;
  readonly tread: number;
  readonly width: number;
  /** Sunk into the upper floor (two ground floors, where the lower one's ceiling is too low to climb under). */
  readonly sunken: boolean;
}
/** A block as the joins see it: where it stands, and whether its inside comes before another's (a lower rank). */
export interface JoinBlock {
  readonly building: Building;
  readonly at: V3;
  readonly turn: number;
  readonly rank: number;
}
export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
export interface Joins {
  /**
   * Walls and risers along the joins (`interior`), each of the block `first`, whose inside comes before the other's;
   * the steps (`stairs`) and their rails (`metalwork` or `stairs`).
   */
  readonly walls: readonly { first: number; mesh: MeshBuilder }[];
  readonly steps: MeshBuilder;
  readonly rails: MeshBuilder;
  /** Wells sunk into a ground floor, in plan terms: cut from block `block`'s floor and base. */
  readonly wells: readonly { block: number; min: V3; max: V3 }[];
  readonly joinSteps: readonly BuildingJoinStep[];
  readonly doorways: readonly BuildingDoorway[];
  /** Floor each block's furniture keeps off, in plan terms. */
  readonly keep: readonly { block: number; floor: number; rect: Rect }[];
  /** Pairs of blocks with a way between them on foot. */
  readonly linked: readonly (readonly [number, number])[];
}

const WALL = 0.04;
const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
const within = (a: Rect, b: Rect) =>
  a.x0 >= b.x0 - 1e-6 && a.x1 <= b.x1 + 1e-6 && a.z0 >= b.z0 - 1e-6 && a.z1 <= b.z1 + 1e-6;
const span = (x0: number, x1: number, z0: number, z1: number): Rect => ({
  x0: Math.min(x0, x1),
  x1: Math.max(x0, x1),
  z0: Math.min(z0, z1),
  z1: Math.max(z0, z1),
});

/** One block in plan terms. */
function frame(q: JoinBlock) {
  const b = q.building,
    yaw = (q.turn * Math.PI) / 2,
    c = Math.round(Math.cos(yaw)),
    s = Math.round(Math.sin(yaw)),
    point = (x: number, z: number): [number, number] => [q.at[0] + x * c + z * s, q.at[2] - x * s + z * c],
    rect = (x0: number, z0: number, x1: number, z1: number) => {
      const a = point(x0, z0),
        e = point(x1, z1);
      return span(a[0], e[0], a[1], e[1]);
    },
    W = b.options.width / 2 - b.options.wall,
    D = b.options.depth / 2 - b.options.wall,
    floors = b.floors.map((y, k) => ({ y, top: (b.floors[k + 1] ?? b.eaves) - SLAB }));
  return {
    point,
    rect,
    inner: rect(-W, -D, W, D),
    outer: rect(-W - b.options.wall, -D - b.options.wall, W + b.options.wall, D + b.options.wall),
    floors,
    eaves: b.eaves,
    rooms: b.rooms.map((r) => ({ floor: r.floor, rect: rect(r.min[0], r.min[1], r.max[0], r.max[1]) })),
  };
}
type Frame = ReturnType<typeof frame>;

/**
 * What stands on floor `k` of block `i`: its stairs and their wells (`solid`), which neither steps nor a landing may
 * take, and the floor a walker needs free (`clear`: stair ends, doorways but those cut away inside a block that comes
 * first, outer doors), which a landing may share and steps may not.
 */
function obstacles(blocks: readonly JoinBlock[], frames: readonly Frame[], i: number, k: number) {
  const q = blocks[i],
    f = frames[i],
    b = q.building,
    solid: Rect[] = [],
    out: Rect[] = [];
  for (const s of b.stairs) {
    if (s.floor !== k && s.floor !== k - 1) continue;
    solid.push(f.rect(s.min[0], s.min[1], s.max[0], s.max[1]));
    const r = s.width / 2;
    for (const [x, z] of [s.foot, s.head]) out.push(f.rect(x - r, z - r, x + r, z + r));
  }
  for (const d of b.doorways) {
    if (d.floor !== k) continue;
    const [x, , z] = d.centre,
      [px, pz] = f.point(x, z),
      [ex, ez] = d.normal === 'x' ? [0.9, d.width / 2] : [d.width / 2, 0.9],
      here = span(px, px, pz, pz),
      gone = blocks.some((other, n) => other.rank < q.rank && within(here, frames[n].inner));
    if (!gone) out.push(f.rect(x - ex, z - ez, x + ex, z + ez));
  }
  for (const o of b.openings) {
    if (o.kind !== 'door' || o.floor !== k) continue;
    // Block openings are in plan terms already; one inside another block is gone with its wall.
    const [x, , z] = o.centre,
      here = span(x, x, z, z);
    if (frames.some((other, n) => n !== i && within(here, other.outer))) continue;
    // 1.2 m stays free in front of a door.
    const alongX = Math.min(Math.abs(z - f.outer.z0), Math.abs(z - f.outer.z1)) < 0.01,
      [ex, ez] = alongX ? [o.width / 2, 1.2] : [1.2, o.width / 2];
    out.push(span(x - ex, x + ex, z - ez, z + ez));
  }
  return { solid, clear: out };
}

/** A side of an inner floor that runs through another's: the plane, which way is out, and the run along it. */
interface Face {
  readonly axis: 'x' | 'z';
  readonly at: number;
  readonly out: 1 | -1;
  readonly t0: number;
  readonly t1: number;
}
function faces(first: Rect, other: Rect): Face[] {
  const out: Face[] = [];
  for (const axis of ['x', 'z'] as const) {
    const along: 'x' | 'z' = axis === 'x' ? 'z' : 'x',
      t0 = Math.max(first[`${along}0`], other[`${along}0`]),
      t1 = Math.min(first[`${along}1`], other[`${along}1`]);
    if (t1 - t0 < 0.01) continue;
    for (const side of [1, -1] as const) {
      const at = side > 0 ? first[`${axis}1`] : first[`${axis}0`];
      if (at > other[`${axis}0`] + 0.01 && at < other[`${axis}1`] - 0.01) out.push({ axis, at, out: side, t0, t1 });
    }
  }
  return out.sort((a, b) => b.t1 - b.t0 - (a.t1 - a.t0));
}
/** The rectangle from `u0` to `u1` metres out of a face (negative: inward) and `s0` to `s1` along it. */
const onFace = (f: Face, u0: number, u1: number, s0: number, s1: number): Rect => {
  const a = f.at + f.out * u0,
    b = f.at + f.out * u1;
  return f.axis === 'x' ? span(a, b, s0, s1) : span(s0, s1, a, b);
};

interface Area {
  s0: number;
  s1: number;
  y0: number;
  y1: number;
}
/** `all` less each hole, as rectangles. */
function remainder(all: Area, holes: readonly Area[]): Area[] {
  let out = [all];
  for (const h of holes)
    out = out.flatMap((a) => {
      if (!(h.s0 < a.s1 && h.s1 > a.s0 && h.y0 < a.y1 && h.y1 > a.y0)) return [a];
      const s0 = Math.max(a.s0, h.s0),
        s1 = Math.min(a.s1, h.s1);
      return [
        { ...a, s1: s0 },
        { ...a, s0: s1 },
        { s0, s1, y0: a.y0, y1: h.y0 },
        { s0, s1, y0: h.y1, y1: a.y1 },
      ].filter((r) => r.s1 - r.s0 > 1e-6 && r.y1 - r.y0 > 1e-6);
    });
  return out;
}

/** Walls, doorways and steps for every two blocks whose floors do not run level where they meet. */
export function planJoins(blocks: readonly JoinBlock[], style: BuildingStyle): Joins {
  const frames = blocks.map(frame),
    walls: { first: number; mesh: MeshBuilder }[] = [],
    steps = new MeshBuilder(),
    metal = new MeshBuilder(),
    wells: { block: number; min: V3; max: V3 }[] = [],
    joinSteps: BuildingJoinStep[] = [],
    doorways: BuildingDoorway[] = [],
    keep: { block: number; floor: number; rect: Rect }[] = [],
    linked: [number, number][] = [],
    // Floor taken by flights already placed, with the heights they take.
    taken: { rect: Rect; y0: number; y1: number }[] = [],
    head = doorHeight(style),
    box = (b: MeshBuilder, r: Rect, y0: number, y1: number) => {
      if (r.x1 - r.x0 > 1e-6 && y1 - y0 > 1e-6 && r.z1 - r.z0 > 1e-6)
        b.box(
          [(r.x0 + r.x1) / 2, (y0 + y1) / 2, (r.z0 + r.z1) / 2],
          [(r.x1 - r.x0) / 2, (y1 - y0) / 2, (r.z1 - r.z0) / 2],
        );
    };
  for (let p = 0; p < blocks.length; p++)
    for (let q = p + 1; q < blocks.length; q++) {
      // `i` comes first indoors: its floors run to its walls' inside faces and the other's stop there.
      const [i, j] = blocks[p].rank <= blocks[q].rank ? [p, q] : [q, p],
        F = frames[i],
        O = frames[j];
      if (!overlaps(F.inner, O.inner)) continue;
      const pairs = F.floors.flatMap((a, ka) =>
        O.floors.flatMap((b, kb) => {
          const lo = Math.max(a.y, b.y),
            hi = Math.min(a.top, b.top);
          // Over the lower ceiling its slab still stands where the other block has a room.
          return hi + SLAB - lo > 0.01 ? [{ ka, kb, a, b, lo, hi, step: Math.abs(a.y - b.y) }] : [];
        }),
      );
      // Level throughout: the blocks are one space on each floor, as built.
      if (pairs.every((v) => v.step < 0.01)) {
        if (pairs.length) linked.push([i, j]);
        continue;
      }
      const runs = faces(F.inner, O.inner),
        holes: Area[][] = runs.map(() => []),
        rule = stairRule(style, (F.inner.x1 - F.inner.x0) * (F.inner.z1 - F.inner.z0)),
        rails = rule.solid ? metal : steps;
      for (const v of pairs) {
        if (v.step <= rule.maxRise) {
          if (v.hi > v.lo) runs.forEach((f, n) => holes[n].push({ s0: f.t0, s1: f.t1, y0: v.lo, y1: v.hi }));
          if (v.hi - v.lo >= 1.5) linked.push([i, j]);
          continue;
        }
        const low = Math.min(v.a.y, v.b.y),
          high = v.lo,
          lowerIsFirst = v.a.y < v.b.y,
          [lowBlock, lowFloor, highBlock, highFloor] = lowerIsFirst ? [i, v.ka, j, v.kb] : [j, v.kb, i, v.ka],
          risers = Math.ceil(v.step / rule.maxRise - 1e-9),
          rise = v.step / risers,
          run = (risers - 1) * rule.minTread,
          w = rule.width,
          landing = Math.max(0.8, w),
          // On the lower floor, climbing to the join; or, between two ground floors, sunk into the higher one, the first
          // tread then passing under the head of the doorway.
          higher = lowerIsFirst ? v.b : v.a,
          ways = [
            ...(v.hi - high >= head ? [false] : []),
            ...(v.ka === 0 && v.kb === 0 && v.hi - low - rise >= head && higher.top - high >= head ? [true] : []),
          ];
        let placed = false;
        for (const sunken of ways) {
          for (let n = 0; n < runs.length && !placed; n++) {
            const f = runs[n],
              // Which way the flight leads from the join, along the face's outward direction.
              toLow = lowerIsFirst ? -1 : 1,
              d = sunken ? -toLow : toLow,
              room = f.t1 - f.t0 - w - 0.1;
            if (room < 0) continue;
            const count = Math.floor(room / 0.1);
            for (let c = 0; c <= count && !placed; c++) {
              // From the middle of the run outward.
              const s0 = f.t0 + 0.05 + room / 2 + (c % 2 ? 1 : -1) * Math.ceil(c / 2) * 0.1;
              if (s0 < f.t0 + 0.05 - 1e-6 || s0 + w > f.t1 - 0.05 + 1e-6) continue;
              const s1 = s0 + w,
                body = onFace(f, 0, d * run, s0, s1),
                // The landing at the join, on the side away from the flight.
                near = onFace(f, 0, -d * landing, s0, s1),
                onFlight = sunken ? highBlock : lowBlock,
                onFlightFloor = sunken ? highFloor : lowFloor,
                across = sunken ? lowBlock : highBlock,
                acrossFloor = sunken ? lowFloor : highFloor,
                long = onFace(f, 0, d * (run + landing), s0, s1),
                holds = (block: number, floor: number, r: Rect) =>
                  frames[block].rooms.some((m) => m.floor === floor && within(r, m.rect)),
                clear = (block: number, floor: number, r: Rect, steps?: Rect) => {
                  const o = obstacles(blocks, frames, block, floor);
                  return !o.solid.some((m) => overlaps(r, m)) && !(steps && o.clear.some((m) => overlaps(steps, m)));
                },
                whole = onFace(f, -d * landing, d * (run + landing), s0, s1),
                y1 = (sunken ? low : high) + head;
              if (!holds(onFlight, onFlightFloor, long) || !holds(across, acrossFloor, near)) continue;
              if (!clear(onFlight, onFlightFloor, long, body) || !clear(across, acrossFloor, near)) continue;
              if (taken.some((t) => t.y0 < y1 && t.y1 > low && overlaps(t.rect, whole))) continue;
              placed = true;
              taken.push({ rect: whole, y0: low, y1 });
              keep.push(
                { block: onFlight, floor: onFlightFloor, rect: long },
                { block: across, floor: acrossFloor, rect: near },
              );
              for (let r = 1; r < risers; r++) {
                const tread = onFace(f, d * (r - 1) * rule.minTread, d * r * rule.minTread, s0, s1);
                if (sunken) box(steps, tread, low - 0.15, low + r * rise);
                else box(steps, tread, low - 0.01, high - r * rise);
              }
              const guarded = v.step > 0.76;
              if (sunken) {
                // The well: its last riser under the floor's edge and a cheek each side.
                box(steps, onFace(f, d * run, d * (run + 0.02), s0, s1), high - rise - 0.01, high - 0.002);
                for (const [a, b] of [
                  [s0 - 0.03, s0],
                  [s1, s1 + 0.03],
                ])
                  box(steps, onFace(f, 0, d * run, a, b), low - 0.15, high - 0.002);
                wells.push({
                  block: highBlock,
                  min: [body.x0, low - SLAB - 0.4, body.z0],
                  max: [body.x1, high + 0.01, body.z1],
                });
              }
              const mid = (s0 + s1) / 2,
                end = (u: number): [number, number] => {
                  const r = onFace(f, u, u, mid, mid);
                  return [r.x0, r.z0];
                },
                // The ends: before the flight, past the join, and past its far end.
                before = end(-d * 0.35),
                after = end(d * (run + 0.35)),
                // A point `u` along the flight, `s` across it, at height `y`.
                at = (u: number, s: number, y: number): V3 => {
                  const r = onFace(f, d * u, d * u, s, s);
                  return [r.x0, y, r.z0];
                },
                // The flight climbs away from the join where it is sunk, and to the join where it is not.
                [bottomAt, topAt] = sunken ? [0, run] : [run, 0],
                sloped = (s: number, height: number) =>
                  railing(rails, at(bottomAt, s, low + rise), at(topAt, s, high), height, true, low, high - rise);
              // A guard where a side is open more than 30 in above the floor, a handrail from four risers.
              if (guarded)
                for (const s of sunken ? [s0 - 0.015, s1 + 0.015] : [s0 + 0.03, s1 - 0.03])
                  if (sunken) railing(rails, at(0, s, high), at(run, s, high), rule.guard, true);
                  else sloped(s, rule.guard);
              if (risers >= 4 && (sunken || !guarded)) sloped(s0 + 0.03, rule.handrail);
              const y0 = sunken ? low : high,
                h = Math.min(head + (sunken ? rise : 0), v.hi - y0);
              holes[n].push({ s0, s1, y0, y1: y0 + h });
              const [cx, cz] = end(0);
              doorways.push({
                floor: highFloor,
                centre: [cx, y0 + h / 2, cz],
                width: w,
                height: h,
                normal: f.axis,
              });
              joinSteps.push({
                floor: lowFloor,
                from: low,
                to: high,
                min: [body.x0, body.z0],
                max: [body.x1, body.z1],
                foot: sunken ? before : after,
                head: sunken ? after : before,
                risers,
                rise,
                tread: rule.minTread,
                width: w,
                sunken,
              });
              linked.push([i, j]);
            }
          }
          if (placed) break;
        }
      }
      // Wall off everything else the two share: the faces under the higher floors and every ledge.
      // A floor below the other block's eaves was cut at the join, so its wall runs to its own ceiling, even where that
      // is up in the other block's roof.
      const bottom = Math.min(F.floors[0].y, O.floors[0].y),
        cutOff = (a: Frame, b: Frame) => a.floors.filter((q) => q.y < b.eaves).map((q) => q.top + SLAB),
        top = Math.max(0, ...cutOff(F, O), ...cutOff(O, F));
      const mesh = new MeshBuilder();
      runs.forEach((f, n) => {
        for (const a of remainder({ s0: f.t0, s1: f.t1, y0: bottom, y1: top }, holes[n]))
          box(mesh, onFace(f, -WALL / 2, WALL / 2, a.s0, a.s1), a.y0, a.y1);
      });
      if (mesh.triangles) walls.push({ first: i, mesh });
    }
  return { walls, steps, rails: metal, wells, joinSteps, doorways, keep, linked };
}
