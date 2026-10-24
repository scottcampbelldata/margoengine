/// <reference lib="esnext.disposable" preserve="true" />
import type { Camera, Engine } from '@margoengine/core';
import { MargoError, Vector3 } from '@margoengine/math';
import { invertMatrix } from '@margoengine/math/mat4';
import { add, cross, dot, normalize, scale, sub } from '@margoengine/math/vec3';
import type { MutableVec3 } from '@margoengine/math';
import { Raycaster, cameraRay } from './raycaster.js';
import { isOrthographic } from '@margoengine/math/mat4';
import {
  createScreenRectangle,
  finiteCanvasPoint,
  type RaycastScreenRectangle,
  type RaycastSegmentPoint,
} from './screen-query.js';

/** CSS canvas point and camera-forward depth. No far-plane rejection is applied. */
export interface RaycastProjectedPoint {
  /** CSS pixels from the canvas's left edge. */
  x: number;
  /** CSS pixels from the canvas's top edge. */
  y: number;
  /** World distance along the camera's forward axis. */
  depth: number;
}

/** Optional explicit orthographic world height for exact one-CSS-pixel boundary tolerances. */
export interface RaycastProjectionOptions {
  /** Visible world height of an orthographic view (as `CameraProjection.height / zoom`), for pixelWorldSize. */
  orthographicHeight?: number;
}

/** Owned near-clipped world endpoints and their corresponding captured CSS projections. */
export interface RaycastProjectedSegment {
  /** First world endpoint, moved onto the near plane when it was behind it. */
  a: MutableVec3;
  /** Second world endpoint, moved onto the near plane when it was behind it. */
  b: MutableVec3;
  /** Projection of `a`. */
  start: RaycastProjectedPoint;
  /** Projection of `b`. */
  end: RaycastProjectedPoint;
}

/** Optional nonnegative world-depth offset added to the captured near plane before clipping a segment. */
export interface RaycastProjectSegmentOptions {
  /** World depth added to the near plane before clipping, default 0. */
  nearPadding?: number;
}

interface ProjectionRuntime {
  camera: Camera;
  canvas: HTMLCanvasElement;
  backend: string;
  disposed?: boolean;
}
interface CameraState {
  matrix: Float64Array;
  inverse: Float64Array;
  position: Float64Array;
  target: Float64Array;
  up: Float64Array;
  near: number;
  fov: number;
  orthographic: boolean;
  webgpu: boolean;
  width: number;
  height: number;
}

/**
 * Owned camera/canvas frame for CSS projection, camera depth, basis and ray mapping. Captures once without
 * reading scene geometry; later camera, canvas or projection changes require a new capture. Point arrays are read
 * on every call and every result owns its numbers. Orthographic pixel scale requires an explicit world height.
 * @throws TypeError for malformed engine/options/point shapes; RangeError for invalid camera, coordinates or
 * pixel-scale inputs; MargoError disposed after frame/engine disposal. Repair data or capture a live frame.
 */
export class RaycastProjection {
  private runtime: ProjectionRuntime | null;
  private data: CameraState | null;
  private height: number | undefined;
  private axes: { forward: MutableVec3; right: MutableVec3; up: MutableVec3 } | null = null;
  // Reused for every projection: Vector3.applyMatrix4 is math's perspective-divide transform.
  private readonly scratch = new Vector3();
  private readonly clip: { elements: Float64Array };

  private constructor(runtime: ProjectionRuntime, data: CameraState, height: number | undefined) {
    this.runtime = runtime;
    this.data = data;
    this.height = height;
    this.clip = { elements: data.matrix };
  }

  /** Capture current camera mapping and optional orthographic height without capturing any model geometry. */
  static capture(engine: Engine, options: RaycastProjectionOptions = {}): RaycastProjection {
    const runtime = engine as unknown as ProjectionRuntime;
    if (!runtime?.camera || !runtime.canvas)
      throw new TypeError('Projection frame needs a Margo Engine camera and canvas; pass a live Engine.');
    if (runtime.disposed) throw new MargoError('disposed', 'Projection engine is disposed; capture a live Engine.');
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new TypeError('Projection options need an object; supply orthographicHeight or omit options.');
    const height = options.orthographicHeight;
    if (height !== undefined && (!Number.isFinite(height) || height <= 0))
      throw new RangeError(
        'Projection orthographicHeight must be positive and finite; supply the rendered world height.',
      );
    const data = captureCamera(runtime);
    if (runtime.disposed)
      throw new MargoError('disposed', 'Projection engine was disposed during capture; use a live Engine.');
    return new RaycastProjection(runtime, data, height);
  }

