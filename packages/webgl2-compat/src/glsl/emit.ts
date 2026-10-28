// The GLSL ES 3.00 back end (roadmap milestone M2): one WGSL vertex or fragment entry point, from the typed IR of the
// front end, to a GLSL ES 3.00 shader plus the table the device binds resources by. Written clean room from the W3C
// WGSL specification and the Khronos GLSL ES 3.00 specification; no other translator's source was read.
//
// Conventions the device relies on:
// - Every name the module declares is renamed (`q` + an injective ASCII encoding; locals get a numeric suffix), so no
//   WGSL name can collide with a GLSL keyword, built-in or generated name (generated names start with `_`).
// - Uniform buffers are std140 blocks of `uvec4` words read back into WGSL's own layout, so every WGSL host-shareable
//   layout (offsets, `@size`, `@align`, strides, nested structs, matCx2) is exact. Each stage names its blocks apart.
// - Each (texture, sampler) pair a stage samples with becomes one combined sampler; `textureLoad` and friends use a
//   (texture, no sampler) pair.
// - Rendering is flipped in y (row 0 is the top of every target, as in WebGPU) and, without EXT_clip_control, z is
//   mapped from [0, w] to [-w, w] at the end of the vertex shader.
// - Integer division and remainder, float remainder, float to integer conversion, out-of-bounds indexes and shift
//   amounts follow WGSL, through helpers where GLSL leaves the result undefined.
import { fault } from '../../../shared/errors.js';
import type {
  ConstValue,
  IREntryPoint,
  IRExpr,
  IRFunction,
  IRGlobalConst,
  IRGlobalVar,
  IRLocal,
  IRModule,
  IROverride,
  IRParam,
  IRStmt,
} from '../wgsl/ir.js';
import {
  alignOf,
  type ArrayType,
  type ScalarType,
  type StructType,
  sizeOf,
  type TextureType,
  type Type,
  typeName,
  vector,
} from '../wgsl/types.js';
import { HELPERS } from './helpers.js';

/** Thrown for WGSL the layer cannot translate (yet): coded `unsupported`, naming what and the milestone. */
const unsupported = (what: string): Error =>
  fault('unsupported', `WebGL2 compatibility cannot translate ${what}`, 'compatibility-layer');

/** Numeric class of a value as GLSL sees it. */
export type GLSLKind = 'float' | 'sint' | 'uint';

/** A uniform buffer the stage reads. */
export interface GLSLUniform {
  readonly group: number;
  readonly binding: number;
  /** GLSL block name. */
  readonly block: string;
  /** Bytes the block declares (16 times its word count): the device binds at least this many. */
  readonly size: number;
  /** Bytes WGSL needs (the variable's store type size): the minimum binding size. */
  readonly minSize: number;
}
/** A combined sampler: one texture with one sampler (or none, for loads and queries). */
export interface GLSLTexture {
  readonly group: number;
  readonly binding: number;
  readonly sampler?: { readonly group: number; readonly binding: number; readonly comparison: boolean };
  /** GLSL uniform name of the combined sampler. */
  readonly name: string;
  /** Mip-level-count uniform name, when the shader needs it (textureNumLevels, robust textureLoad). */
  readonly levels?: string;
  /**
   * textureGather reads texels by hand: the `ivec4` uniform of this name holds the address modes and comparison of
   * the sampler at this binding (u, v, w: 0 clamp-to-edge, 1 repeat, 2 mirror-repeat; then 0 or the compare function).
   */
  readonly gather?: { readonly name: string; readonly group: number; readonly binding: number };
  readonly type: TextureType;
  /** GLSL sampler type (`sampler2D`, `usampler2DArray`, `sampler2DShadow`...). */
  readonly glslType: string;
}
/** A vertex input or fragment output location. */
export interface GLSLLocation {
  readonly location: number;
  readonly kind: GLSLKind;
  readonly components: number;
}
/** A varying between the stages. */
export interface GLSLVarying {
  readonly location: number;
  readonly glslType: string;
  readonly interpolation: 'perspective' | 'linear' | 'flat';
  readonly sampling?: string;
}
/** One translated stage. */
export interface GLSLStage {
  readonly stage: 'vertex' | 'fragment';
  readonly source: string;
  readonly uniforms: readonly GLSLUniform[];
  readonly textures: readonly GLSLTexture[];
  /** Vertex inputs (vertex stage). */
  readonly inputs: readonly GLSLLocation[];
  /** Fragment outputs (fragment stage). */
  readonly outputs: readonly GLSLLocation[];
  /** Varyings the stage writes (vertex) or reads (fragment). */
  readonly varyings: readonly GLSLVarying[];
  /** Name of the `uint` uniform holding the draw's base vertex, when `vertex_index` is read. */
  readonly baseVertex?: string;
  /** Name of the `uint` uniform holding the draw's first instance, when `instance_index` is read. */
  readonly baseInstance?: string;
  /** True when the fragment stage writes `frag_depth`. */
  readonly fragDepth: boolean;
  /** Notes on WGSL behaviour WebGL2 cannot give exactly (sample masks dropped and the like). */
  readonly notes: readonly string[];
}

/** Options for {@link emitStage}. */
interface EmitOptions {
  /** Pipeline-overridable constants by name or `@id`, as WebGPU's `constants`. */
  readonly constants?: Readonly<Record<string, number | boolean>>;
  /** EXT_clip_control (ZERO_TO_ONE) is on: keep z as WebGPU writes it. Default true. */
  readonly clipControl?: boolean;
  /** The pipeline draws points: write `gl_PointSize = 1.0`. */
  readonly points?: boolean;
  /** Vertex stage: only these varying locations are read by the fragment stage (others are not written). */
  readonly varyingsRead?: ReadonlySet<number>;
  /** Fragment stage: the varyings the vertex stage writes, to match types and interpolation. */
  readonly varyings?: readonly GLSLVarying[];
  /** Prefix of generated uniform names, unique per stage (default `v` or `f`). */
  readonly prefix?: string;
}

type Ref =
  | { readonly kind: 'lvalue'; readonly code: string; readonly type: Type }
  | {
      readonly kind: 'buffer';
      readonly v: IRGlobalVar;
      /** Constant byte offset. */
      readonly base: number;
      /** Dynamic offset terms in whole 16-byte rows (GLSL int expressions). */
      readonly rows: readonly string[];
      /** Dynamic offset terms in 4-byte words (GLSL int expressions): vector components, matCx2 columns. */
      readonly dyn: readonly string[];
      readonly type: Type;
    };

const ID = /^[A-Za-z0-9]$/;
/** Injective ASCII encoding of a WGSL identifier: `_` becomes `_u`, anything outside [A-Za-z0-9] `_x<hex>x`. */
export function encodeName(name: string): string {
  let out = '';
  for (const ch of name) {
    if (ID.test(ch)) out += ch;
    else if (ch === '_') out += '_u';
    else out += `_x${(ch.codePointAt(0) as number).toString(16)}x`;
  }
  return out;
}

const SWIZZLE = 'xyzw';

/** GLSL text of an f32 value that parses back to the same f32. */
export function floatLiteral(v: number): string {
  if (Object.is(v, -0)) return '-0.0';
  if (!Number.isFinite(v)) throw unsupported(`the non-finite constant ${v}`);
  const f = Math.fround(v);
  let text = String(f);
  if (Math.fround(Number(text)) !== f || text.length > 12)
    for (let p = 1; p <= 9; p++) {
      const t = f.toPrecision(p);
      if (Math.fround(Number(t)) === f) {
        text = t;
        break;
      }
    }
  if (!/[.e]/.test(text)) text += '.0';
  else if (/^-?\d+e/.test(text)) text = text.replace('e', '.0e');
  return text;
}

const intLiteral = (v: number): string => (v === -2147483648 ? '(-2147483647 - 1)' : v < 0 ? `(${v})` : `${v}`);
const uintLiteral = (v: number): string => `${v >>> 0}u`;

/** The GLSL scalar of a WGSL scalar (f16 and abstract floats compute as highp float). */
function scalarName(s: ScalarType): string {
  switch (s.name) {
    case 'bool':
      return 'bool';
    case 'i32':
    case 'abstract-int':
      return 'int';
    case 'u32':
      return 'uint';
    default:
      return 'float';
  }
}
const vecPrefix = (s: ScalarType): string =>
  s.name === 'bool' ? 'b' : s.name === 'i32' || s.name === 'abstract-int' ? 'i' : s.name === 'u32' ? 'u' : '';
const kindOf = (s: ScalarType): GLSLKind =>
  s.name === 'i32' || s.name === 'abstract-int' ? 'sint' : s.name === 'u32' ? 'uint' : 'float';
const isInt = (s: ScalarType) => s.name === 'i32' || s.name === 'abstract-int';
const isUint = (s: ScalarType) => s.name === 'u32';
const isFloatS = (s: ScalarType) => s.name === 'f32' || s.name === 'f16' || s.name === 'abstract-float';

function elementOfT(t: Type): ScalarType | undefined {
  return t.kind === 'scalar' ? t : t.kind === 'vector' || t.kind === 'matrix' ? t.element : undefined;
}

/** Strips memory references and pointers to the stored type. */
const storeOf = (t: Type): Type => (t.kind === 'ref' || t.kind === 'ptr' ? t.store : t);

const roundUp = (k: number, n: number) => Math.ceil(n / k) * k;
const strideOf = (t: ArrayType): number => roundUp(alignOf(t.element), sizeOf(t.element));

/** True when evaluating the expression cannot change state (it calls no user function). */
function pure(e: IRExpr): boolean {
  switch (e.kind) {
    case 'call':
      return false;
    case 'literal':
    case 'name':
      return true;
    case 'load':
    case 'address-of':
      return pure(e.ref);
    case 'deref':
      return pure(e.pointer);
    case 'construct':
    case 'builtin':
      return e.args.every(pure);
    case 'convert':
    case 'bitcast':
      return pure(e.arg);
    case 'member':
    case 'swizzle':
      return pure(e.object);
    case 'index':
      return pure(e.object) && pure(e.index);
    case 'unary':
      return pure(e.operand);
    case 'binary':
      return pure(e.left) && pure(e.right);
  }
}

/**
 * True when `code` is a single postfix expression: a name, number, call, or bracketed expression, each followed by
 * any `.member` and `[index]`, so another `.x`, `[i]` or unary operator applies to all of it.
 */
function postfix(code: string): boolean {
  let i = 0;
  const n = code.length;
  const close = (open: string, shut: string): boolean => {
    let depth = 0;
    for (; i < n; i++) {
      const c = code[i];
      if (c === open) depth++;
      else if (c === shut && --depth === 0) {
        i++;
        return true;
      }
    }
    return false;
  };
  if (code[0] === '(') {
    if (!close('(', ')')) return false;
  } else {
    const m = /^[A-Za-z_][\w]*|^-?[\d.]+(e[+-]?\d+)?u?/.exec(code);
    if (!m || m[0].startsWith('-')) return false;
    i = m[0].length;
    if (code[i] === '(' && !close('(', ')')) return false;
  }
  while (i < n) {
    if (code[i] === '.') {
      const m = /^\.[A-Za-z_]\w*/.exec(code.slice(i));
      if (!m) return false;
      i += m[0].length;
    } else if (code[i] === '[') {
      if (!close('[', ']')) return false;
    } else return false;
  }
  return true;
}

const SAMPLER_TYPES: Record<string, string> = {
  '2d': 'sampler2D',
  '1d': 'sampler2D',
  '2d_array': 'sampler2DArray',
  '3d': 'sampler3D',
  cube: 'samplerCube',
};

