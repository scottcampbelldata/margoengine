// The `gpu` entry: the clearance of many candidate poses at once, one pose per compute invocation. Each invocation runs
// forward kinematics, then the distance between point sets by GJK (Gilbert, Johnson and Keerthi, 1988): a sphere is one
// point with a radius, a capsule two, a hull its corners. A baked field is read by branch and bound on its Lipschitz
// bound, as on the CPU. The kernel is the CPU kernel of `hull.ts` in f32, with no expanding polytope: an overlap reads
// zero less the radii, which is all a filter needs. Written clean room from that publication.
import { rangeError, typeError } from '../../shared/errors.js';
import { preciseMathWgsl } from '../../shared/precise-math.js';
import { ConvexHullVolume, hullWorldPoints } from './hull.js';
import { Robot } from './robot.js';
import type { GridColliderData } from './sdf.js';
import type { ConstraintVolume } from './types.js';
import { CapsuleVolume, SphereVolume } from './volumes.js';

declare const GPUBufferUsage: { STORAGE: number; UNIFORM: number; COPY_DST: number; COPY_SRC: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

/** Options of {@link GPUClearance}. */
export interface GPUClearanceOptions {
  /**
   * A pose stops at the first pair at or below this gap, because it is out, and reads that pair's gap, not its smallest.
   * Default none: every pose reads its smallest gap.
   */
  minClearance?: number;
  /** Also measure the robot's shapes against each other (see `Robot.selfCollisionPairs`). Default false. */
  selfCollision?: boolean;
  /** Poses per dispatch. A long batch is split, so no single dispatch can hold the GPU for long. Default 16,384. */
  batch?: number;
}

/** Options of {@link GPUClearance.evaluate}. */
export interface GPUClearanceEvaluateOptions {
  /** Checked between dispatches. The promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

interface GridCollider {
  gridData(): GridColliderData | null;
}

const WORKGROUP = 64;
/** A pose whose checks found nothing reads this, which becomes Infinity. */
const NOTHING = 3e38;
/** Floats before a field's samples. */
const FIELD_HEADER = 32;

const kernel = (frames: number): string => /* wgsl */ `
${preciseMathWgsl(['preciseSin', 'preciseCos'])}
struct Params { count: u32, dof: u32, shapes: u32, colliders: u32, pairs: u32, early: u32, stop: f32, unused: u32 }
struct Set { first: u32, count: u32, frame: u32, radius: f32 }

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> poses: array<f32>;
@group(0) @binding(2) var<storage, read> joints: array<vec4f>;
@group(0) @binding(3) var<storage, read> sets: array<Set>;
@group(0) @binding(4) var<storage, read> points: array<vec4f>;
@group(0) @binding(5) var<storage, read> pairs: array<vec2u>;
@group(0) @binding(6) var<storage, read> fields: array<f32>;
@group(0) @binding(7) var<storage, read_write> gaps: array<f32>;

const FRAMES = ${frames}u;
const WORLD = FRAMES - 1u;
const FIELD = 0xffffffffu;
const FAR = ${NOTHING};
const GJK_STEPS = 64u;
// Below this share of the difference's size, a length counts as zero: a few roundings of f32.
const FLAT = 2e-6;
const SQRT3 = 1.7320508;

var<private> rotations: array<mat3x3f, FRAMES>;
var<private> origins: array<vec3f, FRAMES>;
var<private> simplex: array<vec3f, 4>;
var<private> nearest: vec3f;
var<private> nearestSquared: f32;
var<private> extent: f32;
/** The closest point of the last GJK, as a vector in the difference. */
var<private> witness: vec3f;
/** The point a set with no points stands for. */
var<private> probe: vec3f;

fn turn(axis: vec3f, angle: f32) -> mat3x3f {
  let c = preciseCos(angle);
  let s = preciseSin(angle);
  let k = 1.0 - c;
  let x = axis.x;
  let y = axis.y;
  let z = axis.z;
  return mat3x3f(
    vec3f(c + x * x * k, y * x * k + z * s, z * x * k - y * s),
    vec3f(x * y * k - z * s, c + y * y * k, z * y * k + x * s),
    vec3f(x * z * k + y * s, y * z * k - x * s, c + z * z * k),
  );
}

// joints: four rows of the base, then five per joint. Rows hold origin columns, then the axis, with the kind, parent
// frame, configuration entry, multiplier and offset in their w.
fn place(pose: u32) {
  rotations[0] = mat3x3f(joints[0].xyz, joints[1].xyz, joints[2].xyz);
  origins[0] = joints[3].xyz;
  rotations[WORLD] = mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0));
  origins[WORLD] = vec3f(0.0);
  for (var j = 1u; j < WORLD; j++) {
    let at = 4u + (j - 1u) * 5u;
    let c0 = joints[at];
    let c1 = joints[at + 1u];
    let c2 = joints[at + 2u];
    let c3 = joints[at + 3u];
    let c4 = joints[at + 4u];
    let kind = u32(c0.w);
    let parent = u32(c1.w);
    var r = rotations[parent] * mat3x3f(c0.xyz, c1.xyz, c2.xyz);
    var t = rotations[parent] * c3.xyz + origins[parent];
    if (kind != 2u) {
      let value = poses[pose * params.dof + u32(c2.w)] * c3.w + c4.w;
      if (kind == 1u) {
        t += r * (c4.xyz * value);
      } else {
        r = r * turn(c4.xyz, value);
      }
    }
    rotations[j] = r;
    origins[j] = t;
  }
}

fn support(part: Set, direction: vec3f) -> vec3f {
  if (part.count == 0u) {
    return probe;
  }
  let rotation = rotations[part.frame];
  // Row vector times matrix is the transpose's product: the direction in the set's own frame.
  let local = direction * rotation;
  var found = part.first;
  var high = -FAR;
  for (var i = part.first; i < part.first + part.count; i++) {
    let along = dot(points[i].xyz, local);
    if (along > high) {
      high = along;
      found = i;
    }
  }
  return rotation * points[found].xyz + origins[part.frame];
}

fn difference(a: Set, b: Set, direction: vec3f) -> vec3f {
  let w = support(a, direction) - support(b, -direction);
  let size = abs(w);
  extent = max(extent, max(size.x, max(size.y, size.z)));
  return w;
}

fn closerEdge(i: u32, j: u32, mask: u32) -> u32 {
  let a = simplex[i];
  let e = simplex[j] - a;
  let squared = dot(e, e);
  var t = 0.0;
  if (squared > 0.0) {
    t = clamp(-dot(a, e) / squared, 0.0, 1.0);
  }
  let p = a + e * t;
  let distance = dot(p, p);
  if (distance >= nearestSquared) {
    return mask;
  }
  nearest = p;
  nearestSquared = distance;
  if (t <= 0.0) {
    return 1u << i;
  }
  if (t >= 1.0) {
    return 1u << j;
  }
  return (1u << i) | (1u << j);
}

fn closerFace(i: u32, j: u32, k: u32, mask: u32) -> u32 {
  let a = simplex[i];
  let b = simplex[j] - a;
  let c = simplex[k] - a;
  // Through the face's normal, not the normal equations: in f32 their determinant loses a thin triangle.
  let n = cross(b, c);
  let square = dot(n, n);
  if (square > 0.0) {
    let s = dot(cross(c, a), n) / square;
    let t = dot(cross(a, b), n) / square;
    if (s > 0.0 && t > 0.0 && s + t < 1.0) {
      let p = n * (dot(a, n) / square);
      let distance = dot(p, p);
      if (distance >= nearestSquared) {
        return mask;
      }
      nearest = p;
      nearestSquared = distance;
      return (1u << i) | (1u << j) | (1u << k);
    }
  }
  return closerEdge(j, k, closerEdge(i, k, closerEdge(i, j, mask)));
}

fn outside(i: u32, j: u32, k: u32, l: u32) -> bool {
  let a = simplex[i];
  let n = cross(simplex[j] - a, simplex[k] - a);
  let opposite = dot(n, simplex[l] - a);
  let origin = -dot(n, a);
  let limit = FLAT * extent;
  if (abs(opposite) <= limit * limit * limit) {
    return true;
  }
  return select((origin > 0.0), (origin < 0.0), opposite > 0.0);
}

/** Reduces the simplex to what its closest point uses, and writes that point. 4 means the origin is inside. */
fn reduce(count: u32) -> u32 {
  nearestSquared = FAR;
  var mask = 0u;
  if (count == 2u) {
    mask = closerEdge(0u, 1u, 0u);
  } else if (count == 3u) {
    mask = closerFace(0u, 1u, 2u, 0u);
  } else {
    if (outside(0u, 1u, 2u, 3u)) {
      mask = closerFace(0u, 1u, 2u, mask);
    }
    if (outside(0u, 1u, 3u, 2u)) {
      mask = closerFace(0u, 1u, 3u, mask);
    }
    if (outside(0u, 2u, 3u, 1u)) {
      mask = closerFace(0u, 2u, 3u, mask);
    }
    if (outside(1u, 2u, 3u, 0u)) {
      mask = closerFace(1u, 2u, 3u, mask);
    }
    if (mask == 0u) {
      return 4u;
    }
  }
  var kept = 0u;
  for (var i = 0u; i < count; i++) {
    if ((mask & (1u << i)) != 0u) {
      simplex[kept] = simplex[i];
      kept++;
    }
  }
  return kept;
}

/** Distance between two point sets; 0 when they overlap. */
fn gjk(a: Set, b: Set) -> f32 {
  extent = 0.0;
  var direction = support(b, vec3f(1.0, 0.0, 0.0)) - support(a, vec3f(1.0, 0.0, 0.0));
  if (dot(direction, direction) == 0.0) {
    direction = vec3f(1.0, 0.0, 0.0);
  }
  simplex[0] = difference(a, b, direction);
  var v = simplex[0];
  var count = 1u;
  for (var round_ = 0u; round_ < GJK_STEPS; round_++) {
    let squared = dot(v, v);
    let noise = extent * extent;
    if (squared <= FLAT * FLAT * noise) {
      witness = vec3f(0.0);
      return 0.0;
    }
    simplex[count] = difference(a, b, -v);
    // The new vertex is no nearer the origin than v is: its length is the distance. Taking v from it before the product
    // keeps the rounding near |v| E. Subtracting the two products would leave E squared, and that over |v| near contact.
    if (dot(v, v - simplex[count]) <= 1e-6 * squared + 4e-7 * sqrt(squared) * extent) {
      break;
    }
    count = reduce(count + 1u);
    if (count == 4u) {
      witness = vec3f(0.0);
      return 0.0;
    }
    if (nearestSquared >= squared) {
      // Rounding only: a step that made no progress cannot make any later.
      break;
    }
    v = nearest;
  }
  witness = v;
  return length(v);
}

fn fieldVector(at: u32) -> vec3f {
  return vec3f(fields[at], fields[at + 1u], fields[at + 2u]);
}

fn sample(data: u32, size: vec3u, x: u32, y: u32, z: u32) -> f32 {
  return fields[data + x + size.x * (y + size.y * z)];
}

// A field's header: 12 floats of world to field, then min, max, spacing, size, scale, margin, accuracy, Lipschitz bound,
// most cells and where its samples start.
fn fieldRead(h: u32, point: vec3f) -> f32 {
  let inverse = mat3x3f(fieldVector(h), fieldVector(h + 3u), fieldVector(h + 6u));
  let local = inverse * point + fieldVector(h + 9u);
  let low = fieldVector(h + 12u);
  let high = fieldVector(h + 15u);
  let spacing = fieldVector(h + 18u);
  let size = vec3u(fieldVector(h + 21u));
  let data = u32(fields[h + 29u]);
  let held = clamp(local, low, high);
  let beyond = length(local - held);
  let cell = (held - low) / spacing;
  let base = min(vec3u(cell), size - vec3u(2u));
  let t = clamp(cell - vec3f(base), vec3f(0.0), vec3f(1.0));
  let x0 = base.x;
  let y0 = base.y;
  let z0 = base.z;
  let c00 = mix(sample(data, size, x0, y0, z0), sample(data, size, x0 + 1u, y0, z0), t.x);
  let c10 = mix(sample(data, size, x0, y0 + 1u, z0), sample(data, size, x0 + 1u, y0 + 1u, z0), t.x);
  let c01 = mix(sample(data, size, x0, y0, z0 + 1u), sample(data, size, x0 + 1u, y0, z0 + 1u), t.x);
  let c11 = mix(sample(data, size, x0, y0 + 1u, z0 + 1u), sample(data, size, x0 + 1u, y0 + 1u, z0 + 1u), t.x);
  let inner = mix(mix(c00, c10, t.y), mix(c01, c11, t.y), t.z);
  // Past the grid the obstacle is at least as far as the grid is, and the field can drop no faster than the distance.
  let value = select(inner, max(beyond, inner - beyond), beyond > 0.0);
  return value * fields[h + 24u] - fields[h + 25u];
}

/** The world ends of a set of one or two points. */
fn segmentField(part: Set, h: u32) -> f32 {
  let rotation = rotations[part.frame];
  let start = rotation * points[part.first].xyz + origins[part.frame];
  let end = rotation * points[part.first + part.count - 1u].xyz + origins[part.frame];
  let along = end - start;
  let slope = fields[h + 27u] * length(along);
  let accuracy = fields[h + 26u];
  let limit = u32(fields[h + 28u]);
  var best = min(fieldRead(h, start), fieldRead(h, end));
  var floorBound = FAR;
  var cells = 0u;
  var stack: array<vec2f, 48>;
  var top = 1u;
  stack[0] = vec2f(0.0, 1.0);
  while (top > 0u) {
    top--;
    let span = stack[top];
    let middle = (span.x + span.y) * 0.5;
    let value = fieldRead(h, start + along * middle);
    let bound = value - slope * (span.y - span.x) * 0.5;
    best = min(best, value);
    if (bound >= best - accuracy) {
      continue;
    }
    cells++;
    if (cells >= limit || top + 2u > 48u) {
      floorBound = min(floorBound, bound);
      continue;
    }
    stack[top] = vec2f(span.x, middle);
    stack[top + 1u] = vec2f(middle, span.y);
    top += 2u;
  }
  return min(best - accuracy, floorBound) - part.radius;
}

fn hullField(part: Set, h: u32) -> f32 {
  let rotation = rotations[part.frame];
  var low = vec3f(FAR);
  var high = vec3f(-FAR);
  for (var i = part.first; i < part.first + part.count; i++) {
    let p = rotation * points[i].xyz + origins[part.frame];
    low = min(low, p);
    high = max(high, p);
  }
  let accuracy = fields[h + 26u];
  let lipschitz = fields[h + 27u];
  let limit = u32(fields[h + 28u]);
  let box = high - low;
  var best = FAR;
  var floorBound = FAR;
  var cells = 0u;
  var stack: array<vec4f, 64>;
  var top = 1u;
  stack[0] = vec4f((low + high) * 0.5, max(box.x, max(box.y, box.z)) * 0.5);
  let point = Set(0u, 0u, WORLD, 0.0);
  while (top > 0u) {
    top--;
    let cell = stack[top];
    let reach = cell.w * SQRT3;
    probe = cell.xyz;
    let gap = gjk(part, point);
    if (gap > reach) {
      continue;
    }
    // A point of the hull in this cell, for the best reading so far.
    let centre = fieldRead(h, cell.xyz);
    let value = select(centre, fieldRead(h, cell.xyz + witness), gap > 0.0);
    best = min(best, value);
    let bound = centre - lipschitz * reach;
    if (bound >= best - accuracy) {
      continue;
    }
    cells++;
    if (cells >= limit || top + 8u > 64u) {
      floorBound = min(floorBound, bound);
      continue;
    }
    let next = cell.w * 0.5;
    for (var i = 0u; i < 8u; i++) {
      let side = vec3f(f32(i & 1u) * 2.0 - 1.0, f32((i >> 1u) & 1u) * 2.0 - 1.0, f32((i >> 2u) & 1u) * 2.0 - 1.0);
      stack[top] = vec4f(cell.xyz + side * next, next);
      top++;
    }
  }
  return min(best - accuracy, floorBound);
}

fn measure(shape: Set, collider: Set) -> f32 {
  if (collider.frame == FIELD) {
    if (shape.count <= 2u) {
      return segmentField(shape, collider.first);
    }
    return hullField(shape, collider.first);
  }
  return gjk(shape, collider) - shape.radius - collider.radius;
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pose = id.x;
  if (pose >= params.count) {
    return;
  }
  place(pose);
  var least = FAR;
  for (var s = 0u; s < params.shapes; s++) {
    for (var c = 0u; c < params.colliders; c++) {
      least = min(least, measure(sets[s], sets[params.shapes + c]));
      if (params.early != 0u && least <= params.stop) {
        gaps[pose] = least;
        return;
      }
    }
  }
  for (var p = 0u; p < params.pairs; p++) {
    let pair = pairs[p];
    least = min(least, measure(sets[pair.x], sets[pair.y]));
    if (params.early != 0u && least <= params.stop) {
      break;
    }
  }
  gaps[pose] = least;
}
`;

/** Packs the base and the joints for the kernel: see `place`. */
function packJoints(robot: Robot): Float32Array {
  const data = robot.describe(),
    count = data.parents.length,
    out = new Float32Array((4 + count * 5) * 4);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) out[c * 4 + r] = data.base[c * 3 + r];
  for (let j = 0; j < count; j++) {
    const at = (4 + j * 5) * 4;
    for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) out[at + c * 4 + r] = data.origins[j * 12 + c * 3 + r];
    for (let r = 0; r < 3; r++) out[at + 16 + r] = data.axes[j * 3 + r];
    out[at + 3] = data.kinds[j];
    out[at + 7] = data.parents[j] + 1;
    out[at + 11] = Math.max(data.variable[j], 0);
    out[at + 15] = data.multipliers[j];
    out[at + 19] = data.offsets[j];
  }
  return out;
}

