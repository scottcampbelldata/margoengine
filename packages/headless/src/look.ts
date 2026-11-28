// Look checks for rendered frames: pure functions over 8-bit sRGB frames, float frames and grey masks, each giving a
// value and a pass against a bound, so a shot's probe frames are reviewed as one page (a contact sheet and a table)
// instead of by eye frame by frame. No node: imports and no GPU: they run in Node, a worker or a page.
//
// Sources (clean room, from the papers only; full list with links in docs/clean-room.md, "headless/look"):
// - Perceptual difference: P. Andersson, J. Nilsson, T. Akenine-Moller, M. Oskarsson, K. Astrom, M. D. Fairchild,
//   "FLIP: A Difference Evaluator for Alternating Images", Proc. ACM Comput. Graph. Interact. Tech. 3(2) (2020).
//   YyCxCz from Flohr et al. (1993); HyAB from Abasi, Amani Tehran and Fairchild (2020).
// - HDR difference: P. Andersson, J. Nilsson, P. Shirley, T. Akenine-Moller, "Visualizing Errors in Rendered High
//   Dynamic Range Images", Eurographics 2021 Short Papers, https://doi.org/10.2312/egs.20211015.
// - Grain: J. Immerkaer, "Fast Noise Variance Estimation", CVIU 64(2) (1996).
// - Speckle: impulse detection by local order statistics, Hwang and Haddad, "Adaptive median filters" (1995).
// - Banding: steps between flat runs, after Tandon et al., "CAMBI" (2021) and Tu et al., "BBAND" (2020).
// - Block periodicity: Wang, Bovik and Evans, "Blind measurement of blocking artifacts in images" (2000).
// - Edge hardness: edge width between extrema, Marziliano et al., "A no-reference perceptual blur metric" (2002).
// - Light discs: connected components, Rosenfeld and Pfaltz (1966).
// - Flicker: frame mean brightness changes, Guthier et al. (2011); Eilertsen et al. (2013).
// - Luma: ITU-R BT.709 coefficients on the encoded values; sRGB curve from IEC 61966-2-1.
// - Mixed pixels at mask edges (T6 ground means over the masks' interiors): P. Fisher, "The pixel: a snare and a
//   delusion", Int. J. Remote Sensing 18(3) (1997).
import type { HeadlessPixels } from './index.js';
import { decodePNG } from './compare.js';
import { rangeError, typeError } from '../../shared/errors.js';

/** An 8-bit sRGB frame: RGBA, straight alpha, top row first, as `readPixels` and `decodePNG` give. */
export type LookImage = HeadlessPixels;

/** A mask: one byte per pixel, or RGBA where the first channel counts. 128 and above is inside. */
export interface LookMask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A float frame, RGBA: `Float32Array`, or `Uint16Array` of half-float bits as an `rgba16float` readback holds them. */
export interface FloatFrame {
  width: number;
  height: number;
  data: Float32Array | Uint16Array;
}

/** A bound from a shot file's `lookBounds`: a number is the largest value that passes, `[low, high]` a range. */
export type LookBound = number | readonly [number, number];

/** The name of a look check, as `lookBounds` names it. */
export type LookCheckName =
  | 'skyClip'
  | 'grain'
  | 'speckle'
  | 'banding'
  | 'flat'
  | 'blocks'
  | 'horizonSeam'
  | 'waterSeam'
  | 'lights'
  | 'foamEdges'
  | 'crush'
  | 'flicker'
  | 'shimmer'
  | 'nan'
  | 'backends'
  | 'reference'
  | 'penumbra'
  | 'penumbraPlants'
  | 'stairs'
  | 'colourEdges'
  | 'chromaSmear'
  | 'shimmerMoving'
  | 'motionBlur'
  | 'silhouette'
  | 'silhouetteShape'
  | 'bounce'
  | 'shadowTint'
  | 'nightLuma'
  | 'nightPeak';

/** What a check gives back. */
export interface LookResult {
  /** The check's name. */
  check: LookCheckName | string;
  /** The measured value, in `unit`. NaN when the check could not run (`missing`), which never passes. */
  value: number;
  /** `[low, high]`: the value passes when inside, ends included. */
  bound: [number, number];
  pass: boolean;
  unit: string;
  /** Set when the check could not run: what was missing. */
  missing?: string;
  /**
   * Set when the check ran over a mask with no pixels in it, so it measured nothing: for example `0 sky pixels` for
   * a shot with no sky in view. The row passes, and the report says what it measured, so the pass is never silent.
   */
  empty?: string;
  /**
   * The mask the check measured inside, by name, when {@link checkProbe} chose one: `sky` (the page's sky mask),
   * `sky-coverage` (the pixels `@margoengine/sky` drew, when there is no `sky` mask) or `frame` (the whole frame).
   * Set on `skyClip`; the report says which.
   */
  mask?: string;
  /** Further numbers the check measured, for the report. */
  detail: Record<string, number>;
}

/** Each check's default bound, its unit and what it measures. A shot's `lookBounds` replaces the bound by name. */
export const LOOK_CHECKS: Readonly<Record<LookCheckName, { bound: [number, number]; unit: string; about: string }>> =
  Object.freeze({
    skyClip: { bound: [0, 0.5], unit: '%', about: 'sky pixels with a channel at the clip level' },
    grain: { bound: [0, 1.5], unit: 'code', about: 'noise standard deviation (Immerkaer), in 8-bit codes' },
    speckle: { bound: [0, 50], unit: 'ppm', about: 'isolated pixels beyond all eight neighbours, per million' },
    banding: { bound: [0, 1], unit: '%', about: 'pixels in flat runs split by a step that skips a code' },
    flat: { bound: [0, 5], unit: '%', about: 'pixels at the centre of a constant 65 x 65 window, not black or white' },
    blocks: { bound: [0, 1], unit: '%', about: 'frame area in tiles with steps repeating at the block pitch' },
    horizonSeam: { bound: [0, 6], unit: 'code', about: 'luma step at the analytic horizon beyond its surroundings' },
    waterSeam: { bound: [0, 6], unit: 'code', about: 'luma step at the water line beyond its surroundings' },
    lights: { bound: [0, 1], unit: 'discs', about: 'bright discs, against the lights the scene shows' },
    foamEdges: { bound: [0, 35], unit: '%', about: 'strong edges at the foam that are 2 pixels wide or less' },
    crush: { bound: [0, 0.5], unit: '%', about: 'pixels at black outside the declared dark areas' },
    flicker: { bound: [0, 0.75], unit: 'code', about: 'largest jump of the mean luma off its trend, still camera' },
    shimmer: { bound: [0, 0.5], unit: '%', about: 'pixels jumping more than 6 codes off their trend, still camera' },
    nan: { bound: [0, 0], unit: 'pixels', about: 'pixels with a NaN or infinite channel in the float frame' },
    backends: { bound: [0, 0.03], unit: 'FLIP', about: 'mean FLIP difference of WebGPU against the compat layer' },
    reference: { bound: [0, 0.05], unit: 'FLIP', about: 'mean FLIP difference against the 16-sample reference' },
    penumbra: {
      bound: [0, 0.7],
      unit: 'code',
      about:
        'noise standard deviation inside the shadow penumbra on the ground (the penumbra mask less the plants mask)',
    },
    penumbraPlants: {
      bound: [0, 1],
      unit: 'ratio',
      about: 'grain of the plants inside the shadow penumbra over the grain of the plants outside it',
    },
    stairs: { bound: [0, 1], unit: '%', about: 'strong luma edges that are one pixel stair steps' },
    colourEdges: { bound: [0, 10], unit: '%', about: 'strong colour edges one pixel wide, which 4:2:0 smears' },
    chromaSmear: {
      bound: [0, 2],
      unit: '%',
      about: 'pixels whose colour moves visibly (CIE76 over 6) when the frame is cut to 4:2:0 chroma',
    },
    shimmerMoving: {
      bound: [0, 0.5],
      unit: '%',
      about: 'pixels off by over 6 codes after the camera motion is undone',
    },
    motionBlur: { bound: [0, 5], unit: '%', about: 'fast edges narrower than half their travel in a frame' },
    silhouette: { bound: [80, 100], unit: '%', about: 'subject outline with at least 15 L* against what is behind' },
    silhouetteShape: { bound: [70, 100], unit: '%', about: 'subject mask in one of three values at 320 x 180' },
    bounce: { bound: [10, 35], unit: '%', about: 'shadowed ground luminance as a share of the lit ground' },
    shadowTint: {
      bound: [3, 100],
      unit: 'b*',
      about: 'how much lower in b* the shadowed ground is than the lit ground',
    },
    nightLuma: { bound: [24, 255], unit: 'code', about: 'mean luma of a night frame' },
    nightPeak: { bound: [180, 255], unit: 'code', about: 'luma reached by the brightest 1% of a night frame' },
  });

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The `[low, high]` of a bound: a number is the high end, with no low end. */
export function lookBound(bound: LookBound): [number, number] {
  if (finite(bound)) return [-Infinity, bound];
  if (Array.isArray(bound) && bound.length === 2 && bound.every(finite) && bound[0] <= bound[1])
    return [bound[0], bound[1]];
  throw typeError('A look bound is a number or [low, high] with low <= high', 'headless');
}

function result(
  check: LookCheckName,
  value: number,
  bound: LookBound | undefined,
  detail: Record<string, number> = {},
): LookResult {
  const range = bound === undefined ? ([...LOOK_CHECKS[check].bound] as [number, number]) : lookBound(bound);
  return {
    check,
    value,
    bound: range,
    pass: value >= range[0] && value <= range[1],
    unit: LOOK_CHECKS[check].unit,
    detail,
  };
}

/** A row for a check that could not run, which fails: an asked-for check that did not run is not a pass. */
export function missingResult(check: LookCheckName | string, missing: string, bound?: LookBound): LookResult {
  const known = (LOOK_CHECKS as Record<string, { bound: [number, number]; unit: string }>)[check];
  return {
    check,
    value: Number.NaN,
    bound: bound === undefined ? ([...(known?.bound ?? [0, 0])] as [number, number]) : lookBound(bound),
    pass: false,
    unit: known?.unit ?? '',
    missing,
    detail: {},
  };
}

function checkImage(image: LookImage, what = 'frame'): void {
  if (!image || !(image.data instanceof Uint8Array) || !(image.width > 0) || !(image.height > 0))
    throw typeError(`The ${what} must be {width, height, data: Uint8Array}`, 'headless');
  if (image.data.length !== image.width * image.height * 4)
    throw rangeError(`The ${what}'s data does not match its size`, 'headless');
}

function sameSize(a: { width: number; height: number }, b: { width: number; height: number }, what: string): void {
  if (a.width !== b.width || a.height !== b.height)
    throw rangeError(
      `The ${what} is ${b.width} x ${b.height}, the frame ${a.width} x ${a.height}: they must match`,
      'headless',
    );
}

/** Inside flags of a mask, one per pixel, or all inside when no mask is given. */
function maskBits(frame: { width: number; height: number }, mask: LookMask | undefined, what: string): Uint8Array {
  const count = frame.width * frame.height,
    bits = new Uint8Array(count);
  if (!mask) return bits.fill(1);
  sameSize(frame, mask, `${what} mask`);
  const step = mask.data.length === count ? 1 : mask.data.length === count * 4 ? 4 : 0;
  if (!step) throw rangeError(`The ${what} mask holds one byte or four per pixel`, 'headless');
  for (let i = 0; i < count; i++) bits[i] = mask.data[i * step] >= 128 ? 1 : 0;
  return bits;
}

/** Luma of each pixel on 0 to 255: BT.709 weights on the encoded values. */
export function luma(image: LookImage): Float32Array {
  checkImage(image);
  const { data } = image,
    out = new Float32Array(image.width * image.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4)
    out[i] = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
  return out;
}

const percent = (part: number, whole: number) => (whole ? (100 * part) / whole : 0);

// ---------------------------------------------------------------------------------------------------------- Sky clip

/** Options of {@link skyClip}. */
export interface SkyClipOptions {
  /** The sky mask; the whole frame without one. */
  sky?: LookMask;
  /** A channel at or above this code is clipped. Default 254. */
  level?: number;
  bound?: LookBound;
}

/** Percent of the sky's pixels with a channel at the clip level. */
export function skyClip(frame: LookImage, { sky, level = 254, bound }: SkyClipOptions = {}): LookResult {
  checkImage(frame);
  const inside = maskBits(frame, sky, 'sky'),
    { data } = frame;
  let count = 0,
    clipped = 0;
  for (let i = 0; i < inside.length; i++) {
    if (!inside[i]) continue;
    count++;
    if (Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) >= level) clipped++;
  }
  const row = result('skyClip', percent(clipped, count), bound, { pixels: count, clipped });
  return count ? row : { ...row, empty: '0 sky pixels' };
}

// ------------------------------------------------------------------------------------------------- Grain and speckle

/** Options of {@link grain} and {@link speckle}. */
export interface RegionOptions {
  /** Only pixels whose 3 x 3 neighbourhood is inside this mask count; the whole frame without one. */
  mask?: LookMask;
  bound?: LookBound;
}

/** Inside flags of pixels whose whole 3 x 3 neighbourhood is inside, borders excluded. */
function interior(width: number, height: number, inside: Uint8Array): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++)
        for (let dx = -1; dx <= 1; dx++) if (!inside[(y + dy) * width + x + dx]) all = 0;
      out[y * width + x] = all;
    }
  return out;
}

/**
 * Noise standard deviation in 8-bit codes, by Immerkaer's estimator: the mean absolute response to the 3 x 3 mask
 * [1 -2 1; -2 4 -2; 1 -2 1], which is blind to flat areas, ramps and planes, times sqrt(pi / 2) / 6.
 */
export function grain(frame: LookImage, { mask, bound }: RegionOptions = {}): LookResult {
  const { width, height } = frame,
    y = luma(frame),
    use = interior(width, height, maskBits(frame, mask, 'grain'));
  let sum = 0,
    count = 0;
  for (let row = 1; row < height - 1; row++)
    for (let x = 1; x < width - 1; x++) {
      const i = row * width + x;
      if (!use[i]) continue;
      const up = i - width,
        down = i + width,
        response =
          y[up - 1] -
          2 * y[up] +
          y[up + 1] -
          2 * y[i - 1] +
          4 * y[i] -
          2 * y[i + 1] +
          y[down - 1] -
          2 * y[down] +
          y[down + 1];
      sum += Math.abs(response);
      count++;
    }
  const row = result('grain', count ? (Math.sqrt(Math.PI / 2) / 6) * (sum / count) : 0, bound, { pixels: count });
  return mask && !count ? { ...row, empty: '0 pixels inside the mask' } : row;
}

/** Options of {@link speckle}. */
export interface SpeckleOptions extends RegionOptions {
  /** A pixel this many codes above the brightest, or below the darkest, of its eight neighbours is a speckle. Default 24. */
  threshold?: number;
}

/** Isolated pixels, per million: brighter than all eight neighbours, or darker than all, by `threshold` codes. */
export function speckle(frame: LookImage, { mask, threshold = 24, bound }: SpeckleOptions = {}): LookResult {
  const { width, height } = frame,
    y = luma(frame),
    use = interior(width, height, maskBits(frame, mask, 'speckle'));
  let count = 0,
    speckles = 0;
  for (let row = 1; row < height - 1; row++)
    for (let x = 1; x < width - 1; x++) {
      const i = row * width + x;
      if (!use[i]) continue;
      count++;
      let low = Infinity,
        high = -Infinity;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const v = y[i + dy * width + dx];
          if (v < low) low = v;
          if (v > high) high = v;
        }
      if (y[i] >= high + threshold || y[i] <= low - threshold) speckles++;
    }
  return result('speckle', count ? (1e6 * speckles) / count : 0, bound, { pixels: count, speckles });
}

// ---------------------------------------------------------------------------------------------- Banding and flatness

/** Options of {@link banding}. */
export interface BandingOptions extends RegionOptions {
  /** Shortest flat run, in pixels, on each side of a step. Default 6. */
  minRun?: number;
  /** A step of more than this many luma codes skips a code. Default 1.5. */
  minStep?: number;
  /** Steps above this many codes are edges of things, not bands. Default 12. */
  maxStep?: number;
}

/**
 * Percent of pixels in banded runs: along every row and column, two neighbouring runs of identical pixels, each at
 * least `minRun` long, whose luma differs by more than one code and at most `maxStep`. A smooth 8-bit gradient steps
 * one code at a time and passes; the same gradient with too few levels skips codes between its flat runs, the gaps
 * in the gradient's histogram that show as bands. Dithered or textured areas have no long runs and pass.
 */
