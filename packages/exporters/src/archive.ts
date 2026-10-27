// Archives of captured frames: a bounded full-frame sprite atlas, a deterministic stored ZIP, and PNG-sequence and
// atlas ZIPs with a manifest the caller can extend. Every step can report progress and stop on an AbortSignal; a
// cancelled call throws the signal's reason and returns nothing partial. Re-exported by `@margoengine/exporters/capture`.
import { crc32 } from '../../shared/crc32.js';
import type { FrameSource, Pixels } from './capture.js';

// The PNG encoder loads on first use, as in model.js, so no module of this package imports it both ways.
const png: typeof import('./png.js').png = async (...args) => (await import('./png.js')).png(...args);

/** Progress and cancellation for the archive functions. */
export interface ArchiveProgress {
  /** Stops the work between frames or entries; the call then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Called after each frame or entry with the count done and the total. */
  onProgress?: (done: number, total: number) => void;
}

/** One file of a ZIP: a safe relative path (forward slashes) and its bytes; a string is written as UTF-8. */
export interface ZIPEntry {
  name: string;
  data: Uint8Array | Blob | string;
}

/** Options for {@link encodeZIP}. */
export interface ZIPOptions extends ArchiveProgress {
  /** Largest archive allowed, in bytes, checked before any entry is read. Default 256 MiB; at most 4 GiB - 1 (ZIP32). */
  maxBytes?: number;
}

const MAX_ZIP = 0xffffffff,
  DEFAULT_ZIP = 256 * 1024 * 1024,
  // 1980-01-01 00:00, the ZIP epoch: every archive of the same files is byte-identical.
  DOS_DATE = (0 << 9) | (1 << 5) | 1;

const size = (data: ZIPEntry['data'], text: Uint8Array | undefined): number =>
  text ? text.length : data instanceof Uint8Array ? data.length : (data as Blob).size;

/**
 * A ZIP archive of `entries`, stored without compression (PNG and GLB are compressed already), UTF-8 names, dated
 * 1980-01-01 so the same files always give the same bytes. The whole size is checked against `maxBytes` before any
 * entry is read.
 * @throws TypeError for an entry without a safe relative name (no `..`, `\`, `:`, leading `/`, control characters) or
 * with other data; RangeError for duplicate names, more than 65,535 entries or an archive over `maxBytes`.
 */
export async function encodeZIP(
  entries: readonly ZIPEntry[],
  { signal, onProgress, maxBytes = DEFAULT_ZIP }: ZIPOptions = {},
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 22 || maxBytes > MAX_ZIP)
    throw new RangeError(`ZIP maxBytes ${maxBytes} must be a whole number from 22 to ${MAX_ZIP}`);
  if (!Array.isArray(entries) || entries.length > 65535)
    throw new RangeError('ZIP takes an array of at most 65,535 entries');
  const encoder = new TextEncoder(),
    names = new Set<string>();
  let total = 22;
  const plan = entries.map((entry, i) => {
    const name = entry?.name;
    if (
      typeof name !== 'string' ||
      !name ||
      /[\\:\u0000-\u001f]/.test(name) ||
      name.startsWith('/') ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new TypeError(`ZIP entry ${i} needs a safe relative name like 'frames/0001.png'`);
    if (names.has(name)) throw new RangeError(`Duplicate ZIP entry name ${name}; give each file its own path`);
    names.add(name);
    const data = entry.data,
      text = typeof data === 'string' ? encoder.encode(data) : undefined;
    if (!text && !(data instanceof Uint8Array) && !(typeof Blob === 'function' && data instanceof Blob))
      throw new TypeError(`ZIP entry ${name} data must be a Uint8Array, Blob or string`);
    const bytes = encoder.encode(name);
    if (bytes.length > 65535)
      throw new RangeError(`ZIP entry name ${name} is longer than 65,535 bytes; shorten the entry name`);
    total += size(data, text) + 30 + bytes.length + 46 + bytes.length;
    if (total > maxBytes) throw new RangeError(`ZIP would exceed ${maxBytes} bytes; export fewer or smaller files`);
    return { name: bytes, data, text };
  });
  const out = new Uint8Array(total),
    view = new DataView(out.buffer),
    central: [Uint8Array, number, number, number][] = [];
  let at = 0;
  for (let i = 0; i < plan.length; i++) {
    signal?.throwIfAborted();
    const { name, data, text } = plan[i],
      bytes = text ?? (data instanceof Uint8Array ? data : new Uint8Array(await (data as Blob).arrayBuffer()));
    signal?.throwIfAborted();
    if (bytes.length !== size(data, text))
      throw new RangeError(
        'A ZIP entry changed size while being written; do not change the data while the archive is being written',
      );
    const crc = crc32(bytes);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 0x0800, true); // UTF-8 names
    view.setUint16(at + 12, DOS_DATE, true);
    view.setUint32(at + 14, crc, true);
    view.setUint32(at + 18, bytes.length, true);
    view.setUint32(at + 22, bytes.length, true);
    view.setUint16(at + 26, name.length, true);
    out.set(name, at + 30);
    out.set(bytes, at + 30 + name.length);
    central.push([name, crc, bytes.length, at]);
    at += 30 + name.length + bytes.length;
    onProgress?.(i + 1, plan.length);
  }
  const directory = at;
  for (const [name, crc, length, offset] of central) {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 14, DOS_DATE, true);
    view.setUint32(at + 16, crc, true);
    view.setUint32(at + 20, length, true);
    view.setUint32(at + 24, length, true);
    view.setUint16(at + 28, name.length, true);
    view.setUint32(at + 42, offset, true);
    out.set(name, at + 46);
    at += 46 + name.length;
  }
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, plan.length, true);
  view.setUint16(at + 10, plan.length, true);
  view.setUint32(at + 12, at - directory, true);
  view.setUint32(at + 16, directory, true);
  return out;
}

