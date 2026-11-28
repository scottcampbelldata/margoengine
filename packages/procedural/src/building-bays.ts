// Bay windows of the building rules (building-rules.ts): a light bay standing out from a wall over one facade bay of one
// storey, box, canted (sides at 30 or 45 degrees from the wall) or bowed (five flat lights on a circular arc), hung from
// its sill on brackets or carried from the floor (a ground floor one on its own footing, ones above each other joined).
// Inside it opens onto the room through the wall. Internal to @margoengine/procedural; our own code, clean room from:
// - Setagaya City (Tokyo), 4-92-1a, the building area of a bay window (出窓の建築面積の算定), after the Ministry of
//   Construction notice 住指発第115号 (1986): a bay that adds no floor area has its underside at least 30 cm over the
//   floor, stands out less than 50 cm from the outer wall and is window over at least half its elevation seen from the
//   room, https://www.city.setagaya.lg.jp/documents/3826/4-92-1a.pdf. A bay hung from its sill at the default depth
//   keeps all three.
// - Wonka, Wimmer, Sillion and Ribarsky 2003, "Instant Architecture", ACM TOG 22(3),
//   https://doi.org/10.1145/882262.882324, and Mueller, Wonka, Haegler, Ulmer and Van Gool 2006, "Procedural Modeling
//   of Buildings", ACM TOG 25(3), https://doi.org/10.1145/1141911.1141931: a facade tile replaced by a volume that
//   stands out of it and is split into faces and windows by the same rules as the wall.
import type { Hole, Side } from './building-interiors.js';
import { type MeshBuilder, add, scale, sub, unit, type V3 } from './mesh-builder.js';

/** Plan of a bay window. */
export type BuildingBayShape = 'box' | 'canted-30' | 'canted-45' | 'bow';
/** What carries a bay window: brackets under its sill, or the floor run out into it. */
export type BuildingBayFrom = 'sill' | 'floor';

/** A point of a bay's plan: along the wall and out from its face, metres. */
export type PlanPoint = readonly [number, number];

/** A bay to build, in its wall's own terms. */
export interface BayPlan {
  readonly shape: BuildingBayShape;
  readonly from: BuildingBayFrom;
  /** The outer faces, from the left end on the wall to the right end on the wall. */
  readonly outline: readonly PlanPoint[];
  /** How far it stands out from the wall face. */
  readonly depth: number;
  /** Bottom of its walls, floor of its inside, sill and head of its windows, top of its walls (above the ground). */
  readonly base: number;
  readonly ledge: number;
  readonly sill: number;
  readonly head: number;
  readonly top: number;
  /** A little roof on it: false where a bay stands on it. */
  readonly capped: boolean;
  /** Carried to the ground. */
  readonly footing: boolean;
  /** Brackets under it. */
  readonly braced: boolean;
}

/** Wall thickness of a bay, how far its glass sits back, and the solid kept at each end of a face, metres. */
const WALL = 0.08,
  SET = 0.03,
  POST = 0.1,
  /** Depth of the floor under a bay's inside, wall over its windows, and the cap's overhang and rise, metres. */
  UNDER = 0.1,
  OVER = 0.12,
  LIP = 0.03,
  RISE = 0.09,
  /** The narrowest bay and front face, and the shallowest bay, metres. */
  MIN_BAY = 0.9,
  MIN_FRONT = 0.4,
  MIN_DEPTH = 0.15;
/** Height of a bay's cap over its window head at the wall, metres. */
export const CAP_HEIGHT = OVER + LIP + RISE;
/** The cap's fall from the wall to its edge, and how far its edge stands past the bay, metres. */
export const CAP_FALL = RISE,
  CAP_LIP = LIP;

