import { typeError } from '../../shared/errors.js';
import type { ConvexHullVolume } from './hull.js';
import type { ConstraintVolume, MutableVec3View, Vec3View } from './types.js';
import {
  validateDistinctOutputs,
  validateNonNegative,
  validateOutputValues,
  validateOutputVector,
  validateVector,
  writeVector,
} from './types.js';

/** Closest points between two segments, their distance and the parameter of each point along its segment. */
export interface SegmentDistanceResult {
  pointA: MutableVec3View;
  pointB: MutableVec3View;
  distance: number;
  parameterA: number;
  parameterB: number;
}

/** A sphere collider: its centre and radius in scene units. */
export interface SphereVolumeOptions {
  center: Vec3View;
  radius: number;
}
/** A capsule collider: the two end points of its axis and its radius in scene units. */
export interface CapsuleVolumeOptions {
  start: Vec3View;
  end: Vec3View;
  radius: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function scaledMagnitude(x: number, y: number, z: number, scale: number): number {
  const componentScale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (componentScale === 0) return 0;
  const sx = x / componentScale,
    sy = y / componentScale,
    sz = z / componentScale;
  const length = Math.sqrt(sx * sx + sy * sy + sz * sz);
  return rescaleLength(componentScale, length, scale);
}

function rescaleLength(componentScale: number, length: number, scale: number): number {
  // Restore a subnormal component before multiplying by its normalized length;
  // otherwise preserve the length factor before the final possible underflow.
  return componentScale < 2 ** -1022 ? componentScale * scale * length : componentScale * length * scale;
}

function newSegmentResult(): SegmentDistanceResult {
  return { pointA: [0, 0, 0], pointB: [0, 0, 0], distance: 0, parameterA: 0, parameterB: 0 };
}

/**
 * Closest points on two closed line segments. Supply `out` to reuse storage.
 * Inputs may alias output points; the two output points must be distinct.
 */
export function closestPointsBetweenSegments(
  a: Vec3View,
  b: Vec3View,
  c: Vec3View,
  d: Vec3View,
  out?: SegmentDistanceResult,
): SegmentDistanceResult {
  validateVector(a, 'segment start');
  validateVector(b, 'segment end');
  validateVector(c, 'segment start');
  validateVector(d, 'segment end');
  const result = out ?? newSegmentResult();
  validateOutputVector(result.pointA);
  validateOutputVector(result.pointB);
  validateDistinctOutputs(result.pointA, result.pointB);

  // Translate and scale the problem before finding physical parameters along
  // unit directions. Scaling also preserves parameters for subnormal segments,
  // whose unscaled lengths cannot represent fractional distances along them.
  const ax = a[0],
    ay = a[1],
    az = a[2],
    bx = b[0],
    by = b[1],
    bz = b[2];
  const cx = c[0],
    cy = c[1],
    cz = c[2],
    dx = d[0],
    dy = d[1],
    dz = d[2];
  let ux = bx - ax,
    uy = by - ay,
    uz = bz - az;
  let vx = dx - cx,
    vy = dy - cy,
    vz = dz - cz;
  let wx = ax - cx,
    wy = ay - cy,
    wz = az - cz;
  const scale = Math.max(
    Math.abs(ux),
    Math.abs(uy),
    Math.abs(uz),
    Math.abs(vx),
    Math.abs(vy),
    Math.abs(vz),
    Math.abs(wx),
    Math.abs(wy),
    Math.abs(wz),
  );
  if (scale > 0) {
    ux /= scale;
    uy /= scale;
    uz /= scale;
    vx /= scale;
    vy /= scale;
    vz /= scale;
    wx /= scale;
    wy /= scale;
    wz /= scale;
  }
  const deltaAX = ux,
    deltaAY = uy,
    deltaAZ = uz,
    deltaBX = vx,
    deltaBY = vy,
    deltaBZ = vz;
  // length3 written out, scaled slow path included. A call in one branch of a ternary makes the whole value a tagged
  // number, which boxes the result of the fast branch too.
  const squaredA = ux * ux + uy * uy + uz * uz,
    squaredB = vx * vx + vy * vy + vz * vz;
  let lengthA = Math.sqrt(squaredA),
    lengthB = Math.sqrt(squaredB);
  if (!(squaredA >= 1e-300 && squaredA < Infinity)) {
    const big = Math.max(Math.abs(ux), Math.abs(uy), Math.abs(uz));
    lengthA =
      big === 0 ? 0 : big * Math.sqrt((ux / big) * (ux / big) + (uy / big) * (uy / big) + (uz / big) * (uz / big));
  }
  if (!(squaredB >= 1e-300 && squaredB < Infinity)) {
    const big = Math.max(Math.abs(vx), Math.abs(vy), Math.abs(vz));
    lengthB =
      big === 0 ? 0 : big * Math.sqrt((vx / big) * (vx / big) + (vy / big) * (vy / big) + (vz / big) * (vz / big));
  }
  const scaleA = Math.max(Math.abs(ux), Math.abs(uy), Math.abs(uz));
  const scaleB = Math.max(Math.abs(vx), Math.abs(vy), Math.abs(vz));
  if (scaleA > 0) {
    ux /= scaleA;
    uy /= scaleA;
    uz /= scaleA;
    const normalLength = Math.sqrt(ux * ux + uy * uy + uz * uz);
    ux /= normalLength;
    uy /= normalLength;
    uz /= normalLength;
  }
  if (scaleB > 0) {
    vx /= scaleB;
    vy /= scaleB;
    vz /= scaleB;
    const normalLength = Math.sqrt(vx * vx + vy * vy + vz * vz);
    vx /= normalLength;
    vy /= normalLength;
    vz /= normalLength;
  }
  let alongA = 0,
    alongB = 0;
  const projectionA = ux * wx + uy * wy + uz * wz;
  const projectionB = vx * wx + vy * wy + vz * wz;
  if (lengthA === 0) {
    if (lengthB > 0) alongB = Math.max(0, Math.min(lengthB, projectionB));
  } else if (lengthB === 0) {
    alongA = Math.max(0, Math.min(lengthA, -projectionA));
  } else {
    const cosine = Math.max(-1, Math.min(1, ux * vx + uy * vy + uz * vz));
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const crossScale = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
    if (crossScale > 0) {
      // A normalized cross product avoids 1-dot(u,v)^2 cancellation for nearly
      // parallel directions, even when their sine is subnormal. Scale the
      // separation before its cross product as well, preserving tiny offsets.
      const sx = nx / crossScale,
        sy = ny / crossScale,
        sz = nz / crossScale;
      const sine = Math.sqrt(sx * sx + sy * sy + sz * sz);
      const separationScale = Math.max(Math.abs(wx), Math.abs(wy), Math.abs(wz));
      if (separationScale > 0) {
        const wxScaled = wx / separationScale,
          wyScaled = wy / separationScale,
          wzScaled = wz / separationScale;
        const crossX = wyScaled * vz - wzScaled * vy,
          crossY = wzScaled * vx - wxScaled * vz,
          crossZ = wxScaled * vy - wyScaled * vx;
        const numerator =
          crossX * (nx / crossScale / sine) + crossY * (ny / crossScale / sine) + crossZ * (nz / crossScale / sine);
        // An infinite line parameter is safe to clamp. Avoid 0 * Infinity for
        // coincident lines whose remote intersection has no unique parameter.
        alongA =
          numerator === 0 ? 0 : Math.max(0, Math.min(lengthA, -(numerator / sine) * (separationScale / crossScale)));
      }
    }
    alongB = cosine * alongA + projectionB;
    if (alongB < 0) {
      alongB = 0;
      alongA = Math.max(0, Math.min(lengthA, -projectionA));
    } else if (alongB > lengthB) {
      alongB = lengthB;
      alongA = Math.max(0, Math.min(lengthA, cosine * lengthB - projectionA));
    }
  }
  const parameterA = lengthA > 0 ? alongA / lengthA : 0;
  const parameterB = lengthB > 0 ? alongB / lengthB : 0;
  // Clamp and interpolation are written out in this kernel: V8 leaves them as calls here, and each call boxes its result.
  const pax = parameterA > 0.5 ? bx + (ax - bx) * (1 - parameterA) : ax + (bx - ax) * parameterA,
    pay = parameterA > 0.5 ? by + (ay - by) * (1 - parameterA) : ay + (by - ay) * parameterA,
    paz = parameterA > 0.5 ? bz + (az - bz) * (1 - parameterA) : az + (bz - az) * parameterA;
  const pbx = parameterB > 0.5 ? dx + (cx - dx) * (1 - parameterB) : cx + (dx - cx) * parameterB,
    pby = parameterB > 0.5 ? dy + (cy - dy) * (1 - parameterB) : cy + (dy - cy) * parameterB,
    pbz = parameterB > 0.5 ? dz + (cz - dz) * (1 - parameterB) : cz + (dz - cz) * parameterB;
  // Keep these scalar guards in the segment kernel: an out-of-line validation
  // call boxes all six coordinates in otherwise optimized V8 code. Check both
  // outputs before writing either, preserving atomic validation and aliasing.
  if (
    !Number.isFinite(pax) ||
    !Number.isFinite(pay) ||
    !Number.isFinite(paz) ||
    !Number.isFinite(pbx) ||
    !Number.isFinite(pby) ||
    !Number.isFinite(pbz) ||
    (result.pointA instanceof Float32Array &&
      (Math.abs(pax) > 3.4028234663852886e38 ||
        Math.abs(pay) > 3.4028234663852886e38 ||
        Math.abs(paz) > 3.4028234663852886e38)) ||
    (result.pointB instanceof Float32Array &&
      (Math.abs(pbx) > 3.4028234663852886e38 ||
        Math.abs(pby) > 3.4028234663852886e38 ||
        Math.abs(pbz) > 3.4028234663852886e38))
  ) {
    throw new RangeError('Result exceeds output precision; scale the scene down or move it nearer the origin');
  }
  result.pointA[0] = pax;
  result.pointA[1] = pay;
  result.pointA[2] = paz;
  result.pointB[0] = pbx;
  result.pointB[1] = pby;
  result.pointB[2] = pbz;
  // Likewise keep the four numeric arguments to scaledMagnitude unboxed here.
  // Preserve its scale-first ordering for subnormal residual components.
  const residualX = wx + deltaAX * parameterA - deltaBX * parameterB;
  const residualY = wy + deltaAY * parameterA - deltaBY * parameterB;
  const residualZ = wz + deltaAZ * parameterA - deltaBZ * parameterB;
  const residualScale = Math.max(Math.abs(residualX), Math.abs(residualY), Math.abs(residualZ));
  let distance = 0;
  if (residualScale > 0) {
    const x = residualX / residualScale,
      y = residualY / residualScale,
      z = residualZ / residualScale;
    const length = Math.sqrt(x * x + y * y + z * z);
    distance = residualScale < 2 ** -1022 ? residualScale * scale * length : residualScale * length * scale;
  }
  result.distance = distance;
  result.parameterA = parameterA;
  result.parameterB = parameterB;
  return result;
}

function validateQuery(point: Vec3View, outSurface: MutableVec3View, outNormal: MutableVec3View): void {
  validateVector(point, 'query point');
  validateOutputVector(outSurface, 'surface output');
  validateOutputVector(outNormal, 'normal output');
  validateDistinctOutputs(outSurface, outNormal);
}

function writeSurface(
  outSurface: MutableVec3View,
  outNormal: MutableVec3View,
  cx: number,
  cy: number,
  cz: number,
  nx: number,
  ny: number,
  nz: number,
  radius: number,
): void {
  const x = cx + nx * radius,
    y = cy + ny * radius,
    z = cz + nz * radius;
  validateOutputValues(outSurface, x, y, z);
  outSurface[0] = x;
  outSurface[1] = y;
  outSurface[2] = z;
  outNormal[0] = nx;
  outNormal[1] = ny;
  outNormal[2] = nz;
}

// The capsule kernel hands its six result numbers over in this array instead of as arguments: it is too large for V8
// to inline writeSurface into, and every double passed to a call that is not inlined is boxed.
const capsuleSurface = /* @__PURE__ */ new Float64Array(6);

/** The checks and writes of writeSurface, reading the surface point and the normal from capsuleSurface. */
function writeCapsuleSurface(outSurface: MutableVec3View, outNormal: MutableVec3View): void {
  const x = capsuleSurface[0],
    y = capsuleSurface[1],
    z = capsuleSurface[2];
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z) ||
    (outSurface instanceof Float32Array &&
      (Math.abs(x) > 3.4028234663852886e38 ||
        Math.abs(y) > 3.4028234663852886e38 ||
        Math.abs(z) > 3.4028234663852886e38))
  ) {
    throw new RangeError('Result exceeds output precision; scale the scene down or move it nearer the origin');
  }
  writeVector(outSurface, capsuleSurface, 0);
  writeVector(outNormal, capsuleSurface, 3);
}

