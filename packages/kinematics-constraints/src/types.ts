import type { ConvexHullVolume } from './hull.js';

/** A three-component vector in the caller's common coordinate frame. */
export type Vec3View = readonly [number, number, number] | Float32Array | Float64Array;
/** Writable, caller-owned vector storage. Only vectors of length three are accepted. */
export type MutableVec3View = [number, number, number] | Float32Array | Float64Array;

/** Geometry used by the constraint solver, independent of any scene or rig. */
export interface ConstraintVolume {
  /** Signed distance to the surface: negative inside, positive outside. */
  evaluate(point: Vec3View, outSurface: MutableVec3View, outNormal: MutableVec3View): number;
  /** Signed clearance between a swept segment and this volume. */
  segmentClearance(start: Vec3View, end: Vec3View, radius: number): number;
  /** Optional form of `evaluate` that writes the distance to `outDistance[0]`; the solver prefers it. */
  evaluateInto?(
    point: Vec3View,
    outSurface: MutableVec3View,
    outNormal: MutableVec3View,
    outDistance: Float64Array,
  ): void;
  /** Optional form of `segmentClearance` that writes the gap to `outDistance[0]`; the solver prefers it. */
  segmentClearanceInto?(start: Vec3View, end: Vec3View, radius: number, outDistance: Float64Array): void;
  /**
   * Signed gap to a convex hull, written to `outDistance[0]`. A solver with link hulls needs this on every collider;
   * spheres, capsules and hulls have it.
   */
  hullClearanceInto?(hull: ConvexHullVolume, outDistance: Float64Array): void;
}

// Bounded coordinates leave ample headroom for differences and scalar products.
// World coordinates this large are not useful at graphics precision, but rejecting
// overflow is preferable to silently turning a valid query into NaN.
const MAX_MAGNITUDE = 1e100;
const FLOAT32_MAX = 3.4028234663852886e38;

/** Fixed-arity norm; avoids variadic builtin boxing while retaining tiny/large ranges. */
export function length3(x: number, y: number, z: number): number {
  const squared = x * x + y * y + z * z;
  return squared >= 1e-300 && squared < Infinity ? Math.sqrt(squared) : scaledLength3(x, y, z);
}

/** The slow path of length3, for squared lengths too small or too large for a double. */
export function scaledLength3(x: number, y: number, z: number): number {
  const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (scale === 0) return 0;
  x /= scale;
  y /= scale;
  z /= scale;
  return scale * Math.sqrt(x * x + y * y + z * z);
}

function validateFinite(value: number, name = 'value'): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_MAGNITUDE) {
    throw new RangeError(`${name} must be finite with magnitude at most 1e100`);
  }
}

export function validateNonNegative(value: number, name = 'value'): void {
  validateFinite(value, name);
  if (value < 0) throw new RangeError(`${name} must be non-negative`);
}

export function validatePositive(value: number, name = 'value'): void {
  validateFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function isVector(value: unknown): value is Vec3View {
  return (Array.isArray(value) || value instanceof Float32Array || value instanceof Float64Array) && value.length === 3;
}

// An element access that has seen more than one array type boxes each value, and callers mix tuples and typed arrays.
// So each type gets its own copy of the access: V8 keeps the types seen per line of code.
/** Copies a three-component vector to `into` at element `at`. */
export function readVector(from: Vec3View, into: Float64Array, at: number): void {
  if (from instanceof Float64Array) {
    into[at] = from[0];
    into[at + 1] = from[1];
    into[at + 2] = from[2];
  } else if (from instanceof Float32Array) {
    into[at] = from[0];
    into[at + 1] = from[1];
    into[at + 2] = from[2];
  } else {
    into[at] = from[0];
    into[at + 1] = from[1];
    into[at + 2] = from[2];
  }
}

/** Copies three elements of `from` at element `at` to a vector. */
export function writeVector(out: MutableVec3View, from: Float64Array, at: number): void {
  if (out instanceof Float64Array) {
    out[0] = from[at];
    out[1] = from[at + 1];
    out[2] = from[at + 2];
  } else if (out instanceof Float32Array) {
    out[0] = from[at];
    out[1] = from[at + 1];
    out[2] = from[at + 2];
  } else {
    out[0] = from[at];
    out[1] = from[at + 1];
    out[2] = from[at + 2];
  }
}

const checked = /* @__PURE__ */ new Float64Array(3);

export function validateVector(value: Vec3View, name = 'vector'): void {
  if (value instanceof Float64Array && value.length === 3) {
    checked[0] = value[0];
    checked[1] = value[1];
    checked[2] = value[2];
  } else if (value instanceof Float32Array && value.length === 3) {
    checked[0] = value[0];
    checked[1] = value[1];
    checked[2] = value[2];
  } else if (Array.isArray(value) && value.length === 3) {
    const x = value[0],
      y = value[1],
      z = value[2];
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number')
      throw new RangeError(`${name} must be finite with magnitude at most 1e100`);
    checked[0] = x;
    checked[1] = y;
    checked[2] = z;
  } else throw new TypeError(`${name} must have three components`);
  // Compared here, not in a call: passing a double to validateFinite boxes it whenever V8 did not inline the call, and
  // this runs for every proxy on every candidate pose. A comparison with NaN is false.
  const x = checked[0],
    y = checked[1],
    z = checked[2];
  if (
    !(x <= MAX_MAGNITUDE && x >= -MAX_MAGNITUDE && y <= MAX_MAGNITUDE && y >= -MAX_MAGNITUDE) ||
    !(z <= MAX_MAGNITUDE && z >= -MAX_MAGNITUDE)
  )
    throw new RangeError(`${name} must be finite with magnitude at most 1e100`);
}

export function validateOutputVector(value: MutableVec3View, name = 'output vector'): void {
  if (!isVector(value) || Object.isFrozen(value)) {
    throw new TypeError(`${name} must be a writable three-component vector`);
  }
}

/** Reject impossible simultaneous outputs, including overlapping typed-array views. */
export function validateDistinctOutputs(a: MutableVec3View, b: MutableVec3View): void {
  if (
    a === b ||
    (!Array.isArray(a) &&
      !Array.isArray(b) &&
      a.buffer === b.buffer &&
      a.byteOffset < b.byteOffset + b.byteLength &&
      b.byteOffset < a.byteOffset + a.byteLength)
  ) {
    throw new TypeError('Output vectors must not overlap');
  }
}

export function validateOutputValues(out: MutableVec3View, x: number, y: number, z: number): void {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z) ||
    (out instanceof Float32Array &&
      (Math.abs(x) > FLOAT32_MAX || Math.abs(y) > FLOAT32_MAX || Math.abs(z) > FLOAT32_MAX))
  ) {
    throw new RangeError('Result exceeds output precision; scale the scene down or move it nearer the origin');
  }
}
