// WGSL types (W3C WGSL specification, section 6) and their memory layout (section 14.4): scalars including the two
// abstract numeric types, vectors, matrices, arrays, structs, atomics, pointers and memory references, samplers and
// every texture kind. Types are plain objects; `typeName` gives the canonical WGSL spelling, which is also the key
// two types are equal by.

/** Scalar types. The abstract ones are the types of untyped literals and constant expressions. */
export type ScalarName = 'bool' | 'i32' | 'u32' | 'f32' | 'f16' | 'abstract-int' | 'abstract-float';

/** A scalar. */
export interface ScalarType {
  readonly kind: 'scalar';
  readonly name: ScalarName;
}
/** `vecN<T>`. */
export interface VectorType {
  readonly kind: 'vector';
  readonly size: 2 | 3 | 4;
  readonly element: ScalarType;
}
/** `matCxR<T>`: C columns of R rows. */
export interface MatrixType {
  readonly kind: 'matrix';
  readonly columns: 2 | 3 | 4;
  readonly rows: 2 | 3 | 4;
  readonly element: ScalarType;
}
/** `array<E, N>`; `count` is a number, `'runtime'` for `array<E>`, or the name of the override that sizes it. */
export interface ArrayType {
  readonly kind: 'array';
  readonly element: Type;
  readonly count: number | 'runtime' | { readonly override: string };
}
/** One member of a struct, with its laid-out offset. */
export interface StructMember {
  readonly name: string;
  readonly type: Type;
  readonly offset: number;
  readonly align: number;
  readonly size: number;
  /** `@location(n)` when declared. */
  readonly location?: number;
  /** `@builtin(name)` when declared. */
  readonly builtin?: string;
  /** `@interpolate(type, sampling)` when declared. */
  readonly interpolate?: readonly string[];
  /** `@invariant`. */
  readonly invariant?: boolean;
  /** `@blend_src(n)`. */
  readonly blendSrc?: number;
}
/** A struct, user-declared or a built-in result struct (`__frexp_result_f32` and the like). */
export interface StructType {
  readonly kind: 'struct';
  readonly name: string;
  readonly members: readonly StructMember[];
  readonly size: number;
  readonly align: number;
}
/** `atomic<T>`. */
export interface AtomicType {
  readonly kind: 'atomic';
  readonly element: ScalarType;
}
/** Address spaces. */
export type AddressSpace = 'function' | 'private' | 'workgroup' | 'uniform' | 'storage' | 'handle';
/** Access modes. */
export type AccessMode = 'read' | 'write' | 'read_write';
/** `ptr<AS, T, AM>` (a value) or a memory reference (the type of a variable name before the Load Rule). */
export interface PointerType {
  readonly kind: 'ptr' | 'ref';
  readonly space: AddressSpace;
  readonly store: Type;
  readonly access: AccessMode;
}
/** `sampler` or `sampler_comparison`. */
export interface SamplerType {
  readonly kind: 'sampler';
  readonly comparison: boolean;
}
/** Texture dimensions. */
export type TextureDimension = '1d' | '2d' | '2d_array' | '3d' | 'cube' | 'cube_array';
/** Every texture kind: sampled, multisampled, depth, depth multisampled, storage and external. */
export interface TextureType {
  readonly kind: 'texture';
  readonly shape: 'sampled' | 'multisampled' | 'depth' | 'depth_multisampled' | 'storage' | 'external';
  readonly dimension: TextureDimension;
  /** Sampled type (f32, i32, u32) of sampled and multisampled textures; the channel type of storage textures. */
  readonly sampled?: ScalarType;
  /** Texel format of a storage texture. */
  readonly format?: string;
  /** Access mode of a storage texture. */
  readonly access?: AccessMode;
}
/** The "type" of a call statement to a function that returns nothing. */
export interface VoidType {
  readonly kind: 'void';
}
/** Any WGSL type. */
export type Type =
  | ScalarType
  | VectorType
  | MatrixType
  | ArrayType
  | StructType
  | AtomicType
  | PointerType
  | SamplerType
  | TextureType
  | VoidType;

