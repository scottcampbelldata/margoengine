/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Camera, Engine, EnginePlugin, Vec3 } from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';

/** Options of `CameraProjection`: orthographic or perspective framing, frustum bounds, zoom and clip range. */
export interface ProjectionOptions {
  /** 'orthographic' (default) or 'perspective'; both accept exactly vertical views. */
  mode?: 'orthographic' | 'perspective';
  /** Visible world height at zoom 1. Default: the perspective height at the target, 2·distance·tan(fov/2), so dolly controls zoom. */
  height?: number;
  /** Orthographic frustum bounds in view units. When all four are set they replace height and the canvas aspect. */
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  /** Zoom factor: divides the frustum about its centre. */
  zoom?: number;
  /** Eye-space clip distances, may be negative. Default: camera.far deep, centred on the target. */
  near?: number;
  far?: number;
  /** Screen up for exactly vertical views; needs a horizontal component. Default [0,0,-1]: north up looking down. */
  up?: Vec3;
  /** Render only a sub-rectangle of a larger frustum; see `ViewOffset`. Default: none, the whole frustum. */
  viewOffset?: ViewOffset;
  /** Lens focal length in millimetres. Replaces `camera.fov` with the field of view of this lens on `filmGauge`. Default: none, `camera.fov` rules. */
  focalLength?: number;
  /** Sensor size in millimetres along the fitted axis (see `sensorFit`). Default 36, a full-frame sensor's width. */
  filmGauge?: number;
  /** Which image axis `filmGauge` spans: 'horizontal', 'vertical', or 'auto' (the longer side, Blender's default). */
  sensorFit?: SensorFit;
}

/** The image axis a sensor size spans. */
export type SensorFit = 'horizontal' | 'vertical' | 'auto';

/** Options of `lensToFov` and `fovToLens`. */
export interface LensOptions {
  /** Sensor size in millimetres along the fitted axis. Default 36. */
  filmGauge?: number;
  /** Default 'auto': `filmGauge` spans the longer image side. */
  sensorFit?: SensorFit;
}

const lensCheck = (value: number, aspect: number, filmGauge: number, sensorFit: SensorFit): void => {
  if (
    ![value, aspect, filmGauge].every(Number.isFinite) ||
    value <= 0 ||
    aspect <= 0 ||
    filmGauge <= 0 ||
    !['horizontal', 'vertical', 'auto'].includes(sensorFit)
  )
    throw new RangeError(
      "Invalid projection lens; pass finite focal length or fov, aspect and film gauge above 0 and sensorFit 'horizontal', 'vertical' or 'auto'",
    );
};
const spansHorizontal = (aspect: number, fit: SensorFit): boolean =>
  fit === 'horizontal' || (fit === 'auto' && aspect >= 1);

/**
 * Vertical field of view in degrees of a lens of `focalLength` mm for an image of `aspect` (width / height) on a sensor
 * `filmGauge` mm along `sensorFit`: 2·atan(sensor / 2f) on that axis, converted to the vertical axis.
 * A 50 mm lens on a 36 mm wide sensor is 39.6° horizontally and 26.99° vertically at 3:2.
 */
export function lensToFov(
  focalLength: number,
  aspect: number,
  { filmGauge = 36, sensorFit = 'auto' }: LensOptions = {},
): number {
  lensCheck(focalLength, aspect, filmGauge, sensorFit);
  const half = filmGauge / (2 * focalLength);
  return (360 / Math.PI) * Math.atan(spansHorizontal(aspect, sensorFit) ? half / aspect : half);
}

/** The focal length in millimetres that gives vertical field of view `fov` degrees; the inverse of `lensToFov`. */
export function fovToLens(
  fov: number,
  aspect: number,
  { filmGauge = 36, sensorFit = 'auto' }: LensOptions = {},
): number {
  lensCheck(fov, aspect, filmGauge, sensorFit);
  if (fov >= 180) throw new RangeError('Invalid projection lens; pass a field of view below 180 degrees');
  const half = Math.tan((fov * Math.PI) / 360);
  return filmGauge / (2 * (spansHorizontal(aspect, sensorFit) ? half * aspect : half));
}

/**
 * A sub-rectangle of a larger image, in pixels of that image with the origin at its top left. The frustum is built
 * for the full image (aspect `fullWidth / fullHeight`) and the view shows only the rectangle, so the canvas or render
 * target should be `width` by `height`. `x` and `y` may be fractions (jittered rendering) or negative.
 */
