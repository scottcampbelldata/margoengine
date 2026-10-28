// WGSL resolver and type checker (W3C WGSL specification, sections 5 to 13): module-scope declarations in any order
// with cycle detection, lexical scopes, the predeclared types and enumerants, the Load Rule and memory views,
// abstract-number materialization, operator and built-in overloads, constructors and conversions, constant folding,
// statement rules (loops, switch, continuing, behaviors for missing returns), resources and entry-point interfaces.
// Produces the typed IR (ir.ts). Uniformity analysis is not done here: the browser's own compiler keeps that check.
import type * as A from './ast.js';
import { type BuiltinResult, BUILTIN_NAMES, resolveBuiltin, unify } from './builtins.js';
import * as K from './constant.js';
import type { SourceMap, WGSLError } from './errors.js';
import type {
  ConstValue,
  IOAttributes,
  IRExpr,
  IRFunction,
  IRGlobalConst,
  IRGlobalVar,
  IRLocal,
  IRModule,
  IROverride,
  IRParam,
  IRStmt,
  IRValueDeclaration,
  ShaderStage,
} from './ir.js';
import {
  type AccessMode,
  type AddressSpace,
  AFLOAT,
  AINT,
  type ArrayType,
  BOOL,
  concretize,
  conversionRank,
  elementOf,
  F16,
  F32,
  hasAbstract,
  I32,
  isAbstract,
  isConstructible,
  isFloat,
  isHostShareable,
  isInteger,
  isNumeric,
  isSigned,
  isStorable,
  layoutStruct,
  type MatrixType,
  matrix,
  type ScalarType,
  STORAGE_FORMATS,
  type StructType,
  sameType,
  sizeOf,
  type TextureDimension,
  type Type,
  typeName,
  U32,
  VOID,
  vector,
  withElement,
} from './types.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Global = IRGlobalVar | IRGlobalConst | IROverride;
type FnState = {
  fn: Mutable<IRFunction> & {
    calls: Set<IRFunction>;
    uses: Set<IRGlobalVar | IROverride>;
    stages: Set<'fragment' | 'compute'>;
  };
  returnType: A.Expr | undefined;
  loops: number;
  switches: number;
  continuing: boolean;
};

const SPACES = new Set(['function', 'private', 'workgroup', 'uniform', 'storage']);
const ACCESS = new Set(['read', 'write', 'read_write']);
const BUILTIN_IO: Record<string, { type: string; stages: Record<string, 'in' | 'out' | 'both'> }> = {
  vertex_index: { type: 'u32', stages: { vertex: 'in' } },
  instance_index: { type: 'u32', stages: { vertex: 'in' } },
  position: { type: 'vec4<f32>', stages: { vertex: 'out', fragment: 'in' } },
  front_facing: { type: 'bool', stages: { fragment: 'in' } },
  frag_depth: { type: 'f32', stages: { fragment: 'out' } },
  sample_index: { type: 'u32', stages: { fragment: 'in' } },
  sample_mask: { type: 'u32', stages: { fragment: 'both' } },
  local_invocation_id: { type: 'vec3<u32>', stages: { compute: 'in' } },
  local_invocation_index: { type: 'u32', stages: { compute: 'in' } },
  global_invocation_id: { type: 'vec3<u32>', stages: { compute: 'in' } },
  workgroup_id: { type: 'vec3<u32>', stages: { compute: 'in' } },
  num_workgroups: { type: 'vec3<u32>', stages: { compute: 'in' } },
  subgroup_invocation_id: { type: 'u32', stages: { compute: 'in', fragment: 'in' } },
  subgroup_size: { type: 'u32', stages: { compute: 'in', fragment: 'in' } },
  primitive_index: { type: 'u32', stages: { fragment: 'in' } },
  clip_distances: { type: 'array', stages: { vertex: 'out' } },
};

const TEXTURE_DIMS: Record<string, TextureDimension> = {
  '1d': '1d',
  '2d': '2d',
  '2d_array': '2d_array',
  '3d': '3d',
  cube: 'cube',
  cube_array: 'cube_array',
};

/** Behaviors of statements (WGSL section 9.7), for the "returns on every path" rule. */
type Behavior = 'next' | 'return' | 'break' | 'continue';

/** Checks a parsed module and builds its IR. Throws {@link WGSLError} with code `type` (or `limit`). */
export function check(ast: A.ModuleAst, map: SourceMap): IRModule {
  return new Checker(ast, map).run();
}

class Checker {
  private readonly decls = new Map<string, A.GlobalDecl>();
  private readonly types = new Map<string, Type>();
  private readonly globals = new Map<string, Global>();
  private readonly functions = new Map<string, Mutable<IRFunction>>();
  private readonly resolving = new Set<string>();
  private readonly enables = new Set<string>();
  private readonly structs: StructType[] = [];
  private scopes: Map<string, IRLocal | IRParam>[] = [];
  private state: FnState | undefined;
  private depth = 0;

  constructor(
    private readonly ast: A.ModuleAst,
    private readonly map: SourceMap,
  ) {}

  private fail(detail: string, at: { start: number } | number, code: 'type' | 'limit' = 'type'): WGSLError {
    return this.map.error(code, detail, typeof at === 'number' ? at : at.start);
  }

  private guard<T>(at: { start: number }, run: () => T): T {
    try {
      return run();
    } catch (error) {
      // Folding faults carry no position; this is the one place that adds it.
      if (error instanceof K.ConstFault) throw this.fail(error.detail, at, error.code);
      throw error;
    }
  }

  run(): IRModule {
    const requires: string[] = [];
    for (const d of this.ast.directives) {
      if (d.kind === 'enable') for (const n of d.names) this.enables.add(n);
      if (d.kind === 'requires') requires.push(...d.names);
    }
    for (const d of this.ast.declarations) {
      if (d.kind === 'const_assert') continue;
      const name = d.kind === 'global' ? d.decl.name : d.name;
      const at = d.kind === 'global' ? d.decl.nameStart : d.nameStart;
      if (this.decls.has(name)) throw this.fail(`'${name}' is declared twice at module scope; rename one`, at);
      this.decls.set(name, d);
    }
    for (const d of this.ast.declarations) {
      if (d.kind === 'struct' || d.kind === 'alias') this.typeDecl(d.name);
      else if (d.kind === 'global') this.global(d.decl.name);
      else if (d.kind === 'fn') this.signature(d);
    }
    for (const d of this.ast.declarations) if (d.kind === 'const_assert') this.constAssert(d.expr);
    for (const d of this.ast.declarations) if (d.kind === 'fn') this.body(d);
    this.recursion();
    const functions = [...this.functions.values()];
    const entryPoints = functions
      .filter((f) => f.stage)
      .map((f) => ({ name: f.name, stage: f.stage as ShaderStage, function: f, globals: this.reach(f) }));
    for (const e of entryPoints) {
      this.entryStages(e.function, e.stage);
      this.bindings(e.function, e.globals);
    }
    return {
      enables: [...this.enables],
      requires,
      structs: this.structs,
      globals: [...this.globals.values()],
      functions,
      entryPoints,
      locate: (offset) => this.map.locate(offset),
    };
  }

  // ---------------------------------------------------------------- module-scope declarations

  private typeDecl(name: string): Type {
    const known = this.types.get(name);
    if (known) return known;
    const d = this.decls.get(name) as A.StructDecl | A.AliasDecl;
    if (this.resolving.has(name))
      throw this.fail(`'${name}' refers to itself; a type cannot contain itself`, d.nameStart);
    this.resolving.add(name);
    let t: Type;
    if (d.kind === 'alias') t = this.type(d.type);
    else {
      const seen = new Set<string>();
      const members = d.members.map((m, i) => {
        if (seen.has(m.name)) throw this.fail(`Struct '${name}' has two members named '${m.name}'`, m.nameStart);
        seen.add(m.name);
        const type = this.type(m.type);
        if (!isStorable(type) || type.kind === 'sampler' || type.kind === 'texture')
          throw this.fail(`Struct member '${m.name}' cannot have type ${typeName(type)}`, m.type);
        if (type.kind === 'array' && type.count === 'runtime' && i !== d.members.length - 1)
          throw this.fail(
            `Only the last member of a struct may be a runtime-sized array; move '${m.name}' to the end`,
            m.type,
          );
        if (
          type.kind === 'struct' &&
          type.members.at(-1)?.type.kind === 'array' &&
          (type.members.at(-1)?.type as ArrayType).count === 'runtime'
        )
          throw this.fail(`'${typeName(type)}' ends in a runtime-sized array, so it cannot be a member`, m.type);
        return { name: m.name, type, ...this.memberAttributes(m.attributes, type) };
      });
      if (!members.length) throw this.fail(`Struct '${name}' has no members; give it at least one`, d.nameStart);
      t = layoutStruct(name, members);
      this.structs.push(t);
    }
    this.resolving.delete(name);
    this.types.set(name, t);
    return t;
  }

  private memberAttributes(attributes: readonly A.Attribute[], type: Type) {
    const out: { align?: number; size?: number } & Mutable<IOAttributes> = {};
    for (const a of attributes) {
      switch (a.name) {
        case 'align': {
          const n = this.attributeInt(a);
          if (n <= 0 || (n & (n - 1)) !== 0) throw this.fail('@align needs a positive power of two', a);
          out.align = n;
          break;
        }
        case 'size': {
          const n = this.attributeInt(a);
          if (n < sizeOf(type))
            throw this.fail(`@size(${n}) is smaller than ${typeName(type)} (${sizeOf(type)} bytes)`, a);
          out.size = n;
          break;
        }
        default:
          Object.assign(out, this.ioAttribute(a, out));
      }
    }
    return out;
  }

