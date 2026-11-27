// Netpbm reading (`@margoengine/decoders/pnm`), written from the Netpbm format specifications for pbm, pgm and ppm
// (https://netpbm.sourceforge.net/doc/pbm.html, pgm.html, ppm.html). Plain (P1 to P3) and raw (P4 to P6) images with a
// maximum sample value of 1 to 65535 become RGBA8 rows, top row first. A file of several raw images gives its first.
import { decodeFailed } from './errors.js';

/** A decoded Netpbm image: RGBA8 rows, top row first, `width * height * 4` bytes, alpha 255. */
export interface DecodedPNM {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Limits for {@link parsePNM}. */
export interface PNMOptions {
  /** Largest `width * height` accepted. Default 2^26 (an 8192 x 8192 image), 256 MiB of RGBA8. */
  maxPixels?: number;
}

const corrupt = (problem: string): Error =>
  decodeFailed(`PNM ${problem}; pass the complete bytes of a valid PBM, PGM or PPM file`);
// The C isspace set: tab, line feed, vertical tab, form feed, carriage return and space.
const isSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13);

/**
 * Reads a PBM, PGM or PPM image (magic numbers P1 to P6). Grey and bitmap images expand to RGB; a set bit of a bitmap
 * is black. Samples scale from 0 to the file's maximum value onto 0 to 255, rounded, with no transfer curve applied.
 *
 * @example
 * import {parsePNM} from 'margoengine/decoders/pnm';
 * const file = new TextEncoder().encode('P2 2 1 255 0 255');
 * console.log(parsePNM(file).data[4]); // 255
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError when the image is larger than `maxPixels`.
 * @throws MargoError `failed` when the bytes are not a complete, valid image of these formats.
 */
export function parsePNM(bytes: Uint8Array, options: PNMOptions = {}): DecodedPNM {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parsePNM needs the PNM file as a Uint8Array');
  const maxPixels = options.maxPixels ?? 2 ** 26;
  if (!(Number.isSafeInteger(maxPixels) && maxPixels > 0))
    throw new RangeError('PNM maxPixels must be a positive integer');
  const kind = bytes[1] - 48;
  if (bytes[0] !== 80 || !(kind >= 1 && kind <= 6)) throw corrupt('does not start with a magic number P1 to P6');
  const plain = kind <= 3,
    bitmap = kind === 1 || kind === 4,
    channels = kind === 3 || kind === 6 ? 3 : 1;
  let at = 2;
  // A comment runs from "#" up to, not including, the next carriage return or line feed.
  const comment = (): void => {
    while (at < bytes.length && bytes[at] !== 10 && bytes[at] !== 13) at++;
  };
  const gap = (): void => {
    for (;;)
      if (isSpace(bytes[at])) at++;
      else if (bytes[at] === 35) comment();
      else return;
  };
  const number = (what: string, spaced = true): number => {
    const before = at;
    gap();
    if (spaced && at === before) throw corrupt(`has no white space before its ${what}`);
    let value = 0,
      digits = 0;
    for (; bytes[at] >= 48 && bytes[at] <= 57; at++, digits++) {
      value = value * 10 + bytes[at] - 48;
      if (value > 0x7fffffff) throw corrupt(`${what} is too large`);
    }
    if (!digits) throw corrupt(`has no ${what}`);
    return value;
  };
  const width = number('width'),
    height = number('height');
  if (!width || !height) throw corrupt('size is 0');
  if (width * height > maxPixels)
    throw new RangeError(`PNM is ${width} x ${height}, over maxPixels ${maxPixels}; raise maxPixels to decode it`);
  const max = bitmap ? 1 : number('maximum value');
  if (max < 1 || max > 65535) throw corrupt(`maximum value ${max} is outside 1 to 65535`);
  const samples = width * height * channels;
  if (!plain) {
    if (bytes[at] === 35) comment();
    if (!isSpace(bytes[at])) throw corrupt('header does not end in white space');
    at++;
  }
  const wide = max > 255,
    rowBytes = Math.ceil(width / 8),
    // Checked before the pixels are allocated: a plain sample takes at least one byte.
    needed = plain ? samples : kind === 4 ? rowBytes * height : samples * (wide ? 2 : 1);
  if (bytes.length - at < needed) throw corrupt('ends before its last sample');
  const data = new Uint8Array(width * height * 4);
  let next: (i: number) => number;
  if (kind === 1)
    // The bits of a plain bitmap need no white space between them.
    next = () => {
      gap();
      const bit = bytes[at++] - 48;
      if (bit !== 0 && bit !== 1) throw corrupt('bitmap holds something other than 0 and 1');
      return 1 - bit;
    };
  else if (plain) next = () => number('sample');
  else if (kind === 4) {
    const start = at;
    next = (i) => {
      const x = i % width;
      return 1 - ((bytes[start + ((i - x) / width) * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1);
    };
  } else if (wide) {
    const start = at;
    next = (i) => (bytes[start + i * 2] << 8) | bytes[start + i * 2 + 1];
  } else {
    const start = at;
    next = (i) => bytes[start + i];
  }
  const half = max >> 1;
  for (let i = 0, pixel = 0; pixel < data.length; pixel += 4) {
    for (let c = 0; c < channels; c++, i++) {
      const value = next(i);
      if (value > max) throw corrupt(`sample ${value} is above the maximum value ${max}`);
      data[pixel + c] = ((value * 255 + half) / max) | 0;
    }
    if (channels === 1) data[pixel + 1] = data[pixel + 2] = data[pixel];
    data[pixel + 3] = 255;
  }
  return { width, height, data };
}
