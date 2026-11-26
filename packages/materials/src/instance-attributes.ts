// Extra per-instance attributes read by a material plugin: named values of every instance, set one at a time or as whole
// buffers, edited in place and uploaded as dirty row ranges. All attributes share one read-only storage buffer, one
// contiguous block per attribute (so a whole attribute is one Float32Array view and one upload), which the plugin's WGSL
// loads by the instance index into `var<private>` values in the vertex stage, in every depth pass and, passed as a flat
// varying, in the fragment stage. Per-instance data fetched by instance index in the vertex shader follows B. Dudash,
// "Animated Crowd Rendering" (GPU Gems 3, chapter 2, 2007,
// https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-2-animated-crowd-rendering); the trade-offs of
// the places per-instance data can live are F. Carucci, "Inside Geometry Instancing" (GPU Gems 2, chapter 3, 2005,
// https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-3-inside-geometry-instancing).
import { MargoError } from '@margoengine/math/errors';
import { parseColor, type ColorInput } from '@margoengine/math/color';
import type { MaterialValueCodec } from './serialization.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };

/** What one instance holds of an attribute: `color` reads in WGSL as a linear `vec3f`; matrices are column-major. */
export type InstanceAttributeType = 'f32' | 'vec2f' | 'vec3f' | 'vec4f' | 'color' | 'mat3x3f' | 'mat4x4f';
/** An attribute: its type, or its type with the value instances hold until set. */
export type InstanceAttribute =
  | InstanceAttributeType
  | { type: InstanceAttributeType; default?: number | ArrayLike<number> | string };
/** The attributes of `instanceAttributes()`, by name (letters and digits, starting with a letter). */
export type InstanceAttributeSchema = Record<string, InstanceAttribute>;
type TypeOf<A> = A extends InstanceAttributeType ? A : A extends { type: infer T } ? T : never;
/** The value one instance takes: a number for `f32`, any colour for `color`, else its numbers. */
export type InstanceAttributeValue<A> =
  TypeOf<A> extends 'f32' ? number : TypeOf<A> extends 'color' ? ColorInput : ArrayLike<number>;

const help = '; see https://margoengine.com/errors#instance-attributes',
  identity3 = [1, 0, 0, 0, 1, 0, 0, 0, 1],
  identity4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  // Floats per instance and the default of each type.
  kinds: Record<InstanceAttributeType, readonly number[]> = {
    f32: [0],
    vec2f: [0, 0],
    vec3f: [0, 0, 0],
    vec4f: [0, 0, 0, 0],
    color: [1, 1, 1],
    mat3x3f: identity3,
    mat4x4f: identity4,
  },
  identifier = /^[A-Za-z][A-Za-z0-9]*$/,
  surfaceHead = 'fn surface(i:Out,front:bool)->Surface {',
  MAX_CAPACITY = 1_000_000,
  MAX_ATTRIBUTES = 16;

interface Slot {
  readonly name: string;
  readonly type: InstanceAttributeType;
  readonly size: number;
  /** First float of the attribute's block in `data`: `capacity` rows, then one row holding the default. */
  readonly base: number;
  readonly view: Float32Array;
}
interface Uploaded {
  readonly device: GPUDevice;
  readonly buffer: GPUBuffer;
  /** Dirty rows of each attribute, [low, high). */
  readonly low: Int32Array;
  readonly high: Int32Array;
  readonly entries: Map<number, GPUBindGroupEntry>;
}
const finite = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(Math.fround(v));
const unsupported = () =>
  new MargoError(
    'unsupported',
    `Instance attributes need the standard PBR shader; use matching @margoengine/materials and gltf/pbr versions${help}`,
  );

/**
 * Per-instance values of named attributes, read by a material plugin (`materialPlugin({instanceAttributes})`) as
 * `<plugin name>_<attribute>`. Row `i` belongs to instance `i` of every mesh drawn with that material (a plain mesh
 * reads row 0); an instance at or past `capacity` reads the defaults. Setters upload only the rows they touched.
 */
export class InstanceAttributes<S extends InstanceAttributeSchema = InstanceAttributeSchema> {
  /** Rows held, one per instance. */
  readonly capacity: number;
  /** The type of each attribute, in declaration order. */
  readonly types: Readonly<Record<keyof S & string, InstanceAttributeType>>;
  private readonly slots: Slot[] = [];
  private readonly data: Float32Array<ArrayBuffer>;
  private readonly uploaded: Uploaded[] = [];
  private readonly scratch = new Float64Array(16);
  private users = 0;
  private disposed = false;