  private ioAttribute(a: A.Attribute, out: Mutable<IOAttributes>): Mutable<IOAttributes> {
    switch (a.name) {
      case 'location':
        out.location = this.attributeInt(a);
        if (out.location < 0) throw this.fail('@location needs a value of 0 or more', a);
        return out;
      case 'builtin': {
        const name = a.args[0]?.kind === 'ident' ? a.args[0].name : '';
        if (!(name in BUILTIN_IO)) throw this.fail(`'${name}' is not a WGSL built-in value`, a.args[0] ?? a);
        out.builtin = name;
        return out;
      }
      case 'interpolate': {
        const names = a.args.map((x) => (x.kind === 'ident' ? x.name : ''));
        const [type, sampling] = names;
        if (!['perspective', 'linear', 'flat'].includes(type))
          throw this.fail('@interpolate needs perspective, linear or flat first', a);
        if (sampling !== undefined && !['center', 'centroid', 'sample', 'first', 'either'].includes(sampling))
          throw this.fail(
            `'${sampling}' is not an interpolation sampling (center, centroid, sample, first, either)`,
            a,
          );
        out.interpolate = names;
        return out;
      }
      case 'invariant':
        out.invariant = true;
        return out;
      case 'blend_src':
        out.blendSrc = this.attributeInt(a);
        return out;
    }
    throw this.fail(`@${a.name} does not apply here`, a);
  }

  private attributeInt(a: A.Attribute): number {
    if (a.args.length !== 1) throw this.fail(`@${a.name} takes one argument`, a);
    const e = this.value(a.args[0]);
    if (
      e.value === undefined ||
      typeof e.value !== 'number' ||
      !isInteger(elementOf(e.type) ?? BOOL) ||
      e.type.kind !== 'scalar'
    )
      throw this.fail(`@${a.name} needs a constant integer`, a.args[0]);
    return e.value;
  }

  private global(name: string): Global {
    const known = this.globals.get(name);
    if (known) return known;
    const g = this.decls.get(name) as A.GlobalValue,
      d = g.decl;
    if (this.resolving.has(name)) throw this.fail(`'${name}' depends on itself`, d.nameStart);
    this.resolving.add(name);
    let out: Global;
    if (d.kind === 'const') out = this.constDecl(d) as IRGlobalConst;
    else if (d.kind === 'override') out = this.override(d);
    else out = this.globalVar(d);
    this.resolving.delete(name);
    this.globals.set(name, out);
    return out;
  }

  private constDecl(d: A.ValueDecl): {
    kind: 'const' | 'local-const';
    name: string;
    type: Type;
    value: ConstValue;
    start: number;
    end: number;
  } {
    if (d.attributes.length) throw this.fail('const declarations take no attributes', d.attributes[0]);
    let init = this.value(d.init as A.Expr);
    if (init.value === undefined)
      throw this.fail(
        `'${d.name}' is const, so its initializer must be a constant expression; use 'let' or 'override' for runtime values`,
        d.init as A.Expr,
      );
    if (d.type) init = this.convertTo(init, this.type(d.type), d.init as A.Expr);
    if (!isConstructible(init.type)) throw this.fail(`A const cannot hold ${typeName(init.type)}`, d);
    return {
      kind: 'const',
      name: d.name,
      type: init.type,
      value: init.value as ConstValue,
      start: d.start,
      end: d.end,
    };
  }

  private override(d: A.ValueDecl): IROverride {
    let id: number | undefined;
    for (const a of d.attributes) {
      if (a.name !== 'id') throw this.fail(`@${a.name} does not apply to an override`, a);
      id = this.attributeInt(a);
    }
    let type = d.type ? this.type(d.type) : undefined;
    let init = d.init ? this.value(d.init) : undefined;
    if (!type && init) type = concretize(init.type);
    if (!type) throw this.fail(`override '${d.name}' needs a type or an initializer`, d.nameStart);
    if (type.kind !== 'scalar' || isAbstract(type))
      throw this.fail(`override '${d.name}' must be a bool, i32, u32, f32 or f16 scalar`, d.type ?? d);
    if (init) init = this.convertTo(init, type, d.init as A.Expr);
    return { kind: 'override', name: d.name, type, id, init, start: d.start, end: d.end };
  }

  private globalVar(d: A.ValueDecl): IRGlobalVar {
    const type = d.type ? this.type(d.type) : undefined;
    let space: AddressSpace = 'private',
      access: AccessMode = 'read_write';
    if (d.template) {
      const names = d.template.map((e) => (e.kind === 'ident' ? e.name : ''));
      if (!SPACES.has(names[0]))
        throw this.fail(`'${names[0]}' is not an address space (private, workgroup, uniform, storage)`, d.template[0]);
      space = names[0] as AddressSpace;
      if (space === 'function')
        throw this.fail("Module-scope variables cannot be in the 'function' address space", d.template[0]);
      if (names[1] !== undefined) {
        if (!ACCESS.has(names[1]))
          throw this.fail(`'${names[1]}' is not an access mode (read, write, read_write)`, d.template[1]);
        if (space !== 'storage') throw this.fail(`Only storage variables take an access mode`, d.template[1]);
        access = names[1] as AccessMode;
      } else access = space === 'uniform' || space === 'storage' ? 'read' : 'read_write';
      if (space === 'storage' && access === 'write')
        throw this.fail("Storage buffers are 'read' or 'read_write'", d.template[1]);
    } else if (type && (type.kind === 'sampler' || type.kind === 'texture')) {
      space = 'handle';
      access = 'read';
    } else
      throw this.fail(
        `var '${d.name}' at module scope needs an address space: var<private>, var<workgroup>, var<uniform> or var<storage>`,
        d,
      );
    if (!type) throw this.fail(`var '${d.name}' at module scope needs a type`, d.nameStart);
    let group: number | undefined, binding: number | undefined;
    for (const a of d.attributes) {
      if (a.name !== 'group' && a.name !== 'binding') throw this.fail(`@${a.name} does not apply to a variable`, a);
      const n = this.attributeInt(a);
      if (n < 0) throw this.fail(`@${a.name} needs a value of 0 or more`, a);
      if (a.name === 'group') group = n;
      else binding = n;
    }
    const resource = space === 'uniform' || space === 'storage' || space === 'handle';
    if (resource && (group === undefined || binding === undefined))
      throw this.fail(`Resource '${d.name}' needs @group and @binding`, d);
    if (!resource && (group !== undefined || binding !== undefined))
      throw this.fail(`Only resources take @group and @binding; '${d.name}' is ${space}`, d);
    if ((space === 'uniform' || space === 'storage') && !isHostShareable(type))
      throw this.fail(
        `${typeName(type)} cannot live in a ${space} buffer (bool and abstract types are not host-shareable)`,
        d.type as A.Expr,
      );
    if (space === 'uniform' && (type.kind === 'atomic' || containsRuntimeArray(type)))
      throw this.fail('Uniform buffers cannot hold atomics or runtime-sized arrays', d.type as A.Expr);
    if (space !== 'storage' && space !== 'workgroup' && containsAtomic(type))
      throw this.fail(`Atomics live only in storage or workgroup memory, not ${space}`, d.type as A.Expr);
    let init: IRExpr | undefined;
    if (d.init) {
      if (space !== 'private')
        throw this.fail(`Only private variables may have an initializer; '${d.name}' is ${space}`, d.init);
      init = this.convertTo(this.value(d.init), type, d.init);
      if (init.value === undefined) throw this.fail('A module-scope initializer must be a constant expression', d.init);
    }
    return { kind: 'var', name: d.name, type, space, access, group, binding, init, start: d.start, end: d.end };
  }

