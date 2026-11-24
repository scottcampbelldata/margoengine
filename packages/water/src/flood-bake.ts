// Flood bakes (FG-03): per-frame fields of a running Flood as EXR images, tiled atlases and 16-bit PNGs, for renderers
// and compositors outside the engine (Houdini, Blender, Nuke, Unreal take OpenEXR; a game engine a flipbook atlas).
// The fields are the solver's own cells, read back once a frame; nothing is resampled.
// Sources: OpenEXR file layout (Kainz, Bogart and Stanczyk, "Technical Introduction to OpenEXR", ILM 2004, via
// `@margoengine/environment/exr-write`); PNG (W3C Recommendation "Portable Network Graphics (PNG) Specification
// (Third Edition)", 2025, https://www.w3.org/TR/png-3/) with zlib data (RFC 1950) from the platform's
// CompressionStream('deflate'); the atlas is a plain row-major flipbook of frames.
import { crc32 } from '../../shared/crc32.js';
import type { Flood, FloodReading } from './flood.js';

/**
 * A field of a flood frame. 'surface' is depth + bed (the water's height, world y; the bed where dry); 'velocity' is two
 * channels, `velocity.x` and `velocity.z`; 'speed' is their length; 'wet' is 1 where deeper than 1 mm, else 0.
 */
export type FloodField = 'depth' | 'bed' | 'surface' | 'velocity' | 'speed' | 'foam' | 'breaker' | 'wet';
/** The fields a bake writes when none are given. */
export const FLOOD_BAKE_FIELDS: readonly FloodField[] = Object.freeze([
  'depth',
  'surface',
  'velocity',
  'foam',
  'breaker',
]);
const FIELDS = new Set<string>(['depth', 'bed', 'surface', 'velocity', 'speed', 'foam', 'breaker', 'wet']);
const WET = 1e-3;

/** Options for {@link bakeFlood}. */
export interface FloodBakeOptions {
  /** Flood time of the first frame, s. Default the flood's time now; never before it (a flood cannot seek back). */
  from?: number;
  /** Flood time of the last frame, s, inclusive; at least `from`. Required. */
  to: number;
  /** Frames a second, 1..1,000. Default 24. */
  fps?: number;
  /** Stops the bake between frames; the iterator throws the signal's reason. */
  signal?: AbortSignal;
}
/** One baked frame: its index from 0 and the flood's reading at that time. */
export interface FloodBakeFrame {
  index: number;
  /** Flood time of the frame, s: `from + index / fps`, on the flood's 1 / 120 s ticks. */
  time: number;
  reading: FloodReading;
}

/**
 * Runs the flood frame by frame and yields its reading at each frame time from `from` to `to` (inclusive) at `fps`.
 * It moves the flood's own clock (`advanceTime` then `settle`), so a render loop is not needed, and the frames equal a
 * live run's at the same times bit for bit. The flood must have started (one rendered frame with its Water).
 */
export async function* bakeFlood(flood: Flood, options: FloodBakeOptions): AsyncGenerator<FloodBakeFrame> {
  if (!options || typeof options !== 'object') throw new TypeError('bakeFlood needs options { to }');
  const { signal } = options,
    from = options.from ?? flood.time,
    fps = options.fps ?? 24,
    to = options.to;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 1 || fps > 1000)
    throw new RangeError(`bakeFlood fps is ${fps}; pass a number from 1 to 1,000`);
  if (typeof from !== 'number' || !Number.isFinite(from) || from < flood.time - 1e-9)
    throw new RangeError(`bakeFlood from is ${from}; pass a time at or after the flood's ${flood.time} s`);
  if (typeof to !== 'number' || !Number.isFinite(to) || to < from)
    throw new RangeError(`bakeFlood to is ${to}; pass a time at or after from (${from} s)`);
  const count = Math.floor((to - from) * fps + 1e-6) + 1;
  for (let index = 0; index < count; index++) {
    signal?.throwIfAborted();
    const time = from + index / fps,
      owed = time - flood.time;
    if (owed > 0) flood.advanceTime(owed);
    await flood.settle();
    signal?.throwIfAborted();
    yield { index, time, reading: await flood.read() };
  }
}

