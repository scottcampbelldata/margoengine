// Motion checks of a moving probe (frame pairs with per pixel motion and depth): shimmer, blur reach, reprojection,
// depth from distance and motion blur. Split from look.ts along this seam; look.ts re-exports every name.
import {
  luma,
  maskBits,
  percent,
  result,
  sameSize,
  type FlickerOptions,
  type LookImage,
  type LookResult,
} from './look-base.js';
import { rangeError } from '../../shared/errors.js';

/** Per pixel motion of a frame to the next, in pixels: x then y of each pixel, `width * height * 2` floats. */
export interface LookMotion {
  width: number;
  height: number;
  data: Float32Array;
}

/** A moving probe: the frame after this one and where each pixel of this one went. */
export interface MovingFrames {
  next: LookImage;
  motion: LookMotion;
  /**
   * Each pixel of `next` moved back to this frame, the same way as `motion`: with it `shimmerMoving` leaves out the
   * pixels the next frame covers or uncovers (the forward-backward test).
   */
  back?: LookMotion;
  /**
   * The engine's own motion of each pixel of this frame from the frame before, the same way as `motion` (pixels over
   * one frame, TAA's velocity with its jitter removed): with it `shimmerMoving` leaves out a pixel whose surface moves
   * other than the camera moves it, by more than half a pixel (a swaying branch, a flame, a wave), which changes on
   * purpose, including what such a surface leaves behind, and `motionBlur` judges each edge by its surface's own travel.
   */
  velocity?: LookMotion;
  /** The same for each pixel of `next`: `shimmerMoving` also leaves out a pixel that lands where such a surface moved. */
  nextVelocity?: LookMotion;
  /**
   * The shutter angle the frame was exposed with, in degrees (more than 0, up to 360), for `motionBlur`. Default 180,
   * the film standard: a frame drawn without sub-frames is still judged against a 180 degree smear.
   */
  shutter?: number;
  /**
   * The longest blur radius the shot's motion blur draws, in pixels (`MotionBlur` `maxBlur`), for `shimmerMoving`'s
   * blur reach. Default 32, `MotionBlur`'s default.
   */
  maxBlur?: number;
  /**
   * How many sub-frames over the open shutter the frame is the mean of (the shot tool's kept frames), 1 to 4096.
   * Default 1: one frame drawn with its motion blur centred on its velocity. With more, `velocity` is the last
   * sub-frame's (the shot tool records it so), and a moving surface's trail over the shutter lies behind it, which
   * `shimmerMoving`'s blur reach follows (KB-SCATTER-FRINGEVEL1).
   */
  subframes?: number;
}

function sampleLuma(y: Float32Array, width: number, height: number, x: number, v: number): number {
  const px = Math.min(width - 1, Math.max(0, x)),
    py = Math.min(height - 1, Math.max(0, v)),
    x0 = Math.floor(px),
    y0 = Math.floor(py),
    x1 = Math.min(width - 1, x0 + 1),
    y1 = Math.min(height - 1, y0 + 1),
    fx = px - x0,
    fy = py - y0;
  return (
    (y[y0 * width + x0] * (1 - fx) + y[y0 * width + x1] * fx) * (1 - fy) +
    (y[y1 * width + x0] * (1 - fx) + y[y1 * width + x1] * fx) * fy
  );
}

/**
 * Whether `value` lies more than `threshold` outside [min, max] of the four pixels of `y` around (x, v), the taps a
 * bilinear read there blends (those it gives weight). A sharp edge that the warp lands between two pixels can read as any blend of them, so a
 * value inside their range is resampling, not a temporal change; the range test is the neighbourhood clamp of temporal
 * anti-aliasing (B. Karis, "High Quality Temporal Supersampling", SIGGRAPH Advances in Real-Time Rendering, 2014;
 * M. Salvi, "An Excursion in Temporal Supersampling", GDC 2016), applied to the reprojection's own four taps.
 */