const scalars = new Map<ScalarName, ScalarType>();
/** The scalar type named `name` (one shared object per name). */
function scalar(name: ScalarName): ScalarType {
  let t = scalars.get(name);
  if (!t) scalars.set(name, (t = { kind: 'scalar', name }));
  return t;
}
/** The `bool` type. */
export const BOOL = scalar('bool');
/** The `i32` type. */
export const I32 = scalar('i32');
/** The `u32` type. */
export const U32 = scalar('u32');
/** The `f32` type. */
export const F32 = scalar('f32');
/** The `f16` type (needs `enable f16;`). */
export const F16 = scalar('f16');
/** The type of integer literals without a suffix, before materialization. */
export const AINT = scalar('abstract-int');
/** The type of float literals without a suffix, before materialization. */
export const AFLOAT = scalar('abstract-float');
/** The result type of a function that returns nothing. */
export const VOID: VoidType = { kind: 'void' };

/** `vecN<T>`. */
export const vector = (size: 2 | 3 | 4, element: ScalarType): VectorType => ({ kind: 'vector', size, element });
/** `matCxR<T>`. */
export const matrix = (columns: 2 | 3 | 4, rows: 2 | 3 | 4, element: ScalarType): MatrixType => ({
  kind: 'matrix',
  columns,
  rows,
  element,
});

/** The canonical WGSL spelling of a type (`vec3<f32>`, `array<Light, 4>`, `ptr<storage, u32, read>`). */
export function typeName(t: Type): string {
  switch (t.kind) {
    case 'scalar':
      return t.name;
    case 'vector':
      return `vec${t.size}<${t.element.name}>`;
    case 'matrix':
      return `mat${t.columns}x${t.rows}<${t.element.name}>`;
    case 'array':
      return t.count === 'runtime'
        ? `array<${typeName(t.element)}>`
        : `array<${typeName(t.element)}, ${typeof t.count === 'number' ? t.count : t.count.override}>`;
    case 'struct':
      return t.name;
    case 'atomic':
      return `atomic<${t.element.name}>`;
    case 'ptr':
    case 'ref':
      return `${t.kind}<${t.space}, ${typeName(t.store)}, ${t.access}>`;
    case 'sampler':
      return t.comparison ? 'sampler_comparison' : 'sampler';
    case 'texture':
      switch (t.shape) {
        case 'sampled':
          return `texture_${t.dimension}<${t.sampled?.name}>`;
        case 'multisampled':
          return `texture_multisampled_2d<${t.sampled?.name}>`;
        case 'depth':
          return `texture_depth_${t.dimension}`;
        case 'depth_multisampled':
          return 'texture_depth_multisampled_2d';
        case 'storage':
          return `texture_storage_${t.dimension}<${t.format}, ${t.access}>`;
        case 'external':
          return 'texture_external';
      }
      return 'texture';
    case 'void':
      return 'void';
  }
}

/** True when two types are the same type. */
export const sameType = (a: Type, b: Type): boolean => a === b || typeName(a) === typeName(b);

/** The scalar a scalar, vector or matrix is made of; undefined for anything else. */
export function elementOf(t: Type): ScalarType | undefined {
  return t.kind === 'scalar' ? t : t.kind === 'vector' || t.kind === 'matrix' ? t.element : undefined;
}

/** The same shape (scalar, vector or matrix) with another element type. */
export function withElement(t: Type, element: ScalarType): Type {
  if (t.kind === 'vector') return vector(t.size, element);
  if (t.kind === 'matrix') return matrix(t.columns, t.rows, element);
  if (t.kind === 'array' && t.count !== 'runtime')
    return { kind: 'array', element: withElement(t.element, element), count: t.count };
  return element;
}

/** True for the two abstract numeric types. */
export const isAbstract = (s: ScalarType): boolean => s.name === 'abstract-int' || s.name === 'abstract-float';
/** True for f32, f16 and abstract-float. */
export const isFloat = (s: ScalarType): boolean => s.name === 'f32' || s.name === 'f16' || s.name === 'abstract-float';
/** True for i32, u32 and abstract-int. */
export const isInteger = (s: ScalarType): boolean => s.name === 'i32' || s.name === 'u32' || s.name === 'abstract-int';
/** True for every scalar but bool. */
export const isNumeric = (s: ScalarType): boolean => s.name !== 'bool';
/** True for every scalar that can hold a negative value (all but u32 and bool). */
export const isSigned = (s: ScalarType): boolean => s.name !== 'u32' && s.name !== 'bool';

