// Files in and out of a biome world: heightmaps (16-bit PNG, RAW16, float32), per-biome weight maps and masks as PNG,
// layer dumps as JSON or CSV, and `saveWorld` and `loadWorld`, which save a world's options and edits and make it again.
// An entry of its own: the root entry does not import it. The PNG writer is ours (stored or CompressionStream deflate,
// CRC-32 and Adler-32 written out below); nothing here reads a file format library or sends bytes anywhere.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { divFloor } from './fixed.js';
import { LAYERS } from './layers.js';
import type { RasterLayer } from './layers.js';
import { BiomeWorld } from '@margoengine/biomes';
import type { BiomeWorldOptions, LayerWrite } from './world.js';

/** A rectangle of tiles `[x0, z0, x1, z1]` (inclusive tile indices); the default is the whole world. */
type TileRect = readonly [number, number, number, number];

/** Options every export takes. */
export interface ExportOptions {
  /** Tiles to export, inclusive tile indices `[x0, z0, x1, z1]`. Default: the whole world. */
  readonly tiles?: TileRect;
  /** Deflate PNG rows with `CompressionStream` (smaller files, same pixels). Default false: stored blocks. */
  readonly compress?: boolean;
  readonly signal?: AbortSignal;
}

/** A heightmap export. */
export interface HeightExport {
  readonly format: 'png16' | 'raw16' | 'f32';
  /** File bytes: a PNG, or little-endian 16-bit or float32 samples, rows of increasing z. */
  readonly data: Uint8Array;
  readonly width: number;
  readonly depth: number;
  /** Cell size in metres. */
  readonly resolution: number;
  /** Lowest and highest height in metres. 16-bit files map `min..max` onto `0..65535`; `f32` holds metres. */
  readonly min: number;
  readonly max: number;
}

/** Biome weights of a world as one plane per biome. */
export interface WeightExport {
  readonly width: number;
  readonly depth: number;
  /** Biome ids, in the world's biome order; `planes[i]` belongs to `biomes[i]`. */
  readonly biomes: readonly string[];
  /** Weight of each biome per cell, 0..255 (the four blend slots of a cell added up). */
  readonly planes: readonly Uint8Array[];
  /** RGBA PNGs of four biomes each (channel k = `biomes[k]` of the group), the splat map layout of terrain tools. */
  readonly splats: readonly { readonly biomes: readonly string[]; readonly png: Uint8Array }[];
}

const textEncoder = new TextEncoder();

let crcTable: Uint32Array | undefined;
function crc32(parts: readonly Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const part of parts) for (let i = 0; i < part.length; i++) c = crcTable[(c ^ part[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  let a = 1,
    b = 0;
  for (let i = 0; i < data.length; ) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A zlib stream of stored (uncompressed) deflate blocks. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535)), // float division: a count
    out = new Uint8Array(2 + data.length + blocks * 5 + 4),
    view = new DataView(out.buffer);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let i = 0; i < blocks; i++) {
    const part = data.subarray(i * 65535, (i + 1) * 65535);
    out[at] = i === blocks - 1 ? 1 : 0;
    view.setUint16(at + 1, part.length, true);
    view.setUint16(at + 3, part.length ^ 0xffff, true);
    out.set(part, at + 5);
    at += 5 + part.length;
  }
  view.setUint32(at, adler32(data));
  return out;
}

async function zlibDeflate(data: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'function')
    throw fault('unsupported', 'PNG compress needs CompressionStream; leave compress off for stored blocks', 'biomes');
  signal?.throwIfAborted();
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Encodes a PNG. `rows` holds `depth` rows of `width * channels * bitDepth / 8` bytes (16-bit samples big-endian), no
 * filter bytes; `channels` is 1 (gray) or 4 (RGBA).
 */
