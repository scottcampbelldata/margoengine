// The schema-first binary codec: one schema definition gives full encoding, delta encoding against a baseline,
// canonical equality and interpolation for every named struct. The wire format is written out in README.md ("Wire
// format") so another language (a Rust server) can generate the same encoders from the same normalized JSON.
import { ByteReader, ByteWriter, unzigzag, zigzag } from '../../shared/bytes.js';

/** Number kinds: fixed-width integers, 32-bit LEB128 varints (`uint`, zigzag `int`) and little-endian floats. */
export type NumberKind = 'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32' | 'uint' | 'int' | 'f32' | 'f64';
/** The kinds a field can name directly as a string. */
export type ScalarKind = NumberKind | 'bool' | 'string' | 'bytes';
/** How {@link Schema.interpolate} blends a number: straight line, shortest turn in radians, or no blend (step). */
export type Interpolation = 'linear' | 'angle' | 'none';

/**
 * One field's type: a {@link ScalarKind}, the name of another struct in the schema, or an object form:
 * - `{ type: 'f32' | ... , interpolate? }` a number with its interpolation (floats default to `'linear'`, integers
 *   are always `'none'`);
 * - `{ type: 'quantized', min, max, bits, interpolate? }` a float in [min, max] sent as an unsigned integer of `bits`
 *   (2 to 32) bits in `ceil(bits / 8)` bytes, in `2^bits - 2` equal steps so that min, max and their midpoint
 *   (0 in a range like -1..1) are exact;
 * - `{ type: 'string' | 'bytes', maxLength? }` UTF-8 text or raw bytes, at most `maxLength` bytes (default 256 for
 *   strings, 4096 for bytes);
 * - `{ type: 'enum', values }` one of up to 2^32 strings, sent as its index;
 * - `{ type: 'array', of, maxLength? }` a list of up to `maxLength` items (default 256);
 * - `{ type: 'optional', of }` the value or `undefined`;
 * - `{ type: 'map', of, maxSize? }` a `Map` from entity id (0 to 2^32 - 1) to values, at most `maxSize` entries
 *   (default 1024). Maps are the entity collections: a delta sends only added, changed and removed entries.
 */
export type FieldType =
  | ScalarKind
  | (string & {})
  | { readonly type: NumberKind; readonly interpolate?: Interpolation }
  | {
      readonly type: 'quantized';
      readonly min: number;
      readonly max: number;
      readonly bits: number;
      readonly interpolate?: Interpolation;
    }
  | { readonly type: 'string' | 'bytes'; readonly maxLength?: number }
  | { readonly type: 'enum'; readonly values: readonly string[] }
  | { readonly type: 'array'; readonly of: FieldType; readonly maxLength?: number }
  | { readonly type: 'optional'; readonly of: FieldType }
  | { readonly type: 'map'; readonly of: FieldType; readonly maxSize?: number };

/** A struct: field names in wire order, each with its {@link FieldType}. */
export type StructDefinition = { readonly [field: string]: FieldType };

/**
 * A whole schema: named structs (names start with a capital letter) and an optional version number of your own. The
 * same object, as JSON, is the input of every generator.
 */
export interface SchemaDefinition {
  /** Your protocol's version, part of the hash (default 1). */
  readonly version?: number;
  /** Struct name to its fields. */
  readonly types: { readonly [name: string]: StructDefinition };
}

/**
 * Any schema definition's shape, without checking its fields: the constraint of the type helpers below. (Checking
 * fields against {@link FieldType} there makes TypeScript's inference too deep; `defineSchema` checks them.)
 */
export interface SchemaShape {
  /** Struct name to its fields. */
  readonly types: { readonly [name: string]: { readonly [field: string]: unknown } };
}

type Value<T, F> = F extends 'bool'
  ? boolean
  : F extends NumberKind
    ? number
    : F extends 'string'
      ? string
      : F extends 'bytes'
        ? Uint8Array
        : F extends { type: 'quantized' | NumberKind }
          ? number
          : F extends { type: 'string' }
            ? string
            : F extends { type: 'bytes' }
              ? Uint8Array
              : F extends { type: 'enum'; values: readonly (infer E)[] }
                ? E
                : F extends { type: 'array'; of: infer O }
                  ? Value<T, O>[]
                  : F extends { type: 'optional'; of: infer O }
                    ? Value<T, O> | undefined
                    : F extends { type: 'map'; of: infer O }
                      ? Map<number, Value<T, O>>
                      : F extends keyof T
                        ? StructValue<T, T[F]>
                        : unknown;
type OptionalKeys<S> = { [K in keyof S]: S[K] extends { type: 'optional' } ? K : never }[keyof S];
type StructValue<T, S> = { -readonly [K in Exclude<keyof S, OptionalKeys<S>>]: Value<T, S[K]> } & {
  -readonly [K in OptionalKeys<S>]?: Value<T, S[K]>;
};