export function banding(frame: LookImage, options: BandingOptions = {}): LookResult {
  const { mask, minRun = 6, minStep = 1.5, maxStep = 12, bound } = options;
  const { width, height, data } = frame,
    y = luma(frame),
    inside = maskBits(frame, mask, 'banding'),
    banded = new Uint8Array(width * height),
    same = (a: number, b: number) =>
      data[a * 4] === data[b * 4] && data[a * 4 + 1] === data[b * 4 + 1] && data[a * 4 + 2] === data[b * 4 + 2];
  // One line of pixels: `count` pixels from `start`, `stride` apart.
  const line = (start: number, count: number, stride: number) => {
    let runStart = 0,
      previous = -1,
      previousLength = 0;
    for (let k = 1; k <= count; k++) {
      if (k < count && same(start + k * stride, start + (k - 1) * stride)) continue;
      const length = k - runStart;
      if (previous >= 0 && length >= minRun && previousLength >= minRun) {
        const step = Math.abs(y[start + runStart * stride] - y[start + previous * stride]);
        if (step > minStep && step <= maxStep) for (let m = previous; m < k; m++) banded[start + m * stride] = 1;
      }
      previous = runStart;
      previousLength = length;
      runStart = k;
    }
  };
  for (let row = 0; row < height; row++) line(row * width, width, 1);
  for (let x = 0; x < width; x++) line(x, height, width);
  let count = 0,
    bands = 0;
  for (let i = 0; i < inside.length; i++)
    if (inside[i]) {
      count++;
      bands += banded[i];
    }
  return result('banding', percent(bands, count), bound, { pixels: count, banded: bands });
}

/** Options of {@link flat}. */
export interface FlatOptions extends RegionOptions {
  /** Half the side of the constant window: 32 is a 65 x 65 window, wider than the one-code steps of a slow 8-bit
   * gradient, so a smooth sky is not flat. Default 32. */
  radius?: number;
}

/**
 * Percent of pixels at the centre of a window of identical pixels, leaving out black and white (the crush and clip
 * checks own those): an area with no variation at all, such as a missing texture or a fog that lost its detail.
 */
export function flat(frame: LookImage, { mask, radius = 32, bound }: FlatOptions = {}): LookResult {
  checkImage(frame);
  const { width, height, data } = frame,
    inside = maskBits(frame, mask, 'flat'),
    W = width + 1,
    // Summed-area tables of "differs from the right neighbour" and "differs from the one below".
    right = new Uint32Array(W * (height + 1)),
    below = new Uint32Array(W * (height + 1)),
    differs = (a: number, b: number) =>
      data[a * 4] !== data[b * 4] || data[a * 4 + 1] !== data[b * 4 + 1] || data[a * 4 + 2] !== data[b * 4 + 2] ? 1 : 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        h = x + 1 < width ? differs(i, i + 1) : 0,
        v = y + 1 < height ? differs(i, i + width) : 0,
        at = (y + 1) * W + x + 1;
      right[at] = h + right[at - 1] + right[at - W] - right[at - W - 1];
      below[at] = v + below[at - 1] + below[at - W] - below[at - W - 1];
    }
  const area = (table: Uint32Array, x0: number, y0: number, x1: number, y1: number) =>
    table[(y1 + 1) * W + x1 + 1] - table[y0 * W + x1 + 1] - table[(y1 + 1) * W + x0] + table[y0 * W + x0];
  let count = 0,
    flats = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!inside[i]) continue;
      count++;
      if (x < radius || y < radius || x + radius >= width || y + radius >= height) continue;
      const r = data[i * 4],
        g = data[i * 4 + 1],
        b = data[i * 4 + 2];
      if (Math.max(r, g, b) <= 2 || Math.min(r, g, b) >= 254) continue;
      if (
        !area(right, x - radius, y - radius, x + radius - 1, y + radius) &&
        !area(below, x - radius, y - radius, x + radius, y + radius - 1)
      )
        flats++;
    }
  return result('flat', percent(flats, count), bound, { pixels: count, flat: flats });
}

// --------------------------------------------------------------------------------------------------- Block pattern

/** Options of {@link blocks}. */
export interface BlocksOptions {
  /** The block size in pixels, for example the froxel tile of `@margoengine/environment`. Default 8. */
  pitch?: number;
  /** Neighbour differences, less one code, are capped at this many codes, so a few strong edges cannot pose as a
   * pattern. Default 8. */
  cap?: number;
  bound?: LookBound;
}

/** Periods per tile side in {@link blocks}, and how many of them the step phase must win. */
const PERIODS = 8,
  WINS = 7;

/**
 * Percent of the frame in tiles showing a block pattern at the pitch: a blocky image is a smooth one plus a step
 * signal at a known period (Wang, Bovik and Evans 2000). The frame is cut into tiles 8 pitches across. In each tile
 * and along each axis, every neighbour difference loses one code (the one-code steps of a smooth 8-bit gradient
 * never count), is capped, and is summed by its phase within the pitch and its period. A tile is blocky when one
 * phase holds more step energy than every other phase in at least 7 of the 8 periods, and on average a quarter code
 * more than they do. Random detail wins 7 of 8 periods with odds near 1 in 300,000 per phase; the edges of an object
 * or two fall in a few periods; a pattern at a divisor of the pitch ties between phases. Texture masks blocks here as
 * it does to the eye. Tiles with too few steps to say are counted as clear.
 */
export function blocks(frame: LookImage, { pitch = 8, cap = 8, bound }: BlocksOptions = {}): LookResult {
  if (!(Number.isInteger(pitch) && pitch >= 2))
    throw rangeError('The block pitch is a whole number of pixels from 2', 'headless');
  const { width, height } = frame,
    y = luma(frame),
    side = pitch * PERIODS,
    across = Math.floor(width / side),
    down = Math.floor(height / side),
    energy = new Float64Array(pitch * PERIODS);
  // Whether one tile is blocky along one axis, or null when it has too few steps to say.
  const blockyTile = (left: number, top: number, horizontal: boolean): boolean | null => {
    energy.fill(0);
    const [step, lineStep, last] = horizontal ? [1, width, width - 1 - left] : [width, 1, height - 1 - top];
    for (let line = 0; line < side; line++)
      for (let k = 0; k < Math.min(side, last); k++) {
        const i = top * width + left + line * lineStep + k * step;
        energy[(k % pitch) * PERIODS + Math.floor(k / pitch)] +=
          Math.min(cap, Math.max(0, Math.abs(y[i + step] - y[i]) - 1)) / side;
      }
    let total = 0,
      best = 0,
      bestSum = -1;
    for (let p = 0; p < pitch; p++) {
      let sum = 0;
      for (let k = 0; k < PERIODS; k++) sum += energy[p * PERIODS + k];
      total += sum;
      if (sum > bestSum) [best, bestSum] = [p, sum];
    }
    if (total / (pitch * PERIODS) < 0.02) return null;
    let wins = 0;
    for (let k = 0; k < PERIODS; k++) {
      let won = true;
      for (let p = 0; p < pitch && won; p++)
        if (p !== best && energy[p * PERIODS + k] >= energy[best * PERIODS + k]) won = false;
      if (won) wins++;
    }
    const excess = bestSum / PERIODS - (total - bestSum) / ((pitch - 1) * PERIODS);
    return wins >= WINS && excess >= 0.25;
  };
  let active = 0,
    blocky = 0;
  for (let ty = 0; ty < down; ty++)
    for (let tx = 0; tx < across; tx++) {
      const along = blockyTile(tx * side, ty * side, true),
        down2 = blockyTile(tx * side, ty * side, false);
      if (along === null && down2 === null) continue;
      active++;
      if (along || down2) blocky++;
    }
  return result('blocks', percent(blocky, across * down), bound, { tiles: across * down, active, blocky, pitch });
}

// ------------------------------------------------------------------------------------------------------------ Seams

/**
 * The analytic horizon: the row, per column, where horizontal planes vanish, from the camera's view-projection
 * (column-major, WebGPU clip space with y up). NaN in columns where the horizon is off the frame or the view looks
 * straight up or down. The horizon of every horizontal plane is one line, so no plane height is needed.
 */
export function horizonLine(viewProjection: ArrayLike<number>, width: number, height: number): Float32Array {
  if (viewProjection?.length !== 16) throw typeError('viewProjection is 16 numbers, column-major', 'headless');
  const m = (row: number, column: number) => viewProjection[column * 4 + row];
  // Images of the directions +x and +z (w = 0): their cross product is the vanishing line of the plane y = const.
  const p = [m(0, 0), m(1, 0), m(3, 0)],
    q = [m(0, 2), m(1, 2), m(3, 2)],
    l = [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]],
    out = new Float32Array(width).fill(Number.NaN);
  if (Math.abs(l[1]) < 1e-12 * (Math.abs(l[0]) + Math.abs(l[2]) + 1e-30)) return out;
  for (let x = 0; x < width; x++) {
    const ndcX = ((x + 0.5) / width) * 2 - 1,
      ndcY = -(l[0] * ndcX + l[2]) / l[1],
      row = ((1 - ndcY) / 2) * height;
    if (row >= 0 && row <= height) out[x] = row;
  }
  return out;
}

/** The first row, per column, where a mask turns inside going down: the top edge of the water is the water line. */
export function maskTopEdge(mask: LookMask): Float32Array {
  const bits = maskBits(mask, mask, 'edge'),
    out = new Float32Array(mask.width).fill(Number.NaN);
  for (let x = 0; x < mask.width; x++)
    for (let y = 0; y < mask.height; y++)
      if (bits[y * mask.width + x]) {
        if (y > 0) out[x] = y;
        break;
      }
  return out;
}

/**
 * The luma step at a line beyond the image's own gradient around it, in codes: per column, the largest one-row step
 * within a row of the line, less the mean one-row step 3 to 6 rows away on both sides; the median over columns. A
 * blended horizon or a smooth water line gives about 0; a hard seam gives its height.
 */
function seam(
  frame: LookImage,
  line: ArrayLike<number>,
  name: 'horizonSeam' | 'waterSeam',
  bound: LookBound | undefined,
  keep?: (x: number, row: number) => boolean,
): LookResult {
  const { width, height } = frame,
    y = luma(frame);
  if (line.length !== width) throw rangeError('The line gives one row per column of the frame', 'headless');
  const excess: number[] = [],
    step = (x: number, row: number) => Math.abs(y[row * width + x] - y[(row - 1) * width + x]);
  for (let x = 0; x < width; x++) {
    const at = line[x];
    if (!finite(at)) continue;
    const row = Math.round(at);
    if (row - 7 < 1 || row + 7 >= height || (keep && !keep(x, row))) continue;
    const here = Math.max(step(x, row - 1), step(x, row), step(x, row + 1));
    let around = 0;
    for (let d = 3; d <= 6; d++) around += step(x, row - d) + step(x, row + d);
    excess.push(Math.max(0, here - around / 8));
  }
  if (!excess.length) return result(name, 0, bound, { columns: 0 });
  excess.sort((a, b) => a - b);
  return result(name, excess[excess.length >> 1], bound, {
    columns: excess.length,
    p90: excess[Math.min(excess.length - 1, Math.floor(excess.length * 0.9))],
  });
}

/** Options of {@link horizonSeam}. */
export interface HorizonSeamOptions {
  /** The camera's view-projection at this frame, column-major. */
  viewProjection: ArrayLike<number>;
  /**
   * The sky mask: only columns with sky just above the line (3 rows up) count, where the horizon is in view. Without
   * it every column counts, whatever stands across the line. {@link checkProbe} runs the check only with one.
   */
  sky?: LookMask;
  bound?: LookBound;
}

/**
 * The seam at the analytic horizon ({@link horizonLine}): the luma step there beyond its surroundings, in codes, over
 * the columns where the sky meets the line. A wall, a mantel or a hill across the line is not a horizon: it has no sky
 * above it, so those columns are left out, and a frame with no sky at the line measures 0 over 0 columns.
 */
export function horizonSeam(frame: LookImage, { viewProjection, sky, bound }: HorizonSeamOptions): LookResult {
  const bits = sky ? maskBits(frame, sky, 'horizonSeam') : undefined;
  return seam(
    frame,
    horizonLine(viewProjection, frame.width, frame.height),
    'horizonSeam',
    bound,
    bits && ((x, row) => bits[(row - 3) * frame.width + x] === 1),
  );
}

/** Options of {@link waterSeam}. */
export interface WaterSeamOptions {
  /** The water mask: its top edge is the water line. */
  water: LookMask;
  bound?: LookBound;
}

/** The seam at the water line (the top edge of the water mask): the luma step there beyond its surroundings, in codes. */
export function waterSeam(frame: LookImage, { water, bound }: WaterSeamOptions): LookResult {
  return seam(frame, maskTopEdge(water), 'waterSeam', bound);
}

// ------------------------------------------------------------------------------------------------------- Light discs

/** Options of {@link lights}. */
export interface LightsOptions {
  /** Search only inside this mask, for example the sky. */
  mask?: LookMask;
  /** Luma at or above this is bright. Default 0.85 of the brightest luma in the search area, and at least 128. */
  level?: number;
  /** Smallest disc area in pixels; stars, sparks and glints are smaller. Default 24. */
  minArea?: number;
  /** The lights the scene shows, from its light list: the default bound is [0, lights]. Default 1. */
  expected?: number;
  bound?: LookBound;
}

/** A bright disc {@link lights} found. */
export interface LightDisc {
  x: number;
  y: number;
  radius: number;
  area: number;
}

/**
 * Counts bright discs: 8-connected components of bright pixels that fill their bounding box as a disc does (between
 * 0.6 and 0.95 of it) and are about as wide as tall. A second moon or sun is the double light this catches; streaks
 * such as lightning fill too little of their box to count. A light is an emitter: its core clips (luma 250 or more)
 * or it stands clear of what surrounds it (the mean luma of a ring just outside it is below 0.7 of the level). The
 * sunlit tops of cumulus clear the level as round puffs too, but shade smoothly into the cloud round them, so they
 * are not lights (KB-LOOK-LIGHTS-CLOUD1).
 */
export function lights(frame: LookImage, options: LightsOptions = {}): LookResult & { discs: LightDisc[] } {
  const { mask, minArea = 24, expected = 1 } = options;
  const { width, height } = frame,
    y = luma(frame),
    inside = maskBits(frame, mask, 'lights');
  let brightest = 0;
  for (let i = 0; i < y.length; i++) if (inside[i] && y[i] > brightest) brightest = y[i];
  const level = options.level ?? Math.max(128, 0.85 * brightest),
    parent = new Int32Array(width * height).fill(-1);
  const find = (i: number) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const join = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let row = 0; row < height; row++)
    for (let x = 0; x < width; x++) {
      const i = row * width + x;
      if (!inside[i] || y[i] < level) continue;
      parent[i] = i;
      if (x > 0 && parent[i - 1] >= 0) join(i, i - 1);
      if (row > 0) {
        for (let dx = -1; dx <= 1; dx++) {
          const n = i - width + dx;
          if (x + dx >= 0 && x + dx < width && parent[n] >= 0) join(i, n);
        }
      }
    }
  const parts = new Map<
    number,
    { area: number; x0: number; y0: number; x1: number; y1: number; sx: number; sy: number; peak: number }
  >();
  for (let i = 0; i < parent.length; i++) {
    if (parent[i] < 0) continue;
    const root = find(i),
      x = i % width,
      row = (i - x) / width,
      part = parts.get(root) ?? { area: 0, x0: x, y0: row, x1: x, y1: row, sx: 0, sy: 0, peak: 0 };
    part.area++;
    part.peak = Math.max(part.peak, y[i]);
    part.sx += x;
    part.sy += row;
    part.x0 = Math.min(part.x0, x);
    part.x1 = Math.max(part.x1, x);
    part.y0 = Math.min(part.y0, row);
    part.y1 = Math.max(part.y1, row);
    parts.set(root, part);
  }
  const discs: LightDisc[] = [];
  for (const part of parts.values()) {
    const w = part.x1 - part.x0 + 1,
      h = part.y1 - part.y0 + 1,
      fill = part.area / (w * h);
    if (part.area < minArea || fill < 0.6 || fill > 0.95 || w > 1.5 * h || h > 1.5 * w) continue;
    const cx = part.sx / part.area,
      cy = part.sy / part.area,
      radius = Math.sqrt(part.area / Math.PI);
    if (part.peak < 250) {
      // The ring from 2 pixels past the disc's box out to as far again (at least 3 pixels wide), inside the frame.
      const inner = Math.max(w, h) / 2 + 2,
        outer = inner + Math.max(3, Math.max(w, h) / 2);
      let sum = 0,
        n = 0;
      for (let ry = Math.max(0, Math.floor(cy - outer)); ry <= Math.min(height - 1, Math.ceil(cy + outer)); ry++)
        for (let rx = Math.max(0, Math.floor(cx - outer)); rx <= Math.min(width - 1, Math.ceil(cx + outer)); rx++) {
          const d = Math.hypot(rx - cx, ry - cy);
          if (d >= inner && d <= outer) {
            sum += y[ry * width + rx];
            n++;
          }
        }
      if (n > 0 && sum / n >= 0.7 * level) continue;
    }
    discs.push({ x: cx, y: cy, radius, area: part.area });
  }
  discs.sort((a, b) => b.area - a.area);
  const row = result('lights', discs.length, options.bound ?? [0, expected], { level, components: parts.size });
  return inside.includes(1) ? { ...row, discs } : { ...row, empty: '0 pixels inside the mask', discs };
}

