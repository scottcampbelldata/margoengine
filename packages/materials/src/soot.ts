// Soot from a fire: a darkening layer for `layered()` or a multiply decal, both from one plume model. Clean room from
// Morton, Taylor and Turner 1956 (a buoyant plume's width grows linearly with height, b' = 6 alpha / 5 with entrainment
// alpha about 0.1, and its centreline concentration falls as (b0 / b)^(5/3) for a plume of starting half-width b0).
import { Texture } from './built-material.js';
import type { MaterialLayer } from './layered.js';

type Vec3 = readonly [number, number, number];
/** The fire that leaves the soot. Metres, Y up. */
export interface SootSource {
  /** World position of the centre of the fire's base. */
  fire: Vec3;
  /** The fire opening (or the flame bed): `width` sets the plume's starting half-width, width / 2. Default 0.6. */
  width?: number;
  /** Darkness where the plume is densest, 0 to 1. Default 0.85. */
  strength?: number;
  /** Plume spread, half-width growth per metre of height, above 0. Default 0.12 (6 x 0.1 / 5, Morton et al. 1956). */
  spread?: number;
  /** How far below the fire's base the floor patch fades out, in metres, above 0. Default 0.1. */
  floorDepth?: number;
}
/** A flat surface in world space: the point at uv (0, 0) and the world vectors to uv (1, 0) and uv (0, 1). */
export interface SootSurface {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
}
/** Options of {@link soot} and {@link sootMask}. */
export interface SootMaskOptions {
  /** Mask texels per side, an integer 4 to 1024. Default 64. */
  size?: number;
}
/** Options of {@link soot}. */
export interface SootLayerOptions extends SootMaskOptions {
  /** Linear colour of the deposit. Default [0.03, 0.028, 0.026], the dark end of deposited carbon. */
  color?: readonly [number, number, number];
  /** Roughness of the deposit, 0 to 1. Default 0.95 (soot is matte). */
  roughness?: number;
}
/** A multiply decal for `@margoengine/post/decals` `Decals.setDecals`, in its own shape so no post import is needed. */
export interface SootDecal {
  position: [number, number, number];
  direction: [number, number, number];
  width: number;
  height: number;
  depth: number;
  up: [number, number, number];
  /** [0, 1, 1, 0]: the atlas's v = 0 row (the soot pattern's fire end) at the decal's bottom edge. */
  rect: [number, number, number, number];
  color: [number, number, number];
  opacity: number;
  mode: 'multiply';
}

interface Plume {
  fire: Vec3;
  b0: number;
  strength: number;
  spread: number;
  floorDepth: number;
}
const finite3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const positive = (v: number) => typeof v === 'number' && Number.isFinite(v) && v > 0;
function plume(source: SootSource): Plume {
  if (!source || typeof source !== 'object')
    throw new TypeError('soot needs a source {fire: [x, y, z]}; pass the fire position');
  if (!finite3(source.fire)) throw new RangeError('soot fire must be three finite numbers; pass [x, y, z] in metres');
  const width = source.width ?? 0.6,
    strength = source.strength ?? 0.85,
    spread = source.spread ?? 0.12,
    floorDepth = source.floorDepth ?? 0.1;
  if (!positive(width)) throw new RangeError('soot width must be above 0; pass the opening width in metres');
  if (!(typeof strength === 'number' && strength >= 0 && strength <= 1))
    throw new RangeError('soot strength must be from 0 to 1; pass a darkness such as 0.85');
  if (!positive(spread)) throw new RangeError('soot spread must be above 0; pass a growth such as 0.12');
  if (!positive(floorDepth)) throw new RangeError('soot floorDepth must be above 0; pass metres such as 0.1');
  return { fire: source.fire, b0: width / 2, strength, spread, floorDepth };
}
function density(p: Plume, x: number, y: number, z: number): number {
  const h = y - p.fire[1],
    r = Math.hypot(x - p.fire[0], z - p.fire[2]);
  if (h < 0) return p.strength * Math.exp(-((r / p.b0) ** 2)) * Math.exp(h / p.floorDepth);
  const b = p.b0 + p.spread * h;
  return p.strength * (p.b0 / b) ** (5 / 3) * Math.exp(-((r / b) ** 2));
}
/** Soot darkness, 0 to 1, at a world point: the plume above the fire's base and a floor patch around and below it. */
export function sootDensity(source: SootSource, point: Vec3): number {
  if (!finite3(point)) throw new RangeError('sootDensity point must be three finite numbers; pass [x, y, z]');
  return density(plume(source), point[0], point[1], point[2]);
}
function checkSurface(s: SootSurface): void {
  if (!s || typeof s !== 'object' || !finite3(s.origin) || !finite3(s.u) || !finite3(s.v))
    throw new RangeError(
      'soot surface needs origin, u and v as three finite numbers each; pass the face in world space',
    );
}
/**
 * The soot darkness over a surface's UVs as a linear, clamped Texture (red = darkness; texel row 0 is v = 0, which is
 * the bottom-left UV origin of materials meshes), for a `layered()` layer's `mask`.
 */
