// A humanoid skeleton placed inside a mesh nobody rigged, then weighted. Our own method, in the spirit of I. Baran and
// J. Popovic, "Automatic rigging and animation of 3D characters", SIGGRAPH 2007, which embeds a skeleton in a mesh's
// medial surface; this one reads the skeleton off the solid instead of fitting one. The mesh is voxelized (the grid of
// geodesic voxel binding), a distance transform gives how deep each voxel sits, and farthest point sampling through the
// solid finds its tips. One shortest path tree from the head tip, priced to stay deep inside, reaches both feet and both
// hands: where those paths part is the pelvis and the shoulders. Joints go along the paths by body proportion (D. Winter,
// "Biomechanics and Motor Control of Human Movement", segment lengths), moved to the narrowest point nearby for wrists
// and the neck. Left and right pairs are then evened across the body's centre. Weights come from voxel binding, which
// takes the broken and many-part meshes real files are made of.
import { checkRig, type RigJoint, type RigPose } from './rig.js';
import { weld, type WeightMesh } from './mesh.js';
import type { WeightMap } from './weight-map.js';
import { fill, Heap, makeGrid, markTriangles, NEIGHBOURS, OUTSIDE, votes, type Grid } from './voxels.js';
import { voxelWeights } from './voxel-weights.js';
import { MargoError } from '@margoengine/math/errors';

type Vec3 = [number, number, number];

