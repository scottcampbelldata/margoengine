// Sprite-slice stacking: laid-out RGBA frames of one image into an indexed Y-up grid, colours kept exactly.
import type { MutableVec3 } from '@margoengine/math';
import { cellLimit, checkOptions, type GridLimits, type VoxelGrid } from './grid.js';

/** Decoded RGBA pixels, 4 bytes per pixel, rows top to bottom (an `ImageData`'s layout). */
export interface SlicePixels {
  /** Pixels per row, a positive integer. */
  width: number;
  /** Rows, a positive integer. */
  height: number;
  /** `width * height * 4` bytes: red, green, blue, alpha. */
  data: Uint8Array | Uint8ClampedArray;
}

/** How {@link stackSlices} reads the frames and turns them into cells. */
export interface SliceOptions extends GridLimits {
  /** Frame width in pixels; must divide the image width. */
  frameWidth: number;
  /** Frame height in pixels; must divide the image height. */
  frameHeight: number;
  /** Frames per row of the sheet, from 1 to `width / frameWidth`. Default `width / frameWidth`. */
  columns?: number;
  /** Frames to stack, read row by row (left to right, then down), from 1 to `columns * rows`. Default all. */
  frameCount?: number;
  /**
   * The axis frames stack along. `'y'` (default): frame pixel (column, row) lands at (column, depth, row), so image
   * rows run along +z. `'z'`: (column, frameHeight - 1 - row, depth), the image upright. `'x'`: (depth,
   * frameHeight - 1 - row, column).
   */
  axis?: 'x' | 'y' | 'z';
  /** Frame 0 at the top (true, default: depth `frameCount - 1 - frame`) or at the bottom (false: depth `frame`). */
  topToBottom?: boolean;
  /** Pixels with alpha below this, 1 to 255, are air. Default 1 (only fully transparent pixels are air). */
  alphaThreshold?: number;
  /**
   * The palette policy. Without it, each distinct RGBA colour kept gets the next index from 1 in reading order and
   * more than 255 colours are refused. With a 1,024-byte RGBA palette (index i at `4 * i`), each colour takes the
   * first index from 1 with exactly its bytes, and a colour it lacks is refused. Nothing is ever approximated.
   */
  palette?: Uint8Array;
}

/** The checked arithmetic of a slice layout ({@link sliceLayout}). */
export interface SliceLayout {
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  frameCount: number;
  /** `columns * rows`. */
  availableFrames: number;
  axis: 'x' | 'y' | 'z';
  topToBottom: boolean;
  alphaThreshold: number;
  /** The grid's size. */
  size: MutableVec3;
  /** The grid's cell count. */
  cells: number;
}

/** What {@link stackSlices} returns. */
export interface SliceStack {
  grid: VoxelGrid;
  /** 1,024 RGBA bytes, index i at `4 * i`; index 0 and unused indexes are 0 unless a palette was given. */
  palette: Uint8Array;
  /** Distinct indexes the grid uses. */
  colors: number;
  layout: SliceLayout;
}

function whole(value: unknown, subject: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max)
    throw new RangeError(`${subject} must be an integer from 1 to ${max}; pass one`);
  return value as number;
}

/**
 * Checks a slice layout against an image of `width` x `height` pixels without reading or allocating anything: frame
 * sizes divide the image, counts fit the sheet, and the image and the grid stay within `maxCells`.
 */
export function sliceLayout(width: number, height: number, options: SliceOptions): SliceLayout {
  checkOptions(options, 'sliceLayout');
  const limit = cellLimit(options);
  whole(width, 'Slice image width');
  whole(height, 'Slice image height');
  if (width * height > limit) throw new RangeError(`Slice image exceeds maxCells (${limit}) pixels; raise it or crop`);
  const frameWidth = whole(options.frameWidth, 'Slice frameWidth'),
    frameHeight = whole(options.frameHeight, 'Slice frameHeight');
  if (width % frameWidth || height % frameHeight)
    throw new RangeError('Slice image size is not a whole grid of frames; pass frame sizes that divide it');
  const columns = whole(options.columns ?? width / frameWidth, 'Slice columns', width / frameWidth),
    rows = height / frameHeight,
    availableFrames = columns * rows,
    frameCount = whole(options.frameCount ?? availableFrames, 'Slice frameCount', availableFrames),
    axis = options.axis ?? 'y',
    topToBottom = options.topToBottom ?? true,
    alphaThreshold = whole(options.alphaThreshold ?? 1, 'Slice alphaThreshold', 255);
  if (axis !== 'x' && axis !== 'y' && axis !== 'z') throw new RangeError("Slice axis is unknown; pass 'x', 'y' or 'z'");
  if (typeof topToBottom !== 'boolean') throw new TypeError('Slice topToBottom is not a boolean; pass true or false');
  const size: MutableVec3 =
      axis === 'y'
        ? [frameWidth, frameCount, frameHeight]
        : axis === 'z'
          ? [frameWidth, frameHeight, frameCount]
          : [frameCount, frameHeight, frameWidth],
    cells = frameWidth * frameHeight * frameCount;
  if (cells > limit) throw new RangeError(`Slice stack exceeds maxCells (${limit}); stack fewer or smaller frames`);
  return {
    frameWidth,
    frameHeight,
    columns,
    rows,
    frameCount,
    availableFrames,
    axis,
    topToBottom,
    alphaThreshold,
    size,
    cells,
  };
}