function outsideTaps(
  y: Float32Array,
  width: number,
  height: number,
  x: number,
  v: number,
  value: number,
  threshold: number,
): boolean {
  const px = Math.min(width - 1, Math.max(0, x)),
    py = Math.min(height - 1, Math.max(0, v)),
    x0 = Math.floor(px),
    y0 = Math.floor(py),
    // A tap the read gives no weight (the point on a pixel's row or column) is not a neighbour of the reprojection.
    x1 = px > x0 ? Math.min(width - 1, x0 + 1) : x0,
    y1 = py > y0 ? Math.min(height - 1, y0 + 1) : y0,
    t00 = y[y0 * width + x0],
    t10 = y[y0 * width + x1],
    t01 = y[y1 * width + x0],
    t11 = y[y1 * width + x1];
  return value < Math.min(t00, t10, t01, t11) - threshold || value > Math.max(t00, t10, t01, t11) + threshold;
}

/**
 * T4 while moving: frame n is warped onto n + 1 by its motion (`reprojectionMotion` makes it from the depth and the two
 * view-projections), and the percent of pixels whose luma falls more than `threshold` (6 codes) outside [min, max] of
 * the four pixels of the next frame around where it lands is the shimmer (see `outsideTaps`: a blend of those four is
 * the warp resampling an edge, not a change). Pixels whose target leaves the frame are not counted. With `velocity`,
 * a pixel a moving surface's motion blur reaches is left out too (`blurReach`: McGuire, Hennessy, Bukowski and Osman
 * 2012 tile-max, capped at `maxBlur`), and with `nextVelocity` and `back` a pixel landing where the next frame's
 * movers smear, counted in `detail.blurred`.
 * @throws RangeError for a shutter not more than 0 and up to 360 degrees, a maxBlur not 1 to 128 pixels, or subframes
 * not a whole number from 1 to 4096.
 */
export function shimmerMoving(
  frame: LookImage,
  { next, motion, back, velocity, nextVelocity, shutter = 180, maxBlur = 32, subframes = 1 }: MovingFrames,
  { mask, bound, threshold = 6 }: FlickerOptions & { threshold?: number } = {},
): LookResult {
  const { width, height } = frame;
  sameSize(frame, next, 'next frame');
  sameSize(frame, motion, 'motion');
  if (motion.data.length !== width * height * 2)
    throw rangeError('The motion holds two floats (x, y) per pixel', 'headless');
  if (back) {
    sameSize(frame, back, 'back motion');
    if (back.data.length !== width * height * 2)
      throw rangeError('The back motion holds two floats (x, y) per pixel', 'headless');
  }
  for (const [name, field] of [
    ['velocity', velocity],
    ['next velocity', nextVelocity],
  ] as const) {
    if (!field) continue;
    sameSize(frame, field, name);
    if (field.data.length !== width * height * 2)
      throw rangeError(`The ${name} holds two floats (x, y) per pixel`, 'headless');
  }
  if (!(shutter > 0 && shutter <= 360))
    throw rangeError('The shutter is more than 0 and up to 360 degrees', 'headless');
  if (!(maxBlur >= 1 && maxBlur <= 128)) throw rangeError('maxBlur is 1 to 128 pixels', 'headless');
  if (!(Number.isInteger(subframes) && subframes >= 1 && subframes <= 4096))
    throw rangeError('subframes is a whole number from 1 to 4096', 'headless');
  const a = luma(frame),
    b = luma(next),
    inside = maskBits(frame, mask, 'shimmerMoving'),
    reach = velocity ? blurReach(motion, velocity, shutter / 360, maxBlur, subframes) : undefined,
    // The next frame's smear the same way, its camera motion the back motion turned round (each of its pixels moved
    // back here, so forward by the opposite): a pixel landing in a mover's trail there changes on purpose too.
    reachNext =
      nextVelocity && back
        ? blurReach({ width, height, data: back.data.map((d) => -d) }, nextVelocity, shutter / 360, maxBlur, subframes)
        : undefined;
  let count = 0,
    off = 0,
    occluded = 0,
    animated = 0,
    blurred = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!inside[i]) continue;
      const tx = x + motion.data[i * 2],
        ty = y + motion.data[i * 2 + 1];
      if (!(tx >= 0 && ty >= 0 && tx <= width - 1 && ty <= height - 1)) continue;
      if (back && occludedAt(motion.data[i * 2], motion.data[i * 2 + 1], back, tx, ty)) {
        occluded++;
        continue;
      }
      if (
        (velocity && animatedAt(motion.data[i * 2], motion.data[i * 2 + 1], velocity, x, y)) ||
        (nextVelocity && animatedAt(motion.data[i * 2], motion.data[i * 2 + 1], nextVelocity, tx, ty))
      ) {
        animated++;
        continue;
      }
      if ((reach && reach[i]) || (reachNext && reachNext[Math.round(ty) * width + Math.round(tx)])) {
        blurred++;
        continue;
      }
      count++;
      if (outsideTaps(b, width, height, tx, ty, a[i], threshold)) off++;
    }
  return result('shimmerMoving', percent(off, count), bound, {
    pixels: count,
    off,
    ...(back ? { occluded } : {}),
    ...(velocity || nextVelocity ? { animated } : {}),
    ...(velocity ? { blurred } : {}),
  });
}

