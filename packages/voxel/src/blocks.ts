import type { ColorInput, Vec3 } from '@margoengine/math';
import { parseColor } from '@margoengine/math/color';
import { MargoError } from '@margoengine/math/errors';
import { octants } from './octants.js';

/**
 * Render pass of a block type: `'opaque'` (back-face culled, hides its neighbours' faces), `'cutout'` (alpha
 * tested, e.g. leaves), `'translucent'` (sorted and blended, e.g. glass and water) or `'invisible'` (never drawn, e.g. air).
 */
export type BlockLayer = 'opaque' | 'cutout' | 'translucent' | 'invisible';
/**
 * Geometry of a block type: a full `'cube'`, two diagonal quads (`'cross'`, e.g. grass and flowers), a `'liquid'`, a
 * half-height `'slab'` or a `'stair'`. A slab fills the lower half of its cell, or the upper half when bit 2 of its
 * state data is set ({@link slabState}). A stair is a lower slab plus the upper quarter on its back side: state data
 * bits 0-1 name that side (0 +x, 1 -x, 2 +z, 3 -z) and bit 2 turns it upside down ({@link stairState}). Slabs and
 * stairs are meshed, lit, shadowed, collided and picked as their half-block boxes ({@link shapeOctants}).
 */
export type BlockShape = 'cube' | 'cross' | 'liquid' | 'slab' | 'stair';
/** Side a stair's full-height back faces: `'+x'`, `'-x'`, `'+z'` or `'-z'`. */
export type StairFacing = '+x' | '-x' | '+z' | '-z';

/** Options of {@link BlockTypes.define}. Every field is optional. */
export interface BlockTypeOptions {
  /**
   * Texture layer (0-2047) of every face, or one per face in the order +x, -x, +y, -y, +z, -z (`[side, side, top,
   * bottom, side, side]`). Default 0.
   */
  textures?: number | readonly [number, number, number, number, number, number];
  /** Render pass. Default `'opaque'`. */
  layer?: BlockLayer;
  /** Geometry. Default `'cube'`. */
  shape?: BlockShape;
  /** Collides with bodies and characters. Default true. */
  solid?: boolean;
  /** Characters swim in it and its faces against the same liquid are hidden. Default false. */
  liquid?: boolean;
  /** Block light it emits, 0-15. Default 0. */
  light?: number;
  /** Light it absorbs, 0-15 (15 blocks light). Default 15 for an opaque cube, 0 otherwise. */
  opacity?: number;
  /** Tint multiplied with the texture: `'#rrggbb'`, `0xrrggbb` or linear `[r, g, b]`. Default white. */
  color?: ColorInput;
  /** Perceptual roughness, 0-1. Default 1. */
  roughness?: number;
  /** Metalness, 0-1. Default 0. */
  metalness?: number;
  /** Emitted light as a multiple of the textured colour, >= 0. Default 0. */
  emissive?: number;
  /** Animated texture: `frames` consecutive layers from each face's layer (1-2048), played at `fps` (>= 0). */
  animation?: { frames: number; fps: number };
  /**
   * Texture layers (1-2047) of a tangent-space normal map (glTF convention: +y up the image), a roughness map (red)
   * and an emissive map (red, times `emissive`). 0 or absent: none, the scalar values apply. Default none.
   */
  maps?: { normal?: number; roughness?: number; emissive?: number };
  /**
   * Translucent blocks only: how much of the block's own colour shows through, 0-1. It lowers alpha by up to 85% and
   * mixes in the base colour: a cheap look, not refraction. Default 0.
   */
  transmission?: number;
  /** Translucent blocks only: interior scatter, 0-1; 1 halves the see-through part of `transmission`. Default 0. */
  scatter?: number;
}

/** A defined block type with every option resolved; `color` is linear RGB. Plain, structured-cloneable data. */
export interface BlockType {
  /** Its id: the low 16 bits of a block state. */
  readonly id: number;
  /** Its unique name. */
  readonly name: string;
  /** Texture layer per face, +x, -x, +y, -y, +z, -z. */
  readonly textures: readonly [number, number, number, number, number, number];
  /** Render pass. */
  readonly layer: BlockLayer;
  /** Geometry. */
  readonly shape: BlockShape;
  /** Collides with bodies and characters. */
  readonly solid: boolean;
  /** Characters swim in it. */
  readonly liquid: boolean;
  /** Block light it emits, 0-15. */
  readonly light: number;
  /** Light it absorbs, 0-15. */
  readonly opacity: number;
  /** Linear RGB tint. */
  readonly color: Vec3;
  /** Perceptual roughness, 0-1. */
  readonly roughness: number;
  /** Metalness, 0-1. */
  readonly metalness: number;
  /** Emitted light as a multiple of the textured colour. */
  readonly emissive: number;
  /** Texture animation; `frames` 1 means none. */
  readonly animation: { readonly frames: number; readonly fps: number };
  /** Normal, roughness and emissive map layers; 0 is none. */
  readonly maps: { readonly normal: number; readonly roughness: number; readonly emissive: number };
  /** See-through part of a translucent block, 0-1. */
  readonly transmission: number;
  /** Interior scatter of a translucent block, 0-1. */
  readonly scatter: number;
}

