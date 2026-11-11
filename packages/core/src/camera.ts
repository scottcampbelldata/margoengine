import { finite } from './geometry.js';
import { hypot } from '../../shared/hypot.js';
import { rangeError } from '../../shared/errors.js';
// Holds a plane's squared length on its way to Math.sqrt. V8 13 (Node 24) Maglev calls Math.sqrt with a boxed
// number; fed straight from the summing loop, the loop's sum was boxed on every step (288 B per frame), not once.
const squared = new Float64Array(1);
// The next matrix and planes, checked before either is published, so a rejected update keeps the last good ones.
const next = new Float32Array(16),
  nextPlanes = new Float32Array(24);
/** Three components `[x, y, z]`, usually a point or direction in world units. */
export type Vec3 = readonly [number, number, number];
/** Initial {@link Camera} settings. */
export interface CameraOptions {
  /** Vertical field of view in degrees, in (0, 180). Default 60. */
  fov?: number;
  /** Eye position in world units. Default [0, 2, 5]. */
  position?: Vec3;
  /** Look-at point in world units; must differ from `position`. Default [0, 0, 0]. */
  target?: Vec3;
  /** Near clip distance in world units, > 0. Default 0.1. */
  near?: number;
  /** Far clip distance in world units, > `near`. Default 1000. */
  far?: number;
}

/**
 * Perspective look-at camera. Values are checked when the engine updates it each frame: invalid projection settings,
 * a position equal to the target, or a view parallel to `up` throw RangeError.
 */
