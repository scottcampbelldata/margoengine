// The CPU tier of compute (roadmap "Compute plan", tier B, milestone M5): a compute entry point of the typed IR as
// JavaScript, run invocation by invocation by cpu.ts. Atomics are plain read-modify-writes there (one invocation runs
// at a time), barriers are generator yields (each invocation of a workgroup runs to its next barrier before any goes
// on), and workgroup memory is one object per workgroup. Written clean room from the W3C WGSL specification.
import { fault } from '../../../shared/errors.js';
import { encodeName } from '../glsl/emit.js';
import type {
  ConstValue,
  IREntryPoint,
  IRExpr,
  IRFunction,
  IRGlobalVar,
  IRLocal,
  IRModule,
  IROverride,
  IRStmt,
} from '../wgsl/ir.js';
import {
  alignOf,
  type ArrayType,
  type ScalarType,
  sizeOf,
  type StructType,
  type TextureType,
  type Type,
} from '../wgsl/types.js';
import { type CPUBindings, H, type KernelModule } from './cpu.js';

const unsupported = (what: string): Error =>
  fault('unsupported', `WebGL2 compatibility cannot run ${what} on the CPU`, 'compatibility-layer');

/** A compiled CPU kernel: call `bind` per dispatch with the bound resources, then run it with cpu.ts. */
export interface CPUKernel {
  readonly source: string;
  /** True when the entry point reaches a barrier (invocations of a workgroup then interleave). */
  readonly barriers: boolean;
  bind(resources: CPUBindings): KernelModule;
}

type Kind = 'f' | 'i' | 'u' | 'b';
const kindOf = (s: ScalarType): Kind =>
  s.name === 'bool' ? 'b' : s.name === 'u32' ? 'u' : s.name === 'i32' || s.name === 'abstract-int' ? 'i' : 'f';
const elementOf = (t: Type): ScalarType | undefined =>
  t.kind === 'scalar' ? t : t.kind === 'vector' || t.kind === 'matrix' ? t.element : undefined;
const storeOf = (t: Type): Type => (t.kind === 'ref' || t.kind === 'ptr' ? t.store : t);
const composite = (t: Type): boolean =>
  t.kind === 'vector' || t.kind === 'matrix' || t.kind === 'array' || t.kind === 'struct';
const strideOf = (t: ArrayType): number => Math.ceil(sizeOf(t.element) / alignOf(t.element)) * alignOf(t.element);

/** A reference: a variable's value and a path into it, a pointer parameter and a path, or bytes of a buffer. */
type JRef =
  | { readonly k: 'var'; readonly root: string; readonly keys: readonly string[]; readonly type: Type }
  | { readonly k: 'ptr'; readonly p: string; readonly keys: readonly string[]; readonly type: Type }
  | { readonly k: 'mem'; readonly b: string; readonly off: string; readonly type: Type };

const BARRIERS = new Set(['workgroupBarrier', 'storageBarrier', 'textureBarrier', 'workgroupUniformLoad']);

/** Compiles one compute entry point to JavaScript. */
export function compileCPU(
  module: IRModule,
  entry: IREntryPoint,
  constants: Readonly<Record<string, number | boolean>> = {},
): CPUKernel {
  const source = new JSEmitter(module, entry, constants).run();
  let factory: (h: typeof H, r: CPUBindings) => KernelModule;
  try {
    factory = new Function('H', 'R', source) as typeof factory;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw fault(
        'failed',
        `WebGL2 compatibility made JavaScript that does not parse (a bug: report it): ${error.message}`,
        'compatibility-layer',
      );
    // A Content-Security-Policy without 'unsafe-eval' forbids new Function.
    throw unsupported(
      `'${entry.name}': the page forbids JavaScript compiled at run time (its Content-Security-Policy lacks 'unsafe-eval')`,
    );
  }
  const barriers = /\byield\b/.test(source);
  return { source, barriers, bind: (r) => factory(H, r) };
}

class JSEmitter {
  private readonly out: string[] = [];
  private readonly helpers = new Map<string, string>();
  private readonly bindings: string[] = [];
  private readonly bound = new Set<string>();
  private readonly globalsDone = new Set<object>();
  private readonly generators = new Map<IRFunction, boolean>();
  private names = new Map<object, string>();
  private aliases = new Map<IRLocal, JRef>();
  private lines: string[] = [];
  private depth = 1;
  private counter = 0;
  private readonly workgroupVars: IRGlobalVar[] = [];
  private readonly privateVars: IRGlobalVar[] = [];
  /** Module-scope composite constants, emitted once. */
  private readonly consts: string[] = [];
  /** Loop labels for break and continue: [break label, continue label]. */
  private loops: { brk: string; cont: string | null; isSwitch?: boolean }[] = [];

  constructor(
    private readonly module: IRModule,
    private readonly entry: IREntryPoint,
    private readonly constants: Readonly<Record<string, number | boolean>>,
  ) {}

  run(): string {
    const fns = this.reachable(this.entry.function);
    const bodies = fns.map((f) => this.func(f));
    const inputs = this.entry.function.params.map((p) =>
      p.type.kind === 'struct' ? p.type.members.map((m) => m.builtin as string) : (p.io.builtin as string),
    );
    const wg = this.workgroupVars.map((v) => `${this.globalName(v)}: ${this.zero(v.type)}`);
    const pv = this.privateVars.map(
      (v) => `$.${this.globalName(v)} = ${v.init ? this.value(v.init, true) : this.zero(v.type)};`,
    );
    return [
      '"use strict";',
      `const { ${Object.keys(H).join(', ')} } = H;`,
      ...this.bindings,
      ...this.consts,
      ...this.helpers.values(),
      ...this.out,
      ...bodies,
      `function workgroup() { return { ${wg.join(', ')} }; }`,
      `function invocation($) { ${pv.join(' ')} }`,
      `return { main: ${this.fname(this.entry.function)}, workgroup, invocation, inputs: ${JSON.stringify(inputs)} };`,
    ].join('\n');
  }

  /** The functions the entry reaches, callees first. */
  private reachable(root: IRFunction): IRFunction[] {
    const out: IRFunction[] = [],
      seen = new Set<IRFunction>();
    const visit = (f: IRFunction) => {
      if (seen.has(f)) return;
      seen.add(f);
      for (const g of f.calls) visit(g);
      out.push(f);
    };
    visit(root);
    return out;
  }

  /** True when a function reaches a barrier (it becomes a generator). */
  private isGenerator(f: IRFunction): boolean {
    let known = this.generators.get(f);
    if (known !== undefined) return known;
    known =
      [...f.calls].some((g) => this.isGenerator(g)) ||
      this.mentions(f.body, (e) => e.kind === 'builtin' && BARRIERS.has(e.name));
    this.generators.set(f, known);
    return known;
  }

