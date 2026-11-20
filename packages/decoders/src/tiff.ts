// TIFF reading (`@margoengine/decoders/tiff`), written from the Adobe TIFF Revision 6.0 specification: the first image
// (IFD) of a little- or big-endian file, in strips or tiles, uncompressed, LZW (with horizontal differencing,
// Predictor 2), PackBits, Deflate (Adobe's code 8 and the older 32946, with the engine's shared zlib inflater), CCITT
// Modified Huffman, T.4 (1D and 2D) and T.6 bilevel coding (Sections 10 and 11, ITU-T T.4 and T.6; ccitt.ts), and JPEG:
// Compression 7 from TIFF Technical Note 2 (JPEGTables, abbreviated datastreams) and old-style Compression 6 through
// one JPEGInterchangeFormat datastream, with the engine's shared JPEG decoder. Bilevel and greyscale (WhiteIsZero or
// BlackIsZero), RGB and palette images of 1, 2, 4, 8 or 16 bits per sample, CMYK (Section 16, with DotRange) at 8 or
// 16 bits, YCbCr (Section 21: subsampled data units or planes, YCbCrCoefficients, YCbCrPositioning,
// ReferenceBlackWhite) and CIE or ICC L*a*b* (Section 23, D65 white) at 8 bits, and 16, 32 or 64-bit float grey or RGB
// (16-bit is the OpenEXR half that Adobe Photoshop TIFF Technical Note 3, 2005, names), with or without that note's
// floating point predictor (Predictor 3), chunky or planar (PlanarConfiguration 1 or 2). FillOrder 2 is read for 1-bit
// data. The first extra sample is alpha when ExtraSamples marks it associated (premultiplied, divided out) or
// unassociated; unspecified extra samples are dropped. LZMA (34925), Zstandard (50000) and WebP (50001) strips and
// tiles, as libtiff writes them, decode through codecs the caller loads with loadTIFFCodecs (tiff-codecs.ts): each is
// its own lazy chunk, so a reader of the other compressions never fetches them.
import { inflateZlib } from '../../shared/inflate.js';
import { decodeJPEGComponents } from '../../shared/jpeg.js';
import { decodeCCITT } from './ccitt.js';
import { decodeFailed } from './errors.js';
import { corrupt, scanTIFF } from './tiff-ifd.js';

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
  /**
   * Decoders for LZMA, Zstandard and WebP strips and tiles, which load on demand: pass the result of
   * `loadTIFFCodecs` from `@margoengine/decoders/tiff-codecs`. Default none: a file using one of those compressions
   * without its codec throws a MargoError `failed` naming loadTIFFCodecs.
   */
  codecs?: TIFFCodecs;
}

/** The TIFF compressions whose decoders load on demand, each a synchronous decoder of one whole strip or tile. */
export interface TIFFCodecs {
  /** LZMA (Compression 34925): one whole .xz stream into at most `maxBytes` bytes. */
  lzma?: (bytes: Uint8Array, options: { maxBytes: number }) => Uint8Array;
  /** Zstandard (Compression 50000): one whole frame into at most `maxOutputSize` bytes. */
  zstd?: (bytes: Uint8Array, options: { maxOutputSize: number }) => Uint8Array;
  /** WebP (Compression 50001): one whole RIFF WebP file into RGBA8 pixels. */
  webp?: (bytes: Uint8Array, options: { maxPixels: number }) => { width: number; height: number; data: Uint8Array };
}

/** Precision-preserving pixel storage, interleaved in raster order. */
export type TIFFSamples =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;
/** One decoded IFD, without display colour conversion or integer scaling. */
export interface TIFFPage {
  readonly width: number;
  readonly height: number;
  readonly bits: number;
  readonly sampleFormat: number;
  readonly samplesPerPixel: number;
  readonly samples: TIFFSamples;
  readonly description: string;
  readonly tags: ReadonlyMap<number, readonly number[]>;
  /**
   * The ASCII tags the reader keeps, by tag number: ImageDescription (270), GeoAsciiParams (34737, with its `|`
   * terminators), GDAL_METADATA (42112, XML text) and GDAL_NODATA (42113, a number as text). Absent tags are not in it.
   * `@margoengine/decoders/geotiff` reads the georeference and the no-data value from these and `tags`.
   */
  readonly ascii: ReadonlyMap<number, string>;
}
/** Bounded, lazy classic TIFF or BigTIFF directory reader. */
export interface TIFFFile {
  readonly bigTIFF: boolean;
  readonly length: number;
  readonly descriptions: readonly string[];
  read(index: number, signal?: AbortSignal): TIFFPage;
}