/** The plan of a bay `width` wide starting at `a0` along its wall, or null where none this wide can be made. */
export function bayOutline(
  shape: BuildingBayShape,
  a0: number,
  width: number,
  depth: number,
): { outline: PlanPoint[]; depth: number } | null {
  if (width < MIN_BAY - 1e-9) return null;
  const a1 = a0 + width;
  let p = depth;
  if (shape === 'bow') {
    p = Math.min(p, width / 2);
    const r = ((width * width) / 4 + p * p) / (2 * p),
      half = Math.asin(Math.min(1, width / 2 / r)),
      outline: PlanPoint[] = [];
    for (let i = 0; i <= 5; i++) {
      const t = half * ((2 * i) / 5 - 1);
      outline.push(i === 0 ? [a0, 0] : i === 5 ? [a1, 0] : [a0 + width / 2 + r * Math.sin(t), p - r + r * Math.cos(t)]);
    }
    return { outline, depth: Math.max(...outline.map((q) => q[1])) };
  }
  // Canted sides run `p / tan` along the wall each; a narrow bay stands out less, to keep its front.
  const tan = shape === 'canted-30' ? Math.tan(Math.PI / 6) : shape === 'canted-45' ? 1 : Infinity;
  p = Math.min(p, ((width - MIN_FRONT) / 2) * tan);
  if (p < MIN_DEPTH - 1e-9) return null;
  const run = p / tan;
  return {
    outline: [
      [a0, 0],
      [a0 + run, p],
      [a1 - run, p],
      [a1, 0],
    ],
    depth: p,
  };
}

/** The outline moved `by` metres into the bay (negative: out of it), its ends staying on the wall. */
export function insetOutline(outline: readonly PlanPoint[], by: number): PlanPoint[] {
  const lines = outline.slice(1).map((q, i) => {
      const p = outline[i],
        len = Math.hypot(q[0] - p[0], q[1] - p[1]),
        // The outward normal of a face of an outline running left to right and bulging out.
        n: PlanPoint = [-(q[1] - p[1]) / len, (q[0] - p[0]) / len];
      return { n, c: n[0] * p[0] + n[1] * p[1] - by };
    }),
    first = lines[0],
    last = lines[lines.length - 1];
  const out: PlanPoint[] = [[first.c / first.n[0], 0]];
  for (let i = 1; i < lines.length; i++) {
    const u = lines[i - 1],
      v = lines[i],
      det = u.n[0] * v.n[1] - u.n[1] * v.n[0];
    out.push([(u.c * v.n[1] - u.n[1] * v.c) / det, (u.n[0] * v.c - u.c * v.n[0]) / det]);
  }
  out.push([last.c / last.n[0], 0]);
  return out;
}

/** The options bays are placed by (building-rules.ts), resolved. */
export interface BayOptions {
  readonly width: number;
  readonly storeys: readonly number[];
  readonly roof: string;
  readonly pitch: number;
  readonly ridge: 'auto' | 'x' | 'z';
  readonly depth: number;
  readonly overhang: number;
  readonly parapet: number;
  readonly gutters: boolean;
  readonly bayWidth: number;
  readonly window: readonly [number, number];
  readonly sill: number;
  readonly windowKind: string;
  readonly porch: number;
  readonly porchWidth: number;
  readonly balcony: number;
  readonly balconyFloor: number;
  readonly balconyWidth: number;
  readonly bayWindows: readonly number[];
  readonly bayWindowSides: readonly number[];
  readonly bayWindowFloors: readonly number[];
  readonly bayWindowShape: BuildingBayShape;
  readonly bayWindowDepth: number;
  readonly bayWindowFrom: BuildingBayFrom;
}

/** Whether the volume in front of a wall (along it, up, and `depth` out) is free of a joined plan's other blocks. */
export type BayClear = (side: Side, a0: number, a1: number, y0: number, y1: number, depth: number) => boolean;

/**
 * Puts the bays asked for into `holes`, each in place of the windows of its facade bay and floor. A bay is not made on a
 * door, shop or balcony door, across a balcony, where it would not keep a window 0.5 m high or a front 0.4 m wide, or
 * where `clear` says another block stands. Under a porch roof an upper bay hangs from its sill.
 */