/**
 * The pixels a moving surface's motion blur smears over: 1 where a surface the engine moves other than the camera
 * (|v - f| > 0.5 px, as `animatedAt`) smears over a pixel whose own surface moves otherwise (their velocities more than
 * half a pixel apart). The smear is drawn in screen space, so it follows the mover's whole velocity, the camera's part
 * included: a leaf near the lens moving 63 px a frame, 10 px of it its sway, smears 31 px over the still sky behind it
 * at 180 degrees (KB-SCATTER-FRINGEVEL1). A frame drawn once is blurred centred on its velocity, half its travel over
 * the open shutter (`share` of the frame) each way, at most `maxBlur`, the radius `MotionBlur` draws. A frame that is
 * the mean of `subframes` sub-frames, each at the middle of its slice of the shutter, holds the last sub-frame's
 * velocity, so the trail runs back from there over its travel between the first and last sub-frame, plus each
 * sub-frame's own blur over its slice (half a slice's travel, at most `maxBlur`) at either end. The search is the
 * reconstruction filter's (M. McGuire, P. Hennessy, M. Bukowski and B. Osman, "A Reconstruction Filter for Plausible
 * Motion Blur", I3D 2012, https://doi.org/10.1145/2159616.2159639): the longest trail per tile, the longest over each
 * tile's 3 x 3 neighbours, then a walk along that one, one sample per pixel each way; a pixel is in reach when a moving
 * sample's trail on that side covers the distance to it. Tiles are the longest trail across, at least `maxBlur` and at
 * most 128 pixels, and no trail is taken longer than a tile, so no pixel beyond the smear the frame holds is left out.
 */
