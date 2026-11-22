import type { GLSLHost, GLSLUniformValue } from './host.js';
import { fault } from '../../../shared/errors.js';
import type { Program, Declaration, Expression, FunctionDeclaration, Statement } from './parser.js';
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
// Columns and rows of a matrix type (GLSL ES 3.00 4.1.6: matCxR has C columns of R rows, as WGSL's matCxR<f32>).
const shape = (t: string): [number, number] | undefined => {
  const m = /^mat([234])(?:x([234]))?$/.exec(t);
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : undefined;
};
const matrix = (c: number, r: number) => (c === r ? `mat${c}` : `mat${c}x${r}`);
const samplers: Record<string, string> = {
  sampler2D: 'texture_2d<f32>',
  samplerCube: 'texture_cube<f32>',
  sampler3D: 'texture_3d<f32>',
  sampler2DArray: 'texture_2d_array<f32>',
  sampler2DShadow: 'texture_depth_2d',
  samplerCubeShadow: 'texture_depth_cube',
  sampler2DArrayShadow: 'texture_depth_2d_array',
};
// GLSL ES 3.00 4.1.7: isampler and usampler read signed and unsigned integer textures.
for (const k of ['i', 'u'])
  for (const [d, w] of [
    ['2D', '2d'],
    ['3D', '3d'],
    ['Cube', 'cube'],
    ['2DArray', '2d_array'],
  ])
    samplers[`${k}sampler${d}`] = `texture_${w}<${k}32>`;
// The float sampler type of the same dimension: isampler2D and sampler2DShadow look up as sampler2D does.
const dimensionOf = (kind: string) => kind.replace(/^[iu]/, '').replace('Shadow', '');
// What a lookup returns (8.8): a float for a shadow sampler, ivec4 or uvec4 for an integer one, vec4 otherwise.
const texelType = (kind: string) =>
  kind.endsWith('Shadow') ? 'float' : /^[iu]/.test(kind) ? kind[0] + 'vec4' : 'vec4';
