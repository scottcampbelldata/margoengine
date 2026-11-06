import type { EngineKernel } from '@margoengine/core';
import type { Camera, EnginePlugin, Vec3 } from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';

/** A flat display or wall in world space, from three corners: lower left, lower right and upper left. Counter clockwise seen from the viewer. */
export interface Screen {
  lowerLeft: Vec3;
  lowerRight: Vec3;
  upperLeft: Vec3;
}

/** The result of `offAxisFrustum`: the frustum bounds on the near plane and the screen's axes. */
export interface OffAxisFrustum {
  /** Frustum bounds on the near plane, along the screen's right and up axes. */
  left: number;
  right: number;
  bottom: number;
  top: number;
  /** Unit axes of the screen: right, up, and the normal pointing at the viewer. */
  xAxis: Vec3;
  yAxis: Vec3;
  normal: Vec3;
  /** Distance from the eye to the screen plane. */
  distance: number;
}

/** A plane `[nx, ny, nz, d]`: points with `n·p + d >= 0` are kept. */
export type Plane = readonly [number, number, number, number];

const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * The asymmetric frustum that makes a flat screen a window onto the scene for an eye at `eye`: the bounds on the plane
 * at distance `near` along the screen's normal. Head-tracked displays, CAVE walls and portals use it.
 */
export function offAxisFrustum(screen: Screen, eye: ArrayLike<number>, near: number): OffAxisFrustum {
  const points = [screen.lowerLeft, screen.lowerRight, screen.upperLeft, eye];
  if (!points.every((p) => p?.length >= 3 && Array.from(p).every(Number.isFinite)) || !(near > 0) || near === Infinity)
    throw new RangeError('Invalid off-axis screen; pass three finite corners, a finite eye and near above 0');
  const r = sub(screen.lowerRight, screen.lowerLeft),
    u = sub(screen.upperLeft, screen.lowerLeft),
    cornerNormal = cross(r, u);
  if (!Math.hypot(...cornerNormal))
    throw new RangeError('Invalid off-axis screen; the corners must not lie on one line');
  const xAxis = unit(r),
    yAxis = unit(u),
    normal = unit(cornerNormal),
    a = sub(screen.lowerLeft, eye),
    b = sub(screen.lowerRight, eye),
    c = sub(screen.upperLeft, eye),
    distance = -dot(a, normal);
  if (!(distance > 0))
    throw new RangeError('Invalid off-axis eye; put the eye in front of the screen, on the side its corners face');
  const k = near / distance;
  return {
    left: dot(xAxis, a) * k,
    right: dot(xAxis, b) * k,
    bottom: dot(yAxis, a) * k,
    top: dot(yAxis, c) * k,
    xAxis,
    yAxis,
    normal,
    distance,
  };
}

/**
 * Off-axis (asymmetric) projection for a flat screen: head-tracked displays, CAVE walls and portals. The camera looks
 * straight into the screen from the eye, so `camera.matrix`, culling, picking and every pass see the same view. Move
 * the eye with `setEye`. The canvas aspect is ignored: the screen's shape rules, so size the canvas to match it.
 */
export class OffAxisProjection implements EnginePlugin {
  readonly name = 'offaxis';
  private camera?: Camera;
  private eye: Vec3;
  private up?: Vec3;
  constructor(
    public screen: Screen,
    eye: Vec3 = [0, 0, 1],
  ) {
    this.eye = eye;
  }
  /** Same as `engine.use(new OffAxisProjection(screen, eye))`; returns the projection. */
  static attach(engine: EngineKernel, screen: Screen, eye?: Vec3): OffAxisProjection {
    const value = new OffAxisProjection(screen, eye);
    engine.use(value);
    return value;
  }
  setup(engine: { camera: Camera }): void {
    this.attach(engine.camera);
  }
  /** Use without an engine, e.g. on a second Camera. Throws when the camera already has a projection. */
  attach(camera: Camera): void {
    if (this.camera) throw margoError('attached', 'Projection is already attached; dispose() it or create another');
    if (camera.project) throw margoError('attached', 'Camera already has a projection; dispose that projection first');
    this.camera = camera;
    this.up = camera.up;
    camera.project = (out, _aspect, webgpu) => this.project(camera, out, webgpu);
    this.setEye(this.eye);
  }
  /** Moves the eye (world coordinates) and aims the camera straight into the screen. */
  setEye(eye: Vec3): void {
    const camera = this.camera;
    if (!camera)
      throw margoError('state', 'Projection is not attached; call attach(camera) or engine.use(projection) first');
    const f = offAxisFrustum(this.screen, eye, camera.near);
    this.eye = [eye[0], eye[1], eye[2]];
    camera.position = this.eye;
    camera.target = [eye[0] - f.normal[0], eye[1] - f.normal[1], eye[2] - f.normal[2]];
    camera.up = f.yAxis;
  }
  dispose(): void {
    const camera = this.camera;
    if (!camera) return;
    this.camera = undefined;
    camera.project = undefined;
    if (this.up) camera.up = this.up;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private project(camera: Camera, P: Float64Array, webgpu: boolean): void {
    // The camera is aimed along the screen normal from the eye, so view space has the screen's axes.
    const n = camera.near,
      f = camera.far,
      s = offAxisFrustum(this.screen, camera.position, n),
      w = s.right - s.left,
      h = s.top - s.bottom,
      d = n - f;
    P[0] = (2 * n) / w;
    P[5] = (2 * n) / h;
    P[8] = (s.right + s.left) / w;
    P[9] = (s.top + s.bottom) / h;
    P[10] = webgpu ? -n / d : (f + n) / d;
    P[11] = -1;
    P[14] = webgpu ? (-f * n) / d : (2 * f * n) / d;
  }
}

/** Solves M x = b for a row-major 4x4 `m` by Gauss-Jordan elimination with partial pivoting; null when singular. */
function solve(m: number[][], b: number[]): number[] | null {
  const a = m.map((row, r) => [...row, b[r]]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (!(Math.abs(a[p][c]) > 1e-300)) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const k = a[r][c] / a[c][c];
      for (let x = c; x < 5; x++) a[r][x] -= k * a[c][x];
    }
  }
  return a.map((row, r) => row[4] / row[r]);
}

