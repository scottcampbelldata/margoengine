// The CPU side of a layer, with no GPU or DOM: the Sprite, draw order and the 12 floats each sprite sends to the shader.
import { rangeError, typeError } from '../../shared/errors.js';

/** Floats per sprite in the instance buffer (48 bytes). See {@link packSprites} for the layout. */
export const SPRITE_FLOATS = 12;

/** What a layer looks through: world units to target pixels, y down, with (`x`, `y`) at the top-left of the target. */
export interface SpriteCamera {
  /** World x at the left edge of the target. */
  x: number;
  /** World y at the top edge of the target. */
  y: number;
  /** Target pixels per world unit, above 0. */
  zoom: number;
}

/** Every setting of a {@link Sprite}; each is optional and has the default the field states. */
export interface SpriteOptions {
  x?: number;
  y?: number;
  z?: number;
  pivotX?: number;
  pivotY?: number;
  scaleX?: number;
  scaleY?: number;
  flipX?: boolean;
  flipY?: boolean;
  rotation?: number;
  tint?: number | string;
  alpha?: number;
  rect?: readonly [number, number, number, number];
  visible?: boolean;
  params?: readonly [number, number, number, number];
}

/** @internal Parses `0xrrggbb`, `'#rrggbb'` or `'#rgb'` to `0xrrggbb`. Bytes are written as given, with no colour conversion. */
export function parseTint(tint: number | string): number {
  if (typeof tint === 'string') {
    const short = /^#[\da-f]{3}$/i.test(tint);
    if (!short && !/^#[\da-f]{6}$/i.test(tint)) throw typeError('Invalid sprite tint', 'sprite-options');
    return Number.parseInt(short ? tint.replace(/[\da-f]/gi, '$&$&').slice(1) : tint.slice(1), 16);
  }
  if (!Number.isInteger(tint) || tint < 0 || tint > 0xffffff) throw rangeError('Invalid sprite tint', 'sprite-options');
  return tint;
}

/**
 * One image in a {@link SpriteLayer}. Change any field at any time: the layer reads them each frame and uploads only the
 * bytes that changed.
 */
export class Sprite implements SpriteOptions {
  /** World x of the pivot. Default 0. */
  x = 0;
  /** World y of the pivot, y down. Default 0. */
  y = 0;
  /** Draw order: a higher z draws over a lower one. Default 0. */
  z = 0;
  /** Where the pivot sits across the image, 0 left to 1 right. Default 0. */
  pivotX = 0;
  /** Where the pivot sits down the image, 0 top to 1 bottom. Default 0. */
  pivotY = 0;
  /** Horizontal scale; negative mirrors about the pivot. Default 1. */
  scaleX = 1;
  /** Vertical scale; negative mirrors about the pivot. Default 1. */
  scaleY = 1;
  /** Mirrors the image left to right inside its rectangle. Default false. */
  flipX = false;
  /** Mirrors the image top to bottom inside its rectangle. Default false. */
  flipY = false;
  /** Clockwise turn about the pivot, in radians. Default 0. */
  rotation = 0;
  /** Opacity, 0 to 1, multiplied with the atlas alpha. Default 1. */
  alpha = 1;
  /** Atlas rectangle `[x, y, width, height]` in whole texels. Default the whole atlas. */
  rect?: readonly [number, number, number, number];
  /** False leaves the sprite out of the draw. Default true. */
  visible = true;
  /** Four numbers a layer's `shader` reads as `sprite.params`, such as an effect's amount. Default zeros. */
  params?: readonly [number, number, number, number];
  /** @internal Add order, the last sort key. */
  index = 0;
  /** @internal The layer that holds this sprite. */
  owner?: object;
  private color = 0xffffff;

  constructor(options: SpriteOptions = {}) {
    Object.assign(this, options);
  }
  /** Colour multiplied with the atlas: set `0xrrggbb`, `'#rrggbb'` or `'#rgb'`, read `0xrrggbb`. Default white. */
  get tint(): number {
    return this.color;
  }
  set tint(value: number | string) {
    this.color = parseTint(value);
  }
}

/**
 * Puts `sprites` in draw order in place: by `z`, then by `y` when `ySort` is set, then by the order they were added. A
 * list already in order is only scanned, so a still scene does no sorting.
 */
export function sortSprites(sprites: Sprite[], ySort = false): void {
  const before = ySort ? byZY : byZ;
  for (let i = 1; i < sprites.length; i++)
    if (before(sprites[i - 1], sprites[i]) > 0) {
      sprites.sort(before);
      return;
    }
}
const byZ = (a: Sprite, b: Sprite) => a.z - b.z || a.index - b.index;
const byZY = (a: Sprite, b: Sprite) => a.z - b.z || a.y - b.y || a.index - b.index;

/**
 * The pixel the corner of an image lands on, as a float: `pixel` is the pivot's place in target pixels and `offset` the
 * distance from the image's corner to its pivot. Snapping rounds the corner, so an image with a half-pixel pivot still
 * covers whole pixels, and returns the pivot's place again.
 */
export const snapToPixel = (pixel: number, offset: number): number => Math.round(pixel - offset) + offset;

const none = [0, 0, 0, 0] as const;

/** The range of floats a {@link packSprites} call changed, and how many sprites it wrote. */
export interface PackedSprites {
  /** Visible sprites written. */
  count: number;
  /** First float that changed; equal to `end` when nothing did. */
  start: number;
  /** One past the last float that changed. */
  end: number;
}

/**
 * Writes the visible `sprites`, in their current order, into `data` (at least `sprites.length * SPRITE_FLOATS` long) and
 * reports which floats changed. Per sprite: pivot in target pixels (0, 1), signed size in target pixels (2, 3), pivot
 * fractions (4, 5), rotation in radians (6), tint as RGBA8 with red in the low byte (7), atlas origin (8, 9) and signed
 * atlas size in texels (10, 11); a flip moves the origin to the far edge and negates the size. A `stride` of 16 adds the
 * sprite's `params` (12 to 15), for layers with a shader.
 * @throws RangeError for a non-finite value, a rectangle outside the atlas or one that is not whole texels.
 */
export function packSprites(
  sprites: readonly Sprite[],
  data: Float32Array,
  camera: SpriteCamera,
  atlasWidth: number,
  atlasHeight: number,
  snap = true,
  stride = SPRITE_FLOATS,
): PackedSprites {
  const bits = new Uint32Array(data.buffer, data.byteOffset, data.length),
    { x: cameraX, y: cameraY, zoom } = camera;
  if (!(zoom > 0) || !Number.isFinite(zoom + cameraX + cameraY))
    throw rangeError('Invalid sprite camera', 'sprite-options');
  let at = 0,
    start = -1,
    end = 0;
  const put = (value: number) => {
    if (data[at] !== value) {
      data[at] = value;
      if (start < 0) start = at;
      end = at + 1;
    }
    at++;
  };
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i];
    if (!s.visible) continue;
    const rectX = s.rect ? s.rect[0] : 0,
      rectY = s.rect ? s.rect[1] : 0,
      rectW = s.rect ? s.rect[2] : atlasWidth,
      rectH = s.rect ? s.rect[3] : atlasHeight,
      width = rectW * s.scaleX * zoom,
      height = rectH * s.scaleY * zoom,
      pixelX = (s.x - cameraX) * zoom,
      pixelY = (s.y - cameraY) * zoom;
    if (
      !Number.isFinite(pixelX + pixelY + width + height + s.pivotX + s.pivotY + s.rotation + s.alpha + s.z) ||
      s.alpha < 0 ||
      s.alpha > 1
    )
      throw rangeError('Invalid sprite', 'sprite-options');
    if (
      !Number.isInteger(rectX) ||
      !Number.isInteger(rectY) ||
      !Number.isInteger(rectW) ||
      !Number.isInteger(rectH) ||
      rectX < 0 ||
      rectY < 0 ||
      rectW < 1 ||
      rectH < 1 ||
      rectX + rectW > atlasWidth ||
      rectY + rectH > atlasHeight
    )
      throw rangeError('Invalid sprite rect', 'sprite-options');
    const offsetX = s.pivotX * width,
      offsetY = s.pivotY * height;
    put(snap ? snapToPixel(pixelX, offsetX) : pixelX);
    put(snap ? snapToPixel(pixelY, offsetY) : pixelY);
    put(width);
    put(height);
    put(s.pivotX);
    put(s.pivotY);
    put(s.rotation);
    const tint = s.tint,
      packed = ((tint >> 16) | (tint & 0xff00) | ((tint & 0xff) << 16) | (Math.round(s.alpha * 255) << 24)) >>> 0;
    if (bits[at] !== packed) {
      bits[at] = packed;
      if (start < 0) start = at;
      end = at + 1;
    }
    at++;
    put(s.flipX ? rectX + rectW : rectX);
    put(s.flipY ? rectY + rectH : rectY);
    put(s.flipX ? -rectW : rectW);
    put(s.flipY ? -rectH : rectH);
    if (stride > SPRITE_FLOATS) {
      const p = s.params ?? none;
      if (p.length !== 4 || !Number.isFinite(p[0] + p[1] + p[2] + p[3]))
        throw rangeError('Invalid sprite params', 'sprite-options');
      for (let k = 0; k < 4; k++) put(p[k]);
    }
  }
  return { count: at / stride, start: start < 0 ? end : start, end };
}