  private signature(d: A.FunctionDecl): Mutable<IRFunction> {
    const known = this.functions.get(d.name);
    if (known) return known;
    let stage: ShaderStage | undefined, workgroupSize: (number | IRExpr)[] | undefined;
    for (const a of d.attributes) {
      if (a.name === 'vertex' || a.name === 'fragment' || a.name === 'compute') {
        if (stage) throw this.fail(`'${d.name}' has two stage attributes`, a);
        stage = a.name;
      } else if (a.name === 'workgroup_size') {
        if (!a.args.length || a.args.length > 3) throw this.fail('@workgroup_size takes 1 to 3 values', a);
        workgroupSize = a.args.map((x) => {
          const e = this.value(x);
          if (!isInteger(elementOf(e.type) ?? BOOL) || e.type.kind !== 'scalar')
            throw this.fail('@workgroup_size values must be integers', x);
          if (typeof e.value === 'number' && e.value < 1)
            throw this.fail('@workgroup_size values must be 1 or more', x);
          return typeof e.value === 'number' ? e.value : e;
        });
      } else if (a.name !== 'must_use' && a.name !== 'diagnostic')
        throw this.fail(`@${a.name} does not apply to a function`, a);
    }
    if (stage === 'compute' && !workgroupSize)
      throw this.fail(`Compute entry point '${d.name}' needs @workgroup_size`, d.nameStart);
    if (stage !== 'compute' && workgroupSize)
      throw this.fail('@workgroup_size applies only to compute entry points', d.nameStart);
    const names = new Set<string>();
    const params: IRParam[] = d.params.map((p) => {
      if (names.has(p.name)) throw this.fail(`Two parameters are named '${p.name}'`, p.nameStart);
      names.add(p.name);
      const type = this.type(p.type);
      if (!(isConstructible(type) || type.kind === 'ptr' || type.kind === 'sampler' || type.kind === 'texture'))
        throw this.fail(`A parameter cannot have type ${typeName(type)}`, p.type);
      const io: Mutable<IOAttributes> = {};
      for (const a of p.attributes) this.ioAttribute(a, io);
      return { kind: 'param', name: p.name, type, io, start: p.start, end: p.end };
    });
    const returnType = d.returnType ? this.type(d.returnType) : VOID;
    if (returnType !== VOID && !isConstructible(returnType))
      throw this.fail(`A function cannot return ${typeName(returnType)}`, d.returnType as A.Expr);
    const returnIO: Mutable<IOAttributes> = {};
    for (const a of d.returnAttributes) this.ioAttribute(a, returnIO);
    const fn = {
      name: d.name,
      params,
      returnType,
      returnIO,
      body: [] as IRStmt[],
      stage,
      workgroupSize,
      calls: new Set<IRFunction>(),
      uses: new Set<IRGlobalVar | IROverride>(),
      stages: new Set<'fragment' | 'compute'>(),
      start: d.start,
      end: d.end,
    };
    this.functions.set(d.name, fn);
    if (stage) this.entryInterface(fn, d);
    return fn;
  }

  private entryInterface(fn: Mutable<IRFunction>, d: A.FunctionDecl): void {
    const stage = fn.stage as ShaderStage;
    const visit = (type: Type, io: IOAttributes, dir: 'in' | 'out', at: { start: number }) => {
      if (type.kind === 'struct' && io.location === undefined && io.builtin === undefined) {
        for (const m of type.members) {
          if (m.type.kind === 'struct')
            throw this.fail(`Entry-point struct '${type.name}' cannot nest struct '${m.type.name}'`, at);
          visit(m.type, m, dir, at);
        }
        return;
      }
      if (io.builtin) {
        const b = BUILTIN_IO[io.builtin];
        if (b.stages[stage] !== dir && b.stages[stage] !== 'both')
          throw this.fail(`@builtin(${io.builtin}) is not a ${stage} ${dir === 'in' ? 'input' : 'output'}`, at);
        if (b.type !== 'array' && b.type !== typeName(type))
          throw this.fail(`@builtin(${io.builtin}) must have type ${b.type}, not ${typeName(type)}`, at);
        return;
      }
      if (io.location === undefined)
        throw this.fail(
          `Every ${stage} entry-point ${dir === 'in' ? 'input' : 'output'} needs @location or @builtin`,
          at,
        );
      if (stage === 'compute') throw this.fail('Compute entry points have no @location inputs or outputs', at);
      const e = elementOf(type);
      if (!e || type.kind === 'matrix' || !isNumeric(e))
        throw this.fail(`@location values must be numeric scalars or vectors, not ${typeName(type)}`, at);
      if (isInteger(e) && dir === 'out' && stage === 'vertex' && io.interpolate?.[0] !== 'flat')
        throw this.fail('Integer vertex outputs need @interpolate(flat)', at);
    };
    for (const [i, p] of fn.params.entries()) visit(p.type, p.io, 'in', d.params[i]);
    if (fn.returnType !== VOID) visit(fn.returnType, fn.returnIO, 'out', d.returnType as A.Expr);
    if (stage === 'vertex') {
      const hasPosition = (t: Type, io: IOAttributes): boolean =>
        io.builtin === 'position' || (t.kind === 'struct' && t.members.some((m) => m.builtin === 'position'));
      if (fn.returnType === VOID || !hasPosition(fn.returnType, fn.returnIO))
        throw this.fail(`Vertex entry point '${fn.name}' must return @builtin(position)`, d.nameStart);
    }
    if (stage === 'compute' && fn.returnType !== VOID)
      throw this.fail('Compute entry points return nothing', d.returnType as A.Expr);
  }

  // ---------------------------------------------------------------- types

  /** Resolves a type expression. */
  private type(e: A.Expr): Type {
    if (e.kind !== 'ident') throw this.fail('Expected a type', e);
    const local = this.lookupLocal(e.name);
    if (local) throw this.fail(`'${e.name}' is a value, not a type`, e);
    const d = this.decls.get(e.name);
    if (d) {
      if (d.kind !== 'struct' && d.kind !== 'alias') throw this.fail(`'${e.name}' is not a type`, e);
      if (e.template) throw this.fail(`'${e.name}' takes no template arguments`, e);
      return this.typeDecl(e.name);
    }
    const t = this.predeclaredType(e);
    if (!t) throw this.fail(`Unknown type '${e.name}'`, e);
    return t;
  }

  private templateNames(e: A.IdentExpr): string[] {
    return (e.template ?? []).map((x) => (x.kind === 'ident' && !x.template ? x.name : ''));
  }

  /** The predeclared type an identifier names, or undefined when it names none. */
  private predeclaredType(e: A.IdentExpr): Type | undefined {
    const n = e.name,
      tpl = e.template;
    const noTemplate = (t: Type) => {
      if (tpl) throw this.fail(`'${n}' takes no template arguments`, e);
      return t;
    };
    const elementArg = (i = 0): ScalarType => {
      const arg = tpl?.[i];
      if (!arg) throw this.fail(`'${n}' needs its element type: ${n}<f32>`, e);
      const t = this.type(arg);
      if (t.kind !== 'scalar' || isAbstract(t))
        throw this.fail(`'${n}' needs a scalar element type, not ${typeName(t)}`, arg);
      return t;
    };
    switch (n) {
      case 'bool':
        return noTemplate(BOOL);
      case 'i32':
        return noTemplate(I32);
      case 'u32':
        return noTemplate(U32);
      case 'f32':
        return noTemplate(F32);
      case 'f16':
        if (!this.enables.has('f16')) throw this.fail("f16 needs 'enable f16;' at the top of the module", e);
        return noTemplate(F16);
      case 'sampler':
        return noTemplate({ kind: 'sampler', comparison: false });
      case 'sampler_comparison':
        return noTemplate({ kind: 'sampler', comparison: true });
      case 'texture_external':
        return noTemplate({ kind: 'texture', shape: 'external', dimension: '2d' });
      case 'texture_depth_multisampled_2d':
        return noTemplate({ kind: 'texture', shape: 'depth_multisampled', dimension: '2d' });
      case 'texture_multisampled_2d': {
        const s = elementArg();
        if (!['f32', 'i32', 'u32'].includes(s.name)) throw this.fail('Texture sample types are f32, i32 or u32', e);
        return { kind: 'texture', shape: 'multisampled', dimension: '2d', sampled: s };
      }
      case 'atomic': {
        const s = elementArg();
        if (s.name !== 'i32' && s.name !== 'u32') throw this.fail('atomic<T> needs i32 or u32', e);
        return { kind: 'atomic', element: s };
      }
      case 'array': {
        if (!tpl?.length || tpl.length > 2) throw this.fail('array needs array<T> or array<T, N>', e);
        const element = this.type(tpl[0]);
        if (!isStorable(element) || element.kind === 'sampler' || element.kind === 'texture')
          throw this.fail(`An array cannot hold ${typeName(element)}`, tpl[0]);
        if (element.kind === 'array' && element.count === 'runtime')
          throw this.fail('An array element cannot be a runtime-sized array', tpl[0]);
        if (tpl.length === 1) return { kind: 'array', element, count: 'runtime' };
        const count = this.value(tpl[1]);
        if (!isInteger(elementOf(count.type) ?? BOOL) || count.type.kind !== 'scalar')
          throw this.fail('An array count must be an integer', tpl[1]);
        if (typeof count.value === 'number') {
          if (count.value < 1) throw this.fail('An array count must be 1 or more', tpl[1]);
          return { kind: 'array', element, count: count.value };
        }
        if (count.kind === 'name' && count.decl.kind === 'override')
          return { kind: 'array', element, count: { override: count.decl.name } };
        throw this.fail('An array count must be a constant or an override', tpl[1]);
      }
      case 'ptr': {
        const names = this.templateNames(e);
        if (!tpl || tpl.length < 2 || tpl.length > 3 || !SPACES.has(names[0]))
          throw this.fail('ptr needs ptr<address space, T> or ptr<address space, T, access>', e);
        const space = names[0] as AddressSpace,
          store = this.type(tpl[1]);
        let access: AccessMode = space === 'uniform' || space === 'storage' ? 'read' : 'read_write';
        if (tpl.length === 3) {
          if (!ACCESS.has(names[2]) || space !== 'storage')
            throw this.fail('Only storage pointers take an access mode', tpl[2]);
          access = names[2] as AccessMode;
        }
        return { kind: 'ptr', space, store, access };
      }
    }
    let m = /^vec([234])$/.exec(n);
    if (m) {
      if (!tpl) return undefined; // `vec3(...)` with an inferred element type: a constructor, not a type
      return vector(Number(m[1]) as 2, elementArg());
    }
    m = /^vec([234])([ifuh])$/.exec(n);
    if (m) {
      const s = { i: I32, u: U32, f: F32, h: F16 }[m[2] as 'i'];
      if (s === F16 && !this.enables.has('f16')) throw this.fail("f16 needs 'enable f16;' at the top of the module", e);
      return noTemplate(vector(Number(m[1]) as 2, s));
    }
    m = /^mat([234])x([234])([fh]?)$/.exec(n);
    if (m) {
      const c = Number(m[1]) as 2,
        r = Number(m[2]) as 2;
      if (m[3]) {
        if (m[3] === 'h' && !this.enables.has('f16'))
          throw this.fail("f16 needs 'enable f16;' at the top of the module", e);
        return noTemplate(matrix(c, r, m[3] === 'f' ? F32 : F16));
      }
      if (!tpl) return undefined;
      const s = elementArg();
      if (!isFloat(s)) throw this.fail('Matrices hold f32 or f16', e);
      return matrix(c, r, s);
    }
    m = /^texture_(1d|2d|2d_array|3d|cube|cube_array)$/.exec(n);
    if (m) {
      const s = elementArg();
      if (!['f32', 'i32', 'u32'].includes(s.name)) throw this.fail('Texture sample types are f32, i32 or u32', e);
      return { kind: 'texture', shape: 'sampled', dimension: TEXTURE_DIMS[m[1]], sampled: s };
    }
    m = /^texture_depth_(2d|2d_array|cube|cube_array)$/.exec(n);
    if (m) return noTemplate({ kind: 'texture', shape: 'depth', dimension: TEXTURE_DIMS[m[1]] });
    m = /^texture_storage_(1d|2d|2d_array|3d)$/.exec(n);
    if (m) {
      const [format, access] = this.templateNames(e);
      if (!tpl || tpl.length !== 2 || !(format in STORAGE_FORMATS) || !ACCESS.has(access))
        throw this.fail(`${n} needs <format, access>, for example ${n}<rgba8unorm, write>`, e);
      const ch = STORAGE_FORMATS[format];
      return {
        kind: 'texture',
        shape: 'storage',
        dimension: TEXTURE_DIMS[m[1]],
        format,
        access: access as AccessMode,
        sampled: ch === 'f32' ? F32 : ch === 'i32' ? I32 : U32,
      };
    }
    return undefined;
  }

