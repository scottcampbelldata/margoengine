// Buildings on L, T, U and cross plans, wings joined into one building, dormers and corner towers, built from the
// building rules (procedural/building-rules) and joined where they meet: every part of one block that lies inside
// another block's solid (the space under its roof, or its roof slab past the walls) is cut away, triangle by triangle,
// so roofs meet in valleys along the line where their planes cross, walls open into each other at the junction, and
// nothing hidden is left to draw. The roof of the whole is the upper envelope of the blocks' roofs: a valley is where
// that envelope folds up, a hip where one block's own roof folds down. Seeded, deterministic; local origin on the
// ground under the main block, +z its front, metres.
// Clean room from public descriptions, no other engine's code:
// - Aichholzer, O., Aurenhammer, F., Alberts, D., Gaertner, B. 1995, "A novel type of skeleton for polygons",
//   J. Universal Computer Science 1(12): equal pitch roofs over a polygon as its straight skeleton; on a rectilinear
//   plan the skeleton of an L or T is the upper envelope of its two rectangles' hip roofs, which this builds.
// - Kelly, T., Wonka, P. 2011, "Interactive architectural modeling with procedural extrusions", ACM TOG 30(2),
//   https://doi.org/10.1145/1944846.1944854: roofs of joined masses, valleys and hips from plane intersections.
// - Mueller, P., Wonka, P., Haegler, S., Ulmer, A., Van Gool, L. 2006, "Procedural modeling of buildings",
//   ACM TOG 25(3), https://doi.org/10.1145/1141911.1141931: mass models as unions of volumes with occlusion queries.
// - Sutherland, I. E., Hodgman, G. W. 1974, "Reentrant polygon clipping", CACM 17(1),
//   https://doi.org/10.1145/360767.360802: clipping each polygon by the planes of a convex solid.
// - The framing square's hip and valley table (e.g. Wagner, W. H. 1983, "Modern Carpentry", Goodheart-Willcox): a valley
//   between equal pitch roofs at right angles runs at 45 degrees in plan, 16.97 in of run per 12 in of common run.
// - International Residential Code 2021: R310.2.1 emergency escape openings (dormer windows: 5.7 sq ft net, 24 in high,
//   20 in wide), R905.2.8.3 step flashing (4 in up the dormer cheek), R905.2.2, R905.3.2, R905.7.2, R905.10.2 minimum
//   roof slopes per covering.
import type { GeometryData } from '@margoengine/geometry/utils';
import {
  type Building,
  type BuildingDoorway,
  type BuildingFurniture,
  type BuildingMaterial,
  type BuildingOpening,
  type BuildingPart,
  type BuildingRoom,
  type BuildingRuleOptions,
  type BuildingStair,
  type BuildingStyle,
  generateBuilding,
  resolveBuildingOptions,
} from './building-rules.js';
import {
  CURTAINS,
  type CurtainRun,
  KEEP_CLEAR,
  STAIR_AVOID,
  type StairAvoid,
  WALL_LINING,
} from './building-interiors.js';
import { type Joins, type BuildingJoinStep, planJoins } from './building-joins.js';
import { WINDOW_FIT, windowFit } from './building-windows.js';
import { MeshBuilder, type V3 } from './mesh-builder.js';

export type { BuildingJoinStep } from './building-joins.js';
/** The plan of the whole: `rect` (one block), `L` (a wing at the left end), `T` (a wing at the middle), `U` (wings at both ends) or `cross` (wings at the middle, front and back). */
export type BuildingPlanShape = 'rect' | 'L' | 'T' | 'U' | 'cross';
/** Where a corner tower stands on the main block, seen from the street. */
export type BuildingTowerCorner = 'none' | 'front-left' | 'front-right' | 'back-left' | 'back-right';
/** Dormer roof: `gable`, `shed` (one slope, lower than the main roof) or `hip`. */
export type BuildingDormerKind = 'gable' | 'shed' | 'hip';
/** A wing given by hand. Any building option may be set for it; the rest come from the plan's own options. */
export interface BuildingWing
  extends Omit<BuildingRuleOptions, 'origin' | 'yaw' | 'detail' | 'seed' | 'style' | 'interior'> {
  /** Middle of the wing's footprint on the plan, local `[x, z]`, metres. */
  readonly at: readonly [number, number];
  /** Quarter turns of the wing's front about +y: 0 faces +z (the street), 1 faces +x, 2 faces -z, 3 faces -x. */
  readonly turn?: 0 | 1 | 2 | 3;
}
/** Options for {@link generateBuildingPlan}: the building options of the main block, and the plan. */
export interface BuildingPlanOptions extends BuildingRuleOptions {
  /** Default `L`. */
  readonly plan?: BuildingPlanShape;
  /** Which side the wings stand out from (`cross` has both). Default `front`. */
  readonly wingSide?: 'front' | 'back';
  /** Wing width, metres, 3 to 120 (at most the main block's width). Default the smaller of 0.75 depth and 0.45 width. */
  readonly wingWidth?: number;
  /** How far each wing stands out past the main block, metres, 1 to 120. Default 0.6 of the main block's depth. */
  readonly wingLength?: number;
  /** Wings given by hand, in place of the plan's. */
  readonly wings?: readonly BuildingWing[];
  /** Dormers on each long slope of the main roof, 0 to 12. Default 0. */
  readonly dormers?: number;
  /** Default `gable`. */
  readonly dormerKind?: BuildingDormerKind;
  /** Dormer outer width, metres, 1.2 to 4. Default 1.8. */
  readonly dormerWidth?: number;
  /** Dormers on the front slope only, or both long slopes. Default `front`. */
  readonly dormerSides?: 'front' | 'both';
  /** Default `none`. */
  readonly tower?: BuildingTowerCorner;
  /** Tower footprint side, metres, 3 to 12. Default 3.6. */
  readonly towerSize?: number;
  /** Storeys the tower rises above the main block, 0 to 6. Default 1. */
  readonly towerStoreys?: number;
  /** Tower roof pitch, degrees, 20 to 70 (a square hip roof is a pyramid). Default 50. */
  readonly towerPitch?: number;
}
/** One block of the plan: the main block, a wing, a tower or a dormer. */
export interface BuildingPlanBlock {
  readonly kind: 'main' | 'wing' | 'tower' | 'dormer';
  /** Footprint corners `[x, z]`, world. */
  readonly footprint: readonly (readonly [number, number])[];
  /** Wall top above the ground, metres. */
  readonly eaves: number;
  /** Highest point, metres. */
  readonly top: number;
  /** Roof pitch, degrees. */
  readonly pitch: number;
  /** Roof covering. */
  readonly roofing: string;
}
/** A dormer: its window on the dormer face, world, and the main roof's height under its sill. */
export interface BuildingDormer {
  readonly window: BuildingOpening;
  /** Main roof covering height at the dormer face, metres above the ground. */
  readonly roofAtFace: number;
}
/** A building from {@link generateBuildingPlan}. */
export interface PlannedBuilding {
  readonly parts: Readonly<Partial<Record<BuildingPart, GeometryData>>>;
  readonly palette: Readonly<Record<BuildingPart, BuildingMaterial>>;
  readonly blocks: readonly BuildingPlanBlock[];
  /** Highest point of the whole, metres above the ground. */
  readonly top: number;
  /** Openings left visible (an opening inside another block is dropped), world. */
  readonly openings: readonly BuildingOpening[];
  readonly dormers: readonly BuildingDormer[];
  /** Rooms, furnishing blocks, doorways and stairs of every block, in plan-local metres (before origin and yaw). */
  readonly rooms: readonly BuildingRoom[];
  readonly furniture: readonly BuildingFurniture[];
  readonly doorways: readonly BuildingDoorway[];
  readonly stairs: readonly BuildingStair[];
  /** Steps through the joins of blocks whose floors differ, in plan-local metres (`doorways` has their openings). */
  readonly joinSteps: readonly BuildingJoinStep[];
  /** Roof covering height of the whole at plan-local `[x, z]` (NaN off every roof): the upper envelope of the blocks. */
  roofHeight(x: number, z: number): number;
  /** Whether plan-local point `[x, y, z]` is inside block `index`'s solid, the space its parts were cut by. */
  insideBlock(index: number, x: number, y: number, z: number): boolean;
}

