/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math';
import { Raycaster } from './raycaster.js';
import { RaycastProjection, readPoint, type RaycastProjectedPoint } from './projection.js';
import type { RaycastSnapshot } from './raycast-snapshot.js';

/** Top-left row-major RGBA8 shared atlas. Only alpha bytes are captured/validated; RGB is not sampled. */
export interface RaycastAlphaTexture {
  /** Width in texels. */
  width: number;
  /** Height in texels. */
  height: number;
  /** width * height * 4 bytes, RGBA, rows top to bottom. */
  pixels: ArrayLike<number>;
}

/** Captured visibility policy. Every depth query uses all hits so transparent foreground cannot hide an opaque layer. */
export interface RaycastVisibilityOptions {
  /** Optional borrowed projection frame; its lifetime and the parent snapshot must outlive this query. */
  projection?: RaycastProjection;
  /** Explicit world height for orthographic one-CSS-pixel boundary tolerance. */
  orthographicHeight?: number;
  /** Shared clamped nearest atlas, copied once. Recapture after texture edits. Hits without UVs stay opaque. */
  alphaTexture?: RaycastAlphaTexture;
  /** Minimum opaque alpha byte, default 6. */
  alphaThreshold?: number;
  /** Captured ray range/side/layers/filter, with ordinary Raycaster defaults. */
  near?: number;
  far?: number;
  side?: Raycaster['side'];
  layers?: number;
  filter?: Raycaster['filter'];
}

/** Camera-forward nearest opaque depth, distinguishing true geometry misses from known transparent pixels. */
export interface RaycastDepthSample {
  /** Camera-forward depth of the nearest opaque hit, or null when there is none. */
  depth: number | null;
  /** True when the ray hit no geometry at all (not merely transparent texels). */
  missed: boolean;
}

/**
 * Owned projection/depth/alpha policy over a borrowed static scene snapshot and projection frame. Recapture after
 * camera/scene/atlas changes. Scene numeric data is captured; handle/model/engine liveness stays checked per ray.
 * Exact depth uses epsilon max(1e-5,depth*1e-5). Only true misses sample eight quarter-CSS-pixel neighbors;
 * transparent hits remain clear. Boundary tolerance is max(epsilon,one CSS world pixel). No visibility cache or
 * far-plane point clipping is introduced. Shared-atlas alpha is not a general material-shader evaluator.
 * Batch points are copied before callbacks; no partial array is returned on failure. Results own their data.
 * @throws TypeError/RangeError for malformed options/points/atlas/camera data; MargoError state on reentry and
 * disposed after query/snapshot/projection/engine disposal. Finish the call,repair data,or capture a live query.
 */
export interface RaycastVisibilityQuery {
  /** Whether {@link RaycastVisibilityQuery.dispose} has been called. */
  readonly disposed: boolean;
  /** CSS canvas point and camera depth of a world point through the query's projection, or null behind near. */
  project(point: ArrayLike<number>): RaycastProjectedPoint | null;
  /** Camera depth of the nearest opaque hit under a CSS canvas point; `missed` is true only when nothing was hit. */
  depthAtCanvas(x: number, y: number): RaycastDepthSample;
  /** Whether a world point is in front of the near plane and not hidden by opaque captured geometry. */
  visible(point: ArrayLike<number>): boolean;
  /** {@link RaycastVisibilityQuery.visible} for each point, in order; all points are copied before any ray is cast. */
  visibleMany(points: readonly ArrayLike<number>[]): boolean[];
  /** Releases the query. Idempotent. */
  dispose(): void;
  /** Same as {@link RaycastVisibilityQuery.dispose}, for `using` declarations. */
  [Symbol.dispose](): void;
}

// Only true misses retry at these quarter-CSS-pixel offsets, in this order.
const NEIGHBOURS = [
  [-0.25, 0],
  [0.25, 0],
  [0, -0.25],
  [0, 0.25],
  [-0.25, -0.25],
  [0.25, -0.25],
  [-0.25, 0.25],
  [0.25, 0.25],
] as const;

interface AlphaImage {
  width: number;
  height: number;
  alpha: Uint8Array;
}
interface VisibilityState {
  snapshot: RaycastSnapshot;
  projection: RaycastProjection;
  ray: Raycaster;
  alpha: AlphaImage | null;
  cutoff: number;
  height: number | undefined;
  assertLive: () => void;
}

