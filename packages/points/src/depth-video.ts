// Depth video to points: each pixel of an RGB + depth frame is unprojected through a pinhole camera into a coloured point.
// The unprojection is the pinhole model, x = (u - cx) z / fx, y = (cy - v) z / fy (Hartley and Zisserman, "Multiple View
// Geometry", 2nd ed., section 6.1), with the camera looking down -Z and Y up, as the engine's cameras do.
import { MargoError } from '@margoengine/math/errors';
import { PointCloud, type PointCloudData, type PointCloudOptions } from './cloud.js';

/** 8-bit RGBA pixels, row 0 at the top: an `ImageData` fits. */
export interface DepthFrameImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** How a depth video stores depth. */
export type DepthEncoding =
  /** One 8-bit channel (the red one) of a grey picture: `near` at 0 and `far` at 255 (`invert` swaps them). */
  | 'gray'
  /** 16 bits: red is the high byte and green the low one (lossless formats only). Value / 65535 between `near` and `far`. */
  | 'rg16'
  /** 16 bits as in `'rg16'`, read as millimetres: metres = value / 1000, `near` and `far` still clip. */
  | 'millimeters';

/** Where the depth sits in a frame. */
export type DepthLayout =
  /** The colour is the left half of the frame and the depth the right half (the usual one-file depth video). */
  | 'side-by-side'
  /** The colour is the top half and the depth the bottom half. */
  | 'top-bottom'
  /** The depth is a second picture, passed beside the frame. */
  | 'separate';

/** Options of {@link depthVideoPoints} and {@link DepthVideoCloud}. */
export interface DepthVideoOptions {
  /** Where the depth is. Default `'side-by-side'`. */
  layout?: DepthLayout;
  /** How depth is stored. Default `'gray'`. */
  encoding?: DepthEncoding;
  /** The depth, in metres, that the lowest stored value means, and the nearest depth kept. Default 0.3. */
  near?: number;
  /** The depth that the highest stored value means, and the farthest kept. Default 5. */
  far?: number;
  /** The stored values run the other way: the highest is near. Default false. */
  invert?: boolean;
  /** Vertical field of view in degrees, for a camera with square pixels. Default 60. Ignored with `intrinsics`. */
  fov?: number;
  /** The camera's focal lengths and principal point in pixels of the colour picture, when known (they set `fov`). */
  intrinsics?: { fx: number; fy: number; cx: number; cy: number };
  /** Keep every n-th pixel in both directions. Default 1. */
  stride?: number;
  /**
   * Drop a pixel whose depth differs from a neighbour's (left, right, above, below) by more than this share of its own
   * depth: the flying pixels along an edge. 0 keeps everything. Default 0.05.
   */
  maxJump?: number;
}

/** Points from one frame, in `PointCloudData`'s shape. */
export interface DepthVideoPoints extends PointCloudData {
  positions: Float32Array;
  /** RGB in 0..255 per point. */
  colors: Uint8Array;
  /** Pixels kept, which is `positions.length / 3`. */
  count: number;
  /** Size of the colour picture the points came from. */
  width: number;
  height: number;
}

interface Resolved {
  layout: DepthLayout;
  encoding: DepthEncoding;
  near: number;
  far: number;
  invert: boolean;
  fov: number;
  intrinsics?: { fx: number; fy: number; cx: number; cy: number };
  stride: number;
  maxJump: number;
}

function resolve(options: DepthVideoOptions): Resolved {
  const r: Resolved = {
    layout: options.layout ?? 'side-by-side',
    encoding: options.encoding ?? 'gray',
    near: options.near ?? 0.3,
    far: options.far ?? 5,
    invert: options.invert ?? false,
    fov: options.fov ?? 60,
    intrinsics: options.intrinsics,
    stride: options.stride ?? 1,
    maxJump: options.maxJump ?? 0.05,
  };
  if (!['side-by-side', 'top-bottom', 'separate'].includes(r.layout))
    throw new TypeError(`layout ${r.layout} is unknown; use 'side-by-side', 'top-bottom' or 'separate'`);
  if (!['gray', 'rg16', 'millimeters'].includes(r.encoding))
    throw new TypeError(`encoding ${r.encoding} is unknown; use 'gray', 'rg16' or 'millimeters'`);
  if (!(r.near > 0) || !(r.far > r.near) || !Number.isFinite(r.far))
    throw new RangeError(`near ${r.near} and far ${r.far} must satisfy 0 < near < far`);
  if (!(r.fov > 0 && r.fov < 180)) throw new RangeError(`fov ${r.fov} must be between 0 and 180 degrees`);
  if (!Number.isInteger(r.stride) || r.stride < 1) throw new RangeError(`stride ${r.stride} must be an integer of at least 1`);
  if (!(r.maxJump >= 0)) throw new RangeError(`maxJump ${r.maxJump} must not be negative`);
  return r;
}

