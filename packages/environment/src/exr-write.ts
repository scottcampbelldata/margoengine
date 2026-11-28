// OpenEXR writer: single-part, increasing-Y scanline files with any named channels, uncompressed (NONE) or
// compressed with ZIPS (one line a chunk) or ZIP (16 lines a chunk).
// Format: OpenEXR File Layout, https://openexr.com/en/latest/OpenEXRFileLayout.html, and Technical Introduction,
// "Data Compression", https://openexr.com/en/latest/TechnicalIntroduction.html (Kainz, Bogart and Hess, Industrial
// Light & Magic); zlib streams are RFC 1950 (Deutsch and Gailly, 1996, https://www.rfc-editor.org/rfc/rfc1950).
import { floatToHalf } from './half.js';
import { EXR_MAGIC, LINES_PER_BLOCK, TYPE_NAMES, TYPE_SIZE, type EXRChannel } from './exr.js';
import { MargoError } from '@margoengine/math/errors';

/** One channel to write: every pixel of the image, row 0 at the top. */
export interface EXRWriteChannel {
  /** Channel name as stored, e.g. 'R' or 'diffuse.R'; 1 to 31 printable ASCII characters, unique in the image. */
  name: string;
  /** Sample type in the file. HALF rounds to nearest even; FLOAT and UINT keep the exact 32-bit words. */
  type: EXRChannel['type'];
  /** Samples: a Float32Array for HALF and FLOAT, a Uint32Array for UINT. Read, never changed. */
  data: Float32Array | Uint32Array;
  /** Index of the first sample in `data`. Default 0. */
  offset?: number;
  /** Elements between samples, e.g. 4 for one lane of interleaved RGBA. Default 1. */
  stride?: number;
}

/** An image for {@link encodeEXR}. */
export interface EXRWriteImage {
  /** Width in pixels, 1 to 16384; width times height is at most 2^26. */
  width: number;
  /** Height in pixels, 1 to 16384. */
  height: number;
  /** 1 to 64 channels, written in name order as OpenEXR requires. */
  channels: readonly EXRWriteChannel[];
  /**
   * Optional `colorInteropID` header string (1 to 255 printable ASCII characters), stored as given. Name the space of
   * the data, such as `lin_ap1_scene`: the readers convert a known one and prefer it to `chromaticities`.
   */
  colorInteropID?: string;
  /**
   * Optional `chromaticities` header attribute: red, green, blue and white CIE xy, eight finite numbers, stored as
   * float32. Leave it out for linear sRGB / Rec.709 data (the OpenEXR default); `parseEXR` converts other primaries
   * when `colorInteropID` names no known space.
   */
  chromaticities?: readonly number[];
}

/** Options for {@link encodeEXR}. */
export interface EXRWriteOptions {
  /**
   * Lossless chunk compression: 'NONE' (default), 'ZIPS' (zlib, one line a chunk) or 'ZIP' (zlib, 16 lines a chunk,
   * usually the smallest). ZIPS and ZIP need `CompressionStream`. A chunk that does not shrink is stored raw.
   */
  compression?: 'NONE' | 'ZIPS' | 'ZIP';
  /** 'reject' (default) throws on NaN or infinity in HALF and FLOAT channels; 'preserve' writes them. */
  nonFinite?: 'reject' | 'preserve';
  /** Largest file to produce, in bytes, at most 2^29. Default 2^28. */
  maxBytes?: number;
  /** Aborts the encode; checked between rows. */
  signal?: AbortSignal;
  /** Called between rows with samples written so far and the total. */
  onProgress?: (done: number, total: number) => void;
}

/** Milliseconds of encoding between yields to the event loop (well under the 50 ms of a long task). */
const YIELD_MS = 10;
const now = () => performance.now();
// One turn of the event loop. A browser clamps nested setTimeout(0) to 4 ms, so a yield per few rows cost more than
// the encoding (128 yields, about 0.5 s for 2048 x 1024 RGBA); `scheduler.yield()` has no clamp where it exists.
const yieldTurn = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve));
};
const printable = (s: unknown, max: number): s is string =>
  typeof s === 'string' && s.length >= 1 && s.length <= max && /^[\x20-\x7e]+$/.test(s);