interface BlockSpec {
  kind: 'main' | 'wing' | 'tower';
  opts: BuildingRuleOptions;
  at: V3;
  turn: number;
}

/**
 * Gives each block the stairs that reach its floors, and says which block's inside stands where two overlap (the lower
 * number). The main block has the stair for every floor level it shares. A wing or tower that joins it and has no floor
 * the main block lacks needs none; any other gets its own. One that climbs on from all the main block's floors is a
 * stair tower: its inside comes before the main block's, whose stair keeps out of it (and is left out when it has no
 * other room, the tower's serving those floors).
 */
function planStairs(specs: BlockSpec[], given: readonly BuildingWing[]) {
  const all = specs.map((sp) => {
    const o = resolveBuildingOptions(sp.opts);
    let y = o.plinth;
    const floors = [y, ...o.storeys.slice(0, -1).map((h) => (y += h))],
      [w, d] = sp.turn % 2 ? [o.depth, o.width] : [o.width, o.depth];
    return {
      floors,
      stairs: o.stairs,
      wall: o.wall,
      rect: { x0: sp.at[0] - w / 2, x1: sp.at[0] + w / 2, z0: sp.at[2] - d / 2, z1: sp.at[2] + d / 2 },
    };
  });
  // Blocks joined to the main one through overlaps at least a metre each way, so there is a way through.
  const joined = new Set([0]);
  for (const i of joined)
    all.forEach((b, j) => {
      const a = all[i].rect;
      if (Math.min(a.x1, b.rect.x1) - Math.max(a.x0, b.rect.x0) > 1)
        if (Math.min(a.z1, b.rect.z1) - Math.max(a.z0, b.rect.z0) > 1) joined.add(j);
    });
  const main = all[0],
    level = (a: readonly number[], b: readonly number[]) => a.every((y, k) => Math.abs((b[k] ?? Infinity) - y) < 0.01),
    own = (j: number) => !(joined.has(j) && level(all[j].floors, main.floors)),
    // The main block is 0; a stair tower comes before it.
    first = specs.map((_, j) => j),
    towers: number[] = [];
  for (let j = 1; j < specs.length; j++) {
    const sp = specs[j],
      asked = sp.kind === 'wing' && given[j - 1]?.stairs !== undefined,
      stairs = asked ? all[j].stairs : main.stairs && all[j].floors.length > 1 && own(j);
    specs[j] = { ...sp, opts: { ...sp.opts, stairs } };
    if (stairs && joined.has(j) && own(j) && level(main.floors, all[j].floors)) {
      towers.push(j);
      first[j] = j - specs.length;
    }
  }
  // Wings whose floors do not run level with the main block's: steps stand at their join, so stairs stay back from it
  // where there is room.
  const uneven = new Set(
      [...joined].filter((j) =>
        all[j].floors.some((y, k) => k < main.floors.length && Math.abs(main.floors[k] - y) >= 0.01),
      ),
    ),
    REACH = 1.8;
  const keepOut = (j: number, others: number[], required: boolean, enter?: number, near: number[] = []) => {
    const sp = specs[j],
      yaw = (sp.turn * Math.PI) / 2,
      c = Math.round(Math.cos(yaw)),
      s = Math.round(Math.sin(yaw)),
      local = (x: number, z: number) => {
        const dx = x - sp.at[0],
          dz = z - sp.at[2];
        return [dx * c - dz * s, dx * s + dz * c];
      },
      turned = (i: number, inset: number) => {
        const r = all[i].rect,
          a = local(r.x0 + inset, r.z0 + inset),
          b = local(r.x1 - inset, r.z1 - inset);
        return {
          x0: Math.min(a[0], b[0]),
          x1: Math.max(a[0], b[0]),
          z0: Math.min(a[1], b[1]),
          z1: Math.max(a[1], b[1]),
        };
      };
    const avoid: StairAvoid = {
      rects: others.map((i) => turned(i, 0)),
      soft: near.map((i) => turned(i, -REACH)),
      hidden: j > 0 ? near.map((i) => turned(i, 0)) : [],
      required,
      // Just inside the other block's walls.
      from: enter === undefined ? undefined : turned(enter, all[enter].wall + 0.1),
    };
    specs[j] = { ...sp, opts: Object.assign({}, sp.opts, { [STAIR_AVOID]: avoid }) };
  };
  if (towers.length || uneven.size) keepOut(0, towers, !towers.length, undefined, [...uneven]);
  // A tower is entered from the main block, so its stair starts on that side.
  for (const j of towers) keepOut(j, [], true, 0, uneven.has(j) ? [0] : []);
  // Any other block with a stair of its own keeps it out of the insides that come before it.
  for (let j = 1; j < specs.length; j++)
    if (joined.has(j) && !towers.includes(j))
      keepOut(
        j,
        specs.map((_, i) => i).filter((i) => first[i] < first[j] && joined.has(i)),
        true,
        undefined,
        uneven.has(j) ? [0] : [],
      );
  return { first, joined };
}

/** Whether a ground floor door of block `j` is outside every other block. */
function openDoor(specs: BlockSpec[], built: Building[], j: number) {
  return built[j].openings.some(
    (d) =>
      d.kind === 'door' &&
      d.floor === 0 &&
      !specs.some((sp, i) => {
        if (i === j) return false;
        const o = built[i].options,
          [w, depth] = sp.turn % 2 ? [o.depth, o.width] : [o.width, o.depth];
        return Math.abs(d.centre[0] - sp.at[0]) < w / 2 && Math.abs(d.centre[2] - sp.at[2]) < depth / 2;
      }),
  );
}
/**
 * Where every ground floor door of a group of connected blocks is inside another block (a tower over the only one, or a
 * wing no steps reach), one of them, the last first, gets one. Returns whether a block was rebuilt.
 */
function openAWayIn(specs: BlockSpec[], built: Building[], blocks: readonly number[]) {
  const group = [...blocks].sort((a, b) => b - a);
  if (group.some((j) => openDoor(specs, built, j))) return false;
  for (const j of group) {
    const sp = specs[j],
      yaw = (sp.turn * Math.PI) / 2;
    for (const side of ['doors', 'every bay'] as const) {
      const bays = side === 'doors' ? [0] : [0, 1, 2, 3, 4, 5],
        opts = Object.assign({}, sp.opts, { doors: bays }),
        b = generateBuilding({ ...opts, origin: sp.at, yaw }),
        trial = built.map((q, i) => (i === j ? b : q));
      if (openDoor(specs, trial, j)) {
        specs[j] = { ...sp, opts };
        built[j] = b;
        return true;
      }
    }
  }
  return false;
}

/**
 * Builds the steps and walls of every join between unequal floors, gives each group of blocks they leave connected a
 * way in, and rebuilds the blocks whose furniture stood where steps now do.
 */