/** Emits one entry point of a checked module as GLSL ES 3.00. */
export function emitStage(module: IRModule, entry: IREntryPoint, options: EmitOptions = {}): GLSLStage {
  if (entry.stage === 'compute')
    throw unsupported(`compute entry point '${entry.name}' as a render stage (compute is milestone M5)`);
  return new StageEmitter(module, entry, options).run();
}

interface FnInstance {
  readonly name: string;
  readonly fn: IRFunction;
  readonly handles: ReadonlyMap<IRParam, IRGlobalVar>;
}

class StageEmitter {
  private readonly stage: 'vertex' | 'fragment';
  private readonly prefix: string;
  private readonly types: string[] = [];
  private readonly typeNames = new Map<string, string>();
  private readonly globals: string[] = [];
  private readonly globalDone = new Set<object>();
  private readonly helperSrc: string[] = [];
  private readonly helperDone = new Set<string>();
  private readonly loaders: string[] = [];
  private readonly loaderNames = new Map<string, string>();
  private readonly protos: string[] = [];
  private readonly bodies: string[] = [];
  private readonly instances = new Map<string, FnInstance>();
  private readonly pending: FnInstance[] = [];
  private readonly uniforms = new Map<IRGlobalVar, GLSLUniform & { array: string }>();
  private readonly textures = new Map<string, GLSLTexture>();
  private readonly notes = new Set<string>();
  private readonly constants: Readonly<Record<string, number | boolean>>;
  private names = new Map<object, string>();
  private aliases = new Map<IRLocal, Ref>();
  private handles: ReadonlyMap<IRParam, IRGlobalVar> = new Map();
  private lines: string[] = [];
  private depth = 1;
  private counter = 0;
  /** Loop context for break/continue: 'plain' loops and switches, or loops with a continuing block. */
  private breakable: { kind: 'loop' | 'switch' | 'continuing'; flag?: string }[] = [];
  private baseVertex = false;
  /** Calls the current statement evaluates into a temporary first (see markHoists). */
  private readonly hoists = new Set<IRExpr>();
  private readonly discards = new Map<IRFunction, boolean>();
  private baseInstance = false;

  constructor(
    private readonly module: IRModule,
    private readonly entry: IREntryPoint,
    private readonly options: EmitOptions,
  ) {
    this.stage = entry.stage as 'vertex' | 'fragment';
    this.prefix = options.prefix ?? (this.stage === 'vertex' ? 'v' : 'f');
    this.constants = options.constants ?? {};
  }

  run(): GLSLStage {
    for (const e of this.module.enables)
      if (e !== 'f16') throw unsupported(`'enable ${e};' (only f16 is mapped, to highp float)`);
    const main = this.instance(this.entry.function, new Map());
    while (this.pending.length) this.emitFunction(this.pending.shift() as FnInstance);
    const io = this.mainFunction(main);
    const precision = ['float', 'int', ...new Set([...this.textures.values()].map((t) => t.glslType))].map(
      (t) => `precision highp ${t};`,
    );
    const source = [
      '#version 300 es',
      ...precision,
      ...this.types,
      ...io.declarations,
      ...this.globals,
      ...this.helperSrc,
      ...this.loaders,
      ...this.protos,
      ...this.bodies,
      io.main,
      '',
    ].join('\n');
    return {
      stage: this.stage,
      source,
      uniforms: [...this.uniforms.values()].map(({ array: _, ...u }) => u),
      textures: [...this.textures.values()],
      inputs: io.inputs,
      outputs: io.outputs,
      varyings: io.varyings,
      baseVertex: this.baseVertex ? '_bv' : undefined,
      baseInstance: this.baseInstance ? '_bi' : undefined,
      fragDepth: io.fragDepth,
      notes: [...this.notes],
    };
  }

  // ---------------------------------------------------------------- names and types

  private globalName(name: string): string {
    return `q${encodeName(name)}`;
  }

  private localName(d: IRLocal | IRParam): string {
    let n = this.names.get(d);
    if (!n) this.names.set(d, (n = `l${encodeName(d.name)}_${this.counter++}`));
    return n;
  }

  private temp(): string {
    return `_t${this.counter++}`;
  }

  /** The GLSL type of a WGSL value type; registers struct and array-wrapper definitions on first use. */
  type(t: Type): string {
    switch (t.kind) {
      case 'scalar':
        return scalarName(t);
      case 'vector':
        return `${vecPrefix(t.element)}vec${t.size}`;
      case 'matrix':
        return t.columns === t.rows ? `mat${t.columns}` : `mat${t.columns}x${t.rows}`;
      case 'array':
        return `${this.elementType(t)}[${this.count(t)}]`;
      case 'struct':
        return this.struct(t);
      case 'ref':
      case 'ptr':
        return this.type(t.store);
      case 'atomic':
        throw unsupported('atomics outside storage buffers (atomics are milestone M5)');
      default:
        throw unsupported(`a value of type ${typeName(t)}`);
    }
  }

  /** Array length as GLSL text: a number, or the override that sizes it. */
  private count(t: ArrayType): string {
    if (t.count === 'runtime')
      throw unsupported('runtime-sized arrays outside storage buffers (storage is milestone M4)');
    if (typeof t.count === 'number') return String(t.count);
    const o = this.module.globals.find(
      (g) => g.kind === 'override' && g.name === (t.count as { override: string }).override,
    );
    if (!o) throw unsupported(`array size '${t.count.override}'`);
    return this.override(o as IROverride);
  }

  /** GLSL element type of an array: GLSL ES 3.00 has no arrays of arrays, so inner arrays are wrapped in a struct. */
  private elementType(t: ArrayType): string {
    if (t.element.kind !== 'array') return this.type(t.element);
    const key = `wrap:${typeName(t.element)}`;
    let name = this.typeNames.get(key);
    if (!name) {
      const inner = this.type(t.element);
      name = `_A${this.typeNames.size}`;
      this.typeNames.set(key, name);
      this.types.push(`struct ${name} { ${inner.replace(/\[/, ' v[')}; };`);
    }
    return name;
  }

  private struct(t: StructType): string {
    const key = `struct:${t.name}`;
    let name = this.typeNames.get(key);
    if (name) return name;
    const members = t.members.map((m) => {
      const ty = this.type(m.type);
      const i = ty.indexOf('[');
      return i < 0
        ? `${ty} ${this.memberName(m.name)};`
        : `${ty.slice(0, i)} ${this.memberName(m.name)}${ty.slice(i)};`;
    });
    name = this.globalName(t.name);
    this.typeNames.set(key, name);
    this.types.push(`struct ${name} { ${members.join(' ')} };`);
    return name;
  }

  private memberName(name: string): string {
    return `q${encodeName(name)}`;
  }

  /** A declaration `T name` (array sizes after the name are not needed: `T[N] name` is valid GLSL ES 3.00). */
  private decl(t: Type, name: string): string {
    return `${this.type(t)} ${name}`;
  }

  private helper(name: string): string {
    if (this.helperDone.has(name)) return name;
    const h = HELPERS[name];
    if (!h)
      throw fault(
        'failed',
        `WebGL2 compatibility has no GLSL helper '${name}' (a bug: report it)`,
        'compatibility-layer',
      );
    for (const d of h.deps ?? []) this.helper(d);
    this.helperDone.add(name);
    this.helperSrc.push(h.source);
    return name;
  }

  /** A generated helper by key, defined once with `source(name)`. */
  private generated(key: string, source: (name: string) => string): string {
    let name = this.typeNames.get(`fn:${key}`);
    if (!name) {
      name = `_g${this.typeNames.size}`;
      this.typeNames.set(`fn:${key}`, name);
      this.helperSrc.push(source(name));
    }
    return name;
  }

  // ---------------------------------------------------------------- constants

  literal(value: ConstValue, t: Type): string {
    switch (t.kind) {
      case 'scalar':
        if (t.name === 'bool') return value ? 'true' : 'false';
        if (isInt(t)) return intLiteral(value as number);
        if (isUint(t)) return uintLiteral(value as number);
        return floatLiteral(value as number);
      case 'vector': {
        const parts = (value as ConstValue[]).map((v) => this.literal(v, t.element));
        return parts.every((p) => p === parts[0])
          ? `${this.type(t)}(${parts[0]})`
          : `${this.type(t)}(${parts.join(', ')})`;
      }
      case 'matrix': {
        const column = vector(t.rows, t.element);
        return `${this.type(t)}(${(value as ConstValue[]).map((c) => this.literal(c, column)).join(', ')})`;
      }
      case 'array': {
        const els = (value as ConstValue[]).map((v) => this.wrapElement(t, this.literal(v, t.element)));
        return `${this.elementType(t)}[${els.length}](${els.join(', ')})`;
      }
      case 'struct':
        return `${this.type(t)}(${(value as ConstValue[]).map((v, i) => this.literal(v, t.members[i].type)).join(', ')})`;
    }
    throw unsupported(`a constant of type ${typeName(t)}`);
  }

  private wrapElement(t: ArrayType, code: string): string {
    return t.element.kind === 'array' ? `${this.elementType(t)}(${code})` : code;
  }

  /** The zero value of a constructible type. */
  zero(t: Type): string {
    switch (t.kind) {
      case 'scalar':
        return t.name === 'bool' ? 'false' : isUint(t) ? '0u' : isInt(t) ? '0' : '0.0';
      case 'vector':
        return `${this.type(t)}(${this.zero(t.element)})`;
      case 'matrix':
        return `${this.type(t)}(0.0)`;
      case 'array': {
        const n = typeof t.count === 'number' ? t.count : undefined;
        if (n !== undefined && n <= 16)
          return `${this.elementType(t)}[${n}](${Array.from({ length: n }, () => this.wrapElement(t, this.zero(t.element))).join(', ')})`;
        const ty = this.type(t),
          count = this.count(t),
          el = this.wrapElement(t, this.zero(t.element));
        return `${this.generated(`zero:${typeName(t)}`, (name) => `${ty} ${name}() { ${ty} r; for (int i = 0; i < ${count}; i++) r[i] = ${el}; return r; }`)}()`;
      }
      case 'struct':
        return `${this.type(t)}(${t.members.map((m) => this.zero(m.type)).join(', ')})`;
    }
    throw unsupported(`a zero value of type ${typeName(t)}`);
  }

  /** A materialized module-scope const (arrays, structs and matrices, so dynamic indexes read a named constant). */
  private globalConst(c: IRGlobalConst): string {
    const name = this.globalName(c.name);
    if (!this.globalDone.has(c)) {
      this.globalDone.add(c);
      const text = this.literal(c.value, c.type);
      this.globals.push(`const ${this.decl(c.type, name)} = ${text};`);
    }
    return name;
  }

  private override(o: IROverride): string {
    const name = this.globalName(o.name);
    if (this.globalDone.has(o)) return name;
    this.globalDone.add(o);
    const given = this.constants[o.name] ?? (o.id !== undefined ? this.constants[String(o.id)] : undefined);
    let text: string;
    const s = o.type as ScalarType;
    if (given !== undefined) {
      const n = typeof given === 'boolean' ? +given : Number(given);
      if (s.name === 'bool') text = n !== 0 ? 'true' : 'false';
      else if (isInt(s)) text = intLiteral(Math.trunc(n) | 0);
      else if (isUint(s)) text = uintLiteral(Math.trunc(n) >>> 0);
      else text = floatLiteral(Math.fround(n));
    } else if (o.init) text = this.value(o.init);
    else throw unsupported(`override '${o.name}' without a value: pass it in the pipeline's constants`);
    this.globals.push(`const ${scalarName(s)} ${name} = ${text};`);
    return name;
  }