/** World points and a radius of a collider the kernel takes as a point set; null for a grid. */
function pointSet(volume: ConstraintVolume): { points: ArrayLike<number>; radius: number } | null {
  if (volume instanceof SphereVolume) return { points: volume.center, radius: volume.radius };
  if (volume instanceof CapsuleVolume) return { points: [...volume.start, ...volume.end], radius: volume.radius };
  if (volume instanceof ConvexHullVolume) return { points: hullWorldPoints(volume), radius: 0 };
  return null;
}

function writeField(out: number[], grid: GridColliderData): void {
  const at = out.length,
    data = at + FIELD_HEADER;
  out.push(
    ...grid.inverse,
    ...Array.from(grid.min),
    ...Array.from(grid.max),
    ...Array.from(grid.spacing),
    ...grid.size,
    grid.scale,
    grid.margin,
    grid.precision,
    grid.lipschitz,
    grid.maxCells,
    data,
    0,
    0,
  );
  for (const value of grid.samples) out.push(value);
}

/**
 * The clearance of many poses at once on the GPU, to sort a large batch of candidates into clear and blocked for a
 * planner. It works in f32 and reads a pose's smallest gap as `Robot.clearance` does, except that an overlap reads zero
 * less the radii. Treat it as a filter: `Roadmap.addPoses` proves on the CPU every pose it lets through.
 *
 * The robot's shapes, its base and the colliders are read once, here. Spheres, capsules, hulls and `SDFVolume`s on a
 * sampled grid are taken; a `MeshVolume` is not, so bake it with `bakeSDF` first.
 *
 * @example
 * ```ts
 * import { CapsuleVolume } from 'margoengine/kinematics-constraints';
 * import { GPUClearance } from 'margoengine/kinematics-constraints/gpu';
 * import { Roadmap } from 'margoengine/kinematics-constraints/plan';
 * import { Robot } from 'margoengine/kinematics-constraints/robot';
 *
 * const adapter = await navigator.gpu.requestAdapter();
 * const device = await adapter!.requestDevice();
 * const arm = new Robot({ joints: [{ lower: -3, upper: 3 }], shapes: [{ joint: 0, end: [1, 0, 0], radius: 0.05 }] });
 * const colliders = [new CapsuleVolume({ start: [0, 1, -1], end: [0, 1, 1], radius: 0.05 })];
 * using clearance = new GPUClearance(device, arm, colliders, { minClearance: 0.01 });
 * const roadmap = new Roadmap(arm, { colliders });
 * const poses = roadmap.samplePoses(4096);
 * roadmap.addPoses(poses, await clearance.evaluate(poses));
 * ```
 */