  /** Whether this frame or its owning engine has been disposed. */
  get disposed(): boolean {
    return this.runtime === null || !!this.runtime.disposed;
  }
  /** Captured projection kind, independent of later camera changes. */
  get orthographic(): boolean {
    return this.open().orthographic;
  }

  private open(): CameraState {
    if (!this.runtime || !this.data)
      throw new MargoError('disposed', 'Projection frame is disposed; capture a new RaycastProjection.');
    if (this.runtime.disposed)
      throw new MargoError('disposed', 'Projection engine is disposed; capture a live Engine.');
    return this.data;
  }

  private basisValues(): { forward: MutableVec3; right: MutableVec3; up: MutableVec3 } {
    const c = this.open();
    if (!this.axes) {
      if (![...c.target, ...c.up].every(Number.isFinite))
        throw new RangeError(
          'Projection camera needs finite target/up vectors; repair camera orientation and recapture.',
        );
      const forward = normalize(sub(c.target, c.position)),
        right = normalize(cross(forward, c.up));
      this.axes = { forward, right, up: normalize(cross(right, forward)) };
    }
    return this.axes;
  }

  /** Owned captured forward/right/up basis, using the same operand order as Margo vector helpers. */
  basis(): { forward: MutableVec3; right: MutableVec3; up: MutableVec3 } {
    const b = this.basisValues();
    return { forward: [...b.forward], right: [...b.right], up: [...b.up] };
  }

  /** Owned captured CSS canvas dimensions, with backing dimensions as the no-CSS fallback. */
  size(): { width: number; height: number } {
    const c = this.open();
    return { width: c.width, height: c.height };
  }

  /** Camera-forward depth without near/far clipping. */
  depth(point: ArrayLike<number>): number {
    this.open();
    return this.depthValues(readPoint(point));
  }

  private depthValues(p: MutableVec3): number {
    const depth = dot(sub(p, this.open().position), this.basisValues().forward);
    if (!Number.isFinite(depth))
      throw new RangeError('Projection depth overflowed; reduce coordinates or repair the camera.');
    return depth;
  }

  /** Project a finite XYZ point to CSS coordinates, returning null only behind the captured near plane. */
  project(point: ArrayLike<number>): RaycastProjectedPoint | null {
    this.open();
    const p = readPoint(point);
    return this.projectValues(p);
  }

  private projectValues(p: MutableVec3): RaycastProjectedPoint | null {
    const c = this.open();
    if (!Number.isFinite(c.near) || c.near < 0)
      throw new RangeError('Projection near plane must be finite and nonnegative; repair the camera and recapture.');
    const depth = this.depthValues(p);
    if (depth < c.near) return null;
    const projected = this.scratch.set(p[0], p[1], p[2]).applyMatrix4(this.clip),
      x = ((projected.x + 1) * c.width) / 2,
      y = ((1 - projected.y) * c.height) / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new RangeError(
        'Projection reached a nonfinite screen point; move away from the eye plane or repair the camera.',
      );
    return { x, y, depth };
  }

  /**
   * Owned world point, CSS projection and CSS-pixel distance to a finite canvas coordinate. Returns null behind near.
   * @throws TypeError for malformed XYZ; RangeError for nonfinite/overflowing coordinates; MargoError disposed
   * after frame/engine disposal, including through an input getter. Repair inputs or capture a live frame.
   */
  pointDistance(point: ArrayLike<number>, x: number, y: number): RaycastSegmentPoint | null {
    this.open();
    finiteCanvasPoint(x, y);
    const p = readPoint(point);
    this.open();
    const screen = this.projectValues(p);
    if (!screen) return null;
    const distance = Math.hypot(screen.x - x, screen.y - y);
    if (!Number.isFinite(distance))
      throw new RangeError('Projection point distance overflowed; reduce world or canvas coordinates.');
    return { point: [...p], screen, distance };
  }