function blurReach(
  motion: LookMotion,
  velocity: LookMotion,
  share: number,
  maxBlur: number,
  subframes: number,
): Uint8Array {
  const { width, height } = motion,
    n = width * height,
    behind = new Float32Array(n),
    ahead = new Float32Array(n),
    moving = new Uint8Array(n),
    out = new Uint8Array(n),
    v = velocity.data;
  // Each mover's trail behind it and ahead of it, along its screen velocity.
  let longest = 0;
  for (let i = 0; i < n; i++) {
    const dx = v[i * 2] - motion.data[i * 2],
      dy = v[i * 2 + 1] - motion.data[i * 2 + 1];
    if (!(dx * dx + dy * dy > 0.25)) continue;
    const travel = Math.hypot(v[i * 2], v[i * 2 + 1]) * share,
      blur = Math.min(travel / (2 * subframes), maxBlur);
    moving[i] = 1;
    ahead[i] = blur;
    behind[i] = (travel * (subframes - 1)) / subframes + blur;
    if (behind[i] > longest) longest = behind[i];
  }
  const k = Math.ceil(Math.min(128, Math.max(maxBlur, longest))),
    tw = Math.ceil(width / k),
    th = Math.ceil(height / k),
    tiles = new Float32Array(tw * th * 2),
    near = new Float32Array(tw * th * 2);
  const keep = (into: Float32Array, j: number, x: number, y: number) => {
    if (x * x + y * y > into[j * 2] ** 2 + into[j * 2 + 1] ** 2) {
      into[j * 2] = x;
      into[j * 2 + 1] = y;
    }
  };
  for (let i = 0; i < n; i++) {
    if (!moving[i]) continue;
    behind[i] = Math.min(behind[i], k);
    const l = Math.hypot(v[i * 2], v[i * 2 + 1]),
      x = i % width,
      y = (i - x) / width;
    // A mover the camera holds still on screen (its sway cancels the camera's) smears nowhere.
    if (!(l > 0)) continue;
    const r = Math.max(behind[i], ahead[i]) / l;
    keep(tiles, Math.floor(y / k) * tw + Math.floor(x / k), v[i * 2] * r, v[i * 2 + 1] * r);
  }
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++)
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const sx = tx + ox,
            sy = ty + oy;
          if (sx < 0 || sy < 0 || sx >= tw || sy >= th) continue;
          const j = sy * tw + sx;
          keep(near, ty * tw + tx, tiles[j * 2], tiles[j * 2 + 1]);
        }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const t = Math.floor(y / k) * tw + Math.floor(x / k),
        vx = near[t * 2],
        vy = near[t * 2 + 1],
        l = Math.hypot(vx, vy);
      if (l < 0.5) continue;
      const p = y * width + x,
        px = v[p * 2],
        py = v[p * 2 + 1],
        steps = Math.ceil(l);
      for (let s = -steps; s <= steps && !out[p]; s++) {
        const qx = Math.round(x + (vx * s) / steps),
          qy = Math.round(y + (vy * s) / steps);
        if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
        const q = qy * width + qx;
        if (!moving[q]) continue;
        const wx = v[q * 2],
          wy = v[q * 2 + 1];
        // A mover's smear over a surface moving with it changes nothing there.
        if (!((wx - px) ** 2 + (wy - py) ** 2 > 0.25)) continue;
        const dx = x - qx,
          dy = y - qy,
          side = dx * wx + dy * wy <= 0 ? behind[q] : ahead[q];
        if (dx * dx + dy * dy <= (side + 0.5) ** 2) out[p] = 1;
      }
    }
  return out;
}

/**
 * A pixel the camera moves by (fx, fy) moves on purpose when the engine moved the surface at (tx, ty) of `velocity`'s
 * frame by more than half a pixel otherwise (its own velocity, read at the nearest pixel as the back motion is).
 */
function animatedAt(fx: number, fy: number, velocity: LookMotion, tx: number, ty: number): boolean {
  const j = Math.round(ty) * velocity.width + Math.round(tx);
  return (velocity.data[j * 2] - fx) ** 2 + (velocity.data[j * 2 + 1] - fy) ** 2 > 0.25;
}

/**
 * The forward-backward consistency test of optical flow: a pixel moved by (fx, fy) to (tx, ty) in the next frame is
 * covered or uncovered there when the next frame's motion back from that point does not bring it home,
 * |f + b|^2 > 0.01 (|f|^2 + |b|^2) + 0.5 in pixels (N. Sundaram, T. Brox and K. Keutzer, "Dense point trajectories by
 * GPU-accelerated large displacement optical flow", ECCV 2010, https://doi.org/10.1007/978-3-642-15549-9_32; the
 * occlusions of D. J. Butler, J. Wulff, G. B. Stanley and M. J. Black, "A naturalistic open source movie for optical
 * flow evaluation", ECCV 2012, https://doi.org/10.1007/978-3-642-33783-3_44). The back motion is read at the nearest
 * pixel: blending across a depth edge would make a motion no surface has.
 */
function occludedAt(fx: number, fy: number, back: LookMotion, tx: number, ty: number): boolean {
  const j = Math.round(ty) * back.width + Math.round(tx),
    bx = back.data[j * 2],
    by = back.data[j * 2 + 1];
  return (fx + bx) ** 2 + (fy + by) ** 2 > 0.01 * (fx * fx + fy * fy + bx * bx + by * by) + 0.5;
}

