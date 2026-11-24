// The CPU tier without run-time code: a page whose Content-Security-Policy forbids `new Function` (no 'unsafe-eval') still
// runs compute. The JavaScript js.ts generates is the single statement of what a kernel does, so this runs that text
// instead of a second translation of the IR: a parser for the part of the language js.ts writes, and a compiler from its
// syntax tree to closures. Barrier kernels are generators there; here the statements on a path to a `yield` run as
// generators and everything else as plain closures. Written clean room from the ECMAScript specification.
import { fault } from '../../../shared/errors.js';
import type { CPUBindings, H, KernelModule } from './cpu.js';

// biome-ignore lint/suspicious/noExplicitAny: a value of the kernel's JavaScript, whose types only that text states.
type Value = any;
type Node = Value;
/** A call's variables: slot 0 the enclosing frame, slot 1 the return value, then the parameters and locals. */
type Frame = Value[];
type Expr = (f: Frame) => Value;
/** Runs a statement: 0 to go on, RETURN, or a jump code. */
type Stmt = (f: Frame) => number;
type GenExpr = (f: Frame) => Generator<unknown, Value, unknown>;
type GenStmt = (f: Frame) => Generator<unknown, number, unknown>;

const bug = (what: string): Error =>
  fault('failed', `The CPU tier's interpreter met ${what} (a bug: report it)`, 'compatibility-layer');

// ---------------------------------------------------------------- tokens

const PUNCTUATION = new Set(
  '>>>= ... === !== **= <<= >>= >>> => == != <= >= && || ++ -- += -= *= /= %= |= &= ^= << >> ** { } ( ) [ ] ; , ? : . + - * / % < > = ! ~ & | ^'.split(
    ' ',
  ),
);
const isStart = (c: string) => /[A-Za-z_$]/.test(c);
const isPart = (c: string) => /[\w$]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

interface Token {
  /** 'id', 'num', 'str', 'p' (punctuation) or 'end'. */
  readonly t: string;
  readonly v: Value;
}

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') i++;
    else if (c === '/' && s[i + 1] === '/') while (i < s.length && s[i] !== '\n') i++;
    else if (isStart(c)) {
      const start = i;
      while (i < s.length && isPart(s[i])) i++;
      out.push({ t: 'id', v: s.slice(start, i) });
    } else if (isDigit(c) || (c === '.' && isDigit(s[i + 1]))) {
      const start = i;
      if (c === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X')) {
        i += 2;
        while (i < s.length && /[0-9a-fA-F]/.test(s[i])) i++;
      } else {
        while (isDigit(s[i]) || s[i] === '.') i++;
        if (s[i] === 'e' || s[i] === 'E') {
          i++;
          if (s[i] === '+' || s[i] === '-') i++;
          while (isDigit(s[i])) i++;
        }
      }
      out.push({ t: 'num', v: Number(s.slice(start, i)) });
    } else if (c === "'" || c === '"') {
      let text = '';
      for (i++; s[i] !== c; i++) {
        if (i >= s.length) throw bug('an unterminated string');
        if (s[i] === '\\') i++;
        text += s[i];
      }
      i++;
      out.push({ t: 'str', v: text });
    } else {
      let length = 4;
      while (length > 0 && !PUNCTUATION.has(s.slice(i, i + length))) length--;
      if (!length) throw bug(`the character '${c}'`);
      out.push({ t: 'p', v: s.slice(i, i + length) });
      i += length;
    }
  }
  out.push({ t: 'end', v: '' });
  return out;
}

// ---------------------------------------------------------------- parser

const BINARY: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '===': 6,
  '!==': 6,
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '>>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
  '**': 11,
};
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '<<=', '>>=', '>>>=', '**=']);

class Parser {
  private at = 0;
  constructor(private readonly tokens: Token[]) {}

  private get token(): Token {
    return this.tokens[this.at];
  }
  private is(v: string): boolean {
    const t = this.token;
    return (t.t === 'p' || t.t === 'id') && t.v === v;
  }
  private eat(v: string): boolean {
    if (!this.is(v)) return false;
    this.at++;
    return true;
  }
  private need(v: string): void {
    if (!this.eat(v)) throw bug(`'${this.token.v}' where '${v}' goes`);
  }
  private name(): string {
    const t = this.token;
    if (t.t !== 'id') throw bug(`'${t.v}' where a name goes`);
    this.at++;
    return t.v;
  }

  program(): Node[] {
    const body: Node[] = [];
    while (this.token.t !== 'end') body.push(this.statement());
    return body;
  }

  private block(): Node {
    this.need('{');
    const body: Node[] = [];
    while (!this.eat('}')) body.push(this.statement());
    return { k: 'block', body };
  }

  private declaration(): Node {
    const list: Node[] = [];
    do {
      if (this.eat('{')) {
        const names: string[] = [];
        while (!this.eat('}')) {
          names.push(this.name());
          this.eat(',');
        }
        this.need('=');
        list.push({ names, init: this.assignment() });
      } else {
        const name = this.name();
        list.push({ name, init: this.eat('=') ? this.assignment() : null });
      }
    } while (this.eat(','));
    return { k: 'decl', list };
  }