/** A field as named float planes, one per channel (velocity gives two). */
function planes(r: FloodReading, field: FloodField): { name: string; data: Float32Array }[] {
  const cells = r.width * r.height;
  const plane = (f: (k: number) => number) => {
    const out = new Float32Array(cells);
    for (let k = 0; k < cells; k++) out[k] = f(k);
    return out;
  };
  switch (field) {
    case 'depth':
      return [{ name: 'depth', data: r.depth }];
    case 'bed':
      return [{ name: 'bed', data: r.bed }];
    case 'surface':
      return [{ name: 'surface', data: plane((k) => r.depth[k] + r.bed[k]) }];
    case 'velocity':
      return [
        { name: 'velocity.x', data: plane((k) => r.velocity[2 * k]) },
        { name: 'velocity.z', data: plane((k) => r.velocity[2 * k + 1]) },
      ];
    case 'speed':
      return [{ name: 'speed', data: plane((k) => Math.hypot(r.velocity[2 * k], r.velocity[2 * k + 1])) }];
    case 'foam':
      return [{ name: 'foam', data: r.foam }];
    case 'breaker':
      return [{ name: 'breaker', data: r.breaker }];
    case 'wet':
      return [{ name: 'wet', data: plane((k) => (r.depth[k] > WET ? 1 : 0)) }];
  }
}
function checkFields(fields: readonly FloodField[] | undefined): readonly FloodField[] {
  const list = fields ?? FLOOD_BAKE_FIELDS;
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    list.some((f) => !FIELDS.has(f)) ||
    new Set(list).size !== list.length
  )
    throw new RangeError(`Flood bake fields must be distinct names from ${[...FIELDS].join(', ')}`);
  return list;
}
function checkReading(r: FloodReading): void {
  if (!r || !(r.depth instanceof Float32Array) || r.depth.length !== r.width * r.height)
    throw new TypeError('Flood bake needs a reading from flood.read()');
}

/** Options for {@link floodImage} and {@link encodeFloodEXR}. */
export interface FloodImageOptions {
  /** Fields to write. Default {@link FLOOD_BAKE_FIELDS}. */
  fields?: readonly FloodField[];
  /** 'FLOAT' (default) keeps the solver's float32 values; 'HALF' halves the file (about 3 significant digits). */
  type?: 'FLOAT' | 'HALF';
  /** true (default): image row 0 is the map's last row (largest z, north up in a top view); false: its first row. */
  northUp?: boolean;
}
/** An image of named float channels, `width` x `height` pixels, one per cell; the shape `encodeEXR` takes. */
export interface FloodImage {
  width: number;
  height: number;
  channels: { name: string; type: 'FLOAT' | 'HALF'; data: Float32Array }[];
}

/** One frame's fields as an image of named channels, one pixel a cell (no resampling). */
export function floodImage(reading: FloodReading, options: FloodImageOptions = {}): FloodImage {
  checkReading(reading);
  const fields = checkFields(options.fields),
    type = options.type ?? 'FLOAT';
  if (type !== 'FLOAT' && type !== 'HALF') throw new RangeError("Flood image type must be 'FLOAT' or 'HALF'");
  const { width, height } = reading,
    flip = options.northUp ?? true,
    channels = fields
      .flatMap((f) => planes(reading, f))
      .map(({ name, data }) => ({ name, type, data: flipRows(data, width, height, flip) }));
  return { width, height, channels };
}
function flipRows(data: Float32Array, width: number, height: number, flip: boolean): Float32Array {
  if (!flip) return data;
  const out = new Float32Array(data.length);
  for (let j = 0; j < height; j++) out.set(data.subarray(j * width, (j + 1) * width), (height - 1 - j) * width);
  return out;
}

/**
 * One frame's fields as an OpenEXR file (uncompressed scanlines, one channel per field plane, named as in
 * {@link FloodField}). Loads `@margoengine/environment/exr-write` on first use.
 */
