// OpenEXR tiled reader: single-part tiled files (one level, mipmaps or ripmaps) with NONE, RLE, ZIPS, ZIP or PIZ.
// Layout from the OpenEXR File Layout ("Version Field", "tiledesc", "Offset Tables", "Tiled Chunk Layout") and the
// Technical Introduction ("Tiles", "Multiresolution Levels"); cited in docs/clean-room.md.
import {
  copyEXRLines,
  decodeEXRChunk,
  invalidEXR as invalid,
  parseEXR,
  pixelBytesOf,
  readEXRHeader,
  unsupportedEXR,
  type EXRImage,
} from './exr.js';
import { MAX_PIXELS, toBytes } from './hdr.js';

/** One decoded resolution level of a tiled OpenEXR file: linear float RGBA, row 0 at the top. */
export interface EXRLevel {
  /** Level number across x (0 is full width). */
  levelX: number;
  /** Level number across y (0 is full height; equal to `levelX` for mipmaps). */
  levelY: number;
  width: number;
  height: number;
  data: Float32Array;
}

/** How a tiled file is cut: tile size in pixels, level mode and rounding mode (the `tiles` header attribute). */
export interface EXRTiling {
  tileWidth: number;
  tileHeight: number;
  levelMode: 'ONE_LEVEL' | 'MIPMAP_LEVELS' | 'RIPMAP_LEVELS';
  roundingMode: 'ROUND_DOWN' | 'ROUND_UP';
  /** Levels the file holds across x and y (1 and 1 for ONE_LEVEL; equal for mipmaps). */
  levelsX: number;
  levelsY: number;
}

/** A decoded OpenEXR file: the full-resolution level as an {@link EXRImage}, plus its tiling and decoded levels. */
export interface EXRTiledImage extends EXRImage {
  /** The file's tiling, or undefined for a scanline file. */
  tiling?: EXRTiling;
  /** Decoded levels, level (0, 0) first (its `data` is the image's `data`); then the others in file level order. */
  levels: EXRLevel[];
}

/** Options for {@link parseTiledEXR}. */
export interface ParseTiledEXROptions {
  /** 'top' (default) decodes only the full-resolution level; 'all' decodes every mipmap or ripmap level too. */
  levels?: 'top' | 'all';
}

const LEVEL_MODES = ['ONE_LEVEL', 'MIPMAP_LEVELS', 'RIPMAP_LEVELS'] as const;
const ROUNDING_MODES = ['ROUND_DOWN', 'ROUND_UP'] as const;
const NO_SPEC = ['PXR24', 'B44', 'B44A', 'DWAA', 'DWAB'];

const rejectCompression = (label: string) =>
  NO_SPEC.includes(label)
    ? unsupportedEXR(
        `Unsupported EXR compression ${label}: OpenEXR publishes no byte-level description of it (the file layout ` +
          'page points to the library source, which a clean-room decoder cannot read)',
        'export it with NONE, RLE, ZIPS, ZIP or PIZ',
      )
    : unsupportedEXR(`Unsupported EXR compression ${label}`, 'export it with NONE, RLE, ZIPS, ZIP or PIZ');

/** floor(log2(v)) or ceil(log2(v)) for an integer v >= 1. */
const log2 = (v: number, up: boolean) => {
  const down = 31 - Math.clz32(v);
  return up && 2 ** down < v ? down + 1 : down;
};

/**
 * Parses a single-part OpenEXR file, tiled or scanline, into linear float RGBA. Tiled files may hold one level,
 * mipmaps or ripmaps with either rounding mode; the full-resolution level is always decoded, the rest with
 * `levels: 'all'`. Channels are picked as by `parseEXR` (R, G, B, A or Y). Scanline files are passed to `parseEXR`.
 * PXR24, B44, B44A and DWA compression, deep, multi-part and subsampled files are rejected with a descriptive error.
 * @throws MargoError `'failed'` for damaged data, `'unsupported'` for a file feature it does not decode; RangeError for an
 * image or tile over its bounds; TypeError for a source that is not bytes.
 */
