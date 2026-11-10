// Clean-room image columns and font-mask extrusion. Sources and sampling rules: docs/clean-room.md.
import { Colors, rgba } from './file-colors.js';
import { cellIndex, cellLimit, checkOptions, sizeCells, type GridLimits, type VoxelGrid } from './grid.js';

/** Row-major, top-left image. One byte per grey sample or four straight RGBA8 bytes per pixel. */
export interface VoxelImage {
  /** Positive integer width in pixels. */
  width: number;
  /** Positive integer height in pixels. */
  height: number;
  /** Grey8 or RGBA8 samples; the length determines the layout. */
  data: Uint8Array | Uint8ClampedArray;
}

/** An owned grid and its palette, index 0 reserved for air. */
export interface GeneratedVoxels {
  /** Y-up cells. */
  grid: VoxelGrid;
  /** 256 RGBA8 entries, index i at 4*i. */
  palette: Uint8Array;
  /** True if more than 255 colours required deterministic low-bit reduction. */
  colorsReduced: boolean;
}

/** Image column generation options. */
export interface HeightmapOptions extends GridLimits {
  /** Maximum column height in whole cells. Default 32. Black is zero; white is this height. */
  height?: number;
  /** Height source for RGBA; grey input always uses its sample. Default 'luma' (BT.709 encoded RGB). */
  channel?: 'luma' | 'red' | 'green' | 'blue' | 'alpha';
  /** RGBA samples at or below this alpha are air. Default 0. */
  alphaThreshold?: number;
  /** Invert the height sample before scaling. Default false. */
  invert?: boolean;
  /** Cancellation checked before allocation and each image row. */
  signal?: AbortSignal;
}