  private privateVar(v: IRGlobalVar): string {
    const name = this.globalName(v.name);
    if (!this.globalDone.has(v)) {
      this.globalDone.add(v);
      const init = v.init?.value !== undefined ? this.literal(v.init.value, v.type) : this.zero(v.type);
      this.globals.push(`${this.decl(v.type, name)} = ${init};`);
    }
    return name;
  }

  private uniform(v: IRGlobalVar): GLSLUniform & { array: string } {
    let u = this.uniforms.get(v);
    if (u) return u;
    if (v.space === 'storage') throw unsupported(`storage buffer '${v.name}' (storage buffers are milestone M4)`);
    const minSize = sizeOf(v.type),
      words = Math.max(1, Math.ceil(minSize / 16));
    if (words > 4096) throw unsupported(`uniform buffer '${v.name}' of ${minSize} bytes (WebGL2 blocks hold 65,536)`);
    const tag = `${this.prefix}${v.group}_${v.binding}`;
    u = {
      group: v.group as number,
      binding: v.binding as number,
      block: `_B${tag}`,
      size: words * 16,
      minSize,
      array: `_u${tag}`,
    };
    this.uniforms.set(v, u);
    this.globals.push(`layout(std140) uniform ${u.block} { highp uvec4 ${u.array}[${words}]; };`);
    return u;
  }

  // ---------------------------------------------------------------- functions

  private instance(fn: IRFunction, handles: ReadonlyMap<IRParam, IRGlobalVar>): FnInstance {
    const key = `${fn.name}|${fn.params.map((p) => handles.get(p)?.name ?? '').join(',')}`;
    let inst = this.instances.get(key);
    if (!inst) {
      inst = { name: `${this.globalName(fn.name)}${handles.size ? `_s${this.instances.size}` : ''}`, fn, handles };
      this.instances.set(key, inst);
      this.pending.push(inst);
    }
    return inst;
  }

  private signature(inst: FnInstance): string {
    const params = inst.fn.params
      .filter((p) => !inst.handles.has(p))
      .map((p) => {
        if (p.type.kind === 'ptr') {
          if (p.type.space !== 'function' && p.type.space !== 'private')
            throw unsupported(`a pointer parameter into ${p.type.space} memory ('${p.name}' of '${inst.fn.name}')`);
          return `inout ${this.decl(p.type.store, this.localName(p))}`;
        }
        return this.decl(p.type, this.localName(p));
      });
    const ret = inst.fn.returnType.kind === 'void' ? 'void' : this.type(inst.fn.returnType);
    return `${ret} ${inst.name}(${params.join(', ')})`;
  }

  private emitFunction(inst: FnInstance): void {
    const savedNames = this.names,
      savedAliases = this.aliases,
      savedHandles = this.handles;
    this.names = new Map();
    this.aliases = new Map();
    this.handles = inst.handles;
    for (const p of inst.fn.params)
      if ((p.type.kind === 'texture' || p.type.kind === 'sampler') && !inst.handles.has(p))
        throw unsupported(`texture or sampler parameter '${p.name}' without a module-scope argument`);
    const sig = this.signature(inst);
    this.lines = [];
    this.depth = 1;
    this.breakable = [];
    this.statements(inst.fn.body);
    this.protos.push(`${sig};`);
    this.bodies.push(`${sig} {\n${this.lines.join('\n')}\n}`);
    this.names = savedNames;
    this.aliases = savedAliases;
    this.handles = savedHandles;
  }

  private line(text: string): void {
    this.lines.push(`${'  '.repeat(this.depth)}${text}`);
  }

  // ---------------------------------------------------------------- statements

  private statements(list: readonly IRStmt[]): void {
    for (const s of list) this.statement(s);
  }

  private block(list: readonly IRStmt[]): void {
    this.depth++;
    this.statements(list);
    this.depth--;
  }

  private statement(s: IRStmt): void {
    switch (s.kind) {
      case 'block':
        this.line('{');
        this.block(s.body);
        this.line('}');
        return;
      case 'decl':
        if (s.local.init) this.markHoists([s.local.init]);
        return this.declaration(s.local);
      case 'assign':
        return this.assign(s.op, s.lhs, s.rhs);
      case 'increment': {
        const r = this.lvalue(s.lhs, false);
        this.line(`${r}${s.op};`);
        return;
      }
      case 'call':
        if (s.call.kind === 'call') this.markHoists(s.call.args);
        this.line(`${this.value(s.call)};`);
        return;
      case 'if':
        this.line(`if (${this.value(s.condition)}) {`);
        this.block(s.then);
        if (s.else) {
          this.line('} else {');
          this.block(s.else);
        }
        this.line('}');
        return;
      case 'switch': {
        const unsigned = isUint(s.selector.type as ScalarType);
        this.line(`switch (${this.value(s.selector)}) {`);
        this.breakable.push({ kind: 'switch' });
        for (const c of s.clauses) {
          const labels = c.selectors.map((v) =>
            v === null ? 'default:' : `case ${unsigned ? uintLiteral(v) : intLiteral(v)}:`,
          );
          this.line(`${labels.join(' ')} {`);
          this.block(c.body);
          this.line('} break;');
        }
        this.breakable.pop();
        this.line('}');
        return;
      }
      case 'loop':
        return this.loop(s.body, s.continuing, s.breakIf);
      case 'for': {
        // A GLSL for: its update runs on `continue` as WGSL's continuing does. A declared loop variable stays in the
        // header, the shape shader compilers recognise as a counted loop.
        let init = '';
        const outer =
          s.init &&
          !(s.init.kind === 'decl' && s.init.local.kind !== 'local-const' && s.init.local.type.kind !== 'ptr');
        if (outer) {
          this.line('{');
          this.depth++;
          this.statement(s.init as IRStmt);
        } else if (s.init?.kind === 'decl') {
          const d = s.init.local;
          init = `${this.decl(d.type, this.localName(d))} = ${d.init ? this.value(d.init) : this.zero(d.type)}`;
        }
        const condition = s.condition ? this.value(s.condition) : '';
        const update = s.update ? this.expressionStatement(s.update) : '';
        this.line(`for (${init}; ${condition}; ${update}) {`);
        this.breakable.push({ kind: 'loop' });
        this.block(s.body);
        this.breakable.pop();
        this.line('}');
        if (outer) {
          this.depth--;
          this.line('}');
        }
        return;
      }
      case 'while':
        this.line(`while (${this.value(s.condition)}) {`);
        this.breakable.push({ kind: 'loop' });
        this.block(s.body);
        this.breakable.pop();
        this.line('}');
        return;
      case 'break': {
        const target = this.breakable.at(-1);
        if (target?.kind === 'continuing') this.line(`{ ${target.flag} = true; break; }`);
        else this.line('break;');
        return;
      }
      case 'continue':
        this.line('continue;');
        return;
      case 'discard':
        this.line('discard;');
        return;
      case 'return':
        if (s.value) this.markHoists([s.value]);
        this.line(s.value ? `return ${this.value(s.value)};` : 'return;');
        return;
    }
  }

  /**
   * `loop { body continuing { c break if x } }`. With a continuing block, the body runs inside `do { } while (false)`
   * so a WGSL `continue` (a GLSL `continue` there) still reaches the continuing statements, and a WGSL `break` sets a
   * flag that leaves the outer loop after it.
   */
  private loop(body: readonly IRStmt[], continuing?: readonly IRStmt[], breakIf?: IRExpr): void {
    if (!continuing?.length && !breakIf) {
      this.line('while (true) {');
      this.breakable.push({ kind: 'loop' });
      this.block(body);
      this.breakable.pop();
      this.line('}');
      return;
    }
    const flag = this.temp();
    this.line('while (true) {');
    this.depth++;
    this.line(`bool ${flag} = false;`);
    this.line('do {');
    this.breakable.push({ kind: 'continuing', flag });
    this.block(body);
    this.breakable.pop();
    this.line('} while (false);');
    this.line(`if (${flag}) break;`);
    this.breakable.push({ kind: 'loop' });
    if (continuing) this.statements(continuing);
    this.breakable.pop();
    if (breakIf) this.line(`if (${this.value(breakIf)}) break;`);
    this.depth--;
    this.line('}');
  }

  /** True when a function, or one it calls, may discard (or needs fragment-only built-ins). */
  private mayDiscard(fn: IRFunction): boolean {
    let known = this.discards.get(fn);
    if (known === undefined) {
      this.discards.set(fn, false);
      known = fn.stages.has('fragment') || [...fn.calls].some((g) => this.mayDiscard(g));
      this.discards.set(fn, known);
    }
    return known;
  }

  /**
   * Marks calls of functions that may discard for evaluation into a temporary before the statement. ANGLE's Direct3D
   * back end cannot build a pixel shader that calls such a function inside a larger expression (a struct constructor
   * around it, for one). A call is marked only while everything WGSL evaluates before it in the statement is
   * immutable (literals, constants, lets, parameters), so moving it first changes no result.
   */
  private markHoists(roots: readonly IRExpr[]): void {
    let clean = true;
    const walk = (e: IRExpr): void => {
      if (!clean) return;
      switch (e.kind) {
        case 'literal':
          return;
        case 'name':
          if (e.decl.kind === 'var' && e.decl.space !== 'handle') clean = false;
          return;
        case 'load':
          walk(e.ref);
          if (
            e.ref.kind !== 'name' ||
            (e.ref.decl.kind === 'var' && e.ref.decl.space !== 'handle') ||
            e.ref.decl.kind === 'local-var'
          )
            clean = false;
          return;
        case 'call':
          e.args.forEach(walk);
          if (clean && e.type.kind !== 'void' && this.mayDiscard(e.fn)) this.hoists.add(e);
          clean = false;
          return;
        case 'construct':
        case 'builtin':
          e.args.forEach(walk);
          return;
        case 'convert':
        case 'bitcast':
          return walk(e.arg);
        case 'member':
        case 'swizzle':
          return walk(e.object);
        case 'index':
          walk(e.object);
          return walk(e.index);
        case 'unary':
          return walk(e.operand);
        case 'binary':
          walk(e.left);
          // The right side of && and || runs only sometimes: a call there must stay where it is.
          if (e.op === '&&' || e.op === '||') clean = false;
          return walk(e.right);
        default:
          clean = false;
      }
    };
    roots.forEach(walk);
  }

  /** An assignment, increment or call as one GLSL expression (a for loop's update). */
  private expressionStatement(s: IRStmt): string {
    switch (s.kind) {
      case 'increment':
        return `${this.lvalue(s.lhs, false)}${s.op}`;
      case 'call':
        return this.value(s.call);
      case 'assign': {
        if (!s.lhs) return this.value(s.rhs);
        const target = this.lvalue(s.lhs, false);
        if (s.op === '=') return `${target} = ${this.value(s.rhs)}`;
        const bin = s.op.slice(0, -1),
          store = storeOf(s.lhs.type);
        const left = { kind: 'literal', type: store, start: 0, end: 0 } as IRExpr;
        return `${target} = ${this.binaryText(bin, left, s.rhs, store, target)}`;
      }
    }
    throw unsupported(`a ${s.kind} statement as a for-loop update`);
  }

