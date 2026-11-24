// PCX reading (`@margoengine/decoders/pcx`), written from the ZSoft PCX File Format Technical Reference Manual. Run-length
// encoded scanlines of 8-bit images with 1, 3 or 4 planes (a palette, RGB, RGBA) and of 16-colour and 2-colour images
// (4 bits in one plane, or one bit in 4 or 1 planes) become RGBA8 rows, top row first. Quake skins are the 8-bit palette kind.
import { decodeFailed } from './errors.js';

/** A decoded image: RGBA8 rows, top row first, `width * height * 4` bytes. */
export interface DecodedPCX {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Limits for {@link parsePCX}. */
export interface PCXOptions {
  /** Largest `width * height` accepted. Default 2^26 (an 8192 x 8192 image), 256 MiB of RGBA8. */
  maxPixels?: number;
}

const HEADER = 128;
// Version 3 files carry no palette: they mean the standard 16 EGA colours (intensity, red, green, blue; 6 is brown).
const EGA = Uint8Array.from({ length: 48 }, (_, i) => {
  const index = (i / 3) | 0,
    level = (((index >> (2 - (i % 3))) & 1) * 170) + ((index >> 3) & 1) * 85;
  return index === 6 && i % 3 === 1 ? 85 : level;
});
const corrupt = (problem: string): Error => decodeFailed(`PCX ${problem}; pass the complete bytes of a valid PCX file`);

/**
 * Reads a PCX image.
 * @param bytes The file's bytes.
 * @param options `maxPixels`.
 * @returns `{width, height, data}`, RGBA8 rows, top row first, opaque unless the file has a fourth 8-bit plane.
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError when the image is larger than `maxPixels`.
 * @throws MargoError code `failed` when the bytes are not a PCX file this reader covers, or end early.
 */
export function parsePCX(bytes: Uint8Array, options: PCXOptions = {}): DecodedPCX {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parsePCX needs the PCX file as a Uint8Array');
  const maxPixels = options.maxPixels ?? 2 ** 26;
  if (!(Number.isSafeInteger(maxPixels) && maxPixels > 0))
    throw new RangeError('PCX maxPixels must be a positive integer');
  if (bytes.length < HEADER) throw corrupt('is shorter than its 128-byte header');
  if (bytes[0] !== 10) throw corrupt('does not start with the manufacturer byte 10');
  if (bytes[2] !== 1 && bytes[2] !== 0) throw corrupt(`has encoding ${bytes[2]}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    bits = bytes[3],
    planes = bytes[65],
    lineBytes = view.getUint16(66, true),
    width = view.getUint16(8, true) - view.getUint16(4, true) + 1,
    height = view.getUint16(10, true) - view.getUint16(6, true) + 1,
    kind = `${bits}x${planes}`;
  if (!['8x1', '8x3', '8x4', '4x1', '1x1', '1x4'].includes(kind))
    throw corrupt(`has ${bits} bits in ${planes} planes, which this reader does not cover`);
  if (width < 1 || height < 1) throw corrupt('has an empty window');
  if (width * height > maxPixels)
    throw new RangeError(`PCX holds ${width * height} pixels; raise maxPixels past ${maxPixels} to read it`);
  if (lineBytes * 8 < width * bits) throw corrupt('has scanlines too short for its width');

  // One decoded scanline holds every plane in turn.
  const row = planes * lineBytes,
    lines = new Uint8Array(row * height);
  let at = HEADER;
  if (bytes[2] === 0) {
    if (at + lines.length > bytes.length) throw corrupt('ends inside the image data');
    lines.set(bytes.subarray(at, at + lines.length));
    at += lines.length;
  } else
    for (let out = 0; out < lines.length; ) {
      if (at >= bytes.length) throw corrupt('ends inside the image data');
      const value = bytes[at++];
      if (value < 0xc0) {
        lines[out++] = value;
        continue;
      }
      if (at >= bytes.length) throw corrupt('ends inside a run');
      const count = value & 0x3f;
      if (out + count > lines.length) throw corrupt('has a run past the image');
      lines.fill(bytes[at++], out, out + count);
      out += count;
    }

  // The 256-colour palette follows the image, after a 12; the 16-colour one sits in the header.
  const end = bytes.length - 769,
    colors = new Uint8Array(256 * 3);
  if (kind === '8x1') {
    if (end >= at && bytes[end] === 12) colors.set(bytes.subarray(end + 1, end + 769));
    else for (let i = 0; i < 256; i++) colors.fill(i, i * 3, i * 3 + 3);
  } else if (kind === '1x1') colors.fill(255, 3, 6);
  else if (bytes[1] === 3) colors.set(EGA);
  else if (bits < 8) colors.set(bytes.subarray(16, 64));

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const line = y * row;
    for (let x = 0, o = y * width * 4; x < width; x++, o += 4) {
      data[o + 3] = 255;
      if (bits === 8 && planes >= 3) {
        for (let c = 0; c < planes; c++) data[o + c] = lines[line + c * lineBytes + x];
        continue;
      }
      let index = 0;
      if (bits === 8) index = lines[line + x];
      else if (bits === 4) index = (lines[line + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15;
      else
        for (let p = 0; p < planes; p++) index |= ((lines[line + p * lineBytes + (x >> 3)] >> (7 - (x & 7))) & 1) << p;
      data[o] = colors[index * 3];
      data[o + 1] = colors[index * 3 + 1];
      data[o + 2] = colors[index * 3 + 2];
    }
  }
  return { width, height, data };
}