  private func(): Node {
    const generator = this.eat('*'),
      name = this.name();
    return { k: 'func', name, generator, params: this.params(), body: this.block() };
  }

  private params(): string[] {
    const params: string[] = [];
    this.need('(');
    while (!this.eat(')')) {
      params.push(this.name());
      this.eat(',');
    }
    return params;
  }

  private statement(): Node {
    const t = this.token;
    if (t.t === 'p') {
      if (t.v === '{') return this.block();
      if (this.eat(';')) return { k: 'block', body: [] };
    } else if (t.t === 'id') {
      switch (t.v) {
        case 'const':
        case 'let': {
          this.at++;
          const d = this.declaration();
          this.need(';');
          return d;
        }
        case 'function':
          this.at++;
          return this.func();
        case 'if': {
          this.at++;
          this.need('(');
          const test = this.expression();
          this.need(')');
          const then = this.statement();
          return { k: 'if', test, then, else: this.eat('else') ? this.statement() : null };
        }
        case 'for': {
          this.at++;
          this.need('(');
          let init: Node = null;
          if (!this.is(';'))
            init = this.eat('let') || this.eat('const') ? this.declaration() : { k: 'expr', e: this.expression() };
          this.need(';');
          const test = this.is(';') ? null : this.expression();
          this.need(';');
          const update = this.is(')') ? null : this.expression();
          this.need(')');
          return { k: 'for', init, test, update, body: this.statement() };
        }
        case 'switch': {
          this.at++;
          this.need('(');
          const value = this.expression();
          this.need(')');
          this.need('{');
          const cases: Node[] = [];
          while (!this.eat('}')) {
            const test = this.eat('default') ? null : (this.need('case'), this.expression());
            this.need(':');
            const body: Node[] = [];
            while (!this.is('case') && !this.is('default') && !this.is('}')) body.push(this.statement());
            cases.push({ test, body });
          }
          return { k: 'switch', value, cases };
        }
        case 'break':
        case 'continue': {
          this.at++;
          const label = this.token.t === 'id' ? this.name() : null;
          this.need(';');
          return { k: t.v, label };
        }
        case 'return': {
          this.at++;
          const value = this.is(';') ? null : this.expression();
          this.need(';');
          return { k: 'return', value };
        }
      }
      const next = this.tokens[this.at + 1];
      if (next.t === 'p' && next.v === ':') {
        this.at += 2;
        return { k: 'label', name: t.v, body: this.statement() };
      }
    }
    const e = this.expression();
    this.need(';');
    return { k: 'expr', e };
  }

  private expression(): Node {
    const first = this.assignment();
    if (!this.is(',')) return first;
    const list = [first];
    while (this.eat(',')) list.push(this.assignment());
    return { k: 'seq', list };
  }

  /** True at the `(` of an arrow function's parameters. */
  private arrow(): boolean {
    let depth = 0;
    for (let i = this.at; ; i++) {
      const t = this.tokens[i];
      if (t.t === 'end') return false;
      if (t.t !== 'p') continue;
      if (t.v === '(') depth++;
      else if (t.v === ')' && --depth === 0) {
        const next = this.tokens[i + 1];
        return next.t === 'p' && next.v === '=>';
      }
    }
  }

  private assignment(): Node {
    if (this.is('(') && this.arrow()) {
      const params = this.params();
      this.need('=>');
      return this.is('{') ? { k: 'arrow', params, body: this.block() } : { k: 'arrow', params, value: this.assignment() };
    }
    if (this.is('yield')) {
      this.at++;
      const delegate = this.eat('*');
      return { k: 'yield', delegate, value: this.assignment() };
    }
    const left = this.conditional(),
      t = this.token;
    if (t.t === 'p' && ASSIGN.has(t.v)) {
      this.at++;
      return { k: 'assign', op: t.v, target: left, value: this.assignment() };
    }
    return left;
  }

  private conditional(): Node {
    const test = this.binary(1);
    if (!this.eat('?')) return test;
    const then = this.assignment();
    this.need(':');
    return { k: 'cond', test, then, else: this.assignment() };
  }