function joinFloors(
  specs: BlockSpec[],
  built: Building[],
  first: readonly number[],
  joined: ReadonlySet<number>,
  style: BuildingStyle,
): Joins {
  const plan = () =>
    planJoins(
      specs.map((sp, j) => ({ building: built[j], at: sp.at, turn: sp.turn, rank: first[j] })),
      style,
    );
  let joins = plan(),
    changed = true;
  // A new door moves partitions off it, so the steps are placed again; a block gains doors at most once.
  while (changed) {
    changed = false;
    const group = new Map([...joined].map((j) => [j, j])),
      root = (j: number): number => (group.get(j) === j ? j : root(group.get(j)!));
    for (const [a, b] of joins.linked) if (group.has(a) && group.has(b)) group.set(root(a), root(b));
    for (const r of new Set([...joined].map(root))) {
      const members = [...joined].filter((j) => root(j) === r);
      if (openAWayIn(specs, built, members)) changed = true;
    }
    if (changed) joins = plan();
  }
  specs.forEach((sp, j) => {
    const yaw = (sp.turn * Math.PI) / 2,
      c = Math.round(Math.cos(yaw)),
      s = Math.round(Math.sin(yaw)),
      local = (x: number, z: number) => {
        const dx = x - sp.at[0],
          dz = z - sp.at[2];
        return [dx * c - dz * s, dx * s + dz * c];
      },
      clear = joins.keep
        .filter((k) => k.block === j)
        .map(({ floor, rect }) => {
          const a = local(rect.x0, rect.z0),
            b = local(rect.x1, rect.z1);
          return {
            floor,
            x0: Math.min(a[0], b[0]),
            x1: Math.max(a[0], b[0]),
            z0: Math.min(a[1], b[1]),
            z1: Math.max(a[1], b[1]),
          };
        });
    if (!clear.length) return;
    const opts = Object.assign({}, sp.opts, { [KEEP_CLEAR]: clear });
    built[j] = generateBuilding({ ...opts, origin: sp.at, yaw });
  });
  return joins;
}

/** The parts behind the walls, which only an earlier block cuts. */
const INDOOR = new Set<BuildingPart>(['interior', 'furniture', 'stairs', 'fixtures', 'metalwork', 'fabric', 'mats']);
// a x + b y + c z <= d.
type Half = readonly [number, number, number, number];
interface Solid {
  readonly halves: readonly Half[];
  readonly lo: V3;
  readonly hi: V3;
}
interface Plane {
  readonly a: number;
  readonly g: number;
  readonly d: number;
}
interface Block {
  readonly kind: BuildingPlanBlock['kind'];
  readonly parts: Partial<Record<BuildingPart, GeometryData>>;
  readonly solids: Solid[];
  /** The room inside its walls (a dormer: its solids). */
  readonly inner: Solid[];
  /** The walls' inside faces: this many of the `interior` part's first triangles. */
  readonly lining?: number;
  /** Each window's curtains and rod, with the window's middle in plan terms. */
  readonly curtains?: readonly CurtainRun[];
  readonly roof: (x: number, z: number) => number;
  readonly info: Omit<BuildingPlanBlock, 'footprint'> & {
    footprint: [number, number][];
  };
  readonly building?: Building;
}

/** A box as a solid to cut by. */
const boxSolid = (lo: V3, hi: V3): Solid => ({
  halves: [
    [1, 0, 0, hi[0]],
    [-1, 0, 0, -lo[0]],
    [0, 1, 0, hi[1]],
    [0, -1, 0, -lo[1]],
    [0, 0, 1, hi[2]],
    [0, 0, -1, -lo[2]],
  ],
  lo,
  hi,
});

const PLANS: readonly BuildingPlanShape[] = ['rect', 'L', 'T', 'U', 'cross'];
const CORNERS: readonly BuildingTowerCorner[] = ['none', 'front-left', 'front-right', 'back-left', 'back-right'];
const PLAN_KEYS = [
  'plan',
  'wingSide',
  'wingWidth',
  'wingLength',
  'wings',
  'dormers',
  'dormerKind',
  'dormerWidth',
  'dormerSides',
  'tower',
  'towerSize',
  'towerStoreys',
  'towerPitch',
];
const EPS = 0.005;

function num(o: Record<string, unknown>, name: string, lo: number, hi: number, fallback: number, int = false): number {
  const v = o[name];
  if (v === undefined) return fallback;
  if (typeof v !== 'number') throw new TypeError(`Invalid building plan ${name}; pass a number from ${lo} to ${hi}.`);
  if (!Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v)))
    throw new RangeError(`Invalid building plan ${name}; pass ${int ? 'an integer' : 'a number'} from ${lo} to ${hi}.`);
  return v;
}
function pick<T extends string>(o: Record<string, unknown>, name: string, choices: readonly T[], fallback: T): T {
  const v = o[name];
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !choices.includes(v as T))
    throw new RangeError(`Invalid building plan ${name}; pass one of ${choices.join(', ')}.`);
  return v as T;
}

// The roof's top planes of a block from the building rules, local (y = a x + g z + d), and whether it is pitched.
function roofPlanes(b: Building): Plane[] {
  const o = b.options;
  if (o.roof === 'flat') return [{ a: 0, g: 0, d: b.roofHeight(0, 0) }];
  const W = o.width,
    D = o.depth,
    t = Math.tan((o.pitch * Math.PI) / 180),
    ov = o.overhang,
    swap = o.roof === 'hip' || o.roof === 'hip-gable' ? W < D : o.ridge === 'auto' ? W < D : o.ridge === 'z',
    L2 = (swap ? D : W) / 2 + ov,
    d2 = (swap ? W : D) / 2 + ov,
    local = (X: number, Z: number) => (swap ? b.roofHeight(Z, X) : b.roofHeight(X, Z)),
    canon: { aX: number; aZ: number; c: number }[] = [];
  if (o.roof === 'shed') canon.push({ aX: 0, aZ: t, c: local(0, 0) });
  else {
    const k = local(0, d2 / 2) - (d2 / 2) * t;
    canon.push({ aX: 0, aZ: -t, c: k + d2 * t }, { aX: 0, aZ: t, c: k + d2 * t });
    // The hip-gable's ends are taken as full hips: its small gables sit inside that solid, so cuts stop a little short there.
    if (o.roof !== 'gable') canon.push({ aX: -t, aZ: 0, c: k + L2 * t }, { aX: t, aZ: 0, c: k + L2 * t });
  }
  return canon.map((p) => (swap ? { a: p.aZ, g: p.aX, d: p.c } : { a: p.aX, g: p.aZ, d: p.c }));
}

// The solids a block's parts cut others by, local: under its roof inside its walls, and each roof face's slab out to the
// eaves and verges.
function blockSolids(b: Building, planes: Plane[]): Solid[] {
  const o = b.options,
    W = o.width / 2,
    D = o.depth / 2,
    ov = o.roof === 'flat' && o.parapet > 0 ? 0 : o.overhang,
    top = b.top,
    under: Half[] = [
      [1, 0, 0, W],
      [-1, 0, 0, W],
      [0, 0, 1, D],
      [0, 0, -1, D],
      [0, -1, 0, 0.35],
    ];
  for (const p of planes) under.push([-p.a, 1, -p.g, p.d]);
  const out: Solid[] = [{ halves: under, lo: [-W, -0.35, -D], hi: [W, top, D] }];
  if (ov > 0)
    planes.forEach((p, i) => {
      const h: Half[] = [
        [1, 0, 0, W + ov],
        [-1, 0, 0, W + ov],
        [0, 0, 1, D + ov],
        [0, 0, -1, D + ov],
        [-p.a, 1, -p.g, p.d],
        [p.a, -1, p.g, 0.15 - p.d],
      ];
      planes.forEach((q, j) => {
        if (j !== i) h.push([p.a - q.a, 0, p.g - q.g, q.d - p.d]);
      });
      out.push({
        halves: h,
        lo: [-W - ov, b.eaves - ov * 2 - 1, -D - ov],
        hi: [W + ov, top, D + ov],
      });
    });
  return out;
}