/** Options for {@link autoRig}. */
export interface AutoRigOptions {
  /** Voxels along the mesh's longest side, 32 to 384 (default 128). Fingers and thin arms need more. */
  resolution?: number;
  /** The mesh's up direction (default `[0, 1, 0]`, glTF's). */
  up?: readonly [number, number, number];
  /** The way the figure faces. Default: read from the feet. */
  forward?: readonly [number, number, number];
  /** Closes gaps up to this many voxels before filling, joining parts that nearly touch (default 1). */
  closing?: number;
  /** Evens left and right joints across the body's centre when they already nearly agree (default true). */
  symmetric?: boolean;
  /** `voxel` (default) weights the mesh with `voxelWeights`; with `none`, weight `joints` with any solver. */
  weights?: 'voxel' | 'none';
  /** Welding tolerance as a fraction of the mesh's size (default 1e-6: coincident vertices). */
  weld?: number;
  /** Cancels the fit between stages and the weights between bones; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** What {@link autoRig} found. */
export interface AutoRig {
  /** The skeleton in the mesh's space, parents first, ready for the weight solvers and `@margoengine/exporters/skin`. */
  readonly joints: readonly RigJoint[];
  /** Each bone's index in `joints`, by VRM humanoid name: `hips`, `leftUpperArm` and so on. */
  readonly humanoid: Readonly<Record<string, number>>;
  /** The same skeleton as local transforms with no rotation, for `retargetRig` style tools. */
  readonly pose: RigPose;
  /** Weights over the input vertices; null with `weights: 'none'`. */
  readonly weights: WeightMap | null;
  /** The way the figure faces, in the mesh's space. */
  readonly forward: readonly [number, number, number];
  /** False when the feet gave no clear facing and +z of the frame was assumed: left and right may be swapped. */
  readonly facingFound: boolean;
  /** Solid voxels the fit saw. */
  readonly voxels: number;
}

/** Share of the height two tips must be apart through the solid to count as two. */
const TIP_GAP = 0.09;
const MAX_TIPS = 14;
/** Share of the height of the slab at the sole that finds the feet. */
const SOLE = 0.03;
/** Where along shoulder to fingertip the elbow and the wrist sit. Winter's upper arm 0.186, forearm 0.146, hand 0.108 of height. */
const ELBOW = 0.423;
const WRIST = 0.755;
/** Where along hip to ankle the knee sits: thigh 0.245, shin 0.246. */
const KNEE = 0.5;
/** Height of the ankle over the sole, as a share of the leg. */
const ANKLE = 0.085;
/** Cosine of the turn, two degrees, from which a figure is voxelized again square to the grid. */
const SQUARE = 0.9994;
const MIN_RESOLUTION = 32;
const MAX_RESOLUTION = 384;

const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: readonly number[], b: readonly number[], s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const mix = (a: readonly number[], b: readonly number[], t: number): Vec3 => add(a, sub(b, a), t);
const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: readonly number[]): number => Math.hypot(a[0], a[1], a[2]);
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: readonly number[]): Vec3 => {
  const l = length(a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** A direction laid flat in the frame's ground plane. */
const flat = (a: readonly number[]): Vec3 => unit([a[0], 0, a[2]]);

/** The grid's solid as a mask, and the distance of each solid voxel from outside, in voxels. */
interface Solid {
  readonly grid: Grid;
  readonly mask: Uint8Array;
  readonly depth: Float32Array;
  readonly count: number;
}

/** Keeps the largest 26-connected part of `mask`. */
function largestPart(grid: Grid, mask: Uint8Array): number {
  const { nx, ny } = grid,
    label = new Int32Array(mask.length),
    stack: number[] = [];
  let best = 0,
    bestSize = 0,
    next = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i]) continue;
    let size = 0;
    label[i] = ++next;
    stack.push(i);
    while (stack.length) {
      const at = stack.pop()!;
      size++;
      for (const [dx, dy, dz] of NEIGHBOURS) {
        const j = at + dx + nx * (dy + ny * dz);
        if (mask[j] && !label[j]) {
          label[j] = next;
          stack.push(j);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  for (let i = 0; i < mask.length; i++) if (label[i] !== best) mask[i] = 0;
  return bestSize;
}

/** Two pass chamfer distance from outside, 26 neighbours. */
function depthOf(grid: Grid, mask: Uint8Array): Float32Array {
  const { nx, ny, nz } = grid,
    depth = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) depth[i] = mask[i] ? 1e9 : 0;
  const pass = (forward: boolean): void => {
    const half = NEIGHBOURS.filter(([dx, dy, dz]) => {
      const before = dz < 0 || (dz === 0 && (dy < 0 || (dy === 0 && dx < 0)));
      return before === forward;
    }).map(([dx, dy, dz, l]) => [dx + nx * (dy + ny * dz), l] as const);
    const step = forward ? 1 : -1;
    for (let z = forward ? 1 : nz - 2; z > 0 && z < nz - 1; z += step)
      for (let y = forward ? 1 : ny - 2; y > 0 && y < ny - 1; y += step)
        for (let x = forward ? 1 : nx - 2; x > 0 && x < nx - 1; x += step) {
          const i = x + nx * (y + ny * z);
          if (!mask[i]) continue;
          let d = depth[i];
          for (const [offset, l] of half) {
            const v = depth[i + offset] + l;
            if (v < d) d = v;
          }
          depth[i] = d;
        }
  };
  pass(true);
  pass(false);
  return depth;
}

/** Shortest paths through the solid from `start`; `price` multiplies a step's length by where it lands. */
function paths(solid: Solid, start: number, price?: Float32Array): { distance: Float64Array; from: Int32Array } {
  const { grid, mask } = solid,
    { nx, ny } = grid,
    offsets = NEIGHBOURS.map(([dx, dy, dz, l]) => [dx + nx * (dy + ny * dz), l] as const),
    distance = new Float64Array(mask.length).fill(Infinity),
    from = new Int32Array(mask.length).fill(-1),
    heap = new Heap();
  distance[start] = 0;
  heap.push(0, start);
  while (heap.size) {
    heap.pop();
    const i = heap.item,
      d = heap.key;
    if (d > distance[i]) continue;
    for (const [offset, l] of offsets) {
      const j = i + offset;
      if (!mask[j]) continue;
      const next = d + l * (price ? price[j] : 1);
      if (next < distance[j]) {
        distance[j] = next;
        from[j] = i;
        heap.push(next, j);
      }
    }
  }
  return { distance, from };
}

/** The voxels from the tree's root to `to`, root first. */
function walk(from: Int32Array, to: number): number[] {
  const out: number[] = [];
  for (let at = to; at !== -1; at = from[at]) out.push(at);
  return out.reverse();
}

/** A line through the solid in voxel coordinates, smoothed, with arc lengths and depths. */
interface Line {
  readonly points: Vec3[];
  readonly along: number[];
  readonly depth: number[];
}

function line(solid: Solid, voxels: readonly number[]): Line {
  const { nx, ny } = solid.grid,
    raw = voxels.map((i): Vec3 => [i % nx, ((i / nx) | 0) % ny, (i / (nx * ny)) | 0]),
    reach = 3,
    points = raw.map((_, k) => {
      const low = Math.max(0, k - reach),
        high = Math.min(raw.length - 1, k + reach),
        // A window that stays even around k, so the ends stay where they are.
        span = Math.min(k - low, high - k),
        sum: Vec3 = [0, 0, 0];
      for (let j = k - span; j <= k + span; j++) for (let c = 0; c < 3; c++) sum[c] += raw[j][c];
      return sum.map((v) => v / (span * 2 + 1)) as Vec3;
    }),
    along = [0];
  for (let k = 1; k < points.length; k++) along.push(along[k - 1] + length(sub(points[k], points[k - 1])));
  return { points, along, depth: voxels.map((i) => solid.depth[i]) };
}

/** The point at arc length `s` of a line. */
function at(path: Line, s: number): Vec3 {
  const { points, along } = path;
  if (s <= 0) return points[0];
  let k = 1;
  while (k < along.length - 1 && along[k] < s) k++;
  const span = along[k] - along[k - 1];
  return mix(points[k - 1], points[k], span > 0 ? Math.min(1, (s - along[k - 1]) / span) : 0);
}

/** Index where two walks from the same root part. */
function fork(a: readonly number[], b: readonly number[]): number {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k - 1;
}

const fail = (fix: string): MargoError => new MargoError('failed', `autoRig found no humanoid here; ${fix}`);

/** The figure's facts in voxel coordinates, before any joint goes down. */
interface Body {
  readonly centre: Vec3;
  readonly side: Vec3;
  readonly height: number;
  readonly sole: number;
  /** Foot voxels, the one against `side` first. */
  readonly feet: readonly [number[], number[]];
}

/** The sole, the height, and the feet: they give the body's centre and the line across it, which a long arm or a backpack cannot pull. */
function measure(solid: Solid, side?: Vec3): Body {
  const { grid, mask } = solid,
    { nx, ny } = grid;
  let low = Infinity,
    high = -Infinity;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const y = ((i / nx) | 0) % ny;
    if (y < low) low = y;
    if (y > high) high = y;
  }
  const height = high - low + 1,
    parts = slab(solid, low, height);
  if (parts.length < 2 || parts[1].length < 0.1 * parts[0].length)
    throw fail('stand it upright on two separate feet, or pass up.');
  const mid = (part: readonly number[]): Vec3 => {
      const sum: Vec3 = [0, 0, 0];
      for (const i of part) {
        sum[0] += i % nx;
        sum[1] += ((i / nx) | 0) % ny;
        sum[2] += (i / (nx * ny)) | 0;
      }
      return sum.map((v) => v / part.length) as Vec3;
    },
    a = mid(parts[0]),
    b = mid(parts[1]),
    across = side ?? unit([b[0] - a[0], 0, b[2] - a[2]]),
    sign = dot(sub(b, a), across) >= 0 ? 1 : -1;
  return {
    centre: mix(a, b, 0.5),
    side: across,
    height,
    sole: low,
    feet: sign > 0 ? [parts[0], parts[1]] : [parts[1], parts[0]],
  };
}

/** Farthest point sampling through the solid, from its deepest voxel. */
function tips(solid: Solid, height: number): number[] {
  const { depth, mask } = solid;
  let deepest = 0;
  for (let i = 0; i < mask.length; i++) if (depth[i] > depth[deepest]) deepest = i;
  const near = paths(solid, deepest).distance,
    found: number[] = [],
    gap = TIP_GAP * height;
  while (found.length < MAX_TIPS) {
    let best = -1,
      far = gap;
    for (let i = 0; i < near.length; i++)
      if (near[i] > far && near[i] < Infinity) {
        far = near[i];
        best = i;
      }
    if (best < 0) break;
    found.push(best);
    const other = paths(solid, best).distance;
    for (let i = 0; i < near.length; i++) if (other[i] < near[i]) near[i] = other[i];
  }
  return found;
}

/** The parts of the slab at the sole: two when the feet stand apart, and the two largest when more touch the ground. */
function slab(solid: Solid, sole: number, height: number): number[][] {
  const { grid, mask } = solid,
    { nx, ny } = grid,
    top = sole + Math.max(1, SOLE * height),
    seen = new Uint8Array(mask.length),
    parts: number[][] = [];
  const inSlab = (i: number): boolean => mask[i] === 1 && (((i / nx) | 0) % ny) <= top;
  for (let i = 0; i < mask.length; i++) {
    if (!inSlab(i) || seen[i]) continue;
    const part: number[] = [],
      stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const at = stack.pop()!;
      part.push(at);
      for (const [dx, dy, dz] of NEIGHBOURS) {
        const j = at + dx + nx * (dy + ny * dz);
        if (inSlab(j) && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    parts.push(part);
  }
  return parts.sort((a, b) => b.length - a.length);
}

/** The voxel of `voxels` nearest `point`. */
function nearest(solid: Solid, voxels: readonly number[], point: readonly number[]): number {
  const { nx, ny } = solid.grid;
  let best = voxels[0],
    far = Infinity;
  for (const i of voxels) {
    const d = length(sub([i % nx, ((i / nx) | 0) % ny, (i / (nx * ny)) | 0], point));
    if (d < far) {
      far = d;
      best = i;
    }
  }
  return best;
}

/** A cut through the solid at `point` across `normal`: how many voxels it holds and their middle. */
function section(solid: Solid, point: readonly number[], normal: readonly number[], reach: number): { area: number; middle: Vec3 } {
  const { grid, mask } = solid,
    { nx, ny } = grid,
    x0 = Math.round(point[0]),
    y0 = Math.round(point[1]),
    z0 = Math.round(point[2]),
    start = x0 + nx * (y0 + ny * z0),
    seen = new Set<number>(),
    stack: number[] = [],
    sum: Vec3 = [0, 0, 0];
  if (!mask[start]) return { area: 0, middle: [point[0], point[1], point[2]] };
  seen.add(start);
  stack.push(start);
  let area = 0;
  while (stack.length) {
    const i = stack.pop()!,
      p: Vec3 = [i % nx, ((i / nx) | 0) % ny, (i / (nx * ny)) | 0];
    area++;
    sum[0] += p[0];
    sum[1] += p[1];
    sum[2] += p[2];
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const j = i + dx + nx * (dy + ny * dz);
      if (!mask[j] || seen.has(j)) continue;
      const d = sub([p[0] + dx, p[1] + dy, p[2] + dz], point);
      if (Math.abs(dot(d, normal)) > 0.75 || length(d) > reach) continue;
      seen.add(j);
      stack.push(j);
    }
  }
  return { area, middle: sum.map((v) => v / area) as Vec3 };
}

/** The highest height with a gap between the two legs, down from where their paths part. */
function crotchOf(solid: Solid, a: Line, b: Line, sole: number): number {
  const { grid, mask } = solid,
    { nx, ny } = grid,
    onLine = (path: Line, y: number): Vec3 => {
      for (const p of path.points) if (p[1] <= y) return p;
      return path.points[path.points.length - 1];
    };
  for (let y = Math.floor(Math.min(a.points[0][1], b.points[0][1])); y > sole; y--) {
    const from = onLine(a, y),
      to = onLine(b, y),
      steps = Math.ceil(length(sub(to, from)) * 2);
    for (let k = 1; k < steps; k++) {
      const p = mix(from, to, k / steps);
      if (!mask[Math.round(p[0]) + nx * (y + ny * Math.round(p[2]))]) return y + 1;
    }
  }
  return sole;
}

const UP: Vec3 = [0, 1, 0];
/** The cut across an arm has reached the chest when it is this many times the arm's own. */
const GROWN = 1.7;
/** The same for the arm's own line, whose cut takes in the deltoid first. */
const CHEST = 3.2;
/** Nearest a shoulder may come to the body's centre, as a share of height. */
const MIN_SHOULDER = 0.07;
/** Heads in a figure's height from which it counts as adult, and where such a figure's crotch sits as a share of height. */
const ADULT_HEADS = 4.5;
const CROTCH = 0.48;
/** How many arm radii past the armpit the shoulder's ball sits. */
const IN_SHOULDER = 1.5;

/** A limb's line with each sample moved to the middle of the cut across it, and the area of that cut. */
function centred(solid: Solid, path: Line, reach: number): { line: Line; area: number[] } {
  const n = path.points.length,
    area: number[] = [],
    points: Vec3[] = [];
  for (let k = 0; k < n; k++) {
    const dir = unit(sub(path.points[Math.min(n - 1, k + 3)], path.points[Math.max(0, k - 3)])),
      cut = section(solid, path.points[k], dir, reach);
    area.push(cut.area);
    points.push(cut.area ? cut.middle : path.points[k]);
  }
  const along = [0];
  for (let k = 1; k < n; k++) along.push(along[k - 1] + length(sub(points[k], points[k - 1])));
  return { line: { points, along, depth: path.depth }, area };
}

/** The named joints in voxel coordinates, each side given by its sign along `body.side`. */
function place(solid: Solid, body: Body, forwardHint: Vec3 | null) {
  const { grid } = solid,
    { nx, ny } = grid,
    { height, sole, side, centre } = body,
    xyz = (i: number): Vec3 => [i % nx, ((i / nx) | 0) % ny, (i / (nx * ny)) | 0],
    across = (p: readonly number[]): number => dot(sub(p, centre), side),
    found = tips(solid, height);
  const head = found.reduce((best, tip) => {
    const score = (i: number): number => xyz(i)[1] - 1.5 * Math.abs(across(xyz(i)));
    return score(tip) > score(best) ? tip : best;
  }, found[0]);
  if (head === undefined) throw fail('the solid has no tips; raise resolution.');
  const toFoot = (voxels: number[]): { voxels: number[]; middle: Vec3 } => {
      const sum: Vec3 = [0, 0, 0];
      for (const i of voxels) for (let c = 0; c < 3; c++) sum[c] += xyz(i)[c];
      return { voxels, middle: sum.map((v) => v / voxels.length) as Vec3 };
    },
    footA = toFoot(body.feet[0]),
    footB = toFoot(body.feet[1]),
    goalA = nearest(solid, footA.voxels, footA.middle),
    goalB = nearest(solid, footB.voxels, footB.middle);
  // Deep voxels are cheap, so paths run down the middle of each limb. The scale is about a forearm's radius.
  const inner = 0.022 * height,
    price = new Float32Array(solid.depth.length);
  for (let i = 0; i < price.length; i++) {
    const d = solid.depth[i];
    if (d > 0) price[i] = 1 + (inner / d) * (inner / d) * 4;
  }
  const tree = paths(solid, head, price).from,
    legA = walk(tree, goalA),
    legB = walk(tree, goalB);
  if (legA.length < 2 || legB.length < 2) throw fail('join the parts of the figure, or raise closing.');
  const parted = fork(legA, legB),
    crotch = crotchOf(solid, line(solid, legA.slice(parted)), line(solid, legB.slice(parted)), sole);
  // The hands: the pair of tips above the legs that best mirror each other, widest first, so a third arm or a sword does
  // not pass for one.
  const high = found.filter((tip) => tip !== head && xyz(tip)[1] > crotch - 0.1 * height),
    mirrored = (p: Vec3): Vec3 => add(p, side, -2 * across(p));
  let handA = -1,
    handB = -1,
    bestPair = Infinity;
  for (const a of high)
    for (const b of high) {
      if (across(xyz(a)) >= 0 || across(xyz(b)) <= 0) continue;
      const score = length(sub(mirrored(xyz(a)), xyz(b))) - 0.25 * (across(xyz(b)) - across(xyz(a)));
      if (score < bestPair) {
        bestPair = score;
        handA = a;
        handB = b;
      }
    }
  if (handA < 0) throw fail('hold the arms away from the body, in a T or A pose.');
  const armA = walk(tree, handA),
    armB = walk(tree, handB);
  if (armA.length < 2 || armB.length < 2) throw fail('join the parts of the figure, or raise closing.');
  const reach = 0.3 * height,
    legLineA = centred(solid, line(solid, legA.slice(parted)), reach).line,
    legLineB = centred(solid, line(solid, legB.slice(parted)), reach).line,
    arm = (path: readonly number[], foot: readonly number[]) => {
      const start = fork(path, foot),
        whole = centred(solid, line(solid, path.slice(start).reverse()), reach),
        inward = Math.sign(across(whole.line.points[0])),
        // Tip first, and no further than the body's middle: a path may reach the shoulder from the far side.
        stop = whole.line.points.findIndex((p) => across(p) * inward < MIN_SHOULDER * height),
        limb = whole.line,
        area = whole.area,
        // Where the cut across the arm grows past the arm's own, the arm has reached the chest.
        end = stop > 1 ? limb.along[stop] : limb.along[limb.along.length - 1],
        own = area.filter((_, k) => limb.along[k] > end * 0.3 && limb.along[k] < end * 0.65).sort((a, b) => a - b),
        typical = own[own.length >> 1] ?? 1;
      let root = end;
      for (let k = 0; k + 1 < area.length; k++)
        if (limb.along[k] > end * 0.5 && area[k] > GROWN * typical && area[k + 1] > GROWN * typical) {
          root = Math.min(root, limb.along[k]);
          break;
        }
      // The path bends into the chest, the arm does not: go on along the upper arm's own line until a cut across it
      // reaches the chest or the line leaves the shoulder. The ball sits about an arm's width past the armpit.
      const from = at(limb, root * 0.5),
        axis = unit(sub(at(limb, root * 0.72), from)),
        radius = Math.sqrt(typical / Math.PI);
      let run = 0,
        ended = false;
      for (const limit = end - root * 0.5; run < limit; run += 1) {
        const point = add(from, axis, run),
          cut = section(solid, point, axis, reach);
        // A shoulder stays on its own side of the body and above the legs.
        if (across(point) * inward < MIN_SHOULDER * height || point[1] < crotch) break;
        // A line that only grazes the surface goes on: it has left the shoulder when it stays out a whole arm's width.
        if (!cut.area) {
          let out = 1;
          while (out < 2 * radius && !section(solid, add(point, axis, out), axis, reach).area) out++;
          if (out < 2 * radius) continue;
          run -= radius;
          ended = true;
          break;
        }
        if (run > root * 0.15 && cut.area > CHEST * typical) break;
      }
      if (!ended) run += IN_SHOULDER * radius;
      const ball = add(from, axis, run);
      root = root * 0.5 + run;
      const wrist = thinnestArea(limb, area, root * (1 - WRIST - 0.08), root * (1 - WRIST + 0.08));
      return {
        upper: ball,
        lower: at(limb, wrist + (root - wrist) * (1 - ELBOW / WRIST)),
        hand: at(limb, wrist),
        end: limb.points[0],
      };
    },
    a0 = arm(armA, legA),
    b0 = arm(armB, legB);
  const shoulderY = (a0.upper[1] + b0.upper[1]) / 2,
    onTrunk = trunk(solid, mix(onLeg(legLineA, crotch), onLeg(legLineB, crotch), 0.5), crotch, xyz(head), reach);
  // The neck: the narrowest cut between the shoulders and the top of the head.
  const topY = xyz(head)[1],
    base = section(solid, onTrunk(shoulderY), UP, reach).area;
  let neckY = shoulderY + (topY - shoulderY) * 0.2,
    narrow = base * 0.7;
  for (let y = shoulderY + 0.02 * height; y < shoulderY + (topY - shoulderY) * 0.6; y++) {
    const area = section(solid, onTrunk(y), UP, reach).area;
    if (area > 0 && area < narrow) {
      narrow = area;
      neckY = y;
    }
  }
  // A skirt or coat joins the legs below the crotch. On a figure of adult proportions, seven heads or so, a gap that low
  // is a hem: the crotch goes back to where such a body has it. A big headed figure keeps what it shows.
  const heads = height / Math.max(1, topY - neckY),
    hem = heads > ADULT_HEADS && crotch - sole < CROTCH * 0.95 * height,
    legsEnd = hem ? sole + CROTCH * height : crotch,
    hipY = legsEnd + 0.05 * height;
  const leg = (limb: Line) => {
    // Above a hem the legs cannot be told apart, so each keeps the line it had below it.
    const sample = (y: number): Vec3 => {
        const p = onLeg(limb, Math.min(y, crotch - 0.02 * height));
        return [p[0], y, p[2]];
      },
      thigh = sample(legsEnd - 0.04 * height),
      upper: Vec3 = [thigh[0], hipY, thigh[2]],
      ankleY = sole + ANKLE * (hipY - sole),
      ankle = sample(ankleY),
      knee = sample(ankleY + (hipY - ankleY) * KNEE);
    return { upper, knee, ankle };
  };
  const a = { arm: a0, leg: leg(legLineA) },
    b = { arm: b0, leg: leg(legLineB) };

  // Facing: toes reach past the ankle. A foot's voxels ahead of the ankle against those behind it say which way.
  const ahead = cross(side, UP),
    reachOf = (foot: { voxels: number[] }, ankle: Vec3): number => {
      let front = -Infinity,
        back = Infinity;
      for (const i of foot.voxels) {
        const d = dot(sub(xyz(i), ankle), ahead);
        if (d > front) front = d;
        if (d < back) back = d;
      }
      return front + back;
    },
    pushed = (reachOf(footA, a.leg.ankle) + reachOf(footB, b.leg.ankle)) / 2,
    facingFound = !!forwardHint || Math.abs(pushed) > 0.01 * height,
    forward: Vec3 = forwardHint ?? (pushed >= 0 ? ahead : ([-ahead[0], 0, -ahead[2]] as Vec3));

  const toe = (foot: { voxels: number[] }, ankle: Vec3): { toes: Vec3; end: Vec3 } => {
    let best = foot.voxels[0];
    for (const i of foot.voxels) if (dot(xyz(i), forward) > dot(xyz(best), forward)) best = i;
    const tip = xyz(best),
      flat: Vec3 = [ankle[0], sole + 0.02 * height, ankle[2]];
    return { toes: mix(flat, tip, 0.68), end: tip };
  };
  const hips: Vec3 = [(a.leg.upper[0] + b.leg.upper[0]) / 2, hipY + 0.02 * height, (a.leg.upper[2] + b.leg.upper[2]) / 2];
  const spineY = (t: number): number => hips[1] + (shoulderY - hips[1]) * t,
    headJoint = onTrunk(neckY + 0.012 * height),
    neck = onTrunk(shoulderY + (neckY - shoulderY) * 0.45);
  // The figure's left is up x forward.
  const leftSign = dot(cross(UP, forward), side) > 0 ? 1 : -1,
    left = leftSign > 0 ? b : a,
    right = leftSign > 0 ? a : b,
    leftFoot = leftSign > 0 ? footB : footA,
    rightFoot = leftSign > 0 ? footA : footB,
    clavicle = (upper: Vec3): Vec3 => mix(onTrunk(shoulderY), upper, 0.28);
  const leftToe = toe(leftFoot, left.leg.ankle),
    rightToe = toe(rightFoot, right.leg.ankle);
  const named: [string, string | null, Vec3][] = [
    ['hips', null, hips],
    ['spine', 'hips', onTrunk(spineY(0.25))],
    ['chest', 'spine', onTrunk(spineY(0.55))],
    ['upperChest', 'chest', onTrunk(spineY(0.8))],
    ['neck', 'upperChest', neck],
    ['head', 'neck', headJoint],
    ['headEnd', 'head', xyz(head)],
  ];
  for (const [name, limbs, toes] of [
    ['left', left, leftToe],
    ['right', right, rightToe],
  ] as const) {
    named.push(
      [`${name}Shoulder`, 'upperChest', clavicle(limbs.arm.upper)],
      [`${name}UpperArm`, `${name}Shoulder`, limbs.arm.upper],
      [`${name}LowerArm`, `${name}UpperArm`, limbs.arm.lower],
      [`${name}Hand`, `${name}LowerArm`, limbs.arm.hand],
      [`${name}HandEnd`, `${name}Hand`, limbs.arm.end],
      [`${name}UpperLeg`, 'hips', limbs.leg.upper],
      [`${name}LowerLeg`, `${name}UpperLeg`, limbs.leg.knee],
      [`${name}Foot`, `${name}LowerLeg`, limbs.leg.ankle],
      [`${name}Toes`, `${name}Foot`, toes.toes],
      [`${name}ToesEnd`, `${name}Toes`, toes.end],
    );
  }
  return { named, forward, facingFound };
}

/** The first point of a limb at or below height `y`. */
function onLeg(limb: Line, y: number): Vec3 {
  for (const p of limb.points) if (p[1] <= y) return p;
  return limb.points[limb.points.length - 1];
}

/** The middle of the body at each height, marched up from the crotch: each cut starts from the last, and deep voxels count most, so arms and hair pull it little. */
function trunk(solid: Solid, start: Vec3, crotch: number, top: Vec3, reach: number): (y: number) => Vec3 {
  const { grid, mask, depth } = solid,
    { nx, ny } = grid,
    rows = new Map<number, Vec3>();
  let at0 = start;
  for (let y = Math.round(crotch); y <= top[1]; y++) {
    const cx = Math.round(at0[0]),
      cz = Math.round(at0[2]),
      r = Math.ceil(reach);
    let sx = 0,
      sz = 0,
      sw = 0;
    for (let z = cz - r; z <= cz + r; z++)
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || z < 0 || x >= nx || z >= grid.nz) continue;
        const i = x + nx * (y + ny * z);
        if (!mask[i]) continue;
        const w = depth[i] ** 4;
        sx += x * w;
        sz += z * w;
        sw += w;
      }
    // One voxel of drift a row at most, so a backpack or a plait cannot pull the line across to it.
    if (sw > 0) {
      const mx = Math.max(-1, Math.min(1, sx / sw - at0[0])),
        mz = Math.max(-1, Math.min(1, sz / sw - at0[2]));
      at0 = [at0[0] + mx, y, at0[2] + mz];
    }
    rows.set(y, at0);
  }
  return (y) => {
    const low = Math.max(Math.round(crotch), Math.min(Math.floor(y), top[1])),
      a = rows.get(low)!,
      b = rows.get(Math.min(low + 1, top[1]))!;
    return [a[0] + (b[0] - a[0]) * (y - low), y, a[2] + (b[2] - a[2]) * (y - low)];
  };
}

