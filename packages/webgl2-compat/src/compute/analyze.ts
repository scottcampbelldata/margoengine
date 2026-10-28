// Which tier runs a compute entry point on WebGL2 (roadmap "Compute plan", milestone M5), decided from the typed IR.
// Written clean room from the W3C WGSL and WebGPU specifications.
//
// - fragment (A1): every textureStore writes the invocation's own texel (its coordinates are the global invocation
//   id: xy for 1D and 2D textures, xy plus the layer z for arrays, xyz for 3D), no storage buffer is written, and the
//   shader uses no atomics, workgroup memory or barriers. A full-target draw per written texture and layer runs it.
// - scatter (A2): stores go anywhere (storage buffer words, texels at any coordinates), but each invocation makes a
//   bounded number of them (no store inside a loop of unknown length), never reads back what it stored itself, and
//   uses no atomics, workgroup memory or barriers. An instanced point draw per target runs it: instance k of an
//   invocation writes its k-th store.
// - cpu (B): everything else (atomics, workgroup memory, barriers, unbounded stores), as JavaScript.
import { fault } from '../../../shared/errors.js';
import type { IREntryPoint, IRExpr, IRFunction, IRGlobalVar, IRModule, IRParam, IRStmt } from '../wgsl/ir.js';
import type { StructType, TextureType, Type } from '../wgsl/types.js';

/** The three ways the layer runs a compute entry point; see the module comment. */
export type ComputeTier = 'fragment' | 'scatter' | 'cpu';

/** A storage buffer or storage texture an entry point writes. */
export interface ComputeTarget {
  readonly kind: 'buffer' | 'texture';
  readonly group: number;
  readonly binding: number;
  /** The WGSL variable's name. */
  readonly name: string;
  /**
   * The most stores one invocation makes to it: 4-byte words for a buffer, texels for a texture (the scatter tier's
   * instance count). Infinity when unbounded.
   */
  readonly stores: number;
  /** Texel format and dimension of a storage texture. */
  readonly format?: string;
  readonly dimension?: string;
}

/** How the layer runs one compute entry point. */
export interface ComputePlan {
  readonly tier: ComputeTier;
  readonly entryPoint: string;
  /** `@workgroup_size`, overrides applied. */
  readonly workgroupSize: readonly [number, number, number];
  /** What it writes, in binding order. */
  readonly targets: readonly ComputeTarget[];
  /** Why it runs on this tier and not a faster one; empty for the fragment tier. */
  readonly reason: string;
}

const unsupported = (what: string): Error =>
  fault('unsupported', `WebGL2 compatibility cannot run ${what}`, 'compatibility-layer');

/** Formats a fragment or point draw can write (renderable on a full-tier WebGL2 context). */
const RENDERABLE = new Set([
  'r8unorm',
  'r8uint',
  'r8sint',
  'rg8unorm',
  'rg8uint',
  'rg8sint',
  'rgba8unorm',
  'bgra8unorm',
  'rgba8uint',
  'rgba8sint',
  'r16uint',
  'r16sint',
  'r16float',
  'rg16uint',
  'rg16sint',
  'rg16float',
  'rgba16uint',
  'rgba16sint',
  'rgba16float',
  'r32uint',
  'r32sint',
  'r32float',
  'rg32uint',
  'rg32sint',
  'rg32float',
  'rgba32uint',
  'rgba32sint',
  'rgba32float',
  'rgb10a2uint',
  'rgb10a2unorm',
  'rg11b10ufloat',
]);