  private binary(level: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.token,
        p = t.t === 'p' ? BINARY[t.v] : undefined;
      if (p === undefined || p < level) return left;
      this.at++;
      // ** groups from the right.
      const right = this.binary(t.v === '**' ? p : p + 1);
      left = { k: t.v === '&&' || t.v === '||' ? 'logic' : 'binary', op: t.v, a: left, b: right };
    }
  }

  private unary(): Node {
    const t = this.token;
    if (t.t === 'p') {
      if (t.v === '-' || t.v === '+' || t.v === '!' || t.v === '~') {
        this.at++;
        return { k: 'unary', op: t.v, a: this.unary() };
      }
      if (t.v === '++' || t.v === '--') {
        this.at++;
        return { k: 'update', op: t.v, prefix: true, target: this.unary() };
      }
    }
    const e = this.postfix(),
      n = this.token;
    if (n.t === 'p' && (n.v === '++' || n.v === '--')) {
      this.at++;
      return { k: 'update', op: n.v, prefix: false, target: e };
    }
    return e;
  }

  private items(close: string): Node[] {
    const list: Node[] = [];
    while (!this.eat(close)) {
      list.push(this.eat('...') ? { k: 'spread', e: this.assignment() } : this.assignment());
      this.eat(',');
    }
    return list;
  }

  private postfix(): Node {
    let e = this.primary();
    for (;;) {
      if (this.eat('.')) e = { k: 'member', object: e, name: this.name() };
      else if (this.eat('[')) {
        e = { k: 'index', object: e, index: this.expression() };
        this.need(']');
      } else if (this.eat('(')) e = { k: 'call', callee: e, args: this.items(')') };
      else return e;
    }
  }

  private primary(): Node {
    const t = this.token;
    this.at++;
    if (t.t === 'num' || t.t === 'str') return { k: 'value', v: t.v };
    if (t.t === 'id') {
      if (t.v === 'true') return { k: 'value', v: true };
      if (t.v === 'false') return { k: 'value', v: false };
      return { k: 'name', name: t.v };
    }
    if (t.t === 'p') {
      if (t.v === '(') {
        const e = this.expression();
        this.need(')');
        return e;
      }
      if (t.v === '[') return { k: 'array', items: this.items(']') };
      if (t.v === '{') {
        const props: Node[] = [];
        while (!this.eat('}')) {
          const key = this.name();
          props.push({ key, value: this.eat(':') ? this.assignment() : { k: 'name', name: key } });
          this.eat(',');
        }
        return { k: 'object', props };
      }
    }
    throw bug(`'${t.v}' where an expression goes`);
  }
}

// ---------------------------------------------------------------- closures

const RETURN = 1;
const hasYield = (n: Node): boolean => {
  if (Array.isArray(n)) return n.some(hasYield);
  if (n === null || typeof n !== 'object') return false;
  if (n.k === 'yield') return true;
  if (n.k === 'arrow' || n.k === 'func') return false;
  return Object.values(n).some(hasYield);
};

/** The interpreter's own names: everything else a kernel names, it declares. */
const GLOBALS: Record<string, unknown> = { Math, NaN, Infinity, undefined, Number, Array };

/** A function being compiled, then run: its frame size, statements and whether it is a generator. */
interface Fn {
  size: number;
  body: Stmt;
  gen?: GenStmt;
  params: number;
}
interface Slot {
  readonly slot: number;
  readonly fn: Fn | null;
}
/** One function's compile state; `scopes` are its open blocks, innermost last. */
class Unit {
  readonly scopes: Map<string, Slot>[] = [new Map()];
  /** Open labels and loops, innermost last, each with the codes of its break and continue. */
  readonly targets: { label: string | null; brk: number; cont: number; plain: boolean }[] = [];
  size = 2;
  constructor(readonly parent: Unit | null) {}
  declare(name: string, fn: Fn | null = null): number {
    const slot = this.size++;
    this.scopes[this.scopes.length - 1].set(name, { slot, fn });
    return slot;
  }
}

const up = (depth: number): ((f: Frame) => Frame) =>
  depth === 0
    ? (f) => f
    : depth === 1
      ? (f) => f[0]
      : depth === 2
        ? (f) => f[0][0]
        : (f) => {
            for (let i = 0; i < depth; i++) f = f[0];
            return f;
          };

class Compiler {
  private jumps = RETURN;
  private readonly functions: { slot: number; fn: Fn; name: string }[] = [];

  /** Finds a name: how many frames up and where. */
  private find(unit: Unit, name: string): { depth: number; slot: number; fn: Fn | null } | null {
    let depth = 0;
    for (let u: Unit | null = unit; u; u = u.parent, depth++)
      for (let i = u.scopes.length - 1; i >= 0; i--) {
        const found = u.scopes[i].get(name);
        if (found) return { depth, slot: found.slot, fn: found.fn };
      }
    return null;
  }

  /** Declares a block's names up front, so a function may name what the block declares after it. */
  private hoist(unit: Unit, body: Node[]): void {
    for (const s of body)
      if (s.k === 'decl') {
        for (const d of s.list)
          if (d.names) for (const n of d.names) unit.declare(n);
          else unit.declare(d.name);
      } else if (s.k === 'func') {
        const fn: Fn = { size: 0, body: () => 0, params: s.params.length };
        const slot = unit.declare(s.name, fn);
        if (unit.parent) throw bug('a nested function');
        this.functions.push({ slot, fn, name: s.name });
      }
  }

  // Statements. Each compiled in place; the generator forms mirror them for what reaches a yield.

  private list(unit: Unit, body: Node[]): Stmt {
    const run = body.filter((s) => s.k !== 'func' || this.func(unit, s)).map((s) => this.statement(unit, s));
    if (run.length === 1) return run[0];
    if (run.length === 2) {
      const [a, b] = run;
      return (f) => a(f) || b(f);
    }
    const n = run.length;
    return (f) => {
      for (let i = 0; i < n; i++) {
        const code = run[i](f);
        if (code) return code;
      }
      return 0;
    };
  }