/** Names of the structs of schema definition `S`. */
export type TypeName<S extends SchemaShape> = keyof S['types'] & string;
/** The JavaScript value of struct `N` of schema definition `S`, as `encode` takes it and `decode` returns it. */
export type Infer<S extends SchemaShape, N extends TypeName<S>> = StructValue<S['types'], S['types'][N]>;

/** A normalized field: every shorthand expanded and every default filled in (see {@link Schema.json}). */
export type NormalizedField =
  | { type: NumberKind; interpolate: Interpolation }
  | { type: 'bool' }
  | { type: 'quantized'; min: number; max: number; bits: number; interpolate: Interpolation }
  | { type: 'string' | 'bytes'; maxLength: number }
  | { type: 'enum'; values: string[] }
  | { type: 'array'; of: NormalizedField; maxLength: number }
  | { type: 'optional'; of: NormalizedField }
  | { type: 'map'; of: NormalizedField; maxSize: number }
  | { type: 'struct'; name: string };

/** The normalized schema, the exact input of generators and of {@link Schema.hash}. */
export interface NormalizedSchema {
  /** The definition's version (default 1). */
  version: number;
  /** Struct name to its normalized fields, in wire order. */
  types: { [name: string]: { [field: string]: NormalizedField } };
}

/** A compiled schema: the codec of every struct it names. */
export interface Schema<S extends SchemaShape = SchemaDefinition> {
  /** The definition as given. */
  readonly definition: S;
  /** The normalized definition: what a generator in another language reads (`JSON.stringify(schema.json)`). */
  readonly json: NormalizedSchema;
  /** FNV-1a 32-bit hash of `JSON.stringify(schema.json)` as UTF-8: two ends with the same hash speak the same format. */
  readonly hash: number;
  /** Struct names, in definition order. */
  readonly names: readonly TypeName<S>[];
  /**
   * Bytes of `value` as struct `name`.
   * @throws TypeError for a value of the wrong shape; RangeError for one outside its field's range (a non-integer or
   * out-of-range integer, a non-finite float, a quantized value outside [min, max], text, a list or a map over its
   * limit).
   */
  encode<N extends TypeName<S>>(name: N, value: Infer<S, N>): Uint8Array;
  /**
   * The value `encode(name, ...)` wrote. Maps come back sorted by id.
   * @throws RangeError for truncated or malformed bytes, or bytes past the end (never anything else).
   */
  decode<N extends TypeName<S>>(name: N, bytes: Uint8Array): Infer<S, N>;
  /**
   * Bytes of `value` as a change from `baseline` (a value `decode` or `decodeDelta` returned): one bit per field, then
   * only the fields that changed; maps send only removed, added and changed entries.
   * @throws as {@link Schema.encode}.
   */
  encodeDelta<N extends TypeName<S>>(name: N, value: Infer<S, N>, baseline: Infer<S, N>): Uint8Array;
  /**
   * The value `encodeDelta(name, value, baseline)` described, equal to `decode(name, encode(name, value))`. Unchanged
   * parts are shared with `baseline`, so treat decoded values as read-only (`clone` gives a private copy).
   * @throws RangeError for truncated or malformed bytes, or bytes that do not fit `baseline`.
   */
  decodeDelta<N extends TypeName<S>>(name: N, bytes: Uint8Array, baseline: Infer<S, N>): Infer<S, N>;
  /** Whether `a` and `b` encode to the same bytes (floats compared after rounding to the wire precision). */
  equals<N extends TypeName<S>>(name: N, a: Infer<S, N>, b: Infer<S, N>): boolean;
  /** A private deep copy of `value` exactly as the other end decodes it (floats at wire precision, maps sorted by id). */
  clone<N extends TypeName<S>>(name: N, value: Infer<S, N>): Infer<S, N>;
  /**
   * The blend of `a` and `b` at `t` (0 gives `a`, 1 gives `b`): floats per their {@link Interpolation}, everything
   * else steps to `b` at `t >= 1`; a map entry only in `b` is taken from `b`, one only in `a` is dropped.
   */
  interpolate<N extends TypeName<S>>(name: N, a: Infer<S, N>, b: Infer<S, N>, t: number): Infer<S, N>;
}

