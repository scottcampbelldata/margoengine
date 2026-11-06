import type { Spline } from './index.js';
import { newFrame, SplineFrames, type SplineFrame, type SplineFramesOptions } from './frames.js';

/** Which local axis of the placed or bent mesh runs along the spline. */
export type ForwardAxis = 'x' | 'y' | 'z';
/** Frames to use: a ready {@link SplineFrames}, or options to build them from the spline. */
export type SplineFrameSource = SplineFrames | SplineFramesOptions;

const AXES: Record<ForwardAxis, { f: number; u: number; w: number; sign: number }> = {
  // Up is y (z for a y-forward mesh). `sign` is -1 where (forward, up, third) is not a cyclic order of (x, y, z),
  // so the basis stays right-handed: the third column is sign * (tangent x normal).
  x: { f: 0, u: 1, w: 2, sign: 1 },
  y: { f: 1, u: 2, w: 0, sign: 1 },
  z: { f: 2, u: 1, w: 0, sign: -1 },
};
const axisOf = (axis: ForwardAxis): { f: number; u: number; w: number; sign: number } => {
  const a = AXES[axis];
  if (!a) throw new RangeError("axis must be 'x', 'y' or 'z'");
  return a;
};
const framesOf = (spline: Spline, source: SplineFrameSource | undefined): SplineFrames =>
  source instanceof SplineFrames ? source : new SplineFrames(spline, source);
/** Fill `basis` (9 numbers: three columns, x then y then z) from a frame for a forward axis. */
const basisOf = (
  frame: SplineFrame,
  a: { f: number; u: number; w: number; sign: number },
  basis: Float64Array,
): void => {
  for (let k = 0; k < 3; k++) {
    basis[a.f * 3 + k] = frame.tangent[k];
    basis[a.u * 3 + k] = frame.normal[k];
    basis[a.w * 3 + k] = frame.binormal[k] * a.sign;
  }
};

/**
 * The rotation that puts a mesh's `forward` axis along a frame's tangent and its up axis on the frame normal: 9 numbers,
 * three columns, x then y then z, the same turn {@link placeAlongSpline} gives its instances.
 * @throws RangeError for an unknown axis.
 */
export function frameBasis(
  frame: SplineFrame,
  forward: ForwardAxis = 'z',
  out: Float64Array = new Float64Array(9),
): Float64Array {
  basisOf(frame, axisOf(forward), out);
  return out;
}

/** Options for {@link placeAlongSpline}. */
export interface SplinePlaceOptions {
  /** Distance between instances, above 0. Give this or `count`. */
  spacing?: number;
  /** Number of instances, an integer 1..1,000,000; spread evenly from `start` to `end`. Give this or `spacing`. */
  count?: number;
  /** Arc-length position of the first instance. Default 0. */
  start?: number;
  /** Arc-length position the run stops at. Default the spline length. */
  end?: number;
  /** With `spacing`: stretch the gaps slightly so the last instance sits exactly on `end`. Default false. */
  fit?: boolean;
  /** Local axis that points along the spline. Default 'z'. */
  forward?: ForwardAxis;
  /** Uniform scale or per-axis scale of every instance. Default 1. */
  scale?: number | ArrayLike<number>;
  /** Keep instances upright and facing the same way instead of following the curve. Default false. */
  align?: boolean;
  frames?: SplineFrameSource;
}
/** Matrices from {@link placeAlongSpline}: `count` column-major 4x4 matrices in one array. */
export interface SplinePlacement {
  count: number;
  /** 16 numbers per instance, ready for an instance buffer. */
  matrices: Float32Array;
  /** Arc-length position of each instance. */
  distances: Float64Array;
}

/**
 * Instance matrices at a spacing along a spline, for fences, rails, lamp posts and the like. Each matrix puts the
 * mesh's `forward` axis along the tangent and its up axis on the frame normal, so the run follows hills and turns
 * without flipping (see {@link SplineFrames}); `align: false` keeps every instance upright with no turning at all.
 */
export function placeAlongSpline(spline: Spline, options: SplinePlaceOptions): SplinePlacement {
  const { spacing, count, start = 0, forward = 'z', fit = false, align = true, scale = 1 } = options,
    a = axisOf(forward),
    end = options.end ?? spline.length;
  if ((spacing === undefined) === (count === undefined)) throw new RangeError('Give exactly one of spacing or count');
  if (!(Number.isFinite(start) && Number.isFinite(end)) || start < 0 || end > spline.length || end < start)
    throw new RangeError('start and end must satisfy 0 <= start <= end <= spline length');
  const scales = typeof scale === 'number' ? [scale, scale, scale] : Array.from(scale);
  if (scales.length !== 3 || !scales.every(Number.isFinite))
    throw new RangeError('scale must be a finite number or 3 numbers');
  let n: number, step: number;
  if (count !== undefined) {
    if (!Number.isInteger(count) || count < 1 || count > 1_000_000)
      throw new RangeError('count must be an integer from 1 to 1,000,000');
    n = count;
    step = n > 1 ? (end - start) / (n - 1) : 0;
  } else {
    if (!(Number.isFinite(spacing) && spacing! > 0)) throw new RangeError('spacing must be above 0');
    const run = (end - start) / spacing!;
    if (run > 1_000_000)
      throw new RangeError('That spacing gives more than 1,000,000 instances; raise spacing or shorten the run');
    n = Math.floor(run + 1e-9) + 1;
    step = fit && n > 1 ? (end - start) / (n - 1) : spacing!;
  }
  const frames = framesOf(spline, options.frames),
    frame = newFrame(),
    basis = new Float64Array(9),
    matrices = new Float32Array(n * 16),
    distances = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.min(spline.length, start + i * step);
    distances[i] = d;
    frames.frameAt(d, frame);
    if (align) basisOf(frame, a, basis);
    else basis.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const o = i * 16;
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) matrices[o + c * 4 + r] = basis[c * 3 + r] * scales[c];
    matrices[o + 12] = frame.position[0];
    matrices[o + 13] = frame.position[1];
    matrices[o + 14] = frame.position[2];
    matrices[o + 15] = 1;
  }
  return { count: n, matrices, distances };
}