function positive(value: number, subject: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${subject} must be a positive integer; pass whole cells`);
  return value;
}

function threshold(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 255)
    throw new RangeError('alphaThreshold must be 0 to 255; pass an RGBA8 alpha');
  return value;
}

function imageLayout(image: VoxelImage, limit: number): number {
  checkOptions(image, 'image');
  sizeCells([image.width, 1, image.height], limit, 'image');
  if (!(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray))
    throw new TypeError('image data must hold bytes; pass Grey8 or RGBA8 samples');
  const stride = image.data.length / (image.width * image.height);
  if (stride !== 1 && stride !== 4)
    throw new RangeError('image data length does not match its dimensions; pass Grey8 or RGBA8 samples');
  return stride;
}

/**
 * Columns along Y, image columns along X and top-to-bottom rows along Z. Heights round to the nearest cell;
 * RGBA columns retain their source colour. The image is unchanged.
 * @throws RangeError for invalid dimensions, channels, thresholds or cell budgets; pass valid image options.
 */
export function heightmapToVoxels(image: VoxelImage, options: HeightmapOptions = {}): GeneratedVoxels {
  checkOptions(options, 'heightmapToVoxels');
  options.signal?.throwIfAborted();
  const limit = cellLimit(options),
    stride = imageLayout(image, limit),
    height = positive(options.height ?? 32, 'height'),
    alpha = threshold(options.alphaThreshold ?? 0),
    channel = options.channel ?? 'luma',
    invert = options.invert ?? false;
  if (!['luma', 'red', 'green', 'blue', 'alpha'].includes(channel))
    throw new RangeError('height channel is unknown; use luma, red, green, blue or alpha');
  if (typeof invert !== 'boolean') throw new TypeError('invert must be boolean; pass true or false');
  const size = [image.width, height, image.height] as const,
    colors = new Colors(limit),
    cells = colors.add(size, [0, 0, 0], undefined, 'heightmap');
  for (let z = 0; z < image.height; z++) {
    options.signal?.throwIfAborted();
    for (let x = 0; x < image.width; x++) {
      const at = (x + z * image.width) * stride,
        r = image.data[at],
        g = stride === 1 ? r : image.data[at + 1],
        b = stride === 1 ? r : image.data[at + 2],
        a = stride === 1 ? 255 : image.data[at + 3];
      if (a <= alpha) continue;
      const sample =
          stride === 1
            ? r
            : channel === 'luma'
              ? 0.2126 * r + 0.7152 * g + 0.0722 * b
              : channel === 'red'
                ? r
                : channel === 'green'
                  ? g
                  : channel === 'blue'
                    ? b
                    : a,
        count = Math.round(((invert ? 255 - sample : sample) * height) / 255),
        color = rgba(r, g, b, a);
      for (let y = 0; y < count; y++) cells[cellIndex(size, x, y, z)] = color;
    }
  }
  const file = colors.finish();
  return { grid: file.models[0].grid, palette: file.palette, colorsReduced: file.colorsReduced };
}

/** Text rasterization and mask extrusion options. */
export interface TextVoxelOptions extends GridLimits {
  /** CSS canvas font, including pixel size and family. Required; fonts must already be loaded. */
  font: string;
  /** Extrusion along positive Z, in cells. Default 1. */
  depth?: number;
  /** Coverage must exceed this byte to fill a cell. Default 127. */
  alphaThreshold?: number;
  /** Filled RGBA8 colour. Default [255, 255, 255, 255]. */
  color?: readonly [number, number, number, number];
  /** Baseline distance for multiline text in pixels. Default measured font height times 1.2. */
  lineHeight?: number;
  /** Canvas context to use, resized and cleared. Default a new offscreen canvas or DOM canvas at call time. */
  context?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  /** Cancellation checked before rasterization and each image row. */
  signal?: AbortSignal;
}

/**
 * Rasterizes Unicode text using the supplied CSS font, crops to ink bounds and extrudes the mask into Z.
 * Font shaping and ligatures use the platform text engine; await FontFace.load() before calling for custom fonts.
 * A blank string yields one empty cell. No browser objects are accessed on import.
 * @throws TypeError without a canvas 2D context; provide options.context in hosts without Canvas.
 * @throws RangeError for invalid font, extrusion, colour, line spacing or budget; pass valid text options.
 */
export function textToVoxels(text: string, options: TextVoxelOptions): GeneratedVoxels {
  checkOptions(options, 'textToVoxels');
  options.signal?.throwIfAborted();
  if (typeof text !== 'string' || typeof options.font !== 'string' || !options.font.trim())
    throw new TypeError('text and font must be strings; pass text and a CSS font with size and family');
  const limit = cellLimit(options),
    depth = positive(options.depth ?? 1, 'depth'),
    alpha = threshold(options.alphaThreshold ?? 127),
    color = options.color ?? [255, 255, 255, 255];
  if (color.length !== 4 || !Array.from(color).every((v) => Number.isInteger(v) && v >= 0 && v <= 255) || !color[3])
    throw new RangeError('text colour must be nontransparent RGBA8; pass four bytes with positive alpha');
  const canvas =
      options.context?.canvas ??
      (typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1)
        : typeof document !== 'undefined'
          ? document.createElement('canvas')
          : undefined),
    ctx =
      options.context ??
      (canvas?.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null);
  if (!canvas || !ctx) throw new TypeError('text needs Canvas 2D; provide a context or use a browser with Canvas');
  canvas.width = canvas.height = 1;
  const style = () => {
    ctx.font = '1px serif';
    ctx.font = options.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  };
  style();
  if (ctx.font === '1px serif' && options.font !== '1px serif')
    throw new RangeError('font is not a valid canvas font; include a size such as 16px and a family');
  const reference = ctx.measureText('Mg'),
    lines = text.split(/\r\n|\r|\n/),
    spacing =
      options.lineHeight ?? Math.max(1, reference.actualBoundingBoxAscent + reference.actualBoundingBoxDescent) * 1.2;
  if (!Number.isFinite(spacing) || spacing <= 0)
    throw new RangeError('lineHeight must be positive; pass pixel spacing');
  let left = 0,
    right = 0,
    top = 0,
    bottom = 0;
  lines.forEach((line, i) => {
    const m = ctx.measureText(line);
    left = Math.min(left, -m.actualBoundingBoxLeft);
    right = Math.max(right, m.actualBoundingBoxRight);
    top = Math.min(top, i * spacing - m.actualBoundingBoxAscent);
    bottom = Math.max(bottom, i * spacing + m.actualBoundingBoxDescent);
  });
  left = Math.floor(left);
  top = Math.floor(top);
  const width = Math.max(1, Math.ceil(right) - left),
    height = Math.max(1, Math.ceil(bottom) - top),
    size = [width, height, depth] as const;
  const voxels = new Uint8Array(sizeCells(size, limit, 'text'));
  canvas.width = width;
  canvas.height = height;
  style();
  ctx.fillStyle = '#fff';
  lines.forEach((line, i) => ctx.fillText(line, -left, i * spacing - top));
  const pixels = ctx.getImageData(0, 0, width, height).data;
  for (let row = 0; row < height; row++) {
    options.signal?.throwIfAborted();
    for (let x = 0; x < width; x++)
      if (pixels[(row * width + x) * 4 + 3] > alpha)
        for (let z = 0; z < depth; z++) voxels[cellIndex(size, x, height - 1 - row, z)] = 1;
  }
  const palette = new Uint8Array(1024);
  palette.set(color, 4);
  return { grid: { size, voxels }, palette, colorsReduced: false };
}
