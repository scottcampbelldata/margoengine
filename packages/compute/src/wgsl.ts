// Reads what a WGSL module declares, so kernels can bind resources by name and lay out uniform structs from plain
// objects. Written from the WGSL specification (W3C, "WebGPU Shading Language": 4.6 resource interface, 6.2 types,
// 13.4 alignment and size). It is not a WGSL parser: it reads module-scope declarations only, which is all binding
// needs, and leaves full validation to the device compiler.
import { rangeError, typeError } from '../../shared/errors.js';
import { f16Bits } from '../../shared/f16.js';

/** The layout of a WGSL type in host-shareable memory (WGSL 13.4). */
export interface TypeLayout {
  /** The type as written after alias resolution, such as `vec3<f32>` or `Params`. */
  readonly name: string;
  readonly kind: 'scalar' | 'vector' | 'matrix' | 'array' | 'struct' | 'atomic';
  readonly align: number;
  /** Size in bytes; for a runtime-sized array, the size of one element stride (count it per element). */
  readonly size: number;
  /** Scalar component type for scalars, vectors, matrices and atomics. */
  readonly scalar?: 'f32' | 'i32' | 'u32' | 'f16';
  /** Vector width, or a matrix's row count. */
  readonly rows?: number;
  /** A matrix's column count. */
  readonly columns?: number;
  /** An array's element layout and stride; `count` 0 for a runtime-sized array. */
  readonly element?: TypeLayout;
  readonly stride?: number;
  readonly count?: number;
  /** A struct's members with their byte offsets. */
  readonly members?: readonly { readonly name: string; readonly offset: number; readonly layout: TypeLayout }[];
}

/** One `@group @binding` resource a module declares. */
export interface BindingInfo {
  readonly name: string;
  readonly group: number;
  readonly binding: number;
  /** Resource kind as a bind group layout entry needs it. */
  readonly resource: 'uniform' | 'storage' | 'read-only-storage' | 'texture' | 'storage-texture' | 'sampler';
  /** The declared type as written. */
  readonly type: string;
  /** Layout of a buffer binding's type (absent for textures and samplers, or when a type cannot be resolved). */
  readonly layout?: TypeLayout;
  /** Texture details: view dimension, sample type, storage format and access. */
  readonly texture?: {
    readonly viewDimension: GPUTextureViewDimension;
    readonly sampleType?: GPUTextureSampleType;
    readonly multisampled?: boolean;
    readonly format?: GPUTextureFormat;
    readonly access?: GPUStorageTextureAccess;
  };
  /** A sampler's type: `filtering` for `sampler`, `comparison` for `sampler_comparison`. */
  readonly sampler?: GPUSamplerBindingType;
}

/** One `@compute` entry point. */
export interface EntryPointInfo {
  readonly name: string;
  readonly workgroupSize: readonly [number, number, number];
}

/** What a WGSL module declares at module scope. */
export interface ModuleInfo {
  readonly bindings: readonly BindingInfo[];
  readonly entryPoints: readonly EntryPointInfo[];
}

const SCALARS = new Set(['f32', 'i32', 'u32', 'f16', 'bool']);
// WGSL predeclared aliases (vec3f, mat4x4f, ...).
const SUFFIX: Record<string, string> = { f: 'f32', i: 'i32', u: 'u32', h: 'f16' };

/** Removes comments (line and nested block comments) so declarations can be read with simple patterns. */
function stripComments(code: string): string {
  let out = '',
    depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i],
      n = code[i + 1];
    if (depth === 0 && c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      depth++;
      i++;
    } else if (depth > 0 && c === '*' && n === '/') {
      depth--;
      i++;
    } else if (depth === 0) out += c;
    else if (c === '\n') out += '\n';
  }
  return out;
}