  // ---------------------------------------------------------------- scopes

  private lookupLocal(name: string): IRLocal | IRParam | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const d = this.scopes[i].get(name);
      if (d) return d;
    }
    return undefined;
  }

  private declare(d: IRLocal | IRParam, at: number): void {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope.has(d.name)) throw this.fail(`'${d.name}' is already declared in this scope`, at);
    scope.set(d.name, d);
  }

  // ---------------------------------------------------------------- expressions

  /** An expression with the Load Rule applied: a value, never a memory reference. */
  private value(e: A.Expr): IRExpr {
    const x = this.expr(e);
    if (x.type.kind !== 'ref') return x;
    if (x.type.store.kind === 'atomic') throw this.fail('Atomics are read with atomicLoad(&x)', e);
    if (x.type.access === 'write') throw this.fail('This storage texture or buffer is write-only', e);
    return { kind: 'load', ref: x, type: x.type.store, start: x.start, end: x.end };
  }

  private expr(e: A.Expr): IRExpr {
    if (++this.depth > 512) throw this.fail('Expression nested too deep', e, 'limit');
    try {
      return this.guard(e, () => this.exprInner(e));
    } finally {
      this.depth--;
    }
  }

  private exprInner(e: A.Expr): IRExpr {
    const span = { start: e.start, end: e.end };
    switch (e.kind) {
      case 'literal': {
        const { type, value } = K.literal(e.value, e.type);
        if (type === F16 && !this.enables.has('f16')) throw this.fail("f16 literals need 'enable f16;'", e);
        return { kind: 'literal', type, value, ...span };
      }
      case 'paren':
        return { ...this.expr(e.expr), ...span };
      case 'ident':
        return this.name(e);
      case 'call':
        return this.call(e);
      case 'member':
        return this.member(e);
      case 'index':
        return this.index(e);
      case 'unary':
        return this.unary(e);
      case 'binary':
        return this.binary(e);
    }
  }

  private name(e: A.IdentExpr): IRExpr {
    const span = { start: e.start, end: e.end };
    if (e.template) throw this.fail(`'${e.name}' is a type; call it to construct a value: ${e.name}<...>(...)`, e);
    const local = this.lookupLocal(e.name);
    if (local) return this.declRef(local, span);
    const d = this.decls.get(e.name);
    if (d) {
      if (d.kind === 'global') return this.declRef(this.global(e.name), span);
      if (d.kind === 'fn') throw this.fail(`'${e.name}' is a function; call it: ${e.name}(...)`, e);
      throw this.fail(`'${e.name}' is a type, not a value`, e);
    }
    if (BUILTIN_NAMES.has(e.name)) throw this.fail(`'${e.name}' is a built-in function; call it`, e);
    if (this.predeclaredTypeName(e.name)) throw this.fail(`'${e.name}' is a type, not a value`, e);
    throw this.fail(`Unknown name '${e.name}'`, e);
  }

  private predeclaredTypeName(name: string): boolean {
    return /^(bool|i32|u32|f32|f16|vec[234][ifuh]?|mat[234]x[234][fh]?|array|atomic|ptr|sampler|sampler_comparison|texture_\w+)$/.test(
      name,
    );
  }

  private declRef(d: IRValueDeclaration, span: { start: number; end: number }): IRExpr {
    const st = this.state;
    switch (d.kind) {
      case 'var':
        st?.fn.uses.add(d);
        if (st && d.space === 'handle') return { kind: 'name', decl: d, type: d.type, ...span };
        return {
          kind: 'name',
          decl: d,
          type: { kind: 'ref', space: d.space, store: d.type, access: d.access },
          ...span,
        };
      case 'local-var':
        return {
          kind: 'name',
          decl: d,
          type: { kind: 'ref', space: 'function', store: d.type, access: 'read_write' },
          ...span,
        };
      case 'const':
      case 'local-const':
        return { kind: 'name', decl: d, type: d.type, value: d.value, ...span };
      case 'override':
        st?.fn.uses.add(d);
        return { kind: 'name', decl: d, type: d.type, ...span };
      default:
        return { kind: 'name', decl: d, type: d.type, ...span };
    }
  }

  /** Converts a value to `to` (materializing an abstract value); fails when no automatic conversion exists. */
  private convertTo(x: IRExpr, to: Type, at: { start: number }): IRExpr {
    if (sameType(x.type, to)) return x;
    if (conversionRank(x.type, to) === undefined)
      throw this.fail(`Expected ${typeName(to)}, got ${typeName(x.type)}`, at);
    if (x.value === undefined)
      throw this.fail(`Cannot convert ${typeName(x.type)} to ${typeName(to)} automatically`, at);
    return { ...x, type: to, value: this.guard(at, () => K.convert(x.value as ConstValue, x.type, to)) };
  }

  /** Materializes an abstract value to its default concrete type (for let, var and runtime uses). */
  private concrete(x: IRExpr, at: { start: number }): IRExpr {
    return hasAbstract(x.type) ? this.convertTo(x, concretize(x.type), at) : x;
  }

  private call(e: A.CallExpr): IRExpr {
    const span = { start: e.start, end: e.end },
      name = e.callee.name;
    const local = this.lookupLocal(name);
    if (local)
      throw this.fail(`'${name}' is a ${local.kind === 'param' ? 'parameter' : 'value'}, not a function`, e.callee);
    const d = this.decls.get(name);
    if (d?.kind === 'fn') return this.userCall(e, d);
    if (d?.kind === 'global') throw this.fail(`'${name}' is a value, not a function`, e.callee);
    if (d) {
      if (e.callee.template) throw this.fail(`'${name}' takes no template arguments`, e.callee);
      return this.construct(this.typeDecl(name), e.args, span);
    }
    if (name === 'bitcast') {
      const target = e.callee.template?.length === 1 ? this.type(e.callee.template[0]) : undefined;
      return this.builtinCall(e, target);
    }
    if (BUILTIN_NAMES.has(name)) {
      if (e.callee.template) throw this.fail(`'${name}' takes no template arguments`, e.callee);
      return this.builtinCall(e);
    }
    // Type constructors, with explicit or inferred element types.
    const inferred = /^(vec[234]|mat[234]x[234]|array)$/.test(name) && !e.callee.template;
    if (inferred) return this.inferredConstruct(name, e);
    const t = this.predeclaredType(e.callee);
    if (t) return this.construct(t, e.args, span);
    throw this.fail(`Unknown function '${name}'`, e.callee);
  }

  private userCall(e: A.CallExpr, d: A.FunctionDecl): IRExpr {
    const fn = this.signature(d);
    if (fn.stage) throw this.fail(`'${d.name}' is an entry point and cannot be called`, e.callee);
    if (e.args.length !== fn.params.length)
      throw this.fail(
        `'${d.name}' takes ${fn.params.length} argument${fn.params.length === 1 ? '' : 's'}, got ${e.args.length}`,
        e,
      );
    const args = e.args.map((a, i) => {
      const p = fn.params[i];
      const x = this.value(a);
      if (p.type.kind === 'ptr') {
        if (x.type.kind !== 'ptr' || !sameType(x.type, p.type))
          throw this.fail(`Argument ${i + 1} of '${d.name}' must be ${typeName(p.type)}, got ${typeName(x.type)}`, a);
        return x;
      }
      return this.convertTo(x, p.type, a);
    });
    this.state?.fn.calls.add(fn);
    return { kind: 'call', fn, args, type: fn.returnType, start: e.start, end: e.end };
  }

  private builtinCall(e: A.CallExpr, template?: Type): IRExpr {
    const name = e.callee.name,
      raw = e.args.map((a) => this.value(a));
    // A call with a runtime argument, or to a built-in this front end does not fold, is not a constant expression
    // here, so its overload takes concrete types only.
    const runtime = !K.FOLDABLE.has(name) || raw.some((x) => x.value === undefined && x.type.kind !== 'ptr');
    const resolved: BuiltinResult | string = resolveBuiltin(
      name,
      raw.map((x) => x.type),
      template,
    );
    if (typeof resolved === 'string') throw this.fail(resolved, e);
    const r = runtime
      ? { ...resolved, type: concretize(resolved.type), params: resolved.params.map(concretize) }
      : resolved;
    const args = raw.map((x, i) =>
      x.type.kind === 'ptr' || x.type.kind === 'texture' || x.type.kind === 'sampler'
        ? x
        : this.convertTo(x, r.params[i], e.args[i]),
    );
    if (r.stage) this.state?.fn.stages.add(r.stage);
    const span = { start: e.start, end: e.end };
    // extractBits and insertBits: constant offset + count past the bit width is a shader-creation error (WGSL 17.4).
    if (name === 'extractBits' || name === 'insertBits') {
      const k = name === 'extractBits' ? 1 : 2,
        offset = args[k]?.value,
        count = args[k + 1]?.value;
      if (typeof offset === 'number' && typeof count === 'number' && offset + count > 32)
        throw this.fail(`${name}: offset ${offset} + count ${count} is more than 32 bits`, e.args[k]);
    }
    if (name === 'bitcast') {
      const arg = args[0];
      const value =
        arg.value !== undefined ? this.guard(e, () => K.bitcast(arg.value as ConstValue, arg.type, r.type)) : undefined;
      return { kind: 'bitcast', arg, type: r.type, value, ...span };
    }
    let value: ConstValue | undefined;
    if (K.FOLDABLE.has(name) && args.every((a) => a.value !== undefined))
      value = this.guard(e, () =>
        K.builtin(
          name,
          args.map((a) => a.value as ConstValue),
          r.params,
          r.type,
        ),
      );
    return { kind: 'builtin', name, args, type: r.type, value, ...span };
  }

  private inferredConstruct(name: string, e: A.CallExpr): IRExpr {
    const span = { start: e.start, end: e.end };
    const args = e.args.map((a) => this.value(a));
    // With a runtime component the result is not constant, so abstract components take their concrete types.
    const runtime = args.some((a) => a.value === undefined);
    const pick = (t: Type | undefined) => (t && runtime ? concretize(t) : t);
    if (name === 'array') {
      if (!args.length) throw this.fail('array() needs its element type to build an empty array: array<T, N>()', e);
      const element = pick(unify(args.map((a) => a.type)));
      if (!element)
        throw this.fail(`array(...) elements have no common type: ${args.map((a) => typeName(a.type)).join(', ')}`, e);
      return this.construct({ kind: 'array', element, count: args.length }, e.args, span, args);
    }
    const size = Number(name[3]) as 2 | 3 | 4;
    if (name.startsWith('vec')) {
      if (!args.length) return this.construct(vector(size, AINT), e.args, span, args);
      const els = args.map((a) => elementOf(a.type));
      if (els.some((s) => !s) || args.some((a) => a.type.kind === 'matrix'))
        throw this.fail(`${name}(...) takes scalars and vectors`, e);
      const element = pick(unify(els as Type[])) as ScalarType | undefined;
      if (!element) throw this.fail(`${name}(...) components have no common type`, e);
      return this.construct(vector(size, element), e.args, span, args);
    }
    const rows = Number(name[5]) as 2 | 3 | 4;
    const els = args.map((a) => elementOf(a.type));
    let element = unify(els.filter(Boolean) as Type[]) as ScalarType | undefined;
    if (element?.name === 'abstract-int') element = AFLOAT;
    element = pick(element) as ScalarType | undefined;
    if (!element || !isFloat(element)) throw this.fail(`${name}(...) needs float components`, e);
    return this.construct(matrix(size, rows, element), e.args, span, args);
  }

  /** `T(args)`: zero value, conversion, or construction from components. */
  private construct(
    t: Type,
    argExprs: readonly A.Expr[],
    span: { start: number; end: number },
    given?: IRExpr[],
  ): IRExpr {
    const args = given ?? argExprs.map((a) => this.value(a));
    const at = span;
    if (!isConstructible(t)) throw this.fail(`${typeName(t)} cannot be constructed`, at);
    const done = (kind: 'construct' | 'convert', list: IRExpr[], value?: ConstValue): IRExpr =>
      kind === 'convert'
        ? { kind, arg: list[0], type: t, value, ...span }
        : { kind, args: list, type: t, value, ...span };
    const allConst = (list: IRExpr[]) => list.every((a) => a.value !== undefined);
    if (!args.length)
      return done(
        'construct',
        [],
        this.guard(at, () => K.zero(t)),
      );
    switch (t.kind) {
      case 'scalar': {
        if (args.length !== 1 || args[0].type.kind !== 'scalar') throw this.fail(`${t.name}(...) takes one scalar`, at);
        const a = args[0];
        const value =
          a.value !== undefined ? this.guard(at, () => K.convert(a.value as ConstValue, a.type, t)) : undefined;
        return done('convert', [a], value);
      }
      case 'vector': {
        if (args.length === 1 && args[0].type.kind === 'scalar') {
          const a = this.convertScalarTo(args[0], t.element, argExprs[0] ?? at);
          return done(
            'construct',
            [a],
            a.value !== undefined ? Array.from({ length: t.size }, () => a.value as ConstValue) : undefined,
          );
        }
        if (args.length === 1 && args[0].type.kind === 'vector' && args[0].type.size === t.size) {
          const a = args[0];
          if (sameType(a.type, t)) return done('construct', [a], a.value);
          const value =
            a.value !== undefined ? this.guard(at, () => K.convert(a.value as ConstValue, a.type, t)) : undefined;
          return done('convert', [a], value);
        }
        let n = 0;
        const list = args.map((a, i) => {
          if (a.type.kind === 'scalar') {
            n++;
            return this.convertScalarTo(a, t.element, argExprs[i] ?? at);
          }
          if (a.type.kind === 'vector') {
            n += a.type.size;
            return this.convertTo(a, vector(a.type.size, t.element), argExprs[i] ?? at);
          }
          throw this.fail(`${typeName(t)} cannot take ${typeName(a.type)}`, argExprs[i] ?? at);
        });
        if (n !== t.size) throw this.fail(`${typeName(t)} needs ${t.size} components, got ${n}`, at);
        return done(
          'construct',
          list,
          allConst(list)
            ? list.flatMap((a) => (Array.isArray(a.value) ? a.value : [a.value as ConstValue]))
            : undefined,
        );
      }
      case 'matrix': {
        if (args.length === 1 && args[0].type.kind === 'matrix') {
          const a = args[0],
            m = a.type as MatrixType;
          if (m.columns !== t.columns || m.rows !== t.rows)
            throw this.fail(`Cannot convert ${typeName(m)} to ${typeName(t)}`, at);
          const value =
            a.value !== undefined ? this.guard(at, () => K.convert(a.value as ConstValue, a.type, t)) : undefined;
          return done('convert', [a], value);
        }
        const column = vector(t.rows, t.element);
        if (args.length === t.columns && args.every((a) => a.type.kind === 'vector')) {
          const list = args.map((a, i) => this.convertTo(a, column, argExprs[i] ?? at));
          return done('construct', list, allConst(list) ? list.map((a) => a.value as ConstValue) : undefined);
        }
        if (args.length === t.columns * t.rows && args.every((a) => a.type.kind === 'scalar')) {
          const list = args.map((a, i) => this.convertScalarTo(a, t.element, argExprs[i] ?? at));
          const value = allConst(list)
            ? Array.from({ length: t.columns }, (_, c) =>
                list.slice(c * t.rows, (c + 1) * t.rows).map((a) => a.value as ConstValue),
              )
            : undefined;
          return done('construct', list, value);
        }
        throw this.fail(`${typeName(t)} takes ${t.columns} column vectors or ${t.columns * t.rows} scalars`, at);
      }
      case 'array': {
        if (args.length !== t.count)
          throw this.fail(`${typeName(t)} needs ${t.count} elements, got ${args.length}`, at);
        const list = args.map((a, i) => this.convertTo(a, t.element, argExprs[i] ?? at));
        return done('construct', list, allConst(list) ? list.map((a) => a.value as ConstValue) : undefined);
      }
      case 'struct': {
        if (args.length !== t.members.length)
          throw this.fail(`${t.name} has ${t.members.length} members, got ${args.length} values`, at);
        const list = args.map((a, i) => this.convertTo(a, t.members[i].type, argExprs[i] ?? at));
        return done('construct', list, allConst(list) ? list.map((a) => a.value as ConstValue) : undefined);
      }
    }
    throw this.fail(`${typeName(t)} cannot be constructed`, at);
  }

  private convertScalarTo(a: IRExpr, s: ScalarType, at: { start: number }): IRExpr {
    if (a.type.kind !== 'scalar') throw this.fail(`Expected a scalar, got ${typeName(a.type)}`, at);
    return this.convertTo(a, s, at);
  }

  private member(e: A.MemberExpr): IRExpr {
    const span = { start: e.start, end: e.end };
    let object = this.expr(e.object);
    // Pointers are dereferenced implicitly for member access.
    if (object.type.kind === 'ptr')
      object = {
        kind: 'deref',
        pointer: object,
        type: { ...object.type, kind: 'ref' },
        start: object.start,
        end: object.end,
      };
    const isRef = object.type.kind === 'ref',
      base = object.type.kind === 'ref' ? object.type.store : object.type;
    const viewOf = (t: Type): Type =>
      isRef && object.type.kind === 'ref'
        ? { kind: 'ref', space: object.type.space, store: t, access: object.type.access }
        : t;
    if (base.kind === 'struct') {
      const index = base.members.findIndex((m) => m.name === e.member);
      if (index < 0) throw this.fail(`${base.name} has no member '${e.member}'`, e.memberStart);
      const m = base.members[index];
      const value = object.value !== undefined ? (object.value as ConstValue[])[index] : undefined;
      return { kind: 'member', object, member: e.member, index, type: viewOf(m.type), value, ...span };
    }
    if (base.kind === 'vector') {
      const components = swizzle(e.member, base.size);
      if (!components)
        throw this.fail(
          `'${e.member}' is not a swizzle of ${typeName(base)} (use x, y, z, w or r, g, b, a)`,
          e.memberStart,
        );
      if (components.length === 1) {
        const value = object.value !== undefined ? (object.value as ConstValue[])[components[0]] : undefined;
        return { kind: 'swizzle', object, components, type: viewOf(base.element), value, ...span };
      }
      const source = isRef ? this.loadOf(object) : object;
      const value = source.value !== undefined ? components.map((c) => (source.value as ConstValue[])[c]) : undefined;
      return {
        kind: 'swizzle',
        object: source,
        components,
        type: vector(components.length as 2, base.element),
        value,
        ...span,
      };
    }
    throw this.fail(`${typeName(base)} has no members; '.${e.member}' needs a struct or a vector`, e.memberStart);
  }

  private loadOf(x: IRExpr): IRExpr {
    if (x.type.kind !== 'ref') return x;
    return { kind: 'load', ref: x, type: x.type.store, start: x.start, end: x.end };
  }

  private index(e: A.IndexExpr): IRExpr {
    const span = { start: e.start, end: e.end };
    let object = this.expr(e.object);
    if (object.type.kind === 'ptr')
      object = {
        kind: 'deref',
        pointer: object,
        type: { ...object.type, kind: 'ref' },
        start: object.start,
        end: object.end,
      };
    const base = object.type.kind === 'ref' ? object.type.store : object.type;
    let index = this.value(e.index);
    const ie = elementOf(index.type);
    if (index.type.kind !== 'scalar' || !ie || !isInteger(ie))
      throw this.fail(`An index must be i32 or u32, not ${typeName(index.type)}`, e.index);
    if (isAbstract(ie)) index = this.convertTo(index, I32, e.index);
    let element: Type, count: number | undefined;
    if (base.kind === 'array') {
      element = base.element;
      count = typeof base.count === 'number' ? base.count : undefined;
    } else if (base.kind === 'vector') {
      element = base.element;
      count = base.size;
    } else if (base.kind === 'matrix') {
      element = vector(base.rows, base.element);
      count = base.columns;
    } else throw this.fail(`${typeName(base)} cannot be indexed`, e);
    if (typeof index.value === 'number' && count !== undefined && (index.value < 0 || index.value >= count))
      throw this.fail(`Index ${index.value} is out of bounds for ${typeName(base)}`, e.index);
    if (typeof index.value === 'number' && index.value < 0)
      throw this.fail(`Index ${index.value} is negative`, e.index);
    const type: Type =
      object.type.kind === 'ref'
        ? { kind: 'ref', space: object.type.space, store: element, access: object.type.access }
        : element;
    const value =
      object.value !== undefined && typeof index.value === 'number'
        ? (object.value as ConstValue[])[index.value]
        : undefined;
    return { kind: 'index', object, index, type, value, ...span };
  }

  private unary(e: A.UnaryExpr): IRExpr {
    const span = { start: e.start, end: e.end };
    if (e.op === '&') {
      const ref = this.expr(e.operand);
      if (ref.type.kind !== 'ref') throw this.fail("'&' needs a variable or a part of one", e.operand);
      if (ref.kind === 'swizzle') throw this.fail("'&' cannot take the address of a vector component", e.operand);
      if (ref.type.space === 'handle') throw this.fail('Textures and samplers have no address', e.operand);
      return { kind: 'address-of', ref, type: { ...ref.type, kind: 'ptr' }, ...span };
    }
    if (e.op === '*') {
      const pointer = this.value(e.operand);
      if (pointer.type.kind !== 'ptr') throw this.fail(`'*' needs a pointer, got ${typeName(pointer.type)}`, e.operand);
      return { kind: 'deref', pointer, type: { ...pointer.type, kind: 'ref' }, ...span };
    }
    const operand = this.value(e.operand),
      t = operand.type,
      s = elementOf(t);
    if (!s || (t.kind === 'matrix' && e.op !== '-')) throw this.fail(`'${e.op}' cannot apply to ${typeName(t)}`, e);
    if (e.op === '!' && s.name !== 'bool') throw this.fail(`'!' needs bool, got ${typeName(t)}`, e);
    if (e.op === '~' && !isInteger(s)) throw this.fail(`'~' needs an integer, got ${typeName(t)}`, e);
    if (e.op === '-' && (!isSigned(s) || t.kind === 'matrix'))
      throw this.fail(`'-' needs a signed number, got ${typeName(t)}`, e);
    const value =
      operand.value !== undefined
        ? this.guard(e, () => K.unary(e.op as '-', operand.value as ConstValue, t))
        : undefined;
    return { kind: 'unary', op: e.op, operand, type: t, value, ...span };
  }

  private binary(e: A.BinaryExpr): IRExpr {
    const span = { start: e.start, end: e.end };
    let left = this.value(e.left),
      right = this.value(e.right);
    const op = e.op,
      lt = left.type,
      rt = right.type;
    const bad = () => this.fail(`'${op}' cannot combine ${typeName(lt)} and ${typeName(rt)}`, e);
    let result: Type;
    if (op === '&&' || op === '||') {
      if (!sameType(lt, BOOL) || !sameType(rt, BOOL)) throw bad();
      result = BOOL;
    } else if (op === '<<' || op === '>>') {
      const ls = elementOf(lt),
        rs = elementOf(rt);
      if (!ls || !rs || !isInteger(ls) || lt.kind === 'matrix' || (lt.kind === 'vector') !== (rt.kind === 'vector'))
        throw bad();
      if (lt.kind === 'vector' && rt.kind === 'vector' && lt.size !== rt.size) throw bad();
      const shiftType = withElement(rt, isAbstract(ls) && isAbstract(rs) ? AINT : U32);
      if (!isAbstract(ls) || !isAbstract(rs)) right = this.convertTo(right, shiftType, e.right);
      if (isAbstract(ls) && !isAbstract(rs)) left = this.concrete(left, e.left);
      if (typeof right.value === 'number' && !isAbstract(elementOf(left.type) as ScalarType) && right.value >= 32)
        throw this.fail(`Shift by ${right.value} is not less than 32`, e.right);
      result = left.type;
    } else {
      // Unify the two sides: same type, or a scalar side matched to the other side's element.
      const isMatrixOp = lt.kind === 'matrix' || rt.kind === 'matrix';
      if (isMatrixOp) return this.matrixBinary(e, left, right);
      const vectorScalar = (lt.kind === 'vector') !== (rt.kind === 'vector');
      if (
        vectorScalar &&
        (op === '==' ||
          op === '!=' ||
          op === '<' ||
          op === '>' ||
          op === '<=' ||
          op === '>=' ||
          op === '&' ||
          op === '|' ||
          op === '^')
      )
        throw bad();
      const ls = elementOf(lt),
        rs = elementOf(rt);
      if (!ls || !rs) throw bad();
      const element = unify([ls, rs]) as ScalarType | undefined;
      if (!element) throw bad();
      const vt = lt.kind === 'vector' ? lt : rt.kind === 'vector' ? rt : undefined;
      if (lt.kind === 'vector' && rt.kind === 'vector' && lt.size !== rt.size) throw bad();
      left = this.convertTo(left, withElement(lt, element), e.left);
      right = this.convertTo(right, withElement(rt, element), e.right);
      const operandType = vt ? vector(vt.size, element) : element;
      switch (op) {
        case '+':
        case '-':
        case '*':
        case '/':
        case '%':
          if (!isNumeric(element)) throw bad();
          result = operandType;
          break;
        case '==':
        case '!=':
          result = vt ? vector(vt.size, BOOL) : BOOL;
          break;
        case '<':
        case '>':
        case '<=':
        case '>=':
          if (!isNumeric(element)) throw bad();
          result = vt ? vector(vt.size, BOOL) : BOOL;
          break;
        case '&':
        case '|':
        case '^':
          if (!(isInteger(element) || (element.name === 'bool' && op !== '^'))) throw bad();
          result = operandType;
          break;
        default:
          throw bad();
      }
    }
    const value =
      left.value !== undefined && right.value !== undefined
        ? this.guard(e, () =>
            K.binary(op, left.value as ConstValue, right.value as ConstValue, left.type, right.type, result),
          )
        : undefined;
    return { kind: 'binary', op, left, right, type: result, value, ...span };
  }

  private matrixBinary(e: A.BinaryExpr, l: IRExpr, r: IRExpr): IRExpr {
    const span = { start: e.start, end: e.end },
      op = e.op;
    const lt = l.type,
      rt = r.type;
    const bad = () => this.fail(`'${op}' cannot combine ${typeName(lt)} and ${typeName(rt)}`, e);
    const el = unify([elementOf(lt) ?? BOOL, elementOf(rt) ?? BOOL]) as ScalarType | undefined;
    const element = el?.name === 'abstract-int' ? AFLOAT : el;
    if (!element || !isFloat(element)) throw bad();
    const left = this.convertTo(l, withElement(lt, element), e.left),
      right = this.convertTo(r, withElement(rt, element), e.right);
    let result: Type;
    if (op === '+' || op === '-') {
      if (lt.kind !== 'matrix' || rt.kind !== 'matrix' || lt.columns !== rt.columns || lt.rows !== rt.rows) throw bad();
      result = left.type;
    } else if (op === '*') {
      if (lt.kind === 'matrix' && rt.kind === 'scalar') result = left.type;
      else if (lt.kind === 'scalar' && rt.kind === 'matrix') result = right.type;
      else if (lt.kind === 'matrix' && rt.kind === 'vector') {
        if (rt.size !== lt.columns) throw bad();
        result = vector(lt.rows, element);
      } else if (lt.kind === 'vector' && rt.kind === 'matrix') {
        if (lt.size !== rt.rows) throw bad();
        result = vector(rt.columns, element);
      } else if (lt.kind === 'matrix' && rt.kind === 'matrix') {
        if (lt.columns !== rt.rows) throw bad();
        result = matrix(rt.columns, lt.rows, element);
      } else throw bad();
    } else throw bad();
    const value =
      left.value !== undefined && right.value !== undefined
        ? this.guard(e, () =>
            K.binary(op, left.value as ConstValue, right.value as ConstValue, left.type, right.type, result),
          )
        : undefined;
    return { kind: 'binary', op, left, right, type: result, value, ...span };
  }

  // ---------------------------------------------------------------- statements

  private constAssert(e: A.Expr): void {
    const x = this.value(e);
    if (!sameType(x.type, BOOL) || x.value === undefined)
      throw this.fail('const_assert needs a constant bool expression', e);
    if (x.value !== true) throw this.fail('const_assert failed', e);
  }

  private body(d: A.FunctionDecl): void {
    const fn = this.signature(d) as FnState['fn'];
    this.state = { fn, returnType: d.returnType, loops: 0, switches: 0, continuing: false };
    this.scopes = [new Map()];
    for (const [i, p] of fn.params.entries()) this.declare(p, d.params[i].nameStart);
    const body = this.block(d.body, false);
    fn.body = body.stmts;
    if (fn.returnType !== VOID && body.behavior.has('next'))
      throw this.fail(`Function '${d.name}' must return a ${typeName(fn.returnType)} on every path`, d.body.end - 1);
    this.state = undefined;
    this.scopes = [];
  }

  private block(c: A.CompoundStmt, scope = true): { stmts: IRStmt[]; behavior: Set<Behavior> } {
    if (scope) this.scopes.push(new Map());
    const stmts: IRStmt[] = [];
    const behavior = new Set<Behavior>(['next']);
    for (const s of c.body) {
      const b = this.statement(s, stmts);
      // Statements after one that never falls through are checked but add no behavior.
      if (!behavior.has('next')) continue;
      behavior.delete('next');
      for (const x of b) behavior.add(x);
    }
    if (scope) this.scopes.pop();
    return { stmts, behavior };
  }

  private statement(s: A.Stmt, out: IRStmt[]): Set<Behavior> {
    const st = this.state as FnState,
      span = { start: s.start, end: s.end };
    switch (s.kind) {
      case 'compound': {
        const b = this.block(s);
        out.push({ kind: 'block', body: b.stmts, ...span });
        return b.behavior;
      }
      case 'return': {
        if (st.continuing) throw this.fail('A continuing block cannot return', s);
        const want = st.fn.returnType;
        if (want === VOID) {
          if (s.value) throw this.fail(`Function '${st.fn.name}' returns nothing; drop the value`, s.value);
          out.push({ kind: 'return', ...span });
        } else {
          if (!s.value) throw this.fail(`Function '${st.fn.name}' must return a ${typeName(want)}`, s);
          out.push({ kind: 'return', value: this.convertTo(this.value(s.value), want, s.value), ...span });
        }
        return new Set(['return']);
      }
      case 'if': {
        const condition = this.condition(s.condition, 'if');
        const then = this.block(s.then);
        let otherwise: { stmts: IRStmt[]; behavior: Set<Behavior> } = { stmts: [], behavior: new Set(['next']) };
        if (s.else?.kind === 'if') {
          const inner: IRStmt[] = [];
          otherwise = { stmts: inner, behavior: this.statement(s.else, inner) };
        } else if (s.else) otherwise = this.block(s.else);
        out.push({ kind: 'if', condition, then: then.stmts, else: s.else ? otherwise.stmts : undefined, ...span });
        return new Set([...then.behavior, ...otherwise.behavior]);
      }
      case 'switch': {
        let selector = this.value(s.selector);
        const se = elementOf(selector.type);
        if (selector.type.kind !== 'scalar' || !se || !isInteger(se))
          throw this.fail(`A switch selector must be i32 or u32, not ${typeName(selector.type)}`, s.selector);
        const caseValues = s.clauses.flatMap((c) =>
          c.selectors.filter((x): x is A.Expr => x !== null).map((x) => this.value(x)),
        );
        const target = unify([selector.type, ...caseValues.map((c) => c.type)]);
        const want = target && isAbstract(elementOf(target) as ScalarType) ? I32 : target;
        if (!want || (want !== I32 && want !== U32 && !sameType(want, I32) && !sameType(want, U32)))
          throw this.fail('Switch selector and case values must all be i32 or all be u32', s.selector);
        selector = this.convertTo(selector, want, s.selector);
        const seen = new Set<number>();
        let defaults = 0;
        const behaviors = new Set<Behavior>();
        st.switches++;
        const clauses = s.clauses.map((c) => {
          const selectors = c.selectors.map((x) => {
            if (x === null) {
              defaults++;
              return null;
            }
            const v = this.convertTo(this.value(x), want, x);
            if (typeof v.value !== 'number') throw this.fail('Case values must be constant', x);
            if (seen.has(v.value)) throw this.fail(`Case ${v.value} appears twice`, x);
            seen.add(v.value);
            return v.value;
          });
          const b = this.block(c.body);
          for (const x of b.behavior) behaviors.add(x === 'break' ? 'next' : x);
          return { selectors, body: b.stmts };
        });
        st.switches--;
        if (defaults !== 1)
          throw this.fail(defaults ? "A switch may have only one 'default'" : "A switch needs a 'default' clause", s);
        out.push({ kind: 'switch', selector, clauses, ...span });
        return behaviors;
      }
      case 'loop': {
        st.loops++;
        this.scopes.push(new Map());
        const body = this.block(s.body, false);
        let continuing: IRStmt[] | undefined, breakIf: IRExpr | undefined;
        if (s.continuing) {
          const was = st.continuing;
          st.continuing = true;
          const saveLoops = st.loops;
          const c = this.block(s.continuing.body);
          continuing = c.stmts;
          if (s.continuing.breakIf) breakIf = this.condition(s.continuing.breakIf, 'break if');
          st.loops = saveLoops;
          st.continuing = was;
        }
        this.scopes.pop();
        st.loops--;
        out.push({ kind: 'loop', body: body.stmts, continuing, breakIf, ...span });
        const b = new Set(body.behavior);
        if (breakIf) b.add('break');
        return loopBehavior(b);
      }
      case 'for': {
        this.scopes.push(new Map());
        const initOut: IRStmt[] = [];
        if (s.init) this.simple(s.init, initOut);
        const condition = s.condition ? this.condition(s.condition, 'for') : undefined;
        const updateOut: IRStmt[] = [];
        if (s.update) this.simple(s.update, updateOut);
        st.loops++;
        const body = this.block(s.body);
        st.loops--;
        this.scopes.pop();
        out.push({ kind: 'for', init: initOut[0], condition, update: updateOut[0], body: body.stmts, ...span });
        const b = new Set(body.behavior);
        if (condition) b.add('break');
        return loopBehavior(b);
      }
      case 'while': {
        const condition = this.condition(s.condition, 'while');
        st.loops++;
        const body = this.block(s.body);
        st.loops--;
        out.push({ kind: 'while', condition, body: body.stmts, ...span });
        return loopBehavior(new Set([...body.behavior, 'break']));
      }
      case 'break':
        if (!st.loops && !st.switches) throw this.fail("'break' must be inside a loop or switch", s);
        if (st.continuing && !st.switches)
          throw this.fail("Use 'break if' to leave a loop from its continuing block", s);
        out.push({ kind: 'break', ...span });
        return new Set(['break']);
      case 'continue':
        if (!st.loops) throw this.fail("'continue' must be inside a loop", s);
        if (st.continuing) throw this.fail("'continue' cannot be used in a continuing block", s);
        out.push({ kind: 'continue', ...span });
        return new Set(['continue']);
      case 'discard':
        st.fn.stages.add('fragment');
        out.push({ kind: 'discard', ...span });
        return new Set(['next']);
      case 'const_assert':
        this.constAssert(s.expr);
        return new Set(['next']);
      default:
        this.simple(s, out);
        return new Set(['next']);
    }
  }

  private condition(e: A.Expr, what: string): IRExpr {
    const x = this.value(e);
    if (!sameType(x.type, BOOL)) throw this.fail(`The ${what} condition must be bool, not ${typeName(x.type)}`, e);
    return x;
  }

  /** Declarations, assignments, increments and calls. */
  private simple(s: A.Stmt, out: IRStmt[]): void {
    const span = { start: s.start, end: s.end };
    switch (s.kind) {
      case 'decl':
        out.push({ kind: 'decl', local: this.local(s.decl), ...span });
        return;
      case 'assign': {
        if (!s.lhs) {
          const rhs = this.value(s.rhs);
          if (rhs.type.kind === 'void') throw this.fail('The call returns nothing to discard', s.rhs);
          out.push({ kind: 'assign', op: '=', lhs: null, rhs: this.concrete(rhs, s.rhs), ...span });
          return;
        }
        const lhs = this.expr(s.lhs);
        if (lhs.type.kind !== 'ref') throw this.fail('Only variables, or parts of them, can be assigned', s.lhs);
        if (lhs.type.access === 'read') throw this.fail(`This ${lhs.type.space} memory is read-only`, s.lhs);
        const store = lhs.type.store;
        if (!isConstructible(store))
          throw this.fail(
            `${typeName(store)} cannot be assigned${store.kind === 'atomic' ? '; use atomicStore' : ''}`,
            s.lhs,
          );
        let rhs: IRExpr;
        if (s.op === '=') rhs = this.convertTo(this.value(s.rhs), store, s.rhs);
        else {
          const op = s.op.slice(0, -1) as A.BinaryOp;
          // Type the compound assignment as `lhs op rhs`, which must give the variable's type back.
          const combined = this.binary({ kind: 'binary', op, left: s.lhs, right: s.rhs, start: s.start, end: s.end });
          if (!sameType(combined.type, store))
            throw this.fail(
              `'${s.op}' gives ${typeName(combined.type)}, which cannot be stored in ${typeName(store)}`,
              s,
            );
          rhs = (combined as { right: IRExpr }).right;
        }
        out.push({ kind: 'assign', op: s.op, lhs, rhs, ...span });
        return;
      }
      case 'increment': {
        const lhs = this.expr(s.lhs);
        if (lhs.type.kind !== 'ref' || lhs.type.access === 'read')
          throw this.fail(`'${s.op}' needs a writable variable`, s.lhs);
        const t = lhs.type.store;
        if (t.kind !== 'scalar' || (t.name !== 'i32' && t.name !== 'u32'))
          throw this.fail(`'${s.op}' needs an i32 or u32 variable`, s.lhs);
        out.push({ kind: 'increment', op: s.op, lhs, ...span });
        return;
      }
      case 'call': {
        const call = this.call(s.call);
        out.push({ kind: 'call', call, ...span });
        return;
      }
    }
    throw this.fail('This statement is not allowed here', s);
  }

  private local(d: A.ValueDecl): IRLocal {
    if (d.attributes.length) throw this.fail('Local declarations take no attributes', d.attributes[0]);
    let local: IRLocal;
    if (d.kind === 'const') {
      const c = this.constDecl(d);
      local = { kind: 'local-const', name: d.name, type: c.type, value: c.value, start: d.start, end: d.end };
    } else if (d.kind === 'let') {
      let init = this.value(d.init as A.Expr);
      if (init.type.kind === 'void') throw this.fail('The call returns nothing to store', d.init as A.Expr);
      init = d.type ? this.convertTo(init, this.type(d.type), d.init as A.Expr) : this.concrete(init, d.init as A.Expr);
      if (!(isConstructible(init.type) || init.type.kind === 'ptr'))
        throw this.fail(`A let cannot hold ${typeName(init.type)}`, d);
      local = { kind: 'let', name: d.name, type: init.type, init, start: d.start, end: d.end };
    } else {
      if (d.template) {
        const space = d.template[0]?.kind === 'ident' ? d.template[0].name : '';
        if (space !== 'function')
          throw this.fail(
            "Variables in a function are in the 'function' address space; move others to module scope",
            d.template[0] ?? d,
          );
      }
      let type = d.type ? this.type(d.type) : undefined;
      let init = d.init ? this.value(d.init) : undefined;
      if (init?.type.kind === 'void') throw this.fail('The call returns nothing to store', d.init as A.Expr);
      if (!type && init) type = concretize(init.type);
      if (!type) throw this.fail(`var '${d.name}' needs a type or an initializer`, d.nameStart);
      if (!isConstructible(type)) throw this.fail(`A function variable cannot hold ${typeName(type)}`, d.type ?? d);
      if (init) init = this.convertTo(init, type, d.init as A.Expr);
      local = { kind: 'local-var', name: d.name, type, init, start: d.start, end: d.end };
    }
    this.declare(local, d.nameStart);
    return local;
  }

  // ---------------------------------------------------------------- whole-module rules

  private recursion(): void {
    const state = new Map<IRFunction, 1 | 2>();
    const visit = (f: IRFunction) => {
      if (state.get(f) === 2) return;
      if (state.get(f) === 1)
        throw this.fail(
          `'${f.name}' calls itself, directly or through other functions; WGSL has no recursion`,
          f.start,
        );
      state.set(f, 1);
      for (const g of f.calls) visit(g);
      state.set(f, 2);
    };
    for (const f of this.functions.values()) visit(f);
  }

  private reach(f: IRFunction): (IRGlobalVar | IROverride)[] {
    const seen = new Set<IRFunction>(),
      out = new Set<IRGlobalVar | IROverride>();
    const visit = (g: IRFunction) => {
      if (seen.has(g)) return;
      seen.add(g);
      for (const u of g.uses) out.add(u);
      for (const c of g.calls) visit(c);
    };
    visit(f);
    return [...out];
  }

  /** Two resources one entry point reaches may not share a binding (WGSL section 13.3.2). */
  private bindings(f: IRFunction, globals: readonly (IRGlobalVar | IROverride)[]): void {
    const taken = new Map<string, string>();
    for (const g of globals) {
      if (g.kind !== 'var' || g.group === undefined || g.binding === undefined) continue;
      const key = `@group(${g.group}) @binding(${g.binding})`,
        other = taken.get(key);
      if (other !== undefined)
        throw this.fail(
          `Entry point '${f.name}' uses '${other}' and '${g.name}', which are both at ${key}; give one another binding`,
          f.start,
        );
      taken.set(key, g.name);
    }
  }

  private entryStages(f: IRFunction, stage: ShaderStage): void {
    const seen = new Set<IRFunction>();
    const visit = (g: IRFunction) => {
      if (seen.has(g)) return;
      seen.add(g);
      for (const s of g.stages)
        if (s !== stage)
          throw this.fail(
            `Entry point '${f.name}' (${stage}) reaches '${g.name}', which uses a ${s}-only built-in or statement`,
            f.start,
          );
      for (const u of g.uses)
        if (u.kind === 'var' && u.space === 'workgroup' && stage !== 'compute')
          throw this.fail(
            `Entry point '${f.name}' (${stage}) uses workgroup variable '${u.name}'; only compute shaders have workgroup memory`,
            f.start,
          );
      for (const c of g.calls) visit(c);
    };
    visit(f);
  }
}

function loopBehavior(b: Set<Behavior>): Set<Behavior> {
  const out = new Set<Behavior>([...b].filter((x) => x !== 'break' && x !== 'continue' && x !== 'next'));
  if (b.has('break')) out.add('next');
  return out;
}

function swizzle(name: string, size: number): number[] | undefined {
  if (name.length < 1 || name.length > 4) return undefined;
  const sets = ['xyzw', 'rgba'];
  for (const set of sets) {
    const out = [...name].map((c) => set.indexOf(c));
    if (out.every((i) => i >= 0 && i < size)) return out;
  }
  return undefined;
}

function containsRuntimeArray(t: Type): boolean {
  if (t.kind === 'array') return t.count === 'runtime' || containsRuntimeArray(t.element);
  if (t.kind === 'struct') return t.members.some((m) => containsRuntimeArray(m.type));
  return false;
}

function containsAtomic(t: Type): boolean {
  if (t.kind === 'atomic') return true;
  if (t.kind === 'array') return containsAtomic(t.element);
  if (t.kind === 'struct') return t.members.some((m) => containsAtomic(m.type));
  return false;
}