// ------------------------------------------------------------------------------------------------------- Foam edges

/** Options of {@link foamEdges}. */
export interface FoamEdgesOptions {
  /** Where the foam is. Edges within 2 pixels of it count. */
  foam: LookMask;
  /** An edge's luma rise across its width must reach this many codes to count. Default 48. */
  minContrast?: number;
  /** Edges this many pixels wide or less are hard. Default 2. */
  hardWidth?: number;
  bound?: LookBound;
}

/**
 * Percent of the foam's strong edges that are hard. Each edge pixel (a local maximum of the gradient along its
 * stronger axis) is walked both ways to the luma extrema, and the distance between them is its width (Marziliano et
 * al. 2002): a thresholded foam edge is 1 pixel wide, a soft one many.
 */
export function foamEdges(frame: LookImage, options: FoamEdgesOptions): LookResult {
  const { foam, minContrast = 48, hardWidth = 2, bound } = options ?? ({} as FoamEdgesOptions);
  if (!foam) throw typeError('foamEdges needs the foam mask', 'headless');
  const { width, height } = frame,
    y = luma(frame),
    bits = maskBits(frame, foam, 'foam'),
    near = new Uint8Array(width * height);
  for (let row = 0; row < height; row++)
    for (let x = 0; x < width; x++) {
      if (!bits[row * width + x]) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const r = row + dy,
            c = x + dx;
          if (r >= 0 && r < height && c >= 0 && c < width) near[r * width + c] = 1;
        }
    }
  const at = (x: number, row: number) => y[row * width + x],
    gradient = (x: number, row: number, horizontal: boolean) =>
      horizontal
        ? x < 1 || x >= width - 1
          ? 0
          : (at(x + 1, row) - at(x - 1, row)) / 2
        : row < 1 || row >= height - 1
          ? 0
          : (at(x, row + 1) - at(x, row - 1)) / 2;
  let edges = 0,
    hard = 0;
  for (let row = 1; row < height - 1; row++)
    for (let x = 1; x < width - 1; x++) {
      if (!near[row * width + x]) continue;
      const gx = gradient(x, row, true),
        gy = gradient(x, row, false),
        horizontal = Math.abs(gx) >= Math.abs(gy),
        g = horizontal ? gx : gy,
        [sx, sy] = horizontal ? [1, 0] : [0, 1];
      // A local maximum of the gradient along its axis; of two equal neighbours, the first one is the edge.
      if (
        Math.abs(g) < 4 ||
        Math.abs(g) <= Math.abs(gradient(x - sx, row - sy, horizontal)) ||
        Math.abs(g) < Math.abs(gradient(x + sx, row + sy, horizontal))
      )
        continue;
      const sign = Math.sign(g);
      let a = 0,
        b = 0;
      // Walk down the slope to the minimum and up it to the maximum.
      while (true) {
        const cx = x - (a + 1) * sx,
          cy = row - (a + 1) * sy;
        if (cx < 0 || cy < 0 || sign * (at(cx + sx, cy + sy) - at(cx, cy)) <= 0) break;
        a++;
      }
      while (true) {
        const cx = x + (b + 1) * sx,
          cy = row + (b + 1) * sy;
        if (cx >= width || cy >= height || sign * (at(cx, cy) - at(cx - sx, cy - sy)) <= 0) break;
        b++;
      }
      const contrast = Math.abs(at(x + b * sx, row + b * sy) - at(x - a * sx, row - a * sy));
      if (contrast < minContrast) continue;
      edges++;
      if (a + b <= hardWidth) hard++;
    }
  return result('foamEdges', percent(hard, edges), bound, { edges, hard });
}

// ------------------------------------------------------------------------------------------------------- Black crush

/** Options of {@link crush}. */
export interface CrushOptions {
  /** Areas declared dark, where black is meant; left out of the count. */
  dark?: LookMask;
  /** A pixel whose largest channel is at or below this code is crushed. Default 2. */
  level?: number;
  bound?: LookBound;
}

/** Percent of the pixels outside the declared dark areas that are crushed to black. */
export function crush(frame: LookImage, { dark, level = 2, bound }: CrushOptions = {}): LookResult {
  checkImage(frame);
  const declared = dark ? maskBits(frame, dark, 'dark') : new Uint8Array(frame.width * frame.height),
    { data } = frame;
  let count = 0,
    crushed = 0;
  for (let i = 0; i < declared.length; i++) {
    if (declared[i]) continue;
    count++;
    if (Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) <= level) crushed++;
  }
  return result('crush', percent(crushed, count), bound, { pixels: count, crushed });
}

// ------------------------------------------------------------------------------------------------- Flicker, shimmer

/** Options of {@link flicker} and {@link shimmer}. */
export interface FlickerOptions {
  /** Only pixels inside this mask count. */
  mask?: LookMask;
  bound?: LookBound;
}

function stillFrames(frames: readonly LookImage[]): Float32Array[] {
  if (!(frames?.length >= 3))
    throw rangeError('Flicker needs at least three consecutive frames of a still camera', 'headless');
  for (const frame of frames) sameSize(frames[0], frame, 'still frame');
  return frames.map((frame) => luma(frame));
}

/**
 * The largest jump of the mean luma off its trend over consecutive frames of a still camera, in codes: the most
 * |m(t) - (m(t-1) + m(t+1)) / 2|. A steady change, a fade or a slow sweep, is a trend and passes.
 */
export function flicker(frames: readonly LookImage[], { mask, bound }: FlickerOptions = {}): LookResult {
  const ys = stillFrames(frames),
    inside = maskBits(frames[0], mask, 'flicker'),
    means = ys.map((y) => {
      let sum = 0,
        count = 0;
      for (let i = 0; i < y.length; i++)
        if (inside[i]) {
          sum += y[i];
          count++;
        }
      return count ? sum / count : 0;
    });
  let largest = 0,
    at = 0;
  for (let t = 1; t + 1 < means.length; t++) {
    const off = Math.abs(means[t] - (means[t - 1] + means[t + 1]) / 2);
    if (off > largest) [largest, at] = [off, t];
  }
  return result('flicker', largest, bound, { frames: frames.length, frame: at });
}

/**
 * Percent of pixels that jump more than `threshold` codes off their own trend, averaged over the inner frames of a
 * still camera: march noise and unstable shading that the frame mean hides.
 */
export function shimmer(
  frames: readonly LookImage[],
  { mask, bound, threshold = 6 }: FlickerOptions & { threshold?: number } = {},
): LookResult {
  const ys = stillFrames(frames),
    inside = maskBits(frames[0], mask, 'shimmer');
  let count = 0,
    jumping = 0;
  for (let t = 1; t + 1 < ys.length; t++)
    for (let i = 0; i < inside.length; i++) {
      if (!inside[i]) continue;
      count++;
      if (Math.abs(ys[t][i] - (ys[t - 1][i] + ys[t + 1][i]) / 2) > threshold) jumping++;
    }
  return result('shimmer', percent(jumping, count), bound, { frames: frames.length });
}

// --------------------------------------------------------------------------------------------------------------- NaN

const halfToFloat = (bits: number) => {
  const exponent = (bits >> 10) & 31,
    mantissa = bits & 1023;
  if (exponent === 31) return mantissa ? Number.NaN : bits & 0x8000 ? -Infinity : Infinity;
  const value = exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : (mantissa / 1024) * 2 ** -14;
  return bits & 0x8000 ? -value : value;
};

/** Pixels of a float frame with a NaN or infinite channel; detail gives the first one's position. */
export function nan(frame: FloatFrame, { bound }: { bound?: LookBound } = {}): LookResult {
  const { width, height, data } = frame ?? ({} as FloatFrame);
  if (!(data instanceof Float32Array || data instanceof Uint16Array))
    throw typeError('The float frame holds a Float32Array, or a Uint16Array of half floats', 'headless');
  if (data.length !== width * height * 4)
    throw rangeError("The float frame's data does not match its size", 'headless');
  const half = data instanceof Uint16Array;
  let count = 0,
    first = -1;
  for (let i = 0; i < width * height; i++)
    for (let c = 0; c < 4; c++) {
      const value = half ? halfToFloat(data[i * 4 + c]) : data[i * 4 + c];
      if (!Number.isFinite(value)) {
        count++;
        if (first < 0) first = i;
        break;
      }
    }
  return result('nan', count, bound, first < 0 ? {} : { x: first % width, y: Math.floor(first / width) });
}

// -------------------------------------------------------------------------------------------------------------- FLIP

/** Options of {@link flip}. */
export interface FlipOptions {
  /** Pixels per degree of visual angle where the frames are seen. Default 67, the FLIP paper's 0.7 m from a 4K
   * monitor 0.69 m wide; a phone held at 30 cm showing 1080 pixels across 6.5 cm is about 87. */
  pixelsPerDegree?: number;
  /** Also return the error of each pixel. Default false. */
  map?: boolean;
}

/** What {@link flip} gives back: FLIP errors are 0 (no visible difference) to 1. */
export interface FlipResult {
  mean: number;
  /** Error at the 50th, 95th and 99th percentile of pixels. */
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** With `map: true`: the error of each pixel, row by row. */
  map?: Float32Array;
}

const toLinear = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  toLinear[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
// Linear sRGB to XYZ, D65 white at luminance 1 (IEC 61966-2-1); the white is the matrix's row sums.
const RGB_XYZ = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];
const WHITE = [RGB_XYZ[0] + RGB_XYZ[1] + RGB_XYZ[2], 1, RGB_XYZ[6] + RGB_XYZ[7] + RGB_XYZ[8]];
const XYZ_RGB = (() => {
  const [a, b, c, d, e, f, g, h, i] = RGB_XYZ,
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ].map((v) => v / det);
})();
const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);

/** Hunt-adjusted L*a*b* of a linear RGB colour clamped to the unit cube. */
function huntLab(r: number, g: number, b: number, out: Float32Array, at: number): void {
  r = Math.min(1, Math.max(0, r));
  g = Math.min(1, Math.max(0, g));
  b = Math.min(1, Math.max(0, b));
  const fx = labF((RGB_XYZ[0] * r + RGB_XYZ[1] * g + RGB_XYZ[2] * b) / WHITE[0]),
    fy = labF(RGB_XYZ[3] * r + RGB_XYZ[4] * g + RGB_XYZ[5] * b),
    fz = labF((RGB_XYZ[6] * r + RGB_XYZ[7] * g + RGB_XYZ[8] * b) / WHITE[2]),
    L = 116 * fy - 16;
  out[at] = L;
  out[at + 1] = 0.01 * L * 500 * (fx - fy);
  out[at + 2] = 0.01 * L * 200 * (fy - fz);
}

/** One-dimensional convolution with clamped edges, along rows or columns. */
function convolve(src: Float32Array, width: number, height: number, kernel: Float32Array, rows: boolean): Float32Array {
  const out = new Float32Array(src.length),
    radius = kernel.length >> 1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = rows ? Math.min(width - 1, Math.max(0, x + k)) : x,
          sy = rows ? y : Math.min(height - 1, Math.max(0, y + k));
        sum += kernel[k + radius] * src[sy * width + sx];
      }
      out[y * width + x] = sum;
    }
  return out;
}

const separable = (src: Float32Array, width: number, height: number, across: Float32Array, down: Float32Array) =>
  convolve(convolve(src, width, height, across, true), width, height, down, false);

const normalised = (values: number[]) => {
  const sum = values.reduce((a, b) => a + b, 0);
  return Float32Array.from(values, (v) => v / sum);
};
/** Positive weights scaled to sum to 1 and negative ones to -1, as FLIP's feature kernels are. */
const balanced = (values: number[]) => {
  const plus = values.reduce((a, v) => a + Math.max(0, v), 0),
    minus = values.reduce((a, v) => a - Math.min(0, v), 0);
  return Float32Array.from(values, (v) => (v > 0 ? v / plus : v < 0 ? v / minus : 0));
};

interface FlipPlanes {
  lab: Float32Array;
  edge: Float32Array;
  point: Float32Array;
}

/** Linear RGB, three floats per pixel, of an 8-bit sRGB frame. */
function linearOf({ width, height, data }: LookImage): Float32Array {
  const n = width * height,
    out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = toLinear[data[i * 4 + c]];
  return out;
}

/** The colour (spatially filtered, Hunt-adjusted L*a*b*) and feature planes of one linear RGB image in 0..1. */
function flipPlanes(linear: Float32Array, width: number, height: number, ppd: number): FlipPlanes {
  const n = width * height,
    Yy = new Float32Array(n),
    Cx = new Float32Array(n),
    Cz = new Float32Array(n),
    achromatic = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = linear[i * 3],
      g = linear[i * 3 + 1],
      b = linear[i * 3 + 2],
      x = (RGB_XYZ[0] * r + RGB_XYZ[1] * g + RGB_XYZ[2] * b) / WHITE[0],
      y = RGB_XYZ[3] * r + RGB_XYZ[4] * g + RGB_XYZ[5] * b,
      z = (RGB_XYZ[6] * r + RGB_XYZ[7] * g + RGB_XYZ[8] * b) / WHITE[2];
    Yy[i] = 116 * y - 16;
    Cx[i] = 500 * (x - y);
    Cz[i] = 200 * (y - z);
    // The feature input is the achromatic channel moved to 0..1, which is Y over the white's.
    achromatic[i] = y;
  }
  // Contrast sensitivity as spatial Gaussians (FLIP section 4.1.1): a sqrt(pi / b) exp(-pi^2 x^2 / b), x in degrees.
  const spacing = 1 / ppd,
    radius = Math.ceil(3 * Math.sqrt(0.04 / (2 * Math.PI ** 2)) * ppd),
    taps = (b: number) =>
      Array.from({ length: 2 * radius + 1 }, (_, k) => Math.exp((-(Math.PI ** 2) * ((k - radius) * spacing) ** 2) / b)),
    yKernel = normalised(taps(0.0047)),
    xKernel = normalised(taps(0.0053)),
    z1 = taps(0.04),
    z2 = taps(0.025),
    weight = (a: number, b: number, t: number[]) => a * Math.sqrt(Math.PI / b) * t.reduce((s, v) => s + v, 0) ** 2,
    w1 = weight(34.1, 0.04, z1),
    w2 = weight(13.5, 0.025, z2),
    fY = separable(Yy, width, height, yKernel, yKernel),
    fX = separable(Cx, width, height, xKernel, xKernel),
    fZ1 = separable(Cz, width, height, normalised(z1), normalised(z1)),
    fZ2 = separable(Cz, width, height, normalised(z2), normalised(z2)),
    lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = (fY[i] + 16) / 116,
      x = (fX[i] / 500 + y) * WHITE[0],
      z = (y - (w1 * fZ1[i] + w2 * fZ2[i]) / (w1 + w2) / 200) * WHITE[2];
    huntLab(
      XYZ_RGB[0] * x + XYZ_RGB[1] * y + XYZ_RGB[2] * z,
      XYZ_RGB[3] * x + XYZ_RGB[4] * y + XYZ_RGB[5] * z,
      XYZ_RGB[6] * x + XYZ_RGB[7] * y + XYZ_RGB[8] * z,
      lab,
      i * 3,
    );
  }
  // Features (section 4.2.1): first and second derivatives of a Gaussian of sigma 0.5 * 0.082 degrees.
  const sigma = 0.5 * 0.082 * ppd,
    fr = Math.ceil(3 * sigma),
    xs = Array.from({ length: 2 * fr + 1 }, (_, k) => k - fr),
    gauss = normalised(xs.map((x) => Math.exp(-(x * x) / (2 * sigma * sigma)))),
    first = balanced(xs.map((x) => -x * Math.exp(-(x * x) / (2 * sigma * sigma)))),
    second = balanced(xs.map((x) => ((x * x) / sigma ** 2 - 1) * Math.exp(-(x * x) / (2 * sigma * sigma)))),
    ex = separable(achromatic, width, height, first, gauss),
    ey = separable(achromatic, width, height, gauss, first),
    px = separable(achromatic, width, height, second, gauss),
    py = separable(achromatic, width, height, gauss, second),
    edge = new Float32Array(n),
    point = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    edge[i] = Math.hypot(ex[i], ey[i]);
    point[i] = Math.hypot(px[i], py[i]);
  }
  return { lab, edge, point };
}