/** Grid of a sprite atlas: {@link spriteAtlasLayout}'s result. */
export interface AtlasLayout {
  columns: number;
  rows: number;
  /** Atlas size in pixels: `columns * frameWidth` by `rows * frameHeight`. */
  width: number;
  height: number;
}

const MAX_ATLAS_PIXELS = 8192 * 8192;

/**
 * The grid of `count` frames of `frameWidth` x `frameHeight` in `columns` columns (default the square-ish
 * `ceil(sqrt(count))`), checked before any frame is rendered.
 * @throws RangeError for sizes that are not whole numbers >= 1, columns outside 1..count, an atlas side over
 * `maxSize` (default 8192, at most 16384) or more than 8192 x 8192 pixels in all.
 */
export function spriteAtlasLayout(
  count: number,
  frameWidth: number,
  frameHeight: number,
  columns = Math.ceil(Math.sqrt(count)),
  maxSize = 8192,
): AtlasLayout {
  if (![count, frameWidth, frameHeight].every((v) => Number.isSafeInteger(v) && v >= 1))
    throw new RangeError('Atlas frame count and size must be whole numbers >= 1');
  if (!Number.isSafeInteger(columns) || columns < 1 || columns > count)
    throw new RangeError(`Atlas columns ${columns} must be a whole number from 1 to the frame count ${count}`);
  if (!Number.isSafeInteger(maxSize) || maxSize < 1 || maxSize > 16384)
    throw new RangeError('Atlas maxSize must be a whole number from 1 to 16384');
  const rows = Math.ceil(count / columns),
    width = columns * frameWidth,
    height = rows * frameHeight;
  if (width > maxSize || height > maxSize || width * height > MAX_ATLAS_PIXELS)
    throw new RangeError(
      `Atlas ${width}x${height} exceeds ${maxSize} per side or 8192 x 8192 pixels; use smaller frames, fewer frames or other columns`,
    );
  return { columns, rows, width, height };
}