  /**
   * Closest CSS point on a projected segment, with harmonic perspective world reconstruction. Both endpoints must
   * project at/after near; a segment crossing near is rejected, not clipped. Zero CSS length retains endpoint a,
   * including its depth, so endpoint order remains observable. Results own all point/projection numbers.
   * @throws TypeError for malformed XYZ; RangeError for nonfinite/overflowing or invalid reconstructed data;
   * MargoError disposed after frame/engine disposal. Repair inputs or capture a live frame.
   */
  closestSegmentPoint(a: ArrayLike<number>, b: ArrayLike<number>, x: number, y: number): RaycastSegmentPoint | null {
    this.open();
    finiteCanvasPoint(x, y);
    const first = readPoint(a),
      second = readPoint(b);
    const c = this.open(),
      start = this.projectValues(first),
      end = this.projectValues(second);
    if (!start || !end) return null;
    const dx = end.x - start.x,
      dy = end.y - start.y,
      length = dx * dx + dy * dy;
    if (![dx, dy, length].every(Number.isFinite))
      throw new RangeError('Projection segment span overflowed; reduce world or canvas coordinates.');
    const amount = length ? Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / length)) : 0;
    const worldAmount = !c.orthographic
      ? amount / end.depth / ((1 - amount) / start.depth + amount / end.depth)
      : amount;
    if (!Number.isFinite(worldAmount))
      throw new RangeError('Projection segment parameter is nonfinite; repair depth or reduce canvas coordinates.');
    const point = add(first, scale(sub(second, first), worldAmount)),
      projected = this.project(point);
    if (!projected)
      throw new RangeError('Projection segment reconstruction fell behind near; move the endpoints beyond near.');
    const screen = { x: start.x + dx * amount, y: start.y + dy * amount, depth: projected.depth },
      distance = Math.hypot(start.x + dx * amount - x, start.y + dy * amount - y);
    if (![screen.x, screen.y, distance].every(Number.isFinite))
      throw new RangeError('Projection segment result overflowed; reduce world or canvas coordinates.');
    return { point, screen, distance };
  }

  /**
   * Clip owned endpoints to captured near plus nearPadding, then project them. The clipping operand order matches
   * Margo Mesh overlay lines; unlike closestSegmentPoint, a crossing segment may remain visible. No far clipping.
   * @throws TypeError for malformed XYZ/options; RangeError for nonfinite/negative padding or overflowing data;
   * MargoError disposed after frame/engine disposal. Repair inputs or capture a live frame.
   */
  projectSegment(
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    options: RaycastProjectSegmentOptions = {},
  ): RaycastProjectedSegment | null {
    this.open();
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new TypeError('Projection segment options need an object; supply nearPadding or omit options.');
    const suppliedPadding = options.nearPadding,
      padding = suppliedPadding === undefined ? 0 : suppliedPadding;
    if (!Number.isFinite(padding) || padding < 0)
      throw new RangeError('Projection nearPadding must be finite and nonnegative; supply a valid world-depth offset.');
    let first = readPoint(a),
      second = readPoint(b);
    const c = this.open(),
      near = c.near + padding;
    if (!Number.isFinite(c.near) || c.near < 0 || !Number.isFinite(near))
      throw new RangeError('Projection near depth is invalid or overflowed; repair near or reduce nearPadding.');
    const depthA = this.depthValues(first),
      depthB = this.depthValues(second);
    if (depthA < near && depthB < near) return null;
    if (depthA < near) first = add(first, scale(sub(second, first), (near - depthA) / (depthB - depthA)));
    if (depthB < near)
      second = add(second, scale(sub(first, second), (near - depthB) / (Math.max(near, depthA) - depthB)));
    const start = this.projectValues(first),
      end = this.projectValues(second);
    if (!start || !end) return null;
    // readPoint and add return fresh arrays, so the endpoints never alias the caller's input.
    return { a: first, b: second, start, end };
  }

  /**
   * Immutable inclusive CSS rectangle borrowed from this captured camera frame. No scene or visibility is queried.
   * The rectangle and all of its sample iterators reject after frame/engine disposal; keep this frame alive.
   * @throws RangeError for nonfinite CSS coordinates; MargoError disposed after frame/engine disposal.
   */
  rectangle(x1: number, y1: number, x2: number, y2: number): RaycastScreenRectangle {
    this.open();
    return createScreenRectangle(this, x1, y1, x2, y2, () => {
      this.open();
    });
  }

  /** World distance for one CSS pixel at a camera-forward depth; an explicit orthographic height may override capture. */
  pixelWorldSize(depth: number, orthographicHeight = this.height): number {
    const c = this.open();
    if (!Number.isFinite(depth) || depth < 0)
      throw new RangeError('Projection pixel depth must be finite and nonnegative; supply camera-forward depth.');
    if (orthographicHeight !== undefined && (!Number.isFinite(orthographicHeight) || orthographicHeight <= 0))
      throw new RangeError(
        'Projection orthographicHeight must be positive and finite; supply the rendered world height.',
      );
    if (c.orthographic && orthographicHeight === undefined)
      throw new TypeError('Orthographic pixel scale needs orthographicHeight; supply the rendered world height.');
    if (!c.orthographic && (!Number.isFinite(c.fov) || c.fov <= 0 || c.fov >= 180))
      throw new RangeError(
        'Perspective pixel scale needs a finite fov between 0 and 180 degrees; repair the camera and recapture.',
      );
    const value =
      (c.orthographic ? orthographicHeight! : 2 * depth * Math.tan((c.fov * Math.PI) / 360)) / Math.max(1, c.height);
    if (!Number.isFinite(value))
      throw new RangeError('Projection pixel scale overflowed; reduce depth or repair the camera.');
    return value;
  }

  /** Set a Raycaster from captured CSS coordinates, retaining Margo unprojection/normalization and outside-canvas rays. */
  setFromCanvas(raycaster: Raycaster, x: number, y: number): Raycaster {
    const c = this.open();
    if (!(raycaster instanceof Raycaster))
      throw new TypeError('Projection ray mapping needs a Raycaster; create one first.');
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new RangeError('Projection canvas coordinates must be finite; supply CSS pixels.');
    return cameraRay(
      raycaster,
      c.inverse,
      c.orthographic,
      c.position,
      (x / c.width) * 2 - 1,
      1 - (y / c.height) * 2,
      c.webgpu,
    );
  }

  /** Release captured camera data; idempotent. */
  dispose(): void {
    this.runtime = null;
    this.data = null;
    this.axes = null;
  }
  /** Release this frame at the end of an explicit-resource-management scope. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** @internal Finite point capture, also used before atomic visibility batches. */