// The public numeric adapters share one slot without adding instance fields.
// Kernels write it LAST, after every observable getter/output setter; nested
// public evaluations therefore finish before the outer result is published.
// Solver calls use their own slot and never cross the numeric return boundary.
const publicDistance = new Float64Array(1);

function evaluateSphereInto(
  volume: SphereVolume,
  point: Vec3View,
  outSurface: MutableVec3View,
  outNormal: MutableVec3View,
  outDistance: Float64Array,
): void {
  validateVector(volume.center, 'sphere center');
  validateNonNegative(volume.radius, 'sphere radius');
  validateQuery(point, outSurface, outNormal);
  const cx = volume.center[0],
    cy = volume.center[1],
    cz = volume.center[2],
    radius = volume.radius;
  let nx = point[0] - cx,
    ny = point[1] - cy,
    nz = point[2] - cz;
  const scale = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
  let distance = 0;
  if (scale > 0) {
    nx /= scale;
    ny /= scale;
    nz /= scale;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    distance = scale * length;
    nx /= length;
    ny /= length;
    nz /= length;
  } else {
    nx = 1;
    ny = 0;
    nz = 0;
  }
  writeSurface(outSurface, outNormal, cx, cy, cz, nx, ny, nz, radius);
  outDistance[0] = distance - radius;
}