export class Camera {
  fov: number;
  near: number;
  far: number;
  position: Vec3;
  target: Vec3;
  /** Screen-up direction; any value not parallel to the view direction (straight-down views need e.g. [0,0,-1]). */
  up: Vec3 = [0, 1, 0];
  /** Replaces the perspective projection: fill `out` (column-major) for this aspect and depth convention. */
  project?: (out: Float64Array, aspect: number, webgpu: boolean) => void;
  readonly matrix = new Float32Array(16);
  readonly planes = new Float32Array(24);
  private fit?: { position: Vec3; target: Vec3; elapsed: number; duration: number; from: Vec3; fromTarget: Vec3 };
  private readonly view = new Float64Array(16);
  private readonly projection = new Float64Array(16);
  constructor({ fov = 60, position = [0, 2, 5], target = [0, 0, 0], near = 0.1, far = 1000 }: CameraOptions = {}) {
    this.fov = fov;
    this.position = position;
    this.target = target;
    this.near = near;
    this.far = far;
  }
  update(aspect: number, webgpu: boolean): void {
    finite(this.position, 3, 'Camera position');
    finite(this.target, 3, 'Camera target');
    if (
      // One by one: an array of them would be built every frame.
      !Number.isFinite(aspect) ||
      !Number.isFinite(this.fov) ||
      !Number.isFinite(this.near) ||
      !Number.isFinite(this.far) ||
      aspect <= 0 ||
      this.fov <= 0 ||
      this.fov >= 180 ||
      this.near <= 0 ||
      this.far <= this.near
    )
      throw rangeError('Invalid projection', 'camera');
    let zx = this.position[0] - this.target[0],
      zy = this.position[1] - this.target[1],
      zz = this.position[2] - this.target[2];
    const length = hypot(3, zx, zy, zz);
    if (!length) throw rangeError('Camera at target', 'camera');
    zx /= length;
    zy /= length;
    zz /= length;
    const u = this.up;
    let xx = u[1] * zz - u[2] * zy,
      xy = u[2] * zx - u[0] * zz,
      xz = u[0] * zy - u[1] * zx;
    const side = hypot(3, xx, xy, xz);
    if (!side) throw rangeError('Vertical camera', 'camera');
    xx /= side;
    xy /= side;
    xz /= side;
    const yx = zy * xz - zz * xy,
      yy = zz * xx - zx * xz,
      yz = zx * xy - zy * xx,
      p = this.position;
    const v = this.view;
    v[0] = xx;
    v[1] = yx;
    v[2] = zx;
    v[4] = xy;
    v[5] = yy;
    v[6] = zy;
    v[8] = xz;
    v[9] = yz;
    v[10] = zz;
    v[12] = -xx * p[0] - xy * p[1] - xz * p[2];
    v[13] = -yx * p[0] - yy * p[1] - yz * p[2];
    v[14] = -zx * p[0] - zy * p[1] - zz * p[2];
    v[15] = 1;
    const f = 1 / Math.tan((this.fov * Math.PI) / 360),
      d = this.near - this.far,
      projection = this.projection;
    projection.fill(0);
    if (this.project) this.project(projection, aspect, webgpu);
    else {
      projection[0] = f / aspect;
      projection[5] = f;
      projection[10] = webgpu ? -this.near / d : (this.far + this.near) / d;
      projection[11] = -1;
      projection[14] = webgpu ? (-this.far * this.near) / d : (2 * this.far * this.near) / d;
    }
    const m = next;
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++)
        m[c * 4 + r] =
          projection[r] * v[c * 4] +
          projection[4 + r] * v[c * 4 + 1] +
          projection[8 + r] * v[c * 4 + 2] +
          projection[12 + r] * v[c * 4 + 3];
    finite(m, 16, 'Camera matrix');
    for (let plane = 0; plane < 6; plane++) {
      const row = plane >> 1,
        sign = plane % 2 === 0 ? 1 : -1;
      let length2 = 0;
      for (let c = 0; c < 4; c++) {
        const value = plane === 4 && webgpu ? m[c * 4 + 2] : m[c * 4 + 3] + sign * m[c * 4 + row];
        nextPlanes[plane * 4 + c] = value;
        if (c < 3) length2 += value * value;
      }
      squared[0] = length2;
      const norm = Math.sqrt(squared[0]);
      if (!norm) throw rangeError('Invalid frustum', 'camera');
      for (let c = 0; c < 4; c++) nextPlanes[plane * 4 + c] /= norm;
    }
    this.matrix.set(m);
    this.planes.set(nextPlanes);
  }
  fitToBoundingBox(
    min: Vec3,
    max: Vec3,
    { aspect = 1, duration = 0.3, padding = 1.1 }: { aspect?: number; duration?: number; padding?: number } = {},
  ): void {
    finite(min, 3, 'Bounds');
    finite(max, 3, 'Bounds');
    if (
      min.some((v, i) => v > max[i]) ||
      ![aspect, duration, padding, this.fov, this.near, this.far].every(Number.isFinite) ||
      aspect <= 0 ||
      duration < 0 ||
      padding < 1 ||
      this.fov <= 0 ||
      this.fov >= 180 ||
      this.near <= 0 ||
      this.far <= this.near
    )
      throw rangeError('Invalid fit', 'camera');
    const target: Vec3 = min.map((v, i) => (v + max[i]) / 2) as unknown as Vec3,
      radius = Math.hypot(...max.map((v, i) => (v - min[i]) / 2)),
      angle = Math.atan(Math.tan((this.fov * Math.PI) / 360) * Math.min(1, aspect)),
      // The padded bounding sphere touches the narrower half-angle; a tiny part or a wide fov would put that sphere
      // behind the near plane, so the eye backs off until the padded sphere starts past `near`.
      distance = Math.max(radius / Math.sin(angle), radius + this.near) * padding,
      direction = this.position.map((v, i) => v - this.target[i]),
      length = Math.hypot(...direction);
    if (!length || distance + radius >= this.far) throw rangeError('Bounds exceed far: raise camera.far', 'camera');
    const position = target.map((v, i) => v + (direction[i] / length) * distance) as unknown as Vec3;
    this.fit = { position, target, elapsed: 0, duration, from: this.position, fromTarget: this.target };
    this.advance(0);
  }
  advance(delta: number): void {
    if (!this.fit) return;
    const f = this.fit,
      t = f.duration ? Math.min(1, (f.elapsed += delta) / f.duration) : 1,
      s = t * t * (3 - 2 * t);
    this.position = f.from.map((v, i) => v + (f.position[i] - v) * s) as unknown as Vec3;
    this.target = f.fromTarget.map((v, i) => v + (f.target[i] - v) * s) as unknown as Vec3;
    if (t === 1) this.fit = undefined;
  }
  cancelFit(): void {
    this.fit = undefined;
  }
}
