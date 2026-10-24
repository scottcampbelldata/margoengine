// TIFF reading (`@margoengine/decoders/tiff`), written from the Adobe TIFF Revision 6.0 specification: the first image
// (IFD) of a little- or big-endian file, in strips or tiles, uncompressed, LZW (with horizontal differencing,
// Predictor 2), PackBits or Deflate (Adobe's code 8 and the older 32946, with the engine's shared zlib inflater).
// Bilevel and greyscale (WhiteIsZero or BlackIsZero), RGB and palette images of 1, 2, 4, 8 or 16 bits per sample, and
// 32-bit float grey or RGB, chunky or planar (PlanarConfiguration 1 or 2). The first extra sample is alpha when
// ExtraSamples marks it associated (premultiplied, divided out) or unassociated; unspecified extra samples are dropped.
import { inflateZlib } from '../../shared/inflate.js';
import { decodeFailed } from './errors.js';

/**
 * A decoded image, top row first: RGBA8 bytes for integer samples (16-bit samples scale to 0-255) or RGBA 32-bit floats
 * for float samples, `width * height * 4` values. Both are `@margoengine/materials` `DataImage`s.
 */
export type DecodedTIFF =
  | { width: number; height: number; format: 'rgba8unorm'; data: Uint8Array }
  | { width: number; height: number; format: 'rgba32float'; data: Float32Array };

/** Limits for {@link parseTIFF}. */
export interface TIFFOptions {
  /** Largest `width * height` accepted. Default 2^26 (an 8192 x 8192 image). */
  maxPixels?: number;
}

const corrupt = (problem: string): Error =>
  decodeFailed(`TIFF ${problem}; pass the complete bytes of a valid TIFF file`);
const refuse = (what: string): Error =>
  decodeFailed(`TIFF ${what} is not supported; save the image as baseline 8-bit, 16-bit or float RGB, grey or palette`);
const SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/** TIFF LZW (MSB-first codes of 9 to 12 bits, Clear 256, EndOfInformation 257) into exactly `size` bytes. */
function lzw(src: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size),
    // Every table string is a run already in `out`: its start and length.
    start = new Int32Array(4096),
    length = new Int32Array(4096).fill(1, 0, 256);
  let width = 9,
    next = 258,
    old = -1,
    oldAt = 0,
    pos = 0,
    bit = 0;
  while (pos < size && bit + width <= src.length * 8) {
    let code = 0;
    for (let i = 0; i < width; i++, bit++) code = (code << 1) | ((src[bit >> 3] >> (7 - (bit & 7))) & 1);
    if (code === 257) break;
    if (code === 256) {
      width = 9;
      next = 258;
      old = -1;
      continue;
    }
    const at = pos;
    if (code < 256) out[pos++] = code;
    else if (code < next) for (let i = 0; i < length[code] && pos < size; i++) out[pos++] = out[start[code] + i];
    else if (code === next && old >= 0) {
      // The string of the previous code plus its own first byte.
      for (let i = 0; i < length[old] && pos < size; i++) out[pos++] = out[oldAt + i];
      if (pos < size) out[pos++] = out[oldAt];
    } else throw corrupt(`LZW code ${code} is undefined`);
    if (old >= 0 && next < 4096) {
      start[next] = oldAt;
      length[next] = length[old] + 1;
      if (++next >= (1 << width) - 1 && width < 12) width++;
    }
    old = code;
    oldAt = at;
  }
  if (pos < size) throw corrupt('LZW data ends early');
  return out;
}

/** PackBits runs into exactly `size` bytes. */
function packBits(src: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let i = 0,
    o = 0;
  while (o < size && i < src.length) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) {
      if (i + n + 1 > src.length || o + n + 1 > size) throw corrupt('PackBits literal runs past its strip');
      out.set(src.subarray(i, i + n + 1), o);
      i += n + 1;
      o += n + 1;
    } else if (n !== -128) {
      if (i >= src.length || o + 1 - n > size) throw corrupt('PackBits run runs past its strip');
      out.fill(src[i++], o, (o += 1 - n));
    }
  }
  if (o < size) throw corrupt('PackBits data ends early');
  return out;
}

