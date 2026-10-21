// Radiance RGBE (.hdr) decoder: the Three.js RGBELoader equivalent, written from the public picture-format notes
// (radsite.lbl.gov/radiance/refer/Notes/picture_format.html).
import { MargoError } from '@margoengine/math/errors';

/** Linear float image, row 0 at the top. `data` is RGBA (4 floats per pixel; alpha is 1 when the file has none). */
export interface FloatImage {
  width: number;
  height: number;
  data: Float32Array;
}

/** A decoded Radiance image: linear floats (RGBA by default, RGB with `channels: 3`), row 0 at the top. */
export interface HDRImage extends FloatImage {
  /** Value of the EXPOSURE header lines multiplied together (1 when absent). Not applied to `data`. */
  exposure: number;
  /** Value of the GAMMA header line (1 when absent). Not applied to `data`. */
  gamma: number;
  /** Floats per pixel in `data`: 4 (RGBA, the default) or 3 (RGB, `channels: 3`). */
  channels: 3 | 4;
  /** How the file was stored. */
  diagnostics: HDRDiagnostics;
}

/** What `parseHDR` found in a file, for import reports and support. */
export interface HDRDiagnostics {
  /** The FORMAT header value, `''` when the file has none (Radiance then means RGBE). */
  format: string;
  /** The resolution line as stored, normalized to single spaces: `'-Y 512 +X 1024'` is the standard top-down order. */
  orientation: string;
  /** The axis of each stored scanline: `'X'` for rows (standard), `'Y'` for columns (an X-major, transposed file). */
  scanAxis: 'X' | 'Y';
  /** Scanlines stored flat (4 bytes a pixel), with old-style (1, 1, 1, n) repeats, and as adaptive planar RLE. */
  scanlines: { flat: number; legacyRLE: number; planarRLE: number };
  /** Bytes from the signature through the resolution line. */
  headerBytes: number;
  /** Bytes after the last scanline, ignored. */
  trailingBytes: number;
}

/** Bounds `parseHDR` checks before it allocates the image. */
export interface HDRLimits {
  /** Largest input in bytes. Default: no limit. */
  maxBytes?: number;
  /** Widest image in pixels. Default: no limit beyond `maxPixels`. */
  maxWidth?: number;
  /** Tallest image in pixels. Default: no limit beyond `maxPixels`. */
  maxHeight?: number;
  /** Most pixels, 1 to 67,108,864 (2^26, the default). */
  maxPixels?: number;
  /** Most header bytes, signature through resolution line. Default 1,048,576. */
  maxHeaderBytes?: number;
}

/** Options of `parseHDR`. Without options it decodes as before: RGBA, `-Y h +X w` or `+Y h +X w` only. */
export interface HDRParseOptions {
  /** Floats per decoded pixel: 4 (RGBA, alpha 1; default) or 3 (RGB). */
  channels?: 3 | 4;
  /**
   * `'standard'` (default) accepts the top-down and bottom-up row orders (`-Y h +X w`, `+Y h +X w`) and refuses the
   * rest. `'all'` also decodes mirrored X (`-X`) and the X-major (column-scanned) orders `±X w ±Y h`; every order
   * lands as row 0 at the top and column 0 at the left.
   */
  orientation?: 'standard' | 'all';
  /** Refuse a file without a FORMAT line, instead of reading it as RGBE. Default false. */
  requireFormat?: boolean;
  /** Bounds checked before allocation; exceeding one throws RangeError. */
  limits?: HDRLimits;
}

/** Hard limit on decoded pixels, about 1 GiB of float RGBA. */
export const MAX_PIXELS = 1 << 26;
const HEADER_BYTES = 1 << 20,
  LINE_BYTES = 8192;

const decoder = /* @__PURE__ */ new TextDecoder('latin1');
const invalid = (problem: string) =>
  new MargoError('failed', `Invalid HDR: ${problem}; the file is damaged or not Radiance RGBE, export it again`);

/**
 * Parses a Radiance `.hdr` file (`32-bit_rle_rgbe`) into linear floats, decoding flat, old-style run-length and
 * adaptive (planar) run-length scanlines. By default it returns RGBA and accepts the top-down and bottom-up row orders;
 * `options` select RGB output, every scan order and allocation bounds. Malformed data throws MargoError `'failed'`,
 * XYZE files and refused orders MargoError `'unsupported'`, exceeded bounds RangeError; nothing is allocated for the
 * image before its header passed every bound.
 */
