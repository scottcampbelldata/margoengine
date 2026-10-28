// Constant-expression evaluation (W3C WGSL specification, sections 8 and 15.7): scalar conversions, operators and
// the numeric built-ins on folded values, with the shader-creation errors the specification requires (integer
// overflow, division by zero, non-finite float results, shifts past the bit width). Values are ConstValue trees
// typed by the expression that holds them.
import { WGSL_LIMITS } from './errors.js';
import type { ConstValue } from './ir.js';
import {
  AFLOAT,
  AINT,
  BOOL,
  elementOf,
  F16,
  F32,
  I32,
  type ScalarType,
  type Type,
  typeName,
  U32,
  vector,
} from './types.js';

/** A fault while folding: the checker turns it into a positioned WGSLError. */
export class ConstFault {
  constructor(
    readonly code: 'type' | 'limit',
    readonly detail: string,
  ) {}
}

/** Rounds a number to the nearest IEEE half-precision value (ties to even); overflow becomes Infinity. */
export function roundF16(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const a = Math.abs(x);
  let e = Math.floor(Math.log2(a));
  if (2 ** e > a) e--;
  if (2 ** (e + 1) <= a) e++;
  // Below 2^-14 halves are subnormal: one fixed step of 2^-24.
  const step = 2 ** (Math.max(e, -14) - 10),
    q = a / step;
  let r = Math.floor(q);
  const rest = q - r;
  if (rest > 0.5 || (rest === 0.5 && r % 2 === 1)) r++;
  const v = r * step;
  return Math.sign(x) * (v > 65504 ? Infinity : v);
}

/** Rounds/validates a scalar number to type `s`; throws ConstFault when it cannot be represented. */
export function toScalar(x: number, s: ScalarType, what = 'value'): number {
  switch (s.name) {
    case 'f32': {
      const v = Math.fround(x);
      if (!Number.isFinite(v)) throw new ConstFault('type', `The constant ${what} ${x} is not a finite f32`);
      return v;
    }
    case 'f16': {
      const v = roundF16(x);
      if (!Number.isFinite(v)) throw new ConstFault('type', `The constant ${what} ${x} is not a finite f16`);
      return v;
    }
    case 'abstract-float':
      if (!Number.isFinite(x)) throw new ConstFault('type', `The constant ${what} is not finite`);
      return x;
    case 'i32':
      if (!Number.isInteger(x) || x < -2147483648 || x > 2147483647)
        throw new ConstFault('type', `The constant ${what} ${x} does not fit in i32`);
      return x === 0 ? 0 : x; // integers have no negative zero
    case 'u32':
      if (!Number.isInteger(x) || x < 0 || x > 4294967295)
        throw new ConstFault('type', `The constant ${what} ${x} does not fit in u32`);
      return x === 0 ? 0 : x;
    case 'abstract-int':
      if (!Number.isSafeInteger(x))
        throw new ConstFault(
          'limit',
          `The abstract integer ${what} ${x} is outside the range this front end evaluates exactly (2^53); give it a type such as i32`,
        );
      return x === 0 ? 0 : x;
    case 'bool':
      return x;
  }
}

/** Parses a literal's source text: its type and value. */
export function literal(text: string, kind: 'int' | 'float' | 'bool'): { type: ScalarType; value: number | boolean } {
  if (kind === 'bool') return { type: BOOL, value: text === 'true' };
  const last = text[text.length - 1];
  if (kind === 'int') {
    const type = last === 'i' ? I32 : last === 'u' ? U32 : AINT,
      digits = type === AINT ? text : text.slice(0, -1),
      value = Number(digits);
    return { type, value: toScalar(value, type, `literal ${text}`) };
  }
  const isHex = /^0[xX]/.test(text);
  const type =
    last === 'f' && !isHex
      ? F32
      : last === 'h' && !(isHex && !/[pP]/.test(text))
        ? F16
        : isHex && /[pP][+-]?[0-9]+f$/.test(text)
          ? F32
          : AFLOAT;
  const body = type === AFLOAT ? text : text.slice(0, -1);
  return { type, value: toScalar(isHex ? hexFloat(body) : Number(body), type, `literal ${text}`) };
}