export async function encodePng(
  width: number,
  depth: number,
  channels: 1 | 4,
  bitDepth: 8 | 16,
  rows: Uint8Array,
  options: { readonly compress?: boolean; readonly signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  if (!Number.isInteger(width) || !Number.isInteger(depth) || width < 1 || depth < 1)
    throw rangeError('encodePng needs a positive integer width and depth', 'biomes');
  const stride = (width * channels * bitDepth) >> 3,
    raw = new Uint8Array((stride + 1) * depth);
  if (rows.length !== stride * depth) throw rangeError('encodePng rows are the wrong length for width, depth and depth bits', 'biomes');
  for (let j = 0; j < depth; j++) raw.set(rows.subarray(j * stride, (j + 1) * stride), j * (stride + 1) + 1);
  const idat = options.compress ? await zlibDeflate(raw, options.signal) : zlibStored(raw),
    header = new Uint8Array(13),
    hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, depth);
  header[8] = bitDepth;
  header[9] = channels === 1 ? 0 : 6;
  const chunks: [string, Uint8Array][] = [
    ['IHDR', header],
    ['IDAT', idat],
    ['IEND', new Uint8Array(0)],
  ];
  const out = new Uint8Array(8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0));
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(out.buffer);
  let at = 8;
  for (const [type, data] of chunks) {
    const tag = textEncoder.encode(type);
    view.setUint32(at, data.length);
    out.set(tag, at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32([tag, data]));
    at += 12 + data.length;
  }
  return out;
}

/** One layer of the chosen tiles stitched into one raster (cropped to the world), `channels` values per cell. */
async function stitch(
  world: BiomeWorld,
  name: string,
  options: ExportOptions,
): Promise<{ layer: RasterLayer; width: number; depth: number; channels: number }> {
  if (typeof name !== 'string' || !(name in LAYERS)) throw rangeError('Unknown biome layer name; use names from LAYERS', 'biomes');
  const rect = options.tiles ?? [0, 0, world.tilesX - 1, world.tilesZ - 1];
  if (
    !Array.isArray(rect) ||
    rect.length !== 4 ||
    !rect.every(Number.isInteger) ||
    rect[0] < 0 ||
    rect[1] < 0 ||
    rect[2] >= world.tilesX ||
    rect[3] >= world.tilesZ ||
    rect[0] > rect[2] ||
    rect[1] > rect[3]
  )
    throw rangeError('Export tiles is [x0, z0, x1, z1], inclusive tile indices inside the world', 'biomes');
  const cells = divFloor(world.tileSize * 1000, world.resolution * 1000),
    worldCells = [
      divFloor((world.bounds[2] - world.bounds[0]) * 1000, world.resolution * 1000),
      divFloor((world.bounds[3] - world.bounds[1]) * 1000, world.resolution * 1000),
    ],
    x0 = rect[0] * cells,
    z0 = rect[1] * cells,
    width = Math.min((rect[2] + 1) * cells, worldCells[0]) - x0,
    depth = Math.min((rect[3] + 1) * cells, worldCells[1]) - z0,
    format = LAYERS[name].format,
    channels = format === 'rgba8' ? 4 : 1,
    Type = (
      { i32: Int32Array, i16: Int16Array, u16: Uint16Array, u8: Uint8Array, rgba8: Uint8Array } as const
    )[format],
    data = new Type(width * depth * channels);
  for (let tz = rect[1]; tz <= rect[3]; tz++)
    for (let tx = rect[0]; tx <= rect[2]; tx++) {
      options.signal?.throwIfAborted();
      const tile = await world.tile(tx, tz, { layers: [name], signal: options.signal }),
        source = tile.layer(name)!,
        cx = tx * cells - x0,
        cz = tz * cells - z0,
        span = Math.min(cells, width - cx) * channels;
      for (let j = 0; j < cells && cz + j < depth; j++)
        data.set(source.data.subarray(j * cells * channels, j * cells * channels + span), ((cz + j) * width + cx) * channels);
    }
  const info = LAYERS[name];
  return { layer: { name, format, width, depth, data, scale: info.scale, unit: info.unit }, width, depth, channels };
}

/**
 * Exports the height of a world (or of some tiles of it) as a heightmap file.
 * `png16` is a 16-bit grayscale PNG and `raw16` the same samples as little-endian bytes (the RAW layout terrain tools
 * import), both mapping the lowest height to 0 and the highest to 65,535 with integer maths; the result's `min` and
 * `max` give the metres back. `f32` is little-endian float32 metres, no scaling.
 * @example
 * const { data, min, max } = await exportHeight(world, 'png16'); // write `data` to height.png
 */