// Moves a solid from a frame placed at `o` and turned by yaw (as MeshBuilder.finish places it) into the parent frame.
function placeSolid(s: Solid, o: V3, yaw: number): Solid {
  const c = Math.cos(yaw),
    sn = Math.sin(yaw);
  const halves = s.halves.map(([a, b, g, d]): Half => {
    const A = a * c + g * sn,
      G = -a * sn + g * c;
    return [A, b, G, d + A * o[0] + b * o[1] + G * o[2]];
  });
  const xs: number[] = [],
    zs: number[] = [];
  for (const x of [s.lo[0], s.hi[0]])
    for (const z of [s.lo[2], s.hi[2]]) {
      xs.push(o[0] + x * c + z * sn);
      zs.push(o[2] - x * sn + z * c);
    }
  return {
    halves,
    lo: [Math.min(...xs), s.lo[1] + o[1], Math.min(...zs)],
    hi: [Math.max(...xs), s.hi[1] + o[1], Math.max(...zs)],
  };
}
/** A block's solid less its walls: the same under its roof, `wall` in from each side. */
function shrunk(s: Solid, wall: number): Solid {
  return {
    halves: s.halves.map(([a, b, g, d]): Half => [a, b, g, b === 0 ? d - wall : d]),
    lo: [s.lo[0] + wall, s.lo[1], s.lo[2] + wall],
    hi: [s.hi[0] - wall, s.hi[1], s.hi[2] - wall],
  };
}
/** A solid with nothing above `top`. */
const capped = (s: Solid, top: number): Solid => ({
  halves: [...s.halves, [0, 1, 0, top]],
  lo: s.lo,
  hi: [s.hi[0], Math.min(s.hi[1], top), s.hi[2]],
});
const inside = (s: Solid, p: V3, eps: number) =>
  s.halves.every((h) => h[0] * p[0] + h[1] * p[1] + h[2] * p[2] <= h[3] + eps);

// Removes from g every part inside any of the solids; each solid has its own margin (grown when positive).
function subtract(g: GeometryData, solids: readonly { s: Solid; eps: number }[]): GeometryData {
  const P = g.positions,
    N = g.normals!,
    U = g.uvs!,
    T = g.tangents!,
    I = g.indices!,
    vert = (i: number) => [
      P[3 * i],
      P[3 * i + 1],
      P[3 * i + 2],
      N[3 * i],
      N[3 * i + 1],
      N[3 * i + 2],
      U[2 * i],
      U[2 * i + 1],
      T[4 * i],
      T[4 * i + 1],
      T[4 * i + 2],
      T[4 * i + 3],
    ];
  const op: number[] = [],
    on: number[] = [],
    ou: number[] = [],
    ot: number[] = [],
    oi: number[] = [],
    remap = new Map<number, number>();
  const emit = (v: number[]) => {
    op.push(v[0], v[1], v[2]);
    on.push(v[3], v[4], v[5]);
    ou.push(v[6], v[7]);
    ot.push(v[8], v[9], v[10], v[11]);
    return op.length / 3 - 1;
  };
  const keep = (i: number) => {
    let r = remap.get(i);
    if (r === undefined) remap.set(i, (r = emit(vert(i))));
    return r;
  };
  const cut = (poly: number[][], vals: number[], side: number) => {
    const out: number[][] = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k],
        b = poly[(k + 1) % poly.length],
        fa = side * vals[k],
        fb = side * vals[(k + 1) % poly.length];
      if (fa >= 0) out.push(a);
      if (fa >= 0 !== fb >= 0) {
        const t = fa / (fa - fb);
        out.push(a.map((x, j) => x + (b[j] - x) * t));
      }
    }
    return out;
  };
  for (let t = 0; t < I.length; t += 3) {
    let polys = [[vert(I[t]), vert(I[t + 1]), vert(I[t + 2])]],
      touched = false;
    for (const { s, eps } of solids) {
      const next: number[][][] = [];
      for (const poly of polys) {
        let out = false;
        for (let a = 0; a < 3 && !out; a++) {
          let lo = Infinity,
            hi = -Infinity;
          for (const v of poly) {
            lo = Math.min(lo, v[a]);
            hi = Math.max(hi, v[a]);
          }
          out = lo > s.hi[a] + eps || hi < s.lo[a] - eps;
        }
        if (out) {
          next.push(poly);
          continue;
        }
        let rest: number[][] | null = poly;
        for (const h of s.halves) {
          const vals = rest.map((v) => h[0] * v[0] + h[1] * v[1] + h[2] * v[2] - h[3] - eps);
          if (vals.every((x) => x >= 0)) {
            next.push(rest);
            rest = null;
            break;
          }
          if (vals.every((x) => x <= 0)) continue;
          const outside = cut(rest, vals, 1);
          if (outside.length >= 3) next.push(outside);
          touched = true;
          rest = cut(rest, vals, -1);
          if (rest.length < 3) {
            rest = null;
            break;
          }
        }
        if (rest) touched = true;
      }
      polys = next;
    }
    if (!touched) {
      oi.push(keep(I[t]), keep(I[t + 1]), keep(I[t + 2]));
      continue;
    }
    for (const poly of polys) {
      // Drop slivers: twice the area under a square millimetre.
      let ax = 0,
        ay = 0,
        az = 0;
      for (let k = 1; k + 1 < poly.length; k++) {
        const u = [poly[k][0] - poly[0][0], poly[k][1] - poly[0][1], poly[k][2] - poly[0][2]],
          w = [poly[k + 1][0] - poly[0][0], poly[k + 1][1] - poly[0][1], poly[k + 1][2] - poly[0][2]];
        ax += u[1] * w[2] - u[2] * w[1];
        ay += u[2] * w[0] - u[0] * w[2];
        az += u[0] * w[1] - u[1] * w[0];
      }
      if (Math.hypot(ax, ay, az) < 1e-6) continue;
      const ids = poly.map(emit);
      for (let k = 1; k + 1 < ids.length; k++) oi.push(ids[0], ids[k], ids[k + 1]);
    }
  }
  return {
    positions: Float32Array.from(op),
    normals: Float32Array.from(on),
    uvs: Float32Array.from(ou),
    tangents: Float32Array.from(ot),
    indices: Uint32Array.from(oi),
  };
}

function concat(list: GeometryData[], origin: V3, yaw: number): GeometryData {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  let n = 0,
    m = 0;
  for (const g of list) {
    n += g.positions.length / 3;
    m += g.indices!.length;
  }
  const P = new Float32Array(n * 3),
    N = new Float32Array(n * 3),
    U = new Float32Array(n * 2),
    T = new Float32Array(n * 4),
    I = new Uint32Array(m);
  let v = 0,
    k = 0;
  for (const g of list) {
    const cnt = g.positions.length / 3;
    for (let i = 0; i < cnt; i++) {
      const x = g.positions[3 * i],
        z = g.positions[3 * i + 2],
        nx = g.normals![3 * i],
        nz = g.normals![3 * i + 2],
        tx = g.tangents![4 * i],
        tz = g.tangents![4 * i + 2],
        o = v + i;
      P[3 * o] = origin[0] + x * c + z * s;
      P[3 * o + 1] = origin[1] + g.positions[3 * i + 1];
      P[3 * o + 2] = origin[2] - x * s + z * c;
      N[3 * o] = nx * c + nz * s;
      N[3 * o + 1] = g.normals![3 * i + 1];
      N[3 * o + 2] = -nx * s + nz * c;
      T[4 * o] = tx * c + tz * s;
      T[4 * o + 1] = g.tangents![4 * i + 1];
      T[4 * o + 2] = -tx * s + tz * c;
      T[4 * o + 3] = g.tangents![4 * i + 3];
      U[2 * o] = g.uvs![2 * i];
      U[2 * o + 1] = g.uvs![2 * i + 1];
    }
    for (const id of g.indices!) I[k++] = id + v;
    v += cnt;
  }
  return { positions: P, normals: N, uvs: U, tangents: T, indices: I };
}

