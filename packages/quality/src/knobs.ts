import type { FeatureKnob } from './features.js';
import { applyQualityTier, type QualityOptions } from './index.js';
import { sceneSamples } from '../../shared/quality.js';
import { fault, rangeError } from '../../shared/errors.js';

/** A named, weighted ladder. Values go from full quality to least quality. */
export interface KnobOptions {
  /** Unique scaler name. Default depends on the factory. */
  name?: string;
  /** Perceptual importance, finite and above zero. Default 2. */
  weight?: number;
  /** Linear scale per level, strictly decreasing from 1 to above 0. Default [1, 0.5, 0.25]. */
  scales?: readonly number[];
}

function ladder(options: KnobOptions, fallback: string) {
  const { name = fallback, weight = 2, scales = [1, 0.5, 0.25] } = options;
  const values = [...scales];
  if (
    !name ||
    !Number.isFinite(weight) ||
    weight <= 0 ||
    values.length < 2 ||
    values[0] !== 1 ||
    values.some((scale, i) => !Number.isFinite(scale) || scale <= 0 || (i > 0 && scale >= values[i - 1]))
  )
    throw rangeError(
      'Invalid knob ladder; use a name, positive weight and decreasing scales starting at 1',
      'arguments',
    );
  const check = (level: number) => {
    if (!Number.isInteger(level) || level < 0 || level >= values.length)
      throw rangeError('Invalid knob level; use an integer within the ladder', 'arguments');
  };
  return { name, weight, values, check };
}

