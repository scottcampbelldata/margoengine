import type { ColorInput, Vec3 } from '@margoengine/math';
import { parseColor } from '@margoengine/math/color';
import { MargoError } from '@margoengine/math/errors';

/**
 * Render pass of a block type: `'opaque'` (back-face culled, hides its neighbours' faces), `'cutout'` (alpha
 * tested, e.g. leaves), `'translucent'` (sorted and blended, e.g. glass and water) or `'invisible'` (never drawn, e.g. air).
 */
export type BlockLayer = 'opaque' | 'cutout' | 'translucent' | 'invisible';
/** Geometry of a block type: a full `'cube'`, two diagonal quads (`'cross'`, e.g. grass and flowers) or a `'liquid'`. */
export type BlockShape = 'cube' | 'cross' | 'liquid';

/** Options of {@link BlockTypes.define}. Every field is optional. */
export interface BlockTypeOptions {
  /**
   * Texture layer (0-255) of every face, or one per face in the order +x, -x, +y, -y, +z, -z (`[side, side, top,
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
  /** Animated texture: `frames` consecutive layers from each face's layer (1-256), played at `fps` (>= 0). */
  animation?: { frames: number; fps: number };
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
}

const LAYERS: readonly BlockLayer[] = ['opaque', 'cutout', 'translucent', 'invisible'],
  SHAPES: readonly BlockShape[] = ['cube', 'cross', 'liquid'];

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
    if (!Number.isInteger(frames) || frames < 1 || frames > 256)
      throw integerError('Block type animation.frames', frames, 256, 'pass 1..256 texture layers');
    const given = o.textures ?? 0,
      faces = typeof given === 'number' ? [given, given, given, given, given, given] : given;
    if (!Array.isArray(faces) || faces.length !== 6)
      throw new TypeError('Block type textures must be a layer or 6 layers (+x, -x, +y, -y, +z, -z)');
    for (const t of faces)
      if ((t & 255) !== t || t + frames > 256)
        throw integerError('Block type texture layer', t, 256 - frames, `${frames} frame(s) must fit 256 layers`);
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