/** The numeric value of a constant or override expression (workgroup sizes, loop bounds); undefined if not constant. */
function constantOf(e: IRExpr, constants: Readonly<Record<string, number | boolean>> = {}): number | undefined {
  if (typeof e.value === 'number') return e.value;
  if (typeof e.value === 'boolean') return +e.value;
  switch (e.kind) {
    case 'name': {
      const d = e.decl;
      if (d.kind === 'override') {
        const given = constants[d.name] ?? (d.id !== undefined ? constants[String(d.id)] : undefined);
        if (given !== undefined) return Number(given);
        return d.init ? constantOf(d.init, constants) : undefined;
      }
      if (d.kind === 'const' || d.kind === 'local-const') return typeof d.value === 'number' ? d.value : undefined;
      return undefined;
    }
    case 'convert':
      return constantOf(e.arg, constants);
    case 'unary': {
      const v = constantOf(e.operand, constants);
      return v === undefined ? undefined : e.op === '-' ? -v : e.op === '~' ? ~v : +!v;
    }
    case 'binary': {
      const a = constantOf(e.left, constants),
        b = constantOf(e.right, constants);
      if (a === undefined || b === undefined) return undefined;
      switch (e.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return b === 0 ? a : Math.trunc(a / b);
        case '%':
          return b === 0 ? 0 : a % b;
        case '<<':
          return a << b;
        case '>>':
          return a >> b;
      }
    }
  }
  return undefined;
}

/** `@workgroup_size` of a compute entry point, with pipeline constants applied. */
function workgroupSizeOf(
  fn: IRFunction,
  constants: Readonly<Record<string, number | boolean>> = {},
): [number, number, number] {
  const out: [number, number, number] = [1, 1, 1];
  (fn.workgroupSize ?? []).forEach((v, i) => {
    const n = typeof v === 'number' ? v : constantOf(v, constants);
    if (n === undefined || !Number.isInteger(n) || n < 1)
      throw unsupported(`compute entry point '${fn.name}': @workgroup_size needs constant values; pass its overrides`);
    out[i] = n;
  });
  if (out[0] * out[1] * out[2] > 256)
    throw new RangeError(
      `@workgroup_size(${out.join(', ')}) of '${fn.name}' has more than 256 invocations; use at most 256 (WebGPU's limit)`,
    );
  return out;
}

/** 4-byte words of data (padding excluded) a value of `t` occupies in memory. */
function wordsOf(t: Type): number {
  switch (t.kind) {
    case 'scalar':
    case 'atomic':
      return 1;
    case 'vector':
      return t.size;
    case 'matrix':
      return t.columns * t.rows;
    case 'array':
      return typeof t.count === 'number' ? t.count * wordsOf(t.element) : Number.POSITIVE_INFINITY;
    case 'struct':
      return t.members.reduce((n, m) => n + wordsOf(m.type), 0);
  }
  return 0;
}

const storeOf = (t: Type): Type => (t.kind === 'ref' || t.kind === 'ptr' ? t.store : t);

/** Which part of the global invocation id an expression equals (A1's own-texel test). */
type Tag = 'x' | 'y' | 'z' | 'xy' | 'xyz' | undefined;

interface Walk {
  /** Value tags of lets and parameters. */
  tags: Map<object, Tag>;
  /** Texture parameters bound to module-scope textures. */
  handles: Map<IRParam, IRGlobalVar>;
}

/** Analyzes one compute entry point and picks its tier. */
export function planCompute(
  module: IRModule,
  entry: IREntryPoint,
  constants: Readonly<Record<string, number | boolean>> = {},
): ComputePlan {
  if (entry.stage !== 'compute') throw new TypeError(`'${entry.name}' is not a compute entry point; pass a @compute entry point`);
  return new Analyzer(module, entry, constants).run();
}

class Analyzer {
  private cpu = '';
  private fragment = '';
  private hazard = '';
  private readonly targets = new Map<IRGlobalVar, { stores: number }>();
  /** Targets stored to so far in the walk (reads of them after that are hazards). */
  private stored = new Set<IRGlobalVar>();
  /** Store multiplier of the enclosing loops. */
  private times = 1;

  constructor(
    private readonly module: IRModule,
    private readonly entry: IREntryPoint,
    private readonly constants: Readonly<Record<string, number | boolean>>,
  ) {}