  private genList(unit: Unit, body: Node[]): GenStmt {
    const run = body
      .filter((s) => s.k !== 'func')
      .map((s) => (hasYield(s) ? { gen: this.genStatement(unit, s) } : { plain: this.statement(unit, s) }));
    return function* (f) {
      for (const step of run) {
        const code = step.gen ? yield* step.gen(f) : step.plain!(f);
        if (code) return code;
      }
      return 0;
    };
  }

  /** Compiles a top-level function; false, so the statement list drops it. */
  private func(unit: Unit, s: Node): boolean {
    const found = this.find(unit, s.name) as { fn: Fn };
    const inner = new Unit(unit),
      fn = found.fn;
    for (const p of s.params) inner.declare(p);
    this.hoist(inner, s.body.body);
    if (s.generator) fn.gen = this.genList(inner, s.body.body);
    else fn.body = this.list(inner, s.body.body);
    fn.size = inner.size;
    return false;
  }

  private scoped<T>(unit: Unit, body: Node[], make: () => T): T {
    unit.scopes.push(new Map());
    this.hoist(unit, body);
    const out = make();
    unit.scopes.pop();
    return out;
  }

  private declare(unit: Unit, d: Node): Stmt {
    if (d.names) {
      const from = this.expression(unit, d.init),
        places = d.names.map((n: string) => [n, (this.find(unit, n) as { slot: number }).slot] as const);
      return (f) => {
        const o = from(f);
        for (const [n, slot] of places) f[slot] = o[n];
        return 0;
      };
    }
    const slot = (this.find(unit, d.name) as { slot: number }).slot;
    if (!d.init) return () => 0;
    const value = this.expression(unit, d.init);
    return (f) => {
      f[slot] = value(f);
      return 0;
    };
  }

  /** The code a `break` or `continue` jumps with. */
  private jump(unit: Unit, s: Node): number {
    for (let i = unit.targets.length - 1; i >= 0; i--) {
      const t = unit.targets[i];
      if (s.label === null ? t.plain && (s.k === 'break' || t.cont) : t.label === s.label)
        return s.k === 'break' ? t.brk : t.cont;
    }
    throw bug(`'${s.k} ${s.label ?? ''}' outside its statement`);
  }

  private target(unit: Unit, label: string | null, plain: boolean, loop: boolean) {
    const t = { label, brk: ++this.jumps, cont: loop ? ++this.jumps : 0, plain };
    unit.targets.push(t);
    return t;
  }

  private statement(unit: Unit, s: Node, label: string | null = null): Stmt {
    switch (s.k) {
      case 'block':
        return this.scoped(unit, s.body, () => this.list(unit, s.body));
      case 'decl': {
        const run = s.list.map((d: Node) => this.declare(unit, d));
        return run.length === 1
          ? run[0]
          : (f) => {
              for (const r of run) r(f);
              return 0;
            };
      }
      case 'expr': {
        const e = this.expression(unit, s.e);
        return (f) => {
          e(f);
          return 0;
        };
      }
      case 'if': {
        const test = this.expression(unit, s.test),
          then = this.statement(unit, s.then);
        if (!s.else) return (f) => (test(f) ? then(f) : 0);
        const other = this.statement(unit, s.else);
        return (f) => (test(f) ? then(f) : other(f));
      }
      case 'return': {
        if (!s.value) return () => RETURN;
        const value = this.expression(unit, s.value);
        return (f) => {
          f[1] = value(f);
          return RETURN;
        };
      }
      case 'break':
      case 'continue': {
        const code = this.jump(unit, s);
        return () => code;
      }
      case 'label': {
        if (s.body.k === 'for' || s.body.k === 'switch') return this.statement(unit, s.body, s.name);
        const t = this.target(unit, s.name, false, false),
          body = this.statement(unit, s.body);
        unit.targets.pop();
        return (f) => {
          const code = body(f);
          return code === t.brk ? 0 : code;
        };
      }
      case 'for': {
        const scope = s.init?.k === 'decl' ? [s.init] : [];
        return this.scoped(unit, scope, () => {
          const init = s.init ? this.statement(unit, s.init) : null,
            test = s.test ? this.expression(unit, s.test) : null,
            update = s.update ? this.expression(unit, s.update) : null,
            t = this.target(unit, label, true, true),
            body = this.statement(unit, s.body);
          unit.targets.pop();
          const { brk, cont } = t;
          return (f) => {
            if (init) init(f);
            while (!test || test(f)) {
              const code = body(f);
              if (code && code !== cont) return code === brk ? 0 : code;
              if (update) update(f);
            }
            return 0;
          };
        });
      }
      case 'switch': {
        const value = this.expression(unit, s.value),
          t = this.target(unit, label, true, false),
          all = s.cases.flatMap((c: Node) => c.body);
        const cases = this.scoped(unit, all, () =>
          s.cases.map((c: Node) => ({
            test: c.test ? this.expression(unit, c.test) : null,
            body: this.list(unit, c.body),
          })),
        );
        unit.targets.pop();
        return (f) => {
          const v = value(f);
          let from = cases.findIndex((c: { test: Expr | null }) => c.test && c.test(f) === v);
          if (from < 0) from = cases.findIndex((c: { test: Expr | null }) => !c.test);
          if (from < 0) return 0;
          for (let i = from; i < cases.length; i++) {
            const code = cases[i].body(f);
            if (code) return code === t.brk ? 0 : code;
          }
          return 0;
        };
      }
    }
    throw bug(`the statement '${s.k}'`);
  }