function evaluateCapsuleInto(
  volume: CapsuleVolume,
  point: Vec3View,
  outSurface: MutableVec3View,
  outNormal: MutableVec3View,
  outDistance: Float64Array,
): void {
  validateVector(volume.start, 'capsule start');
  validateVector(volume.end, 'capsule end');
  // A comparison, not a call: a double passed to validateNonNegative is boxed. NaN fails it too, and the call then throws.
  if (!(volume.radius >= 0 && volume.radius <= 1e100)) validateNonNegative(volume.radius, 'capsule radius');
  validateQuery(point, outSurface, outNormal);
  const px = point[0],
    py = point[1],
    pz = point[2],
    ax = volume.start[0],
    ay = volume.start[1],
    az = volume.start[2],
    radius = volume.radius;
  const dx = volume.end[0] - ax,
    dy = volume.end[1] - ay,
    dz = volume.end[2] - az;
  const wx = px - ax,
    wy = py - ay,
    wz = pz - az;
  const axisScale = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  let ux = axisScale > 0 ? dx / axisScale : 0,
    uy = axisScale > 0 ? dy / axisScale : 0,
    uz = axisScale > 0 ? dz / axisScale : 0;
  const axisLength = Math.sqrt(ux * ux + uy * uy + uz * uz),
    length = axisScale * axisLength;
  if (axisLength > 0) {
    ux /= axisLength;
    uy /= axisLength;
    uz /= axisLength;
  }
  const queryScale = Math.max(axisScale, Math.abs(wx), Math.abs(wy), Math.abs(wz));
  const qx = queryScale > 0 ? wx / queryScale : 0,
    qy = queryScale > 0 ? wy / queryScale : 0,
    qz = queryScale > 0 ? wz / queryScale : 0;
  const relativeLength = queryScale > 0 ? (axisScale / queryScale) * axisLength : 0;
  // The clamp, the interpolation and the length rescale are written out here: V8 does not inline them into this
  // large function, and each out-of-line call returns a boxed number (the allocation test pins this).
  const parameter = relativeLength > 0 ? Math.max(0, Math.min(1, (qx * ux + qy * uy + qz * uz) / relativeLength)) : 0;
  const ex = volume.end[0],
    ey = volume.end[1],
    ez = volume.end[2];
  const cx = parameter > 0.5 ? ex + (ax - ex) * (1 - parameter) : ax + (ex - ax) * parameter,
    cy = parameter > 0.5 ? ey + (ay - ey) * (1 - parameter) : ay + (ey - ay) * parameter,
    cz = parameter > 0.5 ? ez + (az - ez) * (1 - parameter) : az + (ez - az) * parameter;
  let nx = qx - (queryScale > 0 ? dx / queryScale : 0) * parameter;
  let ny = qy - (queryScale > 0 ? dy / queryScale : 0) * parameter;
  let nz = qz - (queryScale > 0 ? dz / queryScale : 0) * parameter;
  const normalScale = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
  if (normalScale > 0) {
    nx /= normalScale;
    ny /= normalScale;
    nz /= normalScale;
  }
  const normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz),
    distance =
      normalScale < 2 ** -1022 ? normalScale * queryScale * normalLength : normalScale * normalLength * queryScale;
  // Cancellation on a diagonal centerline must not create an axial normal:
  // projecting along such a normal could remain inside the capsule.
  const axisTolerance =
    Number.EPSILON *
    8 *
    Math.max(length, Math.abs(px), Math.abs(py), Math.abs(pz), Math.abs(cx), Math.abs(cy), Math.abs(cz));
  if (normalLength > 0 && (distance > axisTolerance || length === 0)) {
    nx /= normalLength;
    ny /= normalLength;
    nz /= normalLength;
  } else if (length > 0) {
    // Cross the axis with its least-aligned basis vector for a stable normal.
    if (Math.abs(ux) <= Math.abs(uy) && Math.abs(ux) <= Math.abs(uz)) {
      nx = 0;
      ny = uz;
      nz = -uy;
    } else if (Math.abs(uy) <= Math.abs(uz)) {
      nx = -uz;
      ny = 0;
      nz = ux;
    } else {
      nx = uy;
      ny = -ux;
      nz = 0;
    }
    const normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= normalLength;
    ny /= normalLength;
    nz /= normalLength;
  } else {
    nx = 1;
    ny = 0;
    nz = 0;
  }
  capsuleSurface[0] = cx + nx * radius;
  capsuleSurface[1] = cy + ny * radius;
  capsuleSurface[2] = cz + nz * radius;
  capsuleSurface[3] = nx;
  capsuleSurface[4] = ny;
  capsuleSurface[5] = nz;
  writeCapsuleSurface(outSurface, outNormal);
  outDistance[0] = distance - radius;
}