/** A resource knob restores the caller-owned original and frees only its own allocations. */
export interface TextureKnob extends FeatureKnob {
  /** Currently bound texture; full resolution until a lower level is applied. */
  readonly texture: GPUTexture;
  /** Restore original binding, release reduced textures and reject subsequent apply calls. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Device, caller-owned original and a synchronous binding update, for a live texture or colour target. */
export interface TextureKnobOptions extends KnobOptions {
  /** Device owning every supplied resource. Rebuild the knob after device restoration. */
  device: GPUDevice;
  /** Original 2D, single-layer, single-sampled texture. Never destroyed by the knob. */
  texture: GPUTexture;
  /** Rebind the material or view to this texture. Must complete synchronously; no default. */
  bind(texture: GPUTexture): void;
}

function textureLadder(
  options: TextureKnobOptions,
  label: string,
  upload?: (texture: GPUTexture) => void,
): TextureKnob {
  const { device, texture: original, bind } = options;
  const { name, weight, values, check } = ladder(options, label);
  if (original.dimension !== '2d' || original.depthOrArrayLayers !== 1 || original.sampleCount !== 1)
    throw rangeError('Invalid knob texture; use a single-layer, single-sampled 2D texture', 'arguments');
  let current = original,
    stopped = false;
  const apply = (level: number) => {
    if (stopped) throw fault('disposed', 'Texture knob disposed; create a new knob', 'disposed');
    check(level);
    const width = Math.max(1, Math.floor(original.width * values[level]));
    const height = Math.max(1, Math.floor(original.height * values[level]));
    if (current.width === width && current.height === height) return;
    const next =
      level === 0
        ? original
        : device.createTexture({
            label: name,
            size: [width, height],
            format: original.format,
            usage: original.usage,
          });
    try {
      if (next !== original) upload?.(next);
      bind(next);
    } catch (error) {
      if (next !== original) next.destroy();
      throw error;
    }
    const previous = current;
    current = next;
    if (previous !== original) previous.destroy();
  };
  const dispose = () => {
    if (stopped) return;
    // A failed bind leaves ownership intact so the caller can correct it and dispose again.
    apply(0);
    stopped = true;
  };
  return {
    name,
    weight,
    levels: values.length,
    apply,
    get texture() {
      return current;
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}

/** Raster source retained by the caller for reversible texture downsampling. */
export interface TextureResolutionOptions extends TextureKnobOptions {
  /** Full-size raster matching texture dimensions, retained until disposal. No default. */
  source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas;
}

/**
 * Resample a raster into a genuinely smaller bound texture on each live level change. Original storage is retained
 * for exact restoration. Reduced textures have one mip; use an ordinary non-comparison filtering sampler.
 * @throws RangeError for an invalid ladder, source size or texture; use matching RGBA8 2D resources with COPY_DST and RENDER_ATTACHMENT usage.
 */
export function textureResolutionKnob(options: TextureResolutionOptions): TextureKnob {
  const { source, texture, device } = options;
  if (
    source.width !== texture.width ||
    source.height !== texture.height ||
    !['rgba8unorm', 'rgba8unorm-srgb'].includes(texture.format) ||
    (texture.usage & 18) !== 18
  )
    throw rangeError(
      'Invalid raster texture; use matching RGBA8 dimensions and COPY_DST and RENDER_ATTACHMENT usage',
      'arguments',
    );
  return textureLadder(options, 'texture resolution', (next) => {
    const canvas = new OffscreenCanvas(next.width, next.height);
    const context = canvas.getContext('2d')!;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, next.width, next.height);
    device.queue.copyExternalImageToTexture({ source: canvas }, { texture: next }, [next.width, next.height]);
  });
}

/**
 * Resize a live colour render target; bind updates the view's target and any dependent resources together. Omitting
 * view depth lets the engine manage matching depth. Contents are redrawn, never copied. Original is caller-owned.
 * @throws RangeError for an invalid ladder/target; use a single-layer 2D colour texture with RENDER_ATTACHMENT usage.
 */
export function renderTargetKnob(options: TextureKnobOptions): TextureKnob {
  if (
    !(options.texture.usage & 16) ||
    options.texture.format.startsWith('depth') ||
    options.texture.format === 'stencil8'
  )
    throw rangeError('Invalid colour target; use a colour texture with RENDER_ATTACHMENT usage', 'arguments');
  return textureLadder(options, 'render target size');
}

/** Live particle birth-rate target; accepts VFX without importing its package. Capacity remains unchanged. */
export interface ParticleTarget {
  /** Fixed allocation capacity; determines the default birth rate. */
  readonly capacity: number;
  /** VFX reads rate each simulation frame. */
  readonly options: { rate?: number };
}

/**
 * Lower particle births, including a final zero-emission level; existing particles finish their lives. Does not
 * reduce capacity, suppress bursts or disable simulation. Level 0 restores the exact original rate option.
 * @throws RangeError for an invalid rate, capacity or ladder; use finite nonnegative rate and positive integer capacity.
 */
export function particleKnob(target: ParticleTarget, options: KnobOptions = {}): FeatureKnob {
  const { name, weight, values, check } = ladder(options, 'particles');
  const original = target.options.rate,
    full = original ?? target.capacity / 2;
  if (!Number.isInteger(target.capacity) || target.capacity < 1 || !Number.isFinite(full) || full < 0)
    throw rangeError('Invalid particle target; use positive integer capacity and finite nonnegative rate', 'arguments');
  return {
    name,
    weight,
    levels: values.length + 1,
    apply(level) {
      if (level === values.length) target.options.rate = 0;
      else {
        check(level);
        if (level === 0 && original === undefined) delete target.options.rate;
        else target.options.rate = level === 0 ? original : full * values[level];
      }
    },
  };
}

/** Deferred hardware MSAA choice. Deliberately separate from live FeatureKnob to avoid measuring imaginary savings. */
export interface MSAAKnob {
  /** Requested sample count, default 4. Applying a level only updates this value. */
  readonly samples: 1 | 4;
  /** Two levels: 0 requests 4, 1 requests 1. */
  readonly levels: 2;
  /** Record a choice without changing any engine, global tier, attachment or pipeline. */
  apply(level: number): void;
  /**
   * Apply the public quality tier before the next Engine.create, with no live engines. Returns effective samples:
   * phones stay at 1; exactSize also forces 1 at engine creation. This page-wide tier persists for device restore.
   * Rebuild the scene and plugins after disposing/recreating an existing engine. No live hardware change.
   */
  prepare(options?: Omit<QualityOptions, 'search'>): 1 | 4;
}

/**
 * Record MSAA for the next engine creation through the existing public quality-tier API. No core mutation.
 * @throws RangeError for any level other than 0 or 1; choose one of the two supported sample counts.
 */
export function msaaKnob(): MSAAKnob {
  let samples: 1 | 4 = 4;
  return {
    levels: 2,
    get samples() {
      return samples;
    },
    apply(level) {
      if (level !== 0 && level !== 1)
        throw rangeError('Invalid MSAA level; choose 0 (4 samples) or 1 (1 sample)', 'arguments');
      samples = level ? 1 : 4;
    },
    prepare(options = {}) {
      applyQualityTier({ ...options, search: `?quality=${samples === 4 ? 'high' : 'low'}` });
      return sceneSamples();
    },
  };
}