  private declaration(d: IRLocal): void {
    if (d.kind === 'local-const') {
      if (d.type.kind === 'array' || d.type.kind === 'struct' || d.type.kind === 'matrix')
        this.line(`const ${this.decl(d.type, this.localName(d))} = ${this.literal(d.value as ConstValue, d.type)};`);
      return;
    }
    if (d.kind === 'let' && d.type.kind === 'ptr') {
      this.aliases.set(d, this.pointer(d.init as IRExpr, true));
      return;
    }
    const name = this.localName(d);
    const init = d.init ? this.value(d.init) : this.zero(d.type);
    this.line(`${this.decl(d.type, name)} = ${init};`);
  }

  private assign(op: string, lhs: IRExpr | null, rhs: IRExpr): void {
    this.markHoists(lhs ? [lhs, rhs] : [rhs]);
    if (!lhs) {
      if (!pure(rhs)) this.line(`${this.value(rhs)};`);
      return;
    }
    if (op === '=') {
      this.line(`${this.lvalue(lhs, false)} = ${this.value(rhs)};`);
      return;
    }
    const bin = op.slice(0, -1);
    const store = storeOf(lhs.type),
      el = elementOfT(store) as ScalarType;
    const direct =
      (bin === '+' || bin === '-' || bin === '*' || bin === '&' || bin === '|' || bin === '^') && !(el.name === 'bool');
    if (direct) {
      this.line(`${this.lvalue(lhs, false)} ${op} ${this.value(rhs)};`);
      return;
    }
    // Division, remainder and shifts go through WGSL's rules: lhs = lhs op rhs, the lhs evaluated once.
    const target = this.lvalue(lhs, true);
    const left = { kind: 'literal', type: store, start: 0, end: 0 } as IRExpr;
    this.line(`${target} = ${this.binaryText(bin, left, rhs, store, target)};`);
  }

  // ---------------------------------------------------------------- references

  /** An lvalue for assignment. `stable`: dynamic indexes are evaluated once, into temporaries. */
  private lvalue(e: IRExpr, stable: boolean): string {
    const r = this.ref(e, stable);
    if (r.kind !== 'lvalue')
      throw unsupported(`a write to ${r.v.space} buffer '${r.v.name}' (storage writes are milestone M5)`);
    return r.code;
  }

  /** A memory reference. `stable` evaluates dynamic indexes into temporaries (pointer lets, compound assignment). */
  private ref(e: IRExpr, stable: boolean): Ref {
    const type = storeOf(e.type);
    switch (e.kind) {
      case 'name': {
        const d = e.decl;
        if (d.kind === 'var') {
          if (d.space === 'private') return { kind: 'lvalue', code: this.privateVar(d), type };
          if (d.space === 'uniform' || d.space === 'storage') {
            this.uniform(d);
            return { kind: 'buffer', v: d, base: 0, rows: [], dyn: [], type };
          }
          if (d.space === 'workgroup') throw unsupported('workgroup memory in a render stage');
          throw unsupported(`a reference to '${d.name}'`);
        }
        if (d.kind === 'let' && d.type.kind === 'ptr') return this.aliases.get(d) as Ref;
        if (d.kind === 'param' || d.kind === 'local-var' || d.kind === 'let')
          return { kind: 'lvalue', code: this.localName(d), type };
        throw unsupported(`a reference to '${d.name}'`);
      }
      case 'deref':
        return this.pointer(e.pointer, stable);
      case 'member': {
        const base = this.ref(e.object, stable),
          st = storeOf(e.object.type) as StructType,
          m = st.members[e.index];
        if (base.kind === 'buffer') return { ...base, base: base.base + m.offset, type };
        return { kind: 'lvalue', code: `${base.code}.${this.memberName(m.name)}`, type };
      }
      case 'swizzle': {
        const base = this.ref(e.object, stable);
        if (base.kind === 'buffer') return { ...base, base: base.base + 4 * e.components[0], type };
        return { kind: 'lvalue', code: `${base.code}.${e.components.map((c) => SWIZZLE[c]).join('')}`, type };
      }
      case 'index': {
        const base = this.ref(e.object, stable),
          outer = storeOf(e.object.type);
        if (base.kind === 'buffer') {
          // A vector component, a matrix column or an array element: a step of whole 16-byte rows keeps the
          // component static (uniform arrays always step in rows); anything else is a word step.
          const step =
            outer.kind === 'array' ? strideOf(outer) : outer.kind === 'matrix' ? (outer.rows === 2 ? 8 : 16) : 4;
          if (typeof e.index.value === 'number') return { ...base, base: base.base + step * e.index.value, type };
          const n =
            outer.kind === 'array'
              ? outer.count === 'runtime'
                ? ''
                : this.count(outer)
              : String(outer.kind === 'matrix' ? outer.columns : (outer as { size: number }).size);
          const index = this.clampedIndex(e.index, n, stable);
          if (step % 16 === 0)
            return { ...base, rows: [...base.rows, step === 16 ? index : `${index} * ${step / 16}`], type };
          return { ...base, dyn: [...base.dyn, `${index} * ${step / 4}`], type };
        }
        const n =
          outer.kind === 'array'
            ? this.count(outer)
            : outer.kind === 'matrix'
              ? String(outer.columns)
              : String((outer as { size: number }).size);
        const index = typeof e.index.value === 'number' ? String(e.index.value) : this.clampedIndex(e.index, n, stable);
        const wrapped = outer.kind === 'array' && outer.element.kind === 'array' ? '.v' : '';
        return { kind: 'lvalue', code: `${base.code}[${index}]${wrapped}`, type };
      }
    }
    throw unsupported(`a memory reference of kind '${e.kind}'`);
  }

  /** The reference a pointer value points at. */
  private pointer(p: IRExpr, stable: boolean): Ref {
    if (p.kind === 'address-of') return this.ref(p.ref, stable);
    if (p.kind === 'name') {
      const d = p.decl;
      if (d.kind === 'let') return this.aliases.get(d) as Ref;
      if (d.kind === 'param') return { kind: 'lvalue', code: this.localName(d), type: storeOf(d.type) };
    }
    throw unsupported(`a pointer expression of kind '${p.kind}'`);
  }

  /** A dynamic index clamped into [0, n): WGSL keeps out-of-bounds accesses inside the array. */
  private clampedIndex(index: IRExpr, n: string, stable: boolean): string {
    let code = this.value(index);
    const unsigned = isUint(index.type as ScalarType);
    code = unsigned ? `int(min(${code}, uint(${n}) - 1u))` : `clamp(${code}, 0, ${n} - 1)`;
    if (!stable) return code;
    const t = this.temp();
    this.line(`int ${t} = ${code};`);
    return t;
  }

  /** Reads a value of `type` from a uniform buffer at a reference. */
  private load(r: Extract<Ref, { kind: 'buffer' }>): string {
    const u = this.uniform(r.v);
    const t = r.type;
    if (r.dyn.length) {
      // A dynamic vector component or matCx2 column: word addressing, with a dynamic component index.
      const offset = [String(r.base >> 2), ...r.rows.map((x) => `(${x}) * 4`), ...r.dyn].join(' + ');
      return `${this.loader(r.v, u.array, t)}(${offset})`;
    }
    // Rows are dynamic, the byte within the row is static: every component is a fixed swizzle.
    const row = [String(r.base >> 4), ...r.rows].join(' + ');
    if (!r.rows.length && (t.kind === 'scalar' || t.kind === 'vector'))
      return this.inlineLoad(`${u.array}[${r.base >> 4}]`, r.base & 15, t);
    return `${this.rowLoader(u.array, t, r.base & 15)}(${row})`;
  }

  /** A scalar or vector at byte `k` of one 16-byte row (`cell`, a uvec4). */
  private inlineLoad(cell: string, k: number, t: Type): string {
    const s = elementOfT(t) as ScalarType;
    const w = k >> 2,
      n = t.kind === 'vector' ? t.size : 1;
    const raw = n === 4 ? cell : `${cell}.${SWIZZLE.slice(w, w + n)}`;
    return this.fromBits(raw, s, n);
  }

  /** A function `T name(int r)` reading a `t` that starts at byte `k` of row `r` of a uniform block. */
  private rowLoader(array: string, t: Type, k: number): string {
    const key = `${array}:${typeName(t)}@${k}`;
    let name = this.loaderNames.get(key);
    if (name) return name;
    name = `_lr${this.loaderNames.size}${this.prefix}`;
    this.loaderNames.set(key, name);
    const ty = this.type(t);
    // A part at byte `at` (relative to the row `r` starts at byte k of): its row and byte.
    const part = (pt: Type, at: number): string => {
      const b = k + at,
        row = b >> 4 ? `r + ${b >> 4}` : 'r';
      if (pt.kind === 'scalar' || pt.kind === 'vector') return this.inlineLoad(`${array}[${row}]`, b & 15, pt);
      return `${this.rowLoader(array, pt, b & 15)}(${row})`;
    };
    let body: string;
    switch (t.kind) {
      case 'scalar':
      case 'vector':
        body = `return ${part(t, 0)};`;
        break;
      case 'matrix': {
        const col = vector(t.rows, t.element),
          step = t.rows === 2 ? 8 : 16;
        body = `return ${ty}(${Array.from({ length: t.columns }, (_, c) => part(col, c * step)).join(', ')});`;
        break;
      }
      case 'array': {
        const stride = strideOf(t);
        if (stride % 16) throw unsupported(`an array with a stride of ${stride} bytes in a uniform buffer`);
        const set = t.element.kind === 'array' ? 'a[i].v' : 'a[i]';
        const el =
          t.element.kind === 'scalar' || t.element.kind === 'vector'
            ? this.inlineLoad(`${array}[r + i * ${stride / 16}]`, k, t.element)
            : `${this.rowLoader(array, t.element, k)}(r + i * ${stride / 16})`;
        body = `${ty} a; for (int i = 0; i < ${this.count(t)}; i++) ${set} = ${el}; return a;`;
        break;
      }
      case 'struct':
        body = `return ${ty}(${t.members.map((m) => part(m.type, m.offset)).join(', ')});`;
        break;
      default:
        throw unsupported(`reading ${typeName(t)} from a uniform buffer`);
    }
    this.loaders.push(`${ty} ${name}(int r) { ${body} }`);
    return name;
  }

  private fromBits(raw: string, s: ScalarType, n: number): string {
    if (s.name === 'f16') throw unsupported('f16 values in uniform buffers');
    if (isUint(s)) return raw;
    if (isInt(s)) return n === 1 ? `int(${raw})` : `ivec${n}(${raw})`;
    return `uintBitsToFloat(${raw})`;
  }

  /** A function `T name(int o)` reading a `t` at word offset `o` of a uniform block (dynamic components). */
  private loader(v: IRGlobalVar | undefined, array: string, t: Type): string {
    const key = `${array}:${typeName(t)}`;
    let name = this.loaderNames.get(key);
    if (name) return name;
    name = `_ld${this.loaderNames.size}${this.prefix}`;
    this.loaderNames.set(key, name);
    const ty = this.type(t);
    let body: string;
    switch (t.kind) {
      case 'scalar':
        body = `return ${this.fromBits(`${array}[o >> 2][o & 3]`, t, 1)};`;
        break;
      case 'vector': {
        const raw =
          t.size === 4
            ? `${array}[o >> 2]`
            : t.size === 3
              ? `${array}[o >> 2].xyz`
              : `((o & 2) == 0 ? ${array}[o >> 2].xy : ${array}[o >> 2].zw)`;
        body = `return ${this.fromBits(raw, t.element, t.size)};`;
        break;
      }
      case 'matrix': {
        const col = vector(t.rows, t.element),
          step = t.rows === 2 ? 2 : 4;
        const f = this.loader(v, array, col);
        body = `return ${ty}(${Array.from({ length: t.columns }, (_, c) => `${f}(o + ${c * step})`).join(', ')});`;
        break;
      }
      case 'array': {
        const f = this.loader(v, array, t.element),
          step = strideOf(t) / 4;
        const set = t.element.kind === 'array' ? `r[i].v` : 'r[i]';
        body = `${ty} r; for (int i = 0; i < ${this.count(t)}; i++) ${set} = ${f}(o + i * ${step}); return r;`;
        break;
      }
      case 'struct':
        body = `return ${ty}(${t.members.map((m) => `${this.loader(v, array, m.type)}(o + ${m.offset / 4})`).join(', ')});`;
        break;
      default:
        throw unsupported(`reading ${typeName(t)} from a uniform buffer`);
    }
    this.loaders.push(`${ty} ${name}(int o) { ${body} }`);
    return name;
  }