let maxColourError = 0;
/** The largest colour error, between Hunt-adjusted green and blue, after the power 0.7. */
const colourCeiling = () => {
  if (!maxColourError) {
    const lab = new Float32Array(6);
    huntLab(0, 1, 0, lab, 0);
    huntLab(0, 0, 1, lab, 3);
    maxColourError = (Math.abs(lab[0] - lab[3]) + Math.hypot(lab[1] - lab[4], lab[2] - lab[5])) ** 0.7;
  }
  return maxColourError;
};

/**
 * FLIP (Andersson et al. 2020): the difference a viewer sees flipping between a test frame and its reference, per
 * pixel 0 to 1, as `{ mean, p50, p95, p99, max }`. Colour: both images filtered by the eye's contrast sensitivity at
 * `pixelsPerDegree`, compared in Hunt-adjusted L*a*b* with HyAB and compressed into 0..1; features: edges and points
 * found in one image and not the other raise it.
 */
export function flip(
  test: LookImage,
  reference: LookImage,
  { pixelsPerDegree = 67, map = false }: FlipOptions = {},
): FlipResult {
  checkImage(test, 'test frame');
  checkImage(reference, 'reference');
  sameSize(reference, test, 'test frame');
  checkPpd(pixelsPerDegree);
  const { width, height } = test,
    errors = flipErrors(
      flipPlanes(linearOf(test), width, height, pixelsPerDegree),
      flipPlanes(linearOf(reference), width, height, pixelsPerDegree),
    );
  return { ...pool(errors), ...(map ? { map: errors } : {}) };
}

const checkPpd = (ppd: number) => {
  if (!(ppd > 0 && ppd < 1000)) throw rangeError('pixelsPerDegree is above 0 and below 1000', 'headless');
};

/** The LDR-FLIP error of each pixel between the planes of a test image and its reference. */
function flipErrors(t: FlipPlanes, r: FlipPlanes): Float32Array {
  const n = t.edge.length,
    errors = new Float32Array(n),
    cmax = colourCeiling(),
    pc = 0.4,
    pt = 0.95;
  for (let i = 0; i < n; i++) {
    const a = i * 3,
      hyab = Math.abs(t.lab[a] - r.lab[a]) + Math.hypot(t.lab[a + 1] - r.lab[a + 1], t.lab[a + 2] - r.lab[a + 2]),
      e = hyab ** 0.7,
      colour = e < pc * cmax ? (pt / (pc * cmax)) * e : pt + ((e - pc * cmax) / (cmax - pc * cmax)) * (1 - pt),
      feature = (Math.max(Math.abs(t.edge[i] - r.edge[i]), Math.abs(t.point[i] - r.point[i])) / Math.SQRT2) ** 0.5;
    errors[i] = Math.min(1, colour ** (1 - feature));
  }
  return errors;
}

/** Mean, percentiles and maximum of per-pixel errors in 0..1. */
function pool(errors: Float32Array): Omit<FlipResult, 'map'> {
  const n = errors.length,
    histogram = new Uint32Array(1001);
  let sum = 0,
    max = 0;
  for (let i = 0; i < n; i++) {
    const value = errors[i];
    sum += value;
    if (value > max) max = value;
    histogram[Math.round(value * 1000)]++;
  }
  const quantile = (q: number) => {
    let seen = 0;
    for (let k = 0; k < histogram.length; k++) {
      seen += histogram[k];
      if (seen >= q * n) return k / 1000;
    }
    return 1;
  };
  return {
    mean: sum / n,
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
    max,
  };
}

// ---------------------------------------------------------------------------------------------------------- HDR-FLIP

/**
 * A tone curve in the form of HDR-FLIP's Equation 1, y = (k0 x^2 + k1 x + k2) / (k3 x^2 + k4 x + k5), applied to each
 * of R, G and B and clamped to 0..1: `'aces'` (the default, Narkowicz's ACES fit as `acesNarkowicz` in
 * `packages/shared/aces.js` has it, with its 0.6 pre-scale), `'reinhard'` (Reinhard et al. 2002, x / (1 + x)) or the
 * six coefficients of another curve that rises from 0 on [0, infinity).
 */
export type ToneCurve = 'aces' | 'reinhard' | readonly [number, number, number, number, number, number];

/** Options of {@link hdrFlip}. */
export interface HdrFlipOptions extends FlipOptions {
  /** The tone curve every exposure goes through before LDR-FLIP compares it. Default `'aces'`. */
  toneMapper?: ToneCurve;
  /** Shortest exposure compensation, in stops. Default: the exposure that maps the reference's largest luminance to
   * 0.85 after the tone curve. */
  startExposure?: number;
  /** Longest exposure compensation, in stops. Default: the exposure that maps the reference's median luminance to
   * 0.85 after the tone curve. */
  stopExposure?: number;
  /** Also return, per pixel, the exposure (in stops) whose LDR pair gave the largest error. Default false. */
  exposureMap?: boolean;
}

/** What {@link hdrFlip} gives back: the errors pooled as {@link flip}'s, and the exposures they were taken over. */
export interface HdrFlipResult extends FlipResult {
  startExposure: number;
  stopExposure: number;
  /** How many exposures were compared: max(2, ceil(stop - start)). */
  exposures: number;
  /** With `exposureMap: true`: the exposure in stops that gave each pixel its error, row by row. */
  exposureMap?: Float32Array;
}

// Narkowicz's fit y = x (2.51 x + 0.03) / (x (2.43 x + 0.59) + 0.14) at x = 0.6 c, written in Equation 1's form.
const ACES_CURVE = [2.51 * 0.36, 0.03 * 0.6, 0, 2.43 * 0.36, 0.59 * 0.6, 0.14] as const;
const REINHARD_CURVE = [0, 1, 0, 0, 1, 1] as const;
// HDR-FLIP section 2.1: the target LDR luminance of the start (largest reference luminance) and stop (median) exposures.
const HDR_FLIP_TARGET = 0.85;

function toneCurve(curve: ToneCurve): readonly number[] {
  if (curve === 'aces') return ACES_CURVE;
  if (curve === 'reinhard') return REINHARD_CURVE;
  if (!Array.isArray(curve) || curve.length !== 6 || !curve.every((k) => Number.isFinite(k)))
    throw typeError("toneMapper is 'aces', 'reinhard' or six finite coefficients [k0, k1, k2, k3, k4, k5]", 'headless');
  return curve;
}

/** The exposure c (stops) at which the curve maps luminance `luminance` to `target`: Equations 2 and 3. */
function exposureFor(k: readonly number[], target: number, luminance: number, which: string): number {
  if (!(luminance > 0))
    throw rangeError(
      `The reference's ${which} luminance is 0, so no exposure maps it to ${target}: give startExposure and stopExposure`,
      'headless',
    );
  const a = target * k[3] - k[0],
    b = target * k[4] - k[1],
    c = target * k[5] - k[2];
  let x = Number.NaN;
  if (Math.abs(a) < 1e-12) x = -c / b;
  else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const q = Math.sqrt(disc),
        roots = [(-b - q) / (2 * a), (-b + q) / (2 * a)].filter((root) => root > 0);
      if (roots.length) x = Math.min(...roots);
    }
  }
  if (!(x > 0 && x < Infinity))
    throw rangeError(
      `The tone curve never reaches ${target} on (0, infinity), so it cannot set the exposures`,
      'headless',
    );
  return Math.log2(x / luminance);
}

/** RGB, three floats per pixel, of a float frame; every value must be finite and not negative. */
function hdrLinear(frame: FloatFrame, what: string): Float32Array {
  const { width, height, data } = frame ?? ({} as FloatFrame);
  if (!(data instanceof Float32Array || data instanceof Uint16Array) || !(width > 0) || !(height > 0))
    throw typeError(`The ${what} must be {width, height, data: Float32Array or Uint16Array half floats}`, 'headless');
  if (data.length !== width * height * 4) throw rangeError(`The ${what}'s data does not match its size`, 'headless');
  const half = data instanceof Uint16Array,
    n = width * height,
    out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) {
      const v = half ? halfToFloat(data[i * 4 + c]) : data[i * 4 + c];
      if (!(v >= 0 && v < Infinity))
        throw rangeError(
          `The ${what} has a negative, NaN or infinite value at pixel ${i}: HDR-FLIP needs light of 0 or more`,
          'headless',
        );
      out[i * 3 + c] = v;
    }
  return out;
}

/**
 * HDR-FLIP (Andersson, Nilsson, Shirley and Akenine-Moller 2021): the largest LDR-FLIP error a rendered HDR frame shows
 * against its HDR reference over a range of exposures. Both float frames (linear Rec.709 RGBA, Float32 or half floats)
 * are exposure compensated by 2^c for max(2, ceil(stop - start)) exposures c spread evenly from `startExposure` to
 * `stopExposure`, tone mapped and clamped to 0..1, and each pair is compared with {@link flip}'s LDR-FLIP; each pixel
 * keeps its largest error. The default range comes from the reference alone, so every test frame of one reference is
 * judged over the same exposures.
 */
export function hdrFlip(
  test: FloatFrame,
  reference: FloatFrame,
  {
    pixelsPerDegree = 67,
    map = false,
    toneMapper = 'aces',
    startExposure,
    stopExposure,
    exposureMap = false,
  }: HdrFlipOptions = {},
): HdrFlipResult {
  const t = hdrLinear(test, 'test frame'),
    r = hdrLinear(reference, 'reference');
  sameSize(reference, test, 'test frame');
  checkPpd(pixelsPerDegree);
  const k = toneCurve(toneMapper),
    { width, height } = test,
    n = width * height;
  if (startExposure !== undefined && !Number.isFinite(startExposure))
    throw rangeError('startExposure is a finite number of stops', 'headless');
  if (stopExposure !== undefined && !Number.isFinite(stopExposure))
    throw rangeError('stopExposure is a finite number of stops', 'headless');
  let start = startExposure,
    stop = stopExposure;
  if (start === undefined || stop === undefined) {
    const luminance = new Float32Array(n);
    for (let i = 0; i < n; i++)
      luminance[i] = RGB_XYZ[3] * r[i * 3] + RGB_XYZ[4] * r[i * 3 + 1] + RGB_XYZ[5] * r[i * 3 + 2];
    luminance.sort();
    const largest = luminance[n - 1],
      median = n % 2 ? luminance[n >> 1] : (luminance[n / 2 - 1] + luminance[n / 2]) / 2;
    start ??= exposureFor(k, HDR_FLIP_TARGET, largest, 'largest');
    stop ??= exposureFor(k, HDR_FLIP_TARGET, median, 'median');
  }
  if (start > stop) throw rangeError(`startExposure ${start} is above stopExposure ${stop}`, 'headless');
  const first = start,
    last = stop,
    count = Math.max(2, Math.ceil(last - first)),
    errors = new Float32Array(n),
    chosen = exposureMap ? new Float32Array(n).fill(first) : undefined,
    curve = (x: number) =>
      Math.min(1, Math.max(0, (k[0] * x * x + k[1] * x + k[2]) / (k[3] * x * x + k[4] * x + k[5]))),
    ldr = (hdr: Float32Array, scale: number) => Float32Array.from(hdr, (v) => curve(scale * v));
  for (let e = 0; e < count; e++) {
    const c = first + (e * (last - first)) / (count - 1),
      at = flipErrors(
        flipPlanes(ldr(t, 2 ** c), width, height, pixelsPerDegree),
        flipPlanes(ldr(r, 2 ** c), width, height, pixelsPerDegree),
      );
    for (let i = 0; i < n; i++)
      if (at[i] > errors[i]) {
        errors[i] = at[i];
        if (chosen) chosen[i] = c;
      }
  }
  return {
    ...pool(errors),
    startExposure: first,
    stopExposure: last,
    exposures: count,
    ...(map ? { map: errors } : {}),
    ...(chosen ? { exposureMap: chosen } : {}),
  };
}

/** Mean FLIP of a frame against a reference, as the `reference` (16-sample frame) or `backends` (compat frame) check. */
export function difference(
  frame: LookImage,
  other: LookImage,
  check: 'reference' | 'backends',
  { bound, ...options }: FlipOptions & { bound?: LookBound } = {},
): LookResult & { map?: Float32Array } {
  const { mean, map, ...rest } = flip(frame, other, options);
  return { ...result(check, mean, bound, rest), ...(map ? { map } : {}) };
}

// ------------------------------------------------------------------------------------------------- Probes and shots

/** One probe frame and what the checks need beside it. Checks whose inputs are missing are left out, unless named. */
export interface LookProbe {
  name: string;
  frame: LookImage;
  /**
   * Masks by name: `sky`, `water`, `foam` and `dark` are read, and `sky-coverage` (the pixels `@margoengine/sky` drew,
   * its `coverage` option) limits `skyClip` when there is no `sky` mask. `grain`, `lights` and `horizonSeam` read only
   * `sky`.
   */
  masks?: Record<string, LookMask>;
  /** The float frame before tone mapping, for the `nan` check. */
  hdr?: FloatFrame;
  /** The 16-sample reference render of this frame. */
  reference?: LookImage;
  /** This frame from the WebGL2 compatibility layer. */
  compat?: LookImage;
  /** The camera's view-projection at this frame, column-major, for the horizon seam. */
  viewProjection?: ArrayLike<number>;
  /** Consecutive frames of a still camera around this one, for flicker and shimmer. */
  still?: LookImage[];
  /** The frame after this one and each pixel's motion to it, for `shimmerMoving` and `motionBlur`. */
  moving?: MovingFrames;
  /** The light the frame was shaded with: `bounce` and `shadowTint` take their limits from it ({@link lightBounds}). */
  light?: LookLight;
  /** The frame before its 8 bits, which `bounce` and `shadowTint` read in its place. */
  precise?: PreciseFrame;
  /**
   * More frames whose ground `bounce` and `shadowTint` pool with this one's: each its precise frame (or frame) and its
   * masks, or its {@link groundSample} made with this probe's choice of albedo (with one only if the probe has one).
   */
  pool?: ({ frame?: LookImage; precise?: PreciseFrame; masks: Record<string, LookMask> } | GroundSample)[];
}

/** Options of {@link checkProbe}. */
export interface CheckProbeOptions {
  /** The block pitch: the froxel tile in pixels. Default 8. */
  pitch?: number;
  /** Viewing condition of the FLIP checks. Default 67 pixels per degree. */
  pixelsPerDegree?: number;
  /** A look family from {@link LOOK_FAMILY_NAMES}: its bounds apply to every check the probe can run, under `bounds`. */
  family?: string | null;
}

/**
 * Runs every look check a probe has the inputs for, with `bounds` from the shot file's `lookBounds` in place of the
 * defaults. A check named in `bounds` that cannot run fails as missing, and so does a name no check has.
 */