/** A compiled schema seen without its definition's types: names are strings and values `unknown`. */
export interface UntypedSchema {
  /** See {@link Schema.json}. */
  readonly json: NormalizedSchema;
  /** See {@link Schema.hash}. */
  readonly hash: number;
  /** See {@link Schema.names}. */
  readonly names: readonly string[];
  /** See {@link Schema.encode}. */
  encode(name: string, value: unknown): Uint8Array;
  /** See {@link Schema.decode}. */
  decode(name: string, bytes: Uint8Array): unknown;
  /** See {@link Schema.encodeDelta}. */
  encodeDelta(name: string, value: unknown, baseline: unknown): Uint8Array;
  /** See {@link Schema.decodeDelta}. */
  decodeDelta(name: string, bytes: Uint8Array, baseline: unknown): unknown;
  /** See {@link Schema.equals}. */
  equals(name: string, a: unknown, b: unknown): boolean;
  /** See {@link Schema.clone}. */
  clone(name: string, value: unknown): unknown;
  /** See {@link Schema.interpolate}. */
  interpolate(name: string, a: unknown, b: unknown, t: number): unknown;
}

// ---------------------------------------------------------------------------------------------------------------
// Normalization

const NUMBER_KINDS = new Set<string>(['u8', 'u16', 'u32', 'i8', 'i16', 'i32', 'uint', 'int', 'f32', 'f64']);
const FLOATS = new Set<string>(['f32', 'f64']);
const STRUCT_NAME = /^[A-Z][A-Za-z0-9]*$/;
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;
const INTERPOLATIONS = new Set<string>(['linear', 'angle', 'none']);

const limit = (where: string, value: unknown, fallback: number, max: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max)
    throw new RangeError(`${where} must be an integer from 0 to ${max}; fix the schema`);
  return value;
};

function normalizeField(
  where: string,
  field: unknown,
  types: SchemaDefinition['types'],
  lerp: boolean,
): NormalizedField {
  if (typeof field === 'string') {
    if (field === 'bool') return { type: 'bool' };
    if (field === 'string' || field === 'bytes') return normalizeField(where, { type: field }, types, lerp);
    if (NUMBER_KINDS.has(field))
      return { type: field as NumberKind, interpolate: FLOATS.has(field) ? 'linear' : 'none' };
    if (Object.hasOwn(types, field)) return { type: 'struct', name: field };
    throw new TypeError(`${where} names an unknown type '${field}'; use a scalar kind or a struct of this schema`);
  }
  if (!field || typeof field !== 'object' || typeof (field as { type?: unknown }).type !== 'string')
    throw new TypeError(`${where} must be a type name or an object with a 'type'; fix the schema`);
  const f = field as Record<string, unknown>,
    type = f.type as string;
  const interpolation = (fallback: Interpolation): Interpolation => {
    if (f.interpolate === undefined) return fallback;
    if (typeof f.interpolate !== 'string' || !INTERPOLATIONS.has(f.interpolate))
      throw new TypeError(`${where} interpolate must be 'linear', 'angle' or 'none'; fix the schema`);
    return f.interpolate as Interpolation;
  };
  if (NUMBER_KINDS.has(type)) {
    if (FLOATS.has(type)) return { type: type as NumberKind, interpolate: interpolation('linear') };
    if (f.interpolate !== undefined && f.interpolate !== 'none')
      throw new TypeError(`${where} is an integer, which only steps; drop interpolate or use a float type`);
    return { type: type as NumberKind, interpolate: 'none' };
  }
  switch (type) {
    case 'bool':
      return { type: 'bool' };
    case 'quantized': {
      const { min, max, bits } = f as { min: unknown; max: unknown; bits: unknown };
      if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max))
        throw new TypeError(`${where} needs finite numbers min and max; fix the schema`);
      if (!(max > min) || !Number.isFinite(max - min))
        throw new RangeError(`${where} needs max greater than min with a finite range; fix the schema`);
      if (typeof bits !== 'number' || !Number.isInteger(bits) || bits < 2 || bits > 32)
        throw new RangeError(`${where} bits must be an integer from 2 to 32; fix the schema`);
      return { type: 'quantized', min, max, bits, interpolate: interpolation('linear') };
    }
    case 'string':
      return { type: 'string', maxLength: limit(`${where} maxLength`, f.maxLength, 256, 2 ** 24) };
    case 'bytes':
      return { type: 'bytes', maxLength: limit(`${where} maxLength`, f.maxLength, 4096, 2 ** 24) };
    case 'enum': {
      const values = f.values;
      if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== 'string'))
        throw new TypeError(`${where} needs a non-empty array of string values; fix the schema`);
      if (new Set(values).size !== values.length) throw new TypeError(`${where} lists a value twice; fix the schema`);
      return { type: 'enum', values: [...values] };
    }
    case 'array':
      return {
        type: 'array',
        of: normalizeField(`${where} item`, f.of, types, lerp),
        maxLength: limit(`${where} maxLength`, f.maxLength, 256, 2 ** 24),
      };
    case 'optional': {
      const of = normalizeField(`${where} value`, f.of, types, lerp);
      if (of.type === 'optional') throw new TypeError(`${where} is an optional of an optional; use one optional`);
      return { type: 'optional', of };
    }
    case 'map':
      return {
        type: 'map',
        of: normalizeField(`${where} value`, f.of, types, lerp),
        maxSize: limit(`${where} maxSize`, f.maxSize, 1024, 2 ** 24),
      };
  }
  throw new TypeError(
    `${where} has unknown type '${type}'; use a scalar kind, quantized, enum, array, optional or map`,
  );
}

