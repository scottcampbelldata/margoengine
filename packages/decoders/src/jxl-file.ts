// JPEG XL header reading (`@margoengine/decoders/jxl`), from the bit layout of ISO/IEC 18181-1: enough of the codestream to
// know the size, the alpha channel and the colour encoding before any pixel is decoded. The container of ISO/IEC 18181-2 is
// unwrapped first. Nothing here runs the decoder.
import { decodeFailed } from './errors.js';

/** What a JPEG XL file says about itself, from {@link readJXLHeader}. */
export interface JXLHeader {
  /** Size in pixels after the orientation is applied, which is the size a decode gives. */
  width: number;
  height: number;
  /** Bits of each colour sample as stored. */
  bitsPerSample: number;
  /** True when samples are floating point. */
  floatSamples: boolean;
  hasAlpha: boolean;
  /** True when the colour samples are stored already multiplied by alpha. */
  alphaPremultiplied: boolean;
  animated: boolean;
  /** EXIF orientation, 1 to 8; 1 is upright. */
  orientation: number;
  /** True when the file names plain sRGB, with no ICC profile. */
  srgb: boolean;
  /** True when the file holds its colour as an ICC profile. */
  iccProfile: boolean;
  /** True when the samples are stored in XYB, which a decoder can turn into sRGB without any ICC work. */
  xyb: boolean;
}

const refuse = (problem: string): Error => decodeFailed(`JPEG XL: ${problem}; pass the complete bytes of a .jxl file`);

// Bits are read from the low end of each byte, and the stream's U32 fields pick one of four forms with a 2-bit selector:
// a number is that value, and [offset, bits] reads `bits` more and adds `offset`.
type Form = number | readonly [number, number];
const ASPECT: readonly (readonly [number, number])[] = [
    [1, 1],
    [12, 10],
    [4, 3],
    [3, 2],
    [16, 9],
    [5, 4],
    [2, 1],
  ],
  SIZE: readonly Form[] = [
    [1, 9],
    [1, 13],
    [1, 18],
    [1, 30],
  ],
  ENUM: readonly Form[] = [0, 1, [2, 4], [18, 6]],
  ALPHA = 0,
  SPOT_COLOUR = 2,
  CFA = 5,
  RGB = 0,
  D65 = 1,
  SRGB_PRIMARIES = 1,
  SRGB_TRANSFER = 13;

class Bits {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++, this.at++) {
      const byte = this.at >> 3;
      if (byte >= this.bytes.length) throw refuse('the file ends inside its header');
      value += ((this.bytes[byte] >> (this.at & 7)) & 1) * 2 ** i;
    }
    return value;
  }

  flag(): boolean {
    return this.read(1) === 1;
  }

  u32(forms: readonly Form[]): number {
    const form = forms[this.read(2)];
    return typeof form === 'number' ? form : form[0] + this.read(form[1]);
  }
}

function readSize(bits: Bits): { width: number; height: number } {
  const small = bits.flag(),
    side = (): number => (small ? (bits.read(5) + 1) * 8 : bits.u32(SIZE)),
    height = side(),
    ratio = bits.read(3);
  if (!ratio) return { width: side(), height };
  const [across, down] = ASPECT[ratio - 1];
  return { width: Math.floor((height * across) / down), height };
}

function skipPreview(bits: Bits): void {
  const div8 = bits.flag(),
    side = (): number =>
      div8
        ? bits.u32([16, 32, [1, 5], [33, 9]])
        : bits.u32([
            [1, 6],
            [65, 8],
            [321, 10],
            [1345, 12],
          ]);
  side();
  if (!bits.read(3)) side();
}

function skipAnimation(bits: Bits): void {
  bits.u32([100, 1000, [1, 10], [1, 30]]);
  bits.u32([1, 1001, [1, 8], [1, 10]]);
  bits.u32([0, [0, 3], [0, 16], [0, 32]]);
  bits.flag();
}

function readDepth(bits: Bits): { bitsPerSample: number; floatSamples: boolean } {
  const floatSamples = bits.flag(),
    bitsPerSample = bits.u32(floatSamples ? [32, 16, 24, [1, 6]] : [8, 10, 12, [1, 6]]);
  if (floatSamples) bits.read(4);
  return { bitsPerSample, floatSamples };
}