export async function encodeFloodEXR(
  reading: FloodReading,
  options: FloodImageOptions & { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const image = floodImage(reading, options),
    { encodeEXR } = await import('@margoengine/environment/exr-write');
  return encodeEXR(image, { signal: options.signal });
}

/** Options for {@link floodAtlas}. */
export interface FloodAtlasOptions extends FloodImageOptions {
  /** Frames a row, 1..4,096. Default ceil(sqrt(frames)), so the atlas is about square. */
  columns?: number;
}
/** Frames tiled row-major into one image: frame i at column i % columns, row floor(i / columns), from the top left. */
export interface FloodAtlas extends FloodImage {
  columns: number;
  rows: number;
  /** One frame's size in pixels (the map's cells). */
  frameWidth: number;
  frameHeight: number;
  /** Flood time of each tile, s. */
  times: number[];
}

/**
 * Tiles frames of one flood into an atlas (a flipbook): the same fields, each frame a `width` x `height` tile, empty
 * tiles 0. Give it to `encodeEXR` from `@margoengine/environment/exr-write`, or one channel to {@link encodeFloodPNG}.
 */
export function floodAtlas(
  frames: readonly (FloodBakeFrame | FloodReading)[],
  options: FloodAtlasOptions = {},
): FloodAtlas {
  if (!Array.isArray(frames) || frames.length === 0) throw new RangeError('Flood atlas needs at least one frame');
  const readings = frames.map((f) => ('reading' in f ? f.reading : f)),
    first = readings[0];
  checkReading(first);
  for (const r of readings) {
    checkReading(r);
    if (r.width !== first.width || r.height !== first.height)
      throw new RangeError('Flood atlas frames must all be the same map size');
  }
  const columns = options.columns ?? Math.ceil(Math.sqrt(readings.length));
  if (!Number.isInteger(columns) || columns < 1 || columns > 4096)
    throw new RangeError(`Flood atlas columns is ${columns}; pass a whole number from 1 to 4,096`);
  const rows = Math.ceil(readings.length / columns),
    fw = first.width,
    fh = first.height,
    width = fw * columns,
    height = fh * rows;
  if (width > 16384 || height > 16384 || width * height > 2 ** 26)
    throw new RangeError(
      `Flood atlas would be ${width} x ${height}; at most 16,384 a side and 2^26 pixels (fewer frames or columns)`,
    );
  const images = readings.map((r) => floodImage(r, options)),
    channels = images[0].channels.map((c, ci) => {
      const data = new Float32Array(width * height);
      images.forEach((image, i) => {
        const src = image.channels[ci].data,
          x0 = (i % columns) * fw,
          y0 = Math.floor(i / columns) * fh;
        for (let j = 0; j < fh; j++) data.set(src.subarray(j * fw, (j + 1) * fw), (y0 + j) * width + x0);
      });
      return { name: c.name, type: c.type, data };
    });
  const times = frames.map((f) => f.time);
  return { width, height, channels, columns, rows, frameWidth: fw, frameHeight: fh, times };
}

/** Options for {@link encodeFloodPNG}. */
export interface FloodPNGOptions {
  /** The channel to write, e.g. 'depth' or 'velocity.x'. Default the image's first. */
  channel?: string;
  /** Values mapped to 0 and 65,535, clamped outside. Default the channel's own least and greatest value. */
  range?: readonly [number, number];
}

/**
 * One channel of a {@link floodImage} or {@link floodAtlas} as a 16-bit greyscale PNG: value v is stored as
 * round(65535 (v - lo) / (hi - lo)), so a reader gets it back as lo + (hi - lo) p / 65535 (state `range` beside it).
 */
export async function encodeFloodPNG(image: FloodImage, options: FloodPNGOptions = {}): Promise<Uint8Array> {
  if (!image || !Array.isArray(image.channels)) throw new TypeError('encodeFloodPNG needs a floodImage or floodAtlas');
  const channel = options.channel ? image.channels.find((c) => c.name === options.channel) : image.channels[0];
  if (!channel)
    throw new RangeError(
      `encodeFloodPNG: no channel '${options.channel}' in the image; pass one of ${image.channels.map((c) => c.name).join(', ')}`,
    );
  const { width, height } = image,
    data = channel.data;
  let [lo, hi] = options.range ?? [Infinity, -Infinity];
  if (!options.range) for (const v of data) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo)
    throw new RangeError(`encodeFloodPNG range [${lo}, ${hi}] must be two finite numbers, low first`);
  const scale = hi > lo ? 65535 / (hi - lo) : 0,
    raw = new Uint8Array(height * (1 + width * 2));
  for (let j = 0; j < height; j++) {
    const row = j * (1 + width * 2);
    for (let i = 0; i < width; i++) {
      const p = Math.round(Math.min(Math.max((data[j * width + i] - lo) * scale, 0), 65535));
      raw[row + 1 + i * 2] = p >> 8;
      raw[row + 2 + i * 2] = p & 255;
    }
  }
  const zlib = new Uint8Array(
      await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer(),
    ),
    header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([16, 0, 0, 0, 0], 8); // 16 bits, greyscale, deflate, adaptive filters (all None), no interlace
  const parts = [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', zlib),
      chunk('IEND', new Uint8Array(0)),
    ],
    out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length),
    view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