export interface ViewOffset {
  fullWidth: number;
  fullHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Splits a `fullWidth` by `fullHeight` image into `tileWidth` by `tileHeight` offsets, row by row from the top left; edge tiles are smaller. */
export function tileOffsets(
  fullWidth: number,
  fullHeight: number,
  tileWidth: number,
  tileHeight = tileWidth,
): ViewOffset[] {
  if (![fullWidth, fullHeight, tileWidth, tileHeight].every((v) => Number.isInteger(v) && v > 0))
    throw new RangeError('Invalid projection tiles; pass whole numbers above 0 for the full size and the tile size');
  const tiles: ViewOffset[] = [];
  for (let y = 0; y < fullHeight; y += tileHeight)
    for (let x = 0; x < fullWidth; x += tileWidth)
      tiles.push({
        fullWidth,
        fullHeight,
        x,
        y,
        width: Math.min(tileWidth, fullWidth - x),
        height: Math.min(tileHeight, fullHeight - y),
      });
  return tiles;
}

/** Options of `CameraProjection.fit`: the view's aspect, the animation time and the margin around the box. */
export interface FitOptions {
  /** Width / height of the view. Default: the engine canvas (`setup`), else 1. */
  aspect?: number;
  /** Seconds; 0 jumps. Default 0.3, like core's `fitToBoundingBox`. */
  duration?: number;
  /** At least 1. Default 1.1. */
  padding?: number;
}

/** Vertical when the horizontal part of the view direction is at most this fraction of the distance. */
const VERTICAL = 1e-9;
type Fit = {
  from: Vec3;
  to: Vec3;
  fromTarget: Vec3;
  toTarget: Vec3;
  fromZoom: number;
  toZoom: number;
  elapsed: number;
  duration: number;
};

/**
 * Orthographic projection and exactly vertical views for core's Camera, through its `project` and `up` hooks, so the
 * matrix, culling planes, `engine.pick`, every pass and every `camera.matrix` reader get the same view.
 */
export class CameraProjection implements EnginePlugin, ProjectionOptions {
  readonly name = 'cameras';
  mode: 'orthographic' | 'perspective' = 'orthographic';
  height?: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  zoom = 1;
  near?: number;
  far?: number;
  up: Vec3 = [0, 0, -1];
  viewOffset?: ViewOffset;
  focalLength?: number;
  filmGauge = 36;
  sensorFit: SensorFit = 'auto';
  private camera?: Camera;
  private worldUp: Vec3 = [0, 1, 0];
  private canvas?: { width: number; height: number };
  private animation?: Fit;
  /** Same as `engine.use(new CameraProjection(...))`; returns the CameraProjection. */
  static attach(engine: EngineKernel, options?: ProjectionOptions): CameraProjection {
    const value = new CameraProjection(options);
    engine.use(value);
    return value;
  }
  constructor(options: ProjectionOptions = {}) {
    Object.assign(this, options);
  }
  setup(engine: Pick<Engine, 'camera'> & { canvas?: { width: number; height: number } }): void {
    this.attach(engine.camera);
    this.canvas = engine.canvas;
  }
  /**
   * Frames a box given as `[minX, minY, minZ, maxX, maxY, maxZ]` (`model.bounds`). Perspective: core's
   * `fitToBoundingBox`. Orthographic: keeps the view direction and distance, centres the box and sets `zoom` so the
   * box's projected outline fits (tighter than a bounding sphere). Animated by the engine (`onPreUpdate`).
   */
  fit(
    bounds: ArrayLike<number>,
    {
      aspect = this.canvas ? this.canvas.width / this.canvas.height : 1,
      duration = 0.3,
      padding = 1.1,
    }: FitOptions = {},
  ): void {
    const camera = this.camera;
    if (!camera)
      throw margoError('state', 'Projection is not attached; call attach(camera) or engine.use(projection) first');
    const b = Array.from(bounds),
      min = b.slice(0, 3) as unknown as Vec3,
      max = b.slice(3) as unknown as Vec3;
    if (
      b.length !== 6 ||
      !b.every(Number.isFinite) ||
      min.some((v, i) => v > max[i]) ||
      ![aspect, duration, padding].every(Number.isFinite) ||
      aspect <= 0 ||
      duration < 0 ||
      padding < 1
    )
      throw new RangeError('Invalid fit; pass min <= max, aspect > 0, duration >= 0 and padding >= 1, all finite');
    this.animation = undefined;
    this.applyLens(aspect);
    if (this.mode === 'perspective') {
      camera.fitToBoundingBox(min, max, { aspect, duration, padding });
      return;
    }
    camera.cancelFit();
    const p = camera.position,
      t = camera.target,
      back = [0, 1, 2].map((i) => p[i] - t[i]),
      length = Math.hypot(...back),
      f = back.map((v) => -v / length),
      up = this.screenUp(camera);
    let r = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
    const side = Math.hypot(...r);
    r = r.map((v) => v / side);
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]],
      half = max.map((v, i) => (v - min[i]) / 2),
      centre = max.map((v, i) => (v + min[i]) / 2);
    // Half extents of the box's outline on the view plane.
    const ex = half.reduce((s, v, i) => s + Math.abs(r[i]) * v, 0),
      ey = half.reduce((s, v, i) => s + Math.abs(u[i]) * v, 0);
    const frustum = [this.left, this.right, this.top, this.bottom];
    let zoom: number,
      offset = [0, 0];
    if (frustum.every((v) => v !== undefined)) {
      const [l, rt, top, bottom] = frustum as number[];
      zoom = Math.min((rt - l) / 2 / ex, (top - bottom) / 2 / ey) / padding;
      offset = [(rt + l) / 2, (top + bottom) / 2];
    } else
      zoom =
        (this.height ?? 2 * length * Math.tan((this.vfov(camera, aspect) * Math.PI) / 360)) /
        2 /
        Math.max(ey, ex / aspect) /
        padding;
    if (!(zoom > 0 && zoom < Infinity) || !side)
      throw new RangeError('Invalid fit; the bounds are empty or flat along the view, pass a box with volume');
    if (this.near === undefined && this.far === undefined && Math.hypot(...half) >= camera.far / 2)
      throw new RangeError('Bounds exceed far; raise camera.far or set far on the projection');
    const target = centre.map((v, i) => v - r[i] * offset[0] - u[i] * offset[1]) as unknown as Vec3,
      position = target.map((v, i) => v + back[i]) as unknown as Vec3;
    this.animation = {
      from: p,
      to: position,
      fromTarget: t,
      toTarget: target,
      fromZoom: this.zoom,
      toZoom: zoom,
      elapsed: 0,
      duration,
    };
    this.onPreUpdate(0);
  }
  /** Advances an orthographic `fit`; the engine calls it each frame. Call it yourself after `attach(camera)`. */
  onPreUpdate(delta: number): void {
    const a = this.animation,
      camera = this.camera;
    if (camera && this.canvas && this.focalLength !== undefined) {
      const o = this.viewOffset,
        aspect = o ? o.fullWidth / o.fullHeight : this.canvas.width / this.canvas.height;
      if (aspect > 0 && aspect < Infinity) this.applyLens(aspect);
    }
    if (!a || !camera) return;
    const k = a.duration ? Math.min(1, (a.elapsed += delta) / a.duration) : 1,
      s = k * k * (3 - 2 * k),
      mix = (x: Vec3, y: Vec3) => x.map((v, i) => v + (y[i] - v) * s) as unknown as Vec3;
    camera.position = mix(a.from, a.to);
    camera.target = mix(a.fromTarget, a.toTarget);
    this.zoom = a.fromZoom * (a.toZoom / a.fromZoom) ** s;
    if (k === 1) this.animation = undefined;
  }
  /**
   * Renders the `width` by `height` rectangle at (`x`, `y`) of a `fullWidth` by `fullHeight` image (see `ViewOffset`).
   * Works in both modes and with any `zoom`, `height` or bounds; `fit` still frames the whole canvas.
   */
  setViewOffset(fullWidth: number, fullHeight: number, x: number, y: number, width: number, height: number): void {
    this.viewOffset = { fullWidth, fullHeight, x, y, width, height };
  }
  /**
   * With a `focalLength`, writes the lens's vertical field of view for `aspect` to `camera.fov`, so passes and controls
   * that read `camera.fov` agree with the projection, and returns it; else returns `camera.fov`. The engine does this
   * each frame (`onPreUpdate`); call it yourself without an engine.
   */
  applyLens(aspect: number): number {
    const camera = this.camera;
    if (!camera)
      throw margoError('state', 'Projection is not attached; call attach(camera) or engine.use(projection) first');
    return (camera.fov = this.vfov(camera, aspect));
  }
  /** Goes back to the whole frustum. */
  clearViewOffset(): void {
    this.viewOffset = undefined;
  }
  /** Use without an engine, e.g. on a second Camera. */
  attach(camera: Camera): void {
    if (this.camera) throw margoError('attached', 'Projection is already attached; dispose() it or create another');
    if (camera.project) throw margoError('attached', 'Camera already has a projection; dispose that projection first');
    this.camera = camera;
    this.worldUp = camera.up;
    // camera.up is the world up except for exactly vertical views, where it is this.up.
    Object.defineProperty(camera, 'up', {
      configurable: true,
      enumerable: true,
      get: () => this.screenUp(camera),
      set: (up: Vec3) => {
        this.worldUp = up;
      },
    });
    // Read by @margoengine/controls: a fixed orthographic size means cursor dolly must not pan.
    Object.defineProperty(camera, 'fixedOrthographic', { configurable: true, get: () => this.fixedOrthographic });
    camera.project = (out, aspect, webgpu) => this.project(camera, out, aspect, webgpu);
  }
  dispose(): void {
    const camera = this.camera;
    if (!camera) return;
    this.camera = undefined;
    this.animation = undefined;
    Object.defineProperty(camera, 'up', { configurable: true, enumerable: true, writable: true, value: this.worldUp });
    delete (camera as { fixedOrthographic?: boolean }).fixedOrthographic;
    camera.project = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /**
   * True when the orthographic view size is fixed (`height` or all four bounds set), so moving the camera along its
   * view direction does not change what is visible. Also exposed on the attached camera for controls.
   */
  get fixedOrthographic(): boolean {
    return (
      this.mode === 'orthographic' &&
      (this.height !== undefined || [this.left, this.right, this.top, this.bottom].every((v) => v !== undefined))
    );
  }
  private screenUp(camera: Camera): Vec3 {
    const p = camera.position,
      t = camera.target,
      x = p[0] - t[0],
      y = p[1] - t[1],
      z = p[2] - t[2];
    if (Math.hypot(x, z) > VERTICAL * Math.hypot(x, y, z)) return this.worldUp;
    const u = this.up;
    if (!(Math.hypot(u[0], u[2]) > 0) || !Number.isFinite(u[1]))
      throw new RangeError('Invalid vertical up; set up to a finite vector that is not parallel to the Y axis');
    return u;
  }
  private vfov(camera: Camera, aspect: number): number {
    if (this.focalLength === undefined) return camera.fov;
    return lensToFov(this.focalLength, aspect, { filmGauge: this.filmGauge, sensorFit: this.sensorFit });
  }
  private project(camera: Camera, P: Float64Array, aspect: number, webgpu: boolean): void {
    const o = this.viewOffset;
    if (!o) return this.build(camera, P, aspect, webgpu);
    if (
      ![o.fullWidth, o.fullHeight, o.x, o.y, o.width, o.height].every(Number.isFinite) ||
      !(o.fullWidth > 0 && o.fullHeight > 0 && o.width > 0 && o.height > 0)
    )
      throw new RangeError(
        'Invalid projection view offset; pass finite numbers with fullWidth, fullHeight, width and height above 0',
      );
    this.build(camera, P, o.fullWidth / o.fullHeight, webgpu);
    // Remap clip x and y from the full image to the rectangle: rows 0 and 1 gain a multiple of row 3 (w).
    const sx = o.fullWidth / o.width,
      sy = o.fullHeight / o.height,
      ox = (o.fullWidth - 2 * o.x - o.width) / o.width,
      oy = (o.height - o.fullHeight + 2 * o.y) / o.height;
    for (let c = 0; c < 4; c++) {
      P[c * 4] = sx * P[c * 4] + ox * P[c * 4 + 3];
      P[c * 4 + 1] = sy * P[c * 4 + 1] + oy * P[c * 4 + 3];
    }
  }
  private build(camera: Camera, P: Float64Array, aspect: number, webgpu: boolean): void {
    const n = camera.near,
      f = camera.far;
    if (this.mode === 'perspective') {
      const d = n - f,
        k = 1 / Math.tan((this.vfov(camera, aspect) * Math.PI) / 360);
      P[0] = k / aspect;
      P[5] = k;
      P[10] = webgpu ? -n / d : (f + n) / d;
      P[11] = -1;
      P[14] = webgpu ? (-f * n) / d : (2 * f * n) / d;
      return;
    }
    if (this.mode !== 'orthographic')
      throw new RangeError("Invalid projection mode; use 'perspective' or 'orthographic'");
    const p = camera.position,
      t = camera.target,
      length = Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
    const bounds = [this.left, this.right, this.top, this.bottom],
      half = (this.height ?? 2 * length * Math.tan((this.vfov(camera, aspect) * Math.PI) / 360)) / 2;
    let [l, r, top, b] = bounds.every((v) => v !== undefined)
      ? (bounds as number[])
      : [-half * aspect, half * aspect, half, -half];
    const near = this.near ?? length - f / 2,
      far = this.far ?? length + f / 2,
      dx = (r - l) / (2 * this.zoom),
      dy = (top - b) / (2 * this.zoom),
      cx = (r + l) / 2,
      cy = (top + b) / 2;
    l = cx - dx;
    r = cx + dx;
    top = cy + dy;
    b = cy - dy;
    if (
      ![l, r, top, b, near, far, this.zoom].every(Number.isFinite) ||
      this.zoom <= 0 ||
      r <= l ||
      top <= b ||
      far <= near
    )
      throw new RangeError('Invalid projection; pass finite bounds with left < right, bottom < top and near < far');
    P[0] = 2 / (r - l);
    P[5] = 2 / (top - b);
    P[10] = webgpu ? 1 / (far - near) : -2 / (far - near);
    P[12] = -(r + l) / (r - l);
    P[13] = -(top + b) / (top - b);
    P[14] = webgpu ? far / (far - near) : -(far + near) / (far - near);
    P[15] = 1;
  }
}