  // ---------------------------------------------------------------- expressions

  /** An rvalue. */
  value(e: IRExpr): string {
    if (e.value !== undefined && e.type.kind !== 'ref' && e.type.kind !== 'ptr') {
      if (e.kind === 'name' && e.decl.kind === 'const' && (e.type.kind === 'array' || e.type.kind === 'struct'))
        return this.globalConst(e.decl);
      if (
        e.kind === 'name' &&
        e.decl.kind === 'local-const' &&
        (e.type.kind === 'array' || e.type.kind === 'struct' || e.type.kind === 'matrix')
      )
        return this.localName(e.decl);
      return this.literal(e.value, e.type);
    }
    switch (e.kind) {
      case 'literal':
        return this.literal(e.value as ConstValue, e.type);
      case 'name': {
        const d = e.decl;
        if (d.kind === 'override') return this.override(d);
        if (d.kind === 'const') return this.globalConst(d);
        if (d.kind === 'local-const') return this.localName(d);
        if (d.kind === 'var' && d.space === 'handle')
          throw unsupported(`texture or sampler '${d.name}' used as a value`);
        if (d.kind === 'param' && this.handles.has(d))
          throw unsupported(`handle parameter '${d.name}' used as a value`);
        return this.localName(d as IRLocal);
      }
      case 'load': {
        const r = this.ref(e.ref, false);
        return r.kind === 'lvalue' ? r.code : this.load(r);
      }
      case 'construct':
        return this.construct(e.type, e.args);
      case 'convert':
        return this.convert(e.arg, e.type);
      case 'bitcast':
        return this.bitcast(e.arg, e.type);
      case 'call': {
        const text = this.call(e.fn, e.args);
        if (!this.hoists.delete(e)) return text;
        const t = this.temp();
        this.line(`${this.decl(e.type, t)} = ${text};`);
        return t;
      }
      case 'builtin':
        return this.builtin(e.name, e.args, e.type);
      case 'member': {
        const st = e.object.type as StructType;
        return `${this.value(e.object)}.${this.memberName(st.members[e.index].name)}`;
      }
      case 'swizzle':
        return `${this.paren(e.object)}.${e.components.map((c) => SWIZZLE[c]).join('')}`;
      case 'index': {
        const t = e.object.type;
        const n =
          t.kind === 'array'
            ? this.count(t)
            : t.kind === 'matrix'
              ? String(t.columns)
              : String((t as { size: number }).size);
        const index = typeof e.index.value === 'number' ? String(e.index.value) : this.clampedIndex(e.index, n, false);
        const wrapped = t.kind === 'array' && t.element.kind === 'array' ? '.v' : '';
        return `${this.paren(e.object)}[${index}]${wrapped}`;
      }
      case 'unary':
        return this.unary(e.op, e.operand, e.type);
      case 'binary':
        return this.binaryText(e.op, e.left, e.right, e.type);
      case 'address-of':
      case 'deref':
        throw unsupported(`a pointer used as a value`);
    }
  }

  /** A value in parentheses unless it is one postfix expression already (safe to follow with `.x` or `[i]`). */
  private paren(e: IRExpr): string {
    return this.wrap(this.value(e));
  }

  private construct(t: Type, args: readonly IRExpr[]): string {
    if (!args.length) return this.zero(t);
    if (t.kind === 'array')
      return `${this.elementType(t)}[${args.length}](${args.map((a) => this.wrapElement(t, this.value(a))).join(', ')})`;
    if (t.kind === 'vector' && args.length === 1 && args[0].type.kind === 'vector') return this.value(args[0]);
    return `${this.type(t)}(${args.map((a) => this.value(a)).join(', ')})`;
  }

  private convert(arg: IRExpr, to: Type): string {
    const from = elementOfT(arg.type) as ScalarType,
      target = elementOfT(to) as ScalarType;
    const code = this.value(arg);
    if (to.kind === 'matrix' || scalarName(from) === scalarName(target)) return code;
    const n = to.kind === 'vector' ? to.size : 1;
    if (isFloatS(from) && (isInt(target) || isUint(target))) {
      const [lo, hi] = isInt(target) ? ['-2147483648.0', '2147483520.0'] : ['0.0', '4294967040.0'];
      return `${this.type(to)}(clamp(${code}, ${lo}, ${hi}))`;
    }
    return n === 1 ? `${scalarName(target)}(${code})` : `${this.type(to)}(${code})`;
  }

  private bitcast(arg: IRExpr, to: Type): string {
    const from = arg.type,
      fs = elementOfT(from) as ScalarType,
      ts = elementOfT(to) as ScalarType;
    const code = this.value(arg);
    if (fs.name === 'f16' || ts.name === 'f16') {
      // vec2<f16> <-> 32-bit and vec4<f16> <-> vec2 of 32-bit: through packHalf2x16.
      const fn = from.kind === 'vector' ? from.size : 1,
        tn = to.kind === 'vector' ? to.size : 1;
      if (fs.name === 'f16' && fn === 2 * tn) {
        const halves = Array.from(
          { length: tn },
          (_, i) => `packHalf2x16(${this.paren(arg)}.${SWIZZLE.slice(2 * i, 2 * i + 2)})`,
        );
        const bits = tn === 1 ? halves[0] : `uvec${tn}(${halves.join(', ')})`;
        return isUint(ts)
          ? bits
          : isInt(ts)
            ? `${tn === 1 ? 'int' : `ivec${tn}`}(${bits})`
            : `uintBitsToFloat(${bits})`;
      }
      if (ts.name === 'f16' && tn === 2 * fn) {
        const bits = isUint(fs)
          ? code
          : isInt(fs)
            ? `${fn === 1 ? 'uint' : `uvec${fn}`}(${code})`
            : `floatBitsToUint(${code})`;
        if (fn === 1) return `unpackHalf2x16(${bits})`;
        return `${this.generated(`unpack-h${fn}`, (name) => `vec${2 * fn} ${name}(uvec${fn} b) { return vec${2 * fn}(${Array.from({ length: fn }, (_, i) => `unpackHalf2x16(b.${SWIZZLE[i]})`).join(', ')}); }`)}(${bits})`;
      }
      throw unsupported(`bitcast from ${typeName(from)} to ${typeName(to)}`);
    }
    if (scalarName(fs) === scalarName(ts)) return code;
    if (isFloatS(fs)) return isUint(ts) ? `floatBitsToUint(${code})` : `floatBitsToInt(${code})`;
    if (isFloatS(ts)) return isUint(fs) ? `uintBitsToFloat(${code})` : `intBitsToFloat(${code})`;
    return `${this.type(to)}(${code})`;
  }

  private call(fn: IRFunction, args: readonly IRExpr[]): string {
    const handles = new Map<IRParam, IRGlobalVar>();
    const list: string[] = [];
    fn.params.forEach((p, i) => {
      const a = args[i];
      if (p.type.kind === 'texture' || p.type.kind === 'sampler') {
        handles.set(p, this.handleGlobal(a));
        return;
      }
      if (p.type.kind === 'ptr') {
        list.push(
          this.lvalue(
            { kind: 'deref', pointer: a, type: { ...p.type, kind: 'ref' }, start: a.start, end: a.end } as IRExpr,
            false,
          ),
        );
        return;
      }
      list.push(this.value(a));
    });
    const inst = this.instance(fn, handles);
    return `${inst.name}(${list.join(', ')})`;
  }

  /** The module-scope texture or sampler an argument names (through specialized parameters). */
  private handleGlobal(e: IRExpr): IRGlobalVar {
    if (e.kind === 'name') {
      if (e.decl.kind === 'var' && e.decl.space === 'handle') return e.decl;
      if (e.decl.kind === 'param') {
        const g = this.handles.get(e.decl);
        if (g) return g;
      }
    }
    throw unsupported('a texture or sampler that is not a module-scope variable');
  }

  private unary(op: string, operand: IRExpr, t: Type): string {
    const code = this.value(operand);
    if (op === '!') return t.kind === 'vector' ? `not(${code})` : `!${this.wrap(code)}`;
    return `${op}${this.wrap(code)}`;
  }

  private wrap(code: string): string {
    return postfix(code) ? code : `(${code})`;
  }

  /** `left op right` with WGSL's semantics. `leftCode` replaces `left` (compound assignment). */
  private binaryText(op: string, left: IRExpr, right: IRExpr, result: Type, leftCode?: string): string {
    const l = leftCode ?? this.value(left),
      r = this.value(right);
    const lt = left.type,
      rt = right.type;
    const ls = elementOfT(storeOf(lt)) as ScalarType,
      vectorOf = (t: Type) => (t.kind === 'vector' ? t.size : 0);
    switch (op) {
      case '&&':
      case '||':
        return `(${l} ${op} ${r})`;
      case '==':
      case '!=':
      case '<':
      case '>':
      case '<=':
      case '>=': {
        if (vectorOf(storeOf(lt)) === 0) return `(${l} ${op} ${r})`;
        const f = {
          '==': 'equal',
          '!=': 'notEqual',
          '<': 'lessThan',
          '>': 'greaterThan',
          '<=': 'lessThanEqual',
          '>=': 'greaterThanEqual',
        }[op];
        return `${f}(${l}, ${r})`;
      }
      case '<<':
      case '>>': {
        if (typeof right.value === 'number' || Array.isArray(right.value)) return `(${l} ${op} ${r})`;
        const n = vectorOf(rt);
        return `(${l} ${op} (${r} & ${n ? `uvec${n}(31u)` : '31u'}))`;
      }
      case '&':
      case '|':
      case '^':
        if (ls.name === 'bool') {
          const n = vectorOf(result);
          if (n) return `bvec${n}(uvec${n}(${l}) ${op} uvec${n}(${r}))`;
          return pure(left) && pure(right) && leftCode === undefined
            ? `(${l} ${op}${op} ${r})`
            : `bool(uint(${l}) ${op} uint(${r}))`;
        }
        return `(${l} ${op} ${r})`;
      case '/':
      case '%': {
        const s = elementOfT(result) as ScalarType | undefined;
        if (!s || result.kind === 'matrix') return `(${l} ${op} ${r})`;
        if (isFloatS(s)) {
          if (op === '/') return `(${l} / ${r})`;
          return this.componentwise('_fmod', result, l, r, storeOf(lt), rt);
        }
        // A nonzero constant unsigned divisor is exact in GLSL; everything else takes WGSL's rules.
        const constant =
          right.value !== undefined && (Array.isArray(right.value) ? right.value : [right.value]).every((v) => v !== 0);
        if (isUint(s) && constant) return `(${l} ${op} ${r})`;
        const name = isUint(s) ? (op === '/' ? '_divu' : '_modu') : op === '/' ? '_divi' : '_modi';
        return this.componentwise(name, result, l, r, storeOf(lt), rt);
      }
      default:
        return `(${l} ${op} ${r})`;
    }
  }

