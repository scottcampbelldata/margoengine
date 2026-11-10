import { rangeError } from '../../shared/errors.js';
import { maskPixels, type SpriteMask } from './index.js';
import { packSprites, sortSprites, type Sprite, type SpriteCamera } from './sprite.js';

/** Atlas dimensions, optionally with straight-alpha RGBA8 bytes for pixel picking. */
export interface PickAtlas {
  width: number;
  height: number;
  data?: Uint8Array | Uint8ClampedArray;
}
/** Matches SpriteLayer's camera, pixel snapping, sorting, atlas pages and mask. */
export interface SpritePickOptions {
  atlas: PickAtlas | readonly PickAtlas[];
  /** Default {x:0,y:0,zoom:1}. Pointer coordinates are target pixels, not CSS pixels. */
  camera?: SpriteCamera;
  /** Default true, as on SpriteLayer. */
  snap?: boolean;
  /** Default false, as on SpriteLayer. */
  ySort?: boolean;
  mask?: SpriteMask;
  /** Pixel uses source alpha and sprite opacity; box ignores source alpha. Default pixel. */
  mode?: 'pixel' | 'box';
  /** Minimum combined alpha in byte units, 0 to 255. Zero alpha never picks. Default 1. */
  alphaThreshold?: number;
}
/** The top matching image, its source texel and local coordinates before texture flips. */
export interface SpriteHit {
  sprite: Sprite;
  texelX: number;
  texelY: number;
  localX: number;
  localY: number;
  /** Combined source/sprite alpha, 0 to 1 (sprite alpha alone in box mode). */
  alpha: number;
}

/**
 * Picks the last drawn sprite under a target-pixel point without GPU readback or mutating the list.
 * Pixel tests use original atlas alpha, matching nearest rendering, before custom fragment effects.
 * @throws RangeError for invalid points, atlases, threshold, camera, sprite or missing pixel data.
 */
export function pickSprite(
  sprites: readonly Sprite[],
  x: number,
  y: number,
  options: SpritePickOptions,
): SpriteHit | undefined {
  const camera = options.camera ?? { x: 0, y: 0, zoom: 1 },
    threshold = options.alphaThreshold ?? 1,
    mode = options.mode ?? 'pixel';
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 255 ||
    !['pixel', 'box'].includes(mode)
  )
    throw rangeError('Invalid sprite pointer, mode or alpha threshold', 'sprite-options');
  const pages: readonly PickAtlas[] = Array.isArray(options.atlas) ? options.atlas : [options.atlas as PickAtlas];
  if (
    !pages.length ||
    pages.some(
      (a) =>
        !a ||
        !Number.isInteger(a.width) ||
        !Number.isInteger(a.height) ||
        a.width < 1 ||
        a.height < 1 ||
        (a.data &&
          (!(a.data instanceof Uint8Array || a.data instanceof Uint8ClampedArray) ||
            a.data.length !== a.width * a.height * 4)),
    )
  )
    throw rangeError('Invalid picking atlas dimensions or RGBA8 bytes', 'sprite-options');
  if (pages.some((a) => a.width !== pages[0].width || a.height !== pages[0].height))
    throw rangeError('Picking atlas pages must have matching dimensions', 'sprite-options');
  if (!Number.isFinite(camera.x) || !Number.isFinite(camera.y) || !Number.isFinite(camera.zoom) || camera.zoom <= 0)
    throw rangeError('Invalid sprite camera', 'sprite-options');
  const mask = new Float32Array(maskPixels(options.mask, camera));
  if (mask[0]) {
    const inside =
      mask[0] === 1
        ? x >= mask[4] && y >= mask[5] && x < mask[6] && y < mask[7]
        : (x - mask[4]) ** 2 + (y - mask[5]) ** 2 <= mask[6] ** 2;
    if (inside === mask[1] > 0) return undefined;
  }
  const ordered = [...sprites],
    data = new Float32Array(12);
  sortSprites(ordered, options.ySort);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const s = ordered[i];
    if (!s.visible) continue;
    const atlas = pages[s.page];
    if (!Number.isInteger(s.page) || !atlas) throw rangeError('Invalid sprite picking atlas page', 'sprite-options');
    packSprites([s], data, camera, atlas.width, atlas.height, options.snap ?? true);
    const opacity = Math.round(s.alpha * 255);
    if (opacity === 0 || opacity < threshold) continue;
    if (data[2] === 0 || data[3] === 0) continue;
    const dx = x - data[0],
      dy = y - data[1],
      cos = Math.cos(data[6]),
      sin = Math.sin(data[6]),
      u = (dx * cos + dy * sin) / data[2] + data[4],
      v = (-dx * sin + dy * cos) / data[3] + data[5];
    if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
    const rx = Math.min(data[8], data[8] + data[10]),
      ry = Math.min(data[9], data[9] + data[11]),
      texelX = Math.max(rx, Math.min(rx + Math.abs(data[10]) - 1, Math.floor(data[8] + data[10] * u))),
      texelY = Math.max(ry, Math.min(ry + Math.abs(data[11]) - 1, Math.floor(data[9] + data[11] * v)));
    if (mode === 'pixel' && !atlas.data)
      throw rangeError(
        'Pixel picking needs original atlas RGBA8 bytes; supply data or select box mode',
        'sprite-options',
      );
    const source = mode === 'pixel' ? atlas.data![(texelY * atlas.width + texelX) * 4 + 3] : 255,
      alpha = (source * opacity) / 255;
    if (alpha <= 0 || alpha < threshold) continue;
    return {
      sprite: s,
      texelX,
      texelY,
      localX: u * Math.abs(data[10]),
      localY: v * Math.abs(data[11]),
      alpha: alpha / 255,
    };
  }
  return undefined;
}