/**
 * Reads directory metadata once; pixels decompress only when read(index) is called. Bytes remain borrowed. LZMA,
 * Zstandard and WebP pages need `codecs` from `loadTIFFCodecs` (`@margoengine/decoders/tiff-codecs`).
 * @example
 * const file = openTIFF(bytes, { codecs: await loadTIFFCodecs(bytes) });
 * const page = file.read(0);
 */
export function openTIFF(bytes: Uint8Array, options: TIFFOptions = {}): TIFFFile {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('openTIFF needs Uint8Array bytes');
  const maxPixels = options.maxPixels ?? 2 ** 26;
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1) throw new RangeError('TIFF maxPixels must be positive');
  const { little, bigTIFF, directories, descriptions, asciiTags } = scanTIFF(bytes),
    codecs = options.codecs ?? {};
  return {
    bigTIFF,
    length: directories.length,
    descriptions,
    read(index, signal) {
      signal?.throwIfAborted();
      if (!Number.isInteger(index) || index < 0 || index >= directories.length)
        throw corrupt('page index is out of range');
      return rawTIFF(bytes, little, directories[index], descriptions[index], asciiTags[index], maxPixels, codecs, signal);
    },
  };
}

function rawTIFF(
  bytes: Uint8Array,
  little: boolean,
  tags: Map<number, number[]>,
  description: string,
  ascii: ReadonlyMap<number, string>,
  maxPixels: number,
  codecs: TIFFCodecs,
  signal?: AbortSignal,
): TIFFPage {
  const tag = (id: number, fallback?: number): number => {
    const n = tags.get(id)?.[0] ?? fallback;
    if (n === undefined) throw corrupt(`required tag ${id} is missing`);
    return n;
  };
  const width = tag(256),
    height = tag(257),
    spp = tag(277, 1),
    bits = tag(258, 1),
    format = tag(339, 1),
    planar = tag(284, 1),
    predictor = tag(317, 1),
    compression = tag(259, 1);
  if (
    ![width, height, spp].every((n) => Number.isSafeInteger(n) && n > 0) ||
    spp > 16 ||
    width * height > maxPixels ||
    width * height * spp > maxPixels * 4
  )
    throw corrupt('image exceeds sample bound');
  if (
    ![1, 2, 3].includes(format) ||
    (format === 3 ? ![16, 32, 64].includes(bits) : ![1, 2, 4, 8, 16, 32].includes(bits)) ||
    (format === 2 && bits < 8)
  )
    throw refuse('sample format');
  if ((tags.get(258) ?? [bits]).some((b) => b !== bits) || (tags.get(339) ?? [format]).some((f) => f !== format))
    throw refuse('mixed sample formats');
  const fillOrder = tag(266, 1),
    jpeg = compression === 6 || compression === 7,
    ccitt = compression >= 2 && compression <= 4,
    webp = compression === 50001,
    [sh, sv] = tag(262, spp >= 3 ? 2 : 1) === 6 ? (tags.get(530) ?? [2, 2]) : [1, 1];
  if (
    ![1, 2].includes(planar) ||
    !COMPRESSIONS.includes(compression) ||
    (fillOrder !== 1 && !(fillOrder === 2 && bits === 1 && [1, 2, 3, 4, 32773].includes(compression)))
  )
    throw refuse('storage layout');
  // Pages keep their stored samples: subsampled YCbCr outside JPEG (Section 21 data units) has no per-pixel layout.
  if ((sh !== 1 || sv !== 1) && !(jpeg && planar === 1)) throw refuse('subsampled YCbCr page');
  if (ccitt && (bits !== 1 || spp !== 1)) throw corrupt('CCITT compression needs 1-bit bilevel data');
  if ((jpeg || webp) && (bits !== 8 || format !== 1))
    throw refuse(`${jpeg ? 'JPEG' : 'WebP'} with ${bits}-bit samples`);
  if (webp && (planar !== 1 || (spp !== 3 && spp !== 4)))
    throw corrupt('WebP compression needs 8-bit RGB or RGBA samples, chunky');
  if (
    predictor !== 1 &&
    (jpeg || ccitt || webp || (!(predictor === 2 && format !== 3 && bits >= 8) && !(predictor === 3 && format === 3)))
  )
    throw refuse('predictor');
  const tiled = tags.has(322),
    tw = tiled ? tag(322) : width,
    th = tiled ? tag(323) : Math.min(tag(278, height), height);
  if (![tw, th].every((n) => Number.isSafeInteger(n) && n > 0) || tw > width + 1024 || th > height + 1024)
    throw corrupt('invalid tile or strip size');
  const across = Math.ceil(width / tw),
    down = Math.ceil(height / th),
    planes = planar === 2 ? spp : 1,
    channels = planar === 2 ? 1 : spp;
  const offsets = tags.get(tiled ? 324 : 273),
    counts = tags.get(tiled ? 325 : 279),
    rowBytes = Math.ceil((tw * channels * bits) / 8),
    max = 2 ** bits - 1;
  if (!offsets || !counts || offsets.length !== across * down * planes || counts.length !== offsets.length)
    throw corrupt('missing block offsets or counts');
  const Ctor =
    format === 3
      ? bits === 64
        ? Float64Array
        : Float32Array
      : format === 2
        ? bits === 8
          ? Int8Array
          : bits === 16
            ? Int16Array
            : Int32Array
        : bits <= 8
          ? Uint8Array
          : bits === 16
            ? Uint16Array
            : Uint32Array;
  const samples: TIFFSamples = new Ctor(width * height * spp),
    tables = tags.get(347);
  if (compression === 6) {
    // Old-style JPEG: the one interchange datastream JPEGInterchangeFormat points at, its components as stored.
    if (!tags.has(513) || planar !== 1)
      throw refuse('old-style JPEG (compression 6) without one JPEGInterchangeFormat datastream');
    const start = tag(513),
      stop = Math.max(start + tag(514, 0), ...offsets.map((o, i) => o + counts[i]));
    if (!Number.isSafeInteger(stop) || start + 2 > bytes.length || stop > bytes.length)
      throw corrupt('JPEGInterchangeFormat runs past the end');
    const frame = decodeJPEGComponents(bytes.subarray(start, stop), { maxPixels }, [spp]);
    if (frame.width < width || frame.height < height) throw corrupt('JPEG frame is smaller than the image');
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let c = 0; c < spp; c++) samples[(y * width + x) * spp + c] = Math.round(frame.planes[c](x, y));
    return { width, height, bits, sampleFormat: format, samplesPerPixel: spp, samples, description, tags, ascii };
  }
  for (let plane = 0; plane < planes; plane++)
    for (let by = 0; by < down; by++)
      for (let bx = 0; bx < across; bx++) {
        signal?.throwIfAborted();
        const index = (plane * down + by) * across + bx,
          rows = tiled ? th : Math.min(th, height - by * th),
          size = rowBytes * rows,
          offset = offsets[index],
          count = counts[index];
        if (!Number.isSafeInteger(offset + count) || offset < 0 || count < 0 || offset + count > bytes.length)
          throw corrupt('block exceeds file');
        let raw = bytes.subarray(offset, offset + count);
        if (fillOrder === 2 && compression !== 32773) raw = reverseBits(raw);
        if (jpeg) {
          // Technical Note 2: each strip or tile is a JPEG datastream (tables from JPEGTables), components as stored.
          const frame = decodeJPEGComponents(jpegStream(tables, raw), { maxPixels }, [channels]),
            w = Math.min(tw, width - bx * tw),
            h = Math.min(rows, height - by * th);
          if (frame.width < w || frame.height < h) throw corrupt('JPEG frame is smaller than its strip or tile');
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++)
              for (let c = 0; c < channels; c++)
                samples[((by * th + y) * width + bx * tw + x) * spp + (planar === 2 ? plane : c)] = Math.round(
                  frame.planes[c](x, y),
                );
          continue;
        }
        let decoded = decompress(compression, raw, size, tw, rows, channels, tag(292, 0), codecs);
        if (decoded.length < size) throw corrupt('short block');
        if (fillOrder === 2 && compression === 32773) decoded = reverseBits(decoded);
        const block = predictor === 3 ? decoded.slice() : decoded,
          data = new DataView(block.buffer, block.byteOffset, block.byteLength),
          row = new Float64Array(tw * channels),
          bps = bits / 8;
        for (let y = 0; y < rows; y++) {
          if (predictor === 3) floatPredictorRow(block, y * rowBytes, tw * channels, channels, bps, little);
          for (let i = 0; i < row.length; i++) {
            const at = y * rowBytes + i * bps;
            let v =
              format === 3
                ? readFloat(data, at, bits, little)
                : bits === 32
                  ? data.getUint32(at, little)
                  : bits === 16
                    ? data.getUint16(at, little)
                    : bits === 8
                      ? block[at]
                      : (block[y * rowBytes + ((i * bits) >> 3)] >> (8 - bits - ((i * bits) & 7))) & max;
            if (predictor === 2 && i >= channels) v = (v + row[i - channels]) % (max + 1);
            row[i] = v;
          }
          if (by * th + y >= height) continue;
          for (let x = 0; x < tw && bx * tw + x < width; x++)
            for (let c = 0; c < channels; c++)
              samples[((by * th + y) * width + bx * tw + x) * spp + (planar === 2 ? plane : c)] = row[x * channels + c];
        }
      }
  return { width, height, bits, sampleFormat: format, samplesPerPixel: spp, samples, description, tags, ascii };
}