/** The arc length of the smallest cut of a line between two arc lengths. */
function thinnestArea(path: Line, area: readonly number[], from: number, to: number): number {
  let best = Infinity,
    out = (from + to) / 2;
  path.along.forEach((s, k) => {
    if (s >= from && s <= to && area[k] > 0 && area[k] < best) {
      best = area[k];
      out = s;
    }
  });
  return out;
}

/** Evens each left and right pair across the plane through the trunk, when the two already nearly agree. */
function even(named: [string, string | null, Vec3][], side: Vec3, height: number): void {
  const byName = new Map(named.map((row) => [row[0], row])),
    hips = byName.get('hips')![2],
    middle = dot(hips, side);
  const mirror = (p: Vec3): Vec3 => add(p, side, 2 * (middle - dot(p, side)));
  const pairs = named.filter((row) => row[0].startsWith('left'));
  const worst = Math.max(
    ...pairs.map((row) => length(sub(mirror(row[2]), byName.get(`right${row[0].slice(4)}`)![2]))),
  );
  if (worst > 0.08 * height) return;
  for (const row of pairs) {
    const other = byName.get(`right${row[0].slice(4)}`)!,
      mean = mix(row[2], mirror(other[2]), 0.5);
    row[2] = mean;
    other[2] = mirror(mean);
  }
  for (const name of ['spine', 'chest', 'upperChest', 'neck', 'head', 'headEnd']) {
    const row = byName.get(name)!;
    row[2] = add(row[2], side, middle - dot(row[2], side));
  }
}