export function placeBays(
  o: BayOptions,
  sides: readonly Side[],
  holes: Hole[],
  floors: readonly number[],
  clear?: BayClear,
): void {
  if (!o.bayWindows.length) return;
  const count = o.storeys.length,
    eaves = floors[count - 1] + o.storeys[count - 1],
    balconied = o.balcony > 0 && o.balconyFloor < count,
    balcony = (o.width * o.balconyWidth) / 2,
    // Whether the roof comes down over a side: a gable's two long eaves, every side of the other pitched roofs.
    swap = o.ridge === 'auto' ? o.width < o.depth : o.ridge === 'z',
    eaved = (side: number) => o.roof !== 'flat' && (o.roof !== 'gable' || side % 2 === (swap ? 1 : 0));
  for (const si of new Set(o.bayWindowSides)) {
    const side = sides[si],
      slots = Math.max(1, Math.round(side.length / o.bayWidth)),
      bw = side.length / slots,
      asked = new Set(o.bayWindows.map((d) => (d < 0 ? Math.floor((slots - 1) / 2) : Math.min(d, slots - 1))));
    for (const j of asked) {
      const made = new Map<number, BayPlan>();
      // From the top down, so a bay knows whether one stands on it.
      for (let k = count - 1; k >= 0; k--) {
        if (o.bayWindowFloors.length && !o.bayWindowFloors.includes(k)) continue;
        const inSlot = (h: Hole) => h.side === si && h.floor === k && Math.floor((h.a0 + h.a1) / 2 / bw) === j;
        if (holes.some((h) => inSlot(h) && h.kind !== 'window')) continue;
        const fy = floors[k],
          h = o.storeys[k],
          c = bw * (j + 0.5),
          width = o.windowKind === 'strip' ? bw - 0.4 : Math.min(bw - 0.4, Math.max(o.window[0], 1.8)),
          // The side's middle is the building's, so this is the bay's near edge from the middle of the front.
          near = Math.abs(c - side.length / 2) - width / 2;
        if (si === 0 && balconied && k === o.balconyFloor && near < balcony) continue;
        const porched = si === 0 && o.porch > 0 && k === 1 && near < (o.width * o.porchWidth) / 2 + 0.15,
          from = porched ? 'sill' : o.bayWindowFrom,
          rise = Math.max(from === 'sill' ? 0.3 : 0, porched ? 0.45 : 0, Math.min(o.sill, h - 0.9)),
          sill = fy + rise,
          shape = bayOutline(o.bayWindowShape, c - width / 2, width, o.bayWindowDepth);
        if (!shape) continue;
        let head = fy + Math.min(rise + o.window[1], h - 0.35);
        // A balcony's slab over it.
        if (si === 0 && balconied && k === o.balconyFloor - 1 && near < balcony)
          head = Math.min(head, floors[k + 1] - 0.18 - CAP_HEIGHT);
        if (k === count - 1) {
          if (eaved(si)) {
            // The cap stays under the eaves, whose underside falls with the pitch as far out as the overhang.
            const reach = shape.depth + CAP_LIP,
              x = Math.min(o.overhang, reach),
              gutter = o.gutters && o.overhang <= reach ? 0.17 : 0.05;
            head = Math.min(
              head,
              eaves - x * Math.tan((o.pitch * Math.PI) / 180) - gutter - CAP_HEIGHT + (CAP_FALL * x) / reach,
            );
          } else if (o.roof === 'flat' && o.parapet === 0 && o.overhang > 0) head = Math.min(head, eaves - 0.45);
        }
        if (head - sill < 0.5 - 1e-9) continue;
        const base = from === 'sill' ? sill - UNDER : fy - UNDER - 0.05,
          above = made.get(k + 1),
          stacked = from === 'floor' && above?.from === 'floor',
          footing = from === 'floor' && k === 0,
          plan: BayPlan = {
            shape: o.bayWindowShape,
            from,
            outline: shape.outline,
            depth: shape.depth,
            base,
            ledge: from === 'sill' ? sill : fy,
            sill,
            head,
            top: stacked ? above.base : head + OVER,
            capped: !stacked,
            footing,
            braced: !footing && !porched && base - 0.3 > 0.05,
          },
          first = shape.outline[0][0],
          last = shape.outline[shape.outline.length - 1][0];
        if (
          clear &&
          !clear(
            side,
            first - CAP_LIP,
            last + CAP_LIP,
            footing ? 0.05 : Math.max(0.05, base - (plan.braced ? 0.3 : 0)),
            plan.capped ? head + CAP_HEIGHT : plan.top,
            shape.depth + CAP_LIP,
          )
        )
          continue;
        made.set(k, plan);
      }
      for (const [k, plan] of made) {
        // A bay standing on one below needs no brackets.
        const bay = plan.from === 'floor' && made.get(k - 1)?.from === 'floor' ? { ...plan, braced: false } : plan,
          mouth = insetOutline(bay.outline, WALL),
          at = holes.findIndex((h) => h.side === si && h.floor === k && Math.floor((h.a0 + h.a1) / 2 / bw) === j),
          hole: Hole = {
            kind: 'window',
            side: si,
            floor: k,
            a0: mouth[0][0],
            a1: mouth[mouth.length - 1][0],
            y0: bay.ledge,
            y1: bay.head,
            bay,
          };
        if (at < 0) holes.push(hole);
        else holes[at] = hole;
      }
    }
  }
}