  private genStatement(unit: Unit, s: Node, label: string | null = null): GenStmt {
    const step = (n: Node): GenStmt => {
      if (hasYield(n)) return this.genStatement(unit, n);
      const plain = this.statement(unit, n);
      return function* (f) {
        return plain(f);
      };
    };
    switch (s.k) {
      case 'block':
        return this.scoped(unit, s.body, () => this.genList(unit, s.body));
      case 'decl': {
        const run = s.list.map((d: Node) => {
          if (d.names || !d.init || !hasYield(d.init)) return { plain: this.declare(unit, d) };
          return { slot: (this.find(unit, d.name) as { slot: number }).slot, value: this.genExpression(unit, d.init) };
        });
        return function* (f) {
          for (const r of run)
            if (r.plain) r.plain(f);
            else f[r.slot] = yield* r.value(f);
          return 0;
        };
      }
      case 'expr': {
        const e = this.genExpression(unit, s.e);
        return function* (f) {
          yield* e(f);
          return 0;
        };
      }
      case 'if': {
        const test = this.anyExpression(unit, s.test),
          then = step(s.then),
          other = s.else ? step(s.else) : null;
        return function* (f) {
          if (yield* test(f)) return yield* then(f);
          return other ? yield* other(f) : 0;
        };
      }
      case 'return': {
        const value = this.genExpression(unit, s.value);
        return function* (f) {
          f[1] = yield* value(f);
          return RETURN;
        };
      }
      case 'label': {
        if (s.body.k === 'for' || s.body.k === 'switch') return this.genStatement(unit, s.body, s.name);
        const t = this.target(unit, s.name, false, false),
          body = step(s.body);
        unit.targets.pop();
        return function* (f) {
          const code = yield* body(f);
          return code === t.brk ? 0 : code;
        };
      }
      case 'for': {
        const scope = s.init?.k === 'decl' ? [s.init] : [];
        return this.scoped(unit, scope, () => {
          const init = s.init ? step(s.init) : null,
            test = s.test ? this.anyExpression(unit, s.test) : null,
            update = s.update ? this.anyExpression(unit, s.update) : null,
            t = this.target(unit, label, true, true),
            body = step(s.body);
          unit.targets.pop();
          const { brk, cont } = t;
          return function* (f) {
            if (init) yield* init(f);
            while (!test || (yield* test(f))) {
              const code = yield* body(f);
              if (code && code !== cont) return code === brk ? 0 : code;
              if (update) yield* update(f);
            }
            return 0;
          };
        });
      }
      case 'switch': {
        const value = this.anyExpression(unit, s.value),
          t = this.target(unit, label, true, false),
          all = s.cases.flatMap((c: Node) => c.body);
        const cases = this.scoped(unit, all, () =>
          s.cases.map((c: Node) => ({
            test: c.test ? this.expression(unit, c.test) : null,
            body: this.genList(unit, c.body),
          })),
        );
        unit.targets.pop();
        return function* (f) {
          const v = yield* value(f);
          let from = cases.findIndex((c: { test: Expr | null }) => c.test && c.test(f) === v);
          if (from < 0) from = cases.findIndex((c: { test: Expr | null }) => !c.test);
          if (from < 0) return 0;
          for (let i = from; i < cases.length; i++) {
            const code: number = yield* cases[i].body(f);
            if (code) return code === t.brk ? 0 : code;
          }
          return 0;
        };
      }
    }
    throw bug(`the statement '${s.k}' on the way to a barrier`);
  }

  // Expressions.

  private anyExpression(unit: Unit, e: Node): GenExpr {
    if (hasYield(e)) return this.genExpression(unit, e);
    const plain = this.expression(unit, e);
    return function* (f) {
      return plain(f);
    };
  }