export class GPUClearance {
  /** Numbers in a pose. */
  readonly dof: number;
  /** Poses per dispatch. */
  readonly batch: number;
  private readonly device: GPUDevice;
  private readonly buffers: GPUBuffer[] = [];
  private readonly params: GPUBuffer;
  private readonly poses: GPUBuffer;
  private readonly gaps: GPUBuffer;
  private readonly read: GPUBuffer;
  private readonly shapes: number;
  private readonly colliders: number;
  private readonly pairs: number;
  private readonly stop: number | null;
  private readonly code: string;
  private readonly bound: GPUBuffer[];
  private pipeline: Promise<{ pipeline: GPUComputePipeline; group: GPUBindGroup }> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(device: GPUDevice, robot: Robot, colliders: readonly ConstraintVolume[], options?: GPUClearanceOptions) {
    if (!device || typeof device.createBuffer !== 'function') throw typeError('GPUClearance needs a GPUDevice', 'kinematics');
    if (!(robot instanceof Robot)) throw typeError('GPUClearance needs a Robot', 'kinematics');
    if (!Array.isArray(colliders)) throw typeError('GPUClearance colliders must be an array of volumes', 'kinematics');
    if (robot.dof === 0) throw rangeError('GPUClearance needs a robot with at least one moving joint', 'kinematics');
    const minClearance = options?.minClearance,
      batch = options?.batch ?? 16384;
    if (minClearance !== undefined && !Number.isFinite(minClearance))
      throw rangeError('GPUClearance minClearance must be a finite number', 'kinematics');
    if (!Number.isSafeInteger(batch) || batch < 1)
      throw rangeError('GPUClearance batch must be a positive integer', 'kinematics');
    this.device = device;
    this.dof = robot.dof;
    this.stop = minClearance ?? null;
    const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    this.batch = Math.min(
      batch,
      Math.floor(limit / (robot.dof * 4)),
      device.limits.maxComputeWorkgroupsPerDimension * WORKGROUP,
    );
    const data = robot.describe(),
      points: number[] = [],
      sets: number[] = [],
      fields: number[] = [],
      world = data.parents.length + 1,
      addSet = (first: number, count: number, frame: number, radius: number) => sets.push(first, count, frame, radius),
      addPoints = (values: ArrayLike<number>): number => {
        const first = points.length / 4;
        for (let i = 0; i < values.length; i += 3) points.push(values[i], values[i + 1], values[i + 2], 0);
        return first;
      };
    for (const shape of data.shapes) addSet(addPoints(shape.points), shape.points.length / 3, shape.joint + 1, shape.radius);
    for (const volume of colliders) {
      const set = pointSet(volume);
      if (set) {
        addSet(addPoints(set.points), set.points.length / 3, world, set.radius);
        continue;
      }
      const grid = (volume as Partial<GridCollider>).gridData?.();
      if (!grid)
        throw typeError(
          'GPUClearance takes spheres, capsules, hulls and SDFVolumes on a sampled grid; bake a mesh with bakeSDF first',
          'kinematics',
        );
      addSet(fields.length, 0, 0xffffffff, 0);
      writeField(fields, grid);
    }
    const pairs = options?.selfCollision === true ? robot.selfCollisionPairs : new Int32Array(0);
    this.shapes = data.shapes.length;
    this.colliders = colliders.length;
    this.pairs = pairs.length / 2;
    this.code = kernel(data.parents.length + 2);
    const usage = GPUBufferUsage,
      upload = (name: string, bytes: ArrayBufferView): GPUBuffer => {
        if (bytes.byteLength > limit)
          throw rangeError(`GPUClearance ${name} take ${bytes.byteLength} bytes, over this device's ${limit}`, 'kinematics');
        const buffer = this.buffer(name, Math.max(bytes.byteLength, 16), usage.STORAGE | usage.COPY_DST);
        device.queue.writeBuffer(buffer, 0, bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
        return buffer;
      };
    // A set is three whole numbers and a float, in one buffer.
    const packedSets = new Uint32Array(sets.length),
      asFloats = new Float32Array(packedSets.buffer);
    for (let i = 0; i < sets.length; i += 4) {
      packedSets[i] = sets[i];
      packedSets[i + 1] = sets[i + 1];
      packedSets[i + 2] = sets[i + 2];
      asFloats[i + 3] = sets[i + 3];
    }
    this.params = this.buffer('params', 32, usage.UNIFORM | usage.COPY_DST);
    this.poses = this.buffer('poses', this.batch * robot.dof * 4, usage.STORAGE | usage.COPY_DST);
    this.gaps = this.buffer('gaps', this.batch * 4, usage.STORAGE | usage.COPY_SRC);
    this.read = this.buffer('read', this.batch * 4, usage.MAP_READ | usage.COPY_DST);
    this.bound = [
      this.params,
      this.poses,
      upload('joints', packJoints(robot)),
      upload('sets', packedSets),
      upload('points', new Float32Array(points)),
      upload('pairs', Uint32Array.from(pairs)),
      upload('fields', new Float32Array(fields)),
      this.gaps,
    ];
  }

  /**
   * The gap of every pose in `configs`, `dof` numbers each, in scene units: Infinity when there was nothing to test.
   * Calls run one after another.
   */
  evaluate(configs: ArrayLike<number>, options?: GPUClearanceEvaluateOptions): Promise<Float32Array> {
    if (this.disposed) return Promise.reject(typeError('GPUClearance is disposed; make a new one', 'kinematics'));
    if (!configs || configs.length % this.dof !== 0)
      return Promise.reject(typeError(`GPUClearance poses need ${this.dof} numbers each`, 'kinematics'));
    const run = this.queue.then(() => this.run(configs, options?.signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Frees the GPU buffers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const buffer of this.buffers) buffer.destroy();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  private buffer(label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.device.createBuffer({ label: `GPUClearance ${label}`, size, usage });
    this.buffers.push(buffer);
    return buffer;
  }

  private ready(): Promise<{ pipeline: GPUComputePipeline; group: GPUBindGroup }> {
    this.pipeline ??= this.device
      .createComputePipelineAsync({
        label: 'GPUClearance',
        layout: 'auto',
        compute: { module: this.device.createShaderModule({ code: this.code }), entryPoint: 'main' },
      })
      .then((pipeline) => ({
        pipeline,
        group: this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: this.bound.map((buffer, binding) => ({ binding, resource: { buffer } })),
        }),
      }));
    return this.pipeline;
  }

  private async run(configs: ArrayLike<number>, signal: AbortSignal | undefined): Promise<Float32Array> {
    const { device, dof, batch } = this,
      total = configs.length / dof,
      out = new Float32Array(total),
      { pipeline, group } = await this.ready(),
      header = new ArrayBuffer(32),
      whole = new Uint32Array(header),
      float = new Float32Array(header),
      poses = new Float32Array(Math.min(batch, total) * dof);
    whole[1] = dof;
    whole[2] = this.shapes;
    whole[3] = this.colliders;
    whole[4] = this.pairs;
    whole[5] = this.stop === null ? 0 : 1;
    float[6] = this.stop ?? 0;
    for (let start = 0; start < total; start += batch) {
      signal?.throwIfAborted();
      if (this.disposed) throw typeError('GPUClearance is disposed; make a new one', 'kinematics');
      const count = Math.min(batch, total - start);
      for (let i = 0; i < count * dof; i++) poses[i] = configs[start * dof + i];
      whole[0] = count;
      device.queue.writeBuffer(this.params, 0, header);
      device.queue.writeBuffer(this.poses, 0, poses.buffer, 0, count * dof * 4);
      const encoder = device.createCommandEncoder({ label: 'GPUClearance' }),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP));
      pass.end();
      encoder.copyBufferToBuffer(this.gaps, 0, this.read, 0, count * 4);
      device.queue.submit([encoder.finish()]);
      await this.read.mapAsync(GPUMapMode.READ, 0, count * 4);
      out.set(new Float32Array(this.read.getMappedRange(0, count * 4)), start);
      this.read.unmap();
    }
    for (let i = 0; i < total; i++) if (out[i] >= NOTHING) out[i] = Infinity;
    return out;
  }
}
