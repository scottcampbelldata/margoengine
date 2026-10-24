// PNG reading (`@margoengine/decoders/png`): any valid PNG (W3C PNG Specification, Third Edition) to RGBA8 pixels, so
// an application can read the images it is given, or check the textures it exported, without another decoder.
// Synchronous, on the calling thread (no worker): every colour type, bit depth, filter and Adam7 interlacing, with the
// engine's shared zlib inflater. Chunk CRCs, chunk order and the exact decompressed size are checked. Ancillary chunks
// (gAMA, iCCP, text, ...) are skipped: samples come out as stored, without colour management.
import { crc32 } from '../../shared/crc32.js';
import { margoError } from '../../shared/errors.js';
import { inflateZlib } from '../../shared/inflate.js';
import { PNG_SIGNATURE, pngPredict } from '../../shared/png.js';

/** A decoded image: RGBA8 rows, top row first, `width * height * 4` bytes. */
export interface DecodedPNG {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Limits for {@link decodePNG}. */
export interface PNGDecodeOptions {
  /** Largest `width * height` accepted. Default 2^26 (an 8192 x 8192 image), 256 MiB of RGBA8. */
  maxPixels?: number;
}

// Adam7 passes: x start, y start, x step, y step.
const ADAM7 = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ],
  // Samples per pixel for colour types 0 (grey), 2 (RGB), 3 (palette), 4 (grey + alpha) and 6 (RGBA).
  CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 },
  DEPTHS: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };

const corrupt = (problem: string): Error =>
  margoError('failed', `PNG ${problem}; pass the complete bytes of a valid PNG file`);

/** Undoes the five PNG row filters in place; `bpp` is whole bytes per pixel (at least 1), `stride` bytes per row. */
function unfilter(rows: Uint8Array, offset: number, height: number, stride: number, bpp: number): void {
  for (let y = 0; y < height; y++) {
    const at = offset + y * (stride + 1),
      filter = rows[at],
      row = at + 1,
      up = row - stride - 1;
    if (filter > 4) throw corrupt(`row filter ${filter} is unknown`);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[row + x - bpp] : 0,
        b = y ? rows[up + x] : 0,
        c = y && x >= bpp ? rows[up + x - bpp] : 0;
      rows[row + x] = (rows[row + x] + pngPredict(filter, a, b, c)) & 255;
    }
  }
}

/**
 * Decodes PNG bytes to RGBA8 pixels. Grey and palette images expand to RGBA; 16-bit samples keep their high byte;
 * sub-byte grey scales to 0-255; a `tRNS` colour key or palette alpha becomes the alpha channel.
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError when the image is larger than `maxPixels`.
 * @throws MargoError `failed` when the bytes are not a complete, valid PNG.
 */