/** One frame's rectangle in an atlas, top-left origin. */
export interface AtlasFrame {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A packed sprite atlas: its RGBA8 pixels, grid and frame rectangles. */
export interface SpriteAtlas extends AtlasLayout {
  pixels: Pixels;
  frameWidth: number;
  frameHeight: number;
  frames: AtlasFrame[];
}

/** Options for {@link packSpriteAtlas}. */
export interface SpriteAtlasOptions extends ArchiveProgress {
  /** Columns of the grid. Default `ceil(sqrt(count))`. */
  columns?: number;
  /** Largest atlas side in pixels. Default 8192, at most 16384. */
  maxSize?: number;
}

/**
 * Packs `count` frames into one atlas, frame `i` at column `i % columns`, row `floor(i / columns)`, each copied pixel
 * for pixel at its full size (no trimming, filtering or premultiplication). Every frame must have the first one's size.
 * Runs anywhere (no canvas). The grid is checked against the limits as soon as the first frame's size is known.
 * @throws RangeError for a frame of another size or an atlas over the limits ({@link spriteAtlasLayout}).
 */
export async function packSpriteAtlas(
  count: number,
  frame: FrameSource,
  { columns, maxSize, signal, onProgress }: SpriteAtlasOptions = {},
): Promise<SpriteAtlas> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError(`Atlas frame count ${count} must be >= 1`);
  if (typeof frame !== 'function') throw new TypeError('Atlas frame must be a function returning pixels');
  let atlas: SpriteAtlas | undefined;
  for (let index = 0; index < count; index++) {
    signal?.throwIfAborted();
    const pixels = checkPixels(await frame(index), index);
    signal?.throwIfAborted();
    if (!atlas) {
      const layout = spriteAtlasLayout(count, pixels.width, pixels.height, columns, maxSize);
      atlas = {
        ...layout,
        pixels: { data: new Uint8Array(layout.width * layout.height * 4), width: layout.width, height: layout.height },
        frameWidth: pixels.width,
        frameHeight: pixels.height,
        frames: [],
      };
    } else if (pixels.width !== atlas.frameWidth || pixels.height !== atlas.frameHeight)
      throw new RangeError(
        `Atlas frame ${index} is ${pixels.width}x${pixels.height}, not ${atlas.frameWidth}x${atlas.frameHeight}; capture every frame at one size`,
      );
    const x = (index % atlas.columns) * atlas.frameWidth,
      y = Math.floor(index / atlas.columns) * atlas.frameHeight,
      stride = atlas.frameWidth * 4,
      target = atlas.pixels.data as Uint8Array;
    for (let row = 0; row < atlas.frameHeight; row++)
      target.set(pixels.data.subarray(row * stride, (row + 1) * stride), ((y + row) * atlas.width + x) * 4);
    atlas.frames.push({ index, x, y, width: atlas.frameWidth, height: atlas.frameHeight });
    onProgress?.(index + 1, count);
  }
  return atlas!;
}

function checkPixels(pixels: Pixels, index: number): Pixels {
  const { data, width, height } = pixels ?? {};
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
    throw new TypeError(
      `Frame ${index} needs data as a Uint8Array or Uint8ClampedArray; pass an ImageData or a capture`,
    );
  if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1))
    throw new RangeError(`Frame ${index} size ${width}x${height} is invalid; pass whole numbers of pixels >= 1`);
  if (data.length !== width * height * 4)
    throw new RangeError(`Frame ${index} has ${data.length} bytes, not ${width * height * 4}; pass RGBA8 rows`);
  return pixels;
}

/** The manifest {@link encodeSequenceZIP} writes, before the caller's hook. */
export interface SequenceManifest {
  format: 'png-sequence';
  width: number;
  height: number;
  frames: { index: number; file: string }[];
}

/** The manifest {@link encodeAtlasZIP} writes, before the caller's hook. */
export interface AtlasManifest extends AtlasLayout {
  format: 'sprite-atlas';
  image: string;
  frameWidth: number;
  frameHeight: number;
  frames: AtlasFrame[];
}

/** Options shared by the sequence and atlas ZIPs. */
interface ArchiveZIPOptions<M> extends ArchiveProgress {
  /**
   * `manifest.json`: by default the base manifest; a function receives it and returns the JSON to write (add camera,
   * clip or naming fields); false leaves the file out.
   */
  manifest?: false | ((manifest: M) => unknown);
  /** Further files to add after the images and manifest (a README, an import script). */
  entries?: readonly ZIPEntry[];
  /** Largest archive in bytes. Default 256 MiB. */
  maxBytes?: number;
}

/** Options for {@link encodeSequenceZIP}. */
export interface SequenceZIPOptions extends ArchiveZIPOptions<SequenceManifest> {
  /** File name before the frame number. Default `'frame'`. */
  name?: string;
  /** Minimum digits of the frame number, zero-padded. Default the digits of `count - 1`. */
  pad?: number;
  /** Folder of the frames inside the ZIP. Default `'frames'`; `''` puts them at the top. */
  folder?: string;
}