/** True when the type holds an abstract numeric type anywhere (it must be concretized before it is stored). */
export function hasAbstract(t: Type): boolean {
  if (t.kind === 'scalar') return isAbstract(t);
  if (t.kind === 'vector' || t.kind === 'matrix') return isAbstract(t.element);
  if (t.kind === 'array') return hasAbstract(t.element);
  if (t.kind === 'struct') return t.members.some((m) => hasAbstract(m.type));
  return false;
}

/**
 * Whether a value of type `from` converts automatically to `to` (WGSL section 15.7.4, feasible automatic
 * conversions), and at what rank: 0 for the same type, higher for longer conversions, undefined when impossible.
 */
export function conversionRank(from: Type, to: Type): number | undefined {
  if (sameType(from, to)) return 0;
  if (from.kind === 'scalar' && to.kind === 'scalar') {
    if (from.name === 'abstract-int')
      return { 'abstract-float': 5, i32: 3, u32: 4, f32: 6, f16: 7 }[to.name as string] as number | undefined;
    if (from.name === 'abstract-float') return { f32: 1, f16: 2 }[to.name as string] as number | undefined;
    return undefined;
  }
  if (from.kind === 'vector' && to.kind === 'vector' && from.size === to.size)
    return conversionRank(from.element, to.element);
  if (from.kind === 'matrix' && to.kind === 'matrix' && from.columns === to.columns && from.rows === to.rows)
    return conversionRank(from.element, to.element);
  if (from.kind === 'array' && to.kind === 'array' && from.count === to.count && typeof from.count === 'number')
    return conversionRank(from.element, to.element);
  // The abstract result structs of modf and frexp convert to their concrete forms (WGSL section 17.5).
  if (from.kind === 'struct' && to.kind === 'struct' && /^__(modf|frexp)_result_.*abstract$/.test(from.name)) {
    if (from.members.length !== to.members.length) return undefined;
    let rank = 0;
    for (const [i, m] of from.members.entries()) {
      const r = conversionRank(m.type, to.members[i].type);
      if (r === undefined || m.name !== to.members[i].name) return undefined;
      rank = Math.max(rank, r);
    }
    return rank;
  }
  return undefined;
}

/** The concrete type an abstract type becomes when nothing else decides (i32 for ints, f32 for floats). */
export function concretize(t: Type): Type {
  if (t.kind === 'scalar') return t.name === 'abstract-int' ? I32 : t.name === 'abstract-float' ? F32 : t;
  if (t.kind === 'vector' || t.kind === 'matrix') return withElement(t, concretize(t.element) as ScalarType);
  if (t.kind === 'array' && t.count !== 'runtime')
    return { kind: 'array', element: concretize(t.element), count: t.count };
  if (t.kind === 'struct' && hasAbstract(t))
    return layoutStruct(
      t.name.replace(/abstract$/, 'f32'),
      t.members.map((m) => ({ name: m.name, type: concretize(m.type) })),
    );
  return t;
}

/** True for types a variable can store and a value can have: scalars to structs and atomics (WGSL "storable"). */
export const isStorable = (t: Type): boolean =>
  t.kind === 'scalar' ||
  t.kind === 'vector' ||
  t.kind === 'matrix' ||
  t.kind === 'array' ||
  t.kind === 'struct' ||
  t.kind === 'atomic' ||
  t.kind === 'sampler' ||
  t.kind === 'texture';

/** True when values of the type can be built and copied: no atomics, no runtime-sized arrays (WGSL "constructible"). */
export function isConstructible(t: Type): boolean {
  if (t.kind === 'scalar' || t.kind === 'vector' || t.kind === 'matrix') return true;
  if (t.kind === 'array') return typeof t.count === 'number' && isConstructible(t.element);
  if (t.kind === 'struct') return t.members.every((m) => isConstructible(m.type));
  return false;
}

