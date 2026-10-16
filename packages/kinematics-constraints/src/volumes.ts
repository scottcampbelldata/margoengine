import type { ConstraintVolume, MutableVec3View, Vec3View } from './types.js';
import {
  length3,
  validateDistinctOutputs,
  validateNonNegative,
  validateOutputValues,
  validateOutputVector,
  validateVector,
} from './types.js';

export interface SegmentDistanceResult {
  pointA: MutableVec3View;
  pointB: MutableVec3View;
  distance: number;
  parameterA: number;
  parameterB: number;
}

export interface SphereVolumeOptions {
  center: Vec3View;
  radius: number;
}
export interface CapsuleVolumeOptions {
  start: Vec3View;
  end: Vec3View;
  radius: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function interpolate(a: number, b: number, parameter: number): number {
  return parameter > 0.5 ? b + (a - b) * (1 - parameter) : a + (b - a) * parameter;
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
  const lengthA = length3(ux, uy, uz),
    lengthB = length3(vx, vy, vz);
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
    if (lengthB > 0) alongB = clamp(projectionB, 0, lengthB);
  } else if (lengthB === 0) {
    alongA = clamp(-projectionA, 0, lengthA);
  } else {
    const cosine = clamp(ux * vx + uy * vy + uz * vz, -1, 1);
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
        alongA = numerator === 0 ? 0 : clamp(-(numerator / sine) * (separationScale / crossScale), 0, lengthA);
      }
    }
    alongB = cosine * alongA + projectionB;
    if (alongB < 0) {
      alongB = 0;
      alongA = clamp(-projectionA, 0, lengthA);
    } else if (alongB > lengthB) {
      alongB = lengthB;
      alongA = clamp(cosine * lengthB - projectionA, 0, lengthA);
    }
  }
  const parameterA = lengthA > 0 ? alongA / lengthA : 0;
  const parameterB = lengthB > 0 ? alongB / lengthB : 0;
  const pax = interpolate(ax, bx, parameterA),
    pay = interpolate(ay, by, parameterA),
    paz = interpolate(az, bz, parameterA);
  const pbx = interpolate(cx, dx, parameterB),
    pby = interpolate(cy, dy, parameterB),
    pbz = interpolate(cz, dz, parameterB);
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
    throw new RangeError('Result exceeds output precision');
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
  validateNonNegative(volume.radius, 'capsule radius');
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
  const parameter = relativeLength > 0 ? clamp((qx * ux + qy * uy + qz * uz) / relativeLength, 0, 1) : 0;
  const cx = interpolate(ax, volume.end[0], parameter),
    cy = interpolate(ay, volume.end[1], parameter),
    cz = interpolate(az, volume.end[2], parameter);
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
    distance = rescaleLength(normalScale, normalLength, queryScale);
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
  writeSurface(outSurface, outNormal, cx, cy, cz, nx, ny, nz, radius);
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
    validateNonNegative(volume.radius, 'capsule radius');
    validateNonNegative(radius, 'segment radius');
    outDistance[0] =
      closestPointsBetweenSegments(start, end, volume.start, volume.end, segmentResult).distance -
      volume.radius -
      radius;
  } else if (volume instanceof SphereVolume && segmentClearance === sphereSegmentClearance) {
    segmentSphereInto(volume, start, end, radius, outDistance);
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