const check = (image: DepthFrameImage, name: string): void => {
  if (!(image.width > 0 && image.height > 0) || image.data.length < image.width * image.height * 4)
    throw new MargoError('failed', `${name}: the image is empty or shorter than width x height x 4 bytes; pass RGBA pixels`);
};

/** Splits a frame into its colour and depth pictures by `layout`. */
function split(frame: DepthFrameImage, depth: DepthFrameImage | undefined, layout: DepthLayout) {
  check(frame, 'depth video frame');
  if (layout === 'separate') {
    if (!depth) throw new TypeError("layout 'separate' needs the depth picture as the second argument");
    check(depth, 'depth picture');
    return { color: { x: 0, y: 0, w: frame.width, h: frame.height, image: frame }, depth: { x: 0, y: 0, w: depth.width, h: depth.height, image: depth } };
  }
  const half = layout === 'side-by-side' ? frame.width : frame.height;
  if (half % 2) throw new RangeError(`a ${layout} frame needs an even ${layout === 'side-by-side' ? 'width' : 'height'}; got ${half}`);
  const w = layout === 'side-by-side' ? frame.width / 2 : frame.width,
    h = layout === 'side-by-side' ? frame.height : frame.height / 2;
  return {
    color: { x: 0, y: 0, w, h, image: frame },
    depth: { x: layout === 'side-by-side' ? w : 0, y: layout === 'side-by-side' ? 0 : h, w, h, image: frame },
  };
}


/** Depth in metres at pixel (x, y) of a depth rectangle, or NaN: a stored 0 is a hole (no reading), as in most depth sensors. */
function metres(r: Resolved, rect: { x: number; y: number; image: DepthFrameImage }, x: number, y: number): number {
  const at = ((rect.y + y) * rect.image.width + rect.x + x) * 4,
    d = rect.image.data;
  if (r.encoding === 'millimeters') {
    const v = (d[at] << 8) | d[at + 1],
      m = v / 1000;
    return v !== 0 && m >= r.near && m <= r.far ? m : NaN;
  }
  const raw = r.encoding === 'gray' ? d[at] : (d[at] << 8) | d[at + 1];
  if (raw === 0) return NaN;
  const t = raw / (r.encoding === 'gray' ? 255 : 65535);
  return r.near + (r.invert ? 1 - t : t) * (r.far - r.near);
}

/** One frame unprojected on its full (strided) grid: dropped pixels are flagged in `valid`, not removed. */
interface Grid {
  columns: number;
  rows: number;
  width: number;
  height: number;
  positions: Float32Array;
  colors: Uint8Array;
  valid: Uint8Array;
  shown: number;
}

function grid(frame: DepthFrameImage, depth: DepthFrameImage | undefined, r: Resolved): Grid {
  const { color, depth: dr } = split(frame, depth, r.layout),
    f = r.intrinsics ?? {
      fx: color.h / 2 / Math.tan((r.fov * Math.PI) / 360),
      fy: color.h / 2 / Math.tan((r.fov * Math.PI) / 360),
      cx: color.w / 2,
      cy: color.h / 2,
    },
    columns = Math.ceil(color.w / r.stride),
    rows = Math.ceil(color.h / r.stride),
    count = columns * rows,
    positions = new Float32Array(count * 3),
    colors = new Uint8Array(count * 3),
    valid = new Uint8Array(count),
    z = new Float32Array(count);
  // Depth of every kept pixel first, so the jump test sees the neighbours. The depth picture may be smaller or larger
  // than the colour one: it is read at the same relative position, nearest pixel.
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const px = Math.min(color.w - 1, i * r.stride),
        py = Math.min(color.h - 1, j * r.stride);
      z[j * columns + i] = metres(
        r,
        dr,
        Math.min(dr.w - 1, Math.floor(((px + 0.5) / color.w) * dr.w)),
        Math.min(dr.h - 1, Math.floor(((py + 0.5) / color.h) * dr.h)),
      );
    }
  let shown = 0;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const slot = j * columns + i,
        d = z[slot];
      if (Number.isNaN(d)) continue;
      if (r.maxJump > 0) {
        let flying = false;
        for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const a = i + di,
            b = j + dj;
          if (a < 0 || b < 0 || a >= columns || b >= rows) continue;
          const o = z[b * columns + a];
          if (!Number.isNaN(o) && Math.abs(o - d) > d * r.maxJump) flying = true;
        }
        if (flying) continue;
      }
      const px = Math.min(color.w - 1, i * r.stride),
        py = Math.min(color.h - 1, j * r.stride),
        at = ((color.y + py) * color.image.width + color.x + px) * 4;
      positions[slot * 3] = ((px + 0.5 - f.cx) * d) / f.fx;
      positions[slot * 3 + 1] = ((f.cy - (py + 0.5)) * d) / f.fy;
      positions[slot * 3 + 2] = -d;
      colors[slot * 3] = color.image.data[at];
      colors[slot * 3 + 1] = color.image.data[at + 1];
      colors[slot * 3 + 2] = color.image.data[at + 2];
      valid[slot] = 1;
      shown++;
    }
  return { columns, rows, width: color.w, height: color.h, positions, colors, valid, shown };
}

