import { fault } from '../../shared/errors.js';
/** Parsed expression with explicit operator precedence. */
export interface Expression {
  op: string;
  value: string;
  args: Expression[];
}
/** Typed variable or parameter declaration. */
export interface Declaration {
  name: string;
  type: string;
  qualifier: string;
  init?: Expression;
}
/** Structured statement before WGSL control-flow lowering. */
export interface Statement {
  kind: string;
  expr?: Expression;
  decls?: Declaration[];
  body?: Statement[];
  other?: Statement[];
  init?: Statement;
  update?: Expression;
}
/** Function definition or prototype. */
export interface FunctionDeclaration {
  name: string;
  type: string;
  params: Declaration[];
  body?: Statement[];
}
/** One parsed transition translation unit. */
export interface Program {
  globals: Declaration[];
  functions: FunctionDeclaration[];
  structs: Map<string, Declaration[]>;
}
const types = new Set([
  'void',
  'float',
  'int',
  'uint',
  'bool',
  'vec2',
  'vec3',
  'vec4',
  'ivec2',
  'ivec3',
  'ivec4',
  'uvec2',
  'uvec3',
  'uvec4',
  'bvec2',
  'bvec3',
  'bvec4',
  'mat2',
  'mat3',
  'mat4',
  'sampler2D',
]);
const qualifiers = new Set(['const', 'uniform', 'highp', 'mediump', 'lowp', 'in', 'out', 'inout']);
const precedence: Record<string, number> = {
  ',': 1,
  '=': 2,
  '+=': 2,
  '-=': 2,
  '*=': 2,
  '/=': 2,
  '%=': 2,
  '?': 3,
  '||': 4,
  '^^': 5,
  '&&': 6,
  '|': 7,
  '^': 8,
  '&': 9,
  '==': 10,
  '!=': 10,
  '<': 11,
  '<=': 11,
  '>': 11,
  '>=': 11,
  '<<': 12,
  '>>': 12,
  '+': 13,
  '-': 13,
  '*': 14,
  '/': 14,
  '%': 14,
};
const node = (op: string, value = '', args: Expression[] = []): Expression => ({ op, value, args });
function lex(source: string): string[] {
  const tokens: string[] = [];
  const re =
    /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fFuU]?|[A-Za-z_]\w*|\+\+|--|\+=|-=|\*=|\/=|%=|==|!=|<=|>=|&&|\|\||\^\^|<<|>>|[{}()[\].,;?:+*/%<>=!&|^~-]/y;
  for (let i = 0; i < source.length; ) {
    re.lastIndex = i;
    const m = re.exec(source);
    if (!m) throw fault('failed', `GLSL character at ${i} is invalid; correct the transition source`);
    i = re.lastIndex;
    if (!/^\s|^\/\//.test(m[0]) && !m[0].startsWith('/*')) tokens.push(m[0]);
    if (tokens.length > 32768) throw fault('failed', 'GLSL token limit exceeded; keep source below 32768 tokens');
  }
  return tokens;
}
/** Tokenizes and parses GLSL declarations, expressions and structured control flow. No GPU work. */
export class GLSLParser {
  private tokens: string[];
  private i = 0;
  private depth = 0;
  private readonly known = new Set(types);
  private readonly globals: Declaration[] = [];
  constructor(source: string) {
    this.tokens = lex(source);
  }
  private peek() {
    return this.tokens[this.i] ?? '';
  }
  private take() {
    const v = this.peek();
    if (!v) this.fail('Unexpected end of source');
    this.i++;
    return v;
  }
  private match(v: string) {
    if (this.peek() !== v) return false;
    this.i++;
    return true;
  }
  private expect(v: string) {
    if (!this.match(v)) this.fail(`Expected ${v}, found ${this.peek() || 'end'}`);
  }
  private fail(message: string): never {
    throw fault('failed', `GLSL token ${this.i}: ${message}; correct the transition source`);
  }
  private identifier() {
    const v = this.take();
    if (!/^[A-Za-z_]\w*$/.test(v)) this.fail('Expected an identifier');
    return v;
  }
  private qualified() {
    const q: string[] = [];
    while (qualifiers.has(this.peek())) q.push(this.take());
    const type = this.identifier();
    if (!this.known.has(type)) this.fail(`Unknown type ${type}`);
    return { type, qualifier: q.join(' ') };
  }
  private array(type: string) {
    while (this.match('[')) {
      const count = this.expression(2);
      this.expect(']');
      // A literal or a named constant stays as written; a constant expression (`weights[2+2]`, `[N*2]`) is folded here
      // over literals and earlier global initializers, so every array type has one integer or name length (KB5433).
      type += `[${count.op === 'literal' || count.op === 'name' ? count.value : this.fold(count)}]`;
    }
    return type;
  }
  private fold(e: Expression, depth = 0): number {
    if (depth > 64) this.fail('Array dimensions must be integer constants');
    if (e.op === 'literal' && /^\d+$/.test(e.value)) return Number(e.value);
    if (e.op === 'name') {
      const d = this.globals.find((g) => g.name === e.value && /\bconst\b/.test(g.qualifier));
      if (d?.init) return this.fold(d.init, depth + 1);
    }
    if (e.op === 'prefix' && e.value === '-' && e.args[0]) return -this.fold(e.args[0], depth + 1);
    if (e.op === 'prefix' && e.value === '+' && e.args[0]) return this.fold(e.args[0], depth + 1);
    if (e.op === 'binary' && e.args[0] && e.args[1]) {
      const a = this.fold(e.args[0], depth + 1),
        b = this.fold(e.args[1], depth + 1);
      switch (e.value) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          if (b !== 0) return Math.trunc(a / b);
          break;
        case '%':
          if (b !== 0) return a % b;
          break;
      }
    }
    return this.fail('Array dimensions must be integer constants');
  }
  private declarations(type: string, qualifier: string, name?: string) {
    const out: Declaration[] = [];
    do {
      const n = name ?? this.identifier();
      name = undefined;
      const t = this.array(type);
      out.push({ name: n, type: t, qualifier, init: this.match('=') ? this.expression(2) : undefined });
    } while (this.match(','));
    this.expect(';');
    return out;
  }
  parse(): Program {
    const result: Program = { globals: this.globals, functions: [], structs: new Map() };
    while (this.peek()) {
      if (this.match('precision')) {
        this.take();
        this.take();
        this.expect(';');
        continue;
      }
      if (this.match(';')) continue;
      if (this.match('struct')) {
        const name = this.identifier();
        this.known.add(name);
        this.expect('{');
        const fields: Declaration[] = [];
        while (!this.match('}')) {
          const q = this.qualified();
          fields.push(...this.declarations(q.type, q.qualifier));
        }
        result.structs.set(name, fields);
        if (!this.match(';')) result.globals.push(...this.declarations(name, ''));
        continue;
      }
      const q = this.qualified(),
        name = this.identifier();
      if (this.match('(')) {
        const params: Declaration[] = [];
        if (!this.match(')')) {
          if (this.peek() === 'void' && this.tokens[this.i + 1] === ')') {
            this.take();
            this.take();
          } else {
            do {
              const p = this.qualified();
              // GLSL allows an unnamed parameter (`float f(float, vec2 uv)`); it gets a name no source can use.
              const unnamed = [',', ')', '['].includes(this.peek());
              const n = unnamed ? `margo_unnamed${params.length}` : this.identifier();
              params.push({ name: n, type: this.array(p.type), qualifier: p.qualifier });
            } while (this.match(','));
            this.expect(')');
          }
        }
        const body = this.match(';') ? undefined : this.block();
        result.functions.push({ name, type: q.type, params, body });
      } else result.globals.push(...this.declarations(q.type, q.qualifier, name));
    }
    return result;
  }
  private block() {
    this.expect('{');
    const body: Statement[] = [];
    while (!this.match('}')) body.push(this.statement());
    return body;
  }
  private statement(): Statement {
    if (++this.depth > 128) this.fail('Statement nesting exceeds 128');
    try {
      if (this.peek() === '{') return { kind: 'block', body: this.block() };
      if (this.match(';')) return { kind: 'block', body: [] };
      if (this.match('if')) {
        this.expect('(');
        const expr = this.expression();
        this.expect(')');
        const body = [this.statement()],
          other = this.match('else') ? [this.statement()] : undefined;
        return { kind: 'if', expr, body, other };
      }
      if (this.match('for')) {
        this.expect('(');
        const init = this.match(';') ? undefined : this.simple();
        const expr = this.match(';') ? undefined : this.expression();
        if (expr) this.expect(';');
        const update = this.peek() === ')' ? undefined : this.expression();
        this.expect(')');
        return { kind: 'for', init, expr, update, body: [this.statement()] };
      }
      if (this.match('while')) {
        this.expect('(');
        const expr = this.expression();
        this.expect(')');
        return { kind: 'while', expr, body: [this.statement()] };
      }
      if (this.match('do')) {
        const body = [this.statement()];
        this.expect('while');
        this.expect('(');
        const expr = this.expression();
        this.expect(')');
        this.expect(';');
        return { kind: 'do', body, expr };
      }
      for (const kind of ['return', 'break', 'continue', 'discard'])
        if (this.match(kind)) {
          const expr = kind === 'return' && this.peek() !== ';' ? this.expression() : undefined;
          this.expect(';');
          return { kind, expr };
        }
      return this.simple();
    } finally {
      this.depth--;
    }
  }
  private simple(): Statement {
    if (qualifiers.has(this.peek()) || this.known.has(this.peek())) {
      const q = this.qualified();
      return { kind: 'decl', decls: this.declarations(q.type, q.qualifier) };
    }
    const expr = this.expression();
    this.expect(';');
    return { kind: 'expr', expr };
  }
  private expression(min = 0): Expression {
    if (++this.depth > 128) this.fail('Expression nesting exceeds 128');
    try {
      const t = this.take();
      let left: Expression;
      if (t === '(') {
        left = this.expression();
        this.expect(')');
      } else if (['+', '-', '!', '~', '++', '--'].includes(t)) left = node('prefix', t, [this.expression(15)]);
      else if (/^(?:\d|\.)/.test(t) || t === 'true' || t === 'false') left = node('literal', t);
      else if (/^[A-Za-z_]\w*$/.test(t)) left = node('name', t);
      else this.fail(`Unexpected expression token ${t}`);
      while (true) {
        if (this.match('(')) {
          const args: Expression[] = [];
          if (!this.match(')')) {
            do {
              args.push(this.expression(2));
            } while (this.match(','));
            this.expect(')');
          }
          left = node('call', '', [left, ...args]);
          continue;
        }
        if (this.match('[')) {
          const index = this.expression();
          this.expect(']');
          left = node('index', '', [left, index]);
          continue;
        }
        if (this.match('.')) {
          left = node('member', this.identifier(), [left]);
          continue;
        }
        if (this.peek() === '++' || this.peek() === '--') {
          left = node('postfix', this.take(), [left]);
          continue;
        }
        const op = this.peek(),
          priority = precedence[op];
        if (priority === undefined || priority < min) break;
        this.take();
        if (op === '?') {
          const yes = this.expression();
          this.expect(':');
          const no = this.expression(priority);
          left = node('conditional', '', [left, yes, no]);
          continue;
        }
        const right = this.expression(priority + (priority === 2 ? 0 : 1));
        left = node('binary', op, [left, right]);
      }
      return left;
    } finally {
      this.depth--;
    }
  }
}
