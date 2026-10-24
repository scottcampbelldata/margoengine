// TGA reading (`@margoengine/decoders/tga`), written from the Truevision TGA File Format Specification 2.0. Colour-
// mapped, true-colour and black-and-white images (types 1, 2, 3) and their run-length encoded forms (9, 10, 11), at 8,
// 15, 16, 24 and 32 bits, become RGBA8 rows, top row first, whichever corner the file's origin bits name. Alpha comes
// from the descriptor's attribute bits; a TGA 2.0 extension area whose attributes type says the alpha is absent or
// undefined makes the image opaque, and premultiplied alpha is divided out.
import { decodeFailed } from './errors.js';

/** A decoded image: RGBA8 rows, top row first, `width * height * 4` bytes. */
export interface DecodedTGA {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Limits for {@link parseTGA}. */
export interface TGAOptions {
  /** Largest `width * height` accepted. Default 2^26 (an 8192 x 8192 image), 256 MiB of RGBA8. */
  maxPixels?: number;
}

const corrupt = (problem: string): Error => decodeFailed(`TGA ${problem}; pass the complete bytes of a valid TGA file`);

/** Writes the pixel of `bits` bits at `src[at]` (little-endian) into `out[o]` as RGBA8; `alpha` uses its alpha bits. */
function pixel(src: Uint8Array, at: number, bits: number, grey: boolean, alpha: boolean, out: Uint8Array, o: number) {
  if (grey) {
    out[o] = out[o + 1] = out[o + 2] = src[at];
    out[o + 3] = bits === 16 && alpha ? src[at + 1] : 255;
  } else if (bits <= 16) {
    const v = src[at] | (src[at + 1] << 8);
    out[o] = (((v >> 10) & 31) * 255 + 15) / 31;
    out[o + 1] = (((v >> 5) & 31) * 255 + 15) / 31;
    out[o + 2] = ((v & 31) * 255 + 15) / 31;
    out[o + 3] = bits === 16 && alpha && !(v & 0x8000) ? 0 : 255;
  } else {
    out[o] = src[at + 2];
    out[o + 1] = src[at + 1];
    out[o + 2] = src[at];
    out[o + 3] = bits === 32 && alpha ? src[at + 3] : 255;
  }
}

/**
 * Decodes TGA bytes to RGBA8 pixels, top row first. Colour-mapped images look up their map; 15- and 16-bit colours
 * scale to 0-255; grey expands to RGB.
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError when the image is larger than `maxPixels`.
 * @throws MargoError `failed` when the bytes are not a complete, valid TGA file, or its image type is not 1-3 or 9-11.
 */
export function parseTGA(bytes: Uint8Array, options: TGAOptions = {}): DecodedTGA {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseTGA needs the TGA file as a Uint8Array');
  const maxPixels = options.maxPixels ?? 2 ** 26;
  if (!(Number.isSafeInteger(maxPixels) && maxPixels > 0))
    throw new RangeError('TGA maxPixels must be a positive integer');
  if (bytes.length < 18) throw corrupt('header is missing');
  const u16 = (at: number) => bytes[at] | (bytes[at + 1] << 8),
    mapType = bytes[1],
    type = bytes[2],
    mapFirst = u16(3),
    mapLength = u16(5),
    mapBits = bytes[7],
    width = u16(12),
    height = u16(14),
    bits = bytes[16],
    descriptor = bytes[17],
    kind = type & 7,
    rle = type > 8,
    mapped = kind === 1,
    grey = kind === 3;
  if (![1, 2, 3, 9, 10, 11].includes(type)) throw corrupt(`image type ${type} is not 1-3 or 9-11 (an image)`);
  if (mapType > 1 || (mapped && mapType !== 1)) throw corrupt('colour map type is invalid');
  if (!width || !height) throw corrupt('size is 0');
  if (width * height > maxPixels)
    throw new RangeError(`TGA is ${width} x ${height}, over maxPixels ${maxPixels}; raise maxPixels to decode it`);
  if (
    !(mapped ? bits === 8 || bits === 16 : grey ? bits === 8 || bits === 16 : [15, 16, 24, 32].includes(bits)) ||
    (mapped && ![15, 16, 24, 32].includes(mapBits))
  )
    throw corrupt(`pixel depth ${bits} is invalid for image type ${type}`);
  // A TGA 2.0 footer's extension area holds the attributes type: 0-2 mean no usable alpha, 4 premultiplied.
  let attributes = 3;
  if (
    bytes.length >= 44 &&
    String.fromCharCode(...bytes.subarray(bytes.length - 18, bytes.length - 2)) === 'TRUEVISION-XFILE'
  ) {
    const extension = u16(bytes.length - 26) + u16(bytes.length - 24) * 65536;
    if (extension && extension + 495 <= bytes.length - 26 && u16(extension) >= 495) attributes = bytes[extension + 494];
  }
  const alpha = (descriptor & 15) > 0 && attributes > 2,
    pixelBytes = (bits + 7) >> 3,
    mapBytes = (mapBits + 7) >> 3;
  let at = 18 + bytes[0];
  // The colour map, expanded to RGBA8 entries.
  const map = new Uint8Array(mapLength * 4);
  if (mapType) {
    if (at + mapLength * mapBytes > bytes.length) throw corrupt('ends inside the colour map');
    for (let i = 0; i < mapLength; i++) pixel(bytes, at + i * mapBytes, mapBits, false, alpha, map, i * 4);
    at += mapLength * mapBytes;
  }
  // Pixel values in file order (bottom-left origin unless the descriptor says otherwise), raw or run-length decoded.
  const count = width * height,
    values = rle ? new Uint8Array(count * pixelBytes) : bytes.subarray(at, at + count * pixelBytes);
  if (rle) {
    for (let n = 0; n < count; ) {
      if (at >= bytes.length) throw corrupt('ends inside the run-length data');
      const header = bytes[at++],
        run = (header & 127) + 1;
      if (n + run > count) throw corrupt('run-length packet runs past the image');
      const size = header & 128 ? pixelBytes : run * pixelBytes;
      if (at + size > bytes.length) throw corrupt('ends inside the run-length data');
      if (header & 128) for (let i = 0; i < run; i++) values.set(bytes.subarray(at, at + size), (n + i) * pixelBytes);
      else values.set(bytes.subarray(at, at + size), n * pixelBytes);
      at += size;
      n += run;
    }
  } else if (values.length < count * pixelBytes) throw corrupt('ends inside the image data');
  const out = new Uint8Array(count * 4),
    right = !!(descriptor & 16),
    top = !!(descriptor & 32);
  for (let i = 0; i < count; i++) {
    const x = i % width,
      y = (i - x) / width,
      o = ((top ? y : height - 1 - y) * width + (right ? width - 1 - x : x)) * 4,
      v = i * pixelBytes;
    if (mapped) {
      const index = (bits === 8 ? values[v] : values[v] | (values[v + 1] << 8)) - mapFirst;
      if (index < 0 || index >= mapLength) throw corrupt(`colour index ${index + mapFirst} is outside the colour map`);
      out.set(map.subarray(index * 4, index * 4 + 4), o);
    } else pixel(values, v, bits, grey, alpha, out, o);
    const a = out[o + 3];
    if (attributes === 4 && a < 255)
      for (let c = 0; c < 3; c++) out[o + c] = a ? Math.min(255, Math.round((out[o + c] * 255) / a)) : 0;
  }
  return { width, height, data: out };
}