  /** @internal Use `instanceAttributes()`. */
  constructor(capacity: number, attributes: S) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY)
      throw new RangeError(`Instance attribute capacity must be a whole number from 1 to 1,000,000; pass one${help}`);
    const names = attributes && typeof attributes === 'object' ? Object.keys(attributes) : [];
    if (!names.length || names.length > MAX_ATTRIBUTES)
      throw new RangeError(`instanceAttributes takes 1 to ${MAX_ATTRIBUTES} named attributes; pass them${help}`);
    let floats = 0;
    const declared = names.map((name) => {
      if (!identifier.test(name))
        throw new TypeError(
          `Instance attribute name '${name}' is not usable; pass letters and digits starting with a letter${help}`,
        );
      const spec: InstanceAttribute = attributes[name],
        type = typeof spec === 'string' ? spec : spec?.type;
      if (!Object.hasOwn(kinds, type))
        throw new TypeError(
          `Instance attribute '${name}' type must be ${Object.keys(kinds).join(', ')}; pass one of those${help}`,
        );
      const size = kinds[type].length,
        base = floats;
      floats += (capacity + 1) * size;
      return { name, type, size, base, initial: typeof spec === 'string' ? undefined : spec.default };
    });
    this.capacity = capacity;
    this.data = new Float32Array(floats);
    for (const { name, type, size, base, initial } of declared) {
      const slot: Slot = { name, type, size, base, view: this.data.subarray(base, base + capacity * size) };
      this.slots.push(slot);
      if (initial === undefined) this.data.set(kinds[type], base + capacity * size);
      else this.write(slot, capacity, initial);
      for (let row = 0; row < capacity; row++) this.copyDefault(slot, row);
    }
    this.types = Object.freeze(Object.fromEntries(this.slots.map((s) => [s.name, s.type]))) as never;
  }

  /** Sets attribute `name` of instance `index`. */
  set<K extends keyof S & string>(name: K, index: number, value: InstanceAttributeValue<S[K]>): this {
    const slot = this.slot(name);
    this.rows(index, 1);
    this.write(slot, index, value);
    this.mark(slot, index, index + 1);
    return this;
  }
  /** Attribute `name` of instance `index`: a number for `f32`, else its numbers, written into `out` when given. */
  get<K extends keyof S & string>(
    name: K,
    index: number,
    out?: Float32Array | number[],
  ): TypeOf<S[K]> extends 'f32' ? number : Float32Array | number[] {
    const slot = this.slot(name);
    this.rows(index, 1);
    const at = slot.base + index * slot.size;
    if (slot.type === 'f32') return this.data[at] as never;
    const to = out ?? new Float32Array(slot.size);
    for (let k = 0; k < slot.size; k++) to[k] = this.data[at + k];
    return to as never;
  }
  /**
   * Writes `values` (flat, the attribute's floats per instance; colours as linear RGB) into attribute `name` from
   * instance `start`: the bulk form of `set`, with one check and one upload range. Nothing is written if a value fails.
   */
  setBuffer(name: keyof S & string, values: ArrayLike<number>, start = 0): this {
    const slot = this.slot(name),
      n = values?.length;
    if (!Number.isInteger(n) || n % slot.size)
      throw new TypeError(
        `Instance attribute '${name}' takes ${slot.size} number(s) per instance; pass whole rows${help}`,
      );
    const count = n / slot.size;
    this.rows(start, count);
    for (let k = 0; k < n; k++)
      if (!finite(values[k]))
        throw new RangeError(
          `Instance attribute '${name}' values must be finite as float32; pass finite numbers${help}`,
        );
    this.data.set(values, slot.base + start * slot.size);
    if (count) this.mark(slot, start, start + count);
    return this;
  }
  /**
   * The live values of attribute `name`, `capacity` rows of its floats: write into it in place, then call `update` for
   * the rows you changed. Direct writes are not checked.
   */
  array(name: keyof S & string): Float32Array {
    return this.slot(name).view;
  }
  /** Marks rows written through `array` for upload: of one attribute or all, `count` rows from `start` (default all). */
  update(name?: keyof S & string, start = 0, count = this.capacity - start): this {
    const only = name === undefined ? undefined : this.slot(name);
    this.rows(start, count);
    if (count)
      for (let a = 0; a < this.slots.length; a++)
        if (!only || this.slots[a] === only) this.mark(this.slots[a], start, start + count);
    return this;
  }
  /** Gives attribute `name` (default every attribute) its default again, on instance `index` (default every instance). */
  reset(name?: keyof S & string, index?: number): this {
    const only = name === undefined ? undefined : this.slot(name);
    if (index !== undefined) this.rows(index, 1);
    else this.live();
    const from = index ?? 0,
      to = index === undefined ? this.capacity : index + 1;
    for (let a = 0; a < this.slots.length; a++) {
      const slot = this.slots[a];
      if (only && slot !== only) continue;
      for (let row = from; row < to; row++) this.copyDefault(slot, row);
      this.mark(slot, from, to);
    }
    return this;
  }
  /** The capacity, types with their defaults and values, for `instanceAttributesCodec`. */
  snapshot(): { capacity: number; attributes: InstanceAttributeSchema; values: Record<string, Float32Array> } {
    this.live();
    const attributes: InstanceAttributeSchema = {},
      values: Record<string, Float32Array> = {};
    for (const s of this.slots) {
      const at = s.base + this.capacity * s.size,
        initial = Array.from(this.data.subarray(at, at + s.size));
      attributes[s.name] = { type: s.type, default: s.type === 'f32' ? initial[0] : initial };
      values[s.name] = s.view.slice();
    }
    return { capacity: this.capacity, attributes, values };
  }
  /** Frees the GPU buffers; the object takes no more edits. Drop the plugins that read it first. */
  dispose(): void {
    this.disposed = true;
    this.free();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  /** @internal A plugin in use holds the GPU buffers. */
  retain(): void {
    this.live();
    this.users++;
  }
  /** @internal The last plugin in use frees them; the values stay and upload again when next drawn. */
  release(): void {
    if (--this.users <= 0) {
      this.users = 0;
      this.free();
    }
  }
  /** @internal The bind group entry of `binding` on `device`, with the edited rows uploaded. */
  entry(device: GPUDevice, binding: number): GPUBindGroupEntry {
    this.live();
    let held: Uploaded | undefined;
    for (let k = 0; k < this.uploaded.length; k++) if (this.uploaded[k].device === device) held = this.uploaded[k];
    if (!held) held = this.create(device);
    else
      for (let a = 0; a < this.slots.length; a++) {
        const low = held.low[a],
          high = held.high[a];
        if (high <= low) continue;
        const s = this.slots[a],
          at = s.base + low * s.size;
        device.queue.writeBuffer(held.buffer, at * 4, this.data, at, (high - low) * s.size);
        held.low[a] = this.capacity;
        held.high[a] = 0;
      }
    let entry = held.entries.get(binding);
    if (!entry) held.entries.set(binding, (entry = { binding, resource: { buffer: held.buffer } }));
    return entry;
  }
  /** @internal The storage declaration, the values `<name>_<attribute>` and `margoInstanceLoad_<name>(row)`. */
  declare(name: string, group: number, binding: number): string {
    const data = `margoInstanceData_${name}`;
    let values = '',
      loads = `let k=min(row,${this.capacity}u);`;
    for (const s of this.slots) {
      const type = s.type === 'color' ? 'vec3f' : s.type,
        read = Array.from({ length: s.size }, (_, c) => `${data}[${s.base + c}u+k*${s.size}u]`).join(',');
      values += `var<private> ${name}_${s.name}:${type};\n`;
      loads += `${name}_${s.name}=${s.size === 1 ? read : `${type}(${read})`};`;
    }
    return `@group(${group}) @binding(${binding}) var<storage,read> ${data}:array<f32>;\n${values}fn margoInstanceLoad_${name}(row:u32){${loads}}\n`;
  }
  /**
   * @internal The colour pass's edit, once per material: the instance index as a vertex input and, for the plugins in
   * `readers` (fragment points), a flat varying that loads their values at the head of `surface()`.
   */
  host(code: string, readers: readonly string[]): string {
    const edit = (out: string, from: RegExp | string, to: (found: string) => string) => {
      const next = out.replace(from, to);
      if (next === out) throw unsupported();
      return next;
    };
    // A shader node graph that reads instanceIndex has declared this input already.
    let out = code.includes('ndInstance:u32')
      ? code
      : edit(code, /struct Input\s*\{/, (head) => head + '@builtin(instance_index) ndInstance:u32,');
    // A shader that reads the model matrix itself is never merged with other plain meshes into one instanced draw, whose
    // batch position would otherwise be read as the row: so a plain mesh reads row 0.
    out = edit(out, /@vertex fn vertex\([^{]*\{/, (head) => head + '_=f.model;');
    if (!readers.length) return out;
    const fields = /struct Out \{[^}]*\}/.exec(out)?.[0],
      // Locations no effect of this package or gltf/pbr takes after this edit (instancing takes 5).
      location = [6, 8].find((n) => !fields?.includes(`@location(${n})`));
    if (location === undefined) throw unsupported();
    out = edit(
      out,
      /(struct Out \{[^}]*?)\n\}/,
      (all) => `${all.slice(0, -2)}, @location(${location}) @interpolate(flat) margoRow:u32\n}`,
    );
    const start = out.indexOf('@vertex fn vertex('),
      end = out.indexOf('return o;', start);
    if (end < 0) throw unsupported();
    out = out.slice(0, end) + 'o.margoRow=i.ndInstance;' + out.slice(end);
    return edit(out, surfaceHead, (head) => head + readers.map((n) => `margoInstanceLoad_${n}(i.margoRow);`).join(''));
  }

  private create(device: GPUDevice): Uploaded {
    const size = this.data.byteLength,
      limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    if (size > limit)
      throw new RangeError(
        `Instance attributes need ${size} bytes, past this device's ${limit}; lower the capacity or drop attributes${help}`,
      );
    const buffer = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, this.data);
    const held: Uploaded = {
      device,
      buffer,
      low: new Int32Array(this.slots.length).fill(this.capacity),
      high: new Int32Array(this.slots.length),
      entries: new Map(),
    };
    this.uploaded.push(held);
    // A lost device's buffer is forgotten; the replacement device gets a new one when it first draws.
    void device.lost?.then(() => {
      const k = this.uploaded.indexOf(held);
      if (k >= 0) this.uploaded.splice(k, 1);
    });
    return held;
  }
  private free(): void {
    for (const { buffer } of this.uploaded) buffer.destroy();
    this.uploaded.length = 0;
  }
  private live(): void {
    if (this.disposed)
      throw new MargoError(
        'disposed',
        `Instance attributes are disposed; create new ones with instanceAttributes${help}`,
      );
  }
  private slot(name: string): Slot {
    this.live();
    for (let k = 0; k < this.slots.length; k++) if (this.slots[k].name === name) return this.slots[k];
    throw new TypeError(`No instance attribute '${name}'; use ${this.slots.map((s) => s.name).join(', ')}${help}`);
  }
  private rows(start: number, count: number): void {
    this.live();
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > this.capacity)
      throw new RangeError(
        `Instance attribute rows run from 0 to ${this.capacity - 1}; pass rows inside the capacity${help}`,
      );
  }
  /** One row from a value of the slot's type; nothing is written unless every number is finite. */
  private write(slot: Slot, row: number, value: unknown): void {
    const { size, type } = slot,
      at = slot.base + row * size;
    if (size === 1) {
      if (!finite(value)) throw this.invalid(slot);
      this.data[at] = value as number;
      return;
    }
    let from = value as ArrayLike<number>;
    if (type === 'color') from = parseColor(value as ColorInput, this.scratch as unknown as number[]) as number[];
    else if (!from || typeof from !== 'object' || from.length !== size) throw this.invalid(slot);
    for (let k = 0; k < size; k++) if (!finite(from[k])) throw this.invalid(slot);
    for (let k = 0; k < size; k++) this.data[at + k] = from[k];
  }
  private invalid(slot: Slot): TypeError {
    return new TypeError(
      `Instance attribute '${slot.name}' is ${slot.type}; pass ${slot.size === 1 ? 'a finite number' : `${slot.size} finite numbers`}${help}`,
    );
  }
  private copyDefault(slot: Slot, row: number): void {
    const from = slot.base + this.capacity * slot.size;
    this.data.copyWithin(slot.base + row * slot.size, from, from + slot.size);
  }
  private mark(slot: Slot, from: number, to: number): void {
    const a = this.slots.indexOf(slot);
    for (let k = 0; k < this.uploaded.length; k++) {
      const held = this.uploaded[k];
      if (from < held.low[a]) held.low[a] = from;
      if (to > held.high[a]) held.high[a] = to;
    }
  }
}

/**
 * Registers extra per-instance data for a material: `capacity` rows (1 to 1,000,000) of up to 16 named attributes, each
 * at its default until set (0, white for `color`, the identity for a matrix). Pass it to
 * `materialPlugin({instanceAttributes})`, whose WGSL reads `<plugin name>_<attribute>`.
 */
export const instanceAttributes = <const S extends InstanceAttributeSchema>(
  capacity: number,
  attributes: S,
): InstanceAttributes<S> => new InstanceAttributes(capacity, attributes);

/**
 * The `/serialization` codec of instance attributes: pass it with `materialPluginCodec` in `codecs`. It saves the
 * capacity, types, defaults and current values.
 */
export const instanceAttributesCodec: MaterialValueCodec = {
  type: 'instance-attributes',
  test: (v) => v instanceof InstanceAttributes,
  capture: (v: InstanceAttributes) => v.snapshot(),
  restore: (data: ReturnType<InstanceAttributes['snapshot']>) => {
    const out = instanceAttributes(data.capacity, data.attributes);
    for (const [name, values] of Object.entries(data.values)) out.setBuffer(name, values);
    return out;
  },
};