  /** A scalar helper applied per component; a scalar operand is splat to the result's size. */
  private componentwise(helper: string, result: Type, l: string, r: string, lt: Type, rt: Type): string {
    this.helper(helper);
    if (result.kind !== 'vector') return `${helper}(${l}, ${r})`;
    const ty = this.type(result),
      n = result.size,
      s = scalarName(result.element);
    const key = `${helper}${n}${s}`;
    const fn = this.generated(
      key,
      (name) =>
        `${ty} ${name}(${ty} a, ${ty} b) { return ${ty}(${Array.from({ length: n }, (_, i) => `${helper}(a.${SWIZZLE[i]}, b.${SWIZZLE[i]})`).join(', ')}); }`,
    );
    const splat = (code: string, t: Type) => (t.kind === 'vector' ? code : `${ty}(${code})`);
    return `${fn}(${splat(l, lt)}, ${splat(r, rt)})`;
  }

  /** A scalar helper `name(x)` mapped over a vector argument. */
  private mapped(helper: string, arg: string, argType: Type, result: Type): string {
    this.helper(helper);
    if (argType.kind !== 'vector') return `${helper}(${arg})`;
    const n = argType.size,
      at = this.type(argType),
      rt = this.type(result);
    const fn = this.generated(
      `${helper}:${at}`,
      (name) =>
        `${rt} ${name}(${at} a) { return ${rt}(${Array.from({ length: n }, (_, i) => `${helper}(a.${SWIZZLE[i]})`).join(', ')}); }`,
    );
    return `${fn}(${arg})`;
  }

  // ---------------------------------------------------------------- built-in functions

  private builtin(name: string, args: readonly IRExpr[], result: Type): string {
    if (name.startsWith('texture') && name !== 'textureBarrier') return this.texture(name, args, result);
    if (name === 'arrayLength') throw unsupported('arrayLength() (storage buffers are milestone M4)');
    if (name.startsWith('atomic') || name.endsWith('Barrier') || name === 'workgroupUniformLoad')
      throw unsupported(`${name}() (atomics, barriers and workgroup memory are milestone M5)`);
    if (name.startsWith('subgroup') || name.startsWith('quad'))
      throw unsupported(`${name}() (WebGL2 has no subgroups)`);
    const a = args.map((x) => (x.type.kind === 'texture' || x.type.kind === 'sampler' ? '' : this.value(x)));
    const t0 = args[0] ? storeOf(args[0].type) : result,
      s0 = elementOfT(t0);
    const direct: Record<string, string> = {
      acos: 'acos',
      acosh: 'acosh',
      asin: 'asin',
      asinh: 'asinh',
      atan: 'atan',
      atanh: 'atanh',
      ceil: 'ceil',
      cos: 'cos',
      cosh: 'cosh',
      cross: 'cross',
      degrees: 'degrees',
      determinant: 'determinant',
      distance: 'distance',
      exp: 'exp',
      exp2: 'exp2',
      floor: 'floor',
      fract: 'fract',
      inverseSqrt: 'inversesqrt',
      length: 'length',
      log: 'log',
      log2: 'log2',
      mix: 'mix',
      normalize: 'normalize',
      pow: 'pow',
      radians: 'radians',
      reflect: 'reflect',
      refract: 'refract',
      sin: 'sin',
      sinh: 'sinh',
      smoothstep: 'smoothstep',
      sqrt: 'sqrt',
      step: 'step',
      tan: 'tan',
      tanh: 'tanh',
      transpose: 'transpose',
      trunc: 'trunc',
      round: 'roundEven',
      faceForward: 'faceforward',
      dpdx: 'dFdx',
      dpdxCoarse: 'dFdx',
      dpdxFine: 'dFdx',
      dpdy: 'dFdy',
      dpdyCoarse: 'dFdy',
      dpdyFine: 'dFdy',
      fwidth: 'fwidth',
      fwidthCoarse: 'fwidth',
      fwidthFine: 'fwidth',
      pack2x16float: 'packHalf2x16',
      unpack2x16float: 'unpackHalf2x16',
      unpack2x16snorm: 'unpackSnorm2x16',
      unpack2x16unorm: 'unpackUnorm2x16',
    };
    if (name in direct) return `${direct[name]}(${a.join(', ')})`;
    const isScalarInt = s0 && (isInt(s0) || isUint(s0));
    switch (name) {
      case 'abs':
        return s0 && isUint(s0) ? a[0] : `abs(${a[0]})`;
      case 'sign':
        return `sign(${a[0]})`;
      case 'min':
      case 'max':
        return `${name}(${a[0]}, ${a[1]})`;
      case 'clamp':
        return `min(max(${a[0]}, ${a[1]}), ${a[2]})`;
      case 'saturate':
        return `clamp(${a[0]}, 0.0, 1.0)`;
      case 'atan2':
        return `atan(${a[0]}, ${a[1]})`;
      case 'fma':
        return `(${a[0]} * ${a[1]} + ${a[2]})`;
      case 'dot': {
        if (!isScalarInt) return `dot(${a[0]}, ${a[1]})`;
        const n = (t0 as { size: number }).size,
          ty = this.type(t0),
          s = scalarName(s0 as ScalarType);
        const fn = this.generated(
          `idot:${ty}`,
          (fname) =>
            `${s} ${fname}(${ty} a, ${ty} b) { return ${Array.from({ length: n }, (_, i) => `a.${SWIZZLE[i]} * b.${SWIZZLE[i]}`).join(' + ')}; }`,
        );
        return `${fn}(${a[0]}, ${a[1]})`;
      }
      case 'select': {
        const cond = storeOf(args[2].type);
        if (cond.kind !== 'vector') {
          if (pure(args[0]) && pure(args[1])) return `(${a[2]} ? ${a[1]} : ${a[0]})`;
          const ty = this.type(result);
          const fn = this.generated(
            `select:${ty}`,
            (fname) => `${ty} ${fname}(${ty} f, ${ty} t, bool c) { return c ? t : f; }`,
          );
          return `${fn}(${a[0]}, ${a[1]}, ${a[2]})`;
        }
        const el = elementOfT(result) as ScalarType;
        if (isFloatS(el)) return `mix(${a[0]}, ${a[1]}, ${a[2]})`;
        const ty = this.type(result),
          n = cond.size;
        const fn = this.generated(
          `select:${ty}:v`,
          (fname) =>
            `${ty} ${fname}(${ty} f, ${ty} t, bvec${n} c) { return ${ty}(${Array.from({ length: n }, (_, i) => `c.${SWIZZLE[i]} ? t.${SWIZZLE[i]} : f.${SWIZZLE[i]}`).join(', ')}); }`,
        );
        return `${fn}(${a[0]}, ${a[1]}, ${a[2]})`;
      }
      case 'all':
      case 'any':
        return t0.kind === 'vector' ? `${name}(${a[0]})` : a[0];
      case 'countOneBits':
      case 'reverseBits':
      case 'countLeadingZeros':
      case 'countTrailingZeros': {
        const h = { countOneBits: '_cob', reverseBits: '_rev', countLeadingZeros: '_clz', countTrailingZeros: '_ctz' }[
          name
        ] as string;
        return this.unsignedMap(h, a[0], t0, result);
      }
      case 'firstLeadingBit':
      case 'firstTrailingBit': {
        const signed = s0 && isInt(s0);
        const h = name === 'firstLeadingBit' ? (signed ? '_flbi' : '_flbu') : signed ? '_ftbi' : '_ftbu';
        return this.mapped(h, a[0], t0, result);
      }
      case 'extractBits': {
        const signed = s0 && isInt(s0);
        return this.vectorOf3(signed ? '_exti' : '_extu', [a[0]], [a[1], a[2]], t0);
      }
      case 'insertBits':
        if (s0 && isInt(s0)) {
          this.helper('_insu');
          const n = t0.kind === 'vector' ? t0.size : 1;
          const inner = this.vectorOf3(
            '_insu',
            [n === 1 ? `uint(${a[0]})` : `uvec${n}(${a[0]})`, n === 1 ? `uint(${a[1]})` : `uvec${n}(${a[1]})`],
            [a[2], a[3]],
            vector(n as 2, { kind: 'scalar', name: 'u32' }),
            n === 1,
          );
          return n === 1 ? `int(${inner})` : `ivec${n}(${inner})`;
        }
        return this.vectorOf3('_insu', [a[0], a[1]], [a[2], a[3]], t0);
      case 'ldexp':
        if (t0.kind === 'vector') {
          this.helper('_ldexp');
          const n = t0.size;
          const fn = this.generated(
            `ldexp${n}`,
            (fname) =>
              `vec${n} ${fname}(vec${n} x, ivec${n} e) { return vec${n}(${Array.from({ length: n }, (_, i) => `_ldexp(x.${SWIZZLE[i]}, e.${SWIZZLE[i]})`).join(', ')}); }`,
          );
          return `${fn}(${a[0]}, ${a[1]})`;
        }
        return `${this.helper('_ldexp')}(${a[0]}, ${a[1]})`;
      case 'quantizeToF16':
        return this.mapped('_q16', a[0], t0, result);
      case 'modf':
        return this.modf(a[0], t0, result as StructType);
      case 'frexp':
        return this.frexp(a[0], t0, result as StructType);
      case 'pack4x8unorm':
        return `${this.helper('_p4x8u')}(${a[0]})`;
      case 'pack4x8snorm':
        return `${this.helper('_p4x8s')}(${a[0]})`;
      case 'unpack4x8unorm':
        return `${this.helper('_u4x8u')}(${a[0]})`;
      case 'unpack4x8snorm':
        return `${this.helper('_u4x8s')}(${a[0]})`;
      case 'pack2x16unorm':
        return `${this.helper('_p2x16u')}(${a[0]})`;
      case 'pack2x16snorm':
        return `${this.helper('_p2x16s')}(${a[0]})`;
      case 'pack4xI8':
        return `${this.helper('_p4i8')}(${a[0]})`;
      case 'pack4xU8':
        return `${this.helper('_p4u8')}(${a[0]})`;
      case 'pack4xI8Clamp':
        return `${this.helper('_p4i8c')}(${a[0]})`;
      case 'pack4xU8Clamp':
        return `${this.helper('_p4u8c')}(${a[0]})`;
      case 'unpack4xI8':
        return `${this.helper('_u4i8')}(${a[0]})`;
      case 'unpack4xU8':
        return `${this.helper('_u4u8')}(${a[0]})`;
      case 'dot4U8Packed':
        return `${this.helper('_d4u8')}(${a[0]}, ${a[1]})`;
      case 'dot4I8Packed':
        return `${this.helper('_d4i8')}(${a[0]}, ${a[1]})`;
    }
    throw unsupported(`the built-in ${name}() in a ${this.stage} stage`);
  }

  /** A u32 helper over a u32 or i32 scalar or vector, keeping the argument's type. */
  private unsignedMap(helper: string, arg: string, t: Type, result: Type): string {
    const s = elementOfT(t) as ScalarType;
    if (isUint(s)) return this.mapped(helper, arg, t, result);
    const n = t.kind === 'vector' ? t.size : 1;
    const ut =
      n === 1 ? ({ kind: 'scalar', name: 'u32' } as ScalarType) : vector(n as 2, { kind: 'scalar', name: 'u32' });
    const inner = this.mapped(helper, n === 1 ? `uint(${arg})` : `uvec${n}(${arg})`, ut, ut);
    return n === 1 ? `int(${inner})` : `ivec${n}(${inner})`;
  }