  /**
   * An expression with a yield inside. Its operands up to the last yield are worked out first, in order, into slots of
   * the frame; the node then runs as a plain expression over those slots.
   */
  private genExpression(unit: Unit, e: Node): GenExpr {
    switch (e.k) {
      case 'yield': {
        const value = this.anyExpression(unit, e.value);
        return e.delegate
          ? function* (f) {
              return yield* yield* value(f);
            }
          : function* (f) {
              return yield yield* value(f);
            };
      }
      case 'logic': {
        const a = this.anyExpression(unit, e.a),
          b = this.anyExpression(unit, e.b),
          and = e.op === '&&';
        return function* (f) {
          const left = yield* a(f);
          return and === !!left ? yield* b(f) : left;
        };
      }
      case 'cond': {
        const test = this.anyExpression(unit, e.test),
          then = this.anyExpression(unit, e.then),
          other = this.anyExpression(unit, e.else);
        return function* (f) {
          return (yield* test(f)) ? yield* then(f) : yield* other(f);
        };
      }
    }
    if (!hasYield(e)) return this.anyExpression(unit, e);
    const copy = { ...e },
      holes: [Node, string | number, Node][] = [];
    const hole = (owner: Node, key: string | number) => holes.push([owner, key, owner[key]]);
    switch (e.k) {
      case 'binary':
        hole(copy, 'a');
        hole(copy, 'b');
        break;
      case 'unary':
        hole(copy, 'a');
        break;
      case 'seq':
        copy.list = e.list.slice();
        copy.list.forEach((_: Node, i: number) => hole(copy.list, i));
        break;
      case 'array':
        copy.items = e.items.slice();
        copy.items.forEach((_: Node, i: number) => hole(copy.items, i));
        break;
      case 'member':
        hole(copy, 'object');
        break;
      case 'index':
        hole(copy, 'object');
        hole(copy, 'index');
        break;
      case 'assign':
        hole(copy, 'value');
        break;
      case 'call':
        if (e.callee.k === 'member') {
          copy.callee = { ...e.callee };
          hole(copy.callee, 'object');
        }
        copy.args = e.args.slice();
        copy.args.forEach((_: Node, i: number) => hole(copy.args, i));
        break;
      default:
        throw bug(`a barrier inside '${e.k}'`);
    }
    let last = -1;
    holes.forEach(([, , n], i) => {
      if (hasYield(n)) last = i;
    });
    const steps = holes.slice(0, last + 1).map(([owner, key, n]) => {
      const slot = unit.size++,
        spread = n.k === 'spread';
      owner[key] = spread ? { k: 'spread', e: { k: 'slot', slot } } : { k: 'slot', slot };
      return { slot, value: this.anyExpression(unit, spread ? n.e : n) };
    });
    const finish = this.expression(unit, copy);
    return function* (f) {
      for (const s of steps) f[s.slot] = yield* s.value(f);
      return finish(f);
    };
  }

  private expression(unit: Unit, e: Node): Expr {
    switch (e.k) {
      case 'value': {
        const v = e.v;
        return () => v;
      }
      case 'slot': {
        const slot = e.slot;
        return (f) => f[slot];
      }
      case 'name':
        return this.read(unit, e.name);
      case 'seq': {
        const list = e.list.map((n: Node) => this.expression(unit, n));
        return (f) => {
          let v;
          for (const x of list) v = x(f);
          return v;
        };
      }
      case 'array':
        return this.array(unit, e.items);
      case 'object': {
        const props = e.props.map((p: Node) => [p.key, this.expression(unit, p.value)] as const);
        return (f) => {
          const o: Record<string, unknown> = {};
          for (const [key, value] of props) o[key] = value(f);
          return o;
        };
      }
      case 'arrow':
        return this.arrow(unit, e);
      case 'unary': {
        const a = this.expression(unit, e.a);
        switch (e.op) {
          case '-':
            return (f) => -a(f);
          case '+':
            return (f) => +a(f);
          case '!':
            return (f) => !a(f);
          case '~':
            return (f) => ~a(f);
        }
        break;
      }
      case 'binary':
        return this.binary(e.op, this.expression(unit, e.a), this.expression(unit, e.b));
      case 'logic': {
        const a = this.expression(unit, e.a),
          b = this.expression(unit, e.b);
        return e.op === '&&' ? (f) => a(f) && b(f) : (f) => a(f) || b(f);
      }
      case 'cond': {
        const test = this.expression(unit, e.test),
          then = this.expression(unit, e.then),
          other = this.expression(unit, e.else);
        return (f) => (test(f) ? then(f) : other(f));
      }
      case 'member': {
        const object = this.expression(unit, e.object),
          name = e.name;
        return (f) => object(f)[name];
      }
      case 'index': {
        const object = this.expression(unit, e.object),
          index = this.expression(unit, e.index);
        return (f) => object(f)[index(f)];
      }
      case 'assign':
        return this.assign(unit, e);
      case 'update':
        return this.update(unit, e);
      case 'call':
        return this.call(unit, e);
      case 'yield':
        throw bug('a yield outside a barrier path');
    }
    throw bug(`the expression '${e.k}'`);
  }

  private read(unit: Unit, name: string): Expr {
    const found = this.find(unit, name);
    if (!found) {
      if (!(name in GLOBALS)) throw bug(`the unknown name '${name}'`);
      const v = GLOBALS[name];
      return () => v;
    }
    const { depth, slot } = found;
    return depth === 0
      ? (f) => f[slot]
      : depth === 1
        ? (f) => f[0][slot]
        : depth === 2
          ? (f) => f[0][0][slot]
          : ((frame) => (f: Frame) => frame(f)[slot])(up(depth));
  }

