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
  /** Fogged by the plugin's fog (`PointsPlugin.setFog`); false keeps this material clear. Default true. */
  fog?: boolean;
  /**
   * Up to 6 world-space planes `[a, b, c, d]`: fragments at points with `a x + b y + c z + d < 0` are cut away (the
   * `@margoengine/materials` convention). Live; default none.
   */
  clippingPlanes?: readonly (readonly number[])[];
}

const checkUnit = (value: number, label: string) => {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw new RangeError(`${label} must be in [0, 1]`);
};

/** Validates up to 6 planes `[a, b, c, d]` and returns them flat with unit normals. */
function clipPlanes(planes: readonly (readonly number[])[]): number[] {
  if (!Array.isArray(planes))
    throw new TypeError('Points material clippingPlanes must be an array of [a, b, c, d] planes');
  if (planes.length > 6) throw new RangeError('Points material clippingPlanes holds at most 6 planes; pass fewer');
  const flat: number[] = [];
  for (const p of planes) {
    if (
      !Array.isArray(p) ||
      p.length !== 4 ||
      !p.every((x) => typeof x === 'number' && Number.isFinite(Math.fround(x)))
    )
      throw new TypeError('Points material clipping plane must be four finite numbers [a, b, c, d]');
    const length = Math.hypot(p[0], p[1], p[2]);
    if (!length) throw new TypeError('Points material clipping plane needs a non-zero normal [a, b, c]');
    flat.push(p[0] / length, p[1] / length, p[2] / length, p[3] / length);
  }
  return flat;
}

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
  fog = true;
  /** Bumped when `map` changes or `needsUpdate()` is called; the plugin re-uploads image sources. */
  mapVersion = 0;
  private source: PointsTextureSource | null = null;
  /** Clipping planes, four normalised numbers each (at most 24). */
  private clipping: number[] = [];

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

  /**
   * Up to 6 world-space planes `[a, b, c, d]`; fragments at points with `a x + b y + c z + d < 0` are discarded. Points
   * test each fragment's world position on the point's camera-facing disc (on the sphere for `shading: 'sphere'`);
   * world-sized sprites each fragment's position on the quad, pixel-sized sprites their centre. Reading gives
   * normalised copies; assign a new list to change them (live, next frame). Throws TypeError for a malformed plane,
   * RangeError for more than 6.
   */
  get clippingPlanes(): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < this.clipping.length; i += 4) out.push(this.clipping.slice(i, i + 4));
    return out;
  }
  set clippingPlanes(planes: readonly (readonly number[])[]) {
    this.clipping = clipPlanes(planes);
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
    if (options.fog !== undefined) this.fog = options.fog;
    if (options.clippingPlanes !== undefined) this.clippingPlanes = options.clippingPlanes;
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
      typeof this.fog !== 'boolean' ||
      (this.depthWrite !== null && typeof this.depthWrite !== 'boolean')
    )
      throw new TypeError('transparent, depthTest, depthWrite and fog must be booleans');
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
  /** Alias: true is `sizeUnits: 'world'`, false is 'pixels'. */
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

/** Point cloud material. Read every frame; change fields freely. */
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
  /** Alias: false is `sizeUnits: 'pixels'`. */
  sizeAttenuation?: boolean;
}

/** Sprite material. Transparent by default. */
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
