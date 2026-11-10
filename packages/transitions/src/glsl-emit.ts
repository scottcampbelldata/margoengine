import type { GLSLUniformValue } from './glsl.js';
import { fault } from '../../shared/errors.js';
import type { Program, Declaration, Expression, FunctionDeclaration, Statement } from './glsl-parser.js';
interface Value {
  code: string;
  type: string;
  before: string[];
}
interface Variable {
  code: string;
  type: string;
}
const scalar = (t: string) =>
  t.startsWith('bvec')
    ? 'bool'
    : t.startsWith('ivec')
      ? 'int'
      : t.startsWith('uvec')
        ? 'uint'
        : t.startsWith('vec') || t.startsWith('mat')
          ? 'float'
          : t;
const width = (t: string) => (/vec[234]$/.test(t) ? Number(t.at(-1)) : 1);
const vector = (base: string, n: number) =>
  n === 1 ? base : `${base === 'float' ? '' : base === 'int' ? 'i' : base === 'uint' ? 'u' : 'b'}vec${n}`;
const identifier = (s: string) => 'user_' + s;
const wgsl = (type: string): string => {
  const array = /^(.*)\[([^\]]+)\]$/.exec(type);
  if (array) return `array<${wgsl(array[1]!)},${/^\d+$/.test(array[2]!) ? array[2] : identifier(array[2]!)}>`;
  const known: Record<string, string> = {
    float: 'f32',
    int: 'i32',
    uint: 'u32',
    bool: 'bool',
    void: 'void',
    sampler2D: 'texture_2d<f32>',
  };
  if (known[type]) return known[type]!;
  const v = /^([ibu]?)vec([234])$/.exec(type);
  if (v) return `vec${v[2]}<${v[1] === 'i' ? 'i32' : v[1] === 'u' ? 'u32' : v[1] === 'b' ? 'bool' : 'f32'}>`;
  if (/^mat[234]$/.test(type)) return `mat${type.at(-1)}x${type.at(-1)}<f32>`;
  return identifier(type);
};
const value = (code: string, type: string, before: string[] = []): Value => ({ code, type, before });
/** Typed GLSL expression and control-flow lowering to the custom transition WGSL contract. */
export class GLSLEmitter {
  private scopes: Map<string, Variable>[] = [new Map()];
  private serial = 0;
  private active?: FunctionDeclaration;
  private functions: FunctionDeclaration[];
  private names = new Map<FunctionDeclaration, string>();
  private helpers = new Set<string>();
  constructor(
    private program: Program,
    private uniforms: Readonly<Record<string, GLSLUniformValue>>,
    private flipY: boolean,
  ) {
    this.functions = program.functions.filter((f) => f.body);
    this.functions.forEach((f, i) => this.names.set(f, `user_function_${i}`));
  }
  private fail(message: string): never {
    throw fault('failed', `GLSL translation: ${message}; correct the source or supplied uniform values`);
  }
  private temp() {
    return `temporary_${this.serial++}`;
  }
  private find(name: string) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i]!.get(name);
      if (v) return v;
    }
    return undefined;
  }
  private define(name: string, type: string, code = identifier(name)) {
    const scope = this.scopes.at(-1)!;
    if (scope.has(name)) this.fail(`Duplicate variable ${name}`);
    scope.set(name, { type, code });
    return code;
  }
  private convert(v: Value, type: string): Value {
    if (type === v.type) return v;
    if (scalar(type) === 'bool' && scalar(v.type) !== 'bool')
      return value(`(${v.code}!=${wgsl(v.type)}(0))`, type, v.before);
    if (scalar(v.type) === 'bool' && scalar(type) !== 'bool')
      return value(`select(${wgsl(type)}(0),${wgsl(type)}(1),${v.code})`, type, v.before);
    if (width(type) > 1 && width(v.type) === 1 && scalar(type) !== scalar(v.type))
      return this.convert(this.convert(v, scalar(type)), type);
    if (scalar(type) === scalar(v.type) && width(type) > 1 && width(v.type) === 1)
      return value(`${wgsl(type)}(${v.code})`, type, v.before);
    if (
      width(type) === width(v.type) &&
      ['float', 'int', 'uint', 'bool'].includes(scalar(type)) &&
      ['float', 'int', 'uint', 'bool'].includes(scalar(v.type))
    )
      return value(`${wgsl(type)}(${v.code})`, type, v.before);
    this.fail(`Cannot convert ${v.type} to ${type}`);
  }
  private join(a: Value, b: Value) {
    const n = Math.max(width(a.type), width(b.type));
    const base = scalar(a.type) === 'float' || scalar(b.type) === 'float' ? 'float' : scalar(a.type);
    const type = vector(base, n);
    return [this.convert(a, type), this.convert(b, type)] as const;
  }
  private literal(e: Expression) {
    let t = e.value;
    if (t === 'true' || t === 'false') return value(t, 'bool');
    if (/[uU]$/.test(t)) return value(t.slice(0, -1) + 'u', 'uint');
    if (/[.eEfF]/.test(t)) {
      t = t.replace(/[fF]$/, '');
      if (t.startsWith('.')) t = '0' + t;
      if (t.endsWith('.')) t += '0';
      return value(`f32(${t})`, 'float');
    }
    return value(`i32(${t})`, 'int');
  }
  private assign(lhs: Expression, rhs: Value, op = '=', known?: Value): string[] {
    const left = known ?? this.expr(lhs);
    const v = this.convert(rhs, left.type);
    const lines = [...left.before, ...v.before];
    if (
      lhs.op === 'member' &&
      /^[ibu]?vec[234]$/.test(this.expr(lhs.args[0]!).type) &&
      /^[xyzwrgba stpq]+$/.test(lhs.value) &&
      lhs.value.length > 1
    ) {
      const targetCode = left.code.slice(0, -lhs.value.length - 1);
      const field = lhs.value
        .replace(/[rgba]/g, (c) => 'xyzw'['rgba'.indexOf(c)]!)
        .replace(/[stpq]/g, (c) => 'xyzw'['stpq'.indexOf(c)]!);
      if (new Set(field).size !== field.length) this.fail('Repeated component in swizzle assignment');
      const temp = this.temp();
      lines.push(`let ${temp}=${v.code};`);
      for (let i = 0; i < field.length; i++) lines.push(`${targetCode}.${field[i]} ${op} ${temp}[${i}];`);
    } else lines.push(`${left.code} ${op} ${v.code};`);
    return lines;
  }
  private expr(e: Expression): Value {
    if (e.op === 'literal') return this.literal(e);
    if (e.op === 'name') {
      const found = this.find(e.value);
      if (!found) this.fail(`Unknown identifier ${e.value}`);
      return value(found.code, found.type);
    }
    if (e.op === 'index') {
      const a = this.expr(e.args[0]!),
        b = this.convert(this.expr(e.args[1]!), 'int');
      const array = /^(.*)\[[^\]]+\]$/.exec(a.type);
      const t = array ? array[1]! : a.type.startsWith('mat') ? 'vec' + a.type.at(-1) : scalar(a.type);
      return value(`${a.code}[${b.code}]`, t, [...a.before, ...b.before]);
    }
    if (e.op === 'member') {
      const a = this.expr(e.args[0]!);
      const field = e.value;
      const struct = this.program.structs.get(a.type);
      if (struct) {
        const member = struct.find((f) => f.name === field);
        if (!member) this.fail(`Unknown struct member ${field}`);
        return value(`${a.code}.${identifier(field)}`, member.type, a.before);
      }
      const set = /^[xyzw]{1,4}$/.test(field)
        ? 'xyzw'
        : /^[rgba]{1,4}$/.test(field)
          ? 'rgba'
          : /^[stpq]{1,4}$/.test(field)
            ? 'stpq'
            : '';
      if (!set || [...field].some((c) => set.indexOf(c) >= width(a.type))) this.fail(`Invalid swizzle ${field}`);
      const converted = [...field].map((c) => 'xyzw'[set.indexOf(c)]).join('');
      return value(`(${a.code}).${converted}`, vector(scalar(a.type), field.length), a.before);
    }
    if (e.op === 'prefix' || e.op === 'postfix') {
      const a = this.expr(e.args[0]!);
      if (e.value === '++' || e.value === '--') {
        const t = this.temp();
        const before =
          e.op === 'postfix'
            ? [
                ...a.before,
                `let ${t}=${a.code};`,
                ...this.assign(e.args[0]!, value(`${wgsl(a.type)}(1)`, a.type), e.value === '++' ? '+=' : '-='),
              ]
            : this.assign(e.args[0]!, value(`${wgsl(a.type)}(1)`, a.type), e.value === '++' ? '+=' : '-=');
        return value(e.op === 'postfix' ? t : a.code, a.type, before);
      }
      return value(`(${e.value === '+' ? '' : e.value}${a.code})`, e.value === '!' ? 'bool' : a.type, a.before);
    }
    if (e.op === 'conditional') {
      const c = this.expr(e.args[0]!),
        a = this.expr(e.args[1]!),
        b = this.convert(this.expr(e.args[2]!), a.type);
      const temp = this.temp();
      return value(temp, a.type, [
        ...c.before,
        `var ${temp}:${wgsl(a.type)};`,
        `if(${c.code}){${a.before.join('\n')}${temp}=${a.code};}else{${b.before.join('\n')}${temp}=${b.code};}`,
      ]);
    }
    if (e.op === 'binary') {
      const op = e.value;
      if (['=', '+=', '-=', '*=', '/=', '%='].includes(op)) {
        const a = this.expr(e.args[0]!),
          b = this.convert(this.expr(e.args[1]!), a.type);
        return value(a.code, a.type, this.assign(e.args[0]!, b, op, a));
      }
      const a = this.expr(e.args[0]!),
        b = this.expr(e.args[1]!);
      if (op === ',') return value(b.code, b.type, [...a.before, `let ${this.temp()}=${a.code};`, ...b.before]);
      if (op === '&&' || op === '||') {
        if (!b.before.length) return value(`(${a.code}${op}${b.code})`, 'bool', a.before);
        const temp = this.temp();
        return value(temp, 'bool', [
          ...a.before,
          `var ${temp}=${a.code};`,
          `if(${op === '||' ? '!' : ''}${temp}){${b.before.join('\n')}${temp}=${b.code};}`,
        ]);
      }
      if (op === '^^') return value(`(${a.code}!=${b.code})`, 'bool', [...a.before, ...b.before]);
      if (op === '*' && (a.type.startsWith('mat') || b.type.startsWith('mat')))
        return value(
          `(${a.code}*${b.code})`,
          a.type.startsWith('vec')
            ? a.type
            : b.type.startsWith('vec')
              ? b.type
              : a.type.startsWith('mat')
                ? a.type
                : b.type,
          [...a.before, ...b.before],
        );
      if ((a.type.startsWith('mat') || b.type.startsWith('mat')) && ['+', '-', '/'].includes(op)) {
        const type = a.type.startsWith('mat') ? a.type : b.type,
          dim = Number(type.at(-1)),
          x = this.temp(),
          y = this.temp();
        const col = (val: Value, code: string, i: number) =>
          val.type.startsWith('mat') ? `${code}[${i}]` : `vec${dim}f(f32(${code}))`;
        return value(
          `${wgsl(type)}(${Array.from({ length: dim }, (_, i) => `(${col(a, x, i)}${op}${col(b, y, i)})`).join(',')})`,
          type,
          [...a.before, ...b.before, `let ${x}=${a.code};`, `let ${y}=${b.code};`],
        );
      }
      const [x, y] = this.join(a, b);
      const compare = ['==', '!=', '<', '<=', '>', '>='].includes(op);
      return value(`(${x.code}${op}${y.code})`, compare ? 'bool' : x.type, [...x.before, ...y.before]);
    }
    if (e.op === 'call') return this.call(e.args[0]!, e.args.slice(1));
    this.fail(`Unknown expression ${e.op}`);
  }
  private call(name: Expression, args: Expression[]): Value {
    if (name.op !== 'name') this.fail('Function calls must use a named function');
    const n = name.value,
      v = args.map((a) => this.expr(a)),
      before = v.flatMap((a) => a.before),
      codes = v.map((a) => a.code);
    const first = v[0] ?? value('', 'void');
    const get = (blue: boolean) => {
      if (v.length !== 1 || first.type !== 'vec2') this.fail(`${n} needs one vec2 coordinate`);
      return value(
        `sample(${blue ? 'after' : 'before'},${this.flipY ? `vec2f(${first.code}.x,1.0-${first.code}.y)` : first.code})`,
        'vec4',
        before,
      );
    };
    if (n === 'getFromColor' || n === 'getToColor') return get(n === 'getToColor');
    if (n === 'texture2D' || n === 'texture2DProj') {
      if ((v.length !== 2 && v.length !== 3) || first.type !== 'sampler2D')
        this.fail('texture2D needs from/to and vec2 coordinates');
      const uv =
        n === 'texture2DProj' ? `(${codes[1]}.xy/${codes[1]}.${width(v[1]!.type) === 4 ? 'w' : 'z'})` : codes[1]!;
      return value(`sample(${first.code},${this.flipY ? `vec2f(${uv}.x,1.0-${uv}.y)` : uv})`, 'vec4', before);
    }
    if (this.program.structs.has(n)) return value(`${wgsl(n)}(${codes.join(',')})`, n, before);
    if (/^(float|int|uint|bool|[ibu]?vec[234]|mat[234])$/.test(n)) {
      if (n.startsWith('mat') && v.length === 1 && first.type.startsWith('mat')) {
        const dim = Number(n.at(-1)),
          old = Number(first.type.at(-1)),
          t = this.temp();
        return value(
          `${wgsl(n)}(${Array.from({ length: dim }, (_, c) => `vec${dim}f(${Array.from({ length: dim }, (_, r) => (c < old && r < old ? `${t}[${c}][${r}]` : c === r ? '1.0' : '0.0')).join(',')})`).join(',')})`,
          n,
          [...before, `let ${t}=${first.code};`],
        );
      }
      if (n.startsWith('mat') && v.length === 1 && ['float', 'int', 'uint'].includes(first.type)) {
        const dim = Number(n.at(-1));
        const cols = Array.from(
          { length: dim },
          (_, c) =>
            `${wgsl('vec' + dim)}(${Array.from({ length: dim }, (_, r) => (r === c ? `f32(${first.code})` : '0.0')).join(',')})`,
        );
        return value(`${wgsl(n)}(${cols.join(',')})`, n, before);
      }
      if (width(n) > 1 && v.length === 1 && width(first.type) > width(n))
        return value(`${wgsl(n)}((${first.code}).${'xyzw'.slice(0, width(n))})`, n, before);
      const adjusted = v.map((a) =>
        scalar(a.type) === scalar(n) ? a : this.convert(a, vector(scalar(n), width(a.type))),
      );
      return value(
        `${wgsl(n)}(${adjusted.map((a) => a.code).join(',')})`,
        n,
        adjusted.flatMap((a) => a.before),
      );
    }
    const candidates = this.functions.filter((f) => f.name === n && f.params.length === v.length);
    const fn =
      candidates.find((f) => f.params.every((p, i) => p.type === v[i]!.type)) ??
      candidates.find((f) => f.params.every((p, i) => width(p.type) === width(v[i]!.type)));
    if (fn) {
      const params = fn.params.map((p, i) => this.convert(v[i]!, p.type));
      const prep = params.flatMap((p) => p.before);
      const code = `${this.names.get(fn)}(${params.map((p) => p.code).join(',')})`;
      const out = fn.params.some((p) => /\b(out|inout)\b/.test(p.qualifier));
      if (!out) return value(code, fn.type, prep);
      const temp = this.temp();
      prep.push(`let ${temp}=${code};`);
      fn.params.forEach((p, i) => {
        if (/\b(out|inout)\b/.test(p.qualifier))
          prep.push(...this.assign(args[i]!, value(`${temp}.out_${i}`, p.type), '=', { ...v[i]!, before: [] }));
      });
      return value(fn.type === 'void' ? '' : `${temp}.result`, fn.type, prep);
    }
    const unary = [
      'radians',
      'degrees',
      'sin',
      'cos',
      'tan',
      'asin',
      'acos',
      'exp',
      'log',
      'exp2',
      'log2',
      'sqrt',
      'inversesqrt',
      'abs',
      'sign',
      'floor',
      'ceil',
      'fract',
      'normalize',
      'dFdx',
      'dFdy',
      'fwidth',
    ];
    if (unary.includes(n)) {
      if (v.length !== 1) this.fail(`${n} needs one argument`);
      const mapped: Record<string, string> = { inversesqrt: 'inverseSqrt', dFdx: 'dpdx', dFdy: 'dpdy' };
      return value(`${n === 'dFdy' && this.flipY ? '-' : ''}${mapped[n] ?? n}(${codes.join(',')})`, first.type, before);
    }
    if (n === 'atan') return value(`${v.length === 2 ? 'atan2' : 'atan'}(${codes.join(',')})`, first.type, before);
    if (['length', 'distance', 'dot', 'determinant'].includes(n))
      return value(`${n}(${codes.join(',')})`, 'float', before);
    if (['any', 'all'].includes(n)) return value(`${n}(${codes.join(',')})`, 'bool', before);
    if (n === 'not') return value(`(!${first.code})`, first.type, before);
    if (['cross', 'reflect', 'refract', 'transpose', 'inverse', 'faceforward'].includes(n))
      return value(`${n === 'faceforward' ? 'faceForward' : n}(${codes.join(',')})`, first.type, before);
    const cmp: Record<string, string> = {
      lessThan: '<',
      lessThanEqual: '<=',
      greaterThan: '>',
      greaterThanEqual: '>=',
      equal: '==',
      notEqual: '!=',
    };
    if (cmp[n]) return value(`(${codes[0]}${cmp[n]}${codes[1]})`, vector('bool', width(first.type)), before);
    if (['min', 'max', 'pow', 'step', 'mod', 'clamp', 'mix', 'smoothstep'].includes(n)) {
      const count = ['clamp', 'mix', 'smoothstep'].includes(n) ? 3 : 2;
      if (v.length !== count) this.fail(`${n} needs ${count} arguments`);
      const type = v.reduce((t, x) => (width(x.type) > width(t) ? x.type : t), first.type);
      const aligned = v.map((x) => this.convert(x, type));
      const c = aligned.map((x) => x.code),
        prep = aligned.flatMap((x) => x.before);
      if (n === 'mod') {
        const x = this.temp(),
          y = this.temp();
        return value(`(${x}-${y}*floor(${x}/${y}))`, type, [...prep, `let ${x}=${c[0]};`, `let ${y}=${c[1]};`]);
      }
      return value(`${n}(${c.join(',')})`, type, prep);
    }
    if (n === 'matrixCompMult') {
      const dim = Number(first.type.at(-1));
      return value(
        `${wgsl(first.type)}(${Array.from({ length: dim }, (_, i) => `${codes[0]}[${i}]*${codes[1]}[${i}]`).join(',')})`,
        first.type,
        before,
      );
    }
    this.fail(`Unknown function or overload ${n}`);
  }
  private declarations(decls: Declaration[], global = false): string[] {
    return decls.map((d) => {
      const name = this.define(d.name, d.type);
      let init = d.init ? this.convert(this.expr(d.init), d.type) : undefined;
      if (/\buniform\b/.test(d.qualifier)) {
        const parameter = this.uniforms[d.name];
        if (parameter === undefined) this.fail(`Supply uniform ${d.name}`);
        init = value(this.parameter(parameter, d.type), d.type);
      }
      const constant = /\bconst\b|\buniform\b/.test(d.qualifier);
      if (global && init?.before.length) this.fail(`Global initializer ${d.name} is not constant`);
      return [
        ...(init?.before ?? []),
        `${global ? (constant ? 'const' : 'var<private>') : constant ? 'let' : 'var'} ${name}:${wgsl(d.type)}${init ? '=' + init.code : ''};`,
      ].join('\n');
    });
  }
  private constant(e: Expression, depth = 0): number {
    if (depth > 64) this.fail('Array length constants are recursive');
    if (e.op === 'literal') return Number(e.value);
    if (e.op === 'name') {
      const d = this.program.globals.find((g) => g.name === e.value);
      if (d?.init) return this.constant(d.init, depth + 1);
    }
    const a = e.args[0] ? this.constant(e.args[0], depth + 1) : 0,
      b = e.args[1] ? this.constant(e.args[1], depth + 1) : 0;
    if (e.op === 'prefix' && e.value === '-') return -a;
    if (e.op === 'binary')
      switch (e.value) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return Math.trunc(a / b);
        case '%':
          return a % b;
      }
    this.fail('Array lengths must be positive integer constants');
  }
  private arrayCount(name: string): number {
    const count = /^\d+$/.test(name) ? Number(name) : this.constant({ op: 'name', value: name, args: [] });
    if (!Number.isSafeInteger(count) || count < 1 || count > 16384)
      this.fail('Uniform array length must be in 1..16384');
    return count;
  }
  private components(type: string): number {
    const a = /^(.*)\[([^\]]+)\]$/.exec(type);
    return a
      ? this.arrayCount(a[2]!) * this.components(a[1]!)
      : type.startsWith('mat')
        ? Number(type.at(-1)) ** 2
        : width(type);
  }
  private parameter(v: GLSLUniformValue, type: string): string {
    const values = Array.isArray(v) ? v : [v];
    if (values.length !== this.components(type)) this.fail(`Uniform ${type} needs ${this.components(type)} components`);
    let offset = 0;
    const build = (t: string): string => {
      const array = /^(.*)\[([^\]]+)\]$/.exec(t);
      if (array)
        return `${wgsl(t)}(${Array.from({ length: this.arrayCount(array[2]!) }, () => build(array[1]!)).join(',')})`;
      const base = scalar(t),
        count = this.components(t);
      const parts = Array.from({ length: count }, () => {
        const x = values[offset++];
        if (base === 'bool') {
          if (typeof x === 'boolean' || x === 0 || x === 1) return String(!!x);
          this.fail('Boolean uniforms need true, false, zero or one');
        }
        if (typeof x !== 'number' || !Number.isFinite(x) || (base === 'float' && !Number.isFinite(Math.fround(x))))
          this.fail('Uniform values must fit finite 32-bit numbers');
        if (
          (base === 'int' || base === 'uint') &&
          (!Number.isSafeInteger(x) ||
            x < (base === 'uint' ? 0 : -2147483648) ||
            x > (base === 'uint' ? 4294967295 : 2147483647))
        )
          this.fail('Integer uniform is outside 32-bit range');
        return `${wgsl(base)}(${Object.is(x, -0) ? '-0.0' : x})`;
      });
      return count === 1 ? parts[0]! : `${wgsl(t)}(${parts.join(',')})`;
    };
    return build(type);
  }
  private returnValue(expr?: Expression): string[] {
    const fn = this.active!;
    const v = expr ? this.convert(this.expr(expr), fn.type) : undefined;
    const outs = fn.params
      .map((p, i) => (/\b(out|inout)\b/.test(p.qualifier) ? this.find(p.name)!.code : undefined))
      .filter((x) => x !== undefined);
    return [
      ...(v?.before ?? []),
      `return${outs.length ? ' ' + this.names.get(fn) + '_result(' + [...(v ? [v.code] : []), ...outs].join(',') + ')' : v ? ' ' + v.code : ''};`,
    ];
  }
  private body(body: Statement[]): string {
    this.scopes.push(new Map());
    try {
      return body.flatMap((s) => this.statement(s)).join('\n');
    } finally {
      this.scopes.pop();
    }
  }
  private statement(s: Statement): string[] {
    if (s.kind === 'block') return ['{' + this.body(s.body ?? []) + '}'];
    if (s.kind === 'decl') return this.declarations(s.decls!);
    if (s.kind === 'return') return this.returnValue(s.expr);
    if (['break', 'continue', 'discard'].includes(s.kind)) return [s.kind + ';'];
    if (s.kind === 'expr') {
      const v = this.expr(s.expr!);
      return [...v.before, ...(v.code ? [v.type === 'void' ? v.code + ';' : '_=' + v.code + ';'] : [])];
    }
    if (s.kind === 'if') {
      const v = this.expr(s.expr!);
      return [
        ...v.before,
        `if(${v.code}){${this.body(s.body ?? [])}}${s.other ? 'else{' + this.body(s.other) + '}' : ''}`,
      ];
    }
    if (['for', 'while', 'do'].includes(s.kind)) {
      this.scopes.push(new Map());
      try {
        const init = s.init ? this.statement(s.init) : [],
          cond = s.expr ? this.expr(s.expr) : undefined,
          update = s.update ? this.expr(s.update) : undefined;
        const check = cond ? [...cond.before, `if(!(${cond.code})){break;}`].join('\n') : '';
        const last = update
          ? [...update.before, ...(update.before.length === 0 && update.code ? [update.code + ';'] : [])].join('\n')
          : '';
        return [
          '{',
          ...init,
          `loop{${s.kind === 'do' ? '' : check}\n${this.body(s.body ?? [])}\ncontinuing{${s.kind === 'do' ? `${cond?.before.join('\n') ?? ''}\nbreak if !(${cond?.code ?? 'true'});` : last}}}`,
          '}',
        ];
      } finally {
        this.scopes.pop();
      }
    }
    this.fail(`Unknown statement ${s.kind}`);
  }
  emit(): string {
    const root = this.scopes[0]!;
    root.set('progress', { code: 'settings.x', type: 'float' });
    root.set('ratio', { code: '(f32(textureDimensions(after).x)/f32(textureDimensions(after).y))', type: 'float' });
    root.set('from', { code: 'before', type: 'sampler2D' });
    root.set('to', { code: 'after', type: 'sampler2D' });
    root.set('gl_FragCoord', { code: 'user_frag_coord', type: 'vec4' });
    const structs = [...this.program.structs]
      .map(
        ([name, fields]) =>
          `struct ${identifier(name)}{${fields.map((f) => identifier(f.name) + ':' + wgsl(f.type)).join(',')}}`,
      )
      .join('\n');
    const globals = this.declarations(
      this.program.globals.filter((d) => !['progress', 'ratio', 'from', 'to'].includes(d.name)),
      true,
    ).join('\n');
    const results = this.functions
      .filter((f) => f.params.some((p) => /\b(out|inout)\b/.test(p.qualifier)))
      .map(
        (f) =>
          `struct ${this.names.get(f)}_result{${[...(f.type === 'void' ? [] : [`result:${wgsl(f.type)}`]), ...f.params.flatMap((p, i) => (/\b(out|inout)\b/.test(p.qualifier) ? [`out_${i}:${wgsl(p.type)}`] : []))].join(',')}}`,
      )
      .join('\n');
    const functions = this.functions
      .map((fn) => {
        this.active = fn;
        this.scopes.push(new Map());
        try {
          const params = fn.params.map((p, i) => `argument_${i}:${wgsl(p.type)}`);
          const locals = fn.params.map((p, i) => {
            if (p.type === 'sampler2D') {
              if (/\b(out|inout)\b/.test(p.qualifier)) this.fail('Samplers cannot be output parameters');
              this.define(p.name, p.type, 'argument_' + i);
              return '';
            }
            return `var ${this.define(p.name, p.type)}:${wgsl(p.type)} = ${/\bout\b/.test(p.qualifier) ? wgsl(p.type) + '()' : 'argument_' + i};`;
          });
          const type = fn.params.some((p) => /\b(out|inout)\b/.test(p.qualifier))
            ? `${this.names.get(fn)}_result`
            : fn.type === 'void'
              ? ''
              : wgsl(fn.type);
          const body = fn.body!.flatMap((s) => this.statement(s));
          if (fn.type === 'void' && fn.body!.at(-1)?.kind !== 'return') body.push(...this.returnValue());
          return `fn ${this.names.get(fn)}(${params.join(',')})${type ? '->' + type : ''}{\n${locals.join('\n')}\n${body.join('\n')}\n}`;
        } finally {
          this.scopes.pop();
        }
      })
      .join('\n');
    const entry = this.functions.find(
      (f) => f.name === 'transition' && f.type === 'vec4' && f.params.length === 1 && f.params[0]!.type === 'vec2',
    );
    if (!entry) this.fail('Supply vec4 transition(vec2 uv)');
    return `${structs}\n${globals}\n${results}\nvar<private> user_frag_coord:vec4f;\n${[...this.helpers].join('\n')}\n${functions}\nfn transition(a:texture_2d<f32>,b:texture_2d<f32>,uv:vec2f,p:f32)->vec4f{\nuser_frag_coord=vec4f(uv.x*f32(textureDimensions(after).x),(1.0-uv.y)*f32(textureDimensions(after).y),0.0,1.0);\nreturn ${this.names.get(entry)}(${this.flipY ? 'vec2f(uv.x,1.0-uv.y)' : 'uv'});\n}`;
  }
}