  run(): ComputePlan {
    for (const e of this.module.enables)
      if (e !== 'f16') throw unsupported(`'enable ${e};' (only f16 is mapped, to highp float)`);
    const fn = this.entry.function;
    const workgroupSize = workgroupSizeOf(fn, this.constants);
    const tags = new Map<object, Tag>();
    for (const p of fn.params) {
      if (p.io.builtin === 'global_invocation_id') tags.set(p, 'xyz');
      if (p.io.builtin?.startsWith('subgroup'))
        throw unsupported(`@builtin(${p.io.builtin}) (WebGL2 has no subgroups)`);
      if (p.type.kind === 'struct')
        for (const m of p.type.members)
          if (m.builtin?.startsWith('subgroup')) throw unsupported(`@builtin(${m.builtin}) (WebGL2 has no subgroups)`);
    }
    for (const g of this.entry.globals)
      if (g.kind === 'var' && g.space === 'workgroup') this.cpu ||= `it uses workgroup memory ('${g.name}')`;
    this.statements(fn.body, { tags, handles: new Map() });
    const targets: ComputeTarget[] = [...this.targets.entries()]
      .map(([v, t]) => {
        const tt = v.type.kind === 'texture' ? (v.type as TextureType) : undefined;
        return {
          kind: tt ? ('texture' as const) : ('buffer' as const),
          group: v.group as number,
          binding: v.binding as number,
          name: v.name,
          stores: t.stores,
          ...(tt ? { format: tt.format, dimension: tt.dimension } : {}),
        };
      })
      .sort((a, b) => a.group - b.group || a.binding - b.binding);
    const unbounded = targets.find((t) => !Number.isFinite(t.stores));
    let tier: ComputeTier, reason: string;
    if (this.cpu) [tier, reason] = ['cpu', this.cpu];
    else if (unbounded) [tier, reason] = ['cpu', `it stores to '${unbounded.name}' inside a loop of unknown length`];
    else if (this.hazard) [tier, reason] = ['cpu', this.hazard];
    else if (this.fragment || !targets.length) [tier, reason] = ['scatter', this.fragment || 'it writes nothing'];
    else [tier, reason] = ['fragment', ''];
    if (tier !== 'cpu') {
      const bad = targets.find((t) => t.kind === 'texture' && !RENDERABLE.has(t.format as string));
      if (bad) [tier, reason] = ['cpu', `WebGL2 cannot draw into its ${bad.format} storage texture '${bad.name}'`];
      const big = targets.find((t) => t.stores > 1024);
      if (tier === 'scatter' && big) [tier, reason] = ['cpu', `it stores ${big.stores} words to '${big.name}'`];
    }
    return { tier, entryPoint: this.entry.name, workgroupSize, targets, reason };
  }

  private target(v: IRGlobalVar, stores: number): void {
    const t = this.targets.get(v) ?? { stores: 0 };
    t.stores += stores * this.times;
    this.targets.set(v, t);
    this.stored.add(v);
  }

  // ---------------------------------------------------------------- statements

  private statements(list: readonly IRStmt[], w: Walk): void {
    for (const s of list) this.statement(s, w);
  }

  private statement(s: IRStmt, w: Walk): void {
    switch (s.kind) {
      case 'block':
        return this.statements(s.body, w);
      case 'decl': {
        const d = s.local;
        if (d.init) {
          this.expr(d.init, w);
          if (d.kind === 'let') w.tags.set(d, this.tag(d.init, w));
        }
        return;
      }
      case 'assign':
        this.expr(s.rhs, w);
        if (s.lhs) {
          this.address(s.lhs, w);
          if (s.op !== '=') this.read(s.lhs);
          this.store(s.lhs);
        }
        return;
      case 'increment':
        this.address(s.lhs, w);
        this.read(s.lhs);
        this.store(s.lhs);
        return;
      case 'call':
        return this.expr(s.call, w);
      case 'if':
        this.expr(s.condition, w);
        this.statements(s.then, w);
        if (s.else) this.statements(s.else, w);
        return;
      case 'switch':
        this.expr(s.selector, w);
        for (const c of s.clauses) this.statements(c.body, w);
        return;
      case 'for': {
        if (s.init) this.statement(s.init, w);
        const n = this.tripCount(s);
        this.loop(n, w, () => {
          if (s.condition) this.expr(s.condition, w);
          this.statements(s.body, w);
          if (s.update) this.statement(s.update, w);
        });
        return;
      }
      case 'while':
        this.loop(Number.POSITIVE_INFINITY, w, () => {
          this.expr(s.condition, w);
          this.statements(s.body, w);
        });
        return;
      case 'loop':
        this.loop(Number.POSITIVE_INFINITY, w, () => {
          this.statements(s.body, w);
          if (s.continuing) this.statements(s.continuing, w);
          if (s.breakIf) this.expr(s.breakIf, w);
        });
        return;
      case 'return':
        if (s.value) this.expr(s.value, w);
        return;
      case 'discard':
        throw unsupported('discard in a compute shader');
    }
  }