export function checkProbe(
  probe: LookProbe,
  bounds: Readonly<Record<string, LookBound>> = {},
  { pitch, pixelsPerDegree, family }: CheckProbeOptions = {},
): (LookResult & { map?: Float32Array })[] {
  checkImage(probe?.frame, `${probe?.name ?? 'probe'} frame`);
  const fam: Record<string, LookBound> = family == null ? {} : familyBounds(family),
    { frame, masks = {} } = probe,
    rows: (LookResult & { map?: Float32Array })[] = [],
    b = (name: LookCheckName) => bounds[name] ?? fam[name],
    sky = masks.sky,
    run = (name: LookCheckName, ready: string | null, make: () => LookResult) => {
      if (ready === null) rows.push(make());
      else if (name in bounds) rows.push(missingResult(name, ready, bounds[name]));
    };
  // With no page sky mask, the sky package's own coverage limits skyClip alone (KB-HEARTH-CLIP1): it is where the sky
  // was drawn, not a split of the frame, so grain, lights and the horizon keep reading the page's mask only.
  const clipSky = sky ?? masks['sky-coverage'];
  run('skyClip', null, () => ({
    ...skyClip(frame, { sky: clipSky, bound: b('skyClip') }),
    mask: sky ? 'sky' : clipSky ? 'sky-coverage' : 'frame',
  }));
  run('grain', null, () => grain(frame, { mask: sky, bound: b('grain') }));
  run('speckle', null, () => speckle(frame, { bound: b('speckle') }));
  run('banding', null, () => banding(frame, { bound: b('banding') }));
  run('flat', null, () => flat(frame, { bound: b('flat') }));
  run('blocks', null, () => blocks(frame, { pitch, bound: b('blocks') }));
  // The horizon is only a horizon where the sky meets it: an interior's line runs across walls (Cabin Hearth's mantel
  // measured a 15.8-code "seam"), so with no sky mask there is nothing to measure.
  run('horizonSeam', !probe.viewProjection ? 'the camera view-projection' : !sky ? 'the sky mask' : null, () =>
    horizonSeam(frame, { viewProjection: probe.viewProjection!, sky, bound: b('horizonSeam') }),
  );
  run('waterSeam', masks.water ? null : 'the water mask', () =>
    waterSeam(frame, { water: masks.water, bound: b('waterSeam') }),
  );
  run('lights', null, () => {
    const { discs: _, ...row } = lights(frame, { mask: sky, bound: b('lights') });
    return row;
  });
  run('foamEdges', masks.foam ? null : 'the foam mask', () =>
    foamEdges(frame, { foam: masks.foam, bound: b('foamEdges') }),
  );
  run('crush', null, () => crush(frame, { dark: masks.dark, bound: b('crush') }));
  run('flicker', probe.still ? null : 'still-camera frames', () => flicker(probe.still!, { bound: b('flicker') }));
  run('shimmer', probe.still ? null : 'still-camera frames', () => shimmer(probe.still!, { bound: b('shimmer') }));
  run('nan', probe.hdr ? null : 'the float frame', () => nan(probe.hdr!, { bound: b('nan') }));
  run('backends', probe.compat ? null : 'the compat frame', () =>
    difference(frame, probe.compat!, 'backends', { bound: b('backends'), pixelsPerDegree }),
  );
  run('reference', probe.reference ? null : 'the 16-sample reference frame', () =>
    difference(frame, probe.reference!, 'reference', { bound: b('reference'), pixelsPerDegree, map: true }),
  );
  // The clean-frame checks (roadmap T1 to T8). A family's bound makes a check fail only where it can run; a bound a shot
  // names itself for a check that cannot run fails as missing, like every other check.
  // A mask that marks no pixel names nothing to measure: a shot with no subject in frame, no penumbra or no lit or
  // shaded ground has no outline, edge or ratio to read, so the check cannot run (it read 0 % before, a false failure
  // for silhouette and a false pass for penumbra; KB-LOOK-EMPTYMASK1).
  const marked = (name: string): string | null =>
    !masks[name]
      ? `the ${name} mask`
      : maskBits(frame, masks[name], name).includes(1)
        ? null
        : `${name} pixels (the ${name} mask is empty)`;
  run('penumbra', marked('penumbra'), () =>
    penumbra(frame, { mask: masks.penumbra, plants: masks.plants, bound: b('penumbra') }),
  );
  run('penumbraPlants', masks.plants ? (marked('penumbra') ?? marked('plants')) : 'the plants mask', () =>
    penumbraPlants(frame, { penumbra: masks.penumbra, plants: masks.plants, bound: b('penumbraPlants') }),
  );
  run('stairs', null, () => stairs(frame, { bound: b('stairs') }));
  run('colourEdges', null, () => colourEdges(frame, { bound: b('colourEdges') }));
  run('chromaSmear', null, () => chromaSmear(frame, { bound: b('chromaSmear') }));
  run('shimmerMoving', probe.moving ? null : 'the next frame and its motion', () =>
    shimmerMoving(frame, probe.moving!, { bound: b('shimmerMoving') }),
  );
  run('motionBlur', probe.moving ? null : 'the next frame and its motion', () =>
    motionBlur(frame, probe.moving!.motion, { bound: b('motionBlur'), shutter: probe.moving!.shutter }),
  );
  run('silhouette', marked('subject'), () => silhouette(frame, { subject: masks.subject, bound: b('silhouette') }));
  run('silhouetteShape', marked('subject'), () =>
    silhouetteShape(frame, { subject: masks.subject, bound: b('silhouetteShape') }),
  );
  const ground = masks.lit && masks.shadow ? (marked('lit') ?? marked('shadow')) : 'the lit and shadow masks';
  // T6 follows the light (KB-LOOK-TV-PALL1): with the probe's light, the family's or default limits move as the lights
  // predict (unchanged under a clear sun); a bound the shot names itself still wins.
  const followed = (name: 'bounce' | 'shadowTint'): LookBound | undefined =>
    bounds[name] ?? (probe.light ? lightBounds(probe.light, { [name]: fam[name] })[name] : fam[name]);
  const noted = (row: LookResult): LookResult =>
    probe.light ? { ...row, detail: { ...row.detail, diffuse: lightBounds(probe.light).diffuse } } : row;
  // The albedo AOV, one grey mask per sRGB channel (`albedo-r`, `albedo-g`, `albedo-b`), makes T6 compare like surfaces.
  const albedo = albedoOf(frame, masks),
    // The precise frames and the pooled frames (KB-LOOK-TV-TINTRES1); a pooled frame's albedo from its own masks.
    pool = probe.pool?.map((one) => {
      if ('strata' in one) return one;
      const { frame: f, precise, masks: m } = one;
      return { frame: f, precise, lit: m.lit, shadow: m.shadow, albedo: albedo && albedoOf((precise ?? f)!, m) };
    }),
    ground6 = { lit: masks.lit, shadow: masks.shadow, albedo, precise: probe.precise, pool };
  run('bounce', ground, () => noted(bounce(frame, { ...ground6, bound: followed('bounce') })));
  run('shadowTint', ground, () => noted(shadowTint(frame, { ...ground6, bound: followed('shadowTint') })));
  // A night shot names these (a daylight frame is not a failed night): no family runs them.
  if ('nightLuma' in bounds) rows.push(nightLuma(frame, { bound: bounds.nightLuma }));
  if ('nightPeak' in bounds) rows.push(nightPeak(frame, { bound: bounds.nightPeak }));
  for (const name of Object.keys(bounds))
    if (!(name in LOOK_CHECKS))
      rows.push(
        missingResult(
          name,
          `a check named ${name}: lookBounds names ${Object.keys(LOOK_CHECKS).join(', ')}`,
          bounds[name],
        ),
      );
  return rows;
}

/** A checked probe, for {@link lookReport}. */
export interface CheckedProbe {
  name: string;
  frame: LookImage;
  results: (LookResult & { map?: Float32Array })[];
}

/** The report as JSON. */
export interface LookReportJSON {
  format: 'margo-look-report';
  version: 1;
  pass: boolean;
  probes: { name: string; pass: boolean; results: LookResult[] }[];
}

/** What {@link lookReport} gives back: one page for review. */
export interface LookReport {
  pass: boolean;
  json: LookReportJSON;
  /** A markdown table: one row per probe and check, failures first. */
  markdown: string;
  /** The contact sheet: each probe's thumbnail framed green (pass) or red (fail) and labelled with what failed, then
   * its FLIP map against the reference when it has one. Save it with `encodePNG`. */
  sheet: LookImage;
}

/** Options of {@link lookReport}. */
export interface LookReportOptions {
  /** Thumbnail width in pixels. Default 270, a quarter of a vertical short. */
  thumbWidth?: number;
  /** Tiles per row. Default 4. */
  columns?: number;
  /** A title over the table. Default "Look checks". */
  title?: string;
}

const formatValue = (value: number) =>
  Number.isNaN(value)
    ? 'not run'
    : Math.abs(value) >= 100 || Number.isInteger(value)
      ? String(Math.round(value * 100) / 100)
      : value.toPrecision(3);
const formatBound = ([low, high]: [number, number]) =>
  low === -Infinity
    ? `<= ${formatValue(high)}`
    : low === high
      ? `= ${formatValue(low)}`
      : `${formatValue(low)} to ${formatValue(high)}`;