  /** True when some expression in the statements satisfies `test`. */
  private mentions(list: readonly IRStmt[], test: (e: IRExpr) => boolean): boolean {
    const ex = (e: IRExpr | null | undefined): boolean => {
      if (!e) return false;
      if (test(e)) return true;
      switch (e.kind) {
        case 'load':
        case 'address-of':
          return ex(e.ref);
        case 'deref':
          return ex(e.pointer);
        case 'construct':
        case 'builtin':
        case 'call':
          return e.args.some(ex);
        case 'convert':
        case 'bitcast':
          return ex(e.arg);
        case 'member':
        case 'swizzle':
          return ex(e.object);
        case 'index':
          return ex(e.object) || ex(e.index);
        case 'unary':
          return ex(e.operand);
        case 'binary':
          return ex(e.left) || ex(e.right);
      }
      return false;
    };
    const st = (s: IRStmt): boolean => {
      switch (s.kind) {
        case 'block':
          return s.body.some(st);
        case 'decl':
          return ex(s.local.init);
        case 'assign':
          return ex(s.lhs) || ex(s.rhs);
        case 'increment':
          return ex(s.lhs);
        case 'call':
          return ex(s.call);
        case 'if':
          return ex(s.condition) || s.then.some(st) || !!s.else?.some(st);
        case 'switch':
          return ex(s.selector) || s.clauses.some((c) => c.body.some(st));
        case 'loop':
          return s.body.some(st) || !!s.continuing?.some(st) || ex(s.breakIf);
        case 'for':
          return (!!s.init && st(s.init)) || ex(s.condition) || (!!s.update && st(s.update)) || s.body.some(st);
        case 'while':
          return ex(s.condition) || s.body.some(st);
        case 'return':
          return ex(s.value);
      }
      return false;
    };
    return list.some(st);
  }

  // ---------------------------------------------------------------- names

  private fname(f: IRFunction): string {
    return `f_${encodeName(f.name)}`;
  }
  private globalName(v: { name: string }): string {
    return `g_${encodeName(v.name)}`;
  }
  private localName(d: object & { name: string }): string {
    let n = this.names.get(d);
    if (!n) this.names.set(d, (n = `l_${encodeName(d.name)}_${this.counter++}`));
    return n;
  }
  private temp(): string {
    return `_t${this.counter++}`;
  }
  private line(text: string): void {
    this.lines.push(`${'  '.repeat(this.depth)}${text}`);
  }
  private helper(name: string, source: () => string): string {
    if (!this.helpers.has(name)) this.helpers.set(name, source());
    return name;
  }

  // ---------------------------------------------------------------- module scope

  /** The JavaScript lvalue of a module-scope variable, or its binding. */
  private global(v: IRGlobalVar): string {
    if (v.space === 'private' || v.space === 'workgroup') {
      if (!this.globalsDone.has(v)) {
        this.globalsDone.add(v);
        (v.space === 'private' ? this.privateVars : this.workgroupVars).push(v);
      }
      return v.space === 'private' ? `$.${this.globalName(v)}` : `$.w.${this.globalName(v)}`;
    }
    const key = `${v.group}:${v.binding}`,
      name = `r${v.group}_${v.binding}`;
    if (!this.bound.has(key)) {
      this.bound.add(key);
      const map =
        v.space === 'uniform' || v.space === 'storage'
          ? 'buffers'
          : v.type.kind === 'sampler'
            ? 'samplers'
            : 'textures';
      this.bindings.push(`const ${name} = R.${map}.get('${key}');`);
    }
    return name;
  }

  private override(o: IROverride): string {
    const given = this.constants[o.name] ?? (o.id !== undefined ? this.constants[String(o.id)] : undefined);
    const s = o.type as ScalarType,
      k = kindOf(s);
    if (given !== undefined) {
      const n = typeof given === 'boolean' ? +given : Number(given);
      return k === 'b'
        ? String(n !== 0)
        : k === 'i'
          ? String(Math.trunc(n) | 0)
          : k === 'u'
            ? String(Math.trunc(n) >>> 0)
            : this.num(Math.fround(n));
    }
    if (o.init) return `(${this.value(o.init, true)})`;
    throw unsupported(`override '${o.name}' without a value: pass it in the pipeline's constants`);
  }

  // ---------------------------------------------------------------- constants

  private num(v: number): string {
    if (Object.is(v, -0)) return '-0';
    if (v !== v) return 'NaN';
    if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
    return v < 0 ? `(${v})` : String(v);
  }

  private literal(value: ConstValue, t: Type): string {
    switch (t.kind) {
      case 'scalar': {
        const k = kindOf(t);
        if (k === 'b') return value ? 'true' : 'false';
        const n = Number(value);
        return this.num(k === 'f' ? Math.fround(n) : k === 'u' ? n >>> 0 : n | 0);
      }
      case 'vector':
        return `[${(value as ConstValue[]).map((v) => this.literal(v, t.element)).join(', ')}]`;
      case 'matrix': {
        const col = { kind: 'vector', size: t.rows, element: t.element } as Type;
        return `[${(value as ConstValue[]).map((c) => this.literal(c, col)).join(', ')}]`;
      }
      case 'array':
        return `[${(value as ConstValue[]).map((v) => this.literal(v, t.element)).join(', ')}]`;
      case 'struct':
        return `[${(value as ConstValue[]).map((v, i) => this.literal(v, t.members[i].type)).join(', ')}]`;
    }
    throw unsupported(`a constant of type ${t.kind}`);
  }

  private zero(t: Type): string {
    switch (t.kind) {
      case 'scalar':
        return kindOf(t) === 'b' ? 'false' : '0';
      case 'atomic':
        return '0';
      case 'vector':
        return `[${Array(t.size).fill(this.zero(t.element)).join(', ')}]`;
      case 'matrix':
        return `[${Array(t.columns)
          .fill(`[${Array(t.rows).fill('0').join(', ')}]`)
          .join(', ')}]`;
      case 'array': {
        const n = this.count(t);
        return `fill(${n}, () => ${this.zero(t.element)})`;
      }
      case 'struct':
        return `[${t.members.map((m) => this.zero(m.type)).join(', ')}]`;
    }
    throw unsupported(`a zero value of type ${t.kind}`);
  }

  private count(t: ArrayType): string {
    if (typeof t.count === 'number') return String(t.count);
    if (t.count === 'runtime') throw unsupported('a runtime-sized array outside a storage buffer');
    const name = (t.count as { override: string }).override;
    const o = this.module.globals.find((g) => g.kind === 'override' && g.name === name) as IROverride | undefined;
    if (!o) throw unsupported(`array size '${name}'`);
    return this.override(o);
  }

  // ---------------------------------------------------------------- functions