function normalize(definition: SchemaDefinition): NormalizedSchema {
  if (!definition || typeof definition !== 'object' || !definition.types || typeof definition.types !== 'object')
    throw new TypeError('Schema definition needs a types object; pass { types: { Name: { field: type } } }');
  const version = limit('Schema version', definition.version, 1, 2 ** 32 - 1);
  const types: NormalizedSchema['types'] = {};
  for (const [name, struct] of Object.entries(definition.types)) {
    if (!STRUCT_NAME.test(name))
      throw new TypeError(`Schema type '${name}' must start with a capital letter and use only letters and digits`);
    if (!struct || typeof struct !== 'object' || !Object.keys(struct).length)
      throw new TypeError(`Schema type ${name} must be an object of at least one field; add a field`);
    const fields: { [field: string]: NormalizedField } = {};
    for (const [field, type] of Object.entries(struct)) {
      if (!FIELD_NAME.test(field))
        throw new TypeError(
          `Schema field ${name}.${field} must start with a lower-case letter and use only letters and digits`,
        );
      fields[field] = normalizeField(`Schema field ${name}.${field}`, type, definition.types, true);
    }
    types[name] = fields;
  }
  // A struct may hold itself only through an array, an optional or a map (otherwise its values would be infinite).
  const state = new Map<string, number>();
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === 2) return;
    if (state.get(name) === 1)
      throw new TypeError(
        `Schema type ${path.join(' -> ')} contains itself directly; wrap the reference in optional, array or map`,
      );
    state.set(name, 1);
    for (const field of Object.values(types[name]))
      if (field.type === 'struct') visit(field.name, [...path, field.name]);
    state.set(name, 2);
  };
  for (const name of Object.keys(types)) visit(name, [name]);
  return { version, types };
}

/** FNV-1a, 32 bits, over UTF-8 bytes. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash;
}

// ---------------------------------------------------------------------------------------------------------------
// Bytes

/** The shared writer plus 64-bit floats. */
export class Writer extends ByteWriter {
  /** Writes a little-endian 64-bit float. */
  f64(v: number): void {
    this.room(8);
    this.view.setFloat64(this.at, v, true);
    this.at += 8;
  }
}

/** The shared checked reader plus 64-bit floats and finite-float checks. */
export class Reader extends ByteReader {
  /** Reads a little-endian 32-bit float and rejects NaN and infinities. */
  override f32(): number {
    return this.finite(super.f32());
  }
  /** Reads a little-endian 64-bit float and rejects NaN and infinities. */
  f64(): number {
    this.need(8);
    this.at += 8;
    return this.finite(this.view.getFloat64(this.at - 8, true));
  }
  /** Throws unless `v` is finite. */
  finite(v: number): number {
    if (!Number.isFinite(v)) throw this.fail(`holds a non-finite number at byte ${this.at}`);
    return v;
  }
  /** A count of items that each take at least one byte: at most `max` and at most the bytes left. */
  count(max: number): number {
    const n = this.varint();
    if (n > max) throw this.fail(`has a count of ${n}, over its limit of ${max}`);
    if (n > this.bytes.length - this.at) this.need(n);
    return n;
  }
}

const utf8 = new TextEncoder(),
  text = new TextDecoder('utf-8', { fatal: true }),
  TAU = 2 * Math.PI;

interface Node {
  write(w: Writer, v: unknown, path: string): void;
  read(r: Reader): unknown;
  same(a: unknown, b: unknown): boolean;
  lerp(a: unknown, b: unknown, t: number): unknown;
  writeDelta?(w: Writer, v: unknown, base: unknown, path: string): void;
  readDelta?(r: Reader, base: unknown): unknown;
}

const step = (a: unknown, b: unknown, t: number): unknown => (t >= 1 ? b : a);
const lerpOf = (mode: Interpolation): ((a: number, b: number, t: number) => number) =>
  mode === 'linear'
    ? (a, b, t) => a + (b - a) * t
    : mode === 'angle'
      ? (a, b, t) => {
          let d = (b - a) % TAU;
          if (d > Math.PI) d -= TAU;
          else if (d <= -Math.PI) d += TAU;
          return a + d * t;
        }
      : (a, b, t) => (t >= 1 ? b : a);