/** Inverse of a column-major 4 x 4 matrix, or undefined when it is singular. */
function invert4(m: ArrayLike<number>): Float64Array | undefined {
  const a = Array.from({ length: 16 }, (_, k) => m[k]),
    inv = new Float64Array(16);
  const s = [
    a[0] * a[5] - a[4] * a[1],
    a[0] * a[6] - a[4] * a[2],
    a[0] * a[7] - a[4] * a[3],
    a[1] * a[6] - a[5] * a[2],
    a[1] * a[7] - a[5] * a[3],
    a[2] * a[7] - a[6] * a[3],
  ];
  const c = [
    a[8] * a[13] - a[12] * a[9],
    a[8] * a[14] - a[12] * a[10],
    a[8] * a[15] - a[12] * a[11],
    a[9] * a[14] - a[13] * a[10],
    a[9] * a[15] - a[13] * a[11],
    a[10] * a[15] - a[14] * a[11],
  ];
  const det = s[0] * c[5] - s[1] * c[4] + s[2] * c[3] + s[3] * c[2] - s[4] * c[1] + s[5] * c[0];
  if (!det || !Number.isFinite(det)) return undefined;
  const d = 1 / det;
  inv[0] = (a[5] * c[5] - a[6] * c[4] + a[7] * c[3]) * d;
  inv[1] = (-a[1] * c[5] + a[2] * c[4] - a[3] * c[3]) * d;
  inv[2] = (a[13] * s[5] - a[14] * s[4] + a[15] * s[3]) * d;
  inv[3] = (-a[9] * s[5] + a[10] * s[4] - a[11] * s[3]) * d;
  inv[4] = (-a[4] * c[5] + a[6] * c[2] - a[7] * c[1]) * d;
  inv[5] = (a[0] * c[5] - a[2] * c[2] + a[3] * c[1]) * d;
  inv[6] = (-a[12] * s[5] + a[14] * s[2] - a[15] * s[1]) * d;
  inv[7] = (a[8] * s[5] - a[10] * s[2] + a[11] * s[1]) * d;
  inv[8] = (a[4] * c[4] - a[5] * c[2] + a[7] * c[0]) * d;
  inv[9] = (-a[0] * c[4] + a[1] * c[2] - a[3] * c[0]) * d;
  inv[10] = (a[12] * s[4] - a[13] * s[2] + a[15] * s[0]) * d;
  inv[11] = (-a[8] * s[4] + a[9] * s[2] - a[11] * s[0]) * d;
  inv[12] = (-a[4] * c[3] + a[5] * c[1] - a[6] * c[0]) * d;
  inv[13] = (a[0] * c[3] - a[1] * c[1] + a[2] * c[0]) * d;
  inv[14] = (-a[12] * s[3] + a[13] * s[1] - a[14] * s[0]) * d;
  inv[15] = (a[8] * s[3] - a[9] * s[1] + a[10] * s[0]) * d;
  return inv;
}

/**
 * The motion of every pixel of a still world seen by a moving camera: each pixel's depth (NDC z, in the convention of the
 * matrices) takes it back to the world by the inverse of `viewProjection`, and `nextViewProjection` takes it forward to
 * where it lands in the next frame. Column-major matrices. Pixels with no depth (`NaN`) move by 0.
 * @throws RangeError for a singular matrix or a depth that is not `width * height` floats.
 */
export function reprojectionMotion(
  depth: Float32Array,
  viewProjection: ArrayLike<number>,
  nextViewProjection: ArrayLike<number>,
  width: number,
  height: number,
): LookMotion {
  if (depth.length !== width * height) throw rangeError('The depth holds one float per pixel', 'headless');
  const inv = invert4(viewProjection);
  if (!inv) throw rangeError('The view-projection is singular', 'headless');
  const out = new Float32Array(width * height * 2),
    n = nextViewProjection;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        z = depth[i];
      if (!Number.isFinite(z)) continue;
      const px = ((x + 0.5) / width) * 2 - 1,
        py = 1 - ((y + 0.5) / height) * 2,
        wx = inv[0] * px + inv[4] * py + inv[8] * z + inv[12],
        wy = inv[1] * px + inv[5] * py + inv[9] * z + inv[13],
        wz = inv[2] * px + inv[6] * py + inv[10] * z + inv[14],
        ww = inv[3] * px + inv[7] * py + inv[11] * z + inv[15],
        ox = wx / ww,
        oy = wy / ww,
        oz = wz / ww,
        cx = n[0] * ox + n[4] * oy + n[8] * oz + n[12],
        cy = n[1] * ox + n[5] * oy + n[9] * oz + n[13],
        cw = n[3] * ox + n[7] * oy + n[11] * oz + n[15];
      if (!(cw > 0)) continue;
      out[i * 2] = ((cx / cw + 1) / 2) * width - 0.5 - x;
      out[i * 2 + 1] = ((1 - cy / cw) / 2) * height - 0.5 - y;
    }
  return { width, height, data: out };
}

