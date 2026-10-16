import { parseColor, type ColorInput } from './color.js';

/**
 * Anything the plugin can sample: a GPUTexture you own (created on the engine's device), or an image source it
 * uploads itself with `copyExternalImageToTexture` (ImageBitmap, canvas, OffscreenCanvas, image, video, ImageData).
 */
export type PointsTextureSource =
  | GPUTexture
  | ImageBitmap
  | HTMLCanvasElement
  | OffscreenCanvas
  | HTMLImageElement
  | HTMLVideoElement
  | ImageData;

/** Blend mode: 'normal' is alpha over, 'additive' adds color to the target. */
export type PointsBlending = 'normal' | 'additive';

/**
 * Options shared by `PointsMaterialOptions` and `SpriteMaterialOptions`. Validated on set and every frame:
 * opacity or alphaTest outside 0..1, an unknown filter or blending, or a negative color throw a RangeError;
 * non-boolean flags a TypeError.
 */
export interface BaseMaterialOptions {
  /** Base color. '#rrggbb', '#rgb' or 0xrrggbb are sRGB; an [r, g, b] array is linear RGB. Default white. */
  color?: ColorInput;
  /** Multiplies alpha. Default 1. */
  opacity?: number;
  /** Texture multiplied into the color. Image sources are uploaded as sRGB (`rgba8unorm-srgb`). Default null. */
  map?: PointsTextureSource | null;
  /** Texture filtering. Default 'linear'. */
  mapFilter?: 'linear' | 'nearest';
  /** Fragments whose alpha (before edge antialiasing) is below this are discarded. Default 0. */
  alphaTest?: number;
  /** Blend without writing depth. Default false for points, true for sprites. */
  transparent?: boolean;
  /** 'normal' (alpha over) or 'additive'. Default 'normal'. */
  blending?: PointsBlending;
  /** Test against the scene depth with reversed-Z `greater-equal`. Default true. */
  depthTest?: boolean;
  /** Write depth. Default `!transparent`. */
  depthWrite?: boolean;
}

const checkUnit = (value: number, label: string) => {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw new RangeError(`${label} must be in [0, 1]`);
};

abstract class BaseMaterial {
  /** Linear RGB. */
  readonly color = new Float32Array([1, 1, 1]);
  opacity = 1;
  mapFilter: 'linear' | 'nearest' = 'linear';
  alphaTest = 0;
  transparent: boolean;
  blending: PointsBlending = 'normal';
  depthTest = true;
  /** null means `!transparent`. */
  depthWrite: boolean | null = null;
  /** Bumped when `map` changes or `needsUpdate()` is called; the plugin re-uploads image sources. */
  mapVersion = 0;
  private source: PointsTextureSource | null = null;

  protected constructor(transparent: boolean) {
    this.transparent = transparent;
  }

  get map(): PointsTextureSource | null {
    return this.source;
  }
  set map(value: PointsTextureSource | null) {
    if (value !== null && typeof value !== 'object') throw new TypeError('map must be a texture source or null');
    if (value !== this.source) {
      this.source = value;
      this.mapVersion++;
    }
  }

  /** Re-uploads an image source whose pixels changed (for example a canvas you drew into). */
  needsUpdate(): void {
    this.mapVersion++;
  }

  setColor(color: ColorInput): this {
    parseColor(color, this.color);
    return this;
  }

  /** Depth writes after resolving the `null` default. */
  get writesDepth(): boolean {
    return this.depthWrite ?? !this.transparent;
  }

  protected apply(options: BaseMaterialOptions): void {
    if (options.color !== undefined) this.setColor(options.color);
    if (options.opacity !== undefined) this.opacity = options.opacity;
    if (options.map !== undefined) this.map = options.map;
    if (options.mapFilter !== undefined) this.mapFilter = options.mapFilter;
    if (options.alphaTest !== undefined) this.alphaTest = options.alphaTest;
    if (options.transparent !== undefined) this.transparent = options.transparent;
    if (options.blending !== undefined) this.blending = options.blending;
    if (options.depthTest !== undefined) this.depthTest = options.depthTest;
    if (options.depthWrite !== undefined) this.depthWrite = options.depthWrite;
  }

  validate(): void {
    checkUnit(this.opacity, 'opacity');
    checkUnit(this.alphaTest, 'alphaTest');
    if (!['linear', 'nearest'].includes(this.mapFilter))
      throw new RangeError("mapFilter must be 'linear' or 'nearest'");
    if (!['normal', 'additive'].includes(this.blending))
      throw new RangeError("blending must be 'normal' or 'additive'");
    if (
      typeof this.transparent !== 'boolean' ||
      typeof this.depthTest !== 'boolean' ||
      (this.depthWrite !== null && typeof this.depthWrite !== 'boolean')
    )
      throw new TypeError('transparent, depthTest and depthWrite must be booleans');
    for (const v of this.color)
      if (!Number.isFinite(v) || v < 0) throw new RangeError('color must be finite and non-negative');
  }
}

/** Point footprint: 'square', or 'round' (an antialiased disc). */
export type PointShape = 'square' | 'round';
/** 'flat' fills the footprint with one color; 'sphere' shades a lit sphere impostor with curved depth. */
export type PointShading = 'flat' | 'sphere';

/**
 * Options for `PointsMaterial`. Besides the base checks, a negative or non-finite size, min above max pixel
 * size, or an unknown sizeUnits, shape or shading throw a RangeError.
 */