/** The contact sheet and the table, JSON and markdown, of checked probes. */
export function lookReport(
  probes: readonly CheckedProbe[],
  { thumbWidth = 270, columns = 4, title = 'Look checks' }: LookReportOptions = {},
): LookReport {
  if (!probes?.length) throw rangeError('lookReport needs at least one checked probe', 'headless');
  const clean = (row: LookResult & { map?: Float32Array }): LookResult => {
    const { map: _, ...rest } = row;
    return { ...rest, bound: [...rest.bound] as [number, number], detail: { ...rest.detail } };
  };
  const json: LookReportJSON = {
    format: 'margo-look-report',
    version: 1,
    pass: probes.every((probe) => probe.results.every((row) => row.pass)),
    probes: probes.map((probe) => ({
      name: probe.name,
      pass: probe.results.every((row) => row.pass),
      results: probe.results.map(clean),
    })),
  };
  const lines = [
    `# ${title}`,
    '',
    `${json.pass ? 'PASS' : 'FAIL'}: ${probes.length} probe${probes.length === 1 ? '' : 's'}, ${json.probes.reduce((n, p) => n + p.results.filter((r) => !r.pass).length, 0)} failing check(s).`,
    '',
    '| Probe | Check | Value | Bound | Result |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const probe of json.probes)
    for (const row of [...probe.results].sort((a, b) => Number(a.pass) - Number(b.pass)))
      lines.push(
        `| ${probe.name} | ${row.check} | ${row.missing ? `not run: needs ${row.missing}` : `${formatValue(row.value)} ${row.unit}`} | ${formatBound(row.bound)} ${row.unit} | ${row.pass ? 'pass' : '**FAIL**'}${row.empty ? ` (measured ${row.empty})` : ''} |`,
      );
  // Which mask each masked check measured inside, by probe, so a pass over the whole frame is never read as one over
  // the sky.
  const about: Record<string, string> = {
      sky: "inside the page's `sky` mask",
      'sky-coverage': 'inside `sky-coverage`, the pixels `@margoengine/sky` drew (no page sky mask)',
      frame: 'over the whole frame (no sky mask)',
    },
    masked = new Map<string, string[]>();
  for (const probe of json.probes)
    for (const row of probe.results)
      if (row.mask) {
        const key = `${row.check} ${row.mask}`;
        masked.set(key, [...(masked.get(key) ?? []), probe.name]);
      }
  if (masked.size) lines.push('', 'Masks:');
  for (const [key, names] of masked) {
    const [check, mask] = key.split(' ');
    lines.push(`- ${check} ${about[mask] ?? `inside \`${mask}\``}: ${names.join(', ')}`);
  }
  return { pass: json.pass, json, markdown: `${lines.join('\n')}\n`, sheet: contactSheet(probes, thumbWidth, columns) };
}

// The 5 x 7 label font: each glyph is 7 rows of 5 bits, one base-32 digit per row.
const GLYPHS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.:%/<>=',
  GLYPH_ROWS =
    'ehjlphe4c4444eeh1248vv2421he26aiv22vgu11he68guhhev124888ehhehheehhf12cehhvhhhuhhuhhuehgggheuhhhhhuvgguggvvggugggehgnhhfhhhvhhhe44444e72222ichikokihggggggvhrllhhhhhpljhhehhhhheuhhugggehhhliduhhukihfgge11uv444444hhhhhhehhhhha4hhhlllahha4ahhhha4444v1248gv000v00000000cc0cc0cc0op248j301248g0248g842842124800v0v00';

function drawText(sheet: LookImage, text: string, left: number, top: number, scale: number, colour: number[]): void {
  let x = left;
  for (const char of text.toUpperCase()) {
    const glyph = GLYPHS.indexOf(char);
    if (glyph >= 0)
      for (let row = 0; row < 7; row++) {
        const bits = Number.parseInt(GLYPH_ROWS[glyph * 7 + row], 32);
        for (let col = 0; col < 5; col++)
          if (bits & (16 >> col)) fill(sheet, x + col * scale, top + row * scale, scale, scale, colour);
      }
    x += 6 * scale;
    if (x + 5 * scale > sheet.width) break;
  }
}

function fill(sheet: LookImage, x0: number, y0: number, w: number, h: number, [r, g, b]: number[]): void {
  for (let y = Math.max(0, y0); y < Math.min(sheet.height, y0 + h); y++)
    for (let x = Math.max(0, x0); x < Math.min(sheet.width, x0 + w); x++)
      sheet.data.set([r, g, b, 255], (y * sheet.width + x) * 4);
}

/** Box-filtered thumbnail of an image, or of a 0..1 map shown as heat, blitted at (left, top). */
function blit(
  sheet: LookImage,
  source: { width: number; height: number },
  pick: (x: number, y: number) => number[],
  left: number,
  top: number,
  w: number,
  h: number,
): void {
  const sx = source.width / w,
    sy = source.height / h;
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++) {
      const x0 = Math.floor(tx * sx),
        x1 = Math.max(x0 + 1, Math.floor((tx + 1) * sx)),
        y0 = Math.floor(ty * sy),
        y1 = Math.max(y0 + 1, Math.floor((ty + 1) * sy)),
        sum = [0, 0, 0];
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const c = pick(x, y);
          sum[0] += c[0];
          sum[1] += c[1];
          sum[2] += c[2];
        }
      const n = (x1 - x0) * (y1 - y0),
        at = ((top + ty) * sheet.width + left + tx) * 4;
      sheet.data.set([sum[0] / n, sum[1] / n, sum[2] / n, 255], at);
    }
}

/** Black to red to yellow to white for 0..1. */
const heat = (v: number) => [
  Math.min(255, v * 3 * 255),
  Math.min(255, Math.max(0, v * 3 - 1) * 255),
  Math.min(255, Math.max(0, v * 3 - 2) * 255),
];

function contactSheet(probes: readonly CheckedProbe[], thumbWidth: number, columns: number): LookImage {
  if (!(Number.isInteger(thumbWidth) && thumbWidth >= 32) || !(Number.isInteger(columns) && columns >= 1))
    throw rangeError('thumbWidth is a whole number from 32 and columns from 1', 'headless');
  const tiles: { probe: CheckedProbe; map?: Float32Array }[] = [];
  for (const probe of probes) {
    tiles.push({ probe });
    const map = probe.results.find((row) => row.map)?.map;
    if (map) tiles.push({ probe, map });
  }
  const first = probes[0].frame,
    thumbHeight = Math.max(1, Math.round((first.height * thumbWidth) / first.width)),
    border = 3,
    label = 36,
    tileW = thumbWidth + 2 * border,
    tileH = thumbHeight + 2 * border + label,
    across = Math.min(columns, tiles.length),
    sheet = {
      width: across * (tileW + 8) + 8,
      height: Math.ceil(tiles.length / across) * (tileH + 8) + 8,
      data: new Uint8Array(0),
    };
  sheet.data = new Uint8Array(sheet.width * sheet.height * 4);
  fill(sheet, 0, 0, sheet.width, sheet.height, [24, 24, 28]);
  tiles.forEach(({ probe, map }, index) => {
    const left = 8 + (index % across) * (tileW + 8),
      top = 8 + Math.floor(index / across) * (tileH + 8),
      failing = probe.results.filter((row) => !row.pass).map((row) => row.check),
      frame = probe.frame;
    fill(sheet, left, top, tileW, thumbHeight + 2 * border, failing.length ? [211, 47, 47] : [46, 160, 67]);
    if (map)
      blit(
        sheet,
        frame,
        (x, y) => heat(map[y * frame.width + x]),
        left + border,
        top + border,
        thumbWidth,
        thumbHeight,
      );
    else
      blit(
        sheet,
        frame,
        (x, y) => {
          const at = (y * frame.width + x) * 4;
          return [frame.data[at], frame.data[at + 1], frame.data[at + 2]];
        },
        left + border,
        top + border,
        thumbWidth,
        thumbHeight,
      );
    const textTop = top + thumbHeight + 2 * border + 4;
    drawText(sheet, map ? `${probe.name} FLIP` : probe.name, left, textTop, 2, [235, 235, 235]);
    drawText(
      sheet,
      failing.length ? `FAIL ${failing.join(' ')}` : 'PASS',
      left,
      textTop + 17,
      1,
      failing.length ? [255, 120, 120] : [120, 220, 140],
    );
  });
  return sheet;
}

/** A probe of a shot tool manifest (`manifest.json`, docs/shots.md): file paths relative to the shot folder. */
export interface ShotManifestProbe {
  frame: number;
  file: string;
  aovs?: Record<string, string>;
  /** The 16-sample reference render of this frame, a PNG. */
  reference?: string;
  /** This frame from the WebGL2 compatibility layer, a PNG. */
  compat?: string;
  /** The float frame, raw little-endian RGBA float32 rows (`.rgba32f`), the frame's size. */
  hdr?: string;
  /** The camera's view-projection at this frame, column-major. */
  viewProjection?: number[];
  /** PNGs of consecutive frames of a still camera around this one. */
  still?: string[];
  /**
   * The frame after this one (a PNG) and each pixel's motion to it (raw little-endian float32, x then y per pixel, the
   * frame's size), for `shimmerMoving` and `motionBlur`.
   */
  moving?: { next: string; motion: string };
  /**
   * This probe's own bounds, check name: bound. They replace the shot's `lookBounds` for the checks they name, on this
   * probe only (for example a lights bound for the probes that face the lamps).
   */
  lookBounds?: Record<string, LookBound>;
  /** The light the frame was shaded with (the shot tool records it), for the T6 limits ({@link lightBounds}). */
  light?: LookLight;
  /** The frame before its 8 bits, raw little-endian RGB float32 rows, sRGB coded 0 to 1 (`.rgb32f`). */
  precise?: string;
  /** More frames whose ground T6 pools with this one's (the shot's `probePool`): each its precise frame and masks. */
  pool?: { frame: number; precise: string; aovs?: Record<string, string> }[];
}

/** What {@link checkShot} reads. */
export interface CheckShotOptions extends CheckProbeOptions, LookReportOptions {
  /** The shot tool's manifest.json, parsed. */
  manifest: {
    id?: string;
    header?: { lookBounds?: Record<string, LookBound>; lookFamily?: string | null };
    /** How the frames were made: a shot drawn with sub-frames over a shutter is judged by `motionBlur` at that angle. */
    render?: { subframes?: number; shutter?: number };
    probes?: Record<string, ShotManifestProbe>;
  };
  /** Reads a file of the shot folder by its manifest path, for example `(path) => readFile(join(folder, path))`. */
  read: (path: string) => Promise<Uint8Array>;
  /** Stops between probes; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

async function movingFrames(
  entry: { next: string; motion: string },
  frame: LookImage,
  read: (path: string) => Promise<Uint8Array>,
  png: (path: string) => Promise<LookImage>,
): Promise<MovingFrames> {
  const bytes = await read(entry.motion),
    data = new Float32Array(frame.width * frame.height * 2);
  if (bytes.byteLength !== data.byteLength)
    throw rangeError(`${entry.motion} is not the frame's size in float32 pairs (x, y)`, 'headless');
  new Uint8Array(data.buffer).set(bytes);
  return { next: await png(entry.next), motion: { width: frame.width, height: frame.height, data } };
}

/**
 * Runs the look checks on every probe of a rendered shot, with its `lookBounds` (and each probe's own `lookBounds` in
 * their place for the checks a probe names), and makes the report.
 */
export async function checkShot({
  manifest,
  read,
  signal,
  pitch,
  pixelsPerDegree,
  ...report
}: CheckShotOptions): Promise<LookReport> {
  if (typeof read !== 'function') throw typeError('checkShot needs read(path) => Promise<Uint8Array>', 'headless');
  const entries = Object.entries(manifest?.probes ?? {});
  if (!entries.length) throw rangeError('The manifest has no probes: name probe frames in the shot file', 'headless');
  const bounds = manifest.header?.lookBounds ?? {},
    family = manifest.header?.lookFamily,
    { subframes = 1, shutter = 0 } = manifest.render ?? {},
    exposed = subframes > 1 && shutter > 0 ? shutter : undefined,
    png = async (path: string) => decodePNG(await read(path)),
    checked: CheckedProbe[] = [];
  for (const [name, entry] of entries) {
    signal?.throwIfAborted();
    const frame = await png(entry.file),
      masks: Record<string, LookMask> = {};
    for (const [aov, path] of Object.entries(entry.aovs ?? {})) masks[aov] = await png(path);
    let hdr: FloatFrame | undefined;
    if (entry.hdr) {
      const bytes = await read(entry.hdr),
        floats = new Float32Array(frame.width * frame.height * 4);
      if (bytes.byteLength !== floats.byteLength)
        throw rangeError(`${entry.hdr} is not the frame's size in RGBA float32`, 'headless');
      new Uint8Array(floats.buffer).set(bytes);
      hdr = { width: frame.width, height: frame.height, data: floats };
    }
    const precise = async (path: string): Promise<PreciseFrame> => {
      const bytes = await read(path),
        data = new Float32Array(frame.width * frame.height * 3);
      if (bytes.byteLength !== data.byteLength)
        throw rangeError(`${path} is not the frame's size in RGB float32`, 'headless');
      new Uint8Array(data.buffer).set(bytes);
      return { width: frame.width, height: frame.height, data };
    };
    // Each pooled frame is cut to its ground strata as it is read, so a pool of hundreds of frames holds a few numbers
    // each, not its 25 MB frame and masks; with an albedo only when the probe has one, as checkProbe would.
    const pool: GroundSample[] = [],
      withAlbedo = !!albedoOf(frame, masks);
    for (const one of entry.pool ?? []) {
      signal?.throwIfAborted();
      const m: Record<string, LookMask> = {};
      for (const [aov, path] of Object.entries(one.aovs ?? {}))
        if (GROUND_AOVS.includes(aov)) m[aov] = await png(path);
      if (!m.lit || !m.shadow) continue;
      const p = await precise(one.precise);
      pool.push(groundSample({ precise: p, lit: m.lit, shadow: m.shadow, albedo: withAlbedo ? albedoOf(p, m) : undefined }));
    }
    const probe: LookProbe = {
      name,
      frame,
      masks,
      hdr,
      precise: entry.precise ? await precise(entry.precise) : undefined,
      pool: pool.length ? pool : undefined,
      reference: entry.reference ? await png(entry.reference) : undefined,
      compat: entry.compat ? await png(entry.compat) : undefined,
      viewProjection: entry.viewProjection,
      still: entry.still ? await Promise.all(entry.still.map(png)) : undefined,
      moving: entry.moving ? { ...(await movingFrames(entry.moving, frame, read, png)), shutter: exposed } : undefined,
      light: entry.light,
    };
    const own = entry.lookBounds ? { ...bounds, ...entry.lookBounds } : bounds;
    checked.push({ name, frame, results: checkProbe(probe, own, { pitch, pixelsPerDegree, family }) });
  }
  return lookReport(checked, { title: manifest.id ? `Look checks: ${manifest.id}` : undefined, ...report });
}

// ------------------------------------------------------------------------------------------------ Clean-frame checks

// The animated-feature look bar (roadmap section 3, T1 to T8): checks that a frame is clean, not only plausible. Every
// bound is a measured number a shot passes or fails, kept in LOOK_FAMILY_BOUNDS and never loosened. Aliasing and temporal
// stability follow the survey of Yang, Liu and Salvi, "A Survey of Temporal Antialiasing Techniques", Computer Graphics
// Forum 39(2), 2020, https://doi.org/10.1111/cgf.14018; banding the contrast-aware index of Tandon et al., "CAMBI: Contrast-aware
// Multiscale Banding Index", PCS 2021, https://arxiv.org/abs/2102.00079; the difference to a reference is FLIP, Andersson et
// al., "FLIP: A Difference Evaluator for Alternating Images", PACMCGIT 3(2), 2020, https://doi.org/10.1145/3406183;
// lightness is CIE 1976 L*a*b* (CIE 15:2004) with the D65 white of IEC 61966-2-1 sRGB; the shutter that motion blur
// must fill is the 180 degree shutter of docs/shots.md.

/** A bound per check for a named look family. `natural` has none: every check keeps its default. */
export const LOOK_FAMILY_BOUNDS: Readonly<Record<string, Readonly<Record<string, LookBound>>>> = Object.freeze({
  natural: Object.freeze({}),
  animatedFeature: Object.freeze({
    // T1 no grain (codes, ppm), T2 no banding (percent), T3 no aliasing (percent), T4 no shimmer, T5 readable shapes
    // (percent of outline, percent of mask), T6 rich bounce light (percent, b* points, FLIP), T7 colour that survives
    // YouTube (percent of one-pixel colour edges), T8 motion (percent of fast edges with too little blur).
    grain: [0, 0.5] as [number, number],
    penumbra: [0, 0.7] as [number, number],
    penumbraPlants: [0, 1] as [number, number],
    speckle: [0, 5] as [number, number],
    banding: [0, 0.2] as [number, number],
    stairs: [0, 1] as [number, number],
    shimmer: [0, 0.1] as [number, number],
    flicker: [0, 0.3] as [number, number],
    shimmerMoving: [0, 0.5] as [number, number],
    silhouette: [80, 100] as [number, number],
    silhouetteShape: [70, 100] as [number, number],
    bounce: [10, 35] as [number, number],
    shadowTint: [3, 100] as [number, number],
    crush: [0, 0.1] as [number, number],
    reference: [0, 0.04] as [number, number],
    colourEdges: [0, 10] as [number, number],
    chromaSmear: [0, 2] as [number, number],
    motionBlur: [0, 5] as [number, number],
  }),
});

/**
 * The share of its fine detail a master frame must keep after a platform re-encode (T7, `detailKept` of the shot tool's
 * master check), per look family: 0.5 for `natural`, 0.6 for `animatedFeature`.
 */
export const LOOK_FAMILY_DETAIL_KEPT: Readonly<Record<string, number>> = Object.freeze({
  natural: 0.5,
  animatedFeature: 0.6,
});

/** The `detailKept` floor of a look family (a missing or null family is `natural`). @throws RangeError for an unknown family. */
export function detailKeptFloor(family?: string | null): number {
  const floor = LOOK_FAMILY_DETAIL_KEPT[family ?? 'natural'];
  if (floor === undefined)
    throw rangeError(`Unknown look family ${String(family)}; use one of ${LOOK_FAMILY_NAMES.join(', ')}`, 'headless');
  return floor;
}

/** The names of the look families, `natural` first. */
export const LOOK_FAMILY_NAMES: readonly string[] = Object.freeze(Object.keys(LOOK_FAMILY_BOUNDS));

/**
 * The bounds of a look family, to pass as `lookBounds` (a shot's own `lookBounds` replace them by name).
 * @throws RangeError for a family not in {@link LOOK_FAMILY_NAMES}.
 */
export function familyBounds(family: string): Record<string, LookBound> {
  const bounds = LOOK_FAMILY_BOUNDS[family];
  if (!bounds)
    throw rangeError(`Unknown look family ${String(family)}; use one of ${LOOK_FAMILY_NAMES.join(', ')}`, 'headless');
  return Object.fromEntries(Object.entries(bounds).map(([name, bound]) => [name, [...(bound as [number, number])]]));
}

const srgbToLinear = (code: number) => {
  const c = code / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const cieF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
/** CIE L*, a* and b* of an 8-bit sRGB pixel (D65). */
function lab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r),
    lg = srgbToLinear(g),
    lb = srgbToLinear(b),
    x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047,
    y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb,
    z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883,
    fy = cieF(y);
  return [116 * fy - 16, 500 * (cieF(x) - fy), 200 * (fy - cieF(z))];
}
function labPlanes(frame: LookImage): [Float32Array, Float32Array, Float32Array] {
  const n = frame.width * frame.height,
    L = new Float32Array(n),
    A = new Float32Array(n),
    B = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4)
    [L[i], A[i], B[i]] = lab(frame.data[j], frame.data[j + 1], frame.data[j + 2]);
  return [L, A, B];
}

// Strong one-step edges of a plane: every step between a pixel and its right or lower neighbour over `strong`. A step
// is a hard stair step when nothing lies between the two plateaus it joins: in the 3 x 4 window of the two pixels, no
// value is further than a tenth of the window's range from both its lowest and its highest. An antialiased edge has
// edge pixels of partial coverage near it, whatever its slope (an edge close to a pixel axis puts one pixel of
// coverage c in each row, and c may be 0.1: that step is a tenth of the climb on one side and nine tenths on the
// other, so judging the step against the climb along one row misreads it); a pixel-aliased edge has none. Thin
// features resolved to partial coverage have a middle value too. A straight vertical or horizontal edge on a pixel
// boundary (a wall, a window frame, a one pixel line) repeats the same hard step along its neighbours, is one clean
// edge, and is not a stair.
function hardEdges(plane: Float32Array, width: number, height: number, strong: number, inside: Uint8Array) {
  let edges = 0,
    hard = 0;
  for (const [step, along] of [
    [1, width],
    [width, 1],
  ]) {
    // `step` is the offset of the neighbour the step goes to, `along` the offset along the edge.
    for (let y = 2; y < height - 2; y++)
      for (let x = 2; x < width - 2; x++) {
        const i = y * width + x;
        if (!inside[i]) continue;
        const d = plane[i + step] - plane[i];
        if (Math.abs(d) <= strong) continue;
        edges++;
        const sign = Math.sign(d);
        let axis = true;
        for (const side of [-along, along]) {
          const e = plane[i + side + step] - plane[i + side];
          if (!(Math.sign(e) === sign && Math.abs(e) >= 0.75 * Math.abs(d))) axis = false;
        }
        if (axis) continue;
        let low = Infinity,
          high = -Infinity;
        for (const centre of [i, i + step])
          for (let a = -1; a <= 1; a++)
            for (let b = -1; b <= 1; b++) {
              const v = plane[centre + a * along + b * step];
              if (v < low) low = v;
              if (v > high) high = v;
            }
        const margin = 0.1 * (high - low);
        let middle = false;
        for (const centre of [i, i + step])
          for (let a = -1; a <= 1 && !middle; a++)
            for (let b = -1; b <= 1; b++) {
              const v = plane[centre + a * along + b * step];
              if (v > low + margin && v < high - margin) {
                middle = true;
                break;
              }
            }
        if (!middle) hard++;
      }
  }
  return { edges, hard };
}

/** Options of {@link stairs} and {@link colourEdges}. */
export interface EdgeOptions extends RegionOptions {
  /** A step this large between neighbours is a strong edge: 24 codes of luma (or L*), 24 of a* or b*. Default 24. */
  strong?: number;
}

/**
 * T3: percent of the strong luma edges (a step over 24 codes) that are hard, one pixel stair steps with no value
 * between the two plateaus in their 3 x 3 window. A frame supersampled and resolved has none; a pixel-aliased edge is all of them.
 */
export function stairs(frame: LookImage, { mask, strong = 24, bound }: EdgeOptions = {}): LookResult {
  const y = luma(frame),
    { edges, hard } = hardEdges(y, frame.width, frame.height, strong, maskBits(frame, mask, 'stairs'));
  return result('stairs', percent(hard, edges), bound, { edges, hard });
}

/**
 * T7: percent of the strong colour edges (a step over 24 in a* or b*) that are one pixel wide. H.264 at 4:2:0 halves the
 * colour detail, so a colour edge narrower than two pixels is smeared by the encoder: red fire and red skies first.
 */
export function colourEdges(frame: LookImage, { mask, strong = 24, bound }: EdgeOptions = {}): LookResult {
  const [, A, B] = labPlanes(frame),
    inside = maskBits(frame, mask, 'colourEdges'),
    a = hardEdges(A, frame.width, frame.height, strong, inside),
    b = hardEdges(B, frame.width, frame.height, strong, inside),
    edges = a.edges + b.edges,
    hard = a.hard + b.hard;
  return result('colourEdges', percent(hard, edges), bound, { edges, hard });
}

/** Options of {@link chromaSmear}. */
export interface ChromaSmearOptions extends RegionOptions {
  /** A pixel whose CIE76 colour difference after the 4:2:0 round trip is over this is smeared. Default 6, clearly visible side by side. */
  threshold?: number;
}

/**
 * T7: percent of the pixels whose colour moves visibly when the frame is cut to 4:2:0 chroma, as a platform's H.264
 * encode does before any quantisation. The frame goes to BT.709 Y'CbCr (full range), Cb and Cr are averaged over
 * each 2 x 2 block (the frame's edge blocks use the pixels they have) and read back with the bilinear sampling a
 * player uses (the block centres, linear between them), and each pixel's CIE76 difference is counted over
 * `threshold`. It needs no encoder, so it runs on any frame, and finds the colour detail an encode will lose: where
 * {@link colourEdges} counts the edges that are one pixel wide, this counts what that loss does.
 */
export function chromaSmear(frame: LookImage, { mask, threshold = 6, bound }: ChromaSmearOptions = {}): LookResult {
  const { width, height, data } = frame,
    n = width * height,
    inside = maskBits(frame, mask, 'chromaSmear'),
    Y = new Float32Array(n),
    cb = new Float32Array(n),
    cr = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j],
      g = data[j + 1],
      b = data[j + 2],
      y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    Y[i] = y;
    cb[i] = (b - y) / 1.8556;
    cr[i] = (r - y) / 1.5748;
  }
  const bw = (width + 1) >> 1,
    bh = (height + 1) >> 1,
    blockCb = new Float32Array(bw * bh),
    blockCr = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      let sb = 0,
        sr = 0,
        count = 0;
      for (let y = by * 2; y < Math.min(height, by * 2 + 2); y++)
        for (let x = bx * 2; x < Math.min(width, bx * 2 + 2); x++) {
          sb += cb[y * width + x];
          sr += cr[y * width + x];
          count++;
        }
      blockCb[by * bw + bx] = sb / count;
      blockCr[by * bw + bx] = sr / count;
    }
  // Block k's chroma sits at pixel 2k + 0.5; a pixel at x reads blocks around (x - 0.5) / 2.
  const sample = (plane: Float32Array, x: number, y: number) => {
    const fx = Math.min(Math.max((x - 0.5) / 2, 0), bw - 1),
      fy = Math.min(Math.max((y - 0.5) / 2, 0), bh - 1),
      x0 = Math.floor(fx),
      y0 = Math.floor(fy),
      x1 = Math.min(x0 + 1, bw - 1),
      y1 = Math.min(y0 + 1, bh - 1),
      tx = fx - x0,
      ty = fy - y0;
    return (
      (plane[y0 * bw + x0] * (1 - tx) + plane[y0 * bw + x1] * tx) * (1 - ty) +
      (plane[y1 * bw + x0] * (1 - tx) + plane[y1 * bw + x1] * tx) * ty
    );
  };
  const clamp = (v: number) => Math.min(255, Math.max(0, v));
  let counted = 0,
    smeared = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!inside[i]) continue;
      const u = sample(blockCb, x, y),
        v = sample(blockCr, x, y),
        r = clamp(Y[i] + 1.5748 * v),
        b = clamp(Y[i] + 1.8556 * u),
        g = clamp((Y[i] - 0.2126 * r - 0.0722 * b) / 0.7152),
        j = i * 4,
        [L0, a0, b0] = lab(data[j], data[j + 1], data[j + 2]),
        [L1, a1, b1] = lab(r, g, b);
      counted++;
      if (Math.hypot(L0 - L1, a0 - a1, b0 - b1) > threshold) smeared++;
    }
  return result('chromaSmear', percent(smeared, counted), bound, { pixels: counted, smeared });
}