/**
 * Places a humanoid skeleton inside a mesh nobody rigged, then weights it. The figure stands in a T or A pose with its
 * arms clear of its body and two feet apart, in any units, turned any way about `up`. The mesh may be broken or in many
 * parts. Joints carry VRM humanoid names plus `headEnd`, `leftHandEnd`, `leftToesEnd` and their right twins as leaves.
 * Fingers are not placed.
 * @example
 * const rig = await autoRig({ positions, indices });
 * const { joints, weights } = rig;
 * @throws TypeError or RangeError for invalid input; a MargoError with code `failed` when no humanoid is found.
 */
export async function autoRig(mesh: WeightMesh, options: AutoRigOptions = {}): Promise<AutoRig> {
  const { resolution = 128, up = [0, 1, 0], closing = 1, symmetric = true, weights = 'voxel', signal } = options;
  if (!Number.isInteger(resolution) || resolution < MIN_RESOLUTION || resolution > MAX_RESOLUTION)
    throw new RangeError(`autoRig resolution must be an integer from ${MIN_RESOLUTION} to ${MAX_RESOLUTION}`);
  if (!Number.isInteger(closing) || closing < 0 || closing > 8)
    throw new RangeError('autoRig closing must be an integer from 0 to 8');
  if (weights !== 'voxel' && weights !== 'none')
    throw new RangeError("autoRig weights must be 'voxel' or 'none'");
  const upLength = up && length(up);
  if (!(upLength > 0) || !Number.isFinite(upLength)) throw new RangeError('autoRig up must be a nonzero vector');
  const forwardGiven = options.forward;
  if (forwardGiven !== undefined && !(length(forwardGiven) > 0))
    throw new RangeError('autoRig forward must be a nonzero vector');
  signal?.throwIfAborted();
  // A frame with y along up. The mesh goes in turned, the joints come out turned back.
  const yAxis = unit(up),
    seed: Vec3 = Math.abs(yAxis[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1],
    source = weld(mesh, options.weld);
  let xAxis = unit(cross(yAxis, seed)),
    zAxis = cross(xAxis, yAxis);
  const toFrame = (p: readonly number[]): Vec3 => [dot(p, xAxis), dot(p, yAxis), dot(p, zAxis)],
    fromFrame = (p: readonly number[]): Vec3 => add(add(add([0, 0, 0], xAxis, p[0]), yAxis, p[1]), zAxis, p[2]),
    voxelize = (): { grid: Grid; solid: Solid; body: Body } => {
      const positions = new Float64Array(source.positions.length);
      for (let i = 0; i < positions.length; i += 3)
        positions.set(toFrame([source.positions[i], source.positions[i + 1], source.positions[i + 2]]), i);
      const frame = { ...source, positions },
        grid = makeGrid(frame, [], resolution);
      markTriangles(grid, frame);
      fill(grid, closing);
      const inside = votes(grid),
        mask = new Uint8Array(grid.state.length);
      for (let i = 0; i < mask.length; i++) mask[i] = grid.state[i] !== OUTSIDE || inside[i] === 6 ? 1 : 0;
      const count = largestPart(grid, mask),
        solid: Solid = { grid, mask, depth: depthOf(grid, mask), count },
        hint = forwardGiven && flat(toFrame(forwardGiven));
      return { grid, solid, body: measure(solid, hint ? cross([0, 1, 0], hint) : undefined) };
    };
  let { grid, solid, body } = voxelize();
  signal?.throwIfAborted();
  // A figure turned against the grid has stairs down its limbs that move the cuts, so it is voxelized again square on.
  if (Math.abs(body.side[0]) < SQUARE) {
    xAxis = unit(fromFrame(flat(body.side)));
    zAxis = cross(xAxis, yAxis);
    ({ grid, solid, body } = voxelize());
    signal?.throwIfAborted();
  }
  const count = solid.count,
    { named, forward, facingFound } = place(solid, body, forwardGiven ? flat(toFrame(forwardGiven)) : null);
  if (symmetric) even(named, body.side, body.height);
  const toMesh = (p: readonly number[]): Vec3 =>
    fromFrame(add(grid.origin, add(p, [0.5, 0.5, 0.5]), grid.cell));
  const index = new Map(named.map((row, i) => [row[0], i]));
  const joints: RigJoint[] = named.map(([name, parent, position]) => ({
    name,
    parent: parent === null ? -1 : index.get(parent)!,
    position: toMesh(position),
  }));
  checkRig(joints);
  const rest = new Float64Array(joints.length * 10);
  joints.forEach((joint, i) => {
    const offset = joint.parent < 0 ? joint.position : sub(joint.position, joints[joint.parent].position);
    rest.set([offset[0], offset[1], offset[2], 0, 0, 0, 1, 1, 1, 1], i * 10);
  });
  let map: WeightMap | null = null;
  if (weights === 'voxel')
    map = (await voxelWeights(mesh, joints, { resolution, closing, weld: options.weld, signal })).weights;
  return {
    joints,
    humanoid: Object.fromEntries(index),
    pose: { names: joints.map((joint) => joint.name), parents: joints.map((joint) => joint.parent), rest },
    weights: map,
    forward: unit(fromFrame(forward)),
    facingFound,
    voxels: count,
  };
}
