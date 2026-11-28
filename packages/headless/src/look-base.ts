// Foundations of the look checks: the frame and result types, the bound table (LOOK_CHECKS) and the helpers every check
// uses. Split from look.ts along this seam; look.ts re-exports every name.
import type { HeadlessPixels } from './index.js';
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
      about: 'pixels over 6 codes outside the four pixels their camera motion lands between',
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

export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The `[low, high]` of a bound: a number is the high end, with no low end. */
export function lookBound(bound: LookBound): [number, number] {
  if (finite(bound)) return [-Infinity, bound];
  if (Array.isArray(bound) && bound.length === 2 && bound.every(finite) && bound[0] <= bound[1])
    return [bound[0], bound[1]];
  throw typeError('A look bound is a number or [low, high] with low <= high', 'headless');
}

export function result(
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

export function checkImage(image: LookImage, what = 'frame'): void {
  if (!image || !(image.data instanceof Uint8Array) || !(image.width > 0) || !(image.height > 0))
    throw typeError(`The ${what} must be {width, height, data: Uint8Array}`, 'headless');
  if (image.data.length !== image.width * image.height * 4)
    throw rangeError(`The ${what}'s data does not match its size`, 'headless');
}

export function sameSize(
  a: { width: number; height: number },
  b: { width: number; height: number },
  what: string,
): void {
  if (a.width !== b.width || a.height !== b.height)
    throw rangeError(
      `The ${what} is ${b.width} x ${b.height}, the frame ${a.width} x ${a.height}: they must match`,
      'headless',
    );
}

/** Inside flags of a mask, one per pixel, or all inside when no mask is given. */
export function maskBits(
  frame: { width: number; height: number },
  mask: LookMask | undefined,
  what: string,
  least = 128,
): Uint8Array {
  const count = frame.width * frame.height,
    bits = new Uint8Array(count);
  if (!mask) return bits.fill(1);
  sameSize(frame, mask, `${what} mask`);
  const step = mask.data.length === count ? 1 : mask.data.length === count * 4 ? 4 : 0;
  if (!step) throw rangeError(`The ${what} mask holds one byte or four per pixel`, 'headless');
  for (let i = 0; i < count; i++) bits[i] = mask.data[i * step] >= least ? 1 : 0;
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

export const percent = (part: number, whole: number) => (whole ? (100 * part) / whole : 0);

/** Options of {@link flicker} and {@link shimmer}. */
export interface FlickerOptions {
  /** Only pixels inside this mask count. */
  mask?: LookMask;
  bound?: LookBound;
}
