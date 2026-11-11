// Scientific adapters over Margo's existing sweep mesher. Research: docs/clean-room.md.
import { Curve } from '@margoengine/geometry/shapes';
import { sweepGeometry } from '@margoengine/geometry/sweep';
import type { GeometryData } from '@margoengine/geometry';
import type { TriangleSet } from './grids.js';
import type { Bounds } from './layer.js';
import { rangeError } from '../../shared/errors.js';

/** A finite polyline in data units, including the last point again for a closed line. */
export interface StreamPath {
  /** Packed xyz, at least two distinct points. Consecutive duplicate points are rejected. */
  readonly positions: ArrayLike<number>;
  /** Optional scalar at every input point, carried to the output for colour mapping. Default zero. */
  readonly scalar?: ArrayLike<number>;
}

/** Controls shared by scientific tubes and ribbons. */
export interface StreamSweepOptions {
  /** Equal-arc-length intervals on the input polyline, 1..16384. Default max(64, point count - 1). */
  readonly steps?: number;
  /** Join the repeated first/last input point, with periodic transported frames. Default false. */
  readonly closed?: boolean;
  /** Cancels before synchronous work starts. No loading, global state or retained resource. Default absent. */
  readonly signal?: AbortSignal;
}

/** Radius can be constant or a nonnegative absolute scalar at every input point, in data units. */
export interface StreamTubeOptions extends StreamSweepOptions {
  /** Default 1. Arrays interpolate linearly by input arc length. */
  readonly radius?: number | ArrayLike<number>;
  /** Sides of the circular cross section, 3..128. Default 12. */
  readonly sides?: number;
  /** Flat end caps on an open tube. Default true. */
  readonly caps?: boolean;
}

/** A ribbon's physical spin is half streamwise vorticity, integrated over travel time. */
export interface StreamRibbonOptions extends StreamSweepOptions {
  /** Full width in data units, constant or one nonnegative value per input point. Default 1. */
  readonly width?: number | ArrayLike<number>;
  /** Signed curl component along the ordered path tangent, in inverse time, one per point. Default zero. */
  readonly streamwiseVorticity?: ArrayLike<number>;
  /** Positive speed in distance/time at each point. Required with streamwiseVorticity. */
  readonly speeds?: ArrayLike<number>;
  /** Initial rotation about the tangent, in radians. Default 0. */
  readonly angle?: number;
}

/** Owned CPU arrays; no device or disposal required. Values follow vertices, including separate cap vertices. */
export interface StreamMesh extends GeometryData {
  readonly values: Float32Array;
}

const count = (n: number, low: number, high: number, name: string): number => {
  if (!Number.isInteger(n) || n < low || n > high)
    throw rangeError(`${name} must be an integer in [${low}, ${high}]`, 'sciviz');
  return n;
};

function array(values: ArrayLike<number> | undefined, length: number, name: string, fallback = 0): Float64Array {
  if (values !== undefined && (values === null || typeof values !== 'object' || values.length !== length))
    throw rangeError(`${name} needs ${length} values, one per input point`, 'sciviz');
  const copy = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const value = values === undefined ? fallback : values[i];
    if (!Number.isFinite(value) || Math.abs(value) > 1e15)
      throw rangeError(`${name} must be finite within +/-1e15`, 'sciviz');
    copy[i] = value;
  }
  return copy;
}

class Polyline extends Curve<[number, number, number]> {
  constructor(readonly positions: Float64Array, readonly distances: Float64Array) { super(); }
  getPoint(t: number): [number, number, number] {
    const d = t * this.distances[this.distances.length - 1],
      [lo, hi, f] = interval(this.distances, d);
    return [0, 1, 2].map((c) => this.positions[3 * lo + c] * (1 - f) +
      this.positions[3 * hi + c] * f) as [number, number, number];
  }
  override getPointAt(u: number): [number, number, number] { return this.getPoint(u); }
  override getTangentAt(u: number): [number, number, number] { return this.getTangent(u); }
}