  /** A helper with per-component vector arguments `vecArgs` and shared scalar arguments `scalars`. */
  private vectorOf3(helper: string, vecArgs: string[], scalars: string[], t: Type, scalarOnly = false): string {
    this.helper(helper);
    if (t.kind !== 'vector' || scalarOnly) return `${helper}(${[...vecArgs, ...scalars].join(', ')})`;
    const n = t.size,
      ty = this.type(t);
    const params = vecArgs.map((_, i) => `${ty} a${i}`).concat(scalars.map((_, i) => `uint s${i}`));
    const fn = this.generated(
      `${helper}:${ty}`,
      (name) =>
        `${ty} ${name}(${params.join(', ')}) { return ${ty}(${Array.from({ length: n }, (_, c) => `${helper}(${[...vecArgs.map((__, i) => `a${i}.${SWIZZLE[c]}`), ...scalars.map((__, i) => `s${i}`)].join(', ')})`).join(', ')}); }`,
    );
    return `${fn}(${[...vecArgs, ...scalars].join(', ')})`;
  }

  private modf(arg: string, t: Type, result: StructType): string {
    const st = this.type(result),
      ty = this.type(t);
    const fn = this.generated(
      `modf:${ty}`,
      (name) => `${st} ${name}(${ty} x) { ${ty} w; ${ty} f = modf(x, w); return ${st}(f, w); }`,
    );
    return `${fn}(${arg})`;
  }

  private frexp(arg: string, t: Type, result: StructType): string {
    const st = this.type(result),
      ty = this.type(t),
      n = t.kind === 'vector' ? t.size : 1;
    const scalar = this.generated('frexp1', (name) =>
      [
        `float ${name}f(float x, out int e) {`,
        '  if (x == 0.0) { e = 0; return x; }',
        '  uint b = floatBitsToUint(x); int k = int((b >> 23u) & 0xFFu); int adjust = 0;',
        '  if (k == 0) { b = floatBitsToUint(x * 18446744073709551616.0); k = int((b >> 23u) & 0xFFu); adjust = 64; }',
        '  e = k - 126 - adjust; return uintBitsToFloat((b & 0x807FFFFFu) | 0x3F000000u);',
        '}',
      ].join('\n'),
    );
    const it = n === 1 ? 'int' : `ivec${n}`;
    const fn = this.generated(`frexp:${ty}`, (name) =>
      n === 1
        ? `${st} ${name}(float x) { int e; float f = ${scalar}f(x, e); return ${st}(f, e); }`
        : `${st} ${name}(${ty} x) { ${ty} f; ${it} e; ${Array.from({ length: n }, (_, i) => `{ int k; f.${SWIZZLE[i]} = ${scalar}f(x.${SWIZZLE[i]}, k); e.${SWIZZLE[i]} = k; }`).join(' ')} return ${st}(f, e); }`,
    );
    return `${fn}(${arg})`;
  }

  // ---------------------------------------------------------------- textures

  /**
   * The combined sampler for a texture and an optional sampler. `gatherArg` is the sampler of a textureGather call:
   * the texture is then fetched texel by texel, and the sampler only gives its address modes (a uniform).
   */
  private combined(textureArg: IRExpr, samplerArg?: IRExpr, levels = false, gatherArg?: IRExpr): GLSLTexture {
    const tex = this.handleGlobal(textureArg),
      samp = samplerArg ? this.handleGlobal(samplerArg) : undefined,
      gather = gatherArg ? this.handleGlobal(gatherArg) : undefined;
    const tt = tex.type as TextureType;
    const comparison = samp ? (samp.type as { comparison: boolean }).comparison : false;
    const key = `${tex.group}:${tex.binding}|${samp ? `${samp.group}:${samp.binding}` : ''}|${gather ? `${gather.group}:${gather.binding}` : ''}`;
    let entry = this.textures.get(key);
    if (!entry) {
      if (tt.shape === 'storage')
        throw unsupported(`storage texture '${tex.name}' (storage textures are milestone M5)`);
      if (tt.dimension === 'cube_array') throw unsupported(`cube array texture '${tex.name}' (GLSL ES 3.00 has none)`);
      let glslType = SAMPLER_TYPES[tt.dimension];
      if (tt.shape === 'depth' && comparison) glslType += 'Shadow';
      const s = tt.sampled?.name;
      if (tt.shape !== 'depth' && tt.shape !== 'depth_multisampled' && s === 'i32') glslType = `i${glslType}`;
      if (tt.shape !== 'depth' && tt.shape !== 'depth_multisampled' && s === 'u32') glslType = `u${glslType}`;
      entry = {
        group: tex.group as number,
        binding: tex.binding as number,
        sampler: samp ? { group: samp.group as number, binding: samp.binding as number, comparison } : undefined,
        name: `_s${this.prefix}${this.textures.size}`,
        type: tt,
        glslType,
      };
      if (gather)
        entry = {
          ...entry,
          gather: { name: `${entry.name}m`, group: gather.group as number, binding: gather.binding as number },
        };
      this.textures.set(key, entry);
      this.globals.push(`uniform ${glslType} ${entry.name};`);
      if (entry.gather) this.globals.push(`uniform highp ivec4 ${entry.gather.name};`);
    }
    if (levels && !entry.levels) {
      entry = { ...entry, levels: `${entry.name}l` };
      this.textures.set(key, entry);
      this.globals.push(`uniform highp int ${entry.levels};`);
    }
    return entry;
  }

  private texture(name: string, args: readonly IRExpr[], result: Type): string {
    let k = 0,
      component: string | undefined;
    if (name === 'textureGather' && args[0].type.kind !== 'texture') component = this.value(args[k++]);
    const texArg = args[k++],
      tt = texArg.type as TextureType;
    const rest = args.slice(k);
    const v = (e: IRExpr) => this.value(e);
    const coordDims = tt.dimension === '1d' ? 1 : tt.dimension === '2d' || tt.dimension === '2d_array' ? 2 : 3;
    const arrayed = tt.dimension === '2d_array';
    const depthResult = tt.shape === 'depth' || tt.shape === 'depth_multisampled';
    const coords1d = (c: string) => (tt.dimension === '1d' ? `vec2(${c}, 0.5)` : c);
    switch (name) {
      case 'textureDimensions': {
        const t = this.combined(texArg);
        const level = rest[0] ? `int(${v(rest[0])})` : '0';
        const size = `textureSize(${t.name}, ${tt.shape === 'multisampled' || tt.shape === 'depth_multisampled' ? '0' : level})`;
        if (tt.dimension === '1d') return `uint(${size}.x)`;
        if (tt.dimension === '3d') return `uvec3(${size})`;
        return `uvec2(${size}.xy)`;
      }
      case 'textureNumLayers':
        return `uint(textureSize(${this.combined(texArg).name}, 0).z)`;
      case 'textureNumLevels':
        return `uint(${this.combined(texArg, undefined, true).levels})`;
      case 'textureNumSamples':
        this.notes.add('textureNumSamples reads 1: multisampled textures are resolved before sampling on WebGL2');
        return '1u';
      case 'textureLoad': {
        const multi = tt.shape === 'multisampled' || tt.shape === 'depth_multisampled';
        const external = tt.shape === 'external';
        const t = this.combined(texArg, undefined, !multi && !external);
        const coord = v(rest[0]);
        const layer = arrayed ? v(rest[1]) : undefined;
        const last = rest[arrayed ? 2 : 1];
        if (multi && last) this.notes.add('textureLoad of a multisampled texture reads the resolved texel');
        const n = tt.dimension === '1d' ? 1 : coordDims;
        const ty = t.glslType,
          rt = this.type(depthResult ? vector(4, { kind: 'scalar', name: 'f32' }) : result);
        const fn = this.generated(`load:${ty}:${tt.dimension}`, (fname) => {
          const size = arrayed ? 'ivec3' : n === 3 ? 'ivec3' : 'ivec2';
          const c = tt.dimension === '1d' ? 'ivec2(p, 0)' : arrayed ? 'ivec3(p, a)' : 'p';
          const pparams = `${n === 1 ? 'int' : `ivec${n}`} p${arrayed ? ', int a' : ''}`;
          return `${rt} ${fname}(highp ${ty} t, ${pparams}, int l, int n) { int m = clamp(l, 0, max(n - 1, 0)); ${size} s = textureSize(t, m) - 1; return texelFetch(t, clamp(${c}, ${size}(0), s), m); }`;
        });
        const levelCount = multi || external ? '1' : (t.levels as string);
        const level = multi || external || !last ? '0' : `int(${v(last)})`;
        const p = `${n === 1 ? 'int' : `ivec${n}`}(${coord})`;
        const call = `${fn}(${t.name}, ${p}${arrayed ? `, int(${layer})` : ''}, ${level}, ${levelCount})`;
        return depthResult ? `${call}.x` : call;
      }
      case 'textureSample':
      case 'textureSampleBias':
      case 'textureSampleLevel':
      case 'textureSampleGrad': {
        const t = this.combined(texArg, rest[0]);
        let i = 1;
        let coord = coords1d(v(rest[i++]));
        if (arrayed) coord = `vec3(${coord}, float(${v(rest[i++])}))`;
        let extra = '';
        let fn = 'texture';
        if (name === 'textureSampleBias') extra = `, ${v(rest[i++])}`;
        if (name === 'textureSampleLevel') {
          fn = 'textureLod';
          extra = `, float(${v(rest[i++])})`;
        }
        if (name === 'textureSampleGrad') {
          fn = 'textureGrad';
          const dx = v(rest[i++]),
            dy = v(rest[i++]);
          extra = tt.dimension === '1d' ? `, vec2(${dx}, 0.0), vec2(${dy}, 0.0)` : `, ${dx}, ${dy}`;
        }
        const offset = rest[i] ? (tt.dimension === '1d' ? `ivec2(${v(rest[i])}, 0)` : v(rest[i])) : undefined;
        let call: string;
        if (offset) {
          if (name === 'textureSampleBias') call = `textureOffset(${t.name}, ${coord}, ${offset}${extra})`;
          else call = `${fn}Offset(${t.name}, ${coord}${extra}, ${offset})`;
        } else call = `${fn}(${t.name}, ${coord}${extra})`;
        if (tt.shape === 'depth') return `${call}.x`;
        return call;
      }
      case 'textureSampleCompare':
      case 'textureSampleCompareLevel': {
        const t = this.combined(texArg, rest[0]);
        let i = 1;
        const c = v(rest[i++]);
        const layer = arrayed || tt.dimension === 'cube_array' ? v(rest[i++]) : undefined;
        const ref = v(rest[i++]);
        const offset = rest[i] ? v(rest[i]) : undefined;
        const p =
          tt.dimension === '2d'
            ? `vec3(${c}, ${ref})`
            : tt.dimension === '2d_array'
              ? `vec4(${c}, float(${layer}), ${ref})`
              : `vec4(${c}, ${ref})`;
        // Level 0 (CompareLevel) and implicit derivatives (Compare) both as explicit gradients: GLSL ES 3.00 has
        // textureLod only for sampler2DShadow, and textureGrad for every shadow sampler.
        const g = tt.dimension === 'cube' ? 'vec3' : 'vec2';
        const level0 = name === 'textureSampleCompareLevel';
        const dx = level0 ? `${g}(0.0)` : `dFdx(${c})`,
          dy = level0 ? `${g}(0.0)` : `dFdy(${c})`;
        if (!level0 && !offset) return `texture(${t.name}, ${p})`;
        if (offset) return `textureGradOffset(${t.name}, ${p}, ${dx}, ${dy}, ${offset})`;
        if (tt.dimension === '2d') return `textureLod(${t.name}, ${p}, 0.0)`;
        return `textureGrad(${t.name}, ${p}, ${dx}, ${dy})`;
      }
      case 'textureSampleBaseClampToEdge': {
        const t = this.combined(texArg, rest[0]);
        const c = v(rest[1]);
        const fn = this.generated(
          `clampedge:${t.glslType}`,
          (fname) =>
            `vec4 ${fname}(highp ${t.glslType} t, vec2 c) { vec2 h = 0.5 / vec2(textureSize(t, 0)); return textureLod(t, clamp(c, h, 1.0 - h), 0.0); }`,
        );
        return `${fn}(${t.name}, ${c})`;
      }
      case 'textureGather':
      case 'textureGatherCompare':
        return this.gather(name === 'textureGatherCompare', component, texArg, rest);
    }
    throw unsupported(`the texture built-in ${name}()`);
  }