/** Splits `a, b<c, d>, e` at top-level commas. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<' || c === '(') depth++;
    else if (c === '>' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

const roundUp = (k: number, n: number) => Math.ceil(n / k) * k;

interface Declarations {
  aliases: Map<string, string>;
  structs: Map<string, { name: string; type: string; align?: number; size?: number }[]>;
  constants: Map<string, string>;
}

function declarations(code: string): Declarations {
  const aliases = new Map<string, string>(),
    structs = new Map<string, { name: string; type: string; align?: number; size?: number }[]>(),
    constants = new Map<string, string>();
  for (const m of code.matchAll(/\balias\s+(\w+)\s*=\s*([^;]+);/g)) aliases.set(m[1], m[2].trim());
  for (const m of code.matchAll(/\b(?:const|override)\s+(\w+)\s*(?::\s*\w+\s*)?=\s*([^;]+);/g))
    constants.set(m[1], m[2].trim());
  for (const m of code.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}/g)) {
    const members = [];
    for (const part of splitTop(m[2])) {
      const member = /^((?:@\w+(?:\([^)]*\))?\s*)*)(\w+)\s*:\s*(.+)$/s.exec(part);
      if (!member) continue;
      const attributes = member[1],
        align = /@align\(\s*(\d+)\s*\)/.exec(attributes),
        size = /@size\(\s*(\d+)\s*\)/.exec(attributes);
      members.push({
        name: member[2],
        type: member[3].trim(),
        align: align ? Number(align[1]) : undefined,
        size: size ? Number(size[1]) : undefined,
      });
    }
    structs.set(m[1], members);
  }
  return { aliases, structs, constants };
}

/** Evaluates a constant integer expression the way array counts and workgroup sizes use them. */
function integer(text: string, d: Declarations, seen = new Set<string>()): number | undefined {
  const t = text.trim();
  const literal = /^(0[xX][0-9a-fA-F]+|\d+)[iu]?$/.exec(t);
  if (literal) return Number(literal[1]);
  if (/^\w+$/.test(t) && d.constants.has(t) && !seen.has(t)) {
    seen.add(t);
    return integer(d.constants.get(t)!, d, seen);
  }
  return undefined;
}

/** Splits `name<args>` into its name and top-level template arguments. */
function template(type: string): { base: string; args: string[] } {
  const t = type.trim(),
    open = t.indexOf('<');
  if (open < 0) return { base: t, args: [] };
  return { base: t.slice(0, open).trim(), args: splitTop(t.slice(open + 1, t.lastIndexOf('>'))) };
}

function layoutOf(type: string, d: Declarations, depth = 0): TypeLayout | undefined {
  if (depth > 32) return undefined;
  let t = type.trim();
  while (d.aliases.has(t)) t = d.aliases.get(t)!;
  // Predeclared aliases: vec3f, vec4u, mat4x4f, ...
  const short = /^(vec[234]|mat[234]x[234])([fiuh])$/.exec(t);
  if (short) t = `${short[1]}<${SUFFIX[short[2]]}>`;
  const { base, args } = template(t);
  if (SCALARS.has(base)) {
    if (base === 'bool') return undefined; // not host-shareable
    const size = base === 'f16' ? 2 : 4;
    return { name: base, kind: 'scalar', align: size, size, scalar: base as TypeLayout['scalar'] };
  }
  if (base === 'atomic') {
    const inner = layoutOf(args[0] ?? '', d, depth + 1);
    return inner && { ...inner, name: t, kind: 'atomic' };
  }
  const vec = /^vec([234])$/.exec(base);
  if (vec) {
    const n = Number(vec[1]),
      scalar = layoutOf(args[0] ?? '', d, depth + 1);
    if (!scalar || scalar.kind !== 'scalar') return undefined;
    const s = scalar.size;
    return {
      name: t,
      kind: 'vector',
      align: (n === 2 ? 2 : 4) * s,
      size: n * s,
      scalar: scalar.scalar,
      rows: n,
    };
  }
  const mat = /^mat([234])x([234])$/.exec(base);
  if (mat) {
    const columns = Number(mat[1]),
      rows = Number(mat[2]),
      column = layoutOf(`vec${rows}<${args[0]}>`, d, depth + 1);
    if (!column) return undefined;
    const stride = roundUp(column.align, column.size);
    return {
      name: t,
      kind: 'matrix',
      align: column.align,
      size: columns * stride,
      scalar: column.scalar,
      rows,
      columns,
      stride,
    };
  }
  if (base === 'array') {
    const element = layoutOf(args[0] ?? '', d, depth + 1);
    if (!element) return undefined;
    const stride = roundUp(element.align, element.size),
      count = args[1] === undefined ? 0 : integer(args[1], d);
    if (count === undefined) return undefined;
    return {
      name: t,
      kind: 'array',
      align: element.align,
      size: count === 0 ? stride : count * stride,
      element,
      stride,
      count,
    };
  }
  const members = d.structs.get(base);
  if (members) {
    let offset = 0,
      align = 1;
    const laid = [];
    for (const member of members) {
      const layout = layoutOf(member.type, d, depth + 1);
      if (!layout) return undefined;
      const a = member.align ?? layout.align;
      offset = roundUp(a, offset);
      laid.push({ name: member.name, offset, layout });
      offset += member.size ?? layout.size;
      align = Math.max(align, a);
    }
    return { name: base, kind: 'struct', align, size: roundUp(align, offset), members: laid };
  }
  return undefined;
}

