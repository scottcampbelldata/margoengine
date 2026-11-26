import type { Quat, Vec3 } from '@margoengine/math';
import { cos, sin } from '@margoengine/math/pinned';
import { multiplyQuaternions, normalizeQuaternion, rotateByQuaternion } from '@margoengine/math/quat';
import type { Cell } from '../world/solver.js';
import { BODY_WORDS } from '../world/solvers/rigid.js';

export const SOLID_WORDS = 21;
export const BOUNDARY_WORDS = 5;
const IDENTITY: Quat = [0, 0, 0, 1];
const ZERO: Vec3 = [0, 0, 0];
const POLY6 = 315 / (64 * Math.PI);

interface BoundaryFrame {
  /** Centre in body coordinates when `body` is set. Default origin. */
  readonly centre?: Vec3;
  /** Local quaternion `[x, y, z, w]`. Default identity. */
  readonly rotation?: Quat;
  /** Matching RigidSolver body row. Omit for a fixed obstacle. */
  readonly body?: number;
  /** Surface sample spacing in metres. Default the fluid particle spacing. */
  readonly sampleSpacing?: number;
}

/** A box, sphere or Y-axis capsule in the fluid cell or attached to a RigidSolver body row. */
export type PbfBoundary = BoundaryFrame &
  (
    | { readonly shape?: 'box'; readonly halfExtents: Vec3 }
    | { readonly shape: 'sphere'; readonly radius: number }
    | { readonly shape: 'capsule'; readonly radius: number; readonly halfSegment: number }
  );

type Sample = { readonly position: Vec3; readonly volume: number };
export interface PreparedBoundary {
  readonly kind: 1 | 2 | 3;
  readonly half: Vec3;
  readonly centre: Vec3;
  readonly rotation: Quat;
  readonly body?: number;
  readonly samples: readonly Sample[];
}

export function vec(input: readonly number[], subject: string): Vec3 {
  if (!input || input.length !== 3 || !input.every(Number.isFinite))
    throw new TypeError(`${subject} must have three finite values. Pass an XYZ vector.`);
  return [input[0]!, input[1]!, input[2]!];
}