/** Options of {@link penumbra}. */
export interface PenumbraOptions {
  /** The shadow penumbra mask. */
  mask?: LookMask;
  /** Where the plants are (the `plants` page mask): left out, so the grain is read on the ground alone. */
  plants?: LookMask;
  bound?: LookBound;
}

/**
 * The fewest interior pixels {@link penumbra} and {@link penumbraPlants} read a grain from: 2,055, where the estimate's
 * relative standard error is 5 percent. Immerkaer's value is a mean of absolute Laplacian responses; for Gaussian noise
 * each one's standard deviation is sqrt(pi / 2 - 1) = 0.756 of its mean, and a response shares pixels with the 8 around
 * it, so about one in 9 is independent: (3 x 0.756 / 0.05)^2 = 2,055.
 */
export const PENUMBRA_MIN_PIXELS = Math.ceil(((3 * Math.sqrt(Math.PI / 2 - 1)) / 0.05) ** 2);

// Foliage texture detail is not shadow noise. Immerkaer's estimator assumes a region without fine structure, so on a
// plant (leaves, needles, bark) it reads the plant's own detail as grain: on the timber valley rail-line shot, calm,
// plants inside the penumbra read 1.218 and 0.921 codes and plants out of it, where no shadow filter runs, 1.610 and
// 1.289, against 0.558 and 0.504 on the ground in the penumbra (KB-LOOK-TV-PENUMBRA2). Edge pixels bias the estimate
// upward (Tai and Yang, "A fast method for image noise estimation using Laplacian operator and adaptive edge
// detection", ISCCSP 2008, https://doi.org/10.1109/ISCCSP.2008.4537384), so T1 reads the ground, where the estimate
// holds, and holds the plants to their own detail elsewhere in the same frame.
function without(frame: LookImage, mask: LookMask | undefined, plants: LookMask | undefined, what: string) {
  const inside = maskBits(frame, mask, what),
    out = plants ? maskBits(frame, plants, 'plants') : new Uint8Array(inside.length),
    keep = new Uint8Array(inside.length);
  for (let i = 0; i < keep.length; i++) keep[i] = inside[i] && !out[i] ? 255 : 0;
  return keep;
}
function both(frame: LookImage, a: LookMask, b: LookMask, what: string, invert = false) {
  const x = maskBits(frame, a, what),
    y = maskBits(frame, b, 'plants'),
    keep = new Uint8Array(x.length);
  for (let i = 0; i < keep.length; i++) keep[i] = y[i] && (invert ? !x[i] : x[i]) ? 255 : 0;
  return keep;
}
function tooFew(row: LookResult, check: string, what: string): LookResult {
  return row.detail.pixels >= PENUMBRA_MIN_PIXELS
    ? row
    : {
        ...row,
        check,
        value: Number.NaN,
        pass: false,
        missing: `${PENUMBRA_MIN_PIXELS} interior pixels of ${what} (${row.detail.pixels} found)`,
      };
}

/**
 * T1 in shadow penumbras: the grain of the ground inside the `penumbra` mask, the `plants` mask left out (bound 0.7
 * codes for the family), over at least {@link PENUMBRA_MIN_PIXELS} interior pixels. Plants in the penumbra are held by
 * {@link penumbraPlants}.
 */
export function penumbra(frame: LookImage, { mask, plants, bound }: PenumbraOptions = {}): LookResult {
  const row = {
    ...grain(frame, {
      mask: { width: frame.width, height: frame.height, data: without(frame, mask, plants, 'penumbra') },
      bound: bound ?? LOOK_CHECKS.penumbra.bound,
    }),
    check: 'penumbra',
  };
  return tooFew(row, 'penumbra', plants ? 'penumbra ground' : 'penumbra');
}

/** Options of {@link penumbraPlants}. */
export interface PenumbraPlantsOptions {
  /** The shadow penumbra mask. */
  penumbra: LookMask;
  /** Where the plants are (the `plants` page mask). */
  plants: LookMask;
  bound?: LookBound;
}

/**
 * T1 on plants in shadow penumbras: the grain of the plants inside the `penumbra` mask over the grain of the plants
 * outside it, where no shadow filter runs (fully lit or fully shadowed), in the same frame (bound 1: the penumbra adds
 * no noise to the plants' own detail). Each side reads at least {@link PENUMBRA_MIN_PIXELS} interior pixels.
 */
export function penumbraPlants(frame: LookImage, { penumbra, plants, bound }: PenumbraPlantsOptions): LookResult {
  const { width, height } = frame,
    use = bound ?? LOOK_CHECKS.penumbraPlants.bound,
    inside = tooFew(
      grain(frame, { mask: { width, height, data: both(frame, penumbra, plants, 'penumbra') } }),
      'penumbraPlants',
      'plants in the penumbra',
    ),
    outside = tooFew(
      grain(frame, { mask: { width, height, data: both(frame, penumbra, plants, 'penumbra', true) } }),
      'penumbraPlants',
      'plants out of the penumbra',
    ),
    detail = {
      inside: inside.value,
      outside: outside.value,
      pixels: inside.detail.pixels,
      outsidePixels: outside.detail.pixels,
    };
  const short = inside.missing ?? outside.missing;
  if (short || !outside.value)
    return {
      ...result('penumbraPlants', Number.NaN, use, detail),
      pass: false,
      missing: short ?? 'grain on the plants out of the penumbra',
    };
  return result('penumbraPlants', inside.value / outside.value, use, detail);
}

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
   * The shutter angle the frame was exposed with, in degrees (more than 0, up to 360), for `motionBlur`. Default 180,
   * the film standard: a frame drawn without sub-frames is still judged against a 180 degree smear.
   */
  shutter?: number;
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
 * T4 while moving: frame n is warped onto n + 1 by its motion (`reprojectionMotion` makes it from the depth and the two
 * view-projections), and the percent of pixels whose warped luma differs from the next frame by more than `threshold`
 * (6 codes) is the shimmer. Pixels whose target leaves the frame are not counted.
 */
export function shimmerMoving(
  frame: LookImage,
  { next, motion }: MovingFrames,
  { mask, bound, threshold = 6 }: FlickerOptions & { threshold?: number } = {},
): LookResult {
  const { width, height } = frame;
  sameSize(frame, next, 'next frame');
  sameSize(frame, motion, 'motion');
  if (motion.data.length !== width * height * 2)
    throw rangeError('The motion holds two floats (x, y) per pixel', 'headless');
  const a = luma(frame),
    b = luma(next),
    inside = maskBits(frame, mask, 'shimmerMoving');
  let count = 0,
    off = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!inside[i]) continue;
      const tx = x + motion.data[i * 2],
        ty = y + motion.data[i * 2 + 1];
      if (!(tx >= 0 && ty >= 0 && tx <= width - 1 && ty <= height - 1)) continue;
      count++;
      if (Math.abs(a[i] - sampleLuma(b, width, height, tx, ty)) > threshold) off++;
    }
  return result('shimmerMoving', percent(off, count), bound, { pixels: count, off });
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
 * crosses the middle value within one pixel of the pixel itself; the edge's width is the part of the profile between 10
 * and 90 percent of its range. A hard edge is under a pixel wide, a blurred one as wide as its smear.
 * @throws RangeError for a shutter that is not more than 0 and up to 360 degrees.
 */
export function motionBlur(
  frame: LookImage,
  motion: LookMotion,
  { mask, bound, minimum = 8, shutter = 180 }: FlickerOptions & { minimum?: number; shutter?: number } = {},
): LookResult {
  const { width, height } = frame;
  sameSize(frame, motion, 'motion');
  if (motion.data.length !== width * height * 2)
    throw rangeError('The motion holds two floats (x, y) per pixel', 'headless');
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
      const mx = motion.data[i * 2],
        my = motion.data[i * 2 + 1],
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
        between = profile.filter((v) => v > from && v < to).length;
      if (between * spacing < (travel * smear) / 2) sharp++;
    }
  return result('motionBlur', percent(sharp, edges), bound, { edges, sharp });
}

/** Options of the subject checks. */
export interface SilhouetteOptions {
  /** The subject's mask: required. */
  subject: LookMask;
  bound?: LookBound;
}

/**
 * T5: percent of the subject's outline pixels where the subject differs from what is behind it by at least `contrast`
 * (15) L*: the mean L* of the subject pixels in the 3 x 3 window against the mean of the others.
 */
export function silhouette(
  frame: LookImage,
  { subject, bound, contrast = 15 }: SilhouetteOptions & { contrast?: number },
): LookResult {
  const { width, height } = frame,
    inside = maskBits(frame, subject, 'silhouette'),
    [L] = labPlanes(frame);
  let outline = 0,
    clear = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!inside[i] || (inside[i - 1] && inside[i + 1] && inside[i - width] && inside[i + width])) continue;
      const sum = [0, 0],
        n = [0, 0];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const j = i + dy * width + dx,
            k = inside[j] ? 1 : 0;
          sum[k] += L[j];
          n[k]++;
        }
      outline++;
      if (n[0] && n[1] && Math.abs(sum[1] / n[1] - sum[0] / n[0]) >= contrast) clear++;
    }
  return result('silhouette', percent(clear, outline), bound, { outline, clear });
}

/**
 * T5 at a glance: the frame reduced to 320 x 180 (box filter) and its L* cut into three values (thirds of 0 to 100); the
 * percent of the subject's mask (a reduced pixel is the subject when half of it is) that sits in one value. A subject
 * that reads as one shape sits in one.
 */
export function silhouetteShape(frame: LookImage, { subject, bound }: SilhouetteOptions): LookResult {
  const { width, height } = frame,
    inside = maskBits(frame, subject, 'silhouetteShape'),
    [L] = labPlanes(frame),
    w = Math.min(320, width),
    h = Math.min(180, height),
    sum = new Float64Array(w * h),
    cover = new Float64Array(w * h),
    count = new Float64Array(w * h);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const k = Math.min(h - 1, Math.floor((y * h) / height)) * w + Math.min(w - 1, Math.floor((x * w) / width)),
        i = y * width + x;
      sum[k] += L[i];
      cover[k] += inside[i];
      count[k]++;
    }
  const levels = [0, 0, 0];
  let total = 0;
  for (let k = 0; k < w * h; k++) {
    if (!count[k] || cover[k] / count[k] < 0.5) continue;
    levels[Math.min(2, Math.floor(sum[k] / count[k] / (100 / 3)))]++;
    total++;
  }
  return result('silhouetteShape', percent(Math.max(...levels), total), bound, { pixels: total });
}

/** Options of {@link bounce}. */
export interface BounceOptions {
  /** Where the ground is in the sun. */
  lit: LookMask;
  /** Where the ground is in shadow. */
  shadow: LookMask;
  /**
   * The surface colour of each pixel, RGBA sRGB coded (an albedo AOV): the lit and shadowed ground are then compared
   * within strata of like albedo. Unset, all ground is one stratum.
   */
  albedo?: LookImage;
  /** The frame's colours before its 8 bits, read in its place ({@link PreciseFrame}). */
  precise?: PreciseFrame;
  /**
   * More frames of the shot whose ground is pooled with this one's, for shadow interiors too small in one frame; the
   * result's detail then gives `frames`, and `se` follows them ({@link GroundFrame}).
   */
  pool?: (GroundFrame | GroundSample)[];
  bound?: LookBound;
}

/**
 * The share of the frame's shorter side kept clear of a ground mask's edge by {@link bounce} and {@link shadowTint}:
 * 1/360, 3 pixels at 1080p and 1 at 360p (at least 1).
 */
export const GROUND_INSET = 1 / 360;

/**
 * Inside flags of pixels whose whole (2r + 1) x (2r + 1) square is inside (a binary erosion by a square, as two
 * separable passes of running counts); the frame's border counts as outside.
 */
function inset(width: number, height: number, inside: Uint8Array, r: number): Uint8Array {
  const rows = new Uint8Array(width * height),
    out = new Uint8Array(width * height),
    span = 2 * r + 1;
  for (let y = 0; y < height; y++) {
    let run = 0;
    for (let x = 0; x < width; x++) {
      run = inside[y * width + x] ? run + 1 : 0;
      if (run >= span) rows[y * width + x - r] = 1;
    }
  }
  for (let x = 0; x < width; x++) {
    let run = 0;
    for (let y = 0; y < height; y++) {
      run = rows[y * width + x] ? run + 1 : 0;
      if (run >= span) out[(y - r) * width + x] = 1;
    }
  }
  return out;
}

// A ground mask comes from a sharp capture of the scene, while the frame is resolved from supersamples and carries
// motion blur, depth of field and bloom, so a pixel on a mask's edge holds light from both sides of it: a mixed
// pixel (Fisher, "The pixel: a snare and a delusion", 1997). Lit and shadowed ground are therefore averaged over
// their interiors, as patch colour is read in a patch's centre away from its edges (ISO 14524), a GROUND_INSET of
// the frame in from every edge (KB-LOOK-TV-BOUNCE1: thin shadows between plants took the lit ground's light).
//
// T6 compares one surface in sun and in shade, and a frame's lit and shadowed ground are seldom the same surface: in
// the timber-valley blowup the shadowed ground read brighter than the lit ground (103 % bounce), which no single
// surface under one light can do, so the masks' own albedo difference outweighed the light's. With an albedo the
// ground is cut into strata of like surface (GROUND_ALBEDO_LEVELS per sRGB channel) and each stratum's lit and
// shadowed means are compared alone, the strata pooled with the Cochran-Mantel-Haenszel weight n_lit n_shadow /
// (n_lit + n_shadow) (W. G. Cochran, "Some methods for strengthening the common chi-squared tests", Biometrics 10(4),
// 417-451, 1954, https://doi.org/10.2307/3001616; N. Mantel and W. Haenszel, "Statistical aspects of the analysis of
// data from retrospective studies of disease", JNCI 22(4), 719-748, 1959, https://doi.org/10.1093/jnci/22.4.719), so
// a surface that is only lit or only shaded does not count (KB-LOOK-TV-TINTMATCH1). Without an albedo the ground is
// one stratum, as before.

/**
 * The albedo of a probe's masks: `albedo-r`, `albedo-g` and `albedo-b` (grey masks of one sRGB coded channel each, as
 * the shot tool writes an AOV) as one RGBA image, or undefined without all three.
 */
export function albedoOf(frame: { width: number; height: number }, masks: Record<string, LookMask>): LookImage | undefined {
  const planes = ['albedo-r', 'albedo-g', 'albedo-b'].map((name) => masks[name]);
  if (planes.some((plane) => !plane)) return undefined;
  const count = frame.width * frame.height,
    data = new Uint8Array(count * 4);
  planes.forEach((plane, c) => {
    sameSize(frame, plane!, `${['albedo-r', 'albedo-g', 'albedo-b'][c]} mask`);
    const step = plane!.data.length === count ? 1 : plane!.data.length === count * 4 ? 4 : 0;
    if (!step) throw rangeError('An albedo mask holds one byte or four per pixel', 'headless');
    for (let i = 0; i < count; i++) data[i * 4 + c] = plane!.data[i * step];
  });
  for (let i = 0; i < count; i++) data[i * 4 + 3] = 255;
  return { width: frame.width, height: frame.height, data };
}

/** The masks T6 reads of a pooled frame. */
const GROUND_AOVS = ['lit', 'shadow', 'albedo-r', 'albedo-g', 'albedo-b'];

/** Levels per sRGB channel of the albedo strata {@link bounce} and {@link shadowTint} compare within: 16 (16 codes). */
export const GROUND_ALBEDO_LEVELS = 16;

