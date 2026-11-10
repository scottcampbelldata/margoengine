// Clean room: clip-space subfrusta (Khronos OpenGL 1.2.1) and image accumulation
// (Haeberli and Akeley, SIGGRAPH 1990). No full-image GPU allocation.
import { Camera, type Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { readPixels, type HeadlessPixels } from './index.js';
import { fault, rangeError } from '../../shared/errors.js';

/** Options for a still larger than the device texture limit. */
export interface TiledRenderOptions {
  /** Output width in pixels, a positive safe integer. Required. */
  width: number;
  /** Output height in pixels, a positive safe integer. Required. */
  height: number;
  /** Maximum tile edge, including padding. Default min(1024, device limit). */
  tileSize?: number;
  /** Subpixel renders per output pixel, 1..1024. Default 1. */
  samples?: number;
  /** Guard pixels on each tile edge for local screen-space filters. Default 0. */
  padding?: number;
  /** Camera, including its custom projection. Default engine.camera. */
  camera?: Camera;
  /** Cancel between samples or during readback. Default none. */
  signal?: AbortSignal;
}

/** One finished tile, top row first, with guard pixels removed. */
export interface RenderedTile extends HeadlessPixels {
  /** Left edge in the full image. */
  x: number;
  /** Top edge in the full image. */
  y: number;
}

const active = new WeakSet<Engine>();
const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const display = (c: number): number => 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
function radical(index: number, base: number): number {
  let value = 0;
  for (let weight = 1 / base; index; index = Math.floor(index / base), weight /= base) value += (index % base) * weight;
  return value;
}

/**
 * Streams a WebGPU headless still in row-major tiles. Time stays fixed (delta 0).
 * Each sample has the same full-image subpixel offset, so boundaries agree.
 * Accumulation uses premultiplied linear light, returning straight-alpha sRGB.
 * CPU memory is O(tileSize squared), independent of image size and sample count.
 * Do not render or resize this engine concurrently. Closing the iterator restores
 * the canvas; the caller's camera is never modified. Nonlocal/temporal effects
 * need to be disabled; finite-radius filters need sufficient padding.
 */
export async function* renderTiles(instance: Engine, options: TiledRenderOptions): AsyncGenerator<RenderedTile> {
  const { width, height, samples = 1, padding = 0, signal } = options;
  signal?.throwIfAborted();
  const engine = engineRuntime(instance),
    device = engine.gpu;
  if (!device) throw fault('unsupported', 'Tiled headless capture requires WebGPU', 'headless');
  const limit = device.limits.maxTextureDimension2D,
    tileSize = options.tileSize ?? Math.min(1024, limit);
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0))
    throw rangeError('Tiled width and height must be positive safe integers', 'headless');
  if (!Number.isInteger(samples) || samples < 1 || samples > 1024)
    throw rangeError('Tiled samples must be in 1..1024', 'headless');
  if (
    !Number.isInteger(tileSize) ||
    tileSize < 1 ||
    tileSize > limit ||
    !Number.isInteger(padding) ||
    padding < 0 ||
    padding * 2 >= tileSize
  )
    throw rangeError('Tile size must fit the device and leave space after padding', 'headless');
  if (active.has(engine)) throw fault('state', 'A tiled capture is already active on this engine', 'headless');
  const canvas = engine.canvas,
    before = [canvas.width, canvas.height],
    source = options.camera ?? engine.camera,
    shot = new Camera(source),
    edge = tileSize - 2 * padding;
  shot.up = source.up;
  shot.project = source.project;
  active.add(engine);
  try {
    for (let y = 0; y < height; y += edge)
      for (let x = 0; x < width; x += edge) {
        const w = Math.min(edge, width - x),
          h = Math.min(edge, height - y),
          rw = w + padding * 2,
          rh = h + padding * 2,
          sums = new Float64Array(w * h * 4);
        for (let sample = 0; sample < samples; sample++) {
          signal?.throwIfAborted();
          const jx = samples === 1 ? 0 : radical(sample + 1, 2) - 0.5,
            jy = samples === 1 ? 0 : radical(sample + 1, 3) - 0.5;
          shot.update = (_aspect, webgpu) => {
            Camera.prototype.update.call(shot, width / height, webgpu);
            // Left multiply the full view-projection by a clip-space scale/shift.
            // Keep the full-view culling planes: conservative even at jittered edges.
            for (let c = 0; c < 16; c += 4) {
              shot.matrix[c] =
                (shot.matrix[c] * width + (width - 2 * (x - padding) - rw - 2 * jx) * shot.matrix[c + 3]) / rw;
              shot.matrix[c + 1] =
                (shot.matrix[c + 1] * height + (2 * (y - padding) + rh - height + 2 * jy) * shot.matrix[c + 3]) / rh;
            }
          };
          canvas.width = rw;
          canvas.height = rh;
          engine.render({ camera: shot, delta: 0, culling: false });
          const frame = await readPixels(instance, { signal });
          for (let row = 0; row < h; row++)
            for (let col = 0; col < w; col++) {
              const from = ((row + padding) * rw + col + padding) * 4,
                to = (row * w + col) * 4,
                alpha = frame.data[from + 3] / 255;
              for (let channel = 0; channel < 3; channel++)
                sums[to + channel] += linear(frame.data[from + channel] / 255) * alpha;
              sums[to + 3] += alpha;
            }
        }
        const data = new Uint8Array(w * h * 4);
        for (let i = 0; i < data.length; i += 4) {
          const alpha = sums[i + 3];
          for (let c = 0; c < 3; c++) data[i + c] = alpha ? Math.round(display(sums[i + c] / alpha)) : 0;
          data[i + 3] = Math.round((255 * alpha) / samples);
        }
        [canvas.width, canvas.height] = before;
        yield { x, y, width: w, height: h, data };
      }
  } finally {
    [canvas.width, canvas.height] = before;
    active.delete(engine);
  }
}

/** Collects renderTiles into one RGBA image. Full-image CPU memory must fit the runtime. */
export async function renderTiled(engine: Engine, options: TiledRenderOptions): Promise<HeadlessPixels> {
  // Let the iterator validate dimensions and cancellation before allocating the full image.
  let data: Uint8Array | undefined;
  for await (const tile of renderTiles(engine, options)) {
    data ??= new Uint8Array(options.width * options.height * 4);
    for (let row = 0; row < tile.height; row++)
      data.set(
        tile.data.subarray(row * tile.width * 4, (row + 1) * tile.width * 4),
        ((tile.y + row) * options.width + tile.x) * 4,
      );
  }
  return { width: options.width, height: options.height, data: data! };
}
