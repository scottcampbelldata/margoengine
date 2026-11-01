// Animated PNG, written from the W3C PNG specification (third edition): acTL, then fcTL plus IDAT for frame 0 and
// fcTL plus fdAT for the rest, with one sequence number shared by every fcTL and fdAT.
import { crc32 } from '../../shared/crc32.js';
import { checkCount, checked, type FrameSource } from './frames.js';

/** Options for {@link encodeAPNG}. */
export interface APNGOptions {
  /**
   * Frames per second, from 1000/65535 to 1000. A whole number is stored exactly as 1/fps s per frame; another rate as
   * whole milliseconds rounded cumulatively, so the total stays exact to the millisecond. Default 30.
   */
  fps?: number;
  /** How many times the animation plays; 0 loops forever. Default 0. */
  loops?: number;
  /**
   * What happens to a frame's area before the next one: `'none'` keeps it, `'background'` clears it to transparent,
   * `'previous'` restores what was there. Default `'none'`.
   */
  dispose?: 'none' | 'background' | 'previous';
  /**
   * `'source'` replaces the area, alpha included, so a cut-out sprite never shows the frame before it; `'over'` draws
   * on top of it. Default `'source'`.
   */
  blend?: 'source' | 'over';
}

const DISPOSE = { none: 0, background: 1, previous: 2 } as const,
  BLEND = { source: 0, over: 1 } as const;

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12),
    view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)));
  return out;
}

/**
 * Lossless animated PNG (APNG, the PNG third edition's animation chunks): one RGBA frame per `frame(index)`, all the
 * same size, deflated with CompressionStream, so it runs anywhere, Node included. A viewer without APNG support shows
 * frame 0 as a plain PNG.
 * @example
 * ```ts
 * import {encodeAPNG} from 'margoengine/exporters/apng';
 * const red = {data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1};
 * const clear = {data: new Uint8Array(4), width: 1, height: 1};
 * const file: Uint8Array = await encodeAPNG(2, (i) => (i ? clear : red), {fps: 12});
 * ```
 * @throws RangeError for a count that is not a whole number >= 1, fps or loops out of range, or frames of different
 * sizes. TypeError for an unknown `dispose` or `blend`.
 */
export async function encodeAPNG(
  count: number,
  frame: FrameSource,
  { fps = 30, loops = 0, dispose = 'none', blend = 'source' }: APNGOptions = {},
): Promise<Uint8Array> {
  checkCount(count);
  if (!(fps >= 1000 / 65535 && fps <= 1000))
    throw new RangeError(`APNG fps ${fps} is outside 1000/65535..1000; pass a frame rate those delays can hold`);
  if (!(Number.isInteger(loops) && loops >= 0 && loops <= 0x7fffffff))
    throw new RangeError(`APNG loops ${loops} is invalid; pass a whole number >= 0 (0 loops forever)`);
  if (!Object.hasOwn(DISPOSE, dispose))
    throw new TypeError(`APNG dispose ${dispose} is unknown; pass none, background or previous`);
  if (!Object.hasOwn(BLEND, blend)) throw new TypeError(`APNG blend ${blend} is unknown; pass source or over`);
  const { png } = await import('./png.js'),
    parts: Uint8Array[] = [],
    whole = Number.isInteger(fps);
  let sequence = 0,
    width = 0,
    height = 0;
  for (let index = 0; index < count; index++) {
    const pixels = checked(await frame(index));
    // The encoder's PNG is signature (8), IHDR (25), one IDAT, IEND (12): frame 0 keeps the IDAT as it is.
    const file = await png(pixels, Infinity, false),
      idat = file.subarray(33, file.length - 12);
    if (!index) {
      ({ width, height } = pixels);
      const animation = new Uint8Array(8),
        view = new DataView(animation.buffer);
      view.setUint32(0, count);
      view.setUint32(4, loops);
      parts.push(file.subarray(0, 33), chunk('acTL', animation));
    } else if (pixels.width !== width || pixels.height !== height)
      throw new RangeError(
        `APNG frame ${index} is ${pixels.width}x${pixels.height}, not ${width}x${height}; capture every frame at one size`,
      );
    const control = new Uint8Array(26),
      view = new DataView(control.buffer);
    view.setUint32(0, sequence++);
    view.setUint32(4, width);
    view.setUint32(8, height);
    view.setUint16(20, whole ? 1 : Math.round(((index + 1) * 1000) / fps) - Math.round((index * 1000) / fps));
    view.setUint16(22, whole ? fps : 1000);
    control[24] = DISPOSE[dispose];
    control[25] = BLEND[blend];
    parts.push(chunk('fcTL', control));
    if (!index) parts.push(idat);
    else {
      const body = new Uint8Array(idat.length - 8);
      new DataView(body.buffer).setUint32(0, sequence++);
      body.set(idat.subarray(8, idat.length - 4), 4);
      parts.push(chunk('fdAT', body));
    }
  }
  parts.push(chunk('IEND', new Uint8Array(0)));
  return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
}