function prepare(path: StreamPath, options: StreamSweepOptions) {
  options.signal?.throwIfAborted();
  if (!path || typeof path !== 'object' || !path.positions || typeof path.positions !== 'object')
    throw rangeError('Path needs an array of packed xyz positions', 'sciviz');
  if (options.closed !== undefined && typeof options.closed !== 'boolean')
    throw rangeError('Closed must be a boolean', 'sciviz');
  const n = count(path.positions.length / 3, 2, 16385, 'Path point count'),
    positions = array(path.positions, n * 3, 'Path positions'),
    scalar = array(path.scalar, n, 'Path scalar'),
    distances = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a: [number, number, number] = [positions[3 * i - 3], positions[3 * i - 2], positions[3 * i - 1]],
      b: [number, number, number] = [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]],
      length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (!(length > 0)) throw rangeError('Path has consecutive duplicate points; remove repeated samples', 'sciviz');
    distances[i] = distances[i - 1] + length;
  }
  const closed = options.closed ?? false;
  if (closed && (n < 4 || [0, 1, 2].some((c) => positions[c] !== positions[3 * (n - 1) + c])))
    throw rangeError('Closed paths need at least three distinct points and an exact repeated endpoint', 'sciviz');
  if (closed && scalar[0] !== scalar[n - 1])
    throw rangeError('Closed path scalar must match at the repeated endpoint', 'sciviz');
  // There is no unique normal through a reversing cusp. Reject it rather than invent a frame flip.
  for (let i = closed ? 0 : 1; i < n - 1; i++) {
    const before = i === 0 ? n - 2 : i - 1,
      incomingLength = i === 0 ? distances[n - 1] - distances[n - 2] : distances[i] - distances[i - 1];
    let dot = 0;
    for (let c = 0; c < 3; c++)
      dot += ((positions[3 * i + c] - positions[3 * before + c]) / incomingLength) *
        ((positions[3 * i + 3 + c] - positions[3 * i + c]) / (distances[i + 1] - distances[i]));
    if (dot < -1 + 1e-12) throw rangeError('Path reverses at a cusp; split it into separate paths', 'sciviz');
  }
  const steps = count(options.steps ?? Math.max(64, n - 1), 1, 16384, 'Sweep steps'),
    total = distances[n - 1];
  return { n, distances, total, curve: new Polyline(positions, distances), scalar, steps, closed };
}

function interval(distances: Float64Array, distance: number): [number, number, number] {
  let lo = 0, hi = distances.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (distances[mid] <= distance) lo = mid; else hi = mid;
  }
  const t = Math.max(0, Math.min(1, (distance - distances[lo]) / (distances[hi] - distances[lo])));
  return [lo, hi, t];
}

function interpolate(distances: Float64Array, values: Float64Array, distance: number): number {
  const [lo, hi, t] = interval(distances, distance);
  return values[lo] * (1 - t) + values[hi] * t;
}

function sizes(value: number | ArrayLike<number> | undefined, n: number, name: string, closed: boolean): Float64Array {
  const result = array(typeof value === 'number' || value === undefined ? undefined : value, n, name,
    typeof value === 'number' ? value : 1);
  if (result.some((v) => v < 0) || !result.some((v) => v > 0))
    throw rangeError(`${name} must be nonnegative with at least one positive sample`, 'sciviz');
  if (closed && result[0] !== result[n - 1])
    throw rangeError(`Closed ${name} must match at the repeated endpoint`, 'sciviz');
  return result;
}

function finish(geometry: GeometryData, state: ReturnType<typeof prepare>, startCapVertices = 0): StreamMesh {
  const values = new Float32Array(geometry.positions.length / 3);
  // sweep's v is normalized path distance, also on flat caps. Cap UVs use the cross-section plane instead;
  // the explicit geometry groups distinguish them so their scalar stays at the corresponding endpoint.
  const walls = geometry.groups?.find((group) => group.materialIndex === 1);
  for (let i = 0; i < values.length; i++)
    values[i] = interpolate(state.distances, state.scalar, geometry.uvs[i * 2 + 1] * state.total);
  // Caps have distinct vertices following all wall vertices, ordered start then end by the existing mesher.
  if (walls) {
    let lastWall = -1;
    for (let i = walls.start; i < walls.start + walls.count; i++) lastWall = Math.max(lastWall, geometry.indices[i]);
    for (let i = lastWall + 1; i < values.length; i++)
      values[i] = i < lastWall + 1 + startCapVertices ? state.scalar[0] : state.scalar[state.n - 1];
  }
  if (!geometry.positions.every(Number.isFinite) || !geometry.normals.every(Number.isFinite))
    throw rangeError('Sweep overflows or has an undefined normal; reduce coordinates or split the path', 'sciviz');
  return { ...geometry, values };
}

/** Scalar-radius scientific tube over a polyline, resampled at equal arc length using Margo's existing mesher. */
export function streamTubeGeometry(path: StreamPath, options: StreamTubeOptions = {}): StreamMesh {
  if (options.caps !== undefined && typeof options.caps !== 'boolean')
    throw rangeError('Caps must be a boolean', 'sciviz');
  const state = prepare(path, options),
    radius = sizes(options.radius, state.n, 'Tube radius', state.closed),
    sides = count(options.sides ?? 12, 3, 128, 'Tube sides');
  if ((state.steps + 1) * (sides + 1) > 1_000_000)
    throw rangeError('Tube exceeds one million vertices; reduce steps or sides', 'sciviz');
  const profile: [number, number][] = Array.from({ length: sides }, (_, i) =>
    [Math.cos(2 * Math.PI * i / sides), Math.sin(2 * Math.PI * i / sides)]);
  return finish(sweepGeometry(profile, state.curve, {
    steps: state.steps, closed: state.closed, caps: options.caps ?? true, creaseAngle: 180,
    scale: (t) => interpolate(state.distances, radius, t * state.total),
  }), state, !state.closed && (options.caps ?? true) && radius[0] > 0 ? sides : 0);
}