const wgsl = (type: string): string => {
  const array = /^(.*)\[([^\]]+)\]$/.exec(type);
  if (array) return `array<${wgsl(array[1]!)},${array[2]}>`;
  const known: Record<string, string> = {
    float: 'f32',
    int: 'i32',
    uint: 'u32',
    bool: 'bool',
    void: 'void',
    ...samplers,
  };
  if (known[type]) return known[type]!;
  const v = /^([ibu]?)vec([234])$/.exec(type);
  if (v) return `vec${v[2]}<${v[1] === 'i' ? 'i32' : v[1] === 'u' ? 'u32' : v[1] === 'b' ? 'bool' : 'f32'}>`;
  const m = shape(type);
  if (m) return `mat${m[0]}x${m[1]}<f32>`;
  return identifier(type);
};
const NL = String.fromCharCode(10);
const value = (code: string, type: string, before: string[] = []): Value => ({ code, type, before });
/** Typed GLSL expression and control-flow lowering to the custom transition WGSL contract. */
export class GLSLEmitter {
  private scopes: Map<string, Variable>[] = [new Map()];
  private serial = 0;
  private active?: FunctionDeclaration;
  private functions: FunctionDeclaration[];
  private names = new Map<FunctionDeclaration, string>();
  private helpers = new Set<string>();
  private equalityNames = new Map<string, string>();
  private uniforms: GLSLHost['uniforms'];
  private flipY: boolean;
  constructor(
    private program: Program,
    private host: GLSLHost,
    // The source's GLSL ES version: 1.00 excludes array equality and inverse, which 3.00 adds.
    private version: 100 | 300 = 100,
  ) {
    this.uniforms = host.uniforms;
    this.flipY = host.flipY;
    this.functions = program.functions.filter((f) => f.body);
    this.functions.forEach((f, i) => this.names.set(f, `user_function_${i}`));
  }
  private fail(message: string): never {
    throw fault('failed', `GLSL translation: ${message}; correct the source or supplied uniform values`);
  }
  private temp() {
    return `temporary_${this.serial++}`;
  }
  private equality(type: string): string {
    const known = this.equalityNames.get(type);
    if (known) return known;
    const name = `aggregate_equal_${this.serial++}`;
    this.equalityNames.set(type, name);
    const component = (t: string, a: string, b: string): string => {
      if (['float', 'int', 'uint', 'bool'].includes(t)) return `(${a}==${b})`;
      return `${this.equality(t)}(${a},${b})`;
    };
    let condition: string;
    if (/^[ibu]?vec[234]$/.test(type)) condition = 'all(a==b)';
    else if (shape(type))
      condition = Array.from({ length: shape(type)![0] }, (_, i) => `all(a[${i}]==b[${i}])`).join('&&');
    else if (/^(.*)\[(\d+)\]$/.test(type) && this.version === 300) {
      // GLSL ES 3.00 5.7: arrays compare equal when every element does.
      const [, element, count] = /^(.*)\[(\d+)\]$/.exec(type)!;
      condition = Array.from({ length: Number(count) }, (_, i) => component(element!, `a[${i}]`, `b[${i}]`)).join('&&');
    } else {
      const fields = this.program.structs.get(type);
      if (!fields) this.fail('GLSL ES 1.00 equality excludes arrays and samplers');
      condition = fields.map((f) => component(f.type, `a.${identifier(f.name)}`, `b.${identifier(f.name)}`)).join('&&');
    }
    this.helpers.add(`fn ${name}(a:${wgsl(type)},b:${wgsl(type)})->bool{return ${condition};}`);
    return name;
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
    // GLSL ES 3.00 4.1.3: a signed literal keeps its 32-bit pattern, so 0xFFFFFFFF is -1.
    if (Number(t) > 2147483647) {
      if (Number(t) > 4294967295) this.fail(`Integer literal ${t} does not fit 32 bits`);
      return value(`bitcast<i32>(${t}u)`, 'int');
    }
    return value(`i32(${t})`, 'int');
  }
  private assign(lhs: Expression, rhs: Value, op = '=', known?: Value): string[] {
    // Only a variable, element, field or swizzle is an l-value (5.8); anything else would assign a temporary.
    if (!['name', 'index', 'member'].includes(lhs.op))
      this.fail('Assignment needs a variable, element, field or swizzle');
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
      const array = /^(.*)\[([^\]]+)\]$/.exec(a.type);
      if (array && Object.hasOwn(samplers, array[1]!)) {
        // Element k of a sampler array binds as <name>__k. GLSL ES 3.00 4.1.7.1 indexes it with a constant; 1.00
        // Appendix A also allows a loop index, read by looking up every element and keeping the indexed one.
        const k = /^i32\((\d+)\)$/.exec(b.code)?.[1];
        if (k !== undefined) {
          if (+k >= +array[2]!) this.fail(`Sampler array index ${k} is outside its ${array[2]} elements`);
          return value(`${a.code}__${k}`, array[1]!, a.before);
        }
        const i = this.temp();
        return value(`margo_pick(${a.code},${array[2]},${i})`, array[1]!, [
          ...a.before,
          ...b.before,
          `let ${i}=${b.code};`,
        ]);
      }
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
    if (e.op === 'prefix' && e.value === '-' && e.args[0]!.op === 'literal' && e.args[0]!.value === '2147483648')
      return value('i32(-2147483648)', 'int');
    if (e.op === 'prefix' || e.op === 'postfix') {
      const a = this.expr(e.args[0]!);
      if (e.value === '++' || e.value === '--') {
        // a = a +- 1 through the binary rules (a matrix or vector adds 1 to each component, 5.9), with the target
        // evaluated once so an index's side effects run once.
        const t = this.temp();
        const one = value(`${wgsl(scalar(a.type))}(1)`, scalar(a.type));
        const step = this.assign(e.args[0]!, this.arith(e.value[0]!, value(a.code, a.type), one), '=', {
          ...a,
          before: [],
        });
        const before = e.op === 'postfix' ? [...a.before, `let ${t}=${a.code};`, ...step] : [...a.before, ...step];
        return value(e.op === 'postfix' ? t : a.code, a.type, before);
      }
      // WGSL has no unary minus on matrices; a times -1 flips each component's sign the same way.
      if (e.value === '-' && a.type.startsWith('mat')) return value(`(${a.code}*(-1.0))`, a.type, a.before);
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
      if (['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^='].includes(op)) {
        // a op= b is a = a op b with a evaluated once (5.8), so the shapes WGSL's compound forms lack (matrix times or
        // over a scalar, vector times matrix) take the binary rules.
        const a = this.expr(e.args[0]!),
          r = this.expr(e.args[1]!);
        const b = op === '=' ? r : this.arith(op.slice(0, -1), value(a.code, a.type), r);
        return value(a.code, a.type, this.assign(e.args[0]!, b, '=', a));
      }
      const a = this.expr(e.args[0]!),
        b = this.expr(e.args[1]!);
      if (op === ',')
        return value(b.code, b.type, [
          ...a.before,
          ...(a.type === 'void' ? (a.code ? [a.code + ';'] : []) : [`let ${this.temp()}=${a.code};`]),
          ...b.before,
        ]);
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
      if (op === '==' || op === '!=') {
        if (a.type !== b.type) this.fail('Equality operands must have matching types');
        const code = ['float', 'int', 'uint', 'bool'].includes(a.type)
          ? `(${a.code}==${b.code})`
          : `${this.equality(a.type)}(${a.code},${b.code})`;
        return value(op === '!=' ? `!(${code})` : code, 'bool', [...a.before, ...b.before]);
      }
      return this.arith(op, a, b);
    }
    if (e.op === 'call') return this.call(e.args[0]!, e.args.slice(1));
    this.fail(`Unknown expression ${e.op}`);
  }
  private arith(op: string, a: Value, b: Value): Value {
    const sa = shape(a.type),
      sb = shape(b.type);
    if (op === '*' && (sa || sb))
      // GLSL ES 3.00 5.10: matCxR * vecC is vecR, vecR * matCxR is vecC, matCxR * matKxC is matKxR.
      return value(
        `(${a.code}*${b.code})`,
        sa && sb
          ? matrix(sb[0], sa[1])
          : sa && b.type.startsWith('vec')
            ? `vec${sa[1]}`
            : sb && a.type.startsWith('vec')
              ? `vec${sb[0]}`
              : sa
                ? a.type
                : b.type,
        [...a.before, ...b.before],
      );
    if ((sa || sb) && ['+', '-', '/'].includes(op)) {
      const type = sa ? a.type : b.type,
        [cols, rows] = (sa ?? sb)!,
        x = this.temp(),
        y = this.temp();
      const col = (val: Value, code: string, i: number) =>
        val.type.startsWith('mat') ? `${code}[${i}]` : `vec${rows}f(f32(${code}))`;
      return value(
        `${wgsl(type)}(${Array.from({ length: cols }, (_, i) => `(${col(a, x, i)}${op}${col(b, y, i)})`).join(',')})`,
        type,
        [...a.before, ...b.before, `let ${x}=${a.code};`, `let ${y}=${b.code};`],
      );
    }
    if (op === '<<' || op === '>>') {
      // GLSL ES 3.00 5.9: the result has the left operand's type and either operand may be signed; WGSL shifts by
      // an unsigned amount of the left operand's width.
      const amount = this.convert(b, vector('uint', width(a.type)));
      return value(`(${a.code}${op}${amount.code})`, a.type, [...a.before, ...amount.before]);
    }
    const [x, y] = this.join(a, b);
    const compare = ['==', '!=', '<', '<=', '>', '>='].includes(op);
    return value(`(${x.code}${op}${y.code})`, compare ? 'bool' : x.type, [...x.before, ...y.before]);
  }
  private call(name: Expression, args: Expression[]): Value {
    if (name.op === 'member' && name.value === 'length' && !args.length) {
      // GLSL ES 3.00 5.9: a.length() is the array's constant size, an int.
      const a = this.expr(name.args[0]!);
      const array = /\[(\d+)\]$/.exec(a.type);
      if (!array) this.fail('length() needs an array');
      return value(`i32(${array[1]})`, 'int', a.before);
    }
    if (name.op !== 'name') this.fail('Function calls must use a named function');
    const n = name.value,
      v = args.map((a) => this.expr(a)),
      before = v.flatMap((a) => a.before),
      codes = v.map((a) => a.code);
    const first = v[0] ?? value('', 'void');
    const get = (blue: boolean) => {
      if (v.length !== 1 || first.type !== 'vec2') this.fail(`${n} needs one vec2 coordinate`);
      return value(
        `sample(${this.host.colorReaders[blue ? 'getToColor' : 'getFromColor']},${this.flipY ? `vec2f(${first.code}.x,1.0-${first.code}.y)` : first.code})`,
        'vec4',
        before,
      );
    };
    if (Object.hasOwn(this.host.colorReaders, n)) return get(n === 'getToColor');
    const lookup = /^(texture2D|texture)(Proj)?(Lod|Grad|Offset)?$/.exec(n);
    if (lookup && Object.hasOwn(samplers, first.type)) return this.lookup(!!lookup[2], lookup[3] ?? '', v, before);
    if (n === 'texelFetch' || n === 'textureSize') return this.texel(n, v, before);
    const array = /^(.*)\[(\d+)\]$/.exec(n);
    if (array) {
      // GLSL ES 3.00 5.4.4: one argument per element, each converted to the element type.
      if (v.length !== Number(array[2])) this.fail(`${n} needs ${array[2]} elements`);
      const elements = v.map((x) => this.convert(x, array[1]!));
      return value(
        `${wgsl(n)}(${elements.map((x) => x.code).join(',')})`,
        n,
        elements.flatMap((x) => x.before),
      );
    }
    if (this.program.structs.has(n)) return value(`${wgsl(n)}(${codes.join(',')})`, n, before);
    if (/^(float|int|uint|bool|[ibu]?vec[234]|mat[234](x[234])?)$/.test(n)) {
      const to = shape(n);
      if (to && v.length === 1 && shape(first.type)) {
        // GLSL ES 3.00 5.4.2: a matrix from a matrix copies the overlap and fills the rest from the identity.
        const [cols, rows] = to,
          [oldCols, oldRows] = shape(first.type)!,
          t = this.temp();
        return value(
          `${wgsl(n)}(${Array.from({ length: cols }, (_, c) => `vec${rows}f(${Array.from({ length: rows }, (_, r) => (c < oldCols && r < oldRows ? `${t}[${c}][${r}]` : c === r ? '1.0' : '0.0')).join(',')})`).join(',')})`,
          n,
          [...before, `let ${t}=${first.code};`],
        );
      }
      if (to && v.length === 1 && ['float', 'int', 'uint'].includes(first.type)) {
        const [cols, rows] = to;
        const columns = Array.from(
          { length: cols },
          (_, c) =>
            `${wgsl('vec' + rows)}(${Array.from({ length: rows }, (_, r) => (r === c ? `f32(${first.code})` : '0.0')).join(',')})`,
        );
        return value(`${wgsl(n)}(${columns.join(',')})`, n, before);
      }
      // Components the WGSL constructor cannot take as given (a matrix, scalars mixed with vectors in a matrix, or a
      // last argument only partly used) are spread into scalars and consumed in order (5.4.2).
      const count = to ? to[0] * to[1] : width(n);
      const total = v.reduce((sum, x) => sum + this.components(x.type), 0);
      const direct = to
        ? total === count &&
          (v.every((x) => x.type === `vec${to[1]}`) || v.every((x) => width(x.type) === 1 && !shape(x.type)))
        : !v.some((x) => shape(x.type)) && (v.length === 1 || total === count);
      if (!direct && (v.length > 1 || (!to && width(n) > 1))) {
        if (total < count) this.fail(`${n} needs ${count} components`);
        const prep = [...before];
        const parts: string[] = [];
        for (const x of v) {
          const t = this.temp(),
            m = shape(x.type);
          prep.push(`let ${t}=${x.code};`);
          const items = m
            ? Array.from({ length: m[0] * m[1] }, (_, i) => `${t}[${Math.floor(i / m[1])}][${i % m[1]}]`)
            : width(x.type) > 1
              ? Array.from({ length: width(x.type) }, (_, i) => `${t}.${'xyzw'[i]}`)
              : [t];
          for (const item of items) parts.push(this.convert(value(item, scalar(x.type)), scalar(n)).code);
        }
        return value(`${wgsl(n)}(${parts.slice(0, count).join(',')})`, n, prep);
      }
      // A scalar from a vector or matrix takes its first component (5.4.1).
      if (
        !n.startsWith('mat') &&
        width(n) === 1 &&
        v.length === 1 &&
        (width(first.type) > 1 || /^mat/.test(first.type))
      )
        return this.convert(
          value(`(${first.code})${first.type.startsWith('mat') ? '[0].x' : '.x'}`, scalar(first.type), before),
          n,
        );
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
      if (params.some((p) => p.code.startsWith('margo_pick(') || /sampler\w*\[/.test(p.type)))
        this.fail(`${fn.name} takes a sampler array element; index it with a constant`);
      // A host that samples itself passes each texture with its sampler, named the texture's name plus "s".
      const paired = (p: Value) =>
        this.host.sample && Object.hasOwn(samplers, p.type)
          ? `${p.code},${this.host.samplerOf?.(p.code) ?? p.code + 's'}${this.host.samplerMode ? ',' + this.host.samplerMode(p.code) : ''}`
          : p.code;
      const code = `${this.names.get(fn)}(${params.map(paired).join(',')})`;
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
    if (n === 'mix' && v.length === 3 && scalar(v[2]!.type) === 'bool') {
      // GLSL ES 3.00 8.3: a boolean mix selects each component without interpolating.
      const type = width(v[1]!.type) > width(first.type) ? v[1]!.type : first.type;
      const [x, y] = [this.convert(first, type), this.convert(v[1]!, type)];
      return value(`select(${x.code},${y.code},${v[2]!.code})`, type, [...x.before, ...y.before, ...v[2]!.before]);
    }
    const bits: Record<string, string> = {
      floatBitsToInt: 'int',
      floatBitsToUint: 'uint',
      intBitsToFloat: 'float',
      uintBitsToFloat: 'float',
    };
    if (bits[n] && v.length === 1) {
      const type = vector(bits[n]!, width(first.type));
      return value(`bitcast<${wgsl(type)}>(${first.code})`, type, before);
    }
    if ((n === 'isnan' || n === 'isinf') && v.length === 1) {
      // WGSL has no isnan or isinf, and a compiler may fold x != x away, so the IEEE 754 bit pattern decides: an
      // exponent of all ones with a zero (inf) or non-zero (NaN) fraction.
      const w = width(first.type),
        u = wgsl(vector('uint', w)),
        t = this.temp();
      return value(`((${t}&${u}(0x7fffffffu))${n === 'isnan' ? '>' : '=='}${u}(0x7f800000u))`, vector('bool', w), [
        ...before,
        `let ${t}=bitcast<${u}>(${first.code});`,
      ]);
    }
    if (n === 'modf' && v.length === 2) {
      const t = this.temp();
      return value(`${t}.fract`, first.type, [
        ...before,
        `let ${t}=modf(${first.code});`,
        ...this.assign(args[1]!, value(`${t}.whole`, first.type), '=', { ...v[1]!, before: [] }),
      ]);
    }
    const square = shape(first.type);
    if (n === 'inverse' && this.version === 300 && v.length === 1 && square && square[0] === square[1])
      return value(`${this.inverse(square[0])}(${first.code})`, first.type, before);
    if (n === 'outerProduct' && v.length === 2) {
      // c * r^T: column i of the result is c scaled by r[i] (8.5).
      const c = this.temp(),
        r = this.temp();
      const type = matrix(width(v[1]!.type), width(first.type));
      return value(
        `${wgsl(type)}(${Array.from({ length: width(v[1]!.type) }, (_, i) => `${c}*${r}[${i}]`).join(',')})`,
        type,
        [...before, `let ${c}=${first.code};`, `let ${r}=${codes[1]};`],
      );
    }
    if (n === 'transpose' && v.length === 1 && square)
      return value(`transpose(${first.code})`, matrix(square[1], square[0]), before);
    const packs: Record<string, [string, string]> = {
      packSnorm2x16: ['pack2x16snorm', 'uint'],
      unpackSnorm2x16: ['unpack2x16snorm', 'vec2'],
      packUnorm2x16: ['pack2x16unorm', 'uint'],
      unpackUnorm2x16: ['unpack2x16unorm', 'vec2'],
      packHalf2x16: ['pack2x16float', 'uint'],
      unpackHalf2x16: ['unpack2x16float', 'vec2'],
    };
    if (packs[n] && v.length === 1) return value(`${packs[n]![0]}(${first.code})`, packs[n]![1], before);
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
      'trunc',
      'round',
      'roundEven',
      'sinh',
      'cosh',
      'tanh',
      'asinh',
      'acosh',
      'atanh',
    ];
    if (unary.includes(n)) {
      if (v.length !== 1) this.fail(`${n} needs one argument`);
      const mapped: Record<string, string> = {
        inversesqrt: 'inverseSqrt',
        dFdx: 'dpdx',
        dFdy: 'dpdy',
        roundEven: 'round',
      };
      return value(
        `${n === 'dFdy' && (this.host.yUp ?? this.flipY) ? '-' : ''}${mapped[n] ?? n}(${codes.join(',')})`,
        first.type,
        before,
      );
    }
    if (n === 'atan') return value(`${v.length === 2 ? 'atan2' : 'atan'}(${codes.join(',')})`, first.type, before);
    if (['length', 'distance', 'dot', 'determinant'].includes(n))
      return value(`${n}(${codes.join(',')})`, 'float', before);
    if (['any', 'all'].includes(n)) return value(`${n}(${codes.join(',')})`, 'bool', before);
    if (n === 'not') return value(`(!${first.code})`, first.type, before);
    // inverse is GLSL ES 3.00 and WGSL has no builtin for it, so it falls through to the unknown function error.
    if (['cross', 'reflect', 'refract', 'transpose', 'faceforward'].includes(n))
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
    if (n === 'matrixCompMult' && square) {
      return value(
        `${wgsl(first.type)}(${Array.from({ length: square[0] }, (_, i) => `${codes[0]}[${i}]*${codes[1]}[${i}]`).join(',')})`,
        first.type,
        before,
      );
    }
    this.fail(`Unknown function or overload ${n}`);
  }
  // texture, textureProj, textureLod, textureGrad, textureOffset and their ES 1.00 texture2D spellings (8.8).
  // A lookup through a sampler array element chosen at run time: every element's lookup, the indexed one kept.
  private picked(image: Value, read: (element: Value) => Value, before: string[]): Value | undefined {
    const pick = /^margo_pick\((\w+),(\d+),(\w+)\)$/.exec(image.code);
    if (!pick) return undefined;
    const all = Array.from({ length: +pick[2]! }, (_, k) => read(value(`${pick[1]}__${k}`, image.type)));
    return value(
      all.reduce((acc, r, k) => (k ? `select(${acc},${r.code},${pick[3]}==${k})` : r.code), ''),
      all[0]!.type,
      [...before, ...all.flatMap((r) => r.before)],
    );
  }
  private lookup(proj: boolean, variant: string, v: Value[], before: string[]): Value {
    const [image, coords, ...rest] = v;
    const many = this.picked(image!, (e) => this.lookup(proj, variant, [e, ...v.slice(1)], []), before);
    if (many) return many;
    const kind = dimensionOf(image!.type),
      shadow = image!.type.endsWith('Shadow');
    // A shadow lookup's coordinates end with the depth reference (8.8): one component more.
    const size = ({ sampler2D: 2, samplerCube: 3, sampler3D: 3, sampler2DArray: 3 }[kind] ?? 2) + (shadow ? 1 : 0);
    const extra = variant === 'Grad' ? 2 : variant ? 1 : 0;
    if (!coords || rest.length < extra || rest.length > extra + (variant === 'Lod' || variant === 'Grad' ? 0 : 1))
      this.fail(`texture${proj ? 'Proj' : ''}${variant} has the wrong number of arguments`);
    if (proj && kind !== 'sampler2D' && kind !== 'sampler3D') this.fail('A projective lookup needs a 2D or 3D sampler');
    if (proj && shadow && width(coords.type) !== 4)
      this.fail('textureProj of a sampler2DShadow takes vec4 coordinates');
    if (width(coords.type) !== (proj ? size + 1 : size) && !(proj && kind === 'sampler2D' && width(coords.type) === 4))
      this.fail(`${image!.type} lookups take vec${proj ? size + 1 : size} coordinates`);
    if (/^[iu]samplerCube/.test(image!.type))
      this.fail(`${image!.type} lookups need a cube texture of integers, which WGSL cannot read; use a 2D array`);
    let uv = proj
      ? `(${coords.code}.${size === 2 ? 'xy' : 'xyz'}/${coords.code}.${width(coords.type) === 4 ? 'w' : 'z'})`
      : coords.code;
    let compare: string | undefined;
    if (shadow) {
      // The reference is the last component; the coordinates are the ones before it.
      const t = this.temp(),
        n = size - 1;
      before = [...before, `let ${t}=${uv};`];
      compare = `${t}.${'xyzw'[n]}`;
      uv = n === 2 ? `${t}.xy` : `${t}.xyz`;
    }
    const at = size - (shadow ? 1 : 0);
    const flip = (c: string) =>
      this.flipY && kind !== 'samplerCube' && kind !== 'sampler3D'
        ? `vec${at}f(${c}.x,1.0-${c}.y${at === 3 ? `,${c}.z` : ''})`
        : c;
    const sample = this.host.sample;
    const options: { lod?: string; bias?: string; ddx?: string; ddy?: string; offset?: string; compare?: string } =
      compare ? { compare } : {};
    if (variant === 'Lod') options.lod = rest[0]!.code;
    else if (variant === 'Grad') {
      // A y flip reverses the y axis of the coordinates' derivatives too.
      const d = (x: Value) =>
        this.flipY && kind !== 'samplerCube' && kind !== 'sampler3D' ? `vec2f(${x.code}.x,-${x.code}.y)` : x.code;
      options.ddx = d(rest[0]!);
      options.ddy = d(rest[1]!);
    } else if (variant === 'Offset')
      options.offset = this.flipY ? `vec2i(${rest[0]!.code}.x,-${rest[0]!.code}.y)` : rest[0]!.code;
    if (rest.length > extra) options.bias = rest[extra]!.code;
    if (!sample) {
      // The transition contract's sample() reads the nearest texel of a one-level image: lod, bias and gradients
      // select nothing there, and an offset moves the coordinate by whole texels before the y flip.
      if (image!.type !== 'sampler2D') this.fail('Only sampler2D images can be read here');
      if (variant === 'Offset') uv = `(${uv}+vec2f(${rest[0]!.code})/vec2f(textureDimensions(${image!.code})))`;
      return value(`sample(${image!.code},${flip(uv)})`, 'vec4', before);
    }
    return value(sample(image!.code, image!.type, flip(uv), options), texelType(image!.type), before);
  }
  // texelFetch reads one texel by integer coordinates; textureSize is the level's size (8.8). Both are WGSL's own.
  private texel(n: string, v: Value[], before: string[]): Value {
    const [image, a] = v;
    if (!image || !Object.hasOwn(samplers, image.type)) this.fail(`${n} needs a sampler`);
    const many = this.picked(image, (e) => this.texel(n, [e, ...v.slice(1)], []), before);
    if (many) return many;
    const kind = dimensionOf(image.type);
    if (n === 'texelFetch' && image.type.endsWith('Shadow')) this.fail('texelFetch takes no shadow sampler');
    if (v.length !== (n === 'textureSize' ? 2 : 3)) this.fail(`${n} has the wrong number of arguments`);
    const level = this.convert(v.at(-1)!, 'int');
    const t = this.temp(),
      lod = this.temp();
    before = [...before, ...level.before];
    if (n === 'textureSize') {
      const type = kind === 'sampler2D' || kind === 'samplerCube' ? 'ivec2' : 'ivec3';
      const dims = `textureDimensions(${image!.code},${lod})`;
      return value(
        kind === 'sampler2DArray'
          ? `vec3<i32>(vec2<i32>(${dims}),i32(textureNumLayers(${image!.code})))`
          : `${wgsl(type)}(${dims})`,
        type,
        [...before, `let ${lod}=${level.code};`],
      );
    }
    if (kind === 'samplerCube') this.fail('texelFetch needs a 2D, 3D or array sampler');
    const coords = this.convert(a!, kind === 'sampler2D' ? 'ivec2' : 'ivec3');
    const prep = [...before, ...coords.before, `let ${t}=${coords.code};`, `let ${lod}=${level.code};`];
    // GLSL numbers rows from the bottom; the y flip numbers them from the top.
    const xy =
      this.flipY && kind !== 'sampler3D'
        ? `vec2i(${t}.x,i32(textureDimensions(${image!.code},${lod}).y)-1-${t}.y)`
        : `${t}.xy`;
    const code =
      kind === 'sampler2DArray'
        ? `textureLoad(${image!.code},${xy},${t}.z,${lod})`
        : kind === 'sampler3D'
          ? `textureLoad(${image!.code},${t},${lod})`
          : `textureLoad(${image!.code},${xy},${lod})`;
    return value(code, texelType(image.type), prep);
  }
  // Inverse of an N x N matrix through the adjugate over the determinant (cofactor expansion); GLSL ES 3.00 8.5
  // leaves a singular input undefined. WGSL has no inverse builtin.
  private inverse(n: number): string {
    const name = `margo_inverse${n}`;
    const t = `mat${n}x${n}<f32>`;
    if (n === 2)
      this.helpers.add(
        `fn ${name}(m:${t})->${t}{return ${t}(m[1][1],-m[0][1],-m[1][0],m[0][0])*(1.0/determinant(m));}`,
      );
    else {
      // Entry (c, r) of the inverse is the cofactor of entry (r, c) of m: the signed determinant of m without column r
      // and row c, over det(m).
      const minor = (col: number, row: number) => {
        const cols = [...Array(n).keys()].filter((i) => i !== col),
          rows = [...Array(n).keys()].filter((i) => i !== row);
        return `determinant(mat${n - 1}x${n - 1}<f32>(${cols.map((c) => `vec${n - 1}f(${rows.map((r) => `m[${c}][${r}]`).join(',')})`).join(',')}))`;
      };
      const cells: string[] = [];
      for (let c = 0; c < n; c++) for (let r = 0; r < n; r++) cells.push(`${(r + c) % 2 ? '-' : ''}${minor(r, c)}`);
      this.helpers.add(`fn ${name}(m:${t})->${t}{return ${t}(${cells.join(',')})*(1.0/determinant(m));}`);
    }
    return name;
  }
  private declarations(decls: Declaration[], global = false): string[] {
    return decls.map((d) => {
      // The name comes into scope after its initializer (4.2.2): `float ratio = ratio * 2.0;` reads the outer ratio.
      let init = d.init ? this.convert(this.expr(d.init), d.type) : undefined;
      const name = this.define(d.name, d.type);
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
  private arrayCount(name: string): number {
    const count = Number(name);
    if (!Number.isSafeInteger(count) || count < 1 || count > 16384)
      this.fail('Uniform array length must be in 1..16384');
    return count;
  }
  private components(type: string): number {
    const a = /^(.*)\[([^\]]+)\]$/.exec(type);
    return a
      ? this.arrayCount(a[2]!) * this.components(a[1]!)
      : type.startsWith('mat')
        ? shape(type)![0] * shape(type)![1]
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
    if (s.kind === 'switch') return this.switch(s);
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
  // GLSL ES 3.00 6.2 lets control fall from one case into the next; WGSL cases never fall through, so each WGSL
  // case holds its own statements and those of the cases it falls into, up to one that cannot complete normally.
  private switch(s: Statement): string[] {
    const selector = this.expr(s.expr!);
    if (selector.type !== 'int' && selector.type !== 'uint') this.fail('A switch selector is an int or uint scalar');
    const cases = s.cases ?? [];
    const ends = (body: Statement[]) => ['break', 'return', 'continue', 'discard'].includes(body.at(-1)?.kind ?? '');
    const clauses = cases.map((c, i) => {
      const body: Statement[] = [];
      for (let j = i; j < cases.length; j++) {
        body.push(...cases[j]!.body);
        if (ends(cases[j]!.body)) break;
      }
      const labels = c.labels.map((l) =>
        l === null ? 'default' : selector.type === 'uint' ? `${l >>> 0}u` : `i32(${l | 0})`,
      );
      return `case ${labels.join(',')}{${this.body(body)}}`;
    });
    if (!cases.some((c) => c.labels.includes(null))) clauses.push('default{}');
    return [...selector.before, `switch(${selector.code}){${clauses.join('\n')}}`];
  }
  emit(): string {
    const root = this.scopes[0]!;
    for (const [name, provided] of Object.entries(this.host.names)) root.set(name, provided);
    const structs = [...this.program.structs]
      .map(
        ([name, fields]) =>
          `struct ${identifier(name)}{${fields.map((f) => identifier(f.name) + ':' + wgsl(f.type)).join(',')}}`,
      )
      .join('\n');
    const globals = this.declarations(
      this.program.globals.filter((d) => d.name === 'gl_FragCoord' || !Object.hasOwn(this.host.names, d.name)),
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
          const params = fn.params.map(
            (p, i) =>
              `argument_${i}:${wgsl(p.type)}${this.host.sample && Object.hasOwn(samplers, p.type) ? `,argument_${i}s:sampler${p.type.endsWith('Shadow') ? '_comparison' : ''}${this.host.samplerMode ? `,argument_${i}m:u32` : ''}` : ''}`,
          );
          const locals = fn.params.map((p, i) => {
            if (Object.hasOwn(samplers, p.type)) {
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
    const want = this.host.entry;
    const entry = this.functions.find(
      (f) =>
        f.name === want.name &&
        f.type === want.type &&
        f.params.length === want.params.length &&
        f.params.every((p, i) => p.type === want.params[i]),
    );
    if (!entry) this.fail(this.host.missingEntry);
    return [
      structs,
      globals,
      results,
      this.host.prologue,
      [...this.helpers].join(NL),
      functions,
      this.host.epilogue(this.names.get(entry)!),
    ].join(NL);
  }
}