const chars = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
// Little-endian bytes of 32-bit integers.
const i32 = (...values: number[]) =>
  values.flatMap((v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
const ONE = 0x3f800000; // 1.0 as float32 bits
// The compression attribute's byte, by name.
const CODES = { NONE: 0, ZIPS: 2, ZIP: 3 } as const;
// What ZIP and ZIPS apply before deflate: the even-indexed bytes, then the odd-indexed ones, each byte after the first
// stored as its difference from the one before, biased by 128.
const predict = (raw: Uint8Array): Uint8Array<ArrayBuffer> => {
  const n = raw.length,
    out = new Uint8Array(n),
    half = (n + 1) >> 1;
  for (let i = 0; i < n; i++) out[(i >> 1) + (i & 1) * half] = raw[i];
  for (let i = n - 1; i > 0; i--) out[i] = out[i] - out[i - 1] + 128;
  return out;
};
const deflate = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer(),
  );
const whole = (value: number, min: number, max: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`EXR ${label} is ${value}; pass a whole number from ${min} to ${max}`);
};

/**
 * Encodes named channels as a scanline OpenEXR file (uncompressed, ZIPS or ZIP) that {@link parseEXR} and OpenEXR read.
 * Data and display windows are `[0, 0, width - 1, height - 1]`. Yields to the event loop (`scheduler.yield()` where
 * the runtime has it, else `setTimeout`) after about 10 ms of encoding and after the last row.
 * ZIPS and ZIP files are bounded by `maxBytes` too, checked as chunks are written.
 * @throws TypeError for a bad name, type or array; RangeError for a size or offset out of range, a file over
 * `maxBytes`, a nonfinite sample under `nonFinite: 'reject'` or a finite value too large for HALF; the signal's reason
 * when aborted; MargoError `'unsupported'` for ZIPS or ZIP without `CompressionStream`.
 */
