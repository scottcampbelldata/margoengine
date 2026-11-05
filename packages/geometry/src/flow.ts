// Bending geometry along a curve. A local point (along, up, side) goes to C(s) + up * N(s) + side * B(s), where s is the
// distance along the curve and N, B turn with it. Normals are mapped by the inverse transpose of that deformation's
// Jacobian, so they stay perpendicular to the bent surface however tight the bend.
import { perpendicular, sampleCount, transport, type Curve } from './curve.js';
import type { GeometryData } from './data.js';
import { cross, dot, normalize, rotateAxis, to3, type MutableVec3, type Vec } from './math.js';

/** Which local axis runs along the curve. Up is +y, or +z when `y` runs along the curve. */
export type FlowAxis = 'x' | 'y' | 'z';

/** Options of {@link CurveFlow}. */
export interface CurveFlowOptions {
  /** The curve is a loop: distances wrap, and the frames meet where it closes. Default false. */
  closed?: boolean;
  /** Frames sampled along the curve. Default 256; raise it for long curves with tight bends. */
  segments?: number;
  /** World direction the first frame's up leans towards. Default `[0, 1, 0]`. */
  up?: readonly [number, number, number];
  /**
   * Hold every frame's up towards `up`, for a train that must stay level. Default false: frames turn with the curve by
   * the smallest rotation, so a roller coaster goes through a loop without flipping.
   */
  lockUp?: boolean;
}

/** Options of {@link CurveFlow.deform}. */
export interface FlowDeformOptions {
  /** Local axis that runs along the curve. Default `'x'`. */
  axis?: FlowAxis;
  /** Distance along the curve of local coordinate 0. Default 0. */
  offset?: number;
  /** Stretch along the curve. Default 1. */
  scale?: number;
  /** Stretch the mesh's extent along `axis` over the whole curve; `offset` and `scale` then apply on top. Default false. */
  fit?: boolean;
}

/** Options of {@link CurveFlow.matrices}. */
export interface FlowMatricesOptions {
  /** Local axis that runs along the curve. Default `'x'`. */
  axis?: FlowAxis;
  /** Distance of the first instance. Default 0. */
  offset?: number;
  /** Distance between instances. Default even spacing over the curve, ends included unless it is closed. */
  spacing?: number;
}

/** Where a distance lands on the curve: a point and three unit directions. `side` is `tangent x up`. */
export interface FlowFrame {
  position: MutableVec3;
  tangent: MutableVec3;
  up: MutableVec3;
  side: MutableVec3;
}

/** Local coordinates: which component of a vector is along, up and side, and the sign of side. */
const layouts = {
  x: [0, 1, 2, 1],
  y: [1, 2, 0, 1],
  z: [2, 1, 0, -1],
} as const;

function layout(axis: FlowAxis): readonly [number, number, number, number] {
  const found = layouts[axis];
  if (!found) throw new RangeError(`CurveFlow axis ${axis} is invalid; pass 'x', 'y' or 'z'`);
  return found;
}

function finite(label: string, value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`CurveFlow ${label} ${value} is invalid; pass a finite number`);
  return value;
}

/** Unit vector of `up` across `tangent`, or `fallback` when the two are parallel. */
function across(up: MutableVec3, tangent: MutableVec3, fallback: MutableVec3): MutableVec3 {
  const along = dot(up, tangent),
    rest: MutableVec3 = [up[0] - tangent[0] * along, up[1] - tangent[1] * along, up[2] - tangent[2] * along];
  return dot(rest, rest) > 1e-12 ? normalize(rest) : fallback;
}

/**
 * Frames along a curve, sampled once at equal distances, for bending meshes and placing instances. Build one per curve
 * and reuse it: {@link CurveFlow.deform} bends a mesh (trains on tracks, text along a path, pipes, snakes), and
 * {@link CurveFlow.matrices} and {@link CurveFlow.matrixAt} place rigid copies. Past the ends of an open curve, shapes
 * carry on straight along the end tangent.
 */