/** What a bay's builder needs of the building around it. */
export interface BayContext {
  readonly walls: MeshBuilder;
  readonly interior: MeshBuilder;
  readonly trim: MeshBuilder;
  readonly roof: MeshBuilder;
  readonly glass: MeshBuilder;
  readonly base: MeshBuilder;
  /** Frames, sills and boards are drawn (not at `far` detail). */
  readonly detail: boolean;
  /** A piece of the outer face of one of the bay's faces, clad as the walls are. */
  clad(face: Side, a0: number, a1: number, y0: number, y1: number): void;
  /** The frame and sashes of a light, its glass `inset` behind the face. */
  frame(face: Side, light: Hole, inset: number): void;
}

/** A light of a bay: the face it is in and its span along it. */
export interface BayLight {
  readonly face: Side;
  readonly a0: number;
  readonly a1: number;
}

/** Builds a bay on `side` (local), the wall opening behind it being the hole's, and returns its lights. */
export function buildBay(ctx: BayContext, side: Side, hole: Hole, bay: BayPlan): BayLight[] {
  const at = (s: Side, a: number, y: number, off = 0): V3 => [
      s.start[0] + s.dir[0] * a + s.out[0] * off,
      y,
      s.start[2] + s.dir[2] * a + s.out[2] * off,
    ],
    point = (q: PlanPoint, y: number) => at(side, q[0], y, q[1]),
    up: V3 = [0, 1, 0],
    inner = insetOutline(bay.outline, WALL),
    lights: BayLight[] = [];
  for (let i = 0; i + 1 < bay.outline.length; i++) {
    const p = point(bay.outline[i], 0),
      q = point(bay.outline[i + 1], 0),
      run = sub(q, p),
      length = Math.hypot(run[0], run[2]),
      dir = unit(run),
      face: Side = { start: p, dir, out: [-dir[2], 0, dir[0]], length },
      along = (r: PlanPoint) => {
        const v = sub(point(r, 0), p);
        return v[0] * dir[0] + v[2] * dir[2];
      },
      i0 = along(inner[i]),
      i1 = along(inner[i + 1]),
      w0 = Math.max(POST, i0 + 0.02),
      w1 = Math.min(length - POST, i1 - 0.02),
      glazed = w1 - w0 >= 0.15 - 1e-6,
      lining = (a0: number, a1: number, y0: number, y1: number) => {
        if (a1 - a0 > 1e-6 && y1 - y0 > 1e-6)
          ctx.interior.poly(
            [at(face, a0, y0, -WALL), at(face, a1, y0, -WALL), at(face, a1, y1, -WALL), at(face, a0, y1, -WALL)],
            scale(face.out, -1),
          );
      };
    if (!glazed) {
      ctx.clad(face, 0, length, bay.base, bay.top);
      lining(i0, i1, bay.ledge, bay.head);
      continue;
    }
    ctx.clad(face, 0, length, bay.base, bay.sill);
    ctx.clad(face, 0, length, bay.head, bay.top);
    ctx.clad(face, 0, w0, bay.sill, bay.head);
    ctx.clad(face, w1, length, bay.sill, bay.head);
    lining(i0, i1, bay.ledge, bay.sill);
    lining(i0, w0, bay.sill, bay.head);
    lining(w1, i1, bay.sill, bay.head);
    // The reveals of the light through the bay's wall.
    const back = (v: V3) => add(v, scale(face.out, -WALL)),
      L0 = at(face, w0, bay.sill),
      L1 = at(face, w0, bay.head),
      R0 = at(face, w1, bay.sill),
      R1 = at(face, w1, bay.head);
    ctx.walls.poly([L0, L1, back(L1), back(L0)], dir);
    ctx.walls.poly([R0, R1, back(R1), back(R0)], scale(dir, -1));
    ctx.walls.poly([L1, R1, back(R1), back(L1)], [0, -1, 0]);
    // A light down to the bay's floor has no sill to reveal.
    if (bay.sill - bay.ledge > 1e-6) ctx.walls.poly([L0, R0, back(R0), back(L0)], up);
    else ctx.interior.poly([L0, R0, back(R0), back(L0)], up);
    ctx.glass.poly(
      [
        at(face, w0, bay.sill, -SET),
        at(face, w1, bay.sill, -SET),
        at(face, w1, bay.head, -SET),
        at(face, w0, bay.head, -SET),
      ],
      face.out,
    );
    if (ctx.detail) {
      ctx.frame(face, { ...hole, a0: w0, a1: w1, y0: bay.sill, y1: bay.head }, SET);
      for (const y of [bay.sill - 0.025, bay.head + 0.025])
        ctx.trim.box(at(face, length / 2, y, 0.012), [length / 2, 0.025, 0.012], dir, up, face.out);
    }
    lights.push({ face, a0: w0, a1: w1 });
  }
  // The floor and ceiling inside, and the underside.
  ctx.interior.poly(
    inner.map((q) => point(q, bay.ledge)),
    up,
  );
  ctx.interior.poly(
    inner.map((q) => point(q, bay.head)),
    [0, -1, 0],
  );
  if (bay.footing)
    ctx.base.column(
      bay.outline.map((q) => point(q, bay.base)),
      -0.3,
    );
  else
    ctx.walls.poly(
      bay.outline.map((q) => point(q, bay.base)),
      [0, -1, 0],
    );
  if (bay.capped) {
    const over = insetOutline(bay.outline, -LIP),
      deepest = Math.max(...over.map((q) => q[1]));
    ctx.roof.column(
      over.map((q) => point(q, bay.top + LIP + RISE * (1 - q[1] / deepest))),
      bay.top,
    );
  }
  if (ctx.detail)
    for (const q of bay.outline.slice(1, -1)) {
      const [x, , z] = point(q, 0);
      ctx.trim.box([x, (bay.base + bay.top) / 2, z], [0.025, (bay.top - bay.base) / 2, 0.025], side.dir, up, side.out);
    }
  if (ctx.detail && bay.braced) {
    const a0 = bay.outline[0][0],
      width = bay.outline[bay.outline.length - 1][0] - a0;
    for (const u of [0.25, 0.75]) {
      const a = a0 + width * u,
        reach = bay.depth * 0.7;
      ctx.trim.beam(at(side, a, bay.base - 0.28, 0.025), at(side, a, bay.base - 0.03, reach), 0.06, 0.07);
      ctx.trim.box(at(side, a, bay.base - 0.17, 0.025), [0.04, 0.17, 0.025], side.dir, up, side.out);
    }
  }
  return lights;
}
