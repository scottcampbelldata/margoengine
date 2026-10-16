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

function scaledLength3(x: number, y: number, z: number): number {
  const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (scale === 0) return 0;
  x /= scale; y /= scale; z /= scale;
  return scale * Math.sqrt(x * x + y * y + z * z);
}

export function validateFinite(value: number, name = 'value'): void {
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
  return (Array.isArray(value) || value instanceof Float32Array || value instanceof Float64Array)
    && value.length === 3;
}

export function validateVector(value: Vec3View, name = 'vector'): void {
  if (!isVector(value)) throw new TypeError(`${name} must have three components`);
  validateFinite(value[0], name);
  validateFinite(value[1], name);
  validateFinite(value[2], name);
}

export function validateOutputVector(value: MutableVec3View, name = 'output vector'): void {
  if (!isVector(value) || Object.isFrozen(value)) {
    throw new TypeError(`${name} must be a writable three-component vector`);
  }
}

/** Reject impossible simultaneous outputs, including overlapping typed-array views. */
export function validateDistinctOutputs(a: MutableVec3View, b: MutableVec3View): void {
  if (a === b || (!Array.isArray(a) && !Array.isArray(b) && a.buffer === b.buffer
    && a.byteOffset < b.byteOffset + b.byteLength && b.byteOffset < a.byteOffset + a.byteLength)) {
    throw new TypeError('Output vectors must not overlap');
  }
}

export function validateOutputValues(out: MutableVec3View, x: number, y: number, z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
    || out instanceof Float32Array && (Math.abs(x) > FLOAT32_MAX || Math.abs(y) > FLOAT32_MAX || Math.abs(z) > FLOAT32_MAX)) {
    throw new RangeError('Result exceeds output precision');
  }
}