const number = (path: string, v: unknown): number => {
  if (typeof v !== 'number') throw new TypeError(`${path} must be a number, not ${v === null ? 'null' : typeof v}`);
  return v;
};
const integer = (path: string, v: unknown, min: number, max: number): number => {
  if (!Number.isInteger(number(path, v)) || (v as number) < min || (v as number) > max)
    throw new RangeError(`${path} is ${v}, not an integer from ${min} to ${max}; pass a whole number in that range`);
  return v as number;
};

const INTEGERS: Record<string, [number, number, (w: Writer, v: number) => void, (r: Reader) => number]> = {
  u8: [0, 255, (w, v) => w.u8(v), (r) => r.u8()],
  u16: [0, 65535, (w, v) => w.u16(v), (r) => r.u16()],
  u32: [0, 2 ** 32 - 1, (w, v) => w.u32(v), (r) => r.u32()],
  i8: [-128, 127, (w, v) => w.u8(v & 255), (r) => (r.u8() << 24) >> 24],
  i16: [-32768, 32767, (w, v) => w.u16(v & 65535), (r) => (r.u16() << 16) >> 16],
  i32: [-(2 ** 31), 2 ** 31 - 1, (w, v) => w.u32(v >>> 0), (r) => r.u32() | 0],
  uint: [0, 2 ** 32 - 1, (w, v) => w.varint(v), (r) => r.varint()],
  int: [-(2 ** 31), 2 ** 31 - 1, (w, v) => w.varint(zigzag(v)), (r) => unzigzag(r.varint())],
};

/** The quantized integer of `v` for a field with `min`, `max` and `bits` (the formula of README "Wire format"). */
export const quantize = (v: number, min: number, max: number, bits: number): number =>
  Math.round((v - min) * ((2 ** bits - 2) / (max - min)));
/** The value of quantized integer `q` (the formula of README "Wire format"). */
export const dequantize = (q: number, min: number, max: number, bits: number): number =>
  min + (max - min) * (q / (2 ** bits - 2));