const DIMENSION: Record<string, GPUTextureViewDimension> = {
  '1d': '1d',
  '2d': '2d',
  '2d_array': '2d-array',
  '3d': '3d',
  cube: 'cube',
  cube_array: 'cube-array',
};
const SAMPLE: Record<string, GPUTextureSampleType> = { f32: 'float', i32: 'sint', u32: 'uint' };

function textureInfo(type: string): BindingInfo['texture'] | undefined {
  const { base, args } = template(type);
  const storage = /^texture_storage_(1d|2d|2d_array|3d)$/.exec(base);
  if (storage) {
    const access = ({ read: 'read-only', write: 'write-only', read_write: 'read-write' } as const)[
      (args[1] ?? 'write') as 'read' | 'write' | 'read_write'
    ];
    return { viewDimension: DIMENSION[storage[1]], format: args[0] as GPUTextureFormat, access };
  }
  const depth = /^texture_depth_(multisampled_)?(2d|2d_array|cube|cube_array)$/.exec(base);
  if (depth) return { viewDimension: DIMENSION[depth[2]], sampleType: 'depth', multisampled: !!depth[1] };
  const sampled = /^texture_(multisampled_)?(1d|2d|2d_array|3d|cube|cube_array)$/.exec(base);
  if (sampled)
    return {
      viewDimension: DIMENSION[sampled[2]],
      // An f32 texture binds as unfilterable-float in a compute kernel unless it is sampled with a filtering
      // sampler; 'float' accepts both filterable formats and the common rgba8/rgba16float, so it is the default.
      sampleType: SAMPLE[args[0] ?? 'f32'] ?? 'float',
      multisampled: !!sampled[1],
    };
  return undefined;
}

/**
 * Reads a WGSL module's resource bindings (with buffer layouts) and compute entry points (with workgroup sizes).
 * Throws a TypeError for a declaration it cannot read, such as a binding whose group or index is not a literal.
 */
export function reflectWGSL(code: string): ModuleInfo {
  const text = stripComments(code),
    d = declarations(text),
    bindings: BindingInfo[] = [],
    entryPoints: EntryPointInfo[] = [];
  const decl = /((?:@\w+\s*(?:\([^)]*\))?\s*)+)var\s*(?:<\s*([\w\s,]+)\s*>)?\s*(\w+)\s*:\s*([^;=]+?)\s*;/g;
  for (const m of text.matchAll(decl)) {
    const attributes = m[1],
      group = /@group\(\s*([^)]+)\)/.exec(attributes),
      binding = /@binding\(\s*([^)]+)\)/.exec(attributes);
    if (!group || !binding) continue;
    const g = integer(group[1], d),
      b = integer(binding[1], d);
    if (g === undefined || b === undefined)
      throw typeError(`Kernel binding ${m[3]} has a group or binding that is not a constant integer`, 'compute');
    const space = (m[2] ?? '').split(',').map((s) => s.trim()),
      name = m[3],
      type = m[4].trim();
    if (space[0] === 'uniform')
      bindings.push({ name, group: g, binding: b, resource: 'uniform', type, layout: layoutOf(type, d) });
    else if (space[0] === 'storage')
      bindings.push({
        name,
        group: g,
        binding: b,
        resource: space[1] === 'read_write' ? 'storage' : 'read-only-storage',
        type,
        layout: layoutOf(type, d),
      });
    else if (/^sampler(_comparison)?$/.test(type))
      bindings.push({
        name,
        group: g,
        binding: b,
        resource: 'sampler',
        type,
        sampler: type === 'sampler' ? 'filtering' : 'comparison',
      });
    else {
      const texture = textureInfo(type);
      if (!texture) throw typeError(`Kernel binding ${name} has a type the kernel cannot bind: ${type}`, 'compute');
      bindings.push({
        name,
        group: g,
        binding: b,
        resource: texture.format ? 'storage-texture' : 'texture',
        type,
        texture,
      });
    }
  }
  const entry = /@compute\s*((?:@\w+\s*(?:\([^)]*\))?\s*)*)fn\s+(\w+)|((?:@\w+\s*(?:\([^)]*\))?\s*)+)fn\s+(\w+)/g;
  for (const m of text.matchAll(entry)) {
    const attributes = m[1] ?? m[3] ?? '',
      name = m[2] ?? m[4];
    if (m[3] !== undefined && !/@compute\b/.test(attributes)) continue;
    const size = /@workgroup_size\(([^)]*)\)/.exec(attributes);
    const dims = size ? splitTop(size[1]).map((s) => integer(s, d)) : [1];
    if (dims.some((v) => v === undefined))
      throw typeError(`Kernel entry point ${name} has a workgroup size that is not a constant integer`, 'compute');
    entryPoints.push({
      name,
      workgroupSize: [dims[0] ?? 1, dims[1] ?? 1, dims[2] ?? 1] as [number, number, number],
    });
  }
  bindings.sort((a, b) => a.group - b.group || a.binding - b.binding);
  return { bindings, entryPoints };
}