/**
 * Unprojects one RGB + depth frame into points, dropping pixels with no depth or with a jump (see `maxJump`). Returns
 * `PointCloudData` for `new PointCloud(...)`. `depth` is the second picture of `layout: 'separate'`; it may differ in
 * size from the colour picture.
 * @throws TypeError or RangeError for options out of range, MargoError `'failed'` for an empty picture.
 */
export function depthVideoPoints(
  frame: DepthFrameImage,
  options: DepthVideoOptions = {},
  depth?: DepthFrameImage,
): DepthVideoPoints {
  const g = grid(frame, depth, resolve(options)),
    positions = new Float32Array(g.shown * 3),
    colors = new Uint8Array(g.shown * 3);
  let n = 0;
  for (let slot = 0; slot < g.valid.length; slot++) {
    if (!g.valid[slot]) continue;
    positions.set(g.positions.subarray(slot * 3, slot * 3 + 3), n * 3);
    colors.set(g.colors.subarray(slot * 3, slot * 3 + 3), n * 3);
    n++;
  }
  return { positions, colors, count: n, width: g.width, height: g.height };
}

/** Options of {@link DepthVideoCloud}: the video options plus those of the cloud it makes. */
export interface DepthVideoCloudOptions extends DepthVideoOptions {
  /** Size of the colour picture the video will deliver (after `layout` splitting), in pixels. */
  width: number;
  height: number;
  /** Options of the `PointCloud`, for example `material`. */
  cloud?: Omit<PointCloudOptions, 'positions' | 'colors' | 'sizes' | 'colorComponents'>;
}

/**
 * A `PointCloud` that follows a depth video: one point per kept pixel, rewritten by every `update(frame)`. Pixels with
 * no depth, and flying pixels, get size 0 for the frame, so the point count never changes and nothing is reallocated.
 * Add `cloud` to a `PointsPlugin`.
 */
export class DepthVideoCloud implements Disposable {
  /** The cloud to add to a `PointsPlugin`. */
  readonly cloud: PointCloud;
  /** Points the cloud holds (showing or not). */
  readonly count: number;
  private readonly options: DepthVideoCloudOptions;

  constructor(options: DepthVideoCloudOptions) {
    const r = resolve(options);
    if (!Number.isInteger(options.width) || !Number.isInteger(options.height) || options.width < 1 || options.height < 1)
      throw new RangeError(`width ${options.width} and height ${options.height} must be integers of at least 1`);
    this.options = options;
    this.count = Math.ceil(options.width / r.stride) * Math.ceil(options.height / r.stride);
    this.cloud = new PointCloud({
      ...options.cloud,
      positions: new Float32Array(this.count * 3),
      colors: new Uint8Array(this.count * 3),
      colorComponents: 3,
      sizes: new Float32Array(this.count),
    });
  }

  /**
   * Writes a frame into the cloud and returns how many points show. A frame whose colour picture is not `width` x
   * `height` throws a RangeError.
   */
  update(frame: DepthFrameImage, depth?: DepthFrameImage): number {
    const g = grid(frame, depth, resolve(this.options));
    if (g.width !== this.options.width || g.height !== this.options.height)
      throw new RangeError(
        `the frame's colour picture is ${g.width} x ${g.height}; this cloud was made for ${this.options.width} x ${this.options.height}`,
      );
    const sizes = new Float32Array(g.valid);
    this.cloud.updatePositions(0, g.positions).updateColors(0, g.colors, 3).updateSizes(0, sizes);
    return g.shown;
  }

  /** Releases the cloud. */
  [Symbol.dispose](): void {
    this.cloud.dispose();
  }
}