export function sootMask(source: SootSource, surface: SootSurface, options: SootMaskOptions = {}): Texture {
  const p = plume(source);
  checkSurface(surface);
  const size = options.size ?? 64;
  if (!Number.isInteger(size) || size < 4 || size > 1024)
    throw new RangeError('soot size must be an integer from 4 to 1024; pass texels per side such as 64');
  const data = new Uint8Array(size * size * 4),
    { origin: o, u, v } = surface;
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++) {
      const s = (col + 0.5) / size,
        t = (row + 0.5) / size,
        d = density(p, o[0] + s * u[0] + t * v[0], o[1] + s * u[1] + t * v[1], o[2] + s * u[2] + t * v[2]),
        k = (row * size + col) * 4,
        byte = Math.round(Math.min(1, Math.max(0, d)) * 255);
      data[k] = data[k + 1] = data[k + 2] = byte;
      data[k + 3] = 255;
    }
  return new Texture({ data, width: size, height: size }, { colorSpace: 'linear', wrapS: 'clamp', wrapT: 'clamp' });
}
/**
 * A `layered()` layer that darkens a surface where a fire's smoke reaches it: back and side walls, the mantel's
 * underside, the floor around the hearth. It is a material layer, so firelight, shadows and every other light reach the
 * soot as they reach the surface under it.
 */
export function soot(source: SootSource, surface: SootSurface, options: SootLayerOptions = {}): MaterialLayer {
  const color = options.color ?? [0.03, 0.028, 0.026],
    roughness = options.roughness ?? 0.95;
  if (!finite3(color) || !color.every((c) => c >= 0 && c <= 1))
    throw new RangeError('soot color must be three numbers from 0 to 1; pass a linear colour');
  if (!(typeof roughness === 'number' && roughness >= 0 && roughness <= 1))
    throw new RangeError('soot roughness must be from 0 to 1; pass a number such as 0.95');
  return { color: [color[0], color[1], color[2]], roughness, metalness: 0, mask: sootMask(source, surface, options) };
}
/**
 * One multiply decal that covers the plume on a wall `direction` faces into (for example [0, 0, -1] for a wall behind
 * the fire), from the fire's base to `height` metres above it (default 1.5). Its footprint follows the plume's width at
 * the top; give the decals pass an atlas baked with the procedural `soot` pattern (white `secondary`, dark `color`) so
 * the darkness fades as the plume does.
 */
export function sootDecal(
  source: SootSource,
  direction: Vec3,
  options: { height?: number; depth?: number } = {},
): SootDecal {
  const p = plume(source),
    height = options.height ?? 1.5,
    depth = options.depth ?? 1;
  if (!finite3(direction) || Math.hypot(direction[0], direction[2]) === 0 || direction[1] !== 0)
    throw new RangeError('sootDecal direction must be horizontal and not zero; pass the way into the wall');
  if (!positive(height) || !positive(depth))
    throw new RangeError('sootDecal height and depth must be above 0; pass metres');
  const width = 2 * (p.b0 + p.spread * height) * 1.5;
  return {
    position: [p.fire[0], p.fire[1] + height / 2, p.fire[2]],
    direction: [direction[0], 0, direction[2]],
    width,
    height,
    depth,
    up: [0, 1, 0],
    rect: [0, 1, 1, 0],
    color: [1, 1, 1],
    opacity: p.strength,
    mode: 'multiply',
  };
}