export function parseTiledEXR(
  source: ArrayBuffer | ArrayBufferView,
  options: ParseTiledEXROptions = {},
): EXRTiledImage {
  const bytes = toBytes(source);
  if (bytes.length >= 8 && !(new DataView(bytes.buffer, bytes.byteOffset, 8).getUint32(4, true) & 0x200)) {
    const image = parseEXR(bytes);
    return { ...image, levels: [{ levelX: 0, levelY: 0, width: image.width, height: image.height, data: image.data }] };
  }
  const header = readEXRHeader(bytes, true, rejectCompression);
  const { view, channels, compression, dataWindow, displayWindow, width, height, indices, layout } = header;
  const { xSize, ySize, mode } = header.tiles!;
  const levelMode = mode & 15,
    roundingMode = mode >> 4;
  if (levelMode > 2 || roundingMode > 1) throw invalid(`bad tiles mode ${mode}`);
  if (!(xSize >= 1 && ySize >= 1 && xSize <= 1 << 24 && ySize <= 1 << 24))
    throw invalid(`bad tile size ${xSize}x${ySize}`);
  const up = roundingMode === 1;
  // Level counts and sizes: Technical Introduction, "Multiresolution Levels" (rf is floor or ceil; at least 1 pixel).
  const levelsX = levelMode === 0 ? 1 : log2(levelMode === 1 ? Math.max(width, height) : width, up) + 1;
  const levelsY = levelMode === 0 ? 1 : levelMode === 1 ? levelsX : log2(height, up) + 1;
  const size = (full: number, level: number) => Math.max(1, (up ? Math.ceil : Math.floor)(full / 2 ** level));
  interface Level extends EXRLevel {
    tilesX: number;
    tilesY: number;
    first: number;
  }
  const levels: Level[] = [];
  let chunks = 0;
  const addLevel = (levelX: number, levelY: number) => {
    const w = size(width, levelX),
      h = size(height, levelY),
      tilesX = Math.ceil(w / xSize),
      tilesY = Math.ceil(h / ySize);
    levels.push({ levelX, levelY, width: w, height: h, data: new Float32Array(0), tilesX, tilesY, first: chunks });
    chunks += tilesX * tilesY;
  };
  if (levelMode === 2) for (let ly = 0; ly < levelsY; ly++) for (let lx = 0; lx < levelsX; lx++) addLevel(lx, ly);
  else for (let l = 0; l < levelsX; l++) addLevel(l, l);
  const levelIndex = (lx: number, ly: number) =>
    levelMode === 2
      ? lx >= 0 && lx < levelsX && ly >= 0 && ly < levelsY
        ? ly * levelsX + lx
        : -1
      : lx === ly && lx >= 0 && lx < levelsX
        ? lx
        : -1;

  // One offset per tile of every level (File Layout, "Offset Tables"); each chunk names its own tile and level, so
  // the reader places it by that header and does not depend on the offsets' order.
  let position = header.position;
  if (position + chunks * 8 > bytes.length) throw invalid('unexpected end of file');
  const wanted = options.levels === 'all' ? levels.length : 1;
  const pixelBytes = pixelBytesOf(channels);
  const chunkOf = new Int32Array(chunks).fill(-1);
  let capacity = 0,
    needed = 0,
    pixels = 0;
  for (let i = 0; i < levels.length && i < wanted; i++) {
    needed += levels[i].width * levels[i].height * pixelBytes;
    pixels += levels[i].width * levels[i].height;
  }
  if (pixels > 2 * MAX_PIXELS)
    throw new RangeError(`Invalid EXR: the levels hold ${pixels} pixels; at most ${2 * MAX_PIXELS} decode at once`);
  for (let i = 0; i < chunks; i++, position += 8) {
    const offset = view.getUint32(position + 4, true) ? Infinity : view.getUint32(position, true);
    if (!(offset >= 8 && offset + 20 <= bytes.length))
      throw new RangeError(
        `Invalid EXR: tile ${i} offset out of bounds; the file is truncated, download or export it again`,
      );
    const tx = view.getInt32(offset, true),
      ty = view.getInt32(offset + 4, true),
      level = levelIndex(view.getInt32(offset + 8, true), view.getInt32(offset + 12, true)),
      dataSize = view.getInt32(offset + 16, true);
    if (dataSize < 0 || offset + 20 + dataSize > bytes.length)
      throw new RangeError(
        `Invalid EXR: tile ${i} data out of bounds; the file is truncated, download or export it again`,
      );
    const info = levels[level];
    if (!info || !(tx >= 0 && tx < info.tilesX && ty >= 0 && ty < info.tilesY))
      throw invalid(`tile ${i} has bad coordinates`);
    const slot = info.first + ty * info.tilesX + tx;
    if (chunkOf[slot] >= 0) throw invalid(`tile ${i} repeats an earlier tile`);
    chunkOf[slot] = offset;
    if (level < wanted) capacity += dataSize * (compression === 'NONE' ? 1 : 2048);
  }
  // Every tile is checked before any level is allocated: a small or truncated file cannot claim a large image.
  if (capacity < needed)
    throw new RangeError(
      'Invalid EXR: tiles are too small for the image size; the file is truncated, download or export it again',
    );
  if (Math.min(xSize, width) * Math.min(ySize, height) * pixelBytes > 1 << 28)
    throw new RangeError('Unsupported EXR: a tile decodes to more than 256 MiB; export the image with smaller tiles');

  for (let index = 0; index < wanted; index++) {
    const info = levels[index];
    const data = new Float32Array(info.width * info.height * 4);
    if (indices[3] < 0) for (let i = 3; i < data.length; i += 4) data[i] = 1;
    for (let ty = 0; ty < info.tilesY; ty++)
      for (let tx = 0; tx < info.tilesX; tx++) {
        const offset = chunkOf[info.first + ty * info.tilesX + tx]; // every tile was seen once and is in bounds
        const x0 = tx * xSize,
          y0 = ty * ySize,
          w = Math.min(xSize, info.width - x0),
          h = Math.min(ySize, info.height - y0);
        const packed = bytes.subarray(offset + 20, offset + 20 + view.getInt32(offset + 16, true));
        const raw = decodeEXRChunk(packed, h * w * pixelBytes, compression, channels, w, h, `tile (${tx}, ${ty})`);
        copyEXRLines(raw, h, w, channels, indices, data, info.width, x0, y0);
      }
    info.data = data;
  }
  return {
    width,
    height,
    data: levels[0].data,
    compression,
    channels,
    layout,
    dataWindow,
    displayWindow,
    tiling: {
      tileWidth: xSize,
      tileHeight: ySize,
      levelMode: LEVEL_MODES[levelMode],
      roundingMode: ROUNDING_MODES[roundingMode],
      levelsX,
      levelsY,
    },
    levels: levels
      .slice(0, wanted)
      .map(({ levelX, levelY, width, height, data }) => ({ levelX, levelY, width, height, data })),
  };
}