/** The ground pixels of one albedo stratum, lit side first: counts and sums of Y and b* and of their squares. */
export interface GroundStratum {
  n: [number, number];
  Y: [number, number];
  b: [number, number];
  /** Sums of squares of Y and b*, for the standard error. */
  Y2: [number, number];
  b2: [number, number];
}

/**
 * The frame's colours before its 8 bits (the shot tool's precise frame, `.rgb32f`): RGB floats, sRGB coded 0 to 1,
 * row 0 at the top. T6 reads it in place of the 8-bit frame, whose blue codes are 0.4 b* apart at dark ground.
 */
export interface PreciseFrame {
  width: number;
  height: number;
  data: Float32Array;
}

/**
 * A frame's ground reduced to its albedo strata ({@link groundSample}): what {@link bounce} and {@link shadowTint} read of
 * a pooled frame, a few numbers in place of its frame and masks.
 */
export interface GroundSample {
  readonly strata: ReadonlyMap<number, Readonly<GroundStratum>>;
}

/** One more frame of a shot whose ground {@link bounce} and {@link shadowTint} pool with the probe's. */
export interface GroundFrame {
  /** The frame, 8-bit; unused where `precise` is given. */
  frame?: LookImage;
  precise?: PreciseFrame;
  lit: LookMask;
  shadow: LookMask;
  albedo?: LookImage;
}

/** A frame's ground as {@link bounce} and {@link shadowTint} pool it: its strata, so the frame and masks can go. */
export function groundSample(frame: GroundFrame): GroundSample {
  return { strata: groundStrata(frame) };
}

function groundStrata({ frame, precise, lit, shadow, albedo }: GroundFrame): Map<number, GroundStratum> {
  const size = precise ?? frame;
  if (!size) throw typeError('A ground frame needs its frame or its precise frame', 'headless');
  if (precise && precise.data?.length !== precise.width * precise.height * 3)
    throw rangeError('A precise frame holds three floats per pixel (RGB, sRGB coded 0 to 1)', 'headless');
  if (precise && frame) sameSize(frame, precise, 'precise frame');
  const r = Math.max(1, Math.round(Math.min(size.width, size.height) * GROUND_INSET)),
    masks = [lit, shadow].map((mask, i) => inset(size.width, size.height, maskBits(size, mask, i ? 'shadow' : 'lit'), r));
  if (albedo) {
    sameSize(size, albedo, 'albedo');
    if (albedo.data.length !== size.width * size.height * 4)
      throw rangeError('The albedo holds four bytes per pixel (RGBA, sRGB coded)', 'headless');
  }
  const strata = new Map<number, GroundStratum>(),
    q = 256 / GROUND_ALBEDO_LEVELS;
  for (let i = 0, j = 0; i < masks[0].length; i++, j += 4) {
    if (!masks[0][i] && !masks[1][i]) continue;
    const side = masks[0][i] ? 0 : 1;
    const key = albedo
      ? (Math.floor(albedo.data[j] / q) * GROUND_ALBEDO_LEVELS + Math.floor(albedo.data[j + 1] / q)) *
          GROUND_ALBEDO_LEVELS +
        Math.floor(albedo.data[j + 2] / q)
      : 0;
    let at = strata.get(key);
    if (!at) strata.set(key, (at = { n: [0, 0], Y: [0, 0], b: [0, 0], Y2: [0, 0], b2: [0, 0] }));
    // Codes 0 to 255, fractional from the precise frame.
    const [R, G, B] = precise
        ? [precise.data[i * 3] * 255, precise.data[i * 3 + 1] * 255, precise.data[i * 3 + 2] * 255]
        : [frame!.data[j], frame!.data[j + 1], frame!.data[j + 2]],
      Y = 0.2126729 * srgbToLinear(R) + 0.7151522 * srgbToLinear(G) + 0.072175 * srgbToLinear(B),
      b = lab(R, G, B)[2];
    at.n[side]++;
    at.Y[side] += Y;
    at.b[side] += b;
    at.Y2[side] += Y * Y;
    at.b2[side] += b * b;
  }
  return strata;
}

/** A side of a stratum: its mean Y and b* and the variance of each mean. */
interface GroundSide {
  Y: number;
  b: number;
  varY: number;
  varB: number;
}

type GroundValue = (lit: GroundSide, shadow: GroundSide) => number;

/**
 * The strata's pooled `value(lit, shadow)` with the Cochran-Mantel-Haenszel weights, and its standard error from
 * `variance(lit, shadow)` pooled with the squared weights: `lit` and `shadow` count the masks' interiors, `matched` the
 * pixels in strata both sides hold, `strata` those strata.
 */
function poolStrata(strata: Iterable<GroundStratum>, value: GroundValue, variance: GroundValue) {
  let lit = 0,
    shadow = 0,
    matched = 0,
    count = 0,
    sum = 0,
    weights = 0,
    spread = 0;
  for (const at of strata) {
    lit += at.n[0];
    shadow += at.n[1];
    if (!at.n[0] || !at.n[1]) continue;
    const side = (k: number): GroundSide => {
        const n = at.n[k],
          Y = at.Y[k] / n,
          b = at.b[k] / n,
          // The sample variance (over n - 1), over n again for the mean's; one pixel gives none.
          v = (s2: number, m: number) => (n > 1 ? Math.max(0, s2 - n * m * m) / (n - 1) / n : 0);
        return { Y, b, varY: v(at.Y2[k], Y), varB: v(at.b2[k], b) };
      },
      l = side(0),
      s = side(1),
      v = value(l, s);
    if (!Number.isFinite(v)) continue;
    const w = (at.n[0] * at.n[1]) / (at.n[0] + at.n[1]);
    matched += at.n[0] + at.n[1];
    count++;
    sum += w * v;
    weights += w;
    spread += w * w * variance(l, s);
  }
  return {
    value: weights ? sum / weights : Number.NaN,
    se: weights ? Math.sqrt(spread) / weights : Number.NaN,
    lit,
    shadow,
    matched,
    strata: count,
  };
}

/**
 * The probe's value with the frames of `options.pool` pooled in, every frame's strata summed as one larger frame.
 * `se` is the value's standard error: with one frame the pixels' (strata pooled with the squared weights), with more
 * the larger of that and the batch-means error, each frame one batch, the spread of the frames' own values over the
 * root of their count (B. Schmeiser, "Batch size effects in the analysis of simulation output", Operations Research
 * 30(3), 556-568, 1982, https://doi.org/10.1287/opre.30.3.556): neighbouring frames see much the same ground, so their
 * pixels are not independent and the pixels' error alone would claim too much (KB-LOOK-TV-TINTRES1).
 */
function pooled(options: BounceOptions, frame: LookImage, value: GroundValue, variance: GroundValue) {
  const frames: (GroundFrame | GroundSample)[] = [{ ...options, frame }, ...(options.pool ?? [])],
    all = new Map<number, GroundStratum>(),
    each: number[] = [];
  for (const one of frames) {
    const strata = 'strata' in one ? one.strata : groundStrata(one),
      own = poolStrata(strata.values(), value, variance).value;
    if (Number.isFinite(own)) each.push(own);
    for (const [key, at] of strata) {
      const to = all.get(key);
      // A copy: a sample may be pooled again by the next check.
      if (!to) all.set(key, { n: [...at.n], Y: [...at.Y], b: [...at.b], Y2: [...at.Y2], b2: [...at.b2] });
      else
        for (const field of ['n', 'Y', 'b', 'Y2', 'b2'] as const)
          for (const k of [0, 1]) to[field][k] += at[field][k];
    }
  }
  const p = poolStrata(all.values(), value, variance);
  let se = p.se;
  if (each.length > 1) {
    const mean = each.reduce((a, v) => a + v, 0) / each.length;
    se = Math.max(se, Math.sqrt(each.reduce((a, v) => a + (v - mean) ** 2, 0) / (each.length - 1) / each.length));
  }
  const detail: Record<string, number> = options.albedo
    ? { lit: p.lit, shadow: p.shadow, matched: p.matched, strata: p.strata }
    : { lit: p.lit, shadow: p.shadow };
  if (Number.isFinite(se)) detail.se = Math.round(se * 1e4) / 1e4;
  if (frames.length > 1) detail.frames = frames.length;
  return { value: p.value, detail };
}

function groundCheck(
  name: 'bounce' | 'shadowTint',
  frame: LookImage,
  options: BounceOptions,
  value: GroundValue,
  variance: GroundValue,
): LookResult {
  const { value: v, detail } = pooled(options, frame, value, variance);
  if (!Number.isFinite(v))
    return {
      ...result(name, Number.NaN, options.bound, detail),
      pass: false,
      missing: options.albedo ? 'lit and shadowed ground of a like albedo' : 'lit and shadowed ground pixels',
    };
  return result(name, v, options.bound, detail);
}

/**
 * T6: the mean luminance of the shadowed ground as a percent of the lit ground's, in linear light, each averaged over
 * its mask's interior ({@link GROUND_INSET} in from the edges, where the frame mixes both sides). Shadow that holds
 * 10 to 35 percent of the sunlit value carries bounce and sky light; under 10 is crushed, over 35 flat. With
 * `albedo` the lit and shadowed ground are compared surface for like surface ({@link GROUND_ALBEDO_LEVELS}).
 */
export function bounce(frame: LookImage, { lit, shadow, bound }: BounceOptions): LookResult;
export function bounce(frame: LookImage, options: BounceOptions): LookResult {
  return groundCheck(
    'bounce',
    frame,
    options,
    (l, s) => (l.Y ? (100 * s.Y) / l.Y : Number.NaN),
    // The ratio's variance by the delta method.
    (l, s) => (l.Y ? 1e4 * (s.varY / l.Y ** 2 + (s.Y ** 2 * l.varY) / l.Y ** 4) : 0),
  );
}

/**
 * T6: how much cooler (lower b*) the shadowed ground is than the lit ground, in CIE b* points (at least 3), over the
 * masks' interiors and, with `albedo`, surface for like surface, as {@link bounce}.
 */
export function shadowTint(frame: LookImage, { lit, shadow, bound }: BounceOptions): LookResult;
export function shadowTint(frame: LookImage, options: BounceOptions): LookResult {
  return groundCheck(
    'shadowTint',
    frame,
    options,
    (l, s) => l.b - s.b,
    (l, s) => l.varB + s.varB,
  );
}

/**
 * The light a frame was shaded with, as the shot tool records it from the engine: the sun as core holds it and the
 * diffuse light on level ground. Both are in the engine light's units, so level ground of albedo a takes
 * a x `intensity` x `colour` x max(`direction`[1], 0) / pi from the sun and a x `ambient` from the sky.
 */
export interface LookLight {
  /** The sun (or moon): `direction` toward it, unit; `intensity`; `colour`, linear RGB. */
  sun: { direction: readonly number[]; intensity: number; colour: readonly number[] };
  /** The diffuse light on level ground: irradiance over pi, linear RGB (the sky's harmonics, or core's ambient). */
  ambient: readonly number[];
}

/**
 * Erbs, Klein and Duffie's diffuse fraction of global horizontal light for an hourly clearness index `kt` ("Estimation
 * of the diffuse radiation fraction for hourly, daily and monthly-average global radiation", Solar Energy 28(4),
 * 293-302, 1982, https://doi.org/10.1016/0038-092X(82)90302-4).
 */
export function erbsDiffuseFraction(kt: number): number {
  if (!Number.isFinite(kt) || kt < 0)
    throw rangeError('erbsDiffuseFraction needs a clearness index of 0 or more', 'headless');
  if (kt <= 0.22) return 1 - 0.09 * kt;
  if (kt <= 0.8) return 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  return 0.165;
}

/**
 * The diffuse fraction up to which a sun counts as clear, where T6 keeps its sunlit limits (10 to 35 percent, 3 b*):
 * {@link erbsDiffuseFraction} at the clearness index 0.65 above which a sky is clear (0 to 0.3 overcast, 0.3 to 0.65
 * intermediate: A. H. Fakra, H. Boyer, F. Miranville, D. Bigot, "A simple evaluation of global and diffuse luminous
 * efficacy for all sky conditions in tropical and humid climate", Renewable Energy 36(1), 298-306, 2011,
 * https://arxiv.org/abs/1212.5259), 0.3336.
 */
export const CLEAR_SUN_DIFFUSE = erbsDiffuseFraction(0.65);

/** What {@link lightBounds} gives: the T6 limits for a light and the diffuse fraction they follow. */
export interface LightBounds {
  /** The share of level ground's light that is diffuse, 0 to 1: ambient luminance over ambient plus the sun's. */
  diffuse: number;
  bounce: [number, number];
  shadowTint: [number, number];
}

const lightLuminance = (c: readonly number[]) => 0.2126729 * c[0] + 0.7151522 * c[1] + 0.072175 * c[2];

/**
 * The T6 limits that follow a frame's own light (KB-LOOK-TV-PALL1). Level ground in the open takes the sun's beam and
 * the sky's diffuse light; a cast shadow loses the beam and keeps the sky it still sees plus the light bounced into it,
 * both in proportion to the diffuse light. So the share a shadow holds scales with the diffuse fraction d of the lit
 * ground's light, and the cooling it shows with the beam's share 1 - d. Up to {@link CLEAR_SUN_DIFFUSE} (a clear sun)
 * the limits are `base` unchanged; above it `bounce` is base x d / CLEAR_SUN_DIFFUSE (the high end at most 100) and the
 * low end of `shadowTint` base x (1 - d) / (1 - CLEAR_SUN_DIFFUSE). A smoke pall or an overcast sky, nearly all diffuse
 * light, so asks for shadows near the lit ground and little tint, as measured under one (Garcia et al., Atmos. Meas.
 * Tech. 19, 3151-3167, 2026, https://doi.org/10.5194/amt-19-3151-2026), and never for crushed shadows.
 * `base` defaults to the checks' defaults (10 to 35 percent, 3 to 100 b*).
 */
export function lightBounds(light: LookLight, base: { bounce?: LookBound; shadowTint?: LookBound } = {}): LightBounds {
  const sun = light?.sun,
    vec = (v: unknown, n: number): v is number[] =>
      Array.isArray(v) && v.length >= n && v.slice(0, n).every((x) => Number.isFinite(x));
  if (!sun || !vec(sun.direction, 3) || !Number.isFinite(sun.intensity) || sun.intensity < 0 || !vec(sun.colour, 3))
    throw rangeError(
      'lightBounds needs light.sun with a direction, an intensity of 0 or more and a colour',
      'headless',
    );
  if (!vec(light.ambient, 3) || light.ambient.some((c) => c < 0) || sun.colour.some((c) => c < 0))
    throw rangeError('lightBounds needs a light.ambient and sun colour of three non-negative numbers', 'headless');
  const length = Math.hypot(sun.direction[0], sun.direction[1], sun.direction[2]) || 1,
    beam = (sun.intensity * lightLuminance(sun.colour) * Math.max(sun.direction[1] / length, 0)) / Math.PI,
    sky = lightLuminance(light.ambient),
    diffuse = sky + beam > 0 ? sky / (sky + beam) : 1,
    [bLow, bHigh] = base.bounce === undefined ? LOOK_CHECKS.bounce.bound : lookBound(base.bounce),
    [tLow, tHigh] = base.shadowTint === undefined ? LOOK_CHECKS.shadowTint.bound : lookBound(base.shadowTint);
  if (diffuse <= CLEAR_SUN_DIFFUSE) return { diffuse, bounce: [bLow, bHigh], shadowTint: [tLow, tHigh] };
  const up = diffuse / CLEAR_SUN_DIFFUSE,
    cool = (1 - diffuse) / (1 - CLEAR_SUN_DIFFUSE);
  return {
    diffuse,
    bounce: [Math.min(100, bLow * up), Math.min(100, bHigh * up)],
    shadowTint: [tLow * cool, tHigh],
  };
}

/** T7 at night: the mean luma of the frame, in codes (at least 24, a night that still reads on a phone). */
export function nightLuma(frame: LookImage, { mask, bound }: RegionOptions = {}): LookResult {
  const y = luma(frame),
    inside = maskBits(frame, mask, 'nightLuma');
  let sum = 0,
    n = 0;
  for (let i = 0; i < y.length; i++) if (inside[i]) (sum += y[i]), n++;
  return result('nightLuma', n ? sum / n : 0, bound, { pixels: n });
}

/** T7 at night: the luma the brightest 1 percent of the frame reaches, in codes (over 180: a night has its lights). */
export function nightPeak(frame: LookImage, { mask, bound }: RegionOptions = {}): LookResult {
  const y = luma(frame),
    inside = maskBits(frame, mask, 'nightPeak'),
    values: number[] = [];
  for (let i = 0; i < y.length; i++) if (inside[i]) values.push(y[i]);
  values.sort((p, q) => p - q);
  return result(
    'nightPeak',
    values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.99))] : 0,
    bound,
    {
      pixels: values.length,
    },
  );
}