function segmentSphereInto(
  volume: SphereVolume,
  start: Vec3View,
  end: Vec3View,
  radius: number,
  outDistance: Float64Array,
): void {
  validateVector(volume.center, 'sphere center');
  validateNonNegative(volume.radius, 'sphere radius');
  validateVector(start, 'segment start');
  validateVector(end, 'segment end');
  validateNonNegative(radius, 'segment radius');
  const dx = end[0] - start[0],
    dy = end[1] - start[1],
    dz = end[2] - start[2];
  const wx = volume.center[0] - start[0],
    wy = volume.center[1] - start[1],
    wz = volume.center[2] - start[2];
  const scale = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz), Math.abs(wx), Math.abs(wy), Math.abs(wz));
  let distance = 0;
  if (scale > 0) {
    const ux = dx / scale,
      uy = dy / scale,
      uz = dz / scale;
    const px = wx / scale,
      py = wy / scale,
      pz = wz / scale;
    const axisScale = Math.max(Math.abs(ux), Math.abs(uy), Math.abs(uz));
    let parameter = 0;
    if (axisScale > 0) {
      const sx = ux / axisScale,
        sy = uy / axisScale,
        sz = uz / axisScale;
      parameter = clamp((px * sx + py * sy + pz * sz) / axisScale / (sx * sx + sy * sy + sz * sz), 0, 1);
    }
    distance = scaledMagnitude(px - ux * parameter, py - uy * parameter, pz - uz * parameter, scale);
  }
  outDistance[0] = distance - volume.radius - radius;
}