/**
 * Converts an indexed stream mesh for the existing sciviz/grids meshLayer renderer, preserving smooth normals.
 * The returned arrays are independent. Output typed arrays are limited to 128 MiB. WebGPU and the WebGL2
 * compatibility layer use the existing mesh renderer and restoration.
 */
export function streamMeshTriangles(mesh: StreamMesh, options: { readonly signal?: AbortSignal } = {}): TriangleSet {
  options.signal?.throwIfAborted();
  const count = mesh.positions.length / 3, corners = mesh.indices.length;
  if (!Number.isInteger(count) || !Number.isInteger(corners / 3) || !corners ||
    mesh.normals.length !== mesh.positions.length || mesh.values.length !== count ||
    !mesh.positions.every(Number.isFinite) || !mesh.normals.every(Number.isFinite) ||
    !mesh.values.every(Number.isFinite) || mesh.indices.some((i) => i >= count))
    throw rangeError('Stream mesh needs finite xyz, normals and scalar per vertex and valid triangle indices', 'sciviz');
  if (corners * 28 + corners / 3 * 4 > 128 * 1024 * 1024)
    throw rangeError('Stream triangle output exceeds 128 MiB; reduce sweep steps or sides', 'sciviz');
  const positions = new Float32Array(corners * 3), normals = new Float32Array(corners * 3),
    values = new Float32Array(corners), cells = new Uint32Array(corners / 3),
    bounds: Bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < corners; i++) {
    const vertex = mesh.indices[i]; values[i] = mesh.values[vertex];
    for (let c = 0; c < 3; c++) {
      const value = mesh.positions[3 * vertex + c];
      positions[i * 3 + c] = value; normals[i * 3 + c] = mesh.normals[3 * vertex + c];
      bounds[2 * c] = Math.min(bounds[2 * c], value); bounds[2 * c + 1] = Math.max(bounds[2 * c + 1], value);
    }
  }
  return { positions, normals, values, cells, bounds };
}

/** Ribbon with signed twist integral d(angle)/ds = streamwiseVorticity / (2 speed), in physical units. */
export function streamRibbonGeometry(path: StreamPath, options: StreamRibbonOptions = {}): StreamMesh {
  const state = prepare(path, options),
    width = sizes(options.width, state.n, 'Ribbon width', state.closed),
    omega = array(options.streamwiseVorticity, state.n, 'Streamwise vorticity'),
    speed = array(options.speeds, state.n, 'Ribbon speeds', 1),
    angles = new Float64Array(state.n);
  if (options.streamwiseVorticity && !options.speeds)
    throw rangeError('Vorticity twist needs positive physical speeds at every input point', 'sciviz');
  if (speed.some((v) => !(v > 0))) throw rangeError('Ribbon speeds must be positive; split at stagnation', 'sciviz');
  angles[0] = options.angle ?? 0;
  if (!Number.isFinite(angles[0])) throw rangeError('Ribbon angle must be finite radians', 'sciviz');
  for (let i = 1; i < state.n; i++) {
    angles[i] = angles[i - 1] + (state.distances[i] - state.distances[i - 1]) *
      (omega[i - 1] / speed[i - 1] + omega[i] / speed[i]) / 4;
    if (!Number.isFinite(angles[i]) || Math.abs(angles[i]) > 1e12)
      throw rangeError('Ribbon twist exceeds 1e12 radians; split the path or check speed units', 'sciviz');
  }
  if (state.closed && Math.abs(Math.sin((angles[state.n - 1] - angles[0]) / 2)) > 1e-10)
    throw rangeError('Closed ribbon physical twist must be a whole number of full turns; split it at the seam', 'sciviz');
  const twistAt = (t: number): number => {
    const distance = t * state.total, [lo, hi, f] = interval(state.distances, distance),
      a = omega[lo] / speed[lo], b = omega[hi] / speed[hi];
    // Integrate the piecewise-linear nodal angular rate, including its quadratic partial-interval term.
    return angles[lo] + (distance - state.distances[lo]) * (a + (b - a) * f / 2) / 2;
  };
  return finish(sweepGeometry([[-0.5, 0], [0.5, 0]], state.curve, {
    steps: state.steps, closed: state.closed, closedProfile: false, caps: false, creaseAngle: 180,
    scale: (t) => interpolate(state.distances, width, t * state.total),
    twist: twistAt,
  }), state);
}