export function decodePNG(bytes: Uint8Array, options: PNGDecodeOptions = {}): DecodedPNG {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decodePNG needs the PNG file as a Uint8Array');
  const maxPixels = options.maxPixels ?? 2 ** 26;
  if (!(Number.isSafeInteger(maxPixels) && maxPixels > 0))
    throw new RangeError('PNG maxPixels must be a positive integer');
  if (bytes.length < 8 || PNG_SIGNATURE.some((v, i) => bytes[i] !== v)) throw corrupt('signature is missing');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    idat: Uint8Array[] = [];
  let width = 0,
    height = 0,
    depth = 0,
    colour = 0,
    interlaced = false,
    palette: Uint8Array | undefined,
    alpha: Uint8Array | undefined,
    idatEnded = false,
    ended = false,
    at = 8;
  while (at < bytes.length && !ended) {
    if (at + 12 > bytes.length) throw corrupt('ends inside a chunk header');
    const length = view.getUint32(at),
      end = at + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) throw corrupt('ends inside a chunk');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]),
      data = bytes.subarray(at + 8, at + 8 + length);
    if (!/^[A-Za-z]{4}$/.test(type)) throw corrupt('has a chunk with an invalid type');
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== view.getUint32(at + 8 + length))
      throw corrupt(`${type} chunk fails its CRC`);
    if ((at === 8) !== (type === 'IHDR')) throw corrupt('must start with one IHDR chunk');
    if (idat.length && type !== 'IDAT') idatEnded = true;
    if (type === 'IHDR') {
      if (length !== 13) throw corrupt('IHDR has the wrong length');
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = data[8];
      colour = data[9];
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw corrupt('size is invalid');
      if (!DEPTHS[colour]?.includes(depth)) throw corrupt(`colour type ${colour} with bit depth ${depth} is invalid`);
      if (data[10] || data[11] || data[12] > 1) throw corrupt('compression, filter or interlace method is unknown');
      interlaced = data[12] === 1;
      if (width * height > maxPixels)
        throw new RangeError(`PNG is ${width} x ${height}, over maxPixels ${maxPixels}; raise maxPixels to decode it`);
    } else if (type === 'PLTE') {
      if (
        palette ||
        idat.length ||
        colour === 0 ||
        colour === 4 ||
        length % 3 ||
        !length ||
        length / 3 > 2 ** Math.min(depth, 8)
      )
        throw corrupt('PLTE is invalid or misplaced');
      palette = data;
    } else if (type === 'tRNS') {
      if (idat.length || colour === 4 || colour === 6 || (colour === 3 && (!palette || length > palette.length / 3)))
        throw corrupt('tRNS is invalid or misplaced');
      if ((colour === 0 && length !== 2) || (colour === 2 && length !== 6)) throw corrupt('tRNS has the wrong length');
      alpha = data;
    } else if (type === 'IDAT') {
      if (idatEnded) throw corrupt('IDAT chunks must be consecutive');
      idat.push(data);
    } else if (type === 'IEND') ended = true;
    else if (type.charCodeAt(0) < 97) throw corrupt(`critical chunk ${type} is unknown`);
    at = end;
  }
  if (!ended) throw corrupt('IEND chunk is missing');
  if (!idat.length) throw corrupt('IDAT chunk is missing');
  if (colour === 3 && !palette) throw corrupt('palette image has no PLTE chunk');

  const channels = CHANNELS[colour],
    bits = channels * depth,
    bpp = Math.max(1, bits >> 3),
    passes = (interlaced ? ADAM7 : [[0, 0, 1, 1]]).map(([x0, y0, dx, dy]) => {
      const w = Math.ceil((width - x0) / dx),
        h = Math.ceil((height - y0) / dy);
      return { x0, y0, dx, dy, w: h ? w : 0, h: w ? h : 0, stride: Math.ceil((w * bits) / 8) };
    });
  let size = 0;
  for (const p of passes) if (p.w) size += (p.stride + 1) * p.h;
  let zlibLength = 0;
  for (const chunk of idat) zlibLength += chunk.length;
  const zlib = idat.length === 1 ? idat[0] : new Uint8Array(zlibLength);
  if (idat.length > 1) {
    let o = 0;
    for (const chunk of idat) {
      zlib.set(chunk, o);
      o += chunk.length;
    }
  }
  // Every IDAT chunk passed its CRC-32 above, which covers these compressed bytes; the Adler-32 would only repeat it.
  const rows = inflateZlib(zlib, size, false),
    out = new Uint8Array(width * height * 4),
    max = (1 << Math.min(depth, 8)) - 1,
    key = alpha && colour !== 3 ? alpha : undefined,
    sample = (row: number, index: number): number => {
      // The sample's value at its own bit depth (16-bit as 0-65535).
      if (depth === 16) return (rows[row + index * 2] << 8) | rows[row + index * 2 + 1];
      if (depth === 8) return rows[row + index];
      const bit = index * depth;
      return (rows[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
    },
    eight = (value: number): number => (depth === 16 ? value >> 8 : depth === 8 ? value : (value * 255) / max);
  let offset = 0;
  for (const p of passes) {
    if (!p.w) continue;
    unfilter(rows, offset, p.h, p.stride, bpp);
    for (let y = 0; y < p.h; y++) {
      const row = offset + y * (p.stride + 1) + 1;
      for (let x = 0; x < p.w; x++) {
        const o = ((p.y0 + y * p.dy) * width + p.x0 + x * p.dx) * 4,
          s = x * channels;
        if (colour === 3) {
          const index = sample(row, s);
          if (index * 3 >= palette!.length) throw corrupt('pixel uses a colour outside its palette');
          out[o] = palette![index * 3];
          out[o + 1] = palette![index * 3 + 1];
          out[o + 2] = palette![index * 3 + 2];
          out[o + 3] = alpha && index < alpha.length ? alpha[index] : 255;
        } else if (colour === 0 || colour === 4) {
          const grey = sample(row, s);
          out[o] = out[o + 1] = out[o + 2] = eight(grey);
          out[o + 3] = colour === 4 ? eight(sample(row, s + 1)) : key && grey === ((key[0] << 8) | key[1]) ? 0 : 255;
        } else {
          const r = sample(row, s),
            g = sample(row, s + 1),
            b = sample(row, s + 2);
          out[o] = eight(r);
          out[o + 1] = eight(g);
          out[o + 2] = eight(b);
          out[o + 3] =
            colour === 6
              ? eight(sample(row, s + 3))
              : key &&
                  r === ((key[0] << 8) | key[1]) &&
                  g === ((key[2] << 8) | key[3]) &&
                  b === ((key[4] << 8) | key[5])
                ? 0
                : 255;
        }
      }
    }
    offset += (p.stride + 1) * p.h;
  }
  return { width, height, data: out };
}