/**
 * The NDC depth of every pixel of a frame from its distance to the eye, in the convention of `viewProjection`, for
 * {@link reprojectionMotion}: the pixel's ray (the line through the unprojected points at depth 0 and 1, pointing away
 * from `eye`) is walked `distance` metres from `eye` and the point is projected back. A pixel with no distance (not
 * finite or not above 0) takes `options`: where `water` is 128 or more its ray meets the plane y = `plane` (the sea
 * level), and any other pixel is `far` metres away (a sky); with neither it gives `NaN` (no depth). Column-major matrix.
 * @throws RangeError for a singular matrix, an eye that is not 3 numbers or a distance that is not `width * height` floats.
 */
export function depthFromDistance(
  distance: ArrayLike<number>,
  eye: ArrayLike<number>,
  viewProjection: ArrayLike<number>,
  width: number,
  height: number,
  options: { water?: ArrayLike<number>; plane?: number; far?: number } = {},
): Float32Array {
  if (distance.length !== width * height) throw rangeError('The distance holds one float per pixel', 'headless');
  if (eye.length !== 3 || !Array.from(eye).every(Number.isFinite))
    throw rangeError('The eye is three numbers', 'headless');
  const inv = invert4(viewProjection);
  if (!inv) throw rangeError('The view-projection is singular', 'headless');
  const m = viewProjection,
    out = new Float32Array(width * height).fill(Number.NaN),
    unproject = (px: number, py: number, z: number) => {
      const w = inv[3] * px + inv[7] * py + inv[11] * z + inv[15];
      return [
        (inv[0] * px + inv[4] * py + inv[8] * z + inv[12]) / w,
        (inv[1] * px + inv[5] * py + inv[9] * z + inv[13]) / w,
        (inv[2] * px + inv[6] * py + inv[10] * z + inv[14]) / w,
      ];
    };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        known = distance[i] > 0 && Number.isFinite(distance[i]),
        wet = !known && options.plane !== undefined && options.water !== undefined && options.water[i] >= 128;
      if (!known && !wet && options.far === undefined) continue;
      const px = ((x + 0.5) / width) * 2 - 1,
        py = 1 - ((y + 0.5) / height) * 2,
        a = unproject(px, py, 0),
        b = unproject(px, py, 1);
      let dx = b[0] - a[0],
        dy = b[1] - a[1],
        dz = b[2] - a[2];
      if (dx * (a[0] - eye[0]) + dy * (a[1] - eye[1]) + dz * (a[2] - eye[2]) < 0) (dx = -dx), (dy = -dy), (dz = -dz);
      const length = Math.hypot(dx, dy, dz);
      let d = distance[i];
      if (!known) {
        const t = wet ? ((options.plane as number) - eye[1]) / (dy / length) : Number.NaN;
        d = t > 0 && Number.isFinite(t) ? t : (options.far ?? Number.NaN);
        if (!(d > 0)) continue;
      }
      const wx = eye[0] + (dx / length) * d,
        wy = eye[1] + (dy / length) * d,
        wz = eye[2] + (dz / length) * d,
        cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
      out[i] = (m[2] * wx + m[6] * wy + m[10] * wz + m[14]) / cw;
    }
  return out;
}