export function readPoint(point: ArrayLike<number>): MutableVec3 {
  if (!point || (typeof point !== 'object' && typeof point !== 'function') || point.length !== 3)
    throw new TypeError('Projection points need an XYZ array-like object; supply three finite coordinates.');
  const p: MutableVec3 = [point[0], point[1], point[2]];
  if (!p.every(Number.isFinite)) throw new RangeError('Projection coordinates must be finite; repair the world point.');
  return p;
}

function optionalVector(value: ArrayLike<number> | undefined): Float64Array {
  return value?.length === 3 ? Float64Array.from(value) : new Float64Array([NaN, NaN, NaN]);
}
function captureCamera(runtime: ProjectionRuntime): CameraState {
  const canvas = runtime.canvas,
    width = canvas.clientWidth || canvas.width,
    height = canvas.clientHeight || canvas.height;
  if (
    !(width > 0) ||
    !(height > 0) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !(canvas.width > 0) ||
    !(canvas.height > 0)
  )
    throw new RangeError(
      'Projection canvas dimensions must be positive and finite; size the Engine canvas before capture.',
    );
  const webgpu = runtime.backend === 'webgpu';
  runtime.camera.update(canvas.width / canvas.height, webgpu);
  const matrix = Float64Array.from(runtime.camera.matrix),
    position = Float64Array.from(runtime.camera.position),
    inverse = invertMatrix(matrix, new Float64Array(16));
  if (
    !inverse ||
    inverse.some((v) => !Number.isFinite(v)) ||
    position.length !== 3 ||
    position.some((v) => !Number.isFinite(v))
  )
    throw new RangeError(
      'Projection camera needs a finite invertible matrix and eye position; repair camera clip settings.',
    );
  return {
    matrix,
    inverse,
    position,
    target: optionalVector(runtime.camera.target),
    up: optionalVector(runtime.camera.up),
    near: runtime.camera.near,
    fov: runtime.camera.fov,
    orthographic: isOrthographic(matrix),
    webgpu,
    width,
    height,
  };
}
