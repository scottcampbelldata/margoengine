// The climbing wall as data: its profile, slabs, volumes, holds and routes. No engine imports, so Node tests read it and
// the page builds meshes from it. Units are metres, +Y up, +Z out of the wall toward the room. The climber faces -Z.

export type Point = [number, number, number];

/** The wall profile, walked from the floor up: height y, then distance z out of the wall. */
const PROFILE: readonly (readonly [number, number])[] = [
  [0, 0],
  [1.75, 0],
  [3.25, 0.95],
  [4.05, 0.95],
];
export const WALL_HALF_WIDTH = 2.7;
export const WALL_THICKNESS = 0.14;
/** Top of the mat. Feet standing on it are this high. */
export const MAT_TOP = 0.12;

const lengths = PROFILE.slice(1).map((p, i) => Math.hypot(p[0] - PROFILE[i][0], p[1] - PROFILE[i][1]));
/** Length of the profile from the floor to the top of the wall. */
export const WALL_LENGTH = lengths.reduce((a, b) => a + b, 0);

/** Position and outward normal at `x` across the wall and `s` metres up the profile. */
export function surface(x: number, s: number, outPoint: Point = [0, 0, 0], outNormal: Point = [0, 0, 0]): Point {
  let rest = Math.max(0, Math.min(WALL_LENGTH, s)),
    i = 0;
  while (i < lengths.length - 1 && rest > lengths[i]) rest -= lengths[i++];
  const a = PROFILE[i],
    b = PROFILE[i + 1],
    t = rest / lengths[i];
  outPoint[0] = x;
  outPoint[1] = a[0] + (b[0] - a[0]) * t;
  outPoint[2] = a[1] + (b[1] - a[1]) * t;
  outNormal[0] = 0;
  outNormal[1] = -(b[1] - a[1]) / lengths[i];
  outNormal[2] = (b[0] - a[0]) / lengths[i];
  return outPoint;
}

/** The wall's surface z at height `y`; writes the outward normal at that height. */
export function wallAt(y: number, outNormal: Point): number {
  let i = 0;
  while (i < PROFILE.length - 2 && y > PROFILE[i + 1][0]) i++;
  const a = PROFILE[i],
    b = PROFILE[i + 1],
    length = lengths[i],
    t = Math.max(0, Math.min(1, (y - a[0]) / (b[0] - a[0])));
  outNormal[0] = 0;
  outNormal[1] = -(b[1] - a[1]) / length;
  outNormal[2] = (b[0] - a[0]) / length;
  return a[1] + (b[1] - a[1]) * t;
}

/**
 * The wall's outward normal `above` metres over a point. For per-frame callers: a height computed by the caller and passed
 * to `wallAt` is a double crossing a call, and V8 boxes those, once per frame.
 */
export function wallNormalAbove(point: ArrayLike<number>, above: number, outNormal: Point): void {
  let i = 0;
  while (i < PROFILE.length - 2 && point[1] + above > PROFILE[i + 1][0]) i++;
  outNormal[0] = 0;
  outNormal[1] = -(PROFILE[i + 1][1] - PROFILE[i][1]) / lengths[i];
  outNormal[2] = (PROFILE[i + 1][0] - PROFILE[i][0]) / lengths[i];
}

/** The eight corners of each wall slab, flat x y z values, thickness behind the climbing face. */
export function wallSlabs(): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const a = PROFILE[i],
      b = PROFILE[i + 1],
      ny = -(b[1] - a[1]) / lengths[i],
      nz = (b[0] - a[0]) / lengths[i],
      corners: number[] = [];
    for (const x of [-WALL_HALF_WIDTH, WALL_HALF_WIDTH])
      for (const p of [a, b]) for (const d of [0, -WALL_THICKNESS]) corners.push(x, p[0] + ny * d, p[1] + nz * d);
    out.push(corners);
  }
  return out;
}

/** A climbing volume: a low plywood ridge bolted to the wall, as hull corners. */
export interface Volume {
  x: number;
  s: number;
  width: number;
  height: number;
  depth: number;
  corners: number[];
}
export function volume(x: number, s: number, width: number, height: number, depth: number): Volume {
  const n: Point = [0, 0, 0],
    corners: number[] = [],
    p: Point = [0, 0, 0];
  for (const [dx, ds] of [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [-width / 2, height / 2],
    [width / 2, height / 2],
  ]) {
    surface(x + dx, s + ds, p, n);
    corners.push(p[0], p[1], p[2]);
  }
  for (const dx of [-width * 0.3, width * 0.3]) {
    surface(x + dx, s + height * 0.15, p, n);
    corners.push(p[0] + n[0] * depth, p[1] + n[1] * depth, p[2] + n[2] * depth);
  }
  return { x, s, width, height, depth, corners };
}
export const VOLUMES: readonly Volume[] = [
  volume(-1.8, 1.05, 0.8, 0.8, 0.26),
  volume(1.8, 1.5, 0.95, 0.75, 0.3),
  volume(0.2, 3.3, 0.8, 0.6, 0.2),
];

export const COLOURS = ['#2f9e5b', '#2f6fd0', '#d4432f', '#e6b422', '#e9e4d8'] as const;
export type RouteName = 'green' | 'blue' | 'red';
const ROUTE_COLOUR: Record<RouteName, number> = { green: 0, blue: 1, red: 2 };

/** Which limb a move uses, by index into the climber's four contacts. */
export const LEFT_HAND = 0;
export const RIGHT_HAND = 1;
export const LEFT_FOOT = 2;
export const RIGHT_FOOT = 3;