// A subclass's own segment check would be silently ignored against a link hull.
const OVERRIDDEN = 'A volume with an overridden segmentClearance must override hullClearanceInto for link hulls';

/** A sphere in a caller-selected coordinate frame. */
export class SphereVolume implements ConstraintVolume {
  readonly center: [number, number, number] = [0, 0, 0];
  radius = 0;

  constructor(options: SphereVolumeOptions) {
    this.set(options.center, options.radius);
  }

  /** Atomically copy a moving sphere's center and radius. */
  set(center: Vec3View, radius = this.radius): this {
    validateVector(center, 'sphere center');
    validateNonNegative(radius, 'sphere radius');
    const x = center[0],
      y = center[1],
      z = center[2];
    this.center[0] = x;
    this.center[1] = y;
    this.center[2] = z;
    this.radius = radius;
    return this;
  }

  evaluate(point: Vec3View, outSurface: MutableVec3View, outNormal: MutableVec3View): number {
    evaluateSphereInto(this, point, outSurface, outNormal, publicDistance);
    return publicDistance[0];
  }

  segmentClearance(start: Vec3View, end: Vec3View, radius: number): number {
    segmentSphereInto(this, start, end, radius, publicDistance);
    return publicDistance[0];
  }

  /** Signed gap to a convex hull, written to `outDistance[0]`. A subclass that changes the geometry overrides this. */
  hullClearanceInto(hull: ConvexHullVolume, outDistance: Float64Array): void {
    if (this.segmentClearance !== sphereSegmentClearance) throw typeError(OVERRIDDEN, 'kinematics');
    validateNonNegative(this.radius, 'sphere radius');
    hull.segmentClearanceInto(this.center, this.center, this.radius, outDistance);
  }
}