// A dormer on the main roof, built in the main roof's canonical frame (X along the ridge, Z across it, the slope falling
// toward +Z) and mapped to plan-local axes by `swap`.
function buildDormer(
  kind: BuildingDormerKind,
  xc: number,
  dw: number,
  zFace: number,
  roofAt: (Z: number) => number,
  ridgeTop: number,
  pitch: number,
  minPitch: number,
  swap: boolean,
  flip: boolean,
  palette: Set<BuildingPart>,
): {
  parts: Partial<Record<BuildingPart, GeometryData>>;
  solid: Solid;
  roof: (x: number, z: number) => number;
  window: BuildingOpening;
  roofAtFace: number;
} | null {
  // Canonical (X, y, Z) to plan-local; `flip` mirrors Z for the back slope.
  const P = (X: number, y: number, Z: number): V3 => {
    const z = flip ? -Z : Z;
    return swap ? [z, y, X] : [X, y, z];
  };
  const dir = (X: number, y: number, Z: number): V3 => P(X, y, Z);
  const hw = dw / 2,
    tw = 0.12,
    slabT = 0.07,
    ov = 0.2,
    yr = roofAt(zFace),
    yb = yr - 0.2,
    ww = Math.max(0.6, dw - 0.5),
    sill = yr + 0.2,
    wh = 1.0,
    head = sill + wh,
    ye = head + 0.25,
    td = Math.tan((pitch * Math.PI) / 180),
    ts = Math.tan((Math.max(minPitch, pitch * 0.35) * Math.PI) / 180),
    yTop = kind === 'shed' ? ye + slabT : ye + slabT + hw * td;
  if (kind !== 'shed' && yTop > ridgeTop - 0.15) return null;
  // The back end: where the dormer roof's lowest line meets the main roof, with a little to spare.
  let zBack = 0;
  for (let Z = zFace; Z > 0; Z -= 0.05)
    if (roofAt(Z) > (kind === 'shed' ? ye + (zFace - Z) * ts : ye) + 0.3) {
      zBack = Z;
      break;
    }
  const m: Record<'walls' | 'roof' | 'glass' | 'frames' | 'trim', MeshBuilder> = {
    walls: new MeshBuilder(),
    roof: new MeshBuilder(),
    glass: new MeshBuilder(),
    frames: new MeshBuilder(),
    trim: new MeshBuilder(),
  };
  const front = dir(0, 0, 1),
    up: V3 = [0, 1, 0];
  const wallPiece = (x0: number, x1: number, y0: number, y1: number) =>
    m.walls.slab([P(x0, y0, zFace), P(x1, y0, zFace), P(x1, y1, zFace), P(x0, y1, zFace)], tw, front);
  wallPiece(xc - hw, xc + hw, yb, sill);
  wallPiece(xc - hw, xc + hw, head, ye);
  wallPiece(xc - hw, xc - ww / 2, sill, head);
  wallPiece(xc + ww / 2, xc + hw, sill, head);
  // Reveals through the wall.
  const zi = zFace - tw;
  m.walls.poly(
    [P(xc - ww / 2, sill, zFace), P(xc + ww / 2, sill, zFace), P(xc + ww / 2, sill, zi), P(xc - ww / 2, sill, zi)],
    up,
  );
  m.walls.poly(
    [P(xc - ww / 2, head, zFace), P(xc + ww / 2, head, zFace), P(xc + ww / 2, head, zi), P(xc - ww / 2, head, zi)],
    [0, -1, 0],
  );
  m.walls.poly(
    [P(xc - ww / 2, sill, zFace), P(xc - ww / 2, head, zFace), P(xc - ww / 2, head, zi), P(xc - ww / 2, sill, zi)],
    dir(1, 0, 0),
  );
  m.walls.poly(
    [P(xc + ww / 2, sill, zFace), P(xc + ww / 2, head, zFace), P(xc + ww / 2, head, zi), P(xc + ww / 2, sill, zi)],
    dir(-1, 0, 0),
  );
  // Cheeks, run back into the main roof (the main roof's solid cuts what is under it).
  for (const sx of [-1, 1])
    m.walls.slab(
      [P(xc + sx * hw, yb, zFace), P(xc + sx * hw, ye, zFace), P(xc + sx * hw, ye, zBack), P(xc + sx * hw, yb, zBack)],
      tw,
      dir(sx, 0, 0),
    );
  // Glass set back 6 cm, a frame round it and a sill under it.
  const zg = zFace - 0.06;
  m.glass.poly(
    [P(xc - ww / 2, sill, zg), P(xc + ww / 2, sill, zg), P(xc + ww / 2, head, zg), P(xc - ww / 2, head, zg)],
    front,
  );
  const fr = 0.05;
  m.frames.beam(P(xc - ww / 2, sill + fr / 2, zg), P(xc + ww / 2, sill + fr / 2, zg), 0.05, fr);
  m.frames.beam(P(xc - ww / 2, head - fr / 2, zg), P(xc + ww / 2, head - fr / 2, zg), 0.05, fr);
  m.frames.beam(P(xc - ww / 2 + fr / 2, sill, zg), P(xc - ww / 2 + fr / 2, head, zg), 0.05, fr, dir(0, 0, 1));
  m.frames.beam(P(xc + ww / 2 - fr / 2, sill, zg), P(xc + ww / 2 - fr / 2, head, zg), 0.05, fr, dir(0, 0, 1));
  m.frames.beam(P(xc, sill, zg), P(xc, head, zg), 0.04, 0.04, dir(0, 0, 1));
  m.trim.beam(
    P(xc - ww / 2 - 0.06, sill - 0.025, zFace + 0.03),
    P(xc + ww / 2 + 0.06, sill - 0.025, zFace + 0.03),
    0.08,
    0.05,
  );
  // Roof and its top planes (canonical): y = aX X + aZ Z + c.
  const eaveY = ye + slabT - ov * td,
    zf = zFace + ov,
    planes: { aX: number; aZ: number; c: number }[] = [];
  if (kind === 'shed') {
    const y0 = ye + slabT - ov * ts;
    m.roof.slab(
      [
        P(xc - hw - ov, y0, zf),
        P(xc + hw + ov, y0, zf),
        P(xc + hw + ov, y0 + (zf - zBack) * ts, zBack),
        P(xc - hw - ov, y0 + (zf - zBack) * ts, zBack),
      ],
      slabT,
      up,
    );
    planes.push({ aX: 0, aZ: -ts, c: ye + slabT + zFace * ts });
    m.trim.beam(P(xc - hw - ov, y0 - 0.06, zf), P(xc + hw + ov, y0 - 0.06, zf), 0.03, 0.14);
  } else {
    const zr = kind === 'hip' ? zFace - hw : zf;
    for (const sx of [-1, 1]) {
      const e = xc + sx * (hw + ov);
      if (kind === 'hip')
        m.roof.slab([P(e, eaveY, zf), P(xc, yTop, zr), P(xc, yTop, zBack), P(e, eaveY, zBack)], slabT, [0, 1, 0]);
      else m.roof.slab([P(e, eaveY, zf), P(xc, yTop, zf), P(xc, yTop, zBack), P(e, eaveY, zBack)], slabT, up);
      planes.push({
        aX: -sx * td,
        aZ: 0,
        c: ye + slabT + hw * td + sx * xc * td,
      });
      // Barge boards (gable) or the eave fascia along each side.
      if (kind === 'gable') m.trim.beam(P(e, eaveY - 0.05, zf + 0.02), P(xc, yTop - 0.05, zf + 0.02), 0.03, 0.16);
    }
    if (kind === 'gable')
      m.walls.slab([P(xc - hw, ye, zFace), P(xc + hw, ye, zFace), P(xc, yTop - slabT, zFace)], tw, front);
    else {
      m.roof.slab([P(xc - hw - ov, eaveY, zf), P(xc + hw + ov, eaveY, zf), P(xc, yTop, zr)], slabT, up);
      planes.push({ aX: 0, aZ: -td, c: yTop + zr * td });
    }
    m.roof.beam(P(xc, yTop + 0.03, zr), P(xc, yTop + 0.03, zBack), 0.12, 0.06);
  }
  // The dormer's solid, canonical then plan-local.
  const loc = ([a, b, g, d]: Half): Half => {
    const G = flip ? -g : g;
    return swap ? [G, b, a, d] : [a, b, G, d];
  };
  const canonHalves: Half[] = [
    [1, 0, 0, xc + hw],
    [-1, 0, 0, -(xc - hw)],
    [0, 0, 1, zFace],
    [0, 0, -1, -zBack],
    [0, -1, 0, -yb],
    ...planes.map((p): Half => [-p.aX, 1, -p.aZ, p.c]),
  ];
  const halves = canonHalves.map(loc);
  const lo = P(xc - hw, yb, zBack),
    hi = P(xc + hw, yTop, zFace),
    solid: Solid = {
      halves,
      lo: [Math.min(lo[0], hi[0]), yb, Math.min(lo[2], hi[2])],
      hi: [Math.max(lo[0], hi[0]), yTop + 0.2, Math.max(lo[2], hi[2])],
    };
  const roof = (x: number, z: number) => {
    const X = swap ? z : x,
      Z0 = swap ? x : z,
      Z = flip ? -Z0 : Z0;
    if (Math.abs(X - xc) > hw + ov || Z < zBack || Z > zf) return NaN;
    return Math.min(...planes.map((p) => p.aX * X + p.aZ * Z + p.c));
  };
  const parts: Partial<Record<BuildingPart, GeometryData>> = {};
  for (const [k, b] of Object.entries(m) as [BuildingPart, MeshBuilder][])
    if (b.triangles > 0) {
      parts[k] = b.finish();
      palette.add(k);
    }
  const c = P(xc, (sill + head) / 2, zFace);
  return {
    parts,
    solid,
    roof,
    window: {
      kind: 'window',
      side: flip ? 2 : 0,
      floor: -1,
      centre: c,
      width: ww - 2 * fr,
      height: wh - 2 * fr,
    },
    roofAtFace: yr,
  };
}