const LAYERS: readonly BlockLayer[] = ['opaque', 'cutout', 'translucent', 'invisible'],
  SHAPES: readonly BlockShape[] = ['cube', 'cross', 'liquid', 'slab', 'stair'],
  FACINGS: readonly StairFacing[] = ['+x', '-x', '+z', '-z'];

// Argument error for `value` that should be an integer in 0..max: TypeError for a non-number, RangeError otherwise.
export const integerError = (what: string, value: unknown, max: number, fix: string): Error =>
  typeof value === 'number'
    ? new RangeError(`${what} ${value} is not an integer in 0..${max}; ${fix}`)
    : new TypeError(`${what} must be a number; ${fix}`);

/**
 * A block state: `id` in the low 16 bits and `state` (orientation, growth, water level: the block type's own meaning)
 * in the high 16, as an unsigned 32-bit integer. A state of id `n` and data 0 is `n` itself, so block ids are states.
 * @throws TypeError for a non-number. @throws RangeError when `id` or `state` is not an integer in 0..65535.
 */
export function blockState(id: number, state = 0): number {
  if ((id & 0xffff) !== id) throw integerError('Block id', id, 0xffff, 'pass an id from blocks.define()');
  if ((state & 0xffff) !== state) throw integerError('Block state data', state, 0xffff, 'pass 16 bits of data');
  return (id | (state << 16)) >>> 0;
}
/** The block type id of block state `s` (its low 16 bits). */
export const blockId = (s: number): number => s & 0xffff;
/** The data of block state `s` (its high 16 bits). */
export const blockData = (s: number): number => s >>> 16;

/**
 * The block state of slab block `id`: its lower half, or its upper half when `top`.
 * @throws TypeError for a non-number id. @throws RangeError when `id` is not an integer in 0..65535.
 */
export const slabState = (id: number, top = false): number => blockState(id, top ? 4 : 0);
/**
 * The block state of stair block `id` with its full-height back toward `facing`, upside down (the slab on top) when
 * `upsideDown`.
 * @throws TypeError for a non-number id or a facing other than `'+x'`, `'-x'`, `'+z'`, `'-z'`.
 * @throws RangeError when `id` is not an integer in 0..65535.
 */
export function stairState(id: number, facing: StairFacing, upsideDown = false): number {
  const side = FACINGS.indexOf(facing);
  if (side < 0) throw new TypeError(`Stair facing ${String(facing)} must be '+x', '-x', '+z' or '-z'`);
  return blockState(id, side | (upsideDown ? 4 : 0));
}
/**
 * The half-block cells block state `state` of `type` fills, as an 8-bit mask: bit `x + 2y + 4z` for the octant at
 * (x, y, z), each 0 for the cell's low half on that axis and 1 for its high half. 255 for a cube (of any layer), the
 * filled octants of a slab or stair, 0 for a cross or a liquid. Collision, picking, light and the path tracer's shapes
 * use these boxes.
 */
export const shapeOctants = (type: BlockType, state: number): number => octants(type.shape, state >>> 16);

const amount = (value: unknown, name: string, fallback: number, max = Infinity): number => {
  if (value === undefined) return fallback;
  const range = max < Infinity ? `0..${max}` : 'a finite number >= 0';
  if (typeof value !== 'number') throw new TypeError(`Block type ${name} must be a number; pass ${range}`);
  if (!(value >= 0 && value <= max && Number.isFinite(value)))
    throw new RangeError(`Block type ${name} ${value} is out of range; pass ${range}`);
  return value;
};
const level = (value: unknown, name: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (((value as number) & 15) !== value) throw integerError(`Block type ${name}`, value, 15, 'pass a light level');
  return value;
};
const flag = (value: unknown, name: string, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`Block type ${name} must be true or false`);
  return value;
};
const mapLayer = (value: unknown): number => {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 2047)
    throw integerError('Block type map layer', value, 2047, 'pass a texture layer');
  return value as number;
};
const choice = <T extends string>(value: unknown, name: string, values: readonly T[]): T => {
  if (value === undefined) return values[0];
  if (!values.includes(value as T))
    throw new TypeError(`Block type ${name} must be ${values.map((v) => `'${v}'`).join(', ')}`);
  return value as T;
};