/** A segment swept by a sphere; a zero-length segment is a sphere. */
export class CapsuleVolume implements ConstraintVolume {
  readonly start: [number, number, number] = [0, 0, 0];
  readonly end: [number, number, number] = [0, 0, 0];
  radius = 0;
  private readonly segmentResult = newSegmentResult();

  constructor(options: CapsuleVolumeOptions) {
    this.set(options.start, options.end, options.radius);
  }

  /** Atomically copy a moving capsule, including when its endpoint inputs alias. */
  set(start: Vec3View, end: Vec3View, radius = this.radius): this {
    validateVector(start, 'capsule start');
    validateVector(end, 'capsule end');
    validateNonNegative(radius, 'capsule radius');
    const ax = start[0],
      ay = start[1],
      az = start[2],
      bx = end[0],
      by = end[1],
      bz = end[2];
    this.start[0] = ax;
    this.start[1] = ay;
    this.start[2] = az;
    this.end[0] = bx;
    this.end[1] = by;
    this.end[2] = bz;
    this.radius = radius;
    return this;
  }

  evaluate(point: Vec3View, outSurface: MutableVec3View, outNormal: MutableVec3View): number {
    evaluateCapsuleInto(this, point, outSurface, outNormal, publicDistance);
    return publicDistance[0];
  }

  segmentClearance(start: Vec3View, end: Vec3View, radius: number): number {
    validateNonNegative(this.radius, 'capsule radius');
    validateNonNegative(radius, 'segment radius');
    return (
      closestPointsBetweenSegments(start, end, this.start, this.end, this.segmentResult).distance - this.radius - radius
    );
  }