  /**
   * A loop body, walked twice so that a read in one iteration after a store in the previous is a hazard; stores
   * inside count `n` times (Infinity for a loop of unknown length).
   */
  private loop(n: number, w: Walk, body: () => void): void {
    const saved = this.times;
    this.times = saved * n;
    // The second walk only finds hazards: its stores are not counted again.
    const before = new Map([...this.targets].map(([k, v]) => [k, v.stores]));
    body();
    const after = new Map([...this.targets].map(([k, v]) => [k, v.stores]));
    body();
    for (const [k, v] of this.targets) v.stores = after.get(k) ?? before.get(k) ?? 0;
    this.times = saved;
  }

  /** The iteration count of `for (var i = a; i < b; i++)` with constants a, b and i unchanged in the body. */
  private tripCount(s: Extract<IRStmt, { kind: 'for' }>): number {
    const init = s.init;
    if (init?.kind !== 'decl' || init.local.kind !== 'local-var' || !init.local.init) return Number.POSITIVE_INFINITY;
    const v = init.local,
      start = constantOf(init.local.init, this.constants);
    const c = s.condition,
      u = s.update;
    if (start === undefined || c?.kind !== 'binary' || !u) return Number.POSITIVE_INFINITY;
    const isV = (e: IRExpr) => e.kind === 'load' && e.ref.kind === 'name' && e.ref.decl === v;
    const bound = isV(c.left) ? constantOf(c.right, this.constants) : undefined;
    if (bound === undefined) return Number.POSITIVE_INFINITY;
    let step: number | undefined;
    if (u.kind === 'increment' && u.lhs.kind === 'name' && u.lhs.decl === v) step = u.op === '++' ? 1 : -1;
    if (u.kind === 'assign' && u.lhs?.kind === 'name' && u.lhs.decl === v && (u.op === '+=' || u.op === '-=')) {
      const k = constantOf(u.rhs, this.constants);
      if (k !== undefined) step = u.op === '+=' ? k : -k;
    }
    if (!step || this.assigns(s.body, v)) return Number.POSITIVE_INFINITY;
    const span =
      c.op === '<'
        ? bound - start
        : c.op === '<='
          ? bound - start + 1
          : c.op === '>'
            ? start - bound
            : c.op === '>='
              ? start - bound + 1
              : c.op === '!='
                ? Math.abs(bound - start)
                : Number.NaN;
    if (!Number.isFinite(span)) return Number.POSITIVE_INFINITY;
    return Math.max(0, Math.ceil(span / Math.abs(step)));
  }

  /** True when a statement list assigns `v` (or takes its address). */
  private assigns(list: readonly IRStmt[], v: object): boolean {
    const hits = (e: IRExpr | null | undefined): boolean => {
      if (!e) return false;
      if (e.kind === 'name') return e.decl === v;
      if (e.kind === 'address-of') return hits(e.ref);
      if (e.kind === 'member' || e.kind === 'swizzle' || e.kind === 'index') return hits(e.object);
      if (e.kind === 'call' || e.kind === 'builtin' || e.kind === 'construct') return e.args.some(argHits);
      return false;
    };
    const argHits = (e: IRExpr): boolean => e.kind === 'address-of' && hits(e.ref);
    const walk = (s: IRStmt): boolean => {
      switch (s.kind) {
        case 'assign':
          return hits(s.lhs) || argHits(s.rhs);
        case 'increment':
          return hits(s.lhs);
        case 'call':
          return hits(s.call);
        case 'block':
          return s.body.some(walk);
        case 'if':
          return s.then.some(walk) || !!s.else?.some(walk);
        case 'switch':
          return s.clauses.some((c) => c.body.some(walk));
        case 'for':
          return (!!s.init && walk(s.init)) || (!!s.update && walk(s.update)) || s.body.some(walk);
        case 'while':
          return s.body.some(walk);
        case 'loop':
          return s.body.some(walk) || !!s.continuing?.some(walk);
        case 'decl':
          return !!s.local.init && argHits(s.local.init);
      }
      return false;
    };
    return list.some(walk);
  }