/** True when the type is host-shareable: it can live in a uniform or storage buffer. */
export function isHostShareable(t: Type): boolean {
  if (t.kind === 'scalar') return t.name !== 'bool' && !isAbstract(t);
  if (t.kind === 'vector' || t.kind === 'matrix' || t.kind === 'atomic') return isHostShareable(t.element);
  if (t.kind === 'array') return isHostShareable(t.element);
  if (t.kind === 'struct') return t.members.every((m) => isHostShareable(m.type));
  return false;
}

const roundUp = (k: number, n: number) => Math.ceil(n / k) * k;

/** AlignOf (WGSL section 14.4.1). Bool and abstract types get a scalar's alignment for function-scope layout. */
export function alignOf(t: Type): number {
  switch (t.kind) {
    case 'scalar':
      return t.name === 'f16' ? 2 : 4;
    case 'atomic':
      return 4;
    case 'vector':
      return (t.size === 2 ? 2 : 4) * alignOf(t.element);
    case 'matrix':
      return alignOf(vector(t.rows, t.element));
    case 'array':
      return alignOf(t.element);
    case 'struct':
      return t.align;
    default:
      return 4;
  }
}

/** SizeOf (WGSL section 14.4.1); a runtime-sized array counts one element. */
export function sizeOf(t: Type): number {
  switch (t.kind) {
    case 'scalar':
      return t.name === 'f16' ? 2 : 4;
    case 'atomic':
      return 4;
    case 'vector':
      return t.size * sizeOf(t.element);
    case 'matrix':
      return t.columns * roundUp(alignOf(vector(t.rows, t.element)), sizeOf(vector(t.rows, t.element)));
    case 'array':
      return (typeof t.count === 'number' ? t.count : 1) * strideOf(t);
    case 'struct':
      return t.size;
    default:
      return 0;
  }
}

/** The element stride of an array type. */
const strideOf = (t: ArrayType): number => roundUp(alignOf(t.element), sizeOf(t.element));

/** Lays out struct members: each at the next multiple of its alignment, `@align` and `@size` applied. */
export function layoutStruct(
  name: string,
  members: readonly (Omit<StructMember, 'offset' | 'align' | 'size'> & { align?: number; size?: number })[],
): StructType {
  let offset = 0,
    align = 1;
  const out: StructMember[] = [];
  for (const m of members) {
    const a = m.align ?? alignOf(m.type),
      s = m.size ?? sizeOf(m.type);
    offset = roundUp(a, offset);
    out.push({ ...m, offset, align: a, size: s });
    offset += s;
    align = Math.max(align, a);
  }
  return { kind: 'struct', name, members: out, size: roundUp(align, offset), align };
}

/** Texel formats of storage textures (WGSL section 6.5.5) and the channel type each one reads as. */
export const STORAGE_FORMATS: Readonly<Record<string, 'f32' | 'i32' | 'u32'>> = {
  rgba8unorm: 'f32',
  rgba8snorm: 'f32',
  rgba8uint: 'u32',
  rgba8sint: 'i32',
  rgba16uint: 'u32',
  rgba16sint: 'i32',
  rgba16float: 'f32',
  rgba16unorm: 'f32',
  rgba16snorm: 'f32',
  r32uint: 'u32',
  r32sint: 'i32',
  r32float: 'f32',
  rg32uint: 'u32',
  rg32sint: 'i32',
  rg32float: 'f32',
  rgba32uint: 'u32',
  rgba32sint: 'i32',
  rgba32float: 'f32',
  bgra8unorm: 'f32',
  r8unorm: 'f32',
  r8snorm: 'f32',
  r8uint: 'u32',
  r8sint: 'i32',
  rg8unorm: 'f32',
  rg8snorm: 'f32',
  rg8uint: 'u32',
  rg8sint: 'i32',
  r16uint: 'u32',
  r16sint: 'i32',
  r16float: 'f32',
  r16unorm: 'f32',
  r16snorm: 'f32',
  rg16uint: 'u32',
  rg16sint: 'i32',
  rg16float: 'f32',
  rg16unorm: 'f32',
  rg16snorm: 'f32',
  rgb10a2uint: 'u32',
  rgb10a2unorm: 'f32',
  rg11b10ufloat: 'f32',
};