function hexFloat(text: string): number {
  const m = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?[0-9]+))?$/.exec(text);
  if (!m) return Number.NaN;
  const whole = m[1] || '0',
    frac = m[2] ?? '',
    exp = Number(m[3] ?? 0);
  return (Number.parseInt(whole + frac || '0', 16) / 16 ** frac.length) * 2 ** exp;
}

/** Converts a folded value to another type of the same shape (value conversion, WGSL section 17.1.2). */
export function convert(value: ConstValue, from: Type, to: Type): ConstValue {
  if (from.kind === 'struct' && to.kind === 'struct')
    return (value as ConstValue[]).map((v, i) => convert(v, from.members[i].type, to.members[i].type));
  if (Array.isArray(value)) {
    const fromElement = componentType(from),
      toElement = componentType(to);
    return value.map((v) => convert(v, fromElement, toElement));
  }
  const s = elementOf(to) as ScalarType,
    f = elementOf(from) as ScalarType;
  if (s.name === 'bool') return typeof value === 'boolean' ? value : value !== 0;
  const n = typeof value === 'boolean' ? (value ? 1 : 0) : (value as number);
  if (s.name === 'i32' || s.name === 'u32') {
    if (f.name === 'u32' && s.name === 'i32') return n | 0;
    if (f.name === 'i32' && s.name === 'u32') return n >>> 0;
    if (f.name === 'f32' || f.name === 'f16' || f.name === 'abstract-float') {
      // Float to integer: truncate toward zero, clamped to the integer range.
      const t = Math.trunc(n);
      return s.name === 'i32' ? Math.min(2147483520, Math.max(-2147483648, t)) : Math.min(4294967040, Math.max(0, t));
    }
  }
  return toScalar(n, s);
}

/** The type of one component of a composite type (vector element, matrix column, array element). */
export function componentType(t: Type): Type {
  if (t.kind === 'vector') return t.element;
  if (t.kind === 'matrix') return vector(t.rows, t.element);
  if (t.kind === 'array') return t.element;
  return t;
}

/** Scalars in one value of type `t` (for the constant-size limit); 1 for anything that is not a composite. */
function scalarsIn(t: Type): number {
  if (t.kind === 'vector') return t.size;
  if (t.kind === 'matrix') return t.columns * t.rows;
  if (t.kind === 'array') return (typeof t.count === 'number' ? t.count : 1) * scalarsIn(t.element);
  if (t.kind === 'struct') return t.members.reduce((n, m) => n + scalarsIn(m.type), 0);
  return 1;
}

/** A zero value of a constructible type. */
export function zero(t: Type): ConstValue {
  const n = scalarsIn(t);
  if (n > WGSL_LIMITS.constantElements)
    throw new ConstFault(
      'limit',
      `The constant ${typeName(t)} holds ${n} values, over the ${WGSL_LIMITS.constantElements} this front end evaluates; use a var`,
    );
  return zeroOf(t);
}

function zeroOf(t: Type): ConstValue {
  switch (t.kind) {
    case 'scalar':
      return t.name === 'bool' ? false : 0;
    case 'vector':
      return Array.from({ length: t.size }, () => zeroOf(t.element));
    case 'matrix':
      return Array.from({ length: t.columns }, () => zeroOf(vector(t.rows, t.element)));
    case 'array':
      if (typeof t.count !== 'number') throw new ConstFault('type', `${typeName(t)} has no zero value`);
      return Array.from({ length: t.count }, () => zeroOf(t.element));
    case 'struct':
      return t.members.map((m) => zeroOf(m.type));
    default:
      throw new ConstFault('type', `${typeName(t)} has no zero value`);
  }
}

const num = (v: ConstValue): number => v as number;