/**
 * Decodes the first image of a TIFF file, top row first. Grey and palette images expand to RGBA; integer samples
 * become RGBA8, 32-bit float samples RGBA floats.
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError when the image is larger than `maxPixels`.
 * @throws MargoError `failed` when the bytes are not a complete, valid TIFF file, or use a compression, colour space
 * or sample layout outside the ones listed above (JPEG, CMYK, YCbCr, signed samples, float predictors).
 */
export function parseTIFF(bytes: Uint8Array, options: TIFFOptions = {}): DecodedTIFF {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseTIFF needs the TIFF file as a Uint8Array');
  const maxPixels = options.maxPixels ?? 2 ** 26;
  if (!(Number.isSafeInteger(maxPixels) && maxPixels > 0))
    throw new RangeError('TIFF maxPixels must be a positive integer');
  const little = bytes[0] === 0x49 && bytes[1] === 0x49,
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) || view.getUint16(2, little) !== 42)
    throw corrupt('header is missing');
  const u16 = (at: number) => view.getUint16(at, little),
    u32 = (at: number) => view.getUint32(at, little),
    ifd = u32(4);
  if (ifd + 2 > bytes.length) throw corrupt('first IFD offset is past the end');
  const entries = u16(ifd),
    tags = new Map<number, number[]>();
  if (ifd + 2 + entries * 12 > bytes.length) throw corrupt('IFD runs past the end');
  for (let e = 0; e < entries; e++) {
    const at = ifd + 2 + e * 12,
      type = u16(at + 2),
      count = u32(at + 4),
      size = SIZES[type] ?? 0;
    // Only BYTE, SHORT and LONG fields are read; others (ASCII, RATIONAL, ...) are skipped.
    if (![1, 3, 4].includes(type)) continue;
    const offset = size * count > 4 ? u32(at + 8) : at + 8;
    if (offset + size * count > bytes.length) throw corrupt(`tag ${u16(at)} runs past the end`);
    tags.set(
      u16(at),
      Array.from({ length: count }, (_, i) =>
        type === 1 ? bytes[offset + i] : type === 3 ? u16(offset + i * 2) : u32(offset + i * 4),
      ),
    );
  }
  const tag = (id: number, fallback?: number): number => {
    const value = tags.get(id)?.[0] ?? fallback;
    if (value === undefined) throw corrupt(`required tag ${id} is missing`);
    return value;
  };
  const width = tag(256),
    height = tag(257),
    spp = tag(277, 1),
    bitsList = tags.get(258) ?? [1],
    bits = bitsList[0],
    compression = tag(259, 1),
    photometric = tag(262, spp >= 3 ? 2 : 1),
    planar = tag(284, 1),
    predictor = tag(317, 1),
    float = tag(339, 1) === 3,
    base = photometric === 2 ? 3 : 1,
    extra = tags.get(338)?.[0],
    alpha = spp > base && (extra === 1 || extra === 2),
    tiled = tags.has(322);
  if (!width || !height) throw corrupt('size is 0');
  if (width * height > maxPixels)
    throw new RangeError(`TIFF is ${width} x ${height}, over maxPixels ${maxPixels}; raise maxPixels to decode it`);
  if (bitsList.some((b) => b !== bits) || (tags.get(339) ?? [1]).some((f) => f !== (float ? 3 : 1)))
    throw refuse('mixed or signed sample formats');
  if (float ? bits !== 32 : ![1, 2, 4, 8, 16].includes(bits))
    throw refuse(`${bits}-bit ${float ? 'float ' : ''}samples`);
  if (photometric > 3 || spp < base || (float && (photometric === 0 || photometric === 3)))
    throw refuse(`photometric interpretation ${photometric}`);
  if (spp > 16) throw refuse(`${spp} samples per pixel`);
  if (planar !== 1 && planar !== 2) throw corrupt(`PlanarConfiguration ${planar} is invalid`);
  if (tag(266, 1) !== 1) throw refuse('FillOrder 2');
  if (predictor !== 1 && !(predictor === 2 && (bits === 8 || bits === 16)))
    throw refuse(`Predictor ${predictor} with ${bits}-bit samples`);
  if (![1, 5, 8, 32773, 32946].includes(compression)) throw refuse(`compression ${compression}`);
  const tileW = tiled ? tag(322) : width,
    tileH = tiled ? tag(323) : Math.min(tag(278, height), height),
    offsets = tags.get(tiled ? 324 : 273),
    counts = tags.get(tiled ? 325 : 279),
    across = Math.ceil(width / tileW),
    down = Math.ceil(height / tileH),
    planes = planar === 2 ? spp : 1,
    perPixel = planar === 2 ? 1 : spp,
    rowBytes = Math.ceil((tileW * perPixel * bits) / 8),
    max = 2 ** bits - 1;
  if (!tileW || !tileH) throw corrupt('tile or strip size is 0');
  // Tiles may overhang the image edge; one far larger than the image is corrupt and would need a huge buffer.
  if (tileW > width + 1024 || tileH > height + 1024)
    throw corrupt(`tile ${tileW} x ${tileH} is far larger than the image`);
  const samples = float ? new Float32Array(width * height * spp) : new Uint16Array(width * height * spp);
  if (!offsets || !counts || offsets.length < across * down * planes || counts.length < offsets.length)
    throw corrupt('strip or tile offsets are missing');
  for (let plane = 0; plane < planes; plane++)
    for (let by = 0; by < down; by++)
      for (let bx = 0; bx < across; bx++) {
        const index = (plane * down + by) * across + bx,
          rows = tiled ? tileH : Math.min(tileH, height - by * tileH),
          size = rowBytes * rows,
          offset = offsets[index];
        if (offset + counts[index] > bytes.length) throw corrupt(`strip or tile ${index} runs past the end`);
        const raw = bytes.subarray(offset, offset + counts[index]),
          block =
            compression === 5
              ? lzw(raw, size)
              : compression === 32773
                ? packBits(raw, size)
                : compression === 1
                  ? raw
                  : inflateZlib(raw, size);
        if (block.length < size) throw corrupt(`strip or tile ${index} is too short`);
        const data = new DataView(block.buffer, block.byteOffset, block.byteLength),
          row = new Float64Array(tileW * perPixel);
        for (let y = 0; y < rows; y++) {
          const iy = by * tileH + y;
          // One row's samples, the predictor's differences summed modulo 2^bits.
          for (let i = 0; i < row.length; i++) {
            const at = y * rowBytes;
            row[i] =
              bits === 32
                ? data.getFloat32(at + i * 4, little)
                : bits === 16
                  ? data.getUint16(at + i * 2, little)
                  : bits === 8
                    ? block[at + i]
                    : (block[at + ((i * bits) >> 3)] >> (8 - bits - ((i * bits) & 7))) & max;
            if (predictor === 2 && i >= perPixel) row[i] = (row[i] + row[i - perPixel]) % (max + 1);
          }
          if (iy >= height) continue;
          for (let x = 0; x < tileW && bx * tileW + x < width; x++)
            for (let c = 0; c < perPixel; c++)
              samples[(iy * width + bx * tileW + x) * spp + plane + c] = row[x * perPixel + c];
        }
      }
  const out = float ? new Float32Array(width * height * 4) : new Uint8Array(width * height * 4),
    map = tags.get(320),
    paletteSize = 2 ** bits,
    scale = float ? 1 : 255 / max;
  if (photometric === 3 && (!map || map.length < 3 * paletteSize)) throw corrupt('palette image has no ColorMap');
  for (let p = 0; p < width * height; p++) {
    const s = p * spp,
      o = p * 4,
      a = alpha ? samples[s + base] * scale : float ? 1 : 255;
    for (let c = 0; c < 3; c++) {
      let v: number;
      if (photometric === 3) v = map![samples[s] + c * paletteSize] / 257;
      else {
        const raw = samples[s + (base === 3 ? c : 0)];
        v = (photometric === 0 ? max - raw : raw) * scale;
      }
      if (alpha && extra === 1) v = a ? (v * (float ? 1 : 255)) / a : 0;
      out[o + c] = float ? v : Math.min(255, Math.round(v));
    }
    out[o + 3] = float ? a : Math.round(a);
  }
  return float
    ? { width, height, format: 'rgba32float', data: out as Float32Array }
    : { width, height, format: 'rgba8unorm', data: out as Uint8Array };
}