export function parseHDR(source: ArrayBuffer | ArrayBufferView, options: HDRParseOptions = {}): HDRImage {
  const bytes = toBytes(source);
  const { channels = 4, orientation: order = 'standard', requireFormat = false, limits = {} } = options;
  if (channels !== 3 && channels !== 4) throw new RangeError('HDR channels must be 3 or 4');
  if (order !== 'standard' && order !== 'all') throw new TypeError("HDR orientation must be 'standard' or 'all'");
  const bound = (value: number | undefined, fallback: number, name: string, max = Infinity) => {
    if (value === undefined) return fallback;
    if (!(value >= 1 && value <= max) || (value !== Infinity && !Number.isInteger(value)))
      throw new RangeError(`HDR limit ${name} must be an integer from 1 to ${max}`);
    return value;
  };
  const maxBytes = bound(limits.maxBytes, Infinity, 'maxBytes'),
    maxWidth = bound(limits.maxWidth, Infinity, 'maxWidth'),
    maxHeight = bound(limits.maxHeight, Infinity, 'maxHeight'),
    maxPixels = bound(limits.maxPixels, MAX_PIXELS, 'maxPixels', MAX_PIXELS),
    maxHeader = bound(limits.maxHeaderBytes, HEADER_BYTES, 'maxHeaderBytes');
  if (bytes.length > maxBytes)
    throw new RangeError(`HDR file is ${bytes.length} bytes, over the ${maxBytes}-byte limit; use a smaller image`);
  let position = 0;
  const readLine = (): string => {
    const start = position,
      end = Math.min(bytes.length, start + LINE_BYTES + 1);
    while (position < end && bytes[position] !== 10) position++;
    if (position - start > LINE_BYTES) throw invalid(`header line at byte ${start} is longer than ${LINE_BYTES} bytes`);
    if (position >= bytes.length) throw invalid('header is not terminated');
    if (position + 1 > maxHeader)
      throw new RangeError(`HDR header exceeds the ${maxHeader}-byte limit; remove header comments or raise the limit`);
    return decoder.decode(bytes.subarray(start, position++)).replace(/\r$/, '');
  };
  const magic = readLine();
  if (!/^#\?(RADIANCE|RGBE)/.test(magic)) throw invalid('missing #?RADIANCE signature');
  let format = '',
    exposure = 1,
    gamma = 1;
  for (;;) {
    const line = readLine();
    if (line === '') break;
    if (line.startsWith('#')) continue;
    const match = /^([A-Za-z-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toUpperCase(),
      value = match[2].trim();
    if (key === 'FORMAT') format = value;
    else if (key === 'EXPOSURE') {
      const v = Number(value);
      if (Number.isFinite(v) && v > 0) exposure *= v;
    } else if (key === 'GAMMA') {
      const v = Number(value);
      if (Number.isFinite(v) && v > 0) gamma = v;
    }
  }
  if (format === '32-bit_rle_xyze')
    throw new MargoError(
      'unsupported',
      'HDR format 32-bit_rle_xyze (XYZE) is not supported; convert the image to RGBE (32-bit_rle_rgbe)',
    );
  if (format && format !== '32-bit_rle_rgbe')
    throw new MargoError('unsupported', `Unsupported HDR format "${format}"; only 32-bit_rle_rgbe decodes`);
  if (!format && requireFormat)
    throw new MargoError('unsupported', 'HDR file has no FORMAT line; add FORMAT=32-bit_rle_rgbe or export it again');
  const line = readLine(),
    // ASCII whitespace only (JavaScript \s also matches latin1 0x85 and 0xA0, which are damage, not spaces).
    resolution = /^([+-])([XY])[ \t\v\f\r]+(\d+)[ \t\v\f\r]+([+-])([XY])[ \t\v\f\r]+(\d+)[ \t\v\f\r]*$/.exec(line);
  if (!resolution || resolution[2] === resolution[5])
    throw invalid(`unsupported resolution line "${line.slice(0, 64)}" (expected "-Y h +X w")`);
  const [, majorSign, majorAxis, majorText, minorSign, , minorText] = resolution;
  if (order === 'standard') {
    if (majorAxis !== 'Y')
      throw invalid(
        `unsupported resolution line "${line.slice(0, 64)}" (expected "-Y h +X w"; pass orientation 'all')`,
      );
    if (minorSign !== '+')
      throw new MargoError(
        'unsupported',
        "Unsupported HDR orientation: mirrored X; pass orientation 'all' to decode it",
      );
  }
  const major = Number(majorText),
    minor = Number(minorText),
    width = majorAxis === 'X' ? major : minor,
    height = majorAxis === 'Y' ? major : minor,
    headerBytes = position;
  if (!(width > 0 && height > 0) || width * height > maxPixels)
    throw new RangeError(`Invalid HDR size ${width}x${height}; at most ${maxPixels} pixels decode`);
  if (width > maxWidth || height > maxHeight)
    throw new RangeError(
      `HDR image ${width}x${height} exceeds the ${maxWidth}x${maxHeight} limit; use a smaller image`,
    );

  // Every scanline takes at least 4 bytes: a header claiming more scanlines than the file can hold fails before the
  // image is allocated (up to 1 GiB).
  if (bytes.length - position < major * 4) throw new RangeError('Invalid HDR: truncated pixel data');
  const data = new Float32Array(width * height * channels),
    scanline = new Uint8Array(minor * 4),
    counts = { flat: 0, legacyRLE: 0, planarRLE: 0 };
  // Stored scanline m, element n lands at column x and row y, row 0 at the top: -Y and +X count forwards.
  const place = (axis: string, sign: string, value: number) =>
    axis === 'X' ? (sign === '+' ? value : width - 1 - value) : sign === '-' ? value : height - 1 - value;
  const columns = majorAxis === 'X',
    minorAxis = columns ? 'Y' : 'X';
  for (let m = 0; m < major; m++) {
    const kind = readScanline(bytes, position, scanline, minor, m);
    position = kind.position;
    counts[kind.kind]++;
    const fixed = place(majorAxis, majorSign, m);
    for (let n = 0; n < minor; n++) {
      const moving = place(minorAxis, minorSign, n),
        x = columns ? fixed : moving,
        y = columns ? moving : fixed,
        o = (y * width + x) * channels,
        e = scanline[n * 4 + 3];
      if (e === 0) data[o] = data[o + 1] = data[o + 2] = 0;
      else {
        const scale = 2 ** (e - 136);
        data[o] = scanline[n * 4] * scale;
        data[o + 1] = scanline[n * 4 + 1] * scale;
        data[o + 2] = scanline[n * 4 + 2] * scale;
      }
      if (channels === 4) data[o + 3] = 1;
    }
  }
  const diagnostics: HDRDiagnostics = {
    format,
    orientation: `${majorSign}${majorAxis} ${major} ${minorSign}${minorAxis} ${minor}`,
    scanAxis: columns ? 'Y' : 'X',
    scanlines: counts,
    headerBytes,
    trailingBytes: bytes.length - position,
  };
  return { width, height, data, exposure, gamma, channels, diagnostics };
}

// Decodes stored scanline `index` (`length` pixels) at `position` into `out` as RGBE bytes.
function readScanline(
  bytes: Uint8Array,
  position: number,
  out: Uint8Array,
  length: number,
  index: number,
): { position: number; kind: 'flat' | 'legacyRLE' | 'planarRLE' } {
  const where = () => `scanline ${index} (byte ${position})`;
  if (position + 4 > bytes.length) throw invalid(`truncated pixel data at ${where()}`);
  // Adaptive run-length scanline: 2, 2, length high byte, length low byte, then four planar channels.
  if (
    length >= 8 &&
    length < 0x8000 &&
    bytes[position] === 2 &&
    bytes[position + 1] === 2 &&
    !(bytes[position + 2] & 0x80)
  ) {
    if (((bytes[position + 2] << 8) | bytes[position + 3]) !== length)
      throw invalid(`scanline width mismatch at ${where()}`);
    position += 4;
    for (let channel = 0; channel < 4; channel++) {
      let x = 0;
      while (x < length) {
        if (position >= bytes.length) throw invalid(`truncated run-length data at ${where()}`);
        let count = bytes[position++];
        if (count > 128) {
          count -= 128;
          if (x + count > length || position >= bytes.length) throw invalid(`bad run at ${where()}`);
          const value = bytes[position++];
          for (let i = 0; i < count; i++) out[x++ * 4 + channel] = value;
        } else {
          if (count === 0 || x + count > length || position + count > bytes.length)
            throw invalid(`bad literal run at ${where()}`);
          for (let i = 0; i < count; i++) out[x++ * 4 + channel] = bytes[position++];
        }
      }
    }
    return { position, kind: 'planarRLE' };
  }
  // Flat RGBE pixels, possibly with old-style runs (1, 1, 1, count) repeating the previous pixel; consecutive runs
  // shift their count by 8 more bits each.
  let x = 0,
    shift = 0,
    runs = false;
  while (x < length) {
    if (position + 4 > bytes.length) throw invalid(`truncated pixel data at ${where()}`);
    const r = bytes[position],
      g = bytes[position + 1],
      b = bytes[position + 2],
      e = bytes[position + 3];
    position += 4;
    if (r === 1 && g === 1 && b === 1) {
      if (x === 0) throw invalid(`run with no previous pixel at ${where()}`);
      if (shift > 24) throw invalid(`run length overflow at ${where()}`);
      const count = e * 2 ** shift;
      if (x + count > length) throw invalid(`run exceeds scanline at ${where()}`);
      for (let i = 0; i < count; i++, x++) out.copyWithin(x * 4, (x - 1) * 4, x * 4);
      shift += 8;
      runs = true;
      continue;
    }
    out[x * 4] = r;
    out[x * 4 + 1] = g;
    out[x * 4 + 2] = b;
    out[x * 4 + 3] = e;
    x++;
    shift = 0;
  }
  return { position, kind: runs ? 'legacyRLE' : 'flat' };
}

export function toBytes(source: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  throw new TypeError('Expected an ArrayBuffer or typed array');
}