/**
 * The block types of a world. Id 0 is `'air'` (invisible, not solid, passes light); {@link BlockTypes.define} assigns
 * the next ids in order, so define types in the same order wherever saved states are read back.
 */
export class BlockTypes {
  private readonly types: BlockType[] = [];
  private readonly names = new Map<string, number>();
  constructor() {
    this.define('air', { layer: 'invisible', solid: false });
  }
  /** Every defined type, indexed by id: plain data to post to workers. */
  get table(): readonly BlockType[] {
    return this.types;
  }
  /**
   * Defines block type `name` and returns its id (also its plain block state).
   * @throws TypeError for a non-string name or an option of the wrong type.
   * @throws RangeError for an empty name, an option out of range, or more than 65,536 types.
   * @throws MargoError `'state'` when `name` is already defined.
   */
  define(name: string, options: BlockTypeOptions = {}): number {
    if (typeof name !== 'string') throw new TypeError('Block type name must be a string such as "stone"');
    if (!name) throw new RangeError('Block type name is empty; pass a name such as "stone"');
    if (this.names.has(name))
      throw new MargoError('state', `Block type "${name}" is already defined; use blocks.id("${name}") or a new name`);
    if (this.types.length > 0xffff) throw new RangeError('Block types are full (65,536 ids); reuse a type with data');
    if (!options || typeof options !== 'object') throw new TypeError('Block type options must be an object');
    const o = options,
      layer = choice(o.layer, 'layer', LAYERS),
      shape = choice(o.shape, 'shape', SHAPES),
      animation = o.animation ?? { frames: 1, fps: 0 };
    if (!animation || typeof animation !== 'object') throw new TypeError('Block type animation must be {frames, fps}');
    const frames = animation.frames;
    if (!Number.isInteger(frames) || frames < 1 || frames > 2048)
      throw integerError('Block type animation.frames', frames, 2048, 'pass 1..2048 texture layers');
    const given = o.textures ?? 0,
      faces = typeof given === 'number' ? [given, given, given, given, given, given] : given;
    if (!Array.isArray(faces) || faces.length !== 6)
      throw new TypeError('Block type textures must be a layer or 6 layers (+x, -x, +y, -y, +z, -z)');
    for (const t of faces)
      if (!Number.isInteger(t) || t < 0 || t + frames > 2048)
        throw integerError('Block type texture layer', t, 2048 - frames, `${frames} frame(s) must fit 2048 layers`);
    const color: [number, number, number] = [1, 1, 1];
    if (o.color !== undefined) parseColor(o.color, color);
    const id = this.types.length;
    this.types.push({
      id,
      name,
      textures: [...faces] as unknown as BlockType['textures'],
      layer,
      shape,
      solid: flag(o.solid, 'solid', true),
      liquid: flag(o.liquid, 'liquid', false),
      light: level(o.light, 'light', 0),
      opacity: level(o.opacity, 'opacity', layer === 'opaque' && shape === 'cube' ? 15 : 0),
      color,
      roughness: amount(o.roughness, 'roughness', 1, 1),
      metalness: amount(o.metalness, 'metalness', 0, 1),
      emissive: amount(o.emissive, 'emissive', 0),
      animation: { frames, fps: amount(animation.fps, 'animation.fps', 0) },
      maps: {
        normal: mapLayer(o.maps?.normal),
        roughness: mapLayer(o.maps?.roughness),
        emissive: mapLayer(o.maps?.emissive),
      },
      transmission: amount(o.transmission, 'transmission', 0, 1),
      scatter: amount(o.scatter, 'scatter', 0, 1),
    });
    this.names.set(name, id);
    return id;
  }
  /**
   * The id of block type `name`.
   * @throws RangeError when no type has that name.
   */
  id(name: string): number {
    const id = this.names.get(name);
    if (id === undefined) throw new RangeError(`Block type "${name}" is not defined; define it with blocks.define()`);
    return id;
  }
  /**
   * The block type with id `id` (the {@link blockId} of a state).
   * @throws RangeError when no type has that id.
   */
  get(id: number): BlockType {
    const type = Number.isInteger(id) ? this.types[id] : undefined;
    if (!type) throw new RangeError(`Block id ${id} is not defined; define it with blocks.define()`);
    return type;
  }
}