  /**
   * textureGather and textureGatherCompare, which GLSL ES 3.00 lacks: the four texels of the bilinear footprint at
   * level 0, fetched with the sampler's address modes applied by hand, in WGSL's order (x: u0 v1, y: u1 v1, z: u1 v0,
   * w: u0 v0); the comparison form compares each with the reference by the sampler's compare function.
   */
  private gather(compare: boolean, component: string | undefined, texArg: IRExpr, rest: readonly IRExpr[]): string {
    const tt = texArg.type as TextureType;
    if (tt.dimension !== '2d' && tt.dimension !== '2d_array')
      throw unsupported(`textureGather on a ${tt.dimension} texture (GLSL ES 3.00 cannot fetch texels of cube maps)`);
    const t = this.combined(texArg, undefined, false, rest[0]);
    const arrayed = tt.dimension === '2d_array',
      depth = tt.shape === 'depth';
    let i = 1;
    const coord = this.value(rest[i++]);
    const layer = arrayed ? `int(${this.value(rest[i++])})` : '';
    const ref = compare ? this.value(rest[i++]) : '';
    const offset = rest[i] ? this.value(rest[i]) : 'ivec2(0)';
    const c = depth ? 'x' : (SWIZZLE[Number(component ?? 0)] ?? 'x');
    const rt =
      compare || depth ? 'vec4' : `${t.glslType.startsWith('u') ? 'u' : t.glslType.startsWith('i') ? 'i' : ''}vec4`;
    const wrap = this.generated(
      'gatherwrap',
      (fn) =>
        `int ${fn}(int i, int n, int m) { if (m == 1) { int k = i % n; return k < 0 ? k + n : k; } if (m == 2) { int p = 2 * n; int k = i % p; k = k < 0 ? k + p : k; return k < n ? k : p - 1 - k; } return clamp(i, 0, n - 1); }`,
    );
    const test = compare
      ? this.generated(
          'gathertest',
          (fn) =>
            `float ${fn}(float r, float d, int f) { bool p = f == 1 ? false : f == 2 ? r < d : f == 3 ? r == d : f == 4 ? r <= d : f == 5 ? r > d : f == 6 ? r != d : f == 7 ? r >= d : true; return p ? 1.0 : 0.0; }`,
        )
      : '';
    const fn = this.generated(`gather:${t.glslType}:${c}:${compare}`, (name) => {
      const at = (x: string, y: string) =>
        `texelFetch(t, ${arrayed ? `ivec3(${x}, ${y}, a)` : `ivec2(${x}, ${y})`}, 0).${c}`;
      const texel = (x: string, y: string) => (compare ? `${test}(r, ${at(x, y)}, m.w)` : at(x, y));
      return [
        `${rt} ${name}(highp ${t.glslType} t, vec2 c${arrayed ? ', int a' : ''}${compare ? ', float r' : ''}, ivec2 o, ivec4 m) {`,
        `  ivec${arrayed ? 3 : 2} z = textureSize(t, 0); ivec2 s = z.xy;${arrayed ? ' a = clamp(a, 0, z.z - 1);' : ''}`,
        '  ivec2 i0 = ivec2(floor(c * vec2(s) - 0.5)) + o, i1 = i0 + 1;',
        `  int x0 = ${wrap}(i0.x, s.x, m.x), x1 = ${wrap}(i1.x, s.x, m.x), y0 = ${wrap}(i0.y, s.y, m.y), y1 = ${wrap}(i1.y, s.y, m.y);`,
        `  return ${rt}(${texel('x0', 'y1')}, ${texel('x1', 'y1')}, ${texel('x1', 'y0')}, ${texel('x0', 'y0')});`,
        '}',
      ].join('\n');
    });
    return `${fn}(${t.name}, ${coord}${arrayed ? `, ${layer}` : ''}${compare ? `, float(${ref})` : ''}, ${offset}, ${t.gather?.name})`;
  }

  // ---------------------------------------------------------------- entry point interface

  private mainFunction(main: FnInstance): {
    declarations: string[];
    main: string;
    inputs: GLSLLocation[];
    outputs: GLSLLocation[];
    varyings: GLSLVarying[];
    fragDepth: boolean;
  } {
    const fn = this.entry.function;
    const declarations: string[] = [],
      inputs: GLSLLocation[] = [],
      outputs: GLSLLocation[] = [],
      varyings: GLSLVarying[] = [],
      body: string[] = [];
    let fragDepth = false;
    const vertex = this.stage === 'vertex';
    const given = new Map((this.options.varyings ?? []).map((x) => [x.location, x]));
    const locationType = (t: Type) => {
      const s = elementOfT(t) as ScalarType;
      return { kind: kindOf(s), components: t.kind === 'vector' ? t.size : 1 };
    };
    const interp = (io: { interpolate?: readonly string[] }, t: Type): GLSLVarying['interpolation'] => {
      const s = elementOfT(t) as ScalarType;
      if (!isFloatS(s)) return 'flat';
      const kind = io.interpolate?.[0];
      return kind === 'flat' ? 'flat' : kind === 'linear' ? 'linear' : 'perspective';
    };
    const qualifier = (v: GLSLVarying) =>
      `${v.interpolation === 'flat' ? 'flat ' : ''}${v.sampling === 'centroid' ? 'centroid ' : ''}`;
    // Inputs: one GLSL expression per WGSL input.
    const input = (t: Type, io: { location?: number; builtin?: string; interpolate?: readonly string[] }): string => {
      if (io.builtin) return this.builtinInput(io.builtin);
      const loc = io.location as number;
      if (vertex) {
        const name = `_a${loc}`;
        declarations.push(`layout(location = ${loc}) in ${this.type(t)} ${name};`);
        inputs.push({ location: loc, ...locationType(t) });
        return name;
      }
      const v: GLSLVarying = {
        location: loc,
        glslType: this.type(t),
        interpolation: interp(io, t),
        sampling: io.interpolate?.[1],
      };
      const from = given.get(loc);
      const use = from ?? v;
      declarations.push(`${qualifier(use)}in ${use.glslType} _v${loc};`);
      varyings.push(use);
      if (use.sampling === 'sample') this.notes.add('@interpolate(..., sample) is centre-sampled on WebGL2');
      return use.interpolation === 'linear' ? `(_v${loc} * gl_FragCoord.w)` : `_v${loc}`;
    };
    const args = fn.params.map((p) => {
      if (p.type.kind === 'struct' && p.io.location === undefined && p.io.builtin === undefined) {
        const st = p.type;
        return `${this.type(st)}(${st.members.map((m) => input(m.type, m)).join(', ')})`;
      }
      return input(p.type, p.io);
    });
    const call = `${main.name}(${args.join(', ')})`;
    // Outputs.
    const sets: string[] = [];
    const output = (
      t: Type,
      io: {
        location?: number;
        builtin?: string;
        interpolate?: readonly string[];
        invariant?: boolean;
        blendSrc?: number;
      },
      code: string,
    ) => {
      if (io.builtin) {
        switch (io.builtin) {
          case 'position':
            sets.push(`gl_Position = ${code};`);
            if (io.invariant) declarations.push('invariant gl_Position;');
            return;
          case 'frag_depth':
            fragDepth = true;
            sets.push(`gl_FragDepth = ${code};`);
            return;
          case 'sample_mask':
            this.notes.add('@builtin(sample_mask) output is dropped on WebGL2');
            return;
          case 'clip_distances':
            throw unsupported('@builtin(clip_distances)');
        }
        throw unsupported(`@builtin(${io.builtin}) as an output`);
      }
      const loc = io.location as number;
      if (vertex) {
        if (this.options.varyingsRead && !this.options.varyingsRead.has(loc)) return;
        const v: GLSLVarying = {
          location: loc,
          glslType: this.type(t),
          interpolation: interp(io, t),
          sampling: io.interpolate?.[1],
        };
        declarations.push(`${qualifier(v)}out ${v.glslType} _v${loc};`);
        varyings.push(v);
        sets.push(v.interpolation === 'linear' ? `_v${loc} = ${code} * _pos.w;` : `_v${loc} = ${code};`);
        return;
      }
      if (io.blendSrc !== undefined) throw unsupported('dual-source blending (@blend_src)');
      declarations.push(`layout(location = ${loc}) out ${this.type(t)} _o${loc};`);
      outputs.push({ location: loc, ...locationType(t) });
      sets.push(`_o${loc} = ${code};`);
    };
    const ret = fn.returnType;
    if (ret.kind === 'void') body.push(`${call};`);
    else {
      const rt = this.type(ret);
      body.push(`${rt} _r = ${call};`);
      if (ret.kind === 'struct' && fn.returnIO.location === undefined && fn.returnIO.builtin === undefined)
        for (const m of ret.members) output(m.type, m, `_r.${this.memberName(m.name)}`);
      else output(ret, fn.returnIO, '_r');
    }
    if (vertex) {
      // The clip position first (linear varyings scale by its w), then the flip into WebGL2's window space.
      const pos = sets.find((s) => s.startsWith('gl_Position = ')) as string;
      body.push(`vec4 _pos = ${pos.slice('gl_Position = '.length, -1)};`);
      for (const s of sets) if (s !== pos) body.push(s);
      body.push('gl_Position = vec4(_pos.x, -_pos.y, _pos.z, _pos.w);');
      if (this.options.clipControl === false) body.push('gl_Position.z = 2.0 * _pos.z - _pos.w;');
      if (this.options.points) body.push('gl_PointSize = 1.0;');
    } else body.push(...sets);
    if (this.baseVertex) declarations.push('uniform highp uint _bv;');
    if (this.baseInstance) declarations.push('uniform highp uint _bi;');
    return {
      declarations,
      main: `void main() {\n${body.map((b) => `  ${b}`).join('\n')}\n}`,
      inputs,
      outputs,
      varyings,
      fragDepth,
    };
  }

  private builtinInput(name: string): string {
    switch (name) {
      case 'vertex_index':
        this.baseVertex = true;
        return '(uint(gl_VertexID) + _bv)';
      case 'instance_index':
        this.baseInstance = true;
        return '(uint(gl_InstanceID) + _bi)';
      case 'position':
        return 'gl_FragCoord';
      case 'front_facing':
        return 'gl_FrontFacing';
      case 'sample_index':
        this.notes.add('@builtin(sample_index) reads 0 on WebGL2');
        return '0u';
      case 'sample_mask':
        this.notes.add('@builtin(sample_mask) input reads all samples covered on WebGL2');
        return '0xFFFFFFFFu';
    }
    throw unsupported(`@builtin(${name}) as an input`);
  }
}