  /** Signed gap to a convex hull, written to `outDistance[0]`. A subclass that changes the geometry overrides this. */
  hullClearanceInto(hull: ConvexHullVolume, outDistance: Float64Array): void {
    if (this.segmentClearance !== capsuleSegmentClearance) throw typeError(OVERRIDDEN, 'kinematics');
    validateNonNegative(this.radius, 'capsule radius');
    hull.segmentClearanceInto(this.start, this.end, this.radius, outDistance);
  }
}

// Capture original methods once: overrides, including later prototype changes,
// must continue through the public custom-volume contract.
// Mark these module-initialization reads as pure so importing one primitive
// alone does not retain the other primitive through the unused dispatcher.
function originalEvaluate(type: { prototype: ConstraintVolume }): ConstraintVolume['evaluate'] {
  return type.prototype.evaluate;
}
const sphereEvaluate = /* @__PURE__ */ originalEvaluate(SphereVolume);
const capsuleEvaluate = /* @__PURE__ */ originalEvaluate(CapsuleVolume);
function originalSegmentClearance(type: { prototype: ConstraintVolume }): ConstraintVolume['segmentClearance'] {
  return type.prototype.segmentClearance;
}
const sphereSegmentClearance = /* @__PURE__ */ originalSegmentClearance(SphereVolume);
const capsuleSegmentClearance = /* @__PURE__ */ originalSegmentClearance(CapsuleVolume);

/** @internal Destination passing for unchanged built-ins; custom methods retain their contract. */
export function evaluateVolumeInto(
  volume: ConstraintVolume,
  point: Vec3View,
  outSurface: MutableVec3View,
  outNormal: MutableVec3View,
  outDistance: Float64Array,
): void {
  const evaluate = volume.evaluate;
  if (volume instanceof CapsuleVolume && evaluate === capsuleEvaluate) {
    evaluateCapsuleInto(volume, point, outSurface, outNormal, outDistance);
  } else if (volume instanceof SphereVolume && evaluate === sphereEvaluate) {
    evaluateSphereInto(volume, point, outSurface, outNormal, outDistance);
  } else if (volume.evaluateInto) {
    volume.evaluateInto(point, outSurface, outNormal, outDistance);
  } else {
    const distance = evaluate.call(volume, point, outSurface, outNormal);
    // A typed-array store would coerce strings/null/boxed numbers. Preserve the
    // public contract's strict Number.isFinite check before that conversion.
    outDistance[0] = Number.isFinite(distance) ? distance : NaN;
  }
}

/** @internal Reuse both scalar and closest-point storage for built-in link checks. */
export function segmentVolumeInto(
  volume: ConstraintVolume,
  start: Vec3View,
  end: Vec3View,
  radius: number,
  outDistance: Float64Array,
  segmentResult: SegmentDistanceResult,
): void {
  const segmentClearance = volume.segmentClearance;
  if (volume instanceof CapsuleVolume && segmentClearance === capsuleSegmentClearance) {
    if (!(volume.radius >= 0 && volume.radius <= 1e100)) validateNonNegative(volume.radius, 'capsule radius');
    if (!(radius >= 0 && radius <= 1e100)) validateNonNegative(radius, 'segment radius');
    outDistance[0] =
      closestPointsBetweenSegments(start, end, volume.start, volume.end, segmentResult).distance -
      volume.radius -
      radius;
  } else if (volume instanceof SphereVolume && segmentClearance === sphereSegmentClearance) {
    segmentSphereInto(volume, start, end, radius, outDistance);
  } else if (volume.segmentClearanceInto) {
    volume.segmentClearanceInto(start, end, radius, outDistance);
  } else {
    const distance = segmentClearance.call(volume, start, end, radius);
    // Keep rejection in the caller, after both checked links have been queried.
    outDistance[0] = Number.isFinite(distance) ? distance : NaN;
  }
}

/** Signed clearance of a swept segment against any compatible proxy volume. */
export function measureSegmentClearance(
  start: Vec3View,
  end: Vec3View,
  radius: number,
  volume: ConstraintVolume,
): number {
  validateVector(start, 'segment start');
  validateVector(end, 'segment end');
  validateNonNegative(radius, 'segment radius');
  return volume.segmentClearance(start, end, radius);
}
