import { fault } from '../../../shared/errors.js';
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
  /** A switch's clauses in source order: their folded integer labels (null for default) and statements. */
  cases?: { labels: (number | null)[]; body: Statement[] }[];
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
  'mat2x3',
  'mat2x4',
  'mat3x2',
  'mat3x4',
  'mat4x2',
  'mat4x3',
  'sampler2D',
  'samplerCube',
  'sampler3D',
  'sampler2DArray',
  // GLSL ES 3.00 4.1.7: integer samplers and depth comparison (shadow) samplers.
  'isampler2D',
  'isampler3D',
  'isamplerCube',
  'isampler2DArray',
  'usampler2D',
  'usampler3D',
  'usamplerCube',
  'usampler2DArray',
  'sampler2DShadow',
  'samplerCubeShadow',
  'sampler2DArrayShadow',
]);
// GLSL ES 3.00 4.1.6: matNxN is the same type as matN, so one spelling reaches the emitter.
const square: Record<string, string> = { mat2x2: 'mat2', mat3x3: 'mat3', mat4x4: 'mat4' };
const qualifiers = new Set([
  'const',
  'uniform',
  'highp',
  'mediump',
  'lowp',
  'in',
  'out',
  'inout',
  'flat',
  'smooth',
  'centroid',
  'invariant',
  // GLSL ES 1.00 4.3: vertex inputs and the values linked between stages.
  'attribute',
  'varying',
]);
const precedence: Record<string, number> = {
  ',': 1,
  '=': 2,
  '+=': 2,
  '-=': 2,
  '*=': 2,
  '/=': 2,
  '%=': 2,
  '<<=': 2,
  '>>=': 2,
  '&=': 2,
  '|=': 2,
  '^=': 2,
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
function lex(source: string, offsets: number[] = []): string[] {
  const tokens: string[] = [];
  const re =
    /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|0[xX][\dA-Fa-f]+[uU]?|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fFuU]?|[A-Za-z_]\w*|<<=|>>=|&=|\|=|\^=|\+\+|--|\+=|-=|\*=|\/=|%=|==|!=|<=|>=|&&|\|\||\^\^|<<|>>|[{}()[\].,;?:+*/%<>=!&|^~-]/y;
  for (let i = 0; i < source.length; ) {
    re.lastIndex = i;
    const m = re.exec(source);
    if (!m) throw fault('failed', `GLSL character at ${i} is invalid; correct the transition source`);
    i = re.lastIndex;
    if (!/^\s|^\/\//.test(m[0]) && !m[0].startsWith('/*')) {
      tokens.push(m[0]);
      offsets.push(m.index);
    }
    if (tokens.length > 32768) throw fault('failed', 'GLSL token limit exceeded; keep source below 32768 tokens');
  }
  return tokens;
}
/** Tokenizes and parses GLSL declarations, expressions and structured control flow. No GPU work. */
export class GLSLParser {
  private tokens: string[];
  private offsets: number[] = [];
  private i = 0;
  private depth = 0;
  private readonly known = new Set(types);
  private readonly globals: Declaration[] = [];
  // Constant initializers by scope, innermost last; null marks a name that is not a constant (GLSL ES 1.00 4.2.2 and
  // 4.3.2), so array sizes fold over the name a scope actually sees, local constants included.
  private readonly constants: Map<string, Expression | null>[] = [new Map()];
  /**
   * `subject` names the source in messages ("transition" by default); a syntax error carries the `line` and `column`
   * (1-based) of its token in `source`.
   */
  constructor(
    private readonly source: string,
    private readonly subject = 'transition',
  ) {
    this.tokens = lex(source, this.offsets);
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
  // `back` is 1 when the faulty token was already taken.
  private fail(message: string, back = 0): never {
    const at = this.offsets[Math.max(0, Math.min(this.i - back, this.offsets.length - 1))] ?? 0,
      before = this.source.slice(0, at);
    throw Object.assign(fault('failed', `GLSL token ${this.i}: ${message}; correct the ${this.subject} source`), {
      line: before.split('\n').length,
      column: at - before.lastIndexOf('\n'),
    });
  }
  private identifier() {
    const v = this.take();
    if (!/^[A-Za-z_]\w*$/.test(v)) this.fail('Expected an identifier', 1);
    return v;
  }
  private qualified() {
    const q: string[] = [];
    for (;;) {
      if (qualifiers.has(this.peek())) q.push(this.take());
      else if (this.match('layout')) {
        // Layout qualifiers (4.3.8) place interface variables; a translated function has none, so they are skipped.
        this.expect('(');
        while (!this.match(')')) this.take();
      } else break;
    }
    const name = this.identifier();
    const type = square[name] ?? name;
    if (!this.known.has(type) && !square[name]) this.fail(`Unknown type ${type}`);
    // GLSL ES 3.00 4.1.9: the array size may follow the type (`float[3] a`, `float[2] f()`).
    return { type: this.peek() === '[' ? this.array(type) : type, qualifier: q.join(' ') };
  }
  private array(type: string) {
    while (this.match('[')) {
      // An unsized array takes its size from its initializer (GLSL ES 3.00 4.1.9), resolved in declarations().
      if (this.match(']')) {
        type += '[]';
        continue;
      }
      const count = this.expression(2);
      this.expect(']');
      // Every length folds to one decimal integer (`weights[2+2]`, `[N*2]`, `[010]`, KB5433) over literals and the
      // constants in scope, so equal array types compare equal and WGSL gets a literal count.
      const n = this.fold(count);
      if (n < 1) this.fail('Array sizes must be positive integer constants');
      type += `[${n}]`;
    }
    return type;
  }
  private fold(e: Expression, depth = 0): number {
    if (depth > 64) this.fail('Array dimensions must be integer constants');
    if (e.op === 'literal' && /^\d+[uU]?$/.test(e.value)) return parseInt(e.value, 10);
    if (e.op === 'name')
      for (let i = this.constants.length - 1; i >= 0; i--) {
        const d = this.constants[i]!.get(e.value);
        if (d) return this.fold(d, depth + 1);
        if (d === null) break;
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
  // Integer literals are decimal, octal (leading 0) or hexadecimal (0x) (4.1.3); they reach the emitter in decimal.
  private number(t: string) {
    if (/[.eE]/.test(t) && !/^0[xX]/.test(t)) return t;
    const u = /[uU]$/.test(t) ? 'u' : '',
      digits = u ? t.slice(0, -1) : t;
    const n = /^0[xX]/.test(digits)
      ? parseInt(digits.slice(2), 16)
      : /^0[0-7]*$/.test(digits)
        ? parseInt(digits, 8)
        : /^[1-9]\d*$/.test(digits)
          ? Number(digits)
          : this.fail(`Integer literal ${t} is malformed`, 1);
    return n + u;
  }
  private declarations(type: string, qualifier: string, name?: string, scoped = true) {
    const out: Declaration[] = [];
    do {
      const n = name ?? this.identifier();
      name = undefined;
      let t = this.array(type);
      const init = this.match('=') ? this.expression(2) : undefined;
      if (t.endsWith('[]')) {
        const sized = init?.op === 'call' && init.args[0]!.op === 'name' ? init.args[0]!.value : '';
        if (!init || sized.replace(/\[\d+\]$/, '[]') !== t)
          this.fail(`Unsized array ${n} needs an array constructor of its type`);
        t = sized;
      }
      if (scoped) this.constants.at(-1)!.set(n, /\bconst\b/.test(qualifier) && init ? init : null);
      out.push({ name: n, type: t, qualifier, init });
    } while (this.match(','));
    this.expect(';');
    return out;
  }
  // GLSL ES 3.00 4.3.7: `uniform Name { members } instance;` is a uniform block. Without an instance name its members
  // are uniforms of global scope; with one they are the fields of that instance (an array of blocks takes a size).
  private uniformBlock(result: Program): boolean {
    let j = this.i,
      uniform = false;
    for (;;) {
      const t = this.tokens[j];
      if (t === 'layout' && this.tokens[j + 1] === '(') {
        while (this.tokens[j] && this.tokens[j] !== ')') j++;
        j++;
      } else if (t && qualifiers.has(t)) (uniform ||= t === 'uniform'), j++;
      else break;
    }
    const name = this.tokens[j] ?? '';
    if (!uniform || this.tokens[j + 1] !== '{' || !/^[A-Za-z_]\w*$/.test(name) || this.known.has(name)) return false;
    this.i = j + 2;
    const fields: Declaration[] = [];
    while (!this.match('}')) {
      const q = this.qualified();
      if (/sampler/.test(q.type)) this.fail('A uniform block holds no samplers');
      fields.push(...this.declarations(q.type, q.qualifier, undefined, false));
    }
    if (this.match(';'))
      result.globals.push(...fields.map((f) => ({ ...f, qualifier: `uniform ${f.qualifier}`.trim() })));
    else {
      this.known.add(name);
      result.structs.set(name, fields);
      result.globals.push(...this.declarations(name, 'uniform'));
    }
    return true;
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
      if (this.uniformBlock(result)) continue;
      // `invariant gl_Position;` redeclares names as invariant (4.6.1); one translation of each stage computes them
      // one way, so it lowers to nothing.
      if (
        this.peek() === 'invariant' &&
        !this.known.has(this.tokens[this.i + 1]!) &&
        !qualifiers.has(this.tokens[this.i + 1]!)
      ) {
        this.take();
        do this.identifier();
        while (this.match(','));
        this.expect(';');
        continue;
      }
      if (this.match('struct')) {
        const name = this.identifier();
        this.known.add(name);
        this.expect('{');
        const fields: Declaration[] = [];
        while (!this.match('}')) {
          const q = this.qualified();
          fields.push(...this.declarations(q.type, q.qualifier, undefined, false));
        }
        result.structs.set(name, fields);
        if (!this.match(';')) result.globals.push(...this.declarations(name, ''));
        continue;
      }
      const q = this.qualified(),
        name = this.identifier();
      if (this.match('(')) {
        const params: Declaration[] = [];
        this.constants.push(new Map());
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
              this.constants.at(-1)!.set(n, null);
            } while (this.match(','));
            this.expect(')');
          }
        }
        const body = this.match(';') ? undefined : this.block();
        this.constants.pop();
        result.functions.push({ name, type: q.type, params, body });
      } else result.globals.push(...this.declarations(q.type, q.qualifier, name));
    }
    return result;
  }
  private block() {
    this.expect('{');
    const body: Statement[] = [];
    this.constants.push(new Map());
    while (!this.match('}')) body.push(this.statement());
    this.constants.pop();
    return body;
  }
  private statement(): Statement {
    if (++this.depth > 128) this.fail('Statement nesting exceeds 128');
    try {
      if (this.peek() === '{') return { kind: 'block', body: this.block() };
      if (this.match(';')) return { kind: 'block', body: [] };
      // A precision statement may stand in any scope (4.5.3); WGSL has no precision, so it lowers to nothing.
      if (this.match('precision')) {
        this.take();
        this.take();
        this.expect(';');
        return { kind: 'block', body: [] };
      }
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
        this.constants.push(new Map());
        const init = this.match(';') ? undefined : this.simple();
        const expr = this.match(';') ? undefined : this.expression();
        if (expr) this.expect(';');
        const update = this.peek() === ')' ? undefined : this.expression();
        this.expect(')');
        const body = [this.statement()];
        this.constants.pop();
        return { kind: 'for', init, expr, update, body };
      }
      if (this.match('while')) {
        this.expect('(');
        const expr = this.expression();
        this.expect(')');
        return { kind: 'while', expr, body: [this.statement()] };
      }
      if (this.match('switch')) {
        // GLSL ES 3.00 6.2: one scope for the whole body; labels are constant integer expressions, folded here.
        this.expect('(');
        const expr = this.expression();
        this.expect(')');
        this.expect('{');
        this.constants.push(new Map());
        const cases: { labels: (number | null)[]; body: Statement[] }[] = [];
        const seen = new Set<number | null>();
        while (!this.match('}')) {
          const label = this.match('case') ? this.fold(this.expression()) : this.match('default') ? null : undefined;
          if (label === undefined) {
            if (!cases.length) this.fail('A switch body starts with a case or default label');
            cases.at(-1)!.body.push(this.statement());
            continue;
          }
          this.expect(':');
          if (seen.has(label)) this.fail(`Duplicate switch label ${label ?? 'default'}`);
          seen.add(label);
          const last = cases.at(-1);
          if (last && !last.body.length) last.labels.push(label);
          else cases.push({ labels: [label], body: [] });
        }
        this.constants.pop();
        if (cases.length && !cases.at(-1)!.body.length) this.fail('A switch label needs a statement after it');
        return { kind: 'switch', expr, cases };
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
    // A type followed by `[` and `(` is an array constructor in an expression statement, not a declaration.
    const t = this.peek();
    if (
      qualifiers.has(t) ||
      t === 'layout' ||
      ((this.known.has(t) || Object.hasOwn(square, t)) && !this.constructs())
    ) {
      const q = this.qualified();
      return { kind: 'decl', decls: this.declarations(q.type, q.qualifier) };
    }
    const expr = this.expression();
    this.expect(';');
    return { kind: 'expr', expr };
  }
  // True when the tokens ahead read `type[...](`, an array constructor.
  private constructs() {
    if (this.tokens[this.i + 1] !== '[') return false;
    let j = this.i + 1,
      level = 0;
    for (; j < this.tokens.length; j++) {
      if (this.tokens[j] === '[') level++;
      else if (this.tokens[j] === ']' && --level === 0) break;
    }
    return this.tokens[j + 1] === '(';
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
      else if (/^\.?\d/.test(t)) left = node('literal', this.number(t));
      else if (t === 'true' || t === 'false') left = node('literal', t);
      else if (this.known.has(t) && this.peek() === '[') {
        // An array constructor (GLSL ES 3.00 5.4.4), `float[3](...)` or `float[](...)` sized by its arguments.
        let type = this.array(t);
        this.expect('(');
        const args: Expression[] = [];
        if (!this.match(')')) {
          do args.push(this.expression(2));
          while (this.match(','));
          this.expect(')');
        }
        if (type.endsWith('[]')) type = type.slice(0, -2) + `[${args.length}]`;
        if (!args.length) this.fail('An array constructor needs its elements');
        left = node('call', '', [node('name', type), ...args]);
      } else if (/^[A-Za-z_]\w*$/.test(t)) left = node('name', square[t] ?? t);
      else this.fail(`Unexpected expression token ${t}`, 1);
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
          // The last operand is an assignment expression (GLSL ES 1.00 grammar), so `c ? x : y = 1.0` assigns y.
          const no = this.expression(2);
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