export async function encodeEXR(image: EXRWriteImage, options: EXRWriteOptions = {}): Promise<Uint8Array> {
  const { width, height, channels, colorInteropID, chromaticities } = image,
    { compression = 'NONE', nonFinite = 'reject', maxBytes = 1 << 28, signal, onProgress } = options;
  signal?.throwIfAborted();
  whole(width, 1, 16384, 'width');
  whole(height, 1, 16384, 'height');
  whole(width * height, 1, 1 << 26, 'pixel count');
  whole(channels.length, 1, 64, 'channel count');
  whole(maxBytes, 1, 1 << 29, 'maxBytes');
  if (nonFinite !== 'reject' && nonFinite !== 'preserve')
    throw new TypeError("EXR nonFinite: pass 'reject' or 'preserve'");
  if (!Object.hasOwn(CODES, compression)) throw new TypeError("EXR compression: pass 'NONE', 'ZIPS' or 'ZIP'");
  if (compression !== 'NONE' && typeof CompressionStream !== 'function')
    throw new MargoError(
      'unsupported',
      `EXR ${compression} needs CompressionStream; pass compression: 'NONE' or use a current browser or Node 18+`,
    );
  if (
    chromaticities !== undefined &&
    !(
      Array.isArray(chromaticities) &&
      chromaticities.length === 8 &&
      chromaticities.every((v) => Number.isFinite(v) && Number.isFinite(Math.fround(v)))
    )
  )
    throw new TypeError('EXR chromaticities: pass eight finite numbers (red, green, blue and white CIE x and y)');
  if (colorInteropID !== undefined && !printable(colorInteropID, 255))
    throw new TypeError('EXR colorInteropID: pass 1 to 255 printable ASCII characters');
  const planes = [...channels].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let pixelBytes = 0;
  planes.forEach(({ name, type, data, offset = 0, stride = 1 }, i) => {
    const uint = type === 'UINT';
    if (!printable(name, 31)) throw new TypeError(`EXR channel name ${name}: pass 1 to 31 printable ASCII characters`);
    if (i && planes[i - 1].name === name)
      throw new TypeError(`EXR channel ${name} appears twice; names must be unique`);
    if (!TYPE_NAMES.includes(type)) throw new TypeError(`EXR channel ${name} type ${type}: pass HALF, FLOAT or UINT`);
    if (!(uint ? data instanceof Uint32Array : data instanceof Float32Array))
      throw new TypeError(`EXR channel ${name}: pass a ${uint ? 'Uint32Array' : 'Float32Array'} for ${type}`);
    whole(offset, 0, Number.MAX_SAFE_INTEGER, `channel ${name} offset`);
    whole(stride, 1, Number.MAX_SAFE_INTEGER, `channel ${name} stride`);
    whole(offset + (width * height - 1) * stride, 0, data.length - 1, `channel ${name} last sample index`);
    pixelBytes += TYPE_SIZE[TYPE_NAMES.indexOf(type)];
  });
  // Header: magic, version 2 (scanline, short names), then attributes as name\0 type\0 size value, then 0.
  const head = i32(EXR_MAGIC, 2),
    attribute = (name: string, type: string, value: number[]) =>
      head.push(...chars(name), 0, ...chars(type), 0, ...i32(value.length), ...value),
    window = i32(0, 0, width - 1, height - 1);
  attribute('channels', 'chlist', [
    ...planes.flatMap((c) => [...chars(c.name), 0, ...i32(TYPE_NAMES.indexOf(c.type), 0, 1, 1)]),
    0,
  ]);
  if (chromaticities !== undefined)
    attribute('chromaticities', 'chromaticities', Array.from(new Uint8Array(Float32Array.from(chromaticities).buffer)));
  if (colorInteropID !== undefined) attribute('colorInteropID', 'string', chars(colorInteropID));
  attribute('compression', 'compression', [CODES[compression]]);
  attribute('dataWindow', 'box2i', window);
  attribute('displayWindow', 'box2i', window);
  attribute('lineOrder', 'lineOrder', [0]); // increasing Y
  attribute('pixelAspectRatio', 'float', i32(ONE));
  attribute('screenWindowCenter', 'v2f', i32(0, 0));
  attribute('screenWindowWidth', 'float', i32(ONE));
  head.push(0);
  const lineBytes = width * pixelBytes,
    blockLines = LINES_PER_BLOCK[compression],
    blocks = Math.ceil(height / blockLines),
    stored = compression === 'NONE',
    first = head.length + 8 * blocks; // past the offset table: one 64-bit file offset per chunk
  const within = (total: number) => {
    if (total > maxBytes)
      throw new RangeError(`EXR file needs ${total} bytes, over maxBytes ${maxBytes}; raise maxBytes`);
  };
  // An uncompressed file's size is known now; a compressed one's is checked chunk by chunk.
  const total = stored ? first + height * (8 + lineBytes) : first;
  within(total);
  // NONE writes every row straight into the file; ZIPS and ZIP fill a chunk buffer and keep the compressed chunks.
  const out = new Uint8Array(total),
    buffer = stored ? out : new Uint8Array(Math.min(blockLines, height) * lineBytes),
    view = new DataView(buffer.buffer),
    chunks: Uint8Array[] = [];
  out.set(head);
  let at = first,
    size = first;
  const words = planes.map((c) => new Uint32Array(c.data.buffer, c.data.byteOffset, c.data.length)),
    samples = width * height * planes.length;
  for (let y = 0, last = now(); y < height; y++) {
    if (stored) {
      view.setBigUint64(head.length + 8 * y, BigInt(at), true);
      view.setInt32(at, y, true);
      view.setInt32(at + 4, lineBytes, true);
      at += 8;
    } else at = (y % blockLines) * lineBytes;
    planes.forEach(({ name, type, data, offset = 0, stride = 1 }, p) => {
      for (let x = 0, i = offset + y * width * stride; x < width; x++, i += stride) {
        const word = words[p][i],
          finite = type === 'UINT' || (word & 0x7f800000) !== 0x7f800000;
        if (!finite && nonFinite === 'reject')
          throw new RangeError(
            `EXR channel ${name} pixel ${x},${y} is not finite; pass nonFinite: 'preserve' to keep it`,
          );
        if (type !== 'HALF') view.setUint32((at += 4) - 4, word, true);
        else {
          const half = !finite && word & 0x7fffff ? 0x7e00 : floatToHalf(data[i]); // NaN: one quiet NaN
          if (finite && (half & 0x7c00) === 0x7c00)
            throw new RangeError(
              `EXR channel ${name} pixel ${x},${y} is ${data[i]}, over the HALF maximum 65504; use FLOAT`,
            );
          view.setUint16((at += 2) - 2, half, true);
        }
      }
    });
    if (!stored && (y === height - 1 || (y + 1) % blockLines === 0)) {
      const raw = buffer.subarray(0, at),
        packed = await deflate(predict(raw)),
        // A reader takes a chunk of exactly the uncompressed size as raw lines.
        body = packed.length < raw.length ? packed : raw,
        chunk = new Uint8Array(8 + body.length),
        header = new DataView(chunk.buffer);
      signal?.throwIfAborted();
      header.setInt32(0, y - (y % blockLines), true);
      header.setInt32(4, body.length, true);
      chunk.set(body, 8);
      chunks.push(chunk);
      within((size += chunk.length));
    }
    if (y === height - 1 || now() - last >= YIELD_MS) {
      onProgress?.((y + 1) * width * planes.length, samples);
      await yieldTurn();
      signal?.throwIfAborted();
      last = now();
    }
  }
  if (stored) return out;
  const file = new Uint8Array(size),
    offsets = new DataView(file.buffer);
  file.set(out);
  chunks.reduce((position, chunk, block) => {
    offsets.setBigUint64(head.length + 8 * block, BigInt(position), true);
    file.set(chunk, position);
    return position + chunk.length;
  }, first);
  return file;
}