  private array(unit: Unit, items: Node[]): Expr {
    if (items.some((n) => n.k === 'spread')) {
      const list = items.map((n) => ({ spread: n.k === 'spread', value: this.expression(unit, n.k === 'spread' ? n.e : n) }));
      return (f) => {
        const out: unknown[] = [];
        for (const x of list)
          if (x.spread) out.push(...x.value(f));
          else out.push(x.value(f));
        return out;
      };
    }
    const list = items.map((n) => this.expression(unit, n));
    if (list.length === 2) {
      const [a, b] = list;
      return (f) => [a(f), b(f)];
    }
    if (list.length === 3) {
      const [a, b, c] = list;
      return (f) => [a(f), b(f), c(f)];
    }
    if (list.length === 4) {
      const [a, b, c, d] = list;
      return (f) => [a(f), b(f), c(f), d(f)];
    }
    return (f) => list.map((x) => x(f));
  }

  private arrow(unit: Unit, e: Node): Expr {
    const inner = new Unit(unit);
    for (const p of e.params) inner.declare(p);
    const count = e.params.length;
    if (e.value) {
      const value = this.expression(inner, e.value);
      return (f) =>
        (...args: unknown[]) => {
          const n: Frame = new Array(inner.size);
          n[0] = f;
          for (let i = 0; i < count; i++) n[2 + i] = args[i];
          return value(n);
        };
    }
    this.hoist(inner, e.body.body);
    const body = this.list(inner, e.body.body);
    return (f) =>
      (...args: unknown[]) => {
        const n: Frame = new Array(inner.size);
        n[0] = f;
        for (let i = 0; i < count; i++) n[2 + i] = args[i];
        body(n);
        return n[1];
      };
  }

  private binary(op: string, a: Expr, b: Expr): Expr {
    switch (op) {
      case '+':
        return (f) => a(f) + b(f);
      case '-':
        return (f) => a(f) - b(f);
      case '*':
        return (f) => a(f) * b(f);
      case '/':
        return (f) => a(f) / b(f);
      case '%':
        return (f) => a(f) % b(f);
      case '**':
        return (f) => a(f) ** b(f);
      case '|':
        return (f) => a(f) | b(f);
      case '&':
        return (f) => a(f) & b(f);
      case '^':
        return (f) => a(f) ^ b(f);
      case '<<':
        return (f) => a(f) << b(f);
      case '>>':
        return (f) => a(f) >> b(f);
      case '>>>':
        return (f) => a(f) >>> b(f);
      case '<':
        return (f) => a(f) < b(f);
      case '>':
        return (f) => a(f) > b(f);
      case '<=':
        return (f) => a(f) <= b(f);
      case '>=':
        return (f) => a(f) >= b(f);
      case '===':
        return (f) => a(f) === b(f);
      case '!==':
        return (f) => a(f) !== b(f);
      case '==':
        return (f) => a(f) == b(f);
      case '!=':
        return (f) => a(f) != b(f);
    }
    throw bug(`the operator '${op}'`);
  }

  /** A place to read and store; the emitter writes only simple places here, so evaluating one twice changes nothing. */
  private place(unit: Unit, target: Node): { get(f: Frame): unknown; set(f: Frame, v: unknown): void } {
    if (target.k === 'name') {
      const found = this.find(unit, target.name);
      if (!found) throw bug(`a store to the unknown name '${target.name}'`);
      const frame = up(found.depth),
        slot = found.slot;
      return { get: (f) => frame(f)[slot], set: (f, v) => (frame(f)[slot] = v) };
    }
    if (target.k === 'slot') throw bug('a store to a barrier operand');
    const object = this.expression(unit, target.object),
      key = target.k === 'member' ? () => target.name : this.expression(unit, target.index);
    if (target.k !== 'member' && target.k !== 'index') throw bug(`a store to '${target.k}'`);
    return {
      get: (f) => object(f)[key(f)],
      set: (f, v) => (object(f)[key(f)] = v),
    };
  }

  private assign(unit: Unit, e: Node): Expr {
    const value = this.expression(unit, e.value);
    if (e.op === '=') {
      if (e.target.k === 'name') {
        const found = this.find(unit, e.target.name);
        if (!found) throw bug(`a store to the unknown name '${e.target.name}'`);
        const frame = up(found.depth),
          slot = found.slot;
        if (found.depth === 0) return (f) => (f[slot] = value(f));
        return (f) => (frame(f)[slot] = value(f));
      }
      const object = this.expression(unit, e.target.object);
      if (e.target.k === 'member') {
        const name = e.target.name;
        return (f) => (object(f)[name] = value(f));
      }
      const index = this.expression(unit, e.target.index);
      return (f) => {
        const o = object(f),
          i = index(f);
        return (o[i] = value(f));
      };
    }
    // Compound stores: the emitter writes them for simple places only, each read once here as in the language.
    const place = this.place(unit, e.target),
      op = this.binary(
        e.op.slice(0, -1),
        (f) => f[f.length - 2],
        (f) => f[f.length - 1],
      );
    return (f) => {
      const v = op([place.get(f), value(f)]);
      place.set(f, v);
      return v;
    };
  }