/** Applies a scalar binary operator; `s` is the operand element type, the result is checked for that type. */
function scalarBinary(op: string, a: number | boolean, b: number | boolean, s: ScalarType): number | boolean {
  if (op === '&&') return (a as boolean) && (b as boolean);
  if (op === '||') return (a as boolean) || (b as boolean);
  if (s.name === 'bool') {
    if (op === '&') return (a as boolean) && (b as boolean);
    if (op === '|') return (a as boolean) || (b as boolean);
    if (op === '==') return a === b;
    if (op === '!=') return a !== b;
  }
  const x = a as number,
    y = b as number;
  switch (op) {
    case '==':
      return x === y;
    case '!=':
      return x !== y;
    case '<':
      return x < y;
    case '>':
      return x > y;
    case '<=':
      return x <= y;
    case '>=':
      return x >= y;
  }
  const int = s.name === 'i32' || s.name === 'u32' || s.name === 'abstract-int';
  switch (op) {
    case '+':
      return toScalar(x + y, s, 'sum');
    case '-':
      return toScalar(x - y, s, 'difference');
    case '*':
      return toScalar(x * y, s, 'product');
    case '/':
      if (int) {
        if (y === 0) throw new ConstFault('type', 'Integer division by zero in a constant expression');
        return toScalar(Math.trunc(x / y), s, 'quotient');
      }
      return toScalar(x / y, s, 'quotient');
    case '%':
      if (int && y === 0) throw new ConstFault('type', 'Integer remainder by zero in a constant expression');
      if (s.name === 'i32' && x === -2147483648 && y === -1)
        throw new ConstFault('type', 'The remainder of the most negative i32 by -1 overflows in a constant expression');
      return toScalar(x % y, s, 'remainder');
    case '&':
      return s.name === 'u32' ? (x & y) >>> 0 : x & y;
    case '|':
      return s.name === 'u32' ? (x | y) >>> 0 : x | y;
    case '^':
      return s.name === 'u32' ? (x ^ y) >>> 0 : x ^ y;
    case '<<':
    case '>>': {
      const bits = s.name === 'abstract-int' ? 64 : 32;
      if (y < 0) throw new ConstFault('type', `Shift by ${y}: the shift amount must not be negative`);
      if (y >= bits) throw new ConstFault('type', `Shift by ${y} is not less than the ${bits}-bit width of ${s.name}`);
      if (op === '>>') return s.name === 'u32' ? x >>> y : Math.floor(x / 2 ** y);
      return toScalar(x * 2 ** y, s, 'shift');
    }
  }
  throw new ConstFault('type', `Operator ${op} is not defined on ${s.name}`);
}

/**
 * Folds `left op right` for scalars, vectors (component-wise, a scalar side broadcast) and the matrix products.
 * `lt` and `rt` are the operand types after conversion; `result` is the result type.
 */
export function binary(op: string, left: ConstValue, right: ConstValue, lt: Type, rt: Type, result: Type): ConstValue {
  if (op === '*' && (lt.kind === 'matrix' || rt.kind === 'matrix')) return matrixProduct(left, right, lt, rt);
  if ((op === '+' || op === '-') && lt.kind === 'matrix')
    return (left as ConstValue[]).map((c, i) =>
      binary(op, c, (right as ConstValue[])[i], componentType(lt), componentType(rt), componentType(result)),
    );
  const s = (elementOf(lt) ?? elementOf(rt)) as ScalarType;
  if (Array.isArray(left) || Array.isArray(right)) {
    const n = Array.isArray(left) ? left.length : (right as ConstValue[]).length;
    const at = (v: ConstValue, i: number) => (Array.isArray(v) ? v[i] : v);
    return Array.from({ length: n }, (_, i) => scalarBinary(op, at(left, i) as number, at(right, i) as number, s));
  }
  return scalarBinary(op, left as number | boolean, right as number | boolean, s);
}

function matrixProduct(left: ConstValue, right: ConstValue, lt: Type, rt: Type): ConstValue {
  const e = (elementOf(lt) ?? elementOf(rt)) as ScalarType,
    round = (x: number) => toScalar(x, e, 'matrix product');
  const cols = (m: ConstValue) => m as number[][];
  if (lt.kind === 'matrix' && rt.kind !== 'matrix' && rt.kind !== 'vector')
    return cols(left).map((c) => c.map((x) => round(x * num(right))));
  if (rt.kind === 'matrix' && lt.kind !== 'matrix' && lt.kind !== 'vector')
    return cols(right).map((c) => c.map((x) => round(x * num(left))));
  if (lt.kind === 'matrix' && rt.kind === 'vector') {
    const m = cols(left),
      v = right as number[];
    return Array.from({ length: m[0].length }, (_, r) => round(m.reduce((sum, c, k) => sum + c[r] * v[k], 0)));
  }
  if (lt.kind === 'vector' && rt.kind === 'matrix') {
    const v = left as number[];
    return cols(right).map((c) => round(c.reduce((sum, x, k) => sum + x * v[k], 0)));
  }
  const a = cols(left),
    b = cols(right);
  return b.map((bc) =>
    Array.from({ length: a[0].length }, (_, r) => round(a.reduce((sum, ac, k) => sum + ac[r] * bc[k], 0))),
  );
}