/** Options for {@link deformAlongSpline}. */
export interface SplineDeformOptions {
  /** Local axis of the mesh that runs along the spline. Default 'z'. */
  axis?: ForwardAxis;
  /** Arc-length position the mesh's low end sits at. Default 0. */
  offset?: number;
  /** 'none' keeps the mesh's own length; 'stretch' scales its length to run from `offset` to the spline's end. Default 'none'. */
  fit?: 'none' | 'stretch';
  /** Past the spline's ends: 'clamp' holds the end frame (the mesh squashes flat), 'extend' continues straight along the end tangent. Default 'extend'. */
  overflow?: 'clamp' | 'extend';
  /** Unit normals (3 per vertex) to rotate with the bend. */
  normals?: ArrayLike<number>;
  frames?: SplineFrameSource;
}
/** Result of {@link deformAlongSpline}. */
export interface SplineDeformed {
  positions: Float32Array | Float64Array;
  /** Present when `normals` was given. Rotated with the frame, not re-derived, so a hard bend leaves them slightly off. */
  normals?: Float32Array | Float64Array;
}

/**
 * Bend a mesh along a spline, for pipes, roads and rails. The vertex position along `axis` becomes a distance along
 * the curve, and its other two coordinates become offsets in the frame there. A mesh that is long and straight
 * along its axis follows the curve; one with few segments bends in straight chords, so subdivide it first.
 */
export function deformAlongSpline(
  spline: Spline,
  positions: ArrayLike<number>,
  options: SplineDeformOptions = {},
): SplineDeformed {
  const { axis = 'z', offset = 0, fit = 'none', overflow = 'extend', normals } = options,
    a = axisOf(axis);
  if (positions.length % 3) throw new RangeError('positions must hold 3 numbers per vertex');
  if (normals && normals.length !== positions.length) throw new RangeError('normals must match positions in length');
  if (!Number.isFinite(offset) || offset < 0 || offset > spline.length)
    throw new RangeError('offset must be within the spline length');
  if (fit !== 'none' && fit !== 'stretch') throw new RangeError("fit must be 'none' or 'stretch'");
  if (overflow !== 'clamp' && overflow !== 'extend') throw new RangeError("overflow must be 'clamp' or 'extend'");
  const vertices = positions.length / 3;
  let low = Infinity,
    high = -Infinity;
  for (let i = 0; i < vertices; i++) {
    const v = positions[i * 3 + a.f];
    if (!Number.isFinite(v) || !Number.isFinite(positions[i * 3 + a.u]) || !Number.isFinite(positions[i * 3 + a.w]))
      throw new RangeError('positions must be finite');
    if (v < low) low = v;
    if (v > high) high = v;
  }
  const scale = fit === 'stretch' && high > low ? (spline.length - offset) / (high - low) : 1,
    frames = framesOf(spline, options.frames),
    wide = positions instanceof Float64Array || normals instanceof Float64Array,
    outP = wide ? new Float64Array(positions.length) : new Float32Array(positions.length),
    outN = normals ? (wide ? new Float64Array(positions.length) : new Float32Array(positions.length)) : undefined,
    basis = new Float64Array(9),
    cache = new Map<number, { frame: SplineFrame; extra: number }>();
  for (let i = 0; i < vertices; i++) {
    const o = i * 3,
      want = offset + (positions[o + a.f] - low) * scale,
      d = Math.min(spline.length, Math.max(0, want)),
      key = want;
    let entry = cache.get(key);
    if (!entry) {
      entry = { frame: frames.frameAt(d, newFrame()), extra: overflow === 'extend' ? want - d : 0 };
      cache.set(key, entry);
    }
    basisOf(entry.frame, a, basis);
    const along = entry.extra,
      lu = positions[o + a.u],
      lw = positions[o + a.w];
    for (let k = 0; k < 3; k++)
      outP[o + k] =
        entry.frame.position[k] + along * entry.frame.tangent[k] + lu * basis[a.u * 3 + k] + lw * basis[a.w * 3 + k];
    if (normals && outN) {
      for (let k = 0; k < 3; k++)
        outN[o + k] =
          normals[o + a.f] * basis[a.f * 3 + k] +
          normals[o + a.u] * basis[a.u * 3 + k] +
          normals[o + a.w] * basis[a.w * 3 + k];
    }
  }
  return outN ? { positions: outP, normals: outN } : { positions: outP };
}