/**
 * Replaces the near plane of the projection `P` (column-major, edited in place) with `plane` given in eye space, so
 * everything on the plane's negative side is clipped, with no extra clip plane in the shader. Works for perspective and
 * orthographic matrices in both depth conventions (`webgpu`: reversed, near 1 and far 0; else -1 to 1). The far plane
 * stays at the corner opposite the plane. The eye must be on the clipped side.
 */
export function obliqueProjection(P: Float64Array, plane: Plane, webgpu: boolean): void {
  if (plane.length !== 4 || !plane.every(Number.isFinite) || !Math.hypot(plane[0], plane[1], plane[2]))
    throw new RangeError('Invalid oblique plane; pass finite [nx, ny, nz, d] with a normal that is not zero');
  if (!(plane[3] < 0))
    throw new RangeError('Invalid oblique plane; the camera must be on the clipped side, behind the plane');
  // P is column-major; rows[r][c] is its entry at row r, column c.
  const rows = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => P[c * 4 + r])),
    columns = [0, 1, 2, 3].map((c) => rows.map((row) => row[c])),
    dn = webgpu ? 1 : -1,
    df = webgpu ? 0 : 1,
    // The plane in clip space is P^-T times the plane, the solution of P^T x = plane.
    clip = solve(columns, [...plane]);
  if (!clip) throw new RangeError('Invalid oblique plane; the projection matrix cannot be inverted');
  // The far plane corner opposite the plane, back in eye space: the solution of P Q = q.
  const Q = solve(rows, [Math.sign(clip[0]) || 1, Math.sign(clip[1]) || 1, df, 1]);
  if (!Q) throw new RangeError('Invalid oblique plane; the projection matrix cannot be inverted');
  const cq = plane[0] * Q[0] + plane[1] * Q[1] + plane[2] * Q[2] + plane[3] * Q[3];
  if (!cq) throw new RangeError('Invalid oblique plane; it passes through the far corner, move or tilt it');
  const wq = P[3] * Q[0] + P[7] * Q[1] + P[11] * Q[2] + P[15] * Q[3],
    k = ((df - dn) * wq) / cq;
  for (let c = 0; c < 4; c++) P[c * 4 + 2] = dn * P[c * 4 + 3] + k * plane[c];
}

/**
 * Oblique near plane for any camera: set `plane` (world space, `[nx, ny, nz, d]`, points with `n·p + d >= 0` are kept)
 * and everything behind it is clipped, as portals and mirrors need. It wraps the camera's projection (core's, or
 * `CameraProjection`'s or `OffAxisProjection`'s), so attach it last and `dispose()` it first. With no `plane` it
 * changes nothing. The camera has to stay on the clipped side of the plane.
 */
export class ObliqueNearPlane {
  /** World space plane, or undefined for none. */
  plane?: Plane;
  private camera?: Camera;
  private inner?: Camera['project'];
  private hook?: Camera['project'];
  constructor(plane?: Plane) {
    this.plane = plane;
  }
  /** Wraps `camera.project`; returns this. */
  attach(camera: Camera): this {
    if (this.camera) throw margoError('attached', 'Oblique plane is already attached; dispose() it or create another');
    this.camera = camera;
    this.inner = camera.project;
    this.hook = (P, aspect, webgpu) => {
      if (this.inner) this.inner(P, aspect, webgpu);
      else {
        const n = camera.near,
          f = camera.far,
          d = n - f,
          k = 1 / Math.tan((camera.fov * Math.PI) / 360);
        P[0] = k / aspect;
        P[5] = k;
        P[10] = webgpu ? -n / d : (f + n) / d;
        P[11] = -1;
        P[14] = webgpu ? (-f * n) / d : (2 * f * n) / d;
      }
      if (this.plane) obliqueProjection(P, this.eyePlane(camera, this.plane), webgpu);
    };
    camera.project = this.hook;
    return this;
  }
  /** Restores the projection this wrapped. */
  dispose(): void {
    const camera = this.camera;
    if (!camera) return;
    if (camera.project === this.hook) camera.project = this.inner;
    this.camera = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** The world plane in the camera's eye space, from its position, target and up (the basis core builds the view from). */
  private eyePlane(camera: Camera, plane: Plane): Plane {
    const p = camera.position,
      z = unit(sub(p, camera.target)),
      x = unit(cross(camera.up, z)),
      y = cross(z, x),
      n: Vec3 = [plane[0], plane[1], plane[2]];
    return [dot(x, n), dot(y, n), dot(z, n), dot(n, p) + plane[3]];
  }
}