/** Folds a unary operator. */
export function unary(op: '-' | '!' | '~', v: ConstValue, t: Type): ConstValue {
  if (Array.isArray(v)) return v.map((x) => unary(op, x, componentType(t)));
  const s = elementOf(t) as ScalarType;
  if (op === '!') return !v;
  if (op === '-') return toScalar(-(v as number), s, 'negation');
  return s.name === 'u32' ? ~(v as number) >>> 0 : ~(v as number);
}

const map1 = (v: ConstValue, f: (x: number) => number): ConstValue =>
  Array.isArray(v) ? v.map((x) => map1(x, f)) : f(v as number);
const zip = (vs: readonly ConstValue[], f: (...x: number[]) => number): ConstValue =>
  Array.isArray(vs[0])
    ? (vs[0] as ConstValue[]).map((_, i) =>
        zip(
          vs.map((v) => (Array.isArray(v) ? v[i] : v)),
          f,
        ),
      )
    : f(...(vs as number[]));
const flat = (v: ConstValue): number[] => (Array.isArray(v) ? v.flatMap(flat) : [v as number]);
const dotOf = (a: ConstValue, b: ConstValue) => flat(a).reduce((s, x, i) => s + x * flat(b)[i], 0);

const roundEven = (x: number) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
};

const ELEMENTWISE: Record<string, (...x: number[]) => number> = {
  // abs of the most negative i32 is itself (two's complement); the check below keeps every other result in range.
  abs: (x) => (x === -2147483648 ? x : Math.abs(x)),
  acos: Math.acos,
  acosh: Math.acosh,
  asin: Math.asin,
  asinh: Math.asinh,
  atan: Math.atan,
  atanh: Math.atanh,
  atan2: Math.atan2,
  ceil: Math.ceil,
  cos: Math.cos,
  cosh: Math.cosh,
  degrees: (x) => (x * 180) / Math.PI,
  exp: Math.exp,
  exp2: (x) => 2 ** x,
  floor: Math.floor,
  fract: (x) => x - Math.floor(x),
  inverseSqrt: (x) => 1 / Math.sqrt(x),
  log: Math.log,
  log2: Math.log2,
  radians: (x) => (x * Math.PI) / 180,
  round: roundEven,
  saturate: (x) => Math.min(1, Math.max(0, x)),
  sign: Math.sign,
  sin: Math.sin,
  sinh: Math.sinh,
  sqrt: Math.sqrt,
  tan: Math.tan,
  tanh: Math.tanh,
  trunc: Math.trunc,
  max: Math.max,
  min: Math.min,
  clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
  fma: (a, b, c) => a * b + c,
  mix: (a, b, t) => a * (1 - t) + b * t,
  pow: Math.pow,
  step: (edge, x) => (edge <= x ? 1 : 0),
  smoothstep: (lo, hi, x) => {
    const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
    return t * t * (3 - 2 * t);
  },
  countOneBits: (x) => {
    let n = x >>> 0,
      c = 0;
    while (n) {
      c += n & 1;
      n >>>= 1;
    }
    return c;
  },
};

/** Built-ins the evaluator folds. Others leave the expression unfolded (a runtime expression). */
export const FOLDABLE: ReadonlySet<string> = new Set([
  ...Object.keys(ELEMENTWISE),
  'select',
  'all',
  'any',
  'dot',
  'cross',
  'length',
  'distance',
  'normalize',
  'determinant',
  'transpose',
  'ldexp',
  'modf',
  'frexp',
  'reflect',
  'faceForward',
]);

/**
 * Folds built-in `name` on folded arguments (already converted to `params`); `result` is the call's type. The result
 * is checked against its type, so a constant `sqrt(-1.0)` fails like the specification says.
 */