/**
 * Stacks sprite frames into an indexed grid, Y up: frame `f` of the sheet becomes one layer along `axis`, its kept
 * pixels cells with their exact RGBA colour's palette index and transparent pixels air (empty frames keep their
 * layer). Every colour is checked against the palette policy before the grid is allocated.
 */
export function stackSlices(pixels: SlicePixels, options: SliceOptions): SliceStack {
  if (typeof pixels !== 'object' || pixels === null)
    throw new TypeError('stackSlices pixels are missing; pass {width, height, data}');
  const layout = sliceLayout(pixels.width, pixels.height, options),
    { data, width } = pixels;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * pixels.height * 4)
    throw new RangeError('stackSlices RGBA buffer does not match the image size; pass width * height * 4 bytes');
  const fixed = options.palette;
  if (fixed !== undefined && (!(fixed instanceof Uint8Array) || fixed.length !== 1024))
    throw new TypeError('stackSlices palette must be a 1,024-byte RGBA Uint8Array; pass one or leave it out');
  const { frameWidth, frameHeight, columns, frameCount, alphaThreshold, axis, topToBottom, size } = layout,
    key = (offset: number) =>
      (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0,
    indexes = new Map<number, number>(),
    palette = fixed ? fixed.slice() : new Uint8Array(1024);
  if (fixed)
    for (let i = 255; i >= 1; i--)
      indexes.set(
        (fixed[4 * i] | (fixed[4 * i + 1] << 8) | (fixed[4 * i + 2] << 16) | (fixed[4 * i + 3] << 24)) >>> 0,
        i,
      );
  const used = new Set<number>();
  for (let frame = 0; frame < frameCount; frame++) {
    const left = (frame % columns) * frameWidth,
      top = Math.floor(frame / columns) * frameHeight;
    for (let row = 0; row < frameHeight; row++)
      for (let column = 0; column < frameWidth; column++) {
        const offset = ((top + row) * width + left + column) * 4;
        if (data[offset + 3] < alphaThreshold) continue;
        const color = key(offset);
        let index = indexes.get(color);
        if (index === undefined) {
          if (fixed)
            throw new RangeError(
              `stackSlices frame ${frame} uses a colour the palette lacks (pixel ${left + column}, ${top + row}); add it or drop the palette`,
            );
          if (indexes.size === 255)
            throw new RangeError(
              'stackSlices sees more than 255 distinct RGBA colours; reduce them or raise alphaThreshold',
            );
          index = indexes.size + 1;
          indexes.set(color, index);
          palette.set(data.subarray(offset, offset + 4), 4 * index);
        }
        used.add(index);
      }
  }
  const voxels = new Uint8Array(layout.cells),
    [sx, , sz] = size;
  for (let frame = 0; frame < frameCount; frame++) {
    const left = (frame % columns) * frameWidth,
      top = Math.floor(frame / columns) * frameHeight,
      depth = topToBottom ? frameCount - 1 - frame : frame;
    for (let row = 0; row < frameHeight; row++)
      for (let column = 0; column < frameWidth; column++) {
        const offset = ((top + row) * width + left + column) * 4;
        if (data[offset + 3] < alphaThreshold) continue;
        const [x, y, z] =
          axis === 'y'
            ? [column, depth, row]
            : axis === 'z'
              ? [column, frameHeight - 1 - row, depth]
              : [depth, frameHeight - 1 - row, column];
        voxels[x + sx * (z + sz * y)] = indexes.get(key(offset))!;
      }
  }
  return { grid: { size: [size[0], size[1], size[2]], voxels }, palette, colors: used.size, layout };
}