export async function exportHeight(
  world: BiomeWorld,
  format: 'png16' | 'raw16' | 'f32' = 'png16',
  options: ExportOptions = {},
): Promise<HeightExport> {
  if (format !== 'png16' && format !== 'raw16' && format !== 'f32')
    throw rangeError("exportHeight format is 'png16', 'raw16' or 'f32'", 'biomes');
  const { layer, width, depth } = await stitch(world, 'height', options),
    mm = layer.data as Int32Array;
  let lo = mm[0],
    hi = mm[0];
  for (let i = 1; i < mm.length; i++) {
    if (mm[i] < lo) lo = mm[i];
    if (mm[i] > hi) hi = mm[i];
  }
  const out = new Uint8Array(width * depth * (format === 'f32' ? 4 : 2)),
    view = new DataView(out.buffer),
    range = hi - lo;
  if (format === 'f32') for (let i = 0; i < mm.length; i++) view.setFloat32(i * 4, mm[i] / 1000, true); // float division: millimetres to metres
  else {
    const big = format === 'png16';
    for (let i = 0; i < mm.length; i++) view.setUint16(i * 2, range ? divFloor((mm[i] - lo) * 65535, range) : 0, !big);
  }
  return {
    format,
    data: format === 'png16' ? await encodePng(width, depth, 1, 16, out, options) : out,
    width,
    depth,
    resolution: world.resolution,
    min: lo / 1000, // float division: millimetres to metres
    max: hi / 1000, // float division
  };
}

async function weightPlanes(
  world: BiomeWorld,
  options: ExportOptions,
): Promise<{ width: number; depth: number; names: string[]; planes: Uint8Array[] }> {
  const ids = (await stitch(world, 'biome', options)).layer.data as Uint8Array,
    { layer, width, depth } = await stitch(world, 'biomeWeight', options),
    weights = layer.data as Uint8Array,
    names = world.biomes.map((b) => b.id),
    planes = names.map(() => new Uint8Array(width * depth));
  for (let cell = 0; cell < width * depth; cell++)
    for (let s = 0; s < 4; s++) {
      const w = weights[cell * 4 + s];
      if (w) {
        const plane = planes[ids[cell * 4 + s]];
        plane[cell] = Math.min(255, plane[cell] + w);
      }
    }
  return { width, depth, names, planes };
}

/** Weight of every biome in every cell as planes 0..255, plus RGBA splat PNGs of four biomes each. */
export async function exportWeights(world: BiomeWorld, options: ExportOptions = {}): Promise<WeightExport> {
  const { width, depth, names, planes } = await weightPlanes(world, options),
    splats: { biomes: string[]; png: Uint8Array }[] = [];
  for (let first = 0; first < names.length; first += 4) {
    const rows = new Uint8Array(width * depth * 4);
    for (let k = 0; k < 4 && first + k < names.length; k++)
      for (let cell = 0; cell < width * depth; cell++) rows[cell * 4 + k] = planes[first + k][cell];
    // Channels without a biome stay 0.
    splats.push({ biomes: names.slice(first, first + 4), png: await encodePng(width, depth, 4, 8, rows, options) });
  }
  return { width, depth, biomes: names, planes, splats };
}

/** One 8-bit grayscale PNG per biome (white = full weight), keyed by biome id; the masks terrain tools import. */
export async function exportMasks(world: BiomeWorld, options: ExportOptions = {}): Promise<Map<string, Uint8Array>> {
  const { width, depth, names, planes } = await weightPlanes(world, options),
    out = new Map<string, Uint8Array>();
  for (let i = 0; i < names.length; i++) out.set(names[i], await encodePng(width, depth, 1, 8, planes[i], options));
  return out;
}

/**
 * Dumps one layer as JSON (`{ name, format, unit, scale, width, depth, channels, data }` with the stored integers, so
 * `value * scale` is in `unit`) or CSV (one row per z, `width * channels` stored integers per row).
 */
export async function exportLayer(
  world: BiomeWorld,
  name: string,
  format: 'json' | 'csv' = 'json',
  options: ExportOptions = {},
): Promise<string> {
  if (format !== 'json' && format !== 'csv') throw rangeError("exportLayer format is 'json' or 'csv'", 'biomes');
  const { layer, width, depth, channels } = await stitch(world, name, options);
  if (format === 'json')
    return JSON.stringify({
      name,
      format: layer.format,
      unit: layer.unit,
      scale: layer.scale,
      width,
      depth,
      channels,
      data: Array.from(layer.data),
    });
  const rows: string[] = [],
    stride = width * channels;
  for (let j = 0; j < depth; j++) rows.push(layer.data.subarray(j * stride, (j + 1) * stride).join(','));
  return rows.join('\n') + '\n';
}