// One extra channel: what it is, and whether it is alpha stored premultiplied.
function readExtraChannel(bits: Bits): { alpha: boolean; associated: boolean } {
  if (bits.flag()) return { alpha: true, associated: false };
  const type = bits.u32(ENUM);
  readDepth(bits);
  bits.u32([0, 3, 4, [1, 3]]);
  const name = bits.u32([0, [0, 4], [16, 5], [48, 10]]);
  for (let i = 0; i < name; i++) bits.read(8);
  const associated = type === ALPHA && bits.flag();
  if (type === SPOT_COLOUR) for (let i = 0; i < 4; i++) bits.read(16);
  if (type === CFA) bits.u32([1, [0, 2], [3, 4], [19, 8]]);
  return { alpha: type === ALPHA, associated };
}

function readColour(bits: Bits): { srgb: boolean; iccProfile: boolean } {
  if (bits.flag()) return { srgb: true, iccProfile: false };
  if (bits.flag()) return { srgb: false, iccProfile: true };
  const plain =
    bits.u32(ENUM) === RGB &&
    bits.u32(ENUM) === D65 &&
    bits.u32(ENUM) === SRGB_PRIMARIES &&
    !bits.flag() &&
    bits.u32(ENUM) === SRGB_TRANSFER;
  return { srgb: plain, iccProfile: false };
}

// The codestream of a container file: a `jxlc` box, or the `jxlp` boxes in order. A bare codestream comes back as it is.
function codestream(bytes: Uint8Array): Uint8Array {
  if (bytes[0] === 0xff && bytes[1] === 0x0a) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    parts: Uint8Array[] = [];
  if (bytes.length < 12 || view.getUint32(0) !== 12 || view.getUint32(4) !== 0x4a584c20)
    throw refuse('neither a codestream nor a container signature is there');
  let at = 0;
  while (at + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    let size = view.getUint32(at),
      head = 8;
    if (size === 1) {
      if (at + 16 > bytes.length) break;
      size = Number(view.getBigUint64(at + 8));
      head = 16;
    }
    const end = size === 0 ? bytes.length : at + size;
    if (end < at + head) throw refuse(`the ${type} box has an impossible size`);
    if (type === 'jxlc') return bytes.subarray(at + head, end);
    if (type === 'jxlp') parts.push(bytes.subarray(at + head + 4, end));
    at = end;
  }
  if (!parts.length) throw refuse('the container holds no codestream');
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let written = 0;
  for (const part of parts) {
    whole.set(part, written);
    written += part.length;
  }
  return whole;
}

/**
 * Reads the header of a JPEG XL file, bare or in its container, without decoding any pixels.
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws MargoError `failed` when the bytes are not JPEG XL or end inside the header.
 * @example
 * const { width, height, hasAlpha } = readJXLHeader(new Uint8Array(await (await fetch('/rock.jxl')).arrayBuffer()));
 */
export function readJXLHeader(bytes: Uint8Array): JXLHeader {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('readJXLHeader needs the file as a Uint8Array');
  const stream = codestream(bytes);
  if (stream[0] !== 0xff || stream[1] !== 0x0a) throw refuse('the codestream signature is missing');
  const bits = new Bits(stream.subarray(2)),
    size = readSize(bits);
  let orientation = 1,
    animated = false,
    depth = { bitsPerSample: 8, floatSamples: false },
    hasAlpha = false,
    alphaPremultiplied = false,
    colour = { srgb: true, iccProfile: false },
    xyb = true;
  if (!bits.flag()) {
    if (bits.flag()) {
      orientation = bits.read(3) + 1;
      if (bits.flag()) readSize(bits);
      if (bits.flag()) skipPreview(bits);
      animated = bits.flag();
      if (animated) skipAnimation(bits);
    }
    depth = readDepth(bits);
    bits.flag();
    const channels = bits.u32([0, 1, [2, 4], [1, 12]]);
    for (let i = 0; i < channels; i++) {
      const { alpha, associated } = readExtraChannel(bits);
      if (alpha && !hasAlpha) {
        hasAlpha = true;
        alphaPremultiplied = associated;
      }
    }
    xyb = bits.flag();
    colour = readColour(bits);
  }
  const turned = orientation > 4;
  return {
    width: turned ? size.height : size.width,
    height: turned ? size.width : size.height,
    ...depth,
    hasAlpha,
    alphaPremultiplied,
    animated,
    orientation,
    ...colour,
    xyb,
  };
}
