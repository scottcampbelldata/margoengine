// The viewport's traced size: what the canvas and `resolutionScale` ask for, within what the device can bind.
import { checkNumber } from './scene.js';
import type { TraceViewportLimits, TraceViewportSize } from './types.js';

/** WebGPU's default `maxTextureDimension2D`, used when the limits leave it out. */
const DEFAULT_TEXTURE_DIMENSION = 8192;

/**
 * The size the viewport traces for a `width` x `height` drawing buffer: `resolutionScale` times it, reduced (keeping
 * the aspect) until every image fits one storage binding (16 bytes per pixel within `maxStorageBufferBindingSize`)
 * and, while denoising, the history textures fit `maxTextureDimension2D`. The tracer sizes its viewport with this;
 * `stats` reports the result. With WebGPU's default limits (128 MiB bindings, 8192 texels) a 3840 x 2160 viewport is
 * traced at its native size, denoised or not.
 * @throws TypeError / RangeError for a size that is not whole numbers from 1, invalid limits or options.
 */
export function traceViewportSize(
  width: number,
  height: number,
  limits: TraceViewportLimits,
  options: { resolutionScale?: number; denoise?: boolean | 'auto' } = {},
): TraceViewportSize {
  for (const [name, v] of [
    ['width', width],
    ['height', height],
  ] as const)
    if (!Number.isInteger(checkNumber(v, `viewport ${name}`, 1, 1 << 20, 'pass the drawing buffer size in pixels')))
      throw new RangeError(`VoxelPathTracer viewport ${name} ${v} must be a whole number of pixels`);
  if (!limits || typeof limits !== 'object')
    throw new TypeError('VoxelPathTracer viewport limits must be the device limits {maxStorageBufferBindingSize, ...}');
  const binding = checkNumber(
      limits.maxStorageBufferBindingSize,
      'maxStorageBufferBindingSize',
      16,
      Number.MAX_SAFE_INTEGER,
      'pass the device limits (device.limits)',
    ),
    dimension =
      limits.maxTextureDimension2D === undefined
        ? DEFAULT_TEXTURE_DIMENSION
        : checkNumber(limits.maxTextureDimension2D, 'maxTextureDimension2D', 1, 1 << 20, 'pass the device limits'),
    scale =
      options.resolutionScale === undefined
        ? 1
        : checkNumber(options.resolutionScale, 'resolutionScale', 0.1, 2, 'pass 0.1 to 2'),
    requestedWidth = Math.max(1, Math.round(width * scale)),
    requestedHeight = Math.max(1, Math.round(height * scale)),
    pixels = Math.floor(binding / 16);
  let w = requestedWidth,
    h = requestedHeight,
    limitedBy: TraceViewportSize['limitedBy'];
  if (w * h > pixels) {
    const k = Math.sqrt(pixels / (w * h));
    w = Math.max(1, Math.floor(w * k));
    h = Math.max(1, Math.floor(h * k));
    limitedBy = 'storage-binding';
  }
  if ((options.denoise ?? false) !== false && Math.max(w, h) > dimension) {
    const k = dimension / Math.max(w, h);
    w = Math.max(1, Math.min(dimension, Math.floor(w * k)));
    h = Math.max(1, Math.min(dimension, Math.floor(h * k)));
    limitedBy = 'texture-dimension';
  }
  return { width: w, height: h, requestedWidth, requestedHeight, ...(limitedBy ? { limitedBy } : {}) };
}
