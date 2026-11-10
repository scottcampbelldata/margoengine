import { Camera } from '@margoengine/core';
import type { EnginePlugin, FrameGraph } from '@margoengine/core/extension';
import type { Figure } from '@margoengine/sciviz';
import { clearColorValue } from '../../shared/clear-color.js';
import { fault, rangeError } from '../../shared/errors.js';

/** One tile, top-left origin, straight RGBA in sRGB. The consumer owns its bytes. */
export interface MediaTile {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
}
/** Common image sizing and tiled capture options. */
export interface MediaImageOptions {
  /** Multiplier of the source CSS dimensions. Default 1. Cannot combine with size. */
  readonly scale?: number;
  /** Explicit physical or pixel size. Physical sizes use dpi (default 300). Both dimensions are required. */
  readonly size?: { readonly width: number; readonly height: number; readonly unit: 'px' | 'mm' | 'in' };
  /** Physical pixel density in dots per inch. Default 300; maximum 1000000. */
  readonly dpi?: number;
  /** Maximum GPU tile edge, clamped to the device limit. Default 1024. */
  readonly tileSize?: number;
  /** Clear pixels outside geometry to transparent. Default false. */
  readonly transparent?: boolean;
  /** Include figure text, legends and colour bars. Default true. */
  readonly overlays?: boolean;
  /** Maximum raw strip or WebP canvas memory. Default 256 MiB. */
  readonly maxBytes?: number;
  /** Record embedded in PNG iTXt or WebP XMP. Default figure.provenance() when present. */
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

/** Resolves pixel dimensions, rounding physical lengths once. No rendering or DOM access. */
export function mediaDimensions(
  width: number,
  height: number,
  options: MediaImageOptions = {},
): { width: number; height: number; dpi: number } {
  const dpi = options.dpi ?? 300,
    scale = options.scale ?? 1,
    size = options.size;
  if (![dpi, scale, width, height].every((v) => Number.isFinite(v) && v > 0) || dpi > 1_000_000)
    throw rangeError('Image sizes and scale must be positive finite numbers; dpi must be in (0, 1000000]', 'sciviz');
  if (size && options.scale !== undefined) throw rangeError('Choose a physical size or a scale, not both', 'sciviz');
  if (size && !['px', 'mm', 'in'].includes(size.unit))
    throw rangeError('Image size unit must be px, mm or in', 'sciviz');
  const factor = size ? (size.unit === 'mm' ? dpi / 25.4 : size.unit === 'in' ? dpi : 1) : scale;
  const w = Math.round((size?.width ?? width) * factor),
    h = Math.round((size?.height ?? height) * factor);
  if (![w, h].every((v) => Number.isSafeInteger(v) && v > 0 && v <= 0x7fffffff))
    throw rangeError('Image dimensions must round to positive 31-bit integers', 'sciviz');
  return { width: w, height: h, dpi };
}

/** @internal Off-axis projection, retaining all rows including the homogeneous w row. */
export function cropProjection(
  base: ArrayLike<number>,
  fullWidth: number,
  fullHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Float64Array {
  const out = Float64Array.from(base),
    sx = fullWidth / width,
    sy = fullHeight / height,
    tx = (fullWidth - 2 * x - width) / width,
    ty = (2 * y + height - fullHeight) / height;
  for (let c = 0; c < 4; c++) {
    out[c * 4] = sx * base[c * 4] + tx * base[c * 4 + 3];
    out[c * 4 + 1] = sy * base[c * 4 + 1] + ty * base[c * 4 + 3];
  }
  return out;
}

/** @internal Query the optional provenance contract without loading another entry. */
export async function mediaProvenance(
  figure: Figure,
  options: MediaImageOptions,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (options.provenance) return options.provenance;
  const source = figure as Figure & {
    provenance?: () => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
  };
  return typeof source.provenance === 'function' ? await source.provenance() : undefined;
}

// No primary camera, canvas size or animation state is changed. A temporary pass clears only our private target.
class TileClear implements EnginePlugin {
  readonly name = 'sciviz:media-clear';
  constructor(readonly tint: GPUColor) {}
  setup(): void {}
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -1_000_000,
      execute: (context) => {
        if (context.backend !== 'webgpu' || context.view?.id !== this.name) return;
        context.encoder
          .beginRenderPass({
            colorAttachments: [{ view: context.color, clearValue: this.tint, loadOp: 'clear', storeOp: 'store' }],
          })
          .end();
      },
    });
  }
}
const active = new WeakSet<object>();