/**
 * A building on an L, T, U or cross plan, with dormers and a corner tower, its blocks joined: roofs meet in valleys,
 * walls open into each other and nothing hidden inside another block is kept.
 * @throws TypeError or RangeError for an invalid option, as `generateBuilding` and for the plan options above.
 */
export function generateBuildingPlan(options: BuildingPlanOptions = {}): PlannedBuilding {
  if (typeof options !== 'object' || options === null)
    throw new TypeError('Invalid building plan options; pass an object.');
  const raw = options as Record<string, unknown>,
    base: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!PLAN_KEYS.includes(k)) base[k] = v;
  const o = resolveBuildingOptions(base as BuildingRuleOptions),
    W = o.width,
    D = o.depth,
    plan = pick(raw, 'plan', PLANS, 'L'),
    wingSide = pick(raw, 'wingSide', ['front', 'back'] as const, 'front'),
    ww = num(raw, 'wingWidth', 3, Math.max(3, W), Math.max(3, Math.min(0.75 * D, 0.45 * W))),
    wl = num(raw, 'wingLength', 1, 120, Math.max(1, 0.6 * D)),
    dormers = num(raw, 'dormers', 0, 12, 0, true),
    dormerKind = pick(raw, 'dormerKind', ['gable', 'shed', 'hip'] as const, 'gable'),
    dormerWidth = num(raw, 'dormerWidth', 1.2, 4, 1.8),
    dormerSides = pick(raw, 'dormerSides', ['front', 'both'] as const, 'front'),
    tower = pick(raw, 'tower', CORNERS, 'none'),
    towerSize = num(raw, 'towerSize', 3, 12, 3.6),
    towerStoreys = num(raw, 'towerStoreys', 0, 6, 1, true),
    towerPitch = num(raw, 'towerPitch', 20, 70, 50),
    origin = (o.origin ?? [0, 0, 0]) as V3,
    yaw = o.yaw;
  if (raw.wings !== undefined && !Array.isArray(raw.wings))
    throw new TypeError('Invalid building plan wings; pass an array.');
  // Block options in plan-local terms: the main block at the plan origin, unturned.
  const shared = { ...base };
  delete shared.origin;
  delete shared.yaw;
  const specs: BlockSpec[] = [
    {
      kind: 'main',
      opts: shared as BuildingRuleOptions,
      at: [0, 0, 0],
      turn: 0,
    },
  ];
  // The main block's stair serves the floors it shares; a wing or tower with floors it does not reach gets its own
  // (planStairs, below). A hand-given wing's own `stairs` is kept.
  const wingDepth = D / 2 + wl;
  const planWing = (x: number, back: boolean) =>
    specs.push({
      kind: 'wing',
      opts: {
        ...shared,
        width: ww,
        depth: wingDepth,
        ridge: 'z',
        chimney: false,
        balcony: 0,
        stairs: false,
      } as BuildingRuleOptions,
      at: [x, 0, (back ? -1 : 1) * (wingDepth / 2)],
      turn: back ? 2 : 0,
    });
  if (Array.isArray(raw.wings)) {
    for (const w of raw.wings as BuildingWing[]) {
      if (typeof w !== 'object' || w === null) throw new TypeError('Invalid building plan wing; pass an object.');
      const at = w.at,
        turn = w.turn ?? 0;
      if (!Array.isArray(at) || at.length !== 2 || !at.every((v) => typeof v === 'number' && Number.isFinite(v)))
        throw new RangeError('Invalid building plan wing at; pass [x, z] in metres.');
      if (![0, 1, 2, 3].includes(turn)) throw new RangeError('Invalid building plan wing turn; pass 0, 1, 2 or 3.');
      const rest: Record<string, unknown> = { ...w };
      delete rest.at;
      delete rest.turn;
      specs.push({
        kind: 'wing',
        opts: {
          ...shared,
          chimney: false,
          stairs: false,
          ...rest,
        } as BuildingRuleOptions,
        at: [at[0], 0, at[1]],
        turn,
      });
    }
  } else {
    const back = wingSide === 'back',
      edge = W / 2 - ww / 2;
    if (plan === 'L') planWing(-edge, back);
    else if (plan === 'T') planWing(0, back);
    else if (plan === 'U') {
      planWing(-edge, back);
      planWing(edge, back);
    } else if (plan === 'cross') {
      planWing(0, false);
      planWing(0, true);
    }
  }
  if (tower !== 'none') {
    const sx = tower.endsWith('left') ? -1 : 1,
      sz = tower.startsWith('front') ? 1 : -1,
      s = Math.min(towerSize, W, D),
      last = o.storeys[o.storeys.length - 1];
    specs.push({
      kind: 'tower',
      opts: {
        ...shared,
        width: s,
        depth: s,
        storeys: [...o.storeys, ...Array(towerStoreys).fill(Math.min(last, 3.2))].slice(0, 60),
        roof: 'hip',
        pitch: towerPitch,
        overhang: Math.min(o.overhang, 0.5),
        parapet: 0,
        falseFront: 0,
        bayWidth: s,
        sideWindows: true,
        doors: [],
        porch: 0,
        balcony: 0,
        storefront: false,
        awning: false,
        chimney: false,
        stairs: false,
      } as BuildingRuleOptions,
      at: [sx * (W / 2 - s / 2 + 0.3 * s), 0, sz * (D / 2 - s / 2 + 0.3 * s)],
      turn: 0,
    });
  }
  const { first, joined } = planStairs(specs, Array.isArray(raw.wings) ? (raw.wings as BuildingWing[]) : []);
  const generate = (sp: BlockSpec) => generateBuilding({ ...sp.opts, origin: sp.at, yaw: (sp.turn * Math.PI) / 2 }),
    alone = specs.map(generate),
    placed = alone.map((b, j) =>
      blockSolids(b, roofPlanes(b)).map((s) => placeSolid(s, specs[j].at, (specs[j].turn * Math.PI) / 2)),
    ),
    // A block that has others beside it is built again, now and by the joins, with its windows fitted clear of them.
    built = alone.map((b, j) => {
      const others = placed.flatMap((list, i) => (i === j ? [] : list));
      if (!others.length) return b;
      const sp = specs[j],
        yawB = (sp.turn * Math.PI) / 2,
        c = Math.cos(yawB),
        sn = Math.sin(yawB),
        fit = windowFit(
          others.map((s) => s.halves),
          ([x, y, z]) => [sp.at[0] + x * c + z * sn, sp.at[1] + y, sp.at[2] - x * sn + z * c],
          b.options.wall,
        );
      specs[j] = { ...sp, opts: Object.assign({}, sp.opts, { [WINDOW_FIT]: fit }) };
      return generate(specs[j]);
    });
  const joins = joinFloors(specs, built, first, joined, o.style);
  const blocks: Block[] = specs.map((sp, j) => {
    const yawB = (sp.turn * Math.PI) / 2,
      b = built[j],
      planes = roofPlanes(b),
      solid = blockSolids(b, planes),
      local = solid.map((s) => placeSolid(s, sp.at, yawB)),
      c = Math.cos(yawB),
      sn = Math.sin(yawB);
    return {
      kind: sp.kind,
      parts: { ...b.parts },
      solids: local,
      // The rooms end at the eaves: what another block has up in this one's roof space keeps its walls and floors.
      inner: [placeSolid(capped(shrunk(solid[0], b.options.wall), b.eaves), sp.at, yawB)],
      lining: (b as Building & { [WALL_LINING]: number })[WALL_LINING],
      curtains: (b as Building & { [CURTAINS]: CurtainRun[] })[CURTAINS].map((run) => {
        const [x, y, z] = run.window,
          c = Math.cos(yawB),
          sn = Math.sin(yawB);
        return { ...run, window: [sp.at[0] + x * c + z * sn, sp.at[1] + y, sp.at[2] - x * sn + z * c] as V3 };
      }),
      roof: (x: number, z: number) => {
        const dx = x - sp.at[0],
          dz = z - sp.at[2];
        return b.roofHeight(dx * c - dz * sn, dx * sn + dz * c);
      },
      info: {
        kind: sp.kind,
        footprint: b.footprint.map((p) => [p[0], p[1]] as [number, number]),
        eaves: b.eaves,
        top: b.top,
        pitch: b.options.roof === 'flat' ? 0 : b.options.pitch,
        roofing: b.options.roofing,
      },
      building: b,
    };
  });
  // Dormers on the main roof's long slopes.
  const main = blocks[0].building!,
    mo = main.options,
    dormerList: BuildingDormer[] = [],
    used = new Set<BuildingPart>();
  if (dormers > 0 && (mo.roof === 'gable' || mo.roof === 'hip' || mo.roof === 'hip-gable')) {
    const swap = mo.roof === 'gable' ? (mo.ridge === 'auto' ? W < D : mo.ridge === 'z') : W < D,
      L = swap ? D : W,
      d = swap ? W : D,
      ridgeTop = Math.max(...roofPlanes(main).map((p) => p.d)),
      minPitch = mo.roofing === 'tile' ? 11.8 : mo.roofing === 'shingle' ? 14.1 : 1.2,
      hipRun = mo.roof === 'gable' ? 0 : d / 2 + mo.overhang,
      setback = 0.45;
    for (const flip of dormerSides === 'both' ? [false, true] : [false]) {
      const roofAt = (Z: number) => (swap ? main.roofHeight(flip ? -Z : Z, 0) : main.roofHeight(0, flip ? -Z : Z));
      let zFace = d / 2 - setback;
      while (zFace > 0.5 && roofAt(zFace) - 0.2 < main.eaves + 0.05) zFace -= 0.05;
      // Room along the slope: inside the verges (gable) or the hips at the dormer's back end.
      const half = L / 2 - 0.6 - dormerWidth / 2 - (hipRun > 0 ? Math.max(0, hipRun - (d / 2 - zFace) - 0.6) : 0);
      if (half < 0) continue;
      for (let i = 0; i < dormers; i++) {
        const xc = dormers === 1 ? 0 : -half + (2 * half * i) / (dormers - 1);
        if (i > 0 && dormers > 1 && (2 * half) / (dormers - 1) < dormerWidth + 0.6) break;
        // No dormer where a wing or the tower already stands over that part of the slope.
        const Zs = flip ? -zFace : zFace,
          at: V3 = swap ? [Zs, roofAt(zFace) + 0.5, xc] : [xc, roofAt(zFace) + 0.5, Zs],
          covered = blocks
            .slice(1)
            .some((blk) =>
              blk.solids.some((sd) =>
                [-dormerWidth / 2, 0, dormerWidth / 2].some((dx) =>
                  inside(sd, swap ? [at[0], at[1], at[2] + dx] : [at[0] + dx, at[1], at[2]], 0.3),
                ),
              ),
            );
        if (covered) continue;
        const dm = buildDormer(
          dormerKind,
          xc,
          dormerWidth,
          zFace,
          roofAt,
          ridgeTop,
          mo.pitch,
          minPitch,
          swap,
          flip,
          used,
        );
        if (!dm) break;
        dormerList.push({ window: dm.window, roofAtFace: dm.roofAtFace });
        const hiB = dm.solid.hi,
          loB = dm.solid.lo;
        blocks.push({
          kind: 'dormer',
          parts: dm.parts,
          solids: [dm.solid],
          inner: [dm.solid],
          roof: dm.roof,
          info: {
            kind: 'dormer',
            footprint: [
              [loB[0], hiB[2]],
              [hiB[0], hiB[2]],
              [hiB[0], loB[2]],
              [loB[0], loB[2]],
            ],
            eaves: dm.roofAtFace,
            top: hiB[1] - 0.2,
            pitch: dormerKind === 'shed' ? Math.max(minPitch, mo.pitch * 0.35) : mo.pitch,
            roofing: mo.roofing,
          },
        });
      }
    }
  }
  // Join: each block's parts lose what lies inside the others. An earlier block's solid is grown and a later one's
  // shrunk, so where two coincide the earlier block's surface is the one kept. Rooms and furniture are cut only by
  // blocks that come first indoors: a stair tower, then the earlier blocks (the main block keeps its rooms where a
  // wing meets it).
  const merged: Partial<Record<BuildingPart, GeometryData[]>> = {};
  blocks.forEach((blk, j) => {
    // A window another block stands over went with its wall, so its curtains and rod come down.
    const taken = (blk.curtains ?? []).filter((run) =>
        blocks.some((other, i) => i !== j && other.solids.some((s) => inside(s, run.window, EPS))),
      ),
      stripped = (Object.entries(blk.parts) as [BuildingPart, GeometryData][]).map(([name, g]) => {
        const runs = taken.filter((run) => run.part === name);
        if (!runs.length) return [name, g] as const;
        const indices = g.indices!.filter((_, i) => !runs.some((r) => i >= 3 * r.from && i < 3 * r.to));
        return [name, { ...g, indices }] as const;
      });
    const pieces = stripped.flatMap(([name, g]) => {
      if (name !== 'interior' || !blk.lining) return [{ name, g, indoor: INDOOR.has(name), lining: false }];
      // The outer walls' inside faces come first in the interior part.
      const end = 3 * blk.lining;
      return [
        { name, g: { ...g, indices: g.indices!.slice(0, end) }, indoor: false, lining: true },
        { name, g: { ...g, indices: g.indices!.slice(end) }, indoor: true, lining: false },
      ];
    });
    for (const { name, g, indoor, lining } of pieces) {
      // A wall goes where another block's solid is. Its inside face goes only where that block has a room, so walls two
      // blocks share keep one face to each side; floors and fittings also give way only to a room, so floors run on
      // through a join and abut exactly (a margin would leave a crack).
      const cutters = blocks.flatMap((other, i) =>
        i === j || (indoor && first[i] > first[j])
          ? []
          : (indoor || lining ? other.inner : other.solids).map((s) => ({
              s,
              eps: indoor ? 0 : i < j ? EPS : -EPS,
            })),
      );
      // A sunk flight's well opens the floor and base it stands in.
      if (name === 'base' || (name === 'interior' && !lining))
        for (const w of joins.wells) if (w.block === j) cutters.push({ s: boxSolid(w.min, w.max), eps: 0 });
      const cut = subtract(g, cutters);
      if (cut.indices!.length) (merged[name] ??= []).push(cut);
    }
  });
  const add = (name: BuildingPart, g: GeometryData) => {
    if (g.indices!.length) (merged[name] ??= []).push(g);
  };
  // The joins' walls give way to rooms that come before theirs.
  for (const w of joins.walls) {
    const before = blocks.flatMap((q, i) => (first[i] < first[w.first] ? q.inner.map((s) => ({ s, eps: 0 })) : []));
    add('interior', subtract(w.mesh.finish(), before));
  }
  if (joins.steps.triangles) add('stairs', joins.steps.finish());
  if (joins.rails.triangles) add('metalwork', joins.rails.finish());
  const parts: Partial<Record<BuildingPart, GeometryData>> = {};
  for (const [name, list] of Object.entries(merged) as [BuildingPart, GeometryData[]][])
    parts[name] = concat(list, origin, yaw);
  // Results back in world terms.
  const c = Math.cos(yaw),
    sn = Math.sin(yaw),
    world = (x: number, z: number): [number, number] => [origin[0] + x * c + z * sn, origin[2] - x * sn + z * c],
    unworld = (X: number, Z: number): [number, number] => {
      const dx = X - origin[0],
        dz = Z - origin[2];
      return [dx * c - dz * sn, dx * sn + dz * c];
    },
    insideBlock = (index: number, x: number, y: number, z: number, eps = 0) =>
      blocks[index].solids.some((s) => inside(s, [x, y, z], eps));
  const hiddenBy = (j: number, p: V3) =>
    blocks.some((_, i) => i !== j && insideBlock(i, p[0], p[1], p[2], i < j ? EPS : -EPS));
  const openings: BuildingOpening[] = [];
  blocks.forEach((blk, j) => {
    for (const op of blk.building?.openings ?? []) {
      const [x, z] = unworld(op.centre[0], op.centre[2]);
      if (hiddenBy(j, [x, op.centre[1], z])) continue;
      const [X, Z] = world(op.centre[0], op.centre[2]);
      openings.push({ ...op, centre: [X, origin[1] + op.centre[1], Z] });
    }
  });
  const dormerOut = dormerList.map((dm) => {
    const [X, Z] = world(dm.window.centre[0], dm.window.centre[2]);
    const window = {
      ...dm.window,
      centre: [X, origin[1] + dm.window.centre[1], Z] as const,
    };
    openings.push(window);
    return { window, roofAtFace: dm.roofAtFace };
  });
  const earlier = (j: number, p: V3) =>
    blocks.some((q, i) => first[i] < first[j] && p[1] < q.info.eaves && insideBlock(i, p[0], p[1], p[2], EPS));
  const rooms: BuildingRoom[] = [],
    furniture: BuildingFurniture[] = [],
    doorways: BuildingDoorway[] = [],
    stairs: BuildingStair[] = [];
  blocks.forEach((blk, j) => {
    const b = blk.building;
    if (!b) return;
    const sp = specs[j],
      yb = (sp.turn * Math.PI) / 2,
      cb = Math.cos(yb),
      sb = Math.sin(yb),
      plan2 = (x: number, z: number): [number, number] => [sp.at[0] + x * cb + z * sb, sp.at[2] - x * sb + z * cb];
    for (const r of b.rooms) {
      const a = plan2(r.min[0], r.min[1]),
        e = plan2(r.max[0], r.max[1]),
        min: [number, number] = [Math.min(a[0], e[0]), Math.min(a[1], e[1])],
        max: [number, number] = [Math.max(a[0], e[0]), Math.max(a[1], e[1])];
      // A room goes only where nothing of it shows: it lies wholly within a room of a block that comes first.
      const gone = blocks.some(
        (q, i) =>
          first[i] < first[j] &&
          [min[0], max[0]].every((x) =>
            [min[1], max[1]].every((z) => q.inner.some((s) => inside(s, [x, r.level + 0.5, z], EPS))),
          ),
      );
      if (gone) continue;
      rooms.push({ ...r, min, max });
    }
    for (const f of b.furniture) {
      const a = plan2(f.min[0], f.min[2]),
        e = plan2(f.max[0], f.max[2]),
        min: [number, number, number] = [Math.min(a[0], e[0]), f.min[1], Math.min(a[1], e[1])],
        max: [number, number, number] = [Math.max(a[0], e[0]), f.max[1], Math.max(a[1], e[1])];
      if (earlier(j, [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2])) continue;
      furniture.push({ ...f, min, max });
    }
    for (const t of b.stairs) {
      const a = plan2(t.min[0], t.min[1]),
        e = plan2(t.max[0], t.max[1]),
        min: [number, number] = [Math.min(a[0], e[0]), Math.min(a[1], e[1])],
        max: [number, number] = [Math.max(a[0], e[0]), Math.max(a[1], e[1])];
      stairs.push({ ...t, min, max, foot: plan2(t.foot[0], t.foot[1]), head: plan2(t.head[0], t.head[1]) });
    }
    for (const d of b.doorways) {
      const [x, z] = plan2(d.centre[0], d.centre[2]);
      if (earlier(j, [x, d.centre[1], z])) continue;
      doorways.push({
        ...d,
        centre: [x, d.centre[1], z],
        normal: sp.turn % 2 ? (d.normal === 'x' ? 'z' : 'x') : d.normal,
      });
    }
  });
  const infos = blocks.map((blk) => ({
    ...blk.info,
    footprint: blk.info.footprint.map(([x, z]) => {
      // Building footprints came out in plan-local terms (each block placed in the plan); dormers' too.
      return world(x, z);
    }),
  }));
  doorways.push(...joins.doorways);
  return {
    parts,
    palette: main.palette,
    blocks: infos,
    top: Math.max(...infos.map((b) => b.top)),
    openings,
    dormers: dormerOut,
    rooms,
    furniture,
    doorways,
    stairs,
    joinSteps: joins.joinSteps,
    roofHeight(x: number, z: number) {
      let best = -Infinity;
      for (const blk of blocks) {
        const h = blk.roof(x, z);
        if (Number.isFinite(h) && h > best) best = h;
      }
      return best === -Infinity ? NaN : best;
    },
    insideBlock: (index, x, y, z) => insideBlock(index, x, y, z),
  };
}