/**
 * Undoes TIFF Predictor 3 on one row in place (Adobe Photoshop TIFF Technical Note 3, 2005): the row's bytes were
 * differenced with a stride of `channels`, after each sample's bytes were spread into `bps` planes, most significant
 * byte first, whatever the file's byte order. The row ends in the file's byte order.
 */
function floatPredictorRow(
  block: Uint8Array,
  begin: number,
  n: number,
  channels: number,
  bps: number,
  little: boolean,
): void {
  const rowBytes = n * bps,
    ordered = new Uint8Array(rowBytes);
  for (let i = channels; i < rowBytes; i++) block[begin + i] = (block[begin + i] + block[begin + i - channels]) & 255;
  for (let i = 0; i < n; i++)
    for (let b = 0; b < bps; b++) ordered[i * bps + (little ? bps - 1 - b : b)] = block[begin + b * n + i];
  block.set(ordered, begin);
}

/** A 16-bit (OpenEXR half, Technical Note 3), 32-bit or 64-bit IEEE float sample. */
function readFloat(data: DataView, at: number, bits: number, little: boolean): number {
  if (bits === 32) return data.getFloat32(at, little);
  if (bits === 64) return data.getFloat64(at, little);
  const h = data.getUint16(at, little),
    e = (h >> 10) & 31,
    m = h & 1023,
    v = e === 0 ? m * 2 ** -24 : e === 31 ? (m ? Number.NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15);
  return h & 0x8000 ? -v : v;
}

const SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

const refuse = (what: string): Error =>
  decodeFailed(`TIFF ${what} is not supported; save the image as baseline 8-bit, 16-bit or float RGB, grey or palette`);

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
/** CIE 1976 L*a*b* (TIFF 6.0 Section 23, D65 reference white) to sRGB 0 to 255, through XYZ (CSS Color 4 matrices). */
function labToRGB(L: number, a: number, b: number, rgb: number[]): void {
  const fy = (L + 16) / 116,
    // The inverse of the section's cube root, with its linear segment below 0.008856 (7.787 F + 16 / 116).
    inverse = (t: number) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787),
    X = 0.95045592705 * inverse(fy + a / 500),
    Y = inverse(fy),
    Z = 1.08905775076 * inverse(fy - b / 200),
    linear = [
      3.2409699419 * X - 1.5373831776 * Y - 0.4986107603 * Z,
      -0.9692436363 * X + 1.8759675015 * Y + 0.0415550574 * Z,
      0.0556300797 * X - 0.2039769589 * Y + 1.0569715142 * Z,
    ];
  for (let c = 0; c < 3; c++) {
    const v = linear[c];
    rgb[c] = 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.min(v, 1) ** (1 / 2.4) - 0.055);
  }
}

/** Reverses the bit order of every byte (FillOrder 2: the first pixel or code bit in the low bit). */
const reverseBits = (src: Uint8Array): Uint8Array =>
  src.map((v) => {
    v = ((v & 0xf0) >> 4) | ((v & 0x0f) << 4);
    v = ((v & 0xcc) >> 2) | ((v & 0x33) << 2);
    return ((v & 0xaa) >> 1) | ((v & 0x55) << 1);
  });

/** The compressions both readers take strip or tile by strip or tile (JPEG is read on its own). */
const COMPRESSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 32773, 32946, 34925, 50000, 50001];

/**
 * Undoes one strip or tile's compression, other than JPEG: `size` bytes are expected, `width` x `height` samples of
 * `channels` each. LZMA (34925) strips are whole .xz streams and Zstandard (50000) strips whole frames, as libtiff
 * writes them; a WebP (50001) strip or tile is a whole RIFF WebP file of exactly its size, RGB or RGBA.
 */
function decompress(
  compression: number,
  raw: Uint8Array,
  size: number,
  width: number,
  height: number,
  channels: number,
  t4Options: number,
  codecs: TIFFCodecs,
): Uint8Array {
  if (compression === 1) return raw;
  if (compression === 5) return lzw(raw, size);
  if (compression === 32773) return packBits(raw, size);
  if (compression === 8 || compression === 32946) return inflateZlib(raw, size);
  if (compression >= 2 && compression <= 4)
    return decodeCCITT(raw, width, height, {
      compression: compression as 2 | 3 | 4,
      twoDimensional: !!(t4Options & 1),
    });
  const { lzma, zstd, webp } = codecs,
    missing = (name: string) =>
      decodeFailed(
        `TIFF compression ${compression} (${name}) needs its decoder; pass { codecs: await loadTIFFCodecs(bytes) } from @margoengine/decoders/tiff-codecs`,
      );
  if (compression === 34925) {
    if (!lzma) throw missing('LZMA');
    return lzma(raw, { maxBytes: size });
  }
  if (compression === 50000) {
    if (!zstd) throw missing('Zstandard');
    try {
      return zstd(raw, { maxOutputSize: size });
    } catch (error) {
      // The shared decoder names damage with a RangeError; here it is one damaged strip or tile of a TIFF file.
      if (error instanceof RangeError) throw corrupt(`Zstandard strip or tile: ${error.message.replace(/\.$/, '')}`);
      throw error;
    }
  }
  if (!webp) throw missing('WebP');
  const image = webp(raw, { maxPixels: width * height });
  if (image.width !== width || image.height !== height) throw corrupt('a WebP strip or tile is not its own size');
  if (channels === 4) return image.data;
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) rgb.set(image.data.subarray(p * 4, p * 4 + 3), p * 3);
  return rgb;
}

