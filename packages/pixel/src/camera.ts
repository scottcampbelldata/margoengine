import { rangeError } from '../../shared/errors.js';

/** How fast a layer scrolls against the camera: one factor for both axes, or `[x, y]`. 1 moves with the camera, 0 stays put. */
export type Parallax = number | readonly [number, number];

/** Settings of {@link PixelCamera}, fixed when it is created except where a member says otherwise. */
export interface PixelCameraOptions {
  /** Low-res width in pixels, a whole number from 1. Required. */
  width: number;
  /** Low-res height in pixels, a whole number from 1. Required. */
  height: number;
  /** World position at the top-left of the view, y down. Default 0. */
  x?: number;
  /** World position at the top-left of the view, y down. Default 0. */
  y?: number;
  /** Output pixels per low-res pixel, a whole number. Default: the largest that fits the canvas, every frame. */
  zoom?: number;
  /** Smallest zoom, a whole number from 1. Default 1. */
  minZoom?: number;
  /** Largest zoom, a whole number. Default 64. */
  maxZoom?: number;
  /** World units in one low-res pixel, above 0. Default 1. */
  unitsPerPixel?: number;
  /**
   * Carries the part of the scroll below one low-res pixel into the composite, in whole output pixels. Default false:
   * the picture moves only when the scroll reaches a whole low-res pixel.
   */
  smooth?: boolean;
}

/** A scroll split into whole low-res pixels and what is left over, from 0 up to 1. */
export interface LayerScroll {
  x: number;
  y: number;
  subX: number;
  subY: number;
}

/** Orthographic bounds for `CameraProjection` of `@margoengine/cameras`. */
export interface PixelProjection {
  mode: 'orthographic';
  left: number;
  right: number;
  top: number;
  bottom: number;
  zoom: number;
}

/** Scroll this close below a whole pixel counts as that pixel: ten steps of 0.1 add up to 0.9999999999999999. */
const WHOLE = 1e-6;
const factor = (parallax: Parallax, axis: 0 | 1): number => {
  const value = typeof parallax === 'number' ? parallax : parallax[axis];
  if (!Number.isFinite(value)) throw rangeError('Invalid parallax', 'pixel-options');
  return value;
};
const whole = (value: number, subject: string, least: number): number => {
  if (!Number.isInteger(value) || value < least) throw rangeError(`Invalid ${subject}`, 'pixel-options');
  return value;
};

/**
 * The view of a pixel-art world: a low-res size, a position in world units, a whole-number zoom and parallax for each
 * layer. Scrolling goes by whole low-res pixels, so nothing shimmers. Runs without a GPU.
 * @throws RangeError when a size or zoom is not a whole number in range, or a position or parallax is not finite.
 */
export class PixelCamera {
  /** World position at the top-left of the view, y down, read each frame. */
  x: number;
  /** World position at the top-left of the view, y down, read each frame. */
  y: number;
  /** While true the compositor sets the zoom to the largest that fits, every frame. Setting {@link zoom} turns it off. */
  autoFit: boolean;
  readonly width: number;
  readonly height: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly unitsPerPixel: number;
  readonly smooth: boolean;
  private current: number;

  constructor(options: PixelCameraOptions) {
    this.width = whole(options?.width, 'pixel camera width', 1);
    this.height = whole(options?.height, 'pixel camera height', 1);
    this.minZoom = whole(options.minZoom ?? 1, 'pixel camera minZoom', 1);
    this.maxZoom = whole(options.maxZoom ?? 64, 'pixel camera maxZoom', this.minZoom);
    const units = options.unitsPerPixel ?? 1;
    if (!(units > 0) || units === Infinity) throw rangeError('Invalid unitsPerPixel', 'pixel-options');
    this.unitsPerPixel = units;
    this.smooth = options.smooth ?? false;
    this.x = options.x ?? 0;
    this.y = options.y ?? 0;
    this.current = this.minZoom;
    this.autoFit = options.zoom === undefined;
    if (options.zoom !== undefined) this.zoom = options.zoom;
  }
  /** Output pixels per low-res pixel. Whole numbers only: anything else throws, as a blurred scale has no place here. */
  get zoom(): number {
    return this.current;
  }
  set zoom(value: number) {
    if (!Number.isInteger(value) || value < this.minZoom || value > this.maxZoom)
      throw rangeError('Invalid pixel camera zoom', 'pixel-options');
    this.current = value;
    this.autoFit = false;
  }
  /** Sets the zoom to the largest whole number that fits `width` x `height` output pixels, inside the bounds, and returns it. */
  fit(width: number, height: number): number {
    if (!(width > 0) || !(height > 0)) throw rangeError('Invalid fit size', 'pixel-options');
    const most = Math.floor(Math.min(width / this.width, height / this.height));
    this.current = Math.min(this.maxZoom, Math.max(this.minZoom, most));
    return this.current;
  }
  /** Whole low-res pixels scrolled along x at this parallax. */
  pixelX(parallax: Parallax = 1): number {
    return Math.floor(this.exactX(parallax) + WHOLE);
  }
  /** Whole low-res pixels scrolled along y at this parallax. */
  pixelY(parallax: Parallax = 1): number {
    return Math.floor(this.exactY(parallax) + WHOLE);
  }
  /** The scroll at this parallax, split into whole low-res pixels and the rest. Fills and returns `out` when given. */
  scroll(parallax: Parallax = 1, out: LayerScroll = { x: 0, y: 0, subX: 0, subY: 0 }): LayerScroll {
    out.x = this.pixelX(parallax);
    out.y = this.pixelY(parallax);
    out.subX = Math.max(0, this.exactX(parallax) - out.x);
    out.subY = Math.max(0, this.exactY(parallax) - out.y);
    return out;
  }
  /**
   * Orthographic bounds that show this view through a core camera looking down -z with +y up: world `(x, -y)` is the
   * low-res pixel `(x, y)`. `new CameraProjection(camera.projection())`, or `Object.assign` them each frame to scroll.
   */
  projection(parallax: Parallax = 1): PixelProjection {
    const units = this.unitsPerPixel,
      left = this.pixelX(parallax) * units,
      top = -this.pixelY(parallax) * units;
    return {
      mode: 'orthographic',
      left,
      right: left + this.width * units,
      top,
      bottom: top - this.height * units,
      zoom: 1,
    };
  }
  private exactX(parallax: Parallax): number {
    if (!Number.isFinite(this.x)) throw rangeError('Invalid pixel camera position', 'pixel-options');
    return (this.x / this.unitsPerPixel) * factor(parallax, 0);
  }
  private exactY(parallax: Parallax): number {
    if (!Number.isFinite(this.y)) throw rangeError('Invalid pixel camera position', 'pixel-options');
    return (this.y / this.unitsPerPixel) * factor(parallax, 1);
  }
}