function compile(json: NormalizedSchema): Map<string, Node> {
  const structs = new Map<string, Node>();
  const node = (field: NormalizedField): Node => {
    switch (field.type) {
      case 'bool':
        return {
          write(w, v, path) {
            if (typeof v !== 'boolean') throw new TypeError(`${path} must be a boolean`);
            w.u8(v ? 1 : 0);
          },
          read(r) {
            const b = r.u8();
            if (b > 1) throw r.fail(`holds a boolean byte of ${b} at byte ${r.at - 1}`);
            return b === 1;
          },
          same: (a, b) => a === b,
          lerp: step,
        };
      case 'f32':
        return {
          write(w, v, path) {
            if (!Number.isFinite(Math.fround(number(path, v))))
              throw new RangeError(`${path} is ${v}, not a finite 32-bit float; pass a finite number`);
            w.f32(v as number);
          },
          read: (r) => r.f32(),
          same: (a, b) => Math.fround(a as number) === Math.fround(b as number),
          lerp: lerpOf(field.interpolate) as Node['lerp'],
        };
      case 'f64':
        return {
          write(w, v, path) {
            if (!Number.isFinite(number(path, v)))
              throw new RangeError(`${path} is ${v}, not a finite number; pass a finite number`);
            w.f64(v as number);
          },
          read: (r) => r.f64(),
          same: (a, b) => a === b,
          lerp: lerpOf(field.interpolate) as Node['lerp'],
        };
      case 'quantized': {
        const { min, max, bits } = field,
          top = 2 ** bits - 2,
          size = Math.ceil(bits / 8);
        const q = (v: number) => quantize(v, min, max, bits);
        return {
          write(w, v, path) {
            const x = number(path, v);
            if (!(x >= min && x <= max))
              throw new RangeError(`${path} is ${v}, outside its quantized range ${min}..${max}; widen the range`);
            const n = q(x);
            for (let i = 0; i < size; i++) w.u8(Math.floor(n / 2 ** (8 * i)) & 255);
          },
          read(r) {
            let n = 0;
            for (let i = 0; i < size; i++) n += r.u8() * 2 ** (8 * i);
            if (n > top) throw r.fail(`holds quantized step ${n} over its top step ${top} at byte ${r.at - size}`);
            return dequantize(n, min, max, bits);
          },
          same: (a, b) => q(a as number) === q(b as number),
          lerp: lerpOf(field.interpolate) as Node['lerp'],
        };
      }
      case 'string': {
        const max = field.maxLength;
        return {
          write(w, v, path) {
            if (typeof v !== 'string') throw new TypeError(`${path} must be a string`);
            const bytes = utf8.encode(v);
            if (bytes.length > max)
              throw new RangeError(`${path} is ${bytes.length} UTF-8 bytes, over its limit of ${max}; shorten it`);
            w.varint(bytes.length);
            w.raw(bytes);
          },
          read(r) {
            const n = r.count(max);
            r.need(n);
            const at = r.at;
            r.at += n;
            try {
              return text.decode(r.bytes.subarray(at, at + n));
            } catch {
              throw r.fail(`holds text that is not UTF-8 at byte ${at}`);
            }
          },
          same: (a, b) => a === b,
          lerp: step,
        };
      }
      case 'bytes': {
        const max = field.maxLength;
        return {
          write(w, v, path) {
            if (!(v instanceof Uint8Array)) throw new TypeError(`${path} must be a Uint8Array`);
            if (v.length > max)
              throw new RangeError(`${path} is ${v.length} bytes, over its limit of ${max}; shorten it`);
            w.varint(v.length);
            w.raw(v);
          },
          read(r) {
            const n = r.count(max);
            r.need(n);
            r.at += n;
            return r.bytes.slice(r.at - n, r.at);
          },
          same(a, b) {
            const x = a as Uint8Array,
              y = b as Uint8Array;
            if (x.length !== y.length) return false;
            for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
            return true;
          },
          lerp: step,
        };
      }
      case 'enum': {
        const values = field.values,
          index = new Map(values.map((v, i) => [v, i]));
        return {
          write(w, v, path) {
            const i = index.get(v as string);
            if (i === undefined) throw new RangeError(`${path} is ${String(v)}; use one of ${values.join(', ')}`);
            w.varint(i);
          },
          read(r) {
            const i = r.varint();
            if (i >= values.length) throw r.fail(`holds enum index ${i} of only ${values.length} values`);
            return values[i];
          },
          same: (a, b) => a === b,
          lerp: step,
        };
      }
      case 'array': {
        const item = node(field.of),
          max = field.maxLength;
        return {
          write(w, v, path) {
            if (!Array.isArray(v)) throw new TypeError(`${path} must be an array`);
            if (v.length > max)
              throw new RangeError(
                `${path} has ${v.length} items, over its limit of ${max}; send fewer or raise maxLength in the schema`,
              );
            w.varint(v.length);
            for (let i = 0; i < v.length; i++) item.write(w, v[i], `${path}[${i}]`);
          },
          read(r) {
            const n = r.count(max),
              out = new Array(n);
            for (let i = 0; i < n; i++) out[i] = item.read(r);
            return out;
          },
          same(a, b) {
            const x = a as unknown[],
              y = b as unknown[];
            if (x.length !== y.length) return false;
            for (let i = 0; i < x.length; i++) if (!item.same(x[i], y[i])) return false;
            return true;
          },
          lerp(a, b, t) {
            const x = a as unknown[],
              y = b as unknown[];
            return x.length === y.length ? x.map((v, i) => item.lerp(v, y[i], t)) : step(a, b, t);
          },
        };
      }
      case 'optional': {
        const inner = node(field.of);
        return {
          write(w, v, path) {
            if (v === undefined) return w.u8(0);
            w.u8(1);
            inner.write(w, v, path);
          },
          read(r) {
            const flag = r.u8();
            if (flag > 1) throw r.fail(`holds an optional flag of ${flag} at byte ${r.at - 1}`);
            return flag ? inner.read(r) : undefined;
          },
          same: (a, b) => (a === undefined || b === undefined ? a === b : inner.same(a, b)),
          lerp: (a, b, t) => (a === undefined || b === undefined ? step(a, b, t) : inner.lerp(a, b, t)),
        };
      }
      case 'map': {
        const item = node(field.of),
          max = field.maxSize;
        const ids = (path: string, v: unknown): number[] => {
          if (!(v instanceof Map)) throw new TypeError(`${path} must be a Map from entity id to value`);
          if (v.size > max)
            throw new RangeError(
              `${path} has ${v.size} entries, over its limit of ${max}; send fewer or raise maxSize in the schema`,
            );
          const keys = [...v.keys()];
          for (const id of keys) integer(`${path} id`, id, 0, 2 ** 32 - 1);
          return keys.sort((x, y) => x - y);
        };
        const sorted = (entries: [number, unknown][]) => new Map(entries.sort((x, y) => x[0] - y[0]));
        // Strictly increasing ids, each written as the gap after the one before (the first as itself).
        const readIds = (r: Reader, n: number, out: number[]) => {
          for (let i = 0, last = -1; i < n; i++) {
            const id = last + 1 + r.varint();
            if (id > 2 ** 32 - 1) throw r.fail(`holds an entity id over 2^32 - 1 at byte ${r.at}`);
            out.push((last = id));
          }
        };
        const writeIds = (w: Writer, list: number[]) => {
          for (let i = 0, last = -1; i < list.length; last = list[i++]) w.varint(list[i] - last - 1);
        };
        return {
          write(w, v, path) {
            const keys = ids(path, v),
              map = v as Map<number, unknown>;
            w.varint(keys.length);
            writeIds(w, keys);
            for (const id of keys) item.write(w, map.get(id), `${path}(${id})`);
          },
          read(r) {
            const n = r.count(max),
              keys: number[] = [];
            readIds(r, n, keys);
            return new Map(keys.map((id) => [id, item.read(r)]));
          },
          same(a, b) {
            const x = a as Map<number, unknown>,
              y = b as Map<number, unknown>;
            if (x.size !== y.size) return false;
            for (const [id, v] of x) if (!y.has(id) || !item.same(v, y.get(id))) return false;
            return true;
          },
          lerp(a, b, t) {
            const x = a as Map<number, unknown>,
              out = new Map<number, unknown>();
            for (const [id, v] of b as Map<number, unknown>) out.set(id, x.has(id) ? item.lerp(x.get(id), v, t) : v);
            return out;
          },
          writeDelta(w, v, base, path) {
            const keys = ids(path, v),
              map = v as Map<number, unknown>,
              old = base as Map<number, unknown>;
            const removed = [...old.keys()].filter((id) => !map.has(id)).sort((x, y) => x - y);
            const changed = keys.filter((id) => !old.has(id) || !item.same(map.get(id), old.get(id)));
            w.varint(removed.length);
            writeIds(w, removed);
            w.varint(changed.length);
            writeIds(w, changed);
            for (const id of changed) {
              const value = map.get(id);
              if (old.has(id) && item.writeDelta) item.writeDelta(w, value, old.get(id), `${path}(${id})`);
              else item.write(w, value, `${path}(${id})`);
            }
          },
          readDelta(r, base) {
            if (!(base instanceof Map)) throw new TypeError('Delta baseline map must be a Map; pass a decoded value');
            const old = base as Map<number, unknown>,
              removed: number[] = [],
              changed: number[] = [];
            readIds(r, r.count(old.size), removed);
            for (const id of removed) if (!old.has(id)) throw r.fail(`removes entity ${id}, which the baseline lacks`);
            readIds(r, r.count(max), changed);
            const gone = new Set(removed),
              out = new Map(old);
            for (const id of removed) out.delete(id);
            for (const id of changed) {
              if (gone.has(id)) throw r.fail(`both removes and changes entity ${id}`);
              out.set(id, out.has(id) && item.readDelta ? item.readDelta(r, out.get(id)) : item.read(r));
            }
            if (out.size > max) throw r.fail(`leaves ${out.size} entries, over the map limit of ${max}`);
            return sorted([...out]);
          },
        };
      }
      case 'struct': {
        // Late-bound: struct nodes are created once all are known (recursion through arrays, optionals and maps).
        const name = field.name;
        const get = () => structs.get(name) as Node;
        return {
          write: (w, v, path) => get().write(w, v, path),
          read: (r) => get().read(r),
          same: (a, b) => get().same(a, b),
          lerp: (a, b, t) => get().lerp(a, b, t),
          writeDelta: (w, v, base, path) => get().writeDelta?.(w, v, base, path),
          readDelta: (r, base) => get().readDelta?.(r, base),
        };
      }
    }
    const kind = INTEGERS[field.type];
    const [min, max, write, read] = kind;
    return {
      write: (w, v, path) => write(w, integer(path, v, min, max)),
      read,
      same: (a, b) => a === b,
      lerp: step,
    };
  };
  for (const [name, fields] of Object.entries(json.types)) {
    const list = Object.entries(fields).map(([key, field]) => [key, node(field)] as const),
      maskBytes = Math.ceil(list.length / 8);
    const object = (path: string, v: unknown): Record<string, unknown> => {
      if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Map)
        throw new TypeError(`${path} must be a ${name} object`);
      return v as Record<string, unknown>;
    };
    structs.set(name, {
      write(w, v, path) {
        const o = object(path, v);
        for (const [key, field] of list) field.write(w, o[key], `${path}.${key}`);
      },
      read(r) {
        const out: Record<string, unknown> = {};
        for (const [key, field] of list) {
          const value = field.read(r);
          if (value !== undefined) out[key] = value;
        }
        return out;
      },
      same(a, b) {
        const x = a as Record<string, unknown>,
          y = b as Record<string, unknown>;
        if (!x || typeof x !== 'object' || !y || typeof y !== 'object') return false;
        for (const [key, field] of list) if (!field.same(x[key], y[key])) return false;
        return true;
      },
      lerp(a, b, t) {
        const x = a as Record<string, unknown>,
          y = b as Record<string, unknown>,
          out: Record<string, unknown> = {};
        for (const [key, field] of list) {
          const value = field.lerp(x[key], y[key], t);
          if (value !== undefined) out[key] = value;
        }
        return out;
      },
      writeDelta(w, v, base, path) {
        const o = object(path, v),
          old = object('Delta baseline', base),
          mask = new Uint8Array(maskBytes);
        // A field equal to the (decoded, so valid) baseline is valid itself; every other field is written and checked.
        list.forEach(([key, field], i) => {
          if (!field.same(o[key], old[key])) mask[i >> 3] |= 1 << (i & 7);
        });
        w.raw(mask);
        list.forEach(([key, field], i) => {
          if (!(mask[i >> 3] & (1 << (i & 7)))) return;
          if (field.writeDelta && old[key] !== undefined && o[key] !== undefined)
            field.writeDelta(w, o[key], old[key], `${path}.${key}`);
          else field.write(w, o[key], `${path}.${key}`);
        });
      },
      readDelta(r, base) {
        if (!base || typeof base !== 'object') throw new TypeError(`Delta baseline must be a decoded ${name}`);
        const old = base as Record<string, unknown>,
          out: Record<string, unknown> = {};
        r.need(maskBytes);
        const mask = r.bytes.subarray(r.at, r.at + maskBytes);
        r.at += maskBytes;
        if (list.length & 7 && mask[maskBytes - 1] >> (list.length & 7))
          throw r.fail(`sets a change bit past the ${list.length} fields of ${name}`);
        list.forEach(([key, field], i) => {
          let value: unknown;
          if (!(mask[i >> 3] & (1 << (i & 7)))) value = old[key];
          else if (field.readDelta && old[key] !== undefined) value = field.readDelta(r, old[key]);
          else value = field.read(r);
          if (value !== undefined) out[key] = value;
        });
        return out;
      },
    });
  }
  return structs;
}