/** A JPEG segment's datastream with the JPEGTables field's tables in front (TIFF Technical Note 2, abbreviated form). */
function jpegStream(tables: number[] | undefined, raw: Uint8Array): Uint8Array {
  if (!tables || tables.length < 4) return raw;
  const head =
      tables[tables.length - 2] === 0xff && tables[tables.length - 1] === 0xd9 ? tables.length - 2 : tables.length,
    skip = raw[0] === 0xff && raw[1] === 0xd8 ? 2 : 0,
    out = new Uint8Array(head + raw.length - skip);
  out.set(tables.slice(0, head));
  out.set(raw.subarray(skip), head);
  return out;
}

/**
 * Decodes the first image of a TIFF file, top row first. Grey, palette, CMYK, YCbCr and CIE L*a*b* images expand to
 * RGBA; integer samples become RGBA8, float samples RGBA 32-bit floats.
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError when the image is larger than `maxPixels`.
 * @throws MargoError `failed` when the bytes are not a complete, valid TIFF file, or use a compression, colour space
 * or sample layout outside the ones listed above (signed samples, 24-bit floats, inks other than CMYK, ITU L*a*b*,
 * lossless or 12-bit JPEG, old-style JPEG without JPEGInterchangeFormat), or LZMA, Zstandard or WebP without its
 * decoder in `codecs`.
 * @example
 * const image = parseTIFF(bytes, { codecs: await loadTIFFCodecs(bytes) });
 */