  // ---------------------------------------------------------------- memory

  /** The module-scope variable a reference is rooted at, if any. */
  private root(e: IRExpr): IRGlobalVar | undefined {
    switch (e.kind) {
      case 'name':
        return e.decl.kind === 'var' ? e.decl : undefined;
      case 'member':
      case 'swizzle':
      case 'index':
        return this.root(e.object);
      case 'deref':
        return e.pointer.kind === 'address-of' ? this.root(e.pointer.ref) : undefined;
      case 'address-of':
        return this.root(e.ref);
    }
    return undefined;
  }

  /** Walks the index expressions of a reference. */
  private address(e: IRExpr, w: Walk): void {
    if (e.kind === 'index') {
      this.address(e.object, w);
      this.expr(e.index, w);
    } else if (e.kind === 'member' || e.kind === 'swizzle') this.address(e.object, w);
    else if (e.kind === 'deref') this.expr(e.pointer, w);
    else if (e.kind === 'address-of') this.address(e.ref, w);
  }

  private read(ref: IRExpr): void {
    const v = this.root(ref);
    if (v?.space === 'storage' && this.stored.has(v))
      this.hazard ||= `an invocation reads back '${v.name}' after storing to it`;
  }

  private store(ref: IRExpr): void {
    const v = this.root(ref);
    if (!v) {
      // A store through a pointer parameter: function or private memory stay inside the invocation; storage and
      // workgroup pointers (an extension WGSL allows) go to the CPU tier.
      const p = ref.kind === 'deref' ? ref.pointer.type : undefined;
      if (p?.kind === 'ptr' && (p.space === 'storage' || p.space === 'workgroup'))
        this.cpu ||= `it stores through a ${p.space} pointer`;
      return;
    }
    if (v.space === 'storage') {
      this.fragment ||= `it writes the storage buffer '${v.name}'`;
      this.target(v, wordsOf(storeOf(ref.type)));
    } else if (v.space === 'workgroup') this.cpu ||= `it uses workgroup memory ('${v.name}')`;
  }

  // ---------------------------------------------------------------- expressions

  private handle(e: IRExpr, w: Walk): IRGlobalVar | undefined {
    if (e.kind !== 'name') return undefined;
    if (e.decl.kind === 'var') return e.decl;
    return e.decl.kind === 'param' ? w.handles.get(e.decl) : undefined;
  }

  private expr(e: IRExpr, w: Walk): void {
    switch (e.kind) {
      case 'literal':
      case 'name':
        return;
      case 'load':
        this.address(e.ref, w);
        this.read(e.ref);
        return;
      case 'address-of':
        this.address(e.ref, w);
        return;
      case 'deref':
        this.expr(e.pointer, w);
        return;
      case 'construct':
        for (const a of e.args) this.expr(a, w);
        return;
      case 'convert':
      case 'bitcast':
        return this.expr(e.arg, w);
      case 'member':
      case 'swizzle':
        return this.expr(e.object, w);
      case 'index':
        this.expr(e.object, w);
        return this.expr(e.index, w);
      case 'unary':
        return this.expr(e.operand, w);
      case 'binary':
        this.expr(e.left, w);
        return this.expr(e.right, w);
      case 'builtin':
        return this.builtin(e, w);
      case 'call':
        return this.call(e.fn, e.args, w);
    }
  }