export interface PointsMaterialOptions extends BaseMaterialOptions {
  /** Point diameter: pixels, or world units when `sizeUnits` is 'world'. Per-point sizes multiply it. Default 4. */
  size?: number;
  /** 'pixels' keeps a constant screen size; 'world' attenuates with distance. Default 'pixels'. */
  sizeUnits?: 'pixels' | 'world';
  /** Three.js alias: true is `sizeUnits: 'world'`, false is 'pixels'. */
  sizeAttenuation?: boolean;
  /** Clamp of the final diameter in pixels. Defaults 1 and 256. */
  minPixelSize?: number;
  /** Upper clamp of the final diameter in pixels; must be at least `minPixelSize`. Default 256. */
  maxPixelSize?: number;
  /** 'square', or 'round' (an antialiased disc). Default 'square'. A `map` is sampled across either shape. */
  shape?: PointShape;
  /** Use per-point colors when the cloud has them. Default true. */
  vertexColors?: boolean;
  /** 'sphere' shades each point as a lit sphere impostor and writes its curved depth (implies a round shape). Default 'flat'. */
  shading?: PointShading;
  /** Eye-dome lighting: darkens depth discontinuities between points in a screen-space pass. Default false. */
  edl?: boolean;
}

/** Point cloud material, the counterpart of Three.js `PointsMaterial`. Read every frame; change fields freely. */
export class PointsMaterial extends BaseMaterial {
  size = 4;
  sizeUnits: 'pixels' | 'world' = 'pixels';
  minPixelSize = 1;
  maxPixelSize = 256;
  shape: PointShape = 'square';
  vertexColors = true;
  shading: PointShading = 'flat';
  edl = false;

  constructor(options: PointsMaterialOptions = {}) {
    super(false);
    this.set(options);
  }

  get sizeAttenuation(): boolean {
    return this.sizeUnits === 'world';
  }
  set sizeAttenuation(value: boolean) {
    this.sizeUnits = value ? 'world' : 'pixels';
  }

  set(options: PointsMaterialOptions): this {
    this.apply(options);
    if (options.size !== undefined) this.size = options.size;
    if (options.sizeAttenuation !== undefined) this.sizeAttenuation = options.sizeAttenuation;
    if (options.sizeUnits !== undefined) this.sizeUnits = options.sizeUnits;
    if (options.minPixelSize !== undefined) this.minPixelSize = options.minPixelSize;
    if (options.maxPixelSize !== undefined) this.maxPixelSize = options.maxPixelSize;
    if (options.shape !== undefined) this.shape = options.shape;
    if (options.vertexColors !== undefined) this.vertexColors = options.vertexColors;
    if (options.shading !== undefined) this.shading = options.shading;
    if (options.edl !== undefined) this.edl = options.edl;
    this.validate();
    return this;
  }

  override validate(): void {
    super.validate();
    if (!(this.size >= 0) || !Number.isFinite(this.size)) throw new RangeError('size must be finite and non-negative');
    if (!(this.minPixelSize >= 0) || !(this.maxPixelSize >= this.minPixelSize) || !Number.isFinite(this.maxPixelSize))
      throw new RangeError('Need 0 <= minPixelSize <= maxPixelSize');
    if (!['pixels', 'world'].includes(this.sizeUnits)) throw new RangeError("sizeUnits must be 'pixels' or 'world'");
    if (!['square', 'round'].includes(this.shape)) throw new RangeError("shape must be 'square' or 'round'");
    if (!['flat', 'sphere'].includes(this.shading)) throw new RangeError("shading must be 'flat' or 'sphere'");
    if (typeof this.vertexColors !== 'boolean' || typeof this.edl !== 'boolean')
      throw new TypeError('vertexColors and edl must be booleans');
  }
}

/** Options for `SpriteMaterial`. A non-finite rotation or unknown sizeUnits throws a RangeError. */
export interface SpriteMaterialOptions extends BaseMaterialOptions {
  /** Added to every sprite's own rotation, radians counterclockwise. Default 0. */
  rotation?: number;
  /** 'world' sizes attenuate with distance; 'pixels' keeps a constant screen size. Default 'world'. */
  sizeUnits?: 'world' | 'pixels';
  /** Three.js alias: false is `sizeUnits: 'pixels'`. */
  sizeAttenuation?: boolean;
}

/** Sprite material, the counterpart of Three.js `SpriteMaterial`. Transparent by default. */
export class SpriteMaterial extends BaseMaterial {
  rotation = 0;
  sizeUnits: 'world' | 'pixels' = 'world';

  constructor(options: SpriteMaterialOptions = {}) {
    super(true);
    this.set(options);
  }

  get sizeAttenuation(): boolean {
    return this.sizeUnits === 'world';
  }
  set sizeAttenuation(value: boolean) {
    this.sizeUnits = value ? 'world' : 'pixels';
  }

  set(options: SpriteMaterialOptions): this {
    this.apply(options);
    if (options.rotation !== undefined) this.rotation = options.rotation;
    if (options.sizeAttenuation !== undefined) this.sizeAttenuation = options.sizeAttenuation;
    if (options.sizeUnits !== undefined) this.sizeUnits = options.sizeUnits;
    this.validate();
    return this;
  }

  override validate(): void {
    super.validate();
    if (!Number.isFinite(this.rotation)) throw new RangeError('rotation must be finite');
    if (!['pixels', 'world'].includes(this.sizeUnits)) throw new RangeError("sizeUnits must be 'pixels' or 'world'");
  }
}