/**
 * Renders actual off-axis tiles, never an enlarged source bitmap. Captures a fixed camera; the caller keeps layer
 * data stable until iteration finishes. Supports WebGPU and the WebGL2 compatibility layer. Close the iterator to
 * release resources early. Native WebGL2 users use createFallbackFigure for this GPU-target API.
 */
export async function* renderMediaTiles(figure: Figure, options: MediaImageOptions = {}): AsyncGenerator<MediaTile> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (active.has(figure.engine)) throw fault('state', 'A media capture is already active on this engine', 'sciviz');
  active.add(figure.engine);
  let attached = false;
  try {
    await figure.ready();
    // The overlay painter is the figure's lazily loaded export module (Figure.toPNG loads it the same way), so no
    // module of this package imports it both ways (tests/dist-dynamic-imports.test.js).
    const overlays = options.overlays === false ? undefined : await import('./export.js');
    signal?.throwIfAborted();
    const engine = figure.engine,
      device = engine.gpu;
    if (!device) throw fault('unsupported', 'Tiled export needs WebGPU or the WebGL2 compatibility layer', 'sciviz');
    const canvas = engine.canvas,
      origin = canvas.getBoundingClientRect(),
      cssWidth = canvas.clientWidth || canvas.width,
      cssHeight = canvas.clientHeight || canvas.height;
    const { width, height } = mediaDimensions(cssWidth, cssHeight, options);
    const tileSize = options.tileSize ?? 1024;
    if (!Number.isSafeInteger(tileSize) || tileSize < 1)
      throw rangeError('tileSize must be a positive integer', 'sciviz');
    const edge = Math.min(tileSize, device.limits.maxTextureDimension2D),
      layout = figure.exportLayout();
    figure.render();
    const runs = overlays ? overlays.textRuns(layout.roots, origin) : [],
      boxes = overlays ? overlays.swatches(layout.roots, origin) : [];
    const source = engine.camera,
      aspect = cssWidth / cssHeight,
      base = new Float64Array(16);
    const { setLineCameraTile } = await import('@margoengine/lines/tiles');
    if (source.project) source.project(base, aspect, true);
    else {
      const f = 1 / Math.tan((source.fov * Math.PI) / 360),
        d = source.far - source.near;
      base[0] = f / aspect;
      base[5] = f;
      base[10] = -source.near / d;
      base[11] = -1;
      base[14] = (-source.far * source.near) / d;
    }
    const camera = new Camera({
      position: [...source.position],
      target: [...source.target],
      near: source.near,
      far: source.far,
      fov: source.fov,
    });
    camera.up = [...source.up];
    camera.project = (out) => out.set(base);
    const clip = engine.views?.find((v) => v.camera === source)?.scissor ?? [0, 0, 1, 1];
    const tint = options.transparent ? [0, 0, 0, 0] : [...clearColorValue(figure.theme.background)];
    const plugin = new TileClear(tint);
    engine.use(plugin);
    attached = true;
    for (let y = 0; y < height; y += edge)
      for (let x = 0; x < width; x += edge) {
        signal?.throwIfAborted();
        const w = Math.min(edge, width - x),
          h = Math.min(edge, height - y);
        let releaseLineTile: (() => void) | undefined;
        // Round the complete view-projection exactly as the whole-image camera does before cropping it.
        // Cropping the projection first changes the multiplication's rounding at antialiased line edges.
        camera.update = (_aspect, webgpu) => {
          Camera.prototype.update.call(camera, aspect, webgpu);
          releaseLineTile?.();
          releaseLineTile = setLineCameraTile(camera, {
            matrix: camera.matrix,
            fullWidth: width,
            fullHeight: height,
            x,
            y,
            width: w,
            height: h,
          });
          camera.matrix.set(cropProjection(camera.matrix, width, height, x, y, w, h));
        };
        const sx = Math.min(w, Math.max(0, clip[0] * width - x)),
          sy = Math.min(h, Math.max(0, clip[1] * height - y)),
          ex = Math.min(w, (clip[0] + clip[2]) * width - x),
          ey = Math.min(h, (clip[1] + clip[3]) * height - y);
        const stride = Math.ceil((w * 4) / 256) * 256,
          budget = options.maxBytes ?? 256 * 1024 * 1024;
        if (stride * h > budget || stride * h > device.limits.maxBufferSize)
          throw rangeError('Tile readback exceeds maxBytes or the device buffer limit; reduce tileSize', 'sciviz');
        const texture = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: 0x10 | 0x01 });
        let buffer: GPUBuffer | undefined;
        try {
          buffer = device.createBuffer({ size: stride * h, usage: 0x01 | 0x08 });
          // Lines use target width/CSS width for pixel density. Counter the tile width synchronously; restore before any await.
          const restore: (() => void)[] = [];
          for (const layer of figure.layers)
            if ('kind' in layer && layer.kind === 'scatter') {
              const m = layer.cloud.material,
                previous = [m.size, m.minPixelSize, m.maxPixelSize],
                scale = width / cssWidth;
              if (m.sizeUnits === 'pixels') m.size *= scale;
              m.minPixelSize *= scale;
              m.maxPixelSize *= scale;
              restore.push(() => {
                [m.size, m.minPixelSize, m.maxPixelSize] = previous;
              });
            }
          try {
            if (Math.round(ex) > Math.round(sx) && Math.round(ey) > Math.round(sy))
              engine.render({
                views: [
                  {
                    camera,
                    viewport: [0, 0, 1, 1],
                    scissor: [sx / w, sy / h, Math.max(0, ex - sx) / w, Math.max(0, ey - sy) / h],
                    target: { color: texture },
                    id: plugin.name,
                    clear: { color: false },
                  },
                ],
              });
            else {
              const clear = device.createCommandEncoder();
              clear
                .beginRenderPass({
                  colorAttachments: [
                    { view: texture.createView(), clearValue: tint, loadOp: 'clear', storeOp: 'store' },
                  ],
                })
                .end();
              device.queue.submit([clear.finish()]);
            }
          } finally {
            for (const undo of restore) undo();
          }
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride, rowsPerImage: h }, [w, h]);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(1);
          signal?.throwIfAborted();
          const mapped = new Uint8Array(buffer.getMappedRange()),
            pixels = new Uint8ClampedArray(w * h * 4);
          for (let row = 0; row < h; row++)
            pixels.set(mapped.subarray(row * stride, row * stride + w * 4), row * w * 4);
          buffer.unmap();
          if (options.transparent)
            for (let p = 0; p < pixels.length; p += 4) {
              const alpha = pixels[p + 3];
              if (alpha && alpha < 255)
                for (let c = 0; c < 3; c++) pixels[p + c] = Math.min(255, Math.round((pixels[p + c] * 255) / alpha));
            }
          if (overlays) {
            const surface = new OffscreenCanvas(w, h),
              g = surface.getContext('2d')!;
            g.putImageData(new ImageData(pixels, w, h), 0, 0);
            g.translate(-x, -y);
            g.scale(width / (origin.width || cssWidth), height / (origin.height || cssHeight));
            overlays.paintOverlays(g, runs, layout.bars, origin, 1, boxes);
            pixels.set(g.getImageData(0, 0, w, h).data);
          }
          yield { x, y, width: w, height: h, pixels };
        } finally {
          releaseLineTile?.();
          buffer?.destroy();
          texture.destroy();
        }
      }
  } finally {
    if (attached && !figure.engine.disposed) figure.engine.removePlugin('sciviz:media-clear');
    active.delete(figure.engine);
  }
}