const unbase64 = (text: string): Uint8Array => {
  const raw = atob(text),
    out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/** What `loadWorld` builds a world from: the saved options (classifier and heights restored) and the saved edits. */
async function worldOptions(
  json: string | object,
): Promise<{ options: BiomeWorldOptions; edits: LayerWrite[] }> {
  const saved = (typeof json === 'string' ? JSON.parse(json) : json) as {
    format?: unknown;
    version?: unknown;
    options?: Record<string, any>;
    edits?: { name: string; x: number; z: number; data: string }[];
  };
  if (typeof saved !== 'object' || saved === null) throw typeError('loadWorld takes the JSON text or object that saveWorld(world) returns', 'biomes');
  if (saved.format !== 'margo-biomes-world' || saved.version !== 1 || !saved.options || !Array.isArray(saved.edits))
    throw rangeError('Not a saved biome world (format margo-biomes-world, version 1)', 'biomes');
  const options: Record<string, any> = { ...saved.options },
    height = options.height;
  for (const key of Object.keys(options)) if (options[key] === null || options[key] === undefined) delete options[key];
  if (height && typeof height === 'object' && 'samples' in height) {
    const bytes = unbase64(height.samples),
      Type = height.type === 'Float32Array' ? Float32Array : height.type === 'Int32Array' ? Int32Array : undefined;
    if (!Type) throw rangeError('Saved height samples are Int32Array or Float32Array', 'biomes');
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    options.height = { ...height, type: undefined, samples: new Type(copy.buffer) };
  }
  if (options.classifier === 'whittaker' || options.classifier === 'holdridge')
    options.classifier = (await import('@margoengine/biomes/zones'))[options.classifier as 'whittaker' | 'holdridge'];
  else if (options.classifier !== undefined && options.classifier !== 'envelopes')
    throw rangeError('Saved classifier is envelopes, whittaker or holdridge', 'biomes');
  return {
    options: options as BiomeWorldOptions,
    edits: saved.edits.map((e) => ({ name: e.name, x: e.x, z: e.z, data: unbase64(e.data) })),
  };
}

function base64(a: ArrayBufferView): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

/**
 * The world as plain JSON data: its options and every painted or masked user layer (base64). `JSON.stringify` it to
 * save; {@link loadWorld} rebuilds a world with the same digests. Runtime options (device, backend, workers, signal,
 * cache) are not saved.
 * @throws MargoError `'unsupported'` for a `field` height function, which JSON cannot hold.
 */
export function saveWorld(world: BiomeWorld): unknown {
  const { options, classifier, paint, user } = world.state(),
    { seed, size, origin, tileSize, resolution, regionResolution, climate, ecotone, biomes, height: h } = options;
  if (h && 'field' in h) throw fault('unsupported', 'saveWorld cannot save a height function', 'biomes');
  return {
    format: 'margo-biomes-world',
    version: 1,
    options: {
      seed,
      size,
      origin,
      tileSize,
      resolution,
      regionResolution,
      climate,
      ecotone,
      biomes,
      classifier: classifier === 'envelopes' ? classifier : classifier.kind,
      paint,
      height: h && 'samples' in h ? { ...h, samples: base64(h.samples), type: h.samples.constructor.name } : h,
    },
    edits: [...user].flatMap(([name, tiles]) =>
      [...tiles].map(([at, data]) => {
        const [x, z] = at.split(',').map(Number);
        return { name, x, z, data: base64(data) };
      }),
    ),
  };
}

/**
 * Rebuilds a world from `JSON.stringify(saveWorld(world))` (the string or the parsed value). `runtime` adds the options
 * JSON cannot hold: `device`, `backend`, `workers`, `createWorker`, `signal`, `cache`.
 * @throws RangeError for data that is not a saved biome world.
 */
export async function loadWorld(json: string | object, runtime: Partial<BiomeWorldOptions> = {}): Promise<BiomeWorld> {
  const { options, edits } = await worldOptions(json),
    world = await BiomeWorld.create({ ...options, ...runtime });
  world.writeLayers(edits);
  return world;
}