export function parseTIFF(bytes: Uint8Array, options: TIFFOptions = {}): DecodedTIFF {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseTIFF needs the TIFF file as a Uint8Array');
  const maxPixels = options.maxPixels ?? 2 ** 26,
    codecs = options.codecs ?? {};
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
    // Only BYTE, SHORT, LONG, RATIONAL and UNDEFINED fields are read; others (ASCII, signed, ...) are skipped.
    if (![1, 3, 4, 5, 7].includes(type)) continue;
    const offset = size * count > 4 ? u32(at + 8) : at + 8;
    if (offset + size * count > bytes.length) throw corrupt(`tag ${u16(at)} runs past the end`);
    tags.set(
      u16(at),
      Array.from({ length: count }, (_, i) =>
        type === 1 || type === 7
          ? bytes[offset + i]
          : type === 3
            ? u16(offset + i * 2)
            : type === 4
              ? u32(offset + i * 4)
              : u32(offset + i * 8) / u32(offset + i * 8 + 4),
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
    fillOrder = tag(266, 1),
    float = tag(339, 1) === 3,
    extras = tags.get(338) ?? [],
    jpeg = compression === 6 || compression === 7,
    ccitt = compression >= 2 && compression <= 4,
    webp = compression === 50001,
    base =
      photometric === 2 || photometric === 6
        ? 3
        : photometric === 5
          ? 4
          : (photometric === 8 || photometric === 9) && spp - extras.length >= 3
            ? 3
            : 1,
    extra = extras[0],
    alpha = spp > base && (extra === 1 || extra === 2),
    tiled = tags.has(322),
    [sh, sv] = photometric === 6 ? (tags.get(530) ?? [2, 2]) : [1, 1],
    // Chroma stored at reduced size: in data units (chunky) or smaller planes. JPEG upsamples chunky chroma itself.
    subsampled = (sh > 1 || sv > 1) && !(jpeg && planar === 1);
  if (!width || !height) throw corrupt('size is 0');
  if (width * height > maxPixels)
    throw new RangeError(`TIFF is ${width} x ${height}, over maxPixels ${maxPixels}; raise maxPixels to decode it`);
  if (bitsList.some((b) => b !== bits) || (tags.get(339) ?? [1]).some((f) => f !== (float ? 3 : 1)))
    throw refuse('mixed or signed sample formats');
  if (float ? ![16, 32, 64].includes(bits) : ![1, 2, 4, 8, 16].includes(bits))
    throw refuse(`${bits}-bit ${float ? 'float ' : ''}samples`);
  if (
    ![0, 1, 2, 3, 5, 6, 8, 9].includes(photometric) ||
    spp < base ||
    (float && photometric !== 1 && photometric !== 2)
  )
    throw refuse(`photometric interpretation ${photometric}`);
  if ((photometric >= 6 && bits !== 8) || (photometric === 5 && bits < 8))
    throw refuse(`${bits}-bit samples in photometric interpretation ${photometric}`);
  if (photometric === 5 && (tag(332, 1) !== 1 || tag(334, 4) !== 4))
    throw refuse('a separated image with inks other than CMYK (InkSet 2)');
  if (spp > 16) throw refuse(`${spp} samples per pixel`);
  if (planar !== 1 && planar !== 2) throw corrupt(`PlanarConfiguration ${planar} is invalid`);
  if (![1, 2, 4].includes(sh) || ![1, 2, 4].includes(sv)) throw corrupt(`YCbCrSubSampling ${sh}, ${sv} is invalid`);
  // Technical Note 2's Section 21 changes: extra samples are full size, so only planar files can hold them.
  if (subsampled && ((planar === 1 && spp !== 3) || predictor !== 1))
    throw refuse('subsampled chunky YCbCr with extra samples, or with a predictor');
  if (fillOrder !== 1 && !(fillOrder === 2 && bits === 1 && [1, 2, 3, 4, 32773].includes(compression)))
    throw refuse(`FillOrder ${fillOrder}`);
  if (
    predictor !== 1 &&
    (jpeg ||
      ccitt ||
      webp ||
      (!(predictor === 2 && !float && (bits === 8 || bits === 16)) && !(predictor === 3 && float)))
  )
    throw refuse(`Predictor ${predictor} with ${bits}-bit samples`);
  if (!COMPRESSIONS.includes(compression)) throw refuse(`compression ${compression}`);
  if (webp && (bits !== 8 || float || planar !== 1 || (spp !== 3 && spp !== 4)))
    throw corrupt('WebP compression needs 8-bit RGB or RGBA samples, chunky');
  if (ccitt && (bits !== 1 || spp !== 1 || photometric > 1))
    throw corrupt('CCITT compression needs 1-bit bilevel data');
  if (jpeg && bits !== 8) throw refuse(`JPEG with ${bits}-bit samples`);
  const tileW = tiled ? tag(322) : width,
    tileH = tiled ? tag(323) : Math.min(tag(278, height), height),
    offsets = tags.get(tiled ? 324 : 273),
    counts = tags.get(tiled ? 325 : 279),
    across = Math.ceil(width / tileW),
    down = Math.ceil(height / tileH),
    planes = planar === 2 ? spp : 1,
    perPixel = planar === 2 ? 1 : spp,
    max = 2 ** bits - 1,
    // Chroma planes of a subsampled YCbCr image, at their stored size.
    cw = Math.ceil(width / sh),
    ch = Math.ceil(height / sv),
    chroma = subsampled ? [new Uint8Array(cw * ch), new Uint8Array(cw * ch)] : [];
  if (!tileW || !tileH) throw corrupt('tile or strip size is 0');
  // Tiles may overhang the image edge; one far larger than the image is corrupt and would need a huge buffer.
  if (tileW > width + 1024 || tileH > height + 1024)
    throw corrupt(`tile ${tileW} x ${tileH} is far larger than the image`);
  // Section 21: tiles and strips hold whole chroma samples.
  if (subsampled && ((tiled && tileW % sh) || (down > 1 && tileH % sv)))
    throw corrupt(`tile or strip size does not hold whole YCbCrSubSampling ${sh} x ${sv} units`);
  const samples = float ? new Float32Array(width * height * spp) : new Uint16Array(width * height * spp),
    tables = tags.get(347);
  if (compression === 6) {
    // Old-style JPEG (TIFF 6.0 Section 22, replaced by Technical Note 2): read the interchange datastream that
    // JPEGInterchangeFormat points at, through the strips that follow it.
    if (!tags.has(513) || planar !== 1)
      throw refuse('old-style JPEG (compression 6) without one JPEGInterchangeFormat datastream');
    const start = tag(513),
      stop = Math.max(start + tag(514, 0), ...(offsets ?? []).map((o, i) => o + (counts?.[i] ?? 0)));
    if (start + 2 > bytes.length || stop > bytes.length) throw corrupt('JPEGInterchangeFormat runs past the end');
    const frame = decodeJPEGComponents(bytes.subarray(start, stop), { maxPixels }, [spp]);
    if (frame.width < width || frame.height < height) throw corrupt('JPEG frame is smaller than the image');
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let c = 0; c < spp; c++) samples[(y * width + x) * spp + c] = Math.round(frame.planes[c](x, y));
  } else {
    if (!offsets || !counts || offsets.length < across * down * planes || counts.length < offsets.length)
      throw corrupt('strip or tile offsets are missing');
    for (let plane = 0; plane < planes; plane++)
      for (let by = 0; by < down; by++)
        for (let bx = 0; bx < across; bx++) {
          const index = (plane * down + by) * across + bx,
            rows = tiled ? tileH : Math.min(tileH, height - by * tileH),
            // A chroma plane of a subsampled planar image: its own reduced size and its own destination.
            small = subsampled && (plane === 1 || plane === 2) ? chroma[plane - 1] : undefined,
            segW = small ? Math.ceil(tileW / sh) : tileW,
            segH = small ? Math.ceil(rows / sv) : rows,
            x0 = small ? (bx * tileW) / sh : bx * tileW,
            y0 = small ? (by * tileH) / sv : by * tileH,
            limitW = small ? cw : width,
            limitH = small ? ch : height,
            rowBytes = Math.ceil((segW * perPixel * bits) / 8),
            units = subsampled && planar === 1,
            size = units ? Math.ceil(tileW / sh) * Math.ceil(rows / sv) * (sh * sv + 2) : rowBytes * segH,
            offset = offsets[index];
          if (offset + counts[index] > bytes.length) throw corrupt(`strip or tile ${index} runs past the end`);
          const put = (x: number, y: number, c: number, v: number) => {
            if (x0 + x >= limitW || y0 + y >= limitH) return;
            if (small) small[(y0 + y) * cw + x0 + x] = v;
            else samples[((y0 + y) * width + x0 + x) * spp + plane + c] = v;
          };
          let raw = bytes.subarray(offset, offset + counts[index]);
          if (fillOrder === 2 && compression !== 32773) raw = reverseBits(raw);
          if (jpeg) {
            const frame = decodeJPEGComponents(jpegStream(tables, raw), { maxPixels }, [perPixel]);
            if (frame.width < Math.min(segW, limitW - x0) || frame.height < Math.min(segH, limitH - y0))
              throw corrupt(`JPEG frame of strip or tile ${index} is smaller than the segment`);
            for (let y = 0; y < Math.min(segH, frame.height); y++)
              for (let x = 0; x < Math.min(segW, frame.width); x++)
                for (let c = 0; c < perPixel; c++) put(x, y, c, Math.round(frame.planes[c](x, y)));
            continue;
          }
          let block = decompress(compression, raw, size, segW, segH, perPixel, tag(292, 0), codecs);
          if (block.length < size) throw corrupt(`strip or tile ${index} is too short`);
          if (fillOrder === 2 && compression === 32773) block = reverseBits(block);
          if (units) {
            // Section 21 data units: sv rows of sh luma samples, then Cb and Cr.
            const unitsWide = Math.ceil(tileW / sh),
              chromaX = (bx * tileW) / sh,
              chromaY = (by * tileH) / sv;
            for (let uy = 0, at = 0; uy < Math.ceil(rows / sv); uy++)
              for (let ux = 0; ux < unitsWide; ux++, at += sh * sv + 2) {
                for (let j = 0; j < sv; j++)
                  for (let i = 0; i < sh; i++) put(ux * sh + i, uy * sv + j, 0, block[at + j * sh + i]);
                if (chromaX + ux < cw && chromaY + uy < ch)
                  for (let k = 0; k < 2; k++) chroma[k][(chromaY + uy) * cw + chromaX + ux] = block[at + sh * sv + k];
              }
            continue;
          }
          // Predictor 3 reorders bytes in place, so it works on a copy, never on the caller's bytes.
          const own = predictor === 3 ? block.slice(0, size) : block,
            data = new DataView(own.buffer, own.byteOffset, own.byteLength),
            row = new Float64Array(segW * perPixel);
          for (let y = 0; y < segH; y++) {
            if (predictor === 3) floatPredictorRow(own, y * rowBytes, segW * perPixel, perPixel, bits / 8, little);
            // One row's samples, the predictor's differences summed modulo 2^bits.
            for (let i = 0; i < row.length; i++) {
              const at = y * rowBytes;
              row[i] = float
                ? readFloat(data, at + (i * bits) / 8, bits, little)
                : bits === 16
                  ? data.getUint16(at + i * 2, little)
                  : bits === 8
                    ? block[at + i]
                    : (block[at + ((i * bits) >> 3)] >> (8 - bits - ((i * bits) & 7))) & max;
              if (predictor === 2 && i >= perPixel) row[i] = (row[i] + row[i - perPixel]) % (max + 1);
            }
            for (let x = 0; x < segW; x++) for (let c = 0; c < perPixel; c++) put(x, y, c, row[x * perPixel + c]);
          }
        }
  }
  if (subsampled) {
    // Section 21 YCbCrPositioning: 1 puts each chroma sample at the centre of its luma group, 2 on its first sample.
    // Chroma is filtered up linearly between those positions.
    const centred = tag(531, 1) === 1,
      offsetX = centred ? sh / 2 - 0.5 : 0,
      offsetY = centred ? sv / 2 - 0.5 : 0;
    for (let y = 0; y < height; y++) {
      const v = Math.min(Math.max((y - offsetY) / sv, 0), ch - 1),
        y1 = v | 0,
        y2 = Math.min(y1 + 1, ch - 1),
        fy = v - y1;
      for (let x = 0; x < width; x++) {
        const u = Math.min(Math.max((x - offsetX) / sh, 0), cw - 1),
          x1 = u | 0,
          x2 = Math.min(x1 + 1, cw - 1),
          fx = u - x1;
        for (let k = 0; k < 2; k++) {
          const p = chroma[k],
            top = p[y1 * cw + x1] * (1 - fx) + p[y1 * cw + x2] * fx,
            bottom = p[y2 * cw + x1] * (1 - fx) + p[y2 * cw + x2] * fx;
          samples[(y * width + x) * spp + 1 + k] = Math.round(top * (1 - fy) + bottom * fy);
        }
      }
    }
  }
  const out = float ? new Float32Array(width * height * 4) : new Uint8Array(width * height * 4),
    map = tags.get(320),
    paletteSize = 2 ** bits,
    scale = float ? 1 : 255 / max,
    // Section 20 and 21: coding ranges, and the luma coefficients. A YCbCr file without ReferenceBlackWhite gets the
    // values that need no expansion ([0, 255, 128, 255, 128, 255]; the generic default is wrong for YCbCr, the spec says).
    reference = tags.get(532)?.length === 6 ? tags.get(532)! : [0, 255, 128, 255, 128, 255],
    [lumaR, lumaG, lumaB] = tags.get(529)?.length === 3 ? tags.get(529)! : [0.299, 0.587, 0.114],
    dots = tags.get(336),
    rgb = [0, 0, 0];
  if (photometric === 3 && (!map || map.length < 3 * paletteSize)) throw corrupt('palette image has no ColorMap');
  if (
    photometric === 6 &&
    (lumaG === 0 || reference[1] === reference[0] || reference[3] === reference[2] || reference[5] === reference[4])
  )
    throw corrupt('YCbCrCoefficients or ReferenceBlackWhite are degenerate');
  for (let p = 0; p < width * height; p++) {
    const s = p * spp,
      o = p * 4,
      a = alpha ? samples[s + base] * scale : float ? 1 : 255;
    if (photometric === 3) for (let c = 0; c < 3; c++) rgb[c] = map![samples[s] + c * paletteSize] / 257;
    else if (photometric === 5) {
      // Section 16: ink coverage, 0% to 100% between the DotRange values (default 0 and 2^bits - 1).
      const ink = (c: number) => {
        const pair = dots && dots.length >= 8 ? c * 2 : 0,
          low = dots && dots.length >= 2 ? dots[pair] : 0,
          high = dots && dots.length >= 2 ? dots[pair + 1] : max;
        return high > low ? Math.min(Math.max((samples[s + c] - low) / (high - low), 0), 1) : 0;
      };
      const k = 1 - ink(3);
      for (let c = 0; c < 3; c++) rgb[c] = 255 * (1 - ink(c)) * k;
    } else if (photometric === 6) {
      const y = ((samples[s] - reference[0]) * 255) / (reference[1] - reference[0]),
        cb = ((samples[s + 1] - reference[2]) * 127) / (reference[3] - reference[2]),
        cr = ((samples[s + 2] - reference[4]) * 127) / (reference[5] - reference[4]);
      rgb[0] = cr * (2 - 2 * lumaR) + y;
      rgb[2] = cb * (2 - 2 * lumaB) + y;
      rgb[1] = (y - lumaB * rgb[2] - lumaR * rgb[0]) / lumaG;
    } else if (photometric >= 8) {
      // CIELab stores a* and b* as signed bytes, ICCLab offset by 128.
      const signed = (v: number) => (photometric === 8 ? (v << 24) >> 24 : v - 128);
      labToRGB(
        (samples[s] * 100) / 255,
        base === 3 ? signed(samples[s + 1]) : 0,
        base === 3 ? signed(samples[s + 2]) : 0,
        rgb,
      );
    } else
      for (let c = 0; c < 3; c++) {
        const raw = samples[s + (base === 3 ? c : 0)];
        rgb[c] = (photometric === 0 ? max - raw : raw) * scale;
      }
    for (let c = 0; c < 3; c++) {
      let v = rgb[c];
      if (alpha && extra === 1) v = a ? (v * (float ? 1 : 255)) / a : 0;
      out[o + c] = float ? v : Math.min(255, Math.max(0, Math.round(v)));
    }
    out[o + 3] = float ? a : Math.round(a);
  }
  return float
    ? { width, height, format: 'rgba32float', data: out as Float32Array }
    : { width, height, format: 'rgba8unorm', data: out as Uint8Array };
}