  private func(f: IRFunction): string {
    this.names = new Map();
    this.aliases = new Map();
    this.lines = [];
    this.depth = 1;
    this.loops = [];
    const params = f.params.map((p) => this.localName(p));
    this.statements(f.body);
    const star = this.isGenerator(f) ? '*' : '';
    return `function${star} ${this.fname(f)}($${params.map((p) => `, ${p}`).join('')}) {\n${this.lines.join('\n')}\n}`;
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
        return this.declaration(s.local);
      case 'assign':
        return this.assign(s.op, s.lhs, s.rhs);
      case 'increment': {
        const r = this.ref(s.lhs, true),
          t = storeOf(r.type) as ScalarType;
        const one = { kind: 'literal', type: t, value: 1, start: 0, end: 0 } as IRExpr;
        this.store(r, this.binary(s.op === '++' ? '+' : '-', this.load(r, false), t, one, t));
        return;
      }
      case 'call':
        this.line(`${this.value(s.call, false)};`);
        return;
      case 'if':
        this.line(`if (${this.value(s.condition, false)}) {`);
        this.block(s.then);
        if (s.else) {
          this.line('} else {');
          this.block(s.else);
        }
        this.line('}');
        return;
      case 'switch': {
        const label = `S${this.counter++}`;
        this.line(`${label}: switch (${this.value(s.selector, false)}) {`);
        this.loops.push({ brk: label, cont: null, isSwitch: true });
        for (const c of s.clauses) {
          const labels = c.selectors.map((v) => (v === null ? 'default:' : `case ${this.num(v)}:`));
          this.line(`${labels.join(' ')} {`);
          this.block(c.body);
          this.line(`} break ${label};`);
        }
        this.loops.pop();
        this.line('}');
        return;
      }
      case 'loop': {
        const label = `L${this.counter++}`;
        if (!s.continuing?.length && !s.breakIf) {
          this.line(`${label}: for (;;) {`);
          this.loops.push({ brk: label, cont: label });
          this.block(s.body);
          this.loops.pop();
          this.line('}');
          return;
        }
        const inner = `C${this.counter++}`;
        this.line(`${label}: for (;;) {`);
        this.depth++;
        this.line(`${inner}: {`);
        this.loops.push({ brk: label, cont: `#${inner}` });
        this.block(s.body);
        this.loops.pop();
        this.line('}');
        this.loops.push({ brk: label, cont: label });
        if (s.continuing) this.statements(s.continuing);
        if (s.breakIf) this.line(`if (${this.value(s.breakIf, false)}) break ${label};`);
        this.loops.pop();
        this.depth--;
        this.line('}');
        return;
      }
      case 'for': {
        const label = `L${this.counter++}`;
        this.line('{');
        this.depth++;
        if (s.init) this.statement(s.init);
        // The update runs on `continue` too, as WGSL's for loop specifies: emitted as a labelled body block.
        const inner = `C${this.counter++}`;
        this.line(`${label}: for (;;) {`);
        this.depth++;
        if (s.condition) this.line(`if (!(${this.value(s.condition, false)})) break;`);
        this.line(`${inner}: {`);
        this.loops.push({ brk: label, cont: `#${inner}` });
        this.block(s.body);
        this.loops.pop();
        this.line('}');
        if (s.update) {
          this.loops.push({ brk: label, cont: label });
          this.statement(s.update);
          this.loops.pop();
        }
        this.depth--;
        this.line('}');
        this.depth--;
        this.line('}');
        return;
      }
      case 'while': {
        const label = `L${this.counter++}`;
        this.line(`${label}: for (;;) {`);
        this.depth++;
        this.line(`if (!(${this.value(s.condition, false)})) break;`);
        this.loops.push({ brk: label, cont: label });
        this.statements(s.body);
        this.loops.pop();
        this.depth--;
        this.line('}');
        return;
      }
      case 'break': {
        const target = this.loops.at(-1);
        this.line(`break ${target?.brk ?? ''};`);
        return;
      }
      case 'continue': {
        const target = [...this.loops].reverse().find((l) => !l.isSwitch);
        const c = target?.cont ?? '';
        this.line(c.startsWith('#') ? `break ${c.slice(1)};` : `continue ${c};`);
        return;
      }
      case 'discard':
        throw unsupported('discard in a compute shader');
      case 'return':
        this.line(s.value ? `return ${this.value(s.value, true)};` : 'return;');
        return;
    }
  }

  private declaration(d: IRLocal): void {
    if (d.kind === 'local-const') {
      this.line(`const ${this.localName(d)} = ${this.literal(d.value as ConstValue, d.type)};`);
      return;
    }
    if (d.kind === 'let' && d.type.kind === 'ptr') {
      this.aliases.set(d, this.pointer(d.init as IRExpr, true));
      return;
    }
    const init = d.init ? this.value(d.init, true) : this.zero(d.type);
    this.line(`${d.kind === 'let' ? 'const' : 'let'} ${this.localName(d)} = ${init};`);
  }

  private assign(op: string, lhs: IRExpr | null, rhs: IRExpr): void {
    if (!lhs) {
      this.line(`${this.value(rhs, false)};`);
      return;
    }
    if (op === '=') {
      const r = this.ref(lhs, true);
      this.store(r, this.value(rhs, true));
      return;
    }
    const r = this.ref(lhs, true),
      t = storeOf(r.type);
    this.store(r, this.binary(op.slice(0, -1), this.load(r, false), t, rhs, t));
  }

  // ---------------------------------------------------------------- references

  private ref(e: IRExpr, stable: boolean): JRef {
    const type = storeOf(e.type);
    switch (e.kind) {
      case 'name': {
        const d = e.decl;
        if (d.kind === 'var') {
          if (d.space === 'storage' || d.space === 'uniform') return { k: 'mem', b: this.global(d), off: '0', type };
          if (d.space === 'private' || d.space === 'workgroup')
            return { k: 'var', root: this.global(d), keys: [], type };
          throw unsupported(`a reference to '${d.name}'`);
        }
        if (d.kind === 'let' && d.type.kind === 'ptr') return this.aliases.get(d) as JRef;
        if (d.kind === 'local-var') return { k: 'var', root: this.localName(d), keys: [], type };
        throw unsupported(`a reference to '${d.name}'`);
      }
      case 'deref':
        return this.pointer(e.pointer, stable);
      case 'member': {
        const base = this.ref(e.object, stable),
          st = storeOf(e.object.type) as StructType;
        if (base.k === 'mem') return { ...base, off: this.add(base.off, st.members[e.index].offset), type };
        return { ...base, keys: [...base.keys, String(e.index)], type };
      }
      case 'swizzle': {
        const base = this.ref(e.object, stable);
        if (base.k === 'mem') return { ...base, off: this.add(base.off, 4 * e.components[0]), type };
        return { ...base, keys: [...base.keys, String(e.components[0])], type };
      }
      case 'index': {
        const base = this.ref(e.object, stable),
          outer = storeOf(e.object.type);
        let n: string;
        if (outer.kind === 'array')
          n =
            outer.count === 'runtime'
              ? `(((${(base as { b: string }).b}.bytes.length - (${(base as { off: string }).off})) / ${strideOf(outer)}) | 0)`
              : this.count(outer);
        else n = String(outer.kind === 'matrix' ? outer.columns : (outer as { size: number }).size);
        let index: string;
        if (typeof e.index.value === 'number') index = String(e.index.value);
        else {
          const unsigned = kindOf(storeOf(e.index.type) as ScalarType) === 'u';
          index = `${unsigned ? 'ux' : 'ix'}(${this.value(e.index, false)}, ${n})`;
          if (stable) {
            const t = this.temp();
            this.line(`const ${t} = ${index};`);
            index = t;
          }
        }
        if (base.k === 'mem') {
          const step =
            outer.kind === 'array' ? strideOf(outer) : outer.kind === 'matrix' ? (outer.rows === 2 ? 8 : 16) : 4;
          return { ...base, off: `${base.off} + ${index} * ${step}`, type };
        }
        return { ...base, keys: [...base.keys, index], type };
      }
    }
    throw unsupported(`a memory reference of kind '${e.kind}'`);
  }

  private add(off: string, n: number): string {
    return n === 0 ? off : off === '0' ? String(n) : `${off} + ${n}`;
  }

  private pointer(p: IRExpr, stable: boolean): JRef {
    if (p.kind === 'address-of') return this.ref(p.ref, stable);
    if (p.kind === 'name') {
      const d = p.decl;
      if (d.kind === 'let') return this.aliases.get(d) as JRef;
      if (d.kind === 'param' && d.type.kind === 'ptr') {
        const name = this.localName(d),
          space = d.type.space;
        if (space === 'storage' || space === 'uniform')
          return { k: 'mem', b: `${name}.b`, off: `${name}.o`, type: d.type.store };
        return { k: 'ptr', p: name, keys: [], type: d.type.store };
      }
    }
    throw unsupported(`a pointer expression of kind '${p.kind}'`);
  }

  private load(r: JRef, retain: boolean): string {
    const copy = (code: string) => (retain && composite(r.type) ? `cp(${code})` : code);
    if (r.k === 'var') return r.keys.length ? `${r.root}${r.keys.map((k) => `[${k}]`).join('')}` : copy(r.root);
    if (r.k === 'ptr') return r.keys.length ? `${r.p}.g()${r.keys.map((k) => `[${k}]`).join('')}` : copy(`${r.p}.g()`);
    return `${this.loader(r.type)}(${r.b}, ${r.off})`;
  }

  private store(r: JRef, code: string): void {
    if (r.k === 'mem') {
      this.line(`${this.storer(r.type)}(${r.b}, ${r.off}, ${code});`);
      return;
    }
    const target = r.k === 'var' ? r.root : `${r.p}.g()`;
    if (r.k === 'ptr') {
      this.line(r.keys.length ? `${r.p}.s(wp(${target}, [${r.keys.join(', ')}], 0, ${code}));` : `${r.p}.s(${code});`);
      return;
    }
    if (!r.keys.length) this.line(`${r.root} = ${code};`);
    else if (r.keys.length === 1) this.line(`${r.root}[${r.keys[0]}] = ${code};`);
    else
      this.line(`${r.root}[${r.keys[0]}] = wp(${r.root}[${r.keys[0]}], [${r.keys.slice(1).join(', ')}], 0, ${code});`);
  }

  /** A pointer value for a call argument: get and set closures, or a buffer and byte offset. */
  private pointerValue(r: JRef): string {
    if (r.k === 'mem') return `{ b: ${r.b}, o: ${r.off} }`;
    const v = this.temp();
    this.line(`let ${v};`);
    const saved = this.lines;
    this.lines = [];
    const depth = this.depth;
    this.depth = 0;
    this.store(r, v);
    const set = this.lines.join(' ').trim();
    this.lines = saved;
    this.depth = depth;
    return `{ g: () => ${this.load(r, false)}, s: (_v) => { ${v} = _v; ${set} } }`;
  }

  /** The function reading a value of `t` at a byte offset of a buffer. */
  private loader(t: Type): string {
    const key = `ld_${this.typeKey(t)}`;
    if (this.helpers.has(key)) return key;
    this.helpers.set(key, '');
    let body: string;
    switch (t.kind) {
      case 'scalar':
      case 'atomic': {
        const k = kindOf(t.kind === 'atomic' ? t.element : t);
        body =
          t.kind === 'scalar' && t.name === 'f16'
            ? 'return halfValue(b.dv.getUint16(o, true));'
            : `return b.dv.${k === 'f' ? 'getFloat32' : k === 'i' ? 'getInt32' : 'getUint32'}(o, true);`;
        break;
      }
      case 'vector':
        body = `return [${Array.from({ length: t.size }, (_, i) => `${this.loader(t.element)}(b, o + ${sizeOf(t.element) * i})`).join(', ')}];`;
        break;
      case 'matrix': {
        const col = { kind: 'vector', size: t.rows, element: t.element } as Type,
          step = t.rows === 2 ? 8 : 16;
        body = `return [${Array.from({ length: t.columns }, (_, c) => `${this.loader(col)}(b, o + ${c * step})`).join(', ')}];`;
        break;
      }
      case 'array':
        body = `const a = []; for (let i = 0; i < ${this.count(t)}; i++) a.push(${this.loader(t.element)}(b, o + i * ${strideOf(t)})); return a;`;
        break;
      case 'struct':
        body = `return [${t.members.map((m) => `${this.loader(m.type)}(b, o + ${m.offset})`).join(', ')}];`;
        break;
      default:
        throw unsupported(`reading ${t.kind} values from a buffer`);
    }
    this.helpers.set(key, `function ${key}(b, o) { ${body} }`);
    return key;
  }

  private storer(t: Type): string {
    const key = `st_${this.typeKey(t)}`;
    if (this.helpers.has(key)) return key;
    this.helpers.set(key, '');
    let body: string;
    switch (t.kind) {
      case 'scalar':
      case 'atomic': {
        const k = kindOf(t.kind === 'atomic' ? t.element : t);
        body =
          t.kind === 'scalar' && t.name === 'f16'
            ? 'b.dv.setUint16(o, halfBits(v), true);'
            : `b.dv.${k === 'f' ? 'setFloat32' : k === 'i' ? 'setInt32' : 'setUint32'}(o, v, true);`;
        break;
      }
      case 'vector':
        body = Array.from(
          { length: t.size },
          (_, i) => `${this.storer(t.element)}(b, o + ${sizeOf(t.element) * i}, v[${i}]);`,
        ).join(' ');
        break;
      case 'matrix': {
        const col = { kind: 'vector', size: t.rows, element: t.element } as Type,
          step = t.rows === 2 ? 8 : 16;
        body = Array.from({ length: t.columns }, (_, c) => `${this.storer(col)}(b, o + ${c * step}, v[${c}]);`).join(
          ' ',
        );
        break;
      }
      case 'array':
        body = `for (let i = 0; i < ${this.count(t)}; i++) ${this.storer(t.element)}(b, o + i * ${strideOf(t)}, v[i]);`;
        break;
      case 'struct':
        body = t.members.map((m, i) => `${this.storer(m.type)}(b, o + ${m.offset}, v[${i}]);`).join(' ');
        break;
      default:
        throw unsupported(`writing ${t.kind} values to a buffer`);
    }
    this.helpers.set(key, `function ${key}(b, o, v) { ${body} }`);
    return key;
  }

  private typeKey(t: Type): string {
    switch (t.kind) {
      case 'scalar':
        return t.name === 'f16' ? 'h' : kindOf(t);
      case 'atomic':
        return `a${kindOf(t.element)}`;
      case 'vector':
        return `v${t.size}${this.typeKey(t.element)}`;
      case 'matrix':
        return `m${t.columns}${t.rows}${this.typeKey(t.element)}`;
      case 'array':
        return `A${this.count(t).replace(/\W/g, '_')}_${this.typeKey(t.element)}`;
      case 'struct':
        return `S${encodeName(t.name)}`;
    }
    return t.kind;
  }

  // ---------------------------------------------------------------- expressions

  /** An expression as JavaScript; `retain` when the value is kept (stored, bound, passed), so loads copy. */
  private value(e: IRExpr, retain: boolean): string {
    if (e.kind === 'name' && e.decl.kind === 'const' && composite(e.type)) {
      const name = `c_${encodeName(e.decl.name)}`;
      if (!this.globalsDone.has(e.decl)) {
        this.globalsDone.add(e.decl);
        this.consts.push(`const ${name} = ${this.literal(e.decl.value, e.decl.type)};`);
      }
      return retain ? `cp(${name})` : name;
    }
    if (e.value !== undefined && e.type.kind !== 'ref' && e.type.kind !== 'ptr') return this.literal(e.value, e.type);
    switch (e.kind) {
      case 'literal':
        return this.literal(e.value as ConstValue, e.type);
      case 'name': {
        const d = e.decl;
        if (d.kind === 'override') return this.override(d);
        if (d.kind === 'const') return this.literal(d.value, d.type);
        if (d.kind === 'var') throw unsupported(`'${d.name}' used as a value`);
        return this.localName(d as IRLocal);
      }
      case 'load':
        return this.load(this.ref(e.ref, false), retain);
      case 'construct':
        return this.construct(e.type, e.args);
      case 'convert':
        return this.convert(e.arg, e.type);
      case 'bitcast':
        return this.bitcast(e.arg, e.type);
      case 'call': {
        const args = e.fn.params.map((p, i) => {
          const a = e.args[i];
          if (p.type.kind === 'ptr') return this.pointerValue(this.pointer(a, true));
          if (p.type.kind === 'texture' || p.type.kind === 'sampler') return this.handle(a);
          return this.value(a, true);
        });
        const call = `${this.fname(e.fn)}($${args.map((a) => `, ${a}`).join('')})`;
        return this.isGenerator(e.fn) ? `(yield* ${call})` : call;
      }
      case 'builtin':
        return this.builtin(e.name, e.args, e.type);
      case 'member':
        return `${this.value(e.object, false)}[${e.index}]`;
      case 'swizzle': {
        const o = this.value(e.object, false);
        if (e.components.length === 1) return `${o}[${e.components[0]}]`;
        return `${this.helper(`sw${e.components.join('')}`, () => `function sw${e.components.join('')}(v) { return [${e.components.map((c) => `v[${c}]`).join(', ')}]; }`)}(${o})`;
      }
      case 'index': {
        const t = e.object.type;
        const n =
          t.kind === 'array' ? this.count(t) : String(t.kind === 'matrix' ? t.columns : (t as { size: number }).size);
        const o = this.value(e.object, false);
        if (typeof e.index.value === 'number') return `${o}[${e.index.value}]`;
        const unsigned = kindOf(storeOf(e.index.type) as ScalarType) === 'u';
        return `${o}[${unsigned ? 'ux' : 'ix'}(${this.value(e.index, false)}, ${n})]`;
      }
      case 'unary':
        return this.unary(e.op, e.operand, e.type);
      case 'binary':
        return this.binary(e.op, this.value(e.left, false), storeOf(e.left.type), e.right, e.type);
      case 'address-of':
      case 'deref':
        throw unsupported('a pointer used as a value');
    }
  }

  private handle(e: IRExpr): string {
    if (e.kind === 'name') {
      if (e.decl.kind === 'var') return this.global(e.decl);
      if (e.decl.kind === 'param') return this.localName(e.decl);
    }
    throw unsupported('a texture or sampler that is not a module-scope variable');
  }

  private construct(t: Type, args: readonly IRExpr[]): string {
    if (!args.length) return this.zero(t);
    if (t.kind === 'vector') {
      if (args.length === 1 && storeOf(args[0].type).kind !== 'vector') {
        const fn = this.helper(
          `splat${t.size}`,
          () => `function splat${t.size}(x) { return [${Array(t.size).fill('x').join(', ')}]; }`,
        );
        return `${fn}(${this.value(args[0], false)})`;
      }
      return `[${args.map((a) => (storeOf(a.type).kind === 'vector' ? `...${this.value(a, false)}` : this.value(a, false))).join(', ')}]`;
    }
    if (t.kind === 'matrix') {
      if (args.length === t.columns) return `[${args.map((a) => this.value(a, true)).join(', ')}]`;
      const flat = args.map((a) => this.value(a, false));
      return `[${Array.from({ length: t.columns }, (_, c) => `[${flat.slice(c * t.rows, (c + 1) * t.rows).join(', ')}]`).join(', ')}]`;
    }
    return `[${args.map((a) => this.value(a, true)).join(', ')}]`;
  }

  /** A scalar conversion expression from kind `a` to kind `b`. */
  private scalarConvert(code: string, a: Kind, b: Kind): string {
    if (a === b) return code;
    if (b === 'b') return `(${code} !== 0)`;
    if (a === 'b') return `(${code} ? 1 : 0)`;
    if (a === 'f') return b === 'i' ? `f2i(${code})` : `f2u(${code})`;
    if (b === 'f') return `fr(${code})`;
    return b === 'u' ? `(${code} >>> 0)` : `(${code} | 0)`;
  }

  /** `f(x)` mapped over a vector's components (or applied to a scalar). */
  private mapped(key: string, n: number, f: (x: string) => string, code: string): string {
    if (!n) return f(code);
    const name = this.helper(
      `m_${key}_${n}`,
      () => `function m_${key}_${n}(v) { return [${Array.from({ length: n }, (_, i) => f(`v[${i}]`)).join(', ')}]; }`,
    );
    return `${name}(${code})`;
  }

  private convert(arg: IRExpr, to: Type): string {
    const from = storeOf(arg.type);
    const a = kindOf(elementOf(from) as ScalarType),
      b = kindOf(elementOf(to) as ScalarType);
    const code = this.value(arg, a === b);
    if (a === b) return code;
    if (to.kind === 'matrix') return code;
    return this.mapped(`cv${a}${b}`, to.kind === 'vector' ? to.size : 0, (x) => this.scalarConvert(x, a, b), code);
  }

  private bitcast(arg: IRExpr, to: Type): string {
    const from = storeOf(arg.type),
      fs = elementOf(from) as ScalarType,
      ts = elementOf(to) as ScalarType;
    const fn = from.kind === 'vector' ? from.size : 1,
      tn = to.kind === 'vector' ? to.size : 1;
    const code = this.value(arg, false);
    if (fs.name === 'f16' || ts.name === 'f16') {
      const toBits = (c: string) => (kindOf(ts) === 'i' ? `(${c} | 0)` : kindOf(ts) === 'f' ? `buf(${c})` : c);
      if (fs.name === 'f16' && fn === 2 * tn) {
        const parts = Array.from({ length: tn }, (_, i) => toBits(`p2x16f([v[${2 * i}], v[${2 * i + 1}]])`));
        return `${this.helper(`bh${fn}${kindOf(ts)}`, () => `function bh${fn}${kindOf(ts)}(v) { return ${tn === 1 ? parts[0] : `[${parts.join(', ')}]`}; }`)}(${code})`;
      }
      if (ts.name === 'f16' && tn === 2 * fn) {
        const bits = (c: string) => (kindOf(fs) === 'f' ? `bfu(${c})` : `(${c} >>> 0)`);
        const parts = Array.from({ length: fn }, (_, i) => `...u2x16f(${bits(fn === 1 ? 'v' : `v[${i}]`)})`);
        return `${this.helper(`hb${tn}${kindOf(fs)}`, () => `function hb${tn}${kindOf(fs)}(v) { return [${parts.join(', ')}]; }`)}(${code})`;
      }
      throw unsupported('this f16 bitcast');
    }
    const a = kindOf(fs),
      b = kindOf(ts);
    if (a === b) return code;
    const f = (x: string) =>
      a === 'f'
        ? b === 'u'
          ? `bfu(${x})`
          : `bfi(${x})`
        : b === 'f'
          ? a === 'u'
            ? `buf(${x})`
            : `bif(${x})`
          : b === 'u'
            ? `(${x} >>> 0)`
            : `(${x} | 0)`;
    return this.mapped(`bc${a}${b}`, tn === 1 ? 0 : tn, f, code);
  }

  private unary(op: string, operand: IRExpr, t: Type): string {
    const k = kindOf(elementOf(t) as ScalarType),
      code = this.value(operand, false);
    const n = t.kind === 'vector' ? t.size : 0;
    if (t.kind === 'matrix')
      return `${this.helper(`mneg${t.columns}${t.rows}`, () => `function mneg${t.columns}${t.rows}(m) { return m.map((c) => c.map((x) => -x)); }`)}(${code})`;
    const f =
      op === '!'
        ? (x: string) => `!${x}`
        : op === '~'
          ? (x: string) => (k === 'u' ? `(~${x} >>> 0)` : `(~${x})`)
          : (x: string) => (k === 'i' ? `(-${x} | 0)` : `(-${x})`);
    return this.mapped(`un${op === '!' ? 'not' : op === '~' ? 'inv' : 'neg'}${k}`, n, f, code);
  }

  /** One scalar operation with WGSL's semantics. */
  private scalarOp(op: string, k: Kind, a: string, b: string): string {
    const cmp: Record<string, string> = { '==': '===', '!=': '!==', '<': '<', '>': '>', '<=': '<=', '>=': '>=' };
    if (op in cmp) return `(${a} ${cmp[op]} ${b})`;
    if (k === 'b') return op === '&&' || op === '||' ? `(${a} ${op} ${b})` : `((${a} ${op} ${b}) !== 0)`;
    if (k === 'f') return `fr(${a} ${op} ${b})`;
    if (k === 'i')
      switch (op) {
        case '+':
        case '-':
          return `((${a} ${op} ${b}) | 0)`;
        case '*':
          return `Math.imul(${a}, ${b})`;
        case '/':
          return `divi(${a}, ${b})`;
        case '%':
          return `modi(${a}, ${b})`;
        default:
          return `(${a} ${op} ${b})`;
      }
    switch (op) {
      case '*':
        return `(Math.imul(${a}, ${b}) >>> 0)`;
      case '/':
        return `divu(${a}, ${b})`;
      case '%':
        return `modu(${a}, ${b})`;
      case '>>':
        return `(${a} >>> ${b})`;
      default:
        return `((${a} ${op} ${b}) >>> 0)`;
    }
  }

  /** `left op right` (left already emitted as `l`), with WGSL's semantics for every shape. */
  private binary(op: string, l: string, lt: Type, right: IRExpr, result: Type): string {
    const rt = storeOf(right.type);
    const r = this.value(right, false);
    const k = kindOf(elementOf(lt) as ScalarType);
    if (op === '&&' || op === '||') return `(${l} ${op} ${r})`;
    if (lt.kind === 'matrix' || rt.kind === 'matrix') return this.matrix(op, l, lt, r, rt);
    const ln = lt.kind === 'vector' ? lt.size : 0,
      rn = rt.kind === 'vector' ? rt.size : 0;
    if (!ln && !rn) return this.scalarOp(op, k, l, r);
    const n = ln || rn;
    const opName = {
      '+': 'add',
      '-': 'sub',
      '*': 'mul',
      '/': 'div',
      '%': 'mod',
      '&': 'and',
      '|': 'or',
      '^': 'xor',
      '<<': 'shl',
      '>>': 'shr',
      '==': 'eq',
      '!=': 'ne',
      '<': 'lt',
      '>': 'gt',
      '<=': 'le',
      '>=': 'ge',
    }[op];
    const name = `v_${opName}${k}${n}${ln ? 'v' : 's'}${rn ? 'v' : 's'}`;
    this.helper(
      name,
      () =>
        `function ${name}(a, b) { return [${Array.from({ length: n }, (_, i) => this.scalarOp(op, k, ln ? `a[${i}]` : 'a', rn ? `b[${i}]` : 'b')).join(', ')}]; }`,
    );
    return `${name}(${l}, ${r})`;
  }

  private matrix(op: string, l: string, lt: Type, r: string, rt: Type): string {
    const sum = (terms: string[]) => terms.reduce((acc, t) => `fr(${acc} + ${t})`);
    if (lt.kind === 'matrix' && rt.kind === 'matrix' && (op === '+' || op === '-'))
      return `${this.helper(`m${op === '+' ? 'add' : 'sub'}`, () => `function m${op === '+' ? 'add' : 'sub'}(a, b) { return a.map((c, i) => c.map((x, j) => fr(x ${op} b[i][j]))); }`)}(${l}, ${r})`;
    if (op !== '*') throw unsupported(`the matrix operator ${op}`);
    if (lt.kind === 'matrix' && rt.kind === 'scalar')
      return `${this.helper('mscale', () => 'function mscale(m, s) { return m.map((c) => c.map((x) => fr(x * s))); }')}(${l}, ${r})`;
    if (lt.kind === 'scalar' && rt.kind === 'matrix')
      return `${this.helper('mscale', () => 'function mscale(m, s) { return m.map((c) => c.map((x) => fr(x * s))); }')}(${r}, ${l})`;
    if (lt.kind === 'matrix' && rt.kind === 'vector') {
      const name = `mv${lt.columns}${lt.rows}`;
      this.helper(
        name,
        () =>
          `function ${name}(m, v) { return [${Array.from({ length: lt.rows }, (_, i) => sum(Array.from({ length: lt.columns }, (_, c) => `fr(m[${c}][${i}] * v[${c}])`))).join(', ')}]; }`,
      );
      return `${name}(${l}, ${r})`;
    }
    if (lt.kind === 'vector' && rt.kind === 'matrix') {
      const name = `vm${rt.columns}${rt.rows}`;
      this.helper(
        name,
        () =>
          `function ${name}(v, m) { return [${Array.from({ length: rt.columns }, (_, c) => sum(Array.from({ length: rt.rows }, (_, i) => `fr(v[${i}] * m[${c}][${i}])`))).join(', ')}]; }`,
      );
      return `${name}(${l}, ${r})`;
    }
    if (lt.kind === 'matrix' && rt.kind === 'matrix') {
      const mv = `mv${lt.columns}${lt.rows}`;
      this.helper(
        mv,
        () =>
          `function ${mv}(m, v) { return [${Array.from({ length: lt.rows }, (_, i) => sum(Array.from({ length: lt.columns }, (_, c) => `fr(m[${c}][${i}] * v[${c}])`))).join(', ')}]; }`,
      );
      const name = `mm${lt.columns}${lt.rows}`;
      this.helper(name, () => `function ${name}(a, b) { return b.map((c) => ${mv}(a, c)); }`);
      return `${name}(${l}, ${r})`;
    }
    throw unsupported(`the matrix operation ${lt.kind} ${op} ${rt.kind}`);
  }

  // ---------------------------------------------------------------- built-in functions

  private builtin(name: string, args: readonly IRExpr[], result: Type): string {
    if (name.startsWith('texture') && name !== 'textureBarrier') return this.texture(name, args, result);
    if (BARRIERS.has(name)) {
      if (name === 'workgroupUniformLoad') return `((yield 0), ${this.load(this.pointer(args[0], false), true)})`;
      return '(yield 0)';
    }
    if (name.startsWith('atomic')) return this.atomic(name, args);
    if (name === 'arrayLength') {
      const r = this.pointer(args[0], false);
      if (r.k !== 'mem') throw unsupported('arrayLength() of something that is not a storage buffer');
      const t = r.type as ArrayType;
      return `((${r.b}.bytes.length - (${r.off})) / ${strideOf(t)} >>> 0)`;
    }
    const t0 = args[0] ? storeOf(args[0].type) : result;
    const n = t0.kind === 'vector' ? t0.size : 0;
    const k = kindOf((elementOf(t0) ?? elementOf(result)) as ScalarType);
    const a = args.map((x) => (x.type.kind === 'texture' || x.type.kind === 'sampler' ? '' : this.value(x, false)));
    // Component-wise functions of one, two or three arguments; scalar arguments of vector calls are splat.
    const each = (key: string, f: (...x: string[]) => string): string => {
      const shapes = args.map((x) => storeOf(x.type).kind === 'vector');
      const count = Math.max(n, ...args.map((x) => (storeOf(x.type) as { size?: number }).size ?? 0));
      if (!count || storeOf(result).kind !== 'vector') return f(...a);
      const fname = this.helper(`e_${key}_${count}_${shapes.map((s) => (s ? 'v' : 's')).join('')}`, () => {
        const params = a.map((_, i) => `a${i}`);
        const comps = Array.from({ length: count }, (_, c) =>
          f(...params.map((p, i) => (shapes[i] ? `${p}[${c}]` : p))),
        );
        return `function e_${key}_${count}_${shapes.map((s) => (s ? 'v' : 's')).join('')}(${params.join(', ')}) { return [${comps.join(', ')}]; }`;
      });
      return `${fname}(${a.join(', ')})`;
    };
    const m1 = (fn: string) => each(name, (x) => `fr(Math.${fn}(${x}))`);
    switch (name) {
      case 'abs':
        return each(`abs${k}`, (x) => (k === 'f' ? `Math.abs(${x})` : k === 'u' ? x : `(Math.abs(${x}) | 0)`));
      case 'acos':
      case 'acosh':
      case 'asin':
      case 'asinh':
      case 'atan':
      case 'atanh':
      case 'cos':
      case 'cosh':
      case 'exp':
      case 'exp2':
      case 'log':
      case 'log2':
      case 'sin':
      case 'sinh':
      case 'sqrt':
      case 'tan':
      case 'tanh':
        return name === 'exp2' ? each(name, (x) => `fr(2 ** ${x})`) : m1(name);
      case 'ceil':
      case 'floor':
      case 'trunc':
        return each(name, (x) => `Math.${name}(${x})`);
      case 'round':
        return each(name, (x) => `(Math.abs(${x} % 1) === 0.5 ? 2 * Math.round(${x} / 2) : Math.round(${x}))`);
      case 'fract':
        return each(name, (x) => `fr(${x} - Math.floor(${x}))`);
      case 'sign':
        return each(`sign${k}`, (x) => (k === 'f' ? `sign(${x})` : `isign(${x})`));
      case 'saturate':
        return each(name, (x) => `fclamp(${x}, 0, 1)`);
      case 'degrees':
        return each(name, (x) => `fr(${x} * 57.29577951308232)`);
      case 'radians':
        return each(name, (x) => `fr(${x} * 0.017453292519943295)`);
      case 'inverseSqrt':
        return each(name, (x) => `inv(${x})`);
      case 'quantizeToF16':
        return each(name, (x) => `q16(${x})`);
      case 'min':
      case 'max':
        return each(`${name}${k}`, (x, y) => `Math.${name}(${x}, ${y})`);
      case 'clamp':
        return each(`clamp${k}`, (x, lo, hi) => `Math.min(Math.max(${x}, ${lo}), ${hi})`);
      case 'atan2':
        return each(name, (y, x) => `fr(Math.atan2(${y}, ${x}))`);
      case 'pow':
        return each(name, (x, y) => `fr(${x} ** ${y})`);
      case 'step':
        return each(name, (edge, x) => `(${edge} <= ${x} ? 1 : 0)`);
      case 'fma':
        return each(name, (x, y, z) => `fr(${x} * ${y} + ${z})`);
      case 'mix':
        return each(name, (x, y, t) => `fr(${x} * (1 - ${t}) + ${y} * ${t})`);
      case 'smoothstep':
        return each(name, (e0, e1, x) => `smooth(${e0}, ${e1}, ${x})`);
      case 'ldexp':
        return each(name, (x, e) => `ldexp(${x}, ${e})`);
      case 'countOneBits':
        return each(`${name}${k}`, (x) => (k === 'i' ? `cob(${x})` : `cob(${x})`));
      case 'reverseBits':
        return each(`${name}${k}`, (x) => (k === 'i' ? `(rev(${x}) | 0)` : `rev(${x})`));
      case 'countLeadingZeros':
        return each(name, (x) => `clz(${x})`);
      case 'countTrailingZeros':
        return each(name, (x) => `ctz(${x})`);
      case 'firstLeadingBit':
        return each(`${name}${k}`, (x) => (k === 'i' ? `flbi(${x})` : `flbu(${x})`));
      case 'firstTrailingBit':
        return each(`${name}${k}`, (x) => (k === 'i' ? `ftb(${x})` : `(ftb(${x}) >>> 0)`));
      case 'extractBits':
        return each(`${name}${k}`, (x, o, c) => (k === 'i' ? `exti(${x}, ${o}, ${c})` : `extu(${x}, ${o}, ${c})`));
      case 'insertBits':
        return each(`${name}${k}`, (x, y, o, c) =>
          k === 'i' ? `(ins(${x}, ${y}, ${o}, ${c}) | 0)` : `ins(${x}, ${y}, ${o}, ${c})`,
        );
      case 'select': {
        const cond = storeOf(args[2].type);
        if (cond.kind !== 'vector') return `(${a[2]} ? ${a[1]} : ${a[0]})`;
        return each('select', (f, t, c) => `(${c} ? ${t} : ${f})`);
      }
      case 'all':
        return n ? `${a[0]}.every((x) => x)` : a[0];
      case 'any':
        return n ? `${a[0]}.some((x) => x)` : a[0];
      case 'dot':
        return `${this.helper(`dot${k}${n}`, () => `function dot${k}${n}(a, b) { return ${Array.from({ length: n }, (_, i) => (k === 'f' ? `fr(a[${i}] * b[${i}])` : `Math.imul(a[${i}], b[${i}])`)).reduce((s, x) => (k === 'f' ? `fr(${s} + ${x})` : k === 'u' ? `((${s} + ${x}) >>> 0)` : `((${s} + ${x}) | 0)`))}; }`)}(${a[0]}, ${a[1]})`;
      case 'length':
        return n ? `fr(Math.hypot(...${a[0]}))` : `Math.abs(${a[0]})`;
      case 'distance':
        return n ? `fr(Math.hypot(...${a[0]}.map((x, i) => x - ${a[1]}[i])))` : `fr(Math.abs(${a[0]} - ${a[1]}))`;
      case 'normalize':
        return `${this.helper('normalize', () => 'function normalize(v) { const l = Math.hypot(...v); return v.map((x) => fr(x / l)); }')}(${a[0]})`;
      case 'cross':
        return `${this.helper('cross', () => 'function cross(a, b) { return [fr(a[1] * b[2] - a[2] * b[1]), fr(a[2] * b[0] - a[0] * b[2]), fr(a[0] * b[1] - a[1] * b[0])]; }')}(${a[0]}, ${a[1]})`;
      case 'reflect':
        return n
          ? `${this.helper('reflect', () => 'function reflect(e, n) { const d = 2 * e.reduce((s, x, i) => s + x * n[i], 0); return e.map((x, i) => fr(x - d * n[i])); }')}(${a[0]}, ${a[1]})`
          : `fr(${a[0]} - 2 * ${a[0]} * ${a[1]} * ${a[1]})`;
      case 'refract':
        return `${this.helper('refract', () => 'function refract(e, n, r) { const d = e.reduce((s, x, i) => s + x * n[i], 0); const k = 1 - r * r * (1 - d * d); return k < 0 ? e.map(() => 0) : e.map((x, i) => fr(r * x - (r * d + Math.sqrt(k)) * n[i])); }')}(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'faceForward':
        return `${this.helper('faceForward', () => 'function faceForward(e1, e2, e3) { return e2.reduce((s, x, i) => s + x * e3[i], 0) < 0 ? e1.slice() : e1.map((x) => -x); }')}(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'determinant':
        return `${this.helper('det', () => 'function det(m) { const n = m.length; if (n === 2) return fr(m[0][0] * m[1][1] - m[1][0] * m[0][1]); if (n === 3) return fr(m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2]) - m[1][0] * (m[0][1] * m[2][2] - m[2][1] * m[0][2]) + m[2][0] * (m[0][1] * m[1][2] - m[1][1] * m[0][2])); let s = 0; for (let c = 0; c < 4; c++) { const sub = m.filter((_, i) => i !== c).map((col) => col.slice(1)); s += (c % 2 ? -1 : 1) * m[c][0] * det(sub); } return fr(s); }')}(${a[0]})`;
      case 'transpose':
        return `${a[0]}[0].map((_, i) => ${a[0]}.map((c) => c[i]))`;
      case 'modf':
        return n
          ? `((v) => [v.map((x) => fr(x - Math.trunc(x))), v.map(Math.trunc)])(${a[0]})`
          : `((x) => [fr(x - Math.trunc(x)), Math.trunc(x)])(${a[0]})`;
      case 'frexp':
        return n
          ? `((v) => { const r = v.map(frexp); return [r.map((x) => x[0]), r.map((x) => x[1])]; })(${a[0]})`
          : `frexp(${a[0]})`;
      case 'pack4x8unorm':
        return `p4x8u(${a[0]})`;
      case 'pack4x8snorm':
        return `p4x8s(${a[0]})`;
      case 'pack2x16unorm':
        return `p2x16u(${a[0]})`;
      case 'pack2x16snorm':
        return `p2x16s(${a[0]})`;
      case 'pack2x16float':
        return `p2x16f(${a[0]})`;
      case 'unpack4x8unorm':
        return `u4x8u(${a[0]})`;
      case 'unpack4x8snorm':
        return `u4x8s(${a[0]})`;
      case 'unpack2x16unorm':
        return `u2x16u(${a[0]})`;
      case 'unpack2x16snorm':
        return `u2x16s(${a[0]})`;
      case 'unpack2x16float':
        return `u2x16f(${a[0]})`;
      case 'pack4xI8':
        return `p4i8(${a[0]})`;
      case 'pack4xU8':
        return `p4u8(${a[0]})`;
      case 'pack4xI8Clamp':
        return `p4i8c(${a[0]})`;
      case 'pack4xU8Clamp':
        return `p4u8c(${a[0]})`;
      case 'unpack4xI8':
        return `u4i8(${a[0]})`;
      case 'unpack4xU8':
        return `u4u8(${a[0]})`;
      case 'dot4U8Packed':
        return `d4u8(${a[0]}, ${a[1]})`;
      case 'dot4I8Packed':
        return `d4i8(${a[0]}, ${a[1]})`;
    }
    throw unsupported(`the built-in ${name}()`);
  }

  private atomic(name: string, args: readonly IRExpr[]): string {
    const r = this.pointer(args[0], true);
    const t = storeOf(r.type);
    const k = kindOf((t.kind === 'atomic' ? t.element : t) as ScalarType);
    const v = args[1] ? this.value(args[1], false) : '';
    if (name === 'atomicLoad') return this.load(r, false);
    if (name === 'atomicStore') {
      this.store(r, v);
      return 'undefined';
    }
    const wrap = (x: string) => (k === 'u' ? `(${x} >>> 0)` : `(${x} | 0)`);
    const f: Record<string, (a: string) => string> = {
      atomicAdd: (a) => wrap(`${a} + ${v}`),
      atomicSub: (a) => wrap(`${a} - ${v}`),
      atomicMax: (a) => `Math.max(${a}, ${v})`,
      atomicMin: (a) => `Math.min(${a}, ${v})`,
      atomicAnd: (a) => wrap(`${a} & ${v}`),
      atomicOr: (a) => wrap(`${a} | ${v}`),
      atomicXor: (a) => wrap(`${a} ^ ${v}`),
      atomicExchange: () => v,
    };
    if (name === 'atomicCompareExchangeWeak') {
      const cmp = v,
        nv = this.value(args[2], false),
        old = this.temp();
      this.line(`const ${old} = ${this.load(r, false)};`);
      this.line(`if (${old} === ${cmp}) {`);
      this.depth++;
      this.store(r, nv);
      this.depth--;
      this.line('}');
      return `[${old}, ${old} === ${cmp}]`;
    }
    const op = f[name];
    if (!op) throw unsupported(`${name}()`);
    if (r.k === 'mem') return `mrmw(${r.b}, ${r.off}, ${k === 'i'}, (_a) => ${op('_a')})`;
    return `rmw(${this.pointerValue(r)}, (_a) => ${op('_a')})`;
  }

  private texture(name: string, args: readonly IRExpr[], result: Type): string {
    const tex = this.handle(args[0]),
      tt = args[0].type as TextureType;
    const v = (e: IRExpr | undefined) => (e ? this.value(e, false) : '0');
    const arrayed = tt.dimension === '2d_array';
    if (
      tt.dimension === 'cube' ||
      tt.dimension === 'cube_array' ||
      tt.shape === 'external' ||
      tt.shape === 'multisampled' ||
      tt.shape === 'depth_multisampled'
    )
      throw unsupported(
        `${name}() on a ${tt.shape === 'sampled' || tt.shape === 'depth' ? tt.dimension : tt.shape} texture`,
      );
    switch (name) {
      case 'textureDimensions': {
        const d = `td(${tex}, ${v(args[1])})`;
        return tt.dimension === '1d' ? `${d}[0]` : d;
      }
      case 'textureNumLayers':
        return `${tex}.layers`;
      case 'textureNumLevels':
        return `${tex}.levels`;
      case 'textureLoad': {
        const layer = arrayed ? v(args[2]) : '0';
        const level = tt.shape === 'storage' ? '0' : v(args[arrayed ? 3 : 2]);
        const call = `tl(${tex}, ${v(args[1])}, ${layer}, ${level})`;
        const s = elementOf(storeOf(result)) as ScalarType;
        return tt.shape === 'depth' ? `${call}[0]` : kindOf(s) === 'f' ? call : call;
      }
      case 'textureSampleLevel': {
        const sampler = this.handle(args[1]);
        const layer = arrayed ? v(args[3]) : '0';
        const level = v(args[arrayed ? 4 : 3]);
        const offset = args[arrayed ? 5 : 4];
        const call = `tsl(${tex}, ${sampler}, ${v(args[2])}, ${layer}, ${level}${offset ? `, ${v(offset)}` : ''})`;
        return tt.shape === 'depth' ? `${call}[0]` : call;
      }
      case 'textureStore': {
        const layer = arrayed ? v(args[2]) : '0';
        this.line(`ts(${tex}, ${v(args[1])}, ${layer}, ${v(args[arrayed ? 3 : 2])});`);
        return 'undefined';
      }
    }
    throw unsupported(`${name}()`);
  }
}