export class CurveFlow {
  /** Length of the curve. */
  readonly length: number;
  /** Whether distances wrap around. */
  readonly closed: boolean;
  private readonly segments: number;
  private readonly points: Float64Array;
  private readonly tangents: Float64Array;
  private readonly ups: Float64Array;
  private readonly sides: Float64Array;

  /**
   * @param curve - Any curve; 2D curves lie in the z = 0 plane.
   * @param options - See {@link CurveFlowOptions}.
   * @throws RangeError when the curve has no length, an option is invalid or `up` has no length.
   */
  constructor(curve: Curve<Vec>, options: CurveFlowOptions = {}) {
    const { closed = false, segments = 256, up = [0, 1, 0], lockUp = false } = options,
      steps = Math.floor(sampleCount('CurveFlow', segments));
    if (steps < 1) throw new RangeError(`CurveFlow segments ${segments} is invalid; pass a finite number >= 1`);
    const towards = normalize([up[0], up[1], up[2]] as MutableVec3);
    if (!towards.every(Number.isFinite) || dot(towards, towards) === 0)
      throw new RangeError('CurveFlow up has no direction; pass a finite vector that is not zero');
    const length = curve.getLength();
    if (!(length > 0 && length < Infinity))
      throw new RangeError(`CurveFlow got a curve of length ${length}; pass a curve with a finite, non-zero length`);
    this.length = length;
    this.closed = closed;
    this.segments = steps;
    const count = steps + 1,
      tangents: MutableVec3[] = [],
      ups: MutableVec3[] = [];
    this.points = new Float64Array(count * 3);
    this.tangents = new Float64Array(count * 3);
    this.ups = new Float64Array(count * 3);
    this.sides = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.points.set(to3(curve.getPointAt(i / steps)), i * 3);
      tangents.push(normalize(to3(curve.getTangentAt(i / steps))));
    }
    // The first up: `up` across the first tangent, or any axis when they are parallel.
    const first = tangents[0],
      axis: MutableVec3 = Math.abs(first[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    ups.push(across(towards, first, perpendicular(axis, first)));
    for (let i = 1; i < count; i++) {
      const carried = transport(ups[i - 1], tangents[i - 1], tangents[i]);
      ups.push(lockUp ? across(towards, tangents[i], carried) : carried);
    }
    if (closed && !lockUp) {
      // The twist left after one lap, spread evenly, so the last frame meets the first.
      const carried = transport(ups[steps], tangents[steps], first),
        angle = Math.atan2(dot(cross(carried, ups[0]), first), dot(carried, ups[0]));
      for (let i = 1; i <= steps; i++)
        ups[i] = perpendicular(rotateAxis(ups[i], tangents[i], (angle * i) / steps), tangents[i]);
    }
    for (let i = 0; i < count; i++) {
      this.tangents.set(tangents[i], i * 3);
      this.ups.set(ups[i], i * 3);
      this.sides.set(normalize(cross(tangents[i], ups[i])), i * 3);
    }
  }

  /**
   * The frame at `distance` along the curve; a closed curve wraps it.
   *
   * @throws RangeError when `distance` is not finite.
   */
  getFrame(distance: number): FlowFrame {
    const out = new Float64Array(15);
    this.locate(finite('distance', distance), out);
    return {
      position: [out[0], out[1], out[2]],
      tangent: [out[3], out[4], out[5]],
      up: [out[6], out[7], out[8]],
      side: [out[9], out[10], out[11]],
    };
  }

  /**
   * Bends a mesh along the curve; the input is left alone. Positions, normals and tangents all move, with normals
   * exact for the bend. Only vertices move, so the mesh needs enough of them along `axis` to follow the curve.
   *
   * @param data - The mesh.
   * @param options - See {@link FlowDeformOptions}.
   * @throws RangeError when an option is invalid, or `fit` is set on a mesh with no extent along `axis`.
   */
  deform(data: GeometryData, options: FlowDeformOptions = {}): GeometryData {
    const { axis = 'x', fit = false } = options,
      [a, u, s, sign] = layout(axis),
      P = data.positions,
      N = data.normals,
      T = data.tangents,
      count = P.length / 3;
    let offset = finite('offset', options.offset ?? 0),
      scale = finite('scale', options.scale ?? 1);
    if (scale === 0) throw new RangeError('CurveFlow scale 0 flattens the mesh; pass a finite number other than 0');
    if (fit) {
      let low = Infinity,
        high = -Infinity;
      for (let i = 0; i < count; i++) {
        low = Math.min(low, P[i * 3 + a]);
        high = Math.max(high, P[i * 3 + a]);
      }
      if (!(high > low))
        throw new RangeError(`CurveFlow fit found no extent along ${axis}; pass a mesh with some length`);
      const stretch = this.length / (high - low);
      offset += -low * stretch * scale;
      scale *= stretch;
    }
    const positions = new Float32Array(P.length),
      normals = new Float32Array(N.length),
      tangents = T ? new Float32Array(T.length) : undefined,
      frame = new Float64Array(18),
      hasNormals = N.length === P.length;
    for (let i = 0; i < count; i++) {
      const at = i * 3,
        up = P[at + u],
        side = P[at + s] * sign;
      this.locate(P[at + a] * scale + offset, frame, true);
      const tx = frame[3],
        ty = frame[4],
        tz = frame[5],
        ux = frame[6],
        uy = frame[7],
        uz = frame[8],
        sx = frame[9],
        sy = frame[10],
        sz = frame[11];
      positions[at] = frame[0] + up * ux + side * sx;
      positions[at + 1] = frame[1] + up * uy + side * sy;
      positions[at + 2] = frame[2] + up * uz + side * sz;
      // The Jacobian's columns: how the point moves with `along`, with `up` and with `side`.
      const jx = (tx + up * frame[12] + side * frame[15]) * scale,
        jy = (ty + up * frame[13] + side * frame[16]) * scale,
        jz = (tz + up * frame[14] + side * frame[17]) * scale;
      if (hasNormals) {
        const na = N[at + a],
          nu = N[at + u],
          ns = N[at + s] * sign,
          // Inverse transpose by cofactors: the columns' pairwise cross products.
          nx = na * (uy * sz - uz * sy) + nu * (sy * jz - sz * jy) + ns * (jy * uz - jz * uy),
          ny = na * (uz * sx - ux * sz) + nu * (sz * jx - sx * jz) + ns * (jz * ux - jx * uz),
          nz = na * (ux * sy - uy * sx) + nu * (sx * jy - sy * jx) + ns * (jx * uy - jy * ux),
          flip = scale < 0 ? -1 : 1,
          size = (Math.hypot(nx, ny, nz) || 1) * flip;
        normals[at] = nx / size;
        normals[at + 1] = ny / size;
        normals[at + 2] = nz / size;
      }
      if (T && tangents) {
        const q = i * 4,
          ta = T[q + a],
          tu = T[q + u],
          ts = T[q + s] * sign,
          x = ta * jx + tu * ux + ts * sx,
          y = ta * jy + tu * uy + ts * sy,
          z = ta * jz + tu * uz + ts * sz,
          size = Math.hypot(x, y, z) || 1;
        tangents[q] = x / size;
        tangents[q + 1] = y / size;
        tangents[q + 2] = z / size;
        tangents[q + 3] = T[q + 3];
      }
    }
    const out: GeometryData = {
      positions,
      normals: hasNormals ? normals : N.slice(),
      uvs: data.uvs,
      indices: data.indices,
    };
    if (tangents) out.tangents = tangents;
    if (data.groups) out.groups = data.groups.map((g) => ({ ...g }));
    return out;
  }

  /**
   * A rigid placement at `distance`: a column-major 4x4 matrix taking local `axis` along the tangent and local up to the
   * frame's up. For moving a train along its track each frame, pass the same `target` to avoid allocating.
   *
   * @param distance - Distance along the curve.
   * @param axis - Local axis that runs along the curve. Default `'x'`.
   * @param target - Optional array of 16 to fill.
   * @throws RangeError when `distance` or `axis` is invalid.
   */
  matrixAt(distance: number, axis: FlowAxis = 'x', target: Float32Array = new Float32Array(16)): Float32Array {
    const frame = new Float64Array(15);
    this.locate(finite('distance', distance), frame);
    writeMatrix(frame, layout(axis), target, 0);
    return target;
  }

  /**
   * `count` rigid placements along the curve as column-major 4x4 matrices, 16 values each, ready for an instance buffer.
   *
   * @param count - Instances.
   * @param options - See {@link FlowMatricesOptions}.
   * @throws RangeError when `count` is not an integer of at least 0 or an option is invalid.
   */
  matrices(count: number, options: FlowMatricesOptions = {}): Float32Array {
    if (!Number.isInteger(count) || count < 0)
      throw new RangeError(`CurveFlow count ${count} is invalid; pass an integer >= 0`);
    const order = layout(options.axis ?? 'x'),
      offset = finite('offset', options.offset ?? 0),
      even = this.length / Math.max(1, this.closed ? count : count - 1),
      spacing = finite('spacing', options.spacing ?? even),
      out = new Float32Array(count * 16),
      frame = new Float64Array(15);
    for (let i = 0; i < count; i++) {
      this.locate(offset + i * spacing, frame);
      writeMatrix(frame, order, out, i * 16);
    }
    return out;
  }

  /**
   * Writes the interpolated frame into `out` (position, tangent, up, side), and with `slopes` how up and side change
   * per unit distance after them.
   */
  private locate(distance: number, out: Float64Array, slopes = false): void {
    const { length, segments, closed, points, tangents, ups, sides } = this;
    let at = distance,
      beyond = 0;
    if (closed) at = ((at % length) + length) % length;
    else if (at < 0) {
      beyond = at;
      at = 0;
    } else if (at > length) {
      beyond = at - length;
      at = length;
    }
    const place = (at / length) * segments,
      i = Math.min(segments - 1, Math.floor(place)),
      f = place - i,
      a = i * 3,
      b = a + 3;
    for (let k = 0; k < 3; k++) {
      out[3 + k] = tangents[a + k] + (tangents[b + k] - tangents[a + k]) * f;
      out[6 + k] = ups[a + k] + (ups[b + k] - ups[a + k]) * f;
      out[9 + k] = sides[a + k] + (sides[b + k] - sides[a + k]) * f;
    }
    for (const base of [3, 6, 9]) {
      const size = Math.hypot(out[base], out[base + 1], out[base + 2]) || 1;
      out[base] /= size;
      out[base + 1] /= size;
      out[base + 2] /= size;
    }
    for (let k = 0; k < 3; k++) out[k] = points[a + k] + (points[b + k] - points[a + k]) * f + out[3 + k] * beyond;
    if (!slopes) return;
    const rate = beyond ? 0 : segments / length;
    for (let k = 0; k < 3; k++) {
      out[12 + k] = (ups[b + k] - ups[a + k]) * rate;
      out[15 + k] = (sides[b + k] - sides[a + k]) * rate;
    }
  }
}

/** The placement matrix of a frame: local along, up and side axes go to tangent, up and side. */
function writeMatrix(
  frame: Float64Array,
  [a, u, s, sign]: readonly [number, number, number, number],
  out: Float32Array,
  at: number,
): void {
  for (let k = 0; k < 3; k++) {
    out[at + a * 4 + k] = frame[3 + k];
    out[at + u * 4 + k] = frame[6 + k];
    out[at + s * 4 + k] = frame[9 + k] * sign;
    out[at + 12 + k] = frame[k];
  }
  out[at + 3] = out[at + 7] = out[at + 11] = 0;
  out[at + 15] = 1;
}

/**
 * Bends a mesh along a curve in one call: `new CurveFlow(curve, options).deform(data, options)`. Build a
 * {@link CurveFlow} yourself to bend several meshes or to animate `offset`.
 *
 * @param data - The mesh.
 * @param curve - The curve.
 * @param options - {@link CurveFlowOptions} and {@link FlowDeformOptions}.
 * @throws RangeError when an option is invalid or the curve has no length.
 */
export function flowGeometry(
  data: GeometryData,
  curve: Curve<Vec>,
  options: CurveFlowOptions & FlowDeformOptions = {},
): GeometryData {
  return new CurveFlow(curve, options).deform(data, options);
}