/**
 * Checks and compiles a schema definition. Write it once, `as const` for full types, and share it between server and
 * client; `schema.json` is the normalized form a generator in another language reads.
 *
 * @example
 * ```ts
 * const schema = defineSchema({
 *   types: {
 *     Input: { x: { type: 'quantized', min: -1, max: 1, bits: 8 }, jump: 'bool' },
 *     Box: { x: 'f32', y: 'f32', owner: 'uint' },
 *     State: { boxes: { type: 'map', of: 'Box', maxSize: 64 } },
 *   },
 * } as const);
 * const bytes = schema.encode('Input', { x: 0.5, jump: true });
 * ```
 * @throws TypeError for an unknown type, a bad name or a struct that contains itself directly; RangeError for a limit
 * or quantized range out of bounds.
 */
export function defineSchema<const S extends SchemaDefinition>(definition: S): Schema<S> {
  const json = normalize(definition),
    structs = compile(json),
    names = Object.keys(json.types) as TypeName<S>[];
  const struct = (name: string): Node => {
    const found = structs.get(name);
    if (!found) throw new TypeError(`Schema has no type '${name}'; use one of ${names.join(', ')}`);
    return found;
  };
  const reader = (name: string, bytes: Uint8Array): Reader => {
    if (!(bytes instanceof Uint8Array)) throw new TypeError(`${name} bytes must be a Uint8Array`);
    return new Reader(bytes, `${name} bytes`, `pass bytes that encode('${name}', ...) returned`);
  };
  const schema: Schema<S> = {
    definition,
    json,
    hash: fnv1a(JSON.stringify(json)),
    names,
    encode(name, value) {
      const w = new Writer();
      struct(name).write(w, value, name);
      return w.done();
    },
    decode(name, bytes) {
      const node = struct(name),
        r = reader(name, bytes),
        value = node.read(r);
      r.end();
      return value as never;
    },
    encodeDelta(name, value, baseline) {
      const w = new Writer();
      (struct(name).writeDelta as NonNullable<Node['writeDelta']>)(w, value, baseline, name);
      return w.done();
    },
    decodeDelta(name, bytes, baseline) {
      const node = struct(name),
        r = reader(name, bytes),
        value = (node.readDelta as NonNullable<Node['readDelta']>)(r, baseline);
      r.end();
      return value as never;
    },
    equals: (name, a, b) => struct(name).same(a, b),
    clone(name, value) {
      return schema.decode(name, schema.encode(name, value));
    },
    interpolate(name, a, b, t) {
      if (!Number.isFinite(t)) throw new RangeError(`Interpolation t is ${t}; pass a finite number from 0 to 1`);
      return struct(name).lerp(a, b, t) as never;
    },
  };
  return schema;
}