function manifestEntry<M>(hook: ArchiveZIPOptions<M>['manifest'], base: M): ZIPEntry[] {
  if (hook === false) return [];
  if (hook !== undefined && typeof hook !== 'function') throw new TypeError('manifest must be false or a function');
  const value = hook ? hook(base) : base,
    text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new TypeError('The manifest hook must return a JSON value; return the manifest');
  return [{ name: 'manifest.json', data: text + '\n' }];
}

/**
 * A ZIP of `count` frames as numbered lossless PNGs (`frames/frame007.png`) and a `manifest.json`. Each frame is
 * rendered, encoded and counted against `maxBytes` in turn, so a too-long sequence stops early.
 * @throws RangeError for frames of different sizes or an archive over `maxBytes`.
 */
export async function encodeSequenceZIP(
  count: number,
  frame: FrameSource,
  {
    name = 'frame',
    pad,
    folder = 'frames',
    manifest,
    entries = [],
    maxBytes = DEFAULT_ZIP,
    signal,
    onProgress,
  }: SequenceZIPOptions = {},
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(count) || count < 1 || count > 65534)
    throw new RangeError(`Sequence frame count ${count} must be a whole number from 1 to 65,534`);
  if (typeof frame !== 'function') throw new TypeError('Sequence frame must be a function returning pixels');
  const digits = pad ?? String(count - 1).length;
  if (!Number.isSafeInteger(digits) || digits < 0 || digits > 16) throw new RangeError('Sequence pad must be 0 to 16');
  if (typeof folder !== 'string' || typeof name !== 'string') throw new TypeError('folder and name must be strings');
  const files: ZIPEntry[] = [],
    base: SequenceManifest = { format: 'png-sequence', width: 0, height: 0, frames: [] };
  let bytes = 0;
  for (let index = 0; index < count; index++) {
    signal?.throwIfAborted();
    const pixels = checkPixels(await frame(index), index);
    if (!index) [base.width, base.height] = [pixels.width, pixels.height];
    else if (pixels.width !== base.width || pixels.height !== base.height)
      throw new RangeError(
        `Sequence frame ${index} is ${pixels.width}x${pixels.height}, not ${base.width}x${base.height}; capture every frame at one size`,
      );
    const data = await png(pixels, Infinity, false),
      file = `${folder ? folder + '/' : ''}${name}${String(index).padStart(digits, '0')}.png`;
    signal?.throwIfAborted();
    bytes += data.length + 76 + 2 * file.length;
    if (bytes > maxBytes)
      throw new RangeError(`Sequence ZIP would exceed ${maxBytes} bytes; export fewer or smaller frames`);
    files.push({ name: file, data });
    base.frames.push({ index, file });
    onProgress?.(index + 1, count);
  }
  return encodeZIP([...files, ...manifestEntry(manifest, base), ...entries], { signal, maxBytes });
}

/** Options for {@link encodeAtlasZIP}. */
export interface AtlasZIPOptions extends ArchiveZIPOptions<AtlasManifest> {
  columns?: number;
  maxSize?: number;
  /** Atlas image file name. Default `'atlas.png'`. */
  image?: string;
}

/**
 * A ZIP of `count` frames packed into one lossless PNG atlas ({@link packSpriteAtlas}) and a `manifest.json` with
 * every frame's rectangle. Progress counts the frames, then the PNG encoding as one more step.
 */
export async function encodeAtlasZIP(
  count: number,
  frame: FrameSource,
  {
    columns,
    maxSize,
    image = 'atlas.png',
    manifest,
    entries = [],
    maxBytes = DEFAULT_ZIP,
    signal,
    onProgress,
  }: AtlasZIPOptions = {},
): Promise<Uint8Array> {
  const atlas = await packSpriteAtlas(count, frame, {
    columns,
    maxSize,
    signal,
    onProgress: onProgress && ((done) => onProgress(done, count + 1)),
  });
  const data = await png(atlas.pixels, Infinity, false);
  signal?.throwIfAborted();
  onProgress?.(count + 1, count + 1);
  const { columns: across, rows, width, height, frameWidth, frameHeight, frames } = atlas,
    base: AtlasManifest = {
      format: 'sprite-atlas',
      image,
      columns: across,
      rows,
      width,
      height,
      frameWidth,
      frameHeight,
      frames,
    };
  return encodeZIP([{ name: image, data }, ...manifestEntry(manifest, base), ...entries], { signal, maxBytes });
}