  private update(unit: Unit, e: Node): Expr {
    const place = this.place(unit, e.target),
      step = e.op === '++' ? 1 : -1,
      prefix = e.prefix;
    return (f) => {
      const old = place.get(f) as number,
        next = old + step;
      place.set(f, next);
      return prefix ? next : old;
    };
  }

  private call(unit: Unit, e: Node): Expr {
    const callee = e.callee,
      spread = e.args.some((n: Node) => n.k === 'spread'),
      list: Expr[] = spread ? [this.array(unit, e.args)] : e.args.map((n: Node) => this.expression(unit, n)),
      [a, b, c] = list,
      n = list.length;
    if (callee.k === 'name') {
      const found = this.find(unit, callee.name);
      if (found?.fn) return this.direct(found.fn, up(found.depth), list, spread);
      const fn = this.read(unit, callee.name);
      if (spread) return (f) => fn(f)(...a(f));
      if (n === 1) return (f) => fn(f)(a(f));
      if (n === 2) return (f) => fn(f)(a(f), b(f));
      if (n === 3) return (f) => fn(f)(a(f), b(f), c(f));
      return (f) => fn(f)(...list.map((x) => x(f)));
    }
    if (callee.k !== 'member') {
      const fn = this.expression(unit, callee);
      return spread ? (f) => fn(f)(...a(f)) : (f) => fn(f)(...list.map((x) => x(f)));
    }
    const name = callee.name;
    if (callee.object.k === 'name' && callee.object.name === 'Math' && !this.find(unit, 'Math')) {
      const fn = (Math as unknown as Record<string, (...args: number[]) => number>)[name];
      if (spread) return (f) => fn(...a(f));
      if (n === 1) return (f) => fn(a(f));
      if (n === 2) return (f) => fn(a(f), b(f));
    }
    const object = this.expression(unit, callee.object);
    if (spread) return (f) => object(f)[name](...a(f));
    if (n === 1) return (f) => object(f)[name](a(f));
    if (n === 2) return (f) => object(f)[name](a(f), b(f));
    return (f) => object(f)[name](...list.map((x) => x(f)));
  }

  /** A call of a function the source declares: its arguments go straight into its frame. */
  private direct(fn: Fn, home: (f: Frame) => Frame, list: Expr[], spread: boolean): Expr {
    const n = list.length;
    const enter = (f: Frame): Frame => {
      const frame: Frame = new Array(fn.size);
      frame[0] = home(f);
      if (spread) {
        const args = list[0](f) as unknown[];
        for (let i = 0; i < args.length; i++) frame[2 + i] = args[i];
      } else for (let i = 0; i < n; i++) frame[2 + i] = list[i](f);
      return frame;
    };
    return (f) => {
      if (fn.gen) return run(fn.gen, enter(f));
      const frame = enter(f);
      fn.body(frame);
      return frame[1];
    };
  }

  /** The module: its statements as the body of a function of (H, R). */
  compile(source: string): (h: typeof H, r: CPUBindings) => KernelModule {
    const body = new Parser(tokenize(source)).program();
    const unit = new Unit(null),
      h = unit.declare('H'),
      r = unit.declare('R');
    this.hoist(unit, body);
    // Every function gets its compiled body first: the statements below may call any of them.
    const declared = body.filter((s) => s.k === 'func');
    for (const s of declared) this.func(unit, s);
    const start = this.list(
      unit,
      body.filter((s) => s.k !== 'func'),
    );
    const { size } = unit,
      functions = this.functions;
    return (hValue, rValue) => {
      const frame: Frame = new Array(size);
      frame[h] = hValue;
      frame[r] = rValue;
      // A function named as a value, as `main` is in the module's result.
      for (const { slot, fn } of functions)
        frame[slot] = (...args: unknown[]) => {
          const inner: Frame = new Array(fn.size);
          inner[0] = frame;
          for (let i = 0; i < fn.params; i++) inner[2 + i] = args[i];
          if (fn.gen) return run(fn.gen, inner);
          fn.body(inner);
          return inner[1];
        };
      start(frame);
      return frame[1] as KernelModule;
    };
  }
}

function* run(body: GenStmt, frame: Frame): Generator<unknown, unknown, unknown> {
  yield* body(frame);
  return frame[1];
}

/**
 * What `new Function('H', 'R', source)` gives for the text js.ts generates, without compiling JavaScript at run time.
 * Slower than the JIT, by the figures in docs/limits.md, and the same to the last bit: it runs the same operations on
 * the same helpers.
 * @param source The generated module.
 * @returns The module's factory.
 * @throws MargoError code `failed` for text outside the part of the language js.ts writes (a bug).
 */
export function interpretKernel(source: string): (h: typeof H, r: CPUBindings) => KernelModule {
  return new Compiler().compile(source);
}