/** Internal construction from a live snapshot; no captured arrays or mutable ray escape through the public interface. */
export function createVisibilityQuery(
  snapshot: RaycastSnapshot,
  projection: RaycastProjection,
  options: RaycastVisibilityOptions,
  validateRay: (ray: Raycaster) => void,
  assertLive: () => void,
): RaycastVisibilityQuery {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Visibility options need an object; supply projection/atlas policy or omit options.');
  const {
    projection: supplied,
    orthographicHeight: height,
    alphaTexture,
    alphaThreshold: cutoff = 6,
    near = 0,
    far = Infinity,
    side = 'material',
    layers = 0xffffffff,
    filter = null,
  } = options;
  const captured = supplied === undefined ? projection : supplied;
  if (!(captured instanceof RaycastProjection))
    throw new TypeError('Visibility projection needs a RaycastProjection; capture a camera frame first.');
  if (!Number.isInteger(cutoff) || cutoff < 0 || cutoff > 255)
    throw new RangeError('Visibility alphaThreshold must be a byte from 0 to 255; choose a valid cutoff.');
  captured.pixelWorldSize(1, height);
  const ray = new Raycaster();
  ray.near = near;
  ray.far = far;
  ray.side = side;
  ray.layers = layers;
  ray.filter = filter;
  validateRay(ray);
  const alpha = alphaTexture === undefined ? null : captureAlpha(alphaTexture);
  assertLive();
  if (captured.disposed)
    throw new MargoError('disposed', 'Visibility projection is disposed; capture a live projection frame.');
  return new VisibilityQuery({ snapshot, projection: captured, ray, alpha, cutoff, height, assertLive });
}

class VisibilityQuery implements RaycastVisibilityQuery {
  private state: VisibilityState | null;
  private busy = false;
  constructor(state: VisibilityState) {
    this.state = state;
  }
  get disposed(): boolean {
    return this.state === null;
  }
  private open(): VisibilityState {
    if (!this.state)
      throw new MargoError('disposed', 'Visibility query is disposed; create a new query from a live snapshot.');
    this.state.assertLive();
    if (this.state.projection.disposed)
      throw new MargoError('disposed', 'Visibility projection is disposed; capture a live projection frame.');
    return this.state;
  }
  private run<T>(action: (state: VisibilityState) => T): T {
    const state = this.open();
    if (this.busy)
      throw new MargoError('state', 'Visibility query is already running; finish the current call before reentry.');
    this.busy = true;
    try {
      const result = action(state);
      this.open();
      return result;
    } finally {
      this.busy = false;
    }
  }
  project(point: ArrayLike<number>): RaycastProjectedPoint | null {
    return this.run((s) => s.projection.project(point));
  }
  depthAtCanvas(x: number, y: number): RaycastDepthSample {
    return this.run((s) => this.sample(s, x, y));
  }
  visible(point: ArrayLike<number>): boolean {
    return this.run((s) => this.test(s, point));
  }
  visibleMany(points: readonly ArrayLike<number>[]): boolean[] {
    return this.run((s) => {
      if (!Array.isArray(points))
        throw new TypeError('Visibility batches need an ordered point array; supply finite XYZ points.');
      const captured = Array.from(points, readPoint);
      this.open();
      return captured.map((p) => this.test(s, p));
    });
  }
  private sample(s: VisibilityState, x: number, y: number): RaycastDepthSample {
    s.projection.setFromCanvas(s.ray, x, y);
    const hits = s.snapshot.intersectDepth(s.ray);
    this.open();
    const a = s.alpha,
      hit = hits.find(({ uv }) => {
        if (!uv || !a) return true;
        const px = Math.max(0, Math.min(a.width - 1, Math.floor(uv[0] * a.width))),
          py = Math.max(0, Math.min(a.height - 1, Math.floor(uv[1] * a.height)));
        return a.alpha[py * a.width + px] >= s.cutoff;
      });
    return { depth: hit ? s.projection.depth(hit.point) : null, missed: hits.length === 0 };
  }
  private test(s: VisibilityState, point: ArrayLike<number>): boolean {
    const screen = s.projection.project(point);
    this.open();
    if (!screen) return false;
    const exact = this.sample(s, screen.x, screen.y),
      epsilon = Math.max(1e-5, screen.depth * 1e-5);
    if (exact.depth !== null) return exact.depth >= screen.depth - epsilon;
    if (!exact.missed) return true;
    let nearest = Infinity;
    for (const [dx, dy] of NEIGHBOURS) {
      const sample = this.sample(s, screen.x + dx, screen.y + dy);
      if (sample.depth !== null) nearest = Math.min(nearest, sample.depth);
    }
    return nearest >= screen.depth - Math.max(epsilon, s.projection.pixelWorldSize(screen.depth, s.height));
  }
  dispose(): void {
    this.state = null;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

function captureAlpha(texture: RaycastAlphaTexture): AlphaImage {
  if (!texture || typeof texture !== 'object')
    throw new TypeError('Visibility alpha texture needs width, height and RGBA8 pixels; supply a shared atlas.');
  const { width, height, pixels } = texture;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16_777_216)
    throw new RangeError('Visibility alpha dimensions need positive integers up to 16777216 texels; resize the atlas.');
  if (!pixels || pixels.length !== width * height * 4)
    throw new TypeError('Visibility alpha texture needs width * height * 4 channels; repair the RGBA storage.');
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    const value = pixels[i * 4 + 3];
    if (!Number.isInteger(value) || value < 0 || value > 255)
      throw new TypeError('Visibility alpha channels must be RGBA8 bytes; repair the atlas before capture.');
    alpha[i] = value;
  }
  return { width, height, alpha };
}