export function positive(value: number, subject: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${subject} must be positive and finite. Pass an SI value above zero.`);
  return value;
}

function orientation(input: Quat, subject: string): Quat {
  if (input.length !== 4 || !input.every(Number.isFinite))
    throw new TypeError(`${subject} must have four finite values. Pass a quaternion as [x, y, z, w].`);
  if (!input.some((value) => value !== 0))
    throw new RangeError(`${subject} cannot have zero length. Pass a nonzero quaternion.`);
  return normalizeQuaternion(input);
}

function sampleBudget(count: number): void {
  // A surface sample needs these arena words before its deterministic grid and host representation.
  if (!Number.isSafeInteger(count) || count * BOUNDARY_WORDS * 8 >= 0x1_0000_0000)
    throw new RangeError('PBF boundary samples exceed wasm32 memory. Use a larger surface sample spacing.');
}

function boxSurface(half: Vec3, spacing: number): Vec3[] {
  const cells = half.map((h) => Math.ceil((2 * h) / spacing));
  const [nx, ny, nz] = cells as [number, number, number];
  sampleBudget(2 * (nx * ny + nx * nz + ny * nz) + 2);
  const points: Vec3[] = [];
  // Each edge belongs to the face with the earliest axis, so a corner is never sampled more than once.
  for (let axis = 0; axis < 3; axis++) {
    const a = (axis + 1) % 3;
    const b = (axis + 2) % 3;
    const startA = a < axis ? 1 : 0;
    const startB = b < axis ? 1 : 0;
    for (const side of [-1, 1])
      for (let i = startA; i <= cells[a]! - startA; i++)
        for (let j = startB; j <= cells[b]! - startB; j++) {
          const p: [number, number, number] = [0, 0, 0];
          p[axis] = side * half[axis]!;
          p[a] = (2 * (i / cells[a]!) - 1) * half[a]!;
          p[b] = (2 * (j / cells[b]!) - 1) * half[b]!;
          points.push(p);
        }
  }
  return points;
}

function curvedSurface(radius: number, half: number, spacing: number): Vec3[] {
  const ratio = radius / spacing;
  const count = 2 * Math.max(2, Math.ceil(2 * Math.PI * ratio * ratio));
  const points: Vec3[] = [];
  const circle = Math.max(3, Math.ceil(2 * Math.PI * ratio));
  const rings = half > 0 ? Math.ceil((2 * half) / spacing) : 0;
  sampleBudget(count + rings * circle);
  const angle = Math.PI * (3 - Math.sqrt(5));
  // Equal-area spherical strata with a golden-angle azimuth. The capsule translates each hemisphere onto its end.
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = radius * Math.sqrt(1 - y * y);
    const direction = i * angle;
    points.push([r * cos(direction), radius * y + Math.sign(y) * half, r * sin(direction)]);
  }
  for (let i = 0; i < rings; i++) {
    const y = half * (2 * ((i + 0.5) / rings) - 1);
    for (let j = 0; j < circle; j++) {
      const direction = (2 * Math.PI * (j + 0.5 * (i % 2))) / circle;
      points.push([radius * cos(direction), y, radius * sin(direction)]);
    }
  }
  return points;
}

function poly6(x: number, y: number, z: number): number {
  const r = Math.max(0, 1 - x * x - y * y - z * z);
  return r * r * r;
}

function boundaryVolumes(
  points: readonly Vec3[],
  support: number,
  weight: (x: number, y: number, z: number) => number,
  normalizer: number,
): Sample[] {
  const grid = new Map<string, Vec3[]>();
  const inv = 1 / support;
  const cell = ([x, y, z]: Vec3): [number, number, number] => [
    Math.floor(x * inv),
    Math.floor(y * inv),
    Math.floor(z * inv),
  ];
  for (const p of points) {
    const key = cell(p).join(',');
    const bucket = grid.get(key);
    if (bucket) bucket.push(p);
    else grid.set(key, [p]);
  }
  return points.map((p) => {
    const [x, y, z] = cell(p);
    let sum = 0;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          for (const q of grid.get(`${x + dx},${y + dy},${z + dz}`) ?? []) {
            const a = (p[0] - q[0]) * inv;
            const b = (p[1] - q[1]) * inv;
            const c = (p[2] - q[2]) * inv;
            sum += weight(a, b, c);
          }
        }
    return { position: p, volume: 1 / (normalizer * sum) };
  });
}

export function prepareBoundary(
  input: PbfBoundary,
  spacing: number,
  support: number,
  bodyCapacity: number,
  weight = poly6,
  normalizer = POLY6,
): PreparedBoundary {
  const centre = vec(input.centre ?? ZERO, 'PBF boundary centre');
  const rotation = orientation(input.rotation ?? IDENTITY, 'PBF boundary rotation');
  if (input.body !== undefined && (!Number.isSafeInteger(input.body) || input.body < 0 || input.body >= bodyCapacity))
    throw new RangeError(
      'PBF boundary body row is outside the configured rigid ports. Choose a valid RigidSolver row.',
    );
  const sampleSpacing = positive(input.sampleSpacing ?? spacing, 'PBF boundary sample spacing');
  let kind: 1 | 2 | 3;
  let half: Vec3;
  let samples: Vec3[];
  if (input.shape === 'sphere' || input.shape === 'capsule') {
    const radius = positive(input.radius, 'PBF boundary radius');
    const segment = input.shape === 'capsule' ? positive(input.halfSegment, 'PBF capsule half segment') : 0;
    kind = input.shape === 'capsule' ? 3 : 2;
    half = [radius, segment, radius];
    samples = curvedSurface(radius, segment, sampleSpacing);
  } else {
    kind = 1;
    half = vec(input.halfExtents, 'PBF boundary half extents');
    for (const extent of half) positive(extent, 'PBF boundary half extent');
    samples = boxSurface(half, sampleSpacing);
  }
  return {
    kind,
    half,
    centre,
    rotation,
    body: input.body,
    samples: boundaryVolumes(samples, support, weight, normalizer),
  };
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const xyz = (array: Float32Array, at: number): Vec3 => [array[at]!, array[at + 1]!, array[at + 2]!];

export function writeBoundaries(
  inputs: readonly PreparedBoundary[],
  boxes: Float64Array,
  boundary: Float64Array,
  bodies: Float32Array | undefined,
  fluidCell: Cell,
  bodyCell: Cell,
  cellSize: number,
): void {
  const offset: Vec3 = [
    (bodyCell[0] - fluidCell[0]) * cellSize,
    (bodyCell[1] - fluidCell[1]) * cellSize,
    (bodyCell[2] - fluidCell[2]) * cellSize,
  ];
  let index = 0;
  for (const [shape, solid] of inputs.entries()) {
    const row = solid.body;
    let position = solid.centre;
    let q = solid.rotation;
    let centre = position;
    let linear = ZERO;
    let angular = ZERO;
    let bodyIndex = -1;
    let active = row === undefined;
    if (bodies && row !== undefined) {
      const at = row * BODY_WORDS;
      const raw: Quat = [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!];
      if (raw.some((value) => value !== 0)) {
        const bodyRotation = orientation(raw, 'RigidSolver body rotation');
        position = add(add(xyz(bodies, at), offset), rotateByQuaternion(position, bodyRotation));
        centre = add(xyz(bodies, at + 7), offset);
        q = multiplyQuaternions(bodyRotation, q);
        linear = xyz(bodies, at + 10);
        angular = xyz(bodies, at + 13);
        if (bodies[at + 23] === 1) bodyIndex = row;
        active = true;
      }
    }
    boxes.set(
      [...position, ...q, ...solid.half, ...linear, ...angular, ...centre, bodyIndex, active ? solid.kind : 0],
      shape * SOLID_WORDS,
    );
    for (const sample of solid.samples) {
      const world = add(position, rotateByQuaternion(sample.position, q));
      boundary.set([...world, active ? sample.volume : 0, shape], index * BOUNDARY_WORDS);
      index++;
    }
  }
}