export function builtin(name: string, args: readonly ConstValue[], params: readonly Type[], result: Type): ConstValue {
  const e = elementOf(result);
  const check = (v: ConstValue): ConstValue =>
    e ? map1(v, (x) => (typeof x === 'number' ? toScalar(x, e, `${name}()`) : x)) : v;
  const f = ELEMENTWISE[name];
  if (f) {
    if (name === 'mix' && params[0].kind === 'vector' && params[2].kind === 'scalar')
      return check(zip([args[0], args[1], (args[0] as ConstValue[]).map(() => args[2])], f));
    return check(zip(args, f));
  }
  switch (name) {
    case 'select':
      if (Array.isArray(args[2]))
        return (args[2] as boolean[]).map((c, i) => (c ? (args[1] as ConstValue[])[i] : (args[0] as ConstValue[])[i]));
      return args[2] ? args[1] : args[0];
    case 'all':
      return Array.isArray(args[0]) ? (args[0] as boolean[]).every(Boolean) : (args[0] as boolean);
    case 'any':
      return Array.isArray(args[0]) ? (args[0] as boolean[]).some(Boolean) : (args[0] as boolean);
    case 'dot':
      return check(dotOf(args[0], args[1]));
    case 'length':
      return check(Math.sqrt(dotOf(args[0], args[0])));
    case 'distance': {
      const d = zip([args[0], args[1]], (a, b) => a - b);
      return check(Math.sqrt(dotOf(d, d)));
    }
    case 'normalize': {
      const l = Math.sqrt(dotOf(args[0], args[0]));
      return check(map1(args[0], (x) => x / l));
    }
    case 'cross': {
      const [a, b] = args as number[][];
      return check([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
    }
    case 'transpose': {
      const m = args[0] as number[][];
      return m[0].map((_, r) => m.map((c) => c[r]));
    }
    case 'determinant':
      return check(det(args[0] as number[][]));
    case 'ldexp':
      return check(zip([args[0], args[1]], (x, k) => x * 2 ** k));
    case 'modf':
      return [map1(args[0], (x) => x - Math.trunc(x)), map1(args[0], Math.trunc)];
    case 'frexp':
      return [map1(args[0], (x) => frexp(x)[0]), map1(args[0], (x) => frexp(x)[1])];
    case 'reflect': {
      // e1 - 2 * dot(e2, e1) * e2
      const d = dotOf(args[0], args[1]);
      return check(zip([args[0], args[1]], (i, n) => i - 2 * d * n));
    }
    case 'faceForward':
      // e1 if dot(e2, e3) < 0, else -e1
      return check(dotOf(args[1], args[2]) < 0 ? args[0] : map1(args[0], (x) => -x));
  }
  throw new ConstFault('limit', `${name}() cannot be folded by this front end`);
}

/** [fraction, exponent] with x = fraction * 2^exponent and 0.5 <= |fraction| < 1; [0, 0] for zero. */
function frexp(x: number): [number, number] {
  if (x === 0 || !Number.isFinite(x)) return [x, 0];
  let e = Math.floor(Math.log2(Math.abs(x))) + 1,
    f = x / 2 ** e;
  // log2 can be off by one ulp near powers of two.
  if (Math.abs(f) >= 1) {
    f /= 2;
    e++;
  } else if (Math.abs(f) < 0.5) {
    f *= 2;
    e--;
  }
  return [f, e];
}

function det(m: number[][]): number {
  if (m.length === 2) return m[0][0] * m[1][1] - m[1][0] * m[0][1];
  let sum = 0;
  for (let c = 0; c < m.length; c++) {
    const minor = m.filter((_, i) => i !== c).map((col) => col.slice(1));
    sum += (c % 2 ? -1 : 1) * m[c][0] * det(minor);
  }
  return sum;
}

/** Bit reinterpretation of folded 32-bit values (bitcast). */
export function bitcast(v: ConstValue, from: Type, to: Type): ConstValue {
  if (Array.isArray(v)) return v.map((x) => bitcast(x, componentType(from), componentType(to)));
  const f = elementOf(from) as ScalarType,
    t = elementOf(to) as ScalarType,
    buf = new DataView(new ArrayBuffer(4));
  if (f.name === 'f32') buf.setFloat32(0, v as number);
  else if (f.name === 'i32' || f.name === 'abstract-int') buf.setInt32(0, v as number);
  else buf.setUint32(0, v as number);
  if (t.name === 'f32') {
    const x = buf.getFloat32(0);
    if (!Number.isFinite(x))
      throw new ConstFault('type', 'bitcast of a constant to f32 gives a value that is not finite');
    return x;
  }
  return t.name === 'i32' ? buf.getInt32(0) : buf.getUint32(0);
}