  private call(fn: IRFunction, args: readonly IRExpr[], w: Walk): void {
    const tags = new Map<object, Tag>(),
      handles = new Map<IRParam, IRGlobalVar>();
    fn.params.forEach((p, i) => {
      const a = args[i];
      if (p.type.kind === 'texture' || p.type.kind === 'sampler') {
        const g = this.handle(a, w);
        if (g) handles.set(p, g);
        return;
      }
      this.expr(a, w);
      tags.set(p, this.tag(a, w));
      if (p.type.kind === 'ptr' && (p.type.space === 'storage' || p.type.space === 'workgroup')) {
        this.cpu ||= `it passes a ${p.type.space} pointer to '${fn.name}'`;
        if (p.type.space === 'storage' && p.type.access === 'read_write') {
          const v = this.root(a);
          if (v) this.target(v, Number.POSITIVE_INFINITY);
        }
      }
    });
    this.statements(fn.body, { tags, handles });
  }

  private builtin(e: Extract<IRExpr, { kind: 'builtin' }>, w: Walk): void {
    const name = e.name;
    if (name.startsWith('subgroup') || name.startsWith('quad'))
      throw unsupported(`${name}() (WebGL2 has no subgroups)`);
    if (name.startsWith('atomic')) {
      this.cpu ||= `it uses ${name}()`;
      const v = this.root(e.args[0]);
      if (v?.space === 'storage' && name !== 'atomicLoad') this.target(v, Number.POSITIVE_INFINITY);
    } else if (name.endsWith('Barrier') || name === 'workgroupUniformLoad') this.cpu ||= `it uses ${name}()`;
    if (name === 'textureStore') {
      const t = this.handle(e.args[0], w);
      for (const a of e.args.slice(1)) this.expr(a, w);
      if (!t) {
        this.cpu ||= 'it stores to a texture it does not name at module scope';
        return;
      }
      const tt = t.type as TextureType;
      const coord = this.tag(e.args[1], w);
      const own =
        tt.dimension === '1d'
          ? coord === 'x'
          : tt.dimension === '2d'
            ? coord === 'xy'
            : tt.dimension === '2d_array'
              ? coord === 'xy' && this.tag(e.args[2], w) === 'z'
              : tt.dimension === '3d'
                ? coord === 'xyz'
                : false;
      if (!own) this.fragment ||= `it stores to '${t.name}' at texels other than its own`;
      this.target(t, 1);
      return;
    }
    if (name === 'textureLoad') {
      const t = this.handle(e.args[0], w);
      if (t && (t.type as TextureType).shape === 'storage' && this.stored.has(t))
        this.hazard ||= `an invocation reads back '${t.name}' after storing to it`;
    }
    for (const a of e.args) this.expr(a, w);
  }

  /** Which part of the global invocation id `e` equals, if any. */
  private tag(e: IRExpr, w: Walk): Tag {
    switch (e.kind) {
      case 'name':
        return w.tags.get(e.decl);
      case 'convert':
        return this.tag(e.arg, w);
      case 'member': {
        // A struct parameter's @builtin(global_invocation_id) member.
        const st = storeOf(e.object.type) as StructType;
        if (e.object.kind === 'name' && e.object.decl.kind === 'param' && st.kind === 'struct')
          return st.members[e.index]?.builtin === 'global_invocation_id' ? 'xyz' : undefined;
        return undefined;
      }
      case 'swizzle': {
        const t = this.tag(e.object, w),
          c = e.components.join('');
        if (t === 'xyz') return ({ '0': 'x', '1': 'y', '2': 'z', '01': 'xy', '012': 'xyz' } as Record<string, Tag>)[c];
        if (t === 'xy') return ({ '0': 'x', '1': 'y', '01': 'xy' } as Record<string, Tag>)[c];
        return undefined;
      }
      case 'construct': {
        const parts = e.args.map((a) => this.tag(a, w) ?? '?').join('');
        if (e.args.length === 1 && storeOf(e.args[0].type).kind === 'vector') return this.tag(e.args[0], w);
        return parts === 'xy' || parts === 'xyz' ? parts : undefined;
      }
    }
    return undefined;
  }
}