export interface Hold {
  x: number;
  s: number;
  /** Centre of the hold, sitting on the wall. */
  position: Point;
  /** The wall's outward normal under the hold. */
  normal: Point;
  /** Radius of the hold, metres; the pick test and the mesh use it. */
  radius: number;
  /** Index into COLOURS. */
  colour: number;
  /** The route this hold belongs to, or null for a filler hold. */
  route: RouteName | null;
  /** Which fractured chunk this hold takes. */
  shape: number;
  /** Turn of the chunk about the wall normal, radians. */
  turn: number;
}
export interface Move {
  limb: number;
  hold: number;
}
export interface Route {
  name: RouteName;
  /** Holds the two hands start on; the feet start on the mat. */
  start: [number, number];
  moves: Move[];
}

// A route is a list of [limb, x, s]. Each entry adds a hold and a move to it. tests/boulder-climb.test.js checks that
// every stance has a pelvis that reaches all four contacts with both knees under the armour's limit.
type Step = readonly [number, number, number];
/**
 * A ladder of moves up the wall from a centre line: two hands, then two feet, each cycle `rise` metres higher. The hands
 * stay about 1.3 m up the profile from the feet, where the rig's legs and arms are both comfortably inside their reach.
 * Each hand's holds sit outside its shoulder, so a straight arm passes beside the head and not into it. `wobble` shifts
 * each cycle sideways so a route is not a straight line.
 */
function ladder(
  cx: number,
  cycles: number,
  rise: number,
  wobble: readonly number[],
): { start: [Step, Step]; steps: Step[] } {
  const steps: Step[] = [],
    jog = (i: number) => wobble[i % wobble.length];
  for (let i = 0; i < cycles; i++) {
    const footS = 0.14 + i * rise,
      handS = 1.64 + i * rise,
      x = cx + jog(i);
    steps.push([LEFT_HAND, x - 0.28, handS + 0.04]);
    steps.push([RIGHT_HAND, x + 0.28, handS - 0.04]);
    steps.push([LEFT_FOOT, x - 0.22, footS + 0.04]);
    steps.push([RIGHT_FOOT, x + 0.22, footS + 0.12]);
  }
  return {
    start: [
      [LEFT_HAND, cx - 0.28, 1.44],
      [RIGHT_HAND, cx + 0.28, 1.36],
    ],
    steps,
  };
}
const ROUTE_STEPS: Record<RouteName, { start: [Step, Step]; steps: Step[] }> = {
  green: ladder(-0.8, 4, 0.2, [0, 0.05, -0.04]),
  blue: ladder(0.05, 5, 0.2, [0, -0.06, 0.05, 0]),
  red: ladder(0.9, 7, 0.2, [0, 0.05, -0.05, 0.04, 0]),
};

// Seeded so the wall is the same on every load (mulberry32).
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Number of different hold shapes the gym builds; `Hold.shape` indexes them. */
export const SHAPES = 16;

/** Builds the wall's holds and routes. Pure: the same data on every call. */
export function buildWall(fillerCount = 40): { holds: Hold[]; routes: Route[] } {
  const rand = random(0x4d41),
    holds: Hold[] = [],
    routes: Route[] = [];
  const add = (x: number, s: number, radius: number, colour: number, route: RouteName | null): number => {
    const position: Point = [0, 0, 0],
      normal: Point = [0, 0, 0];
    surface(x, s, position, normal);
    holds.push({
      x,
      s,
      position,
      normal,
      radius,
      colour,
      route,
      shape: Math.floor(rand() * SHAPES),
      turn: rand() * Math.PI * 2,
    });
    return holds.length - 1;
  };
  for (const name of ['green', 'blue', 'red'] as RouteName[]) {
    const data = ROUTE_STEPS[name],
      size = (limb: number) => (limb === LEFT_FOOT || limb === RIGHT_FOOT ? 0.06 : 0.08),
      hold = (step: Step) => add(step[1], step[2], size(step[0]), ROUTE_COLOUR[name], name);
    routes.push({
      name,
      start: [hold(data.start[0]), hold(data.start[1])],
      moves: data.steps.map((step) => ({ limb: step[0], hold: hold(step) })),
    });
  }
  const wanted = holds.length + fillerCount;
  let tries = 0;
  while (holds.length < wanted && tries++ < 4000) {
    const x = (rand() * 2 - 1) * (WALL_HALF_WIDTH - 0.25),
      s = 0.3 + rand() * (WALL_LENGTH - 0.5),
      radius = 0.055 + rand() * 0.035,
      p: Point = [0, 0, 0];
    surface(x, s, p);
    const clear =
      holds.every((h) => Math.hypot(h.position[0] - p[0], h.position[1] - p[1], h.position[2] - p[2]) > 0.3) &&
      VOLUMES.every((v) => Math.abs(v.x - x) > v.width / 2 + 0.08 || Math.abs(v.s - s) > v.height / 2 + 0.08);
    if (clear) add(x, s, radius, 3 + (rand() < 0.5 ? 1 : 0), null);
  }
  return { holds, routes };
}

/** Index of the hold nearest a ray, within `slack` metres of its radius, or -1. The direction must be unit length. */
export function pickHold(
  holds: readonly Hold[],
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  slack: number,
): number {
  let best = -1,
    bestGap = Infinity;
  for (let i = 0; i < holds.length; i++) {
    const h = holds[i],
      px = h.position[0] - ox,
      py = h.position[1] - oy,
      pz = h.position[2] - oz,
      along = px * dx + py * dy + pz * dz;
    if (along <= 0) continue;
    const gap = Math.hypot(px - dx * along, py - dy * along, pz - dz * along) - h.radius;
    if (gap < slack && gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return best;
}