/**
 * T8: of the edge centres of pixels moving more than `minimum` (8) pixels a frame, the percent whose edge is narrower
 * than half the smear the shutter gives them: strobing spray, rain or debris. A shutter of `shutter` degrees (default
 * 180) is open for shutter / 360 of the frame interval, so it smears an edge across that share of its travel to the
 * next frame: half the travel at 180 degrees, and the check calls an edge sharp under a quarter of it
 * (KB-LOOK-TV-MOTIONBLUR1: the whole travel was taken as the smear, so a correct 180 degree frame read as sharp).
 * An edge centre is a pixel whose luma profile along its motion (one travel wide, centred on it, spanning over 24 codes)
 * crosses the middle value within one pixel of the pixel itself; the edge's width is the run of the profile round that
 * crossing between 10 and 90 percent of its range. A hard edge is under a pixel wide, a blurred one as wide as its smear.
 * A mover narrower than its smear ramps over its own width however well it is blurred, so for one the ramp plus the
 * plateau it holds before coming back is its smear, judged at the same share (`edgeSpan`, KB-LOOK-TV-MBNARROW1).
 * With `velocity` (the engine's own motion of each pixel, as `MovingFrames.velocity`) each pixel's travel is its
 * surface's real motion, not the camera's alone: a leaf swaying against the camera's sweep moves less than the camera
 * moves the place it covers, and is smeared by what it moves (KB-LOOK-TV-MBVEL1).
 * An edge whose ramp is a staircase of sharp copies (`stepped`, one per sub-frame) is sharp too (KB-LOOK-TV-SUBSTEP1).
 * @throws RangeError for a shutter that is not more than 0 and up to 360 degrees.
 */
export function motionBlur(
  frame: LookImage,
  motion: LookMotion,
  {
    mask,
    bound,
    minimum = 8,
    shutter = 180,
    velocity,
  }: FlickerOptions & { minimum?: number; shutter?: number; velocity?: LookMotion } = {},
): LookResult {
  const { width, height } = frame;
  sameSize(frame, motion, 'motion');
  if (motion.data.length !== width * height * 2)
    throw rangeError('The motion holds two floats (x, y) per pixel', 'headless');
  if (velocity) {
    sameSize(frame, velocity, 'velocity');
    if (velocity.data.length !== width * height * 2)
      throw rangeError('The velocity holds two floats (x, y) per pixel', 'headless');
  }
  const travelled = velocity ?? motion;
  if (!(shutter > 0 && shutter <= 360))
    throw rangeError('The shutter is more than 0 and up to 360 degrees', 'headless');
  const smear = shutter / 360;
  const y = luma(frame),
    inside = maskBits(frame, mask, 'motionBlur');
  let edges = 0,
    sharp = 0;
  for (let row = 0; row < height; row++)
    for (let x = 0; x < width; x++) {
      const i = row * width + x;
      if (!inside[i]) continue;
      const mx = travelled.data[i * 2],
        my = travelled.data[i * 2 + 1],
        travel = Math.hypot(mx, my);
      if (!(travel > minimum)) continue;
      const steps = Math.ceil(travel) * 2,
        spacing = travel / steps,
        profile: number[] = [];
      for (let s = -steps / 2; s <= steps / 2; s++)
        profile.push(sampleLuma(y, width, height, x + (mx * s) / steps, row + (my * s) / steps));
      const low = Math.min(...profile),
        high = Math.max(...profile);
      if (high - low <= 24) continue;
      const mid = (low + high) / 2;
      let cross = -1;
      for (let k = 1; k < profile.length && cross < 0; k++) if (profile[k - 1] < mid !== profile[k] < mid) cross = k;
      if (cross < 0 || Math.abs(cross - 0.5 - steps / 2) * spacing > 1) continue;
      edges++;
      const from = low + 0.1 * (high - low),
        to = high - 0.1 * (high - low),
        { ramp, span } = edgeSpan(profile, spacing, from, to, cross);
      // A wide edge's 10 to 90 percent ramp is 0.8 of its smear and is sharp under half of it; a mover narrower than
      // its smear ramps over its own width and holds a plateau, its ramp plus plateau spanning the whole smear, so it is
      // sharp under 0.625 of it, the same share (KB-LOOK-TV-MBNARROW1).
      const length = travel * smear,
        short = ramp < length / 2 && span < length * 0.625;
      if (short || stepped(profile, spacing, from, to, cross)) sharp++;
    }
  return result('motionBlur', percent(sharp, edges), bound, { edges, sharp });
}