/** A value a uniform or storage struct field accepts: a number, a vector or matrix as numbers, or nested values. */
export type HostValue =
  | number
  | boolean
  | ArrayLike<number>
  | readonly HostValue[]
  | { readonly [key: string]: HostValue };

/**
 * Writes `value` into `view` at `offset` with the layout's rules: vectors take arrays, matrices take column-major
 * arrays (padding each column to its stride), structs take objects with every member, arrays take arrays.
 */
function writeValue(view: DataView, offset: number, layout: TypeLayout, value: HostValue, path: string): void {
  const scalar = (at: number, kind: TypeLayout['scalar'], v: unknown) => {
    const n = typeof v === 'boolean' ? Number(v) : v;
    if (typeof n !== 'number') throw typeError(`Uniform ${path} needs a number, got ${typeof v}`, 'compute');
    if (kind === 'f32') view.setFloat32(at, n, true);
    else if (kind === 'f16') view.setUint16(at, f16Bits(n), true);
    else {
      const [low, high] = kind === 'i32' ? [-0x80000000, 0x7fffffff] : [0, 0xffffffff];
      if (!Number.isInteger(n) || n < low || n > high)
        throw rangeError(`Uniform ${path} needs an integer from ${low} to ${high}, got ${n}`, 'compute');
      if (kind === 'i32') view.setInt32(at, n, true);
      else view.setUint32(at, n, true);
    }
  };
  const list = (v: unknown, length: number): ArrayLike<number> => {
    if (typeof v !== 'object' || v === null || typeof (v as ArrayLike<number>).length !== 'number')
      throw typeError(`Uniform ${path} needs an array of ${length} numbers`, 'compute');
    const items = v as ArrayLike<number>;
    if (items.length !== length)
      throw typeError(`Uniform ${path} needs ${length} numbers, got ${items.length}`, 'compute');
    return items;
  };
  const width = layout.scalar === 'f16' ? 2 : 4;
  switch (layout.kind) {
    case 'scalar':
    case 'atomic':
      return scalar(offset, layout.scalar, value);
    case 'vector': {
      const items = list(value, layout.rows!);
      for (let i = 0; i < layout.rows!; i++) scalar(offset + i * width, layout.scalar, items[i]);
      return;
    }
    case 'matrix': {
      const items = list(value, layout.rows! * layout.columns!);
      for (let c = 0; c < layout.columns!; c++)
        for (let r = 0; r < layout.rows!; r++)
          scalar(offset + c * layout.stride! + r * width, layout.scalar, items[c * layout.rows! + r]);
      return;
    }
    case 'array': {
      const element = layout.element!,
        items = value as ArrayLike<HostValue>;
      if (typeof items !== 'object' || items === null || typeof items.length !== 'number')
        throw typeError(`Uniform ${path} needs an array`, 'compute');
      if (layout.count && items.length !== layout.count)
        throw typeError(`Uniform ${path} needs ${layout.count} items, got ${items.length}`, 'compute');
      for (let i = 0; i < items.length; i++)
        writeValue(view, offset + i * layout.stride!, element, items[i], `${path}[${i}]`);
      return;
    }
    case 'struct': {
      if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value) || Array.isArray(value))
        throw typeError(`Uniform ${path} needs an object with the struct's members`, 'compute');
      const record = value as Record<string, HostValue>;
      for (const member of layout.members!) {
        if (!(member.name in record))
          throw typeError(`Uniform ${path}.${member.name} is missing; pass every struct member`, 'compute');
        writeValue(view, offset + member.offset, member.layout, record[member.name], `${path}.${member.name}`);
      }
    }
  }
}

/** The bytes a host value needs for `layout`, with `length` items for a runtime-sized array. */
function byteSize(layout: TypeLayout, length = 0): number {
  return layout.kind === 'array' && layout.count === 0 ? layout.stride! * length : layout.size;
}

/** Encodes `value` as host-shareable bytes laid out as `layout` (rounded up to 16 bytes, the uniform minimum). */
export function encode(layout: TypeLayout, value: HostValue, name = 'value'): Uint8Array<ArrayBuffer> {
  const length = layout.kind === 'array' && layout.count === 0 ? (value as ArrayLike<unknown>).length : 0;
  const bytes = new Uint8Array(roundUp(16, Math.max(byteSize(layout, length), 4)));
  writeValue(new DataView(bytes.buffer), 0, layout, value, name);
  return bytes;
}