/**
 * The edge's own 10 to 90 percent ramp (the run of the profile between `from` and `to` round its crossing at `cross`;
 * a short mover's far edge in the same profile is not this edge's, KB-LOOK-TV-MBNARROW1), and the smear of a mover
 * narrower than its smear, or 0 when the profile is not one. A bar of width w
 * smeared over a length L > w (the sub-frames' travel over the open shutter) climbs over w, holds a plateau of L - w at
 * w / L of its contrast and comes back: its 10 to 90 percent ramp is 0.8 w, however well it is blurred, and its ramp
 * plus the plateau beyond 90 percent is L (0.8 w + L - w + 0.2 w). So the edge's ramp around its crossing at `cross`
 * plus the run past `to` (or under `from`) that comes back toward the middle inside the profile is the smear. A ramp
 * under 1.6 pixels (a climb of under 2 pixels) is a sharp edge, whatever lies behind it: a sharp bar is a hard climb
 * and its own width of plateau, and a mover under 2 pixels wide smeared into a streak cannot be told from a sharp
 * line of the same length, so neither counts as smeared here and both are judged by their ramp.
 */
function edgeSpan(
  profile: number[],
  spacing: number,
  from: number,
  to: number,
  cross: number,
): { ramp: number; span: number } {
  const within = (k: number) => profile[k] > from && profile[k] < to;
  let first = within(cross) ? cross : cross - 1,
    last = first;
  // A hard edge: the crossing falls between two samples, neither inside the band.
  if (!within(first)) return { ramp: 0, span: 0 };
  while (first > 0 && within(first - 1)) first--;
  while (last < profile.length - 1 && within(last + 1)) last++;
  const ramp = (last - first + 1) * spacing;
  if (ramp < 1.6) return { ramp, span: 0 };
  // The run outside the ramp on one side, and whether the profile comes back toward the middle after it.
  const plateau = (start: number, step: number): number => {
    if (start < 0 || start >= profile.length) return 0;
    const high = profile[start] >= to;
    let k = start;
    while (k + step >= 0 && k + step < profile.length && profile[k + step] >= to === high && !within(k + step))
      k += step;
    const after = k + step;
    return after >= 0 && after < profile.length ? (Math.abs(k - start) + 1) * spacing : 0;
  };
  const held = Math.max(plateau(last + 1, 1), plateau(first - 1, -1));
  return { ramp, span: held > 0 ? ramp + held : 0 };
}

/**
 * Whether a smeared edge's ramp is a staircase: copies of a sharp edge, one per sub-frame, instead of one smear
 * (KB-LOOK-TV-SUBSTEP1). Over the ramp (the run of the profile between `from` and `to` around the edge's crossing at
 * `cross`, at least 8 pixels long) a smear climbs evenly, or steepest once in its middle; a staircase climbs in separate jumps with flat
 * steps between, all one way (a fall of over 12 codes against the ramp's way makes it texture or a thin object, not
 * one edge). Read one pixel apart at every sample, a jump is a climb over 12 codes and over twice the ramp's mean climb (its 10 to
 * 90 percent span over its length), and jumps are separate when a climb under the mean lies between them. Three or more
 * is a staircase.
 */
function stepped(profile: number[], spacing: number, from: number, to: number, cross: number): boolean {
  const within = (k: number) => profile[k] > from && profile[k] < to;
  let first = within(cross) ? cross : cross - 1,
    last = first;
  if (!within(first)) return false;
  while (first > 0 && within(first - 1)) first--;
  while (last < profile.length - 1 && within(last + 1)) last++;
  // The ramp's length counts its end samples, as `edgeSpan` does (a narrow mover's 8 px ramp read 7.5 px).
  const length = (last - first + 1) * spacing;
  if (length < 8) return false;
  const per = Math.max(1, Math.round(1 / spacing)),
    mean = (to - from) / length;
  const sign = Math.sign(profile[last] - profile[first]);
  let jumps = 0,
    flat = true;
  // Slid one sample at a time: a jump that falls between two pixel-apart reads is two half jumps, neither counted.
  for (let k = Math.max(0, first - per); k + per <= Math.min(profile.length - 1, last + per); k++) {
    const climb = sign * (profile[k + per] - profile[k]);
    if (climb < -12) return false;
    if (climb > 12 && climb > 2 * mean) {
      if (flat) jumps++;
      flat = false;
    } else if (climb < mean) flat = true;
  }
  return jumps >= 3;
}
