// The stateless operations of KHR_interactivity: math, conversions and reference equality. Every value is a number, a
// boolean, a reference, or a plain array of numbers for vectors and column-major matrices.
import { composeMatrix } from '@margoengine/math/mat4';
import { rotationToQuaternion } from '@margoengine/math/quat';

/** An opaque reference of a behaviour graph: a glTF object, a delay or an event, named by its JSON pointer. */
export interface GraphRef {
  readonly path: string;
}
/** A value on a socket: `bool`, `int` and `float` as themselves, vectors and column-major matrices as arrays. */
export type GraphValue = boolean | number | number[] | GraphRef | null;
type Outs = Record<string, string>;
/** A stateless operation: `resolve` maps input types to output types, or undefined for an overload it lacks. */
export interface PureOp {
  inputs: string[];
  resolve(types: string[]): Outs | undefined;
  /** The `value` output, or a record of all outputs when `multi`. */
  run(values: any[], types: string[]): any;
  multi?: boolean;
}

const scalars = ['float', 'float2', 'float3', 'float4'],
  vectors = scalars.slice(1),
  matrices = ['float2x2', 'float3x3', 'float4x4'],
  numeric = [...scalars, ...matrices],
  near = 1e-9;
const same =
  (list: string[], out?: string) =>
  (types: string[]): Outs | undefined =>
    list.includes(types[0]) && types.every((t) => t === types[0]) ? { value: out ?? types[0] } : undefined;
const exact =
  (inputs: string, outs: Outs | string) =>
  (types: string[]): Outs | undefined =>
    types.join(' ') === inputs ? (typeof outs === 'string' ? { value: outs } : outs) : undefined;
const zip =
  (f: (...a: number[]) => number) =>
  (v: any[]): any =>
    Array.isArray(v[0]) ? v[0].map((_: number, i: number) => f(...v.map((a) => a[i]))) : f(...v);

export const ops = new Map<string, PureOp>();
const def = (name: string, inputs: string, resolve: PureOp['resolve'], run: PureOp['run'], multi?: boolean) =>
  ops.set(name, { inputs: inputs ? inputs.split(' ') : [], resolve, run, multi });
/** A component-wise float operation with an optional int form. */
const wise = (name: string, inputs: string, list: string[], f: (...a: number[]) => number, int?: (...a: number[]) => number) => {
  const float = zip(f);
  def(name, inputs, same(int ? [...list, 'int'] : list), (v, t) => (t[0] === 'int' ? int!(...v) : float(v)));
};

for (const [name, value] of [
  ['E', Math.E],
  ['Pi', Math.PI],
  ['Tau', 2 * Math.PI],
  ['Inf', Infinity],
  ['NaN', NaN],
] as const)
  def(`math/${name}`, '', () => ({ value: 'float' }), () => value);

const clamp = (a: number, b: number, c: number) => Math.min(Math.max(a, Math.min(b, c)), Math.max(b, c));
const saturate = (a: number) => Math.min(Math.max(a, 0), 1);
wise('math/abs', 'a', numeric, Math.abs, (a) => Math.abs(a) | 0);
wise('math/sign', 'a', numeric, Math.sign, Math.sign);
wise('math/trunc', 'a', numeric, Math.trunc);
wise('math/floor', 'a', numeric, Math.floor);
wise('math/ceil', 'a', numeric, Math.ceil);
wise('math/round', 'a', numeric, (a) => (a < 0 ? -Math.round(-a) : Math.round(a)));
wise('math/fract', 'a', numeric, (a) => a - Math.floor(a));
wise('math/neg', 'a', numeric, (a) => -a, (a) => -a | 0);
wise('math/add', 'a b', numeric, (a, b) => a + b, (a, b) => (a + b) | 0);
wise('math/sub', 'a b', numeric, (a, b) => a - b, (a, b) => (a - b) | 0);
wise('math/mul', 'a b', numeric, (a, b) => a * b, Math.imul);
wise('math/div', 'a b', numeric, (a, b) => a / b, (a, b) => (b ? (a / b) | 0 : 0));
wise('math/rem', 'a b', numeric, (a, b) => a % b, (a, b) => (b ? (a % b) | 0 : 0));
wise('math/min', 'a b', numeric, Math.min, Math.min);
wise('math/max', 'a b', numeric, Math.max, Math.max);
wise('math/clamp', 'a b c', numeric, clamp, clamp);
wise('math/saturate', 'a', numeric, saturate);
wise('math/mix', 'a b c', numeric, (a, b, c) => (1 - c) * a + c * b);
wise('math/smoothStep', 'a b c', scalars, (a, b, c) => {
  const t = saturate((c - Math.min(a, b)) / Math.abs(b - a));
  return t * t * (3 - 2 * t);
});
for (const [name, f] of Object.entries({
  rad: (a: number) => (a * Math.PI) / 180,
  deg: (a: number) => (a * 180) / Math.PI,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: Math.atanh,
  exp: Math.exp,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
}))
  wise(`math/${name}`, 'a', scalars, f);
wise('math/atan2', 'a b', scalars, Math.atan2);
wise('math/pow', 'a b', scalars, Math.pow);

const equal = (a: any, b: any) => (Array.isArray(a) ? a.every((x: number, i: number) => x === b[i]) : a === b);
def('math/eq', 'a b', same([...numeric, 'int', 'bool'], 'bool'), ([a, b]) => equal(a, b));
const compare = (name: string, f: (a: number, b: number) => boolean) =>
  def(`math/${name}`, 'a b', same(['float', 'int'], 'bool'), ([a, b]) => f(a, b));
compare('lt', (a, b) => a < b);
compare('le', (a, b) => a <= b);
compare('gt', (a, b) => a > b);
compare('ge', (a, b) => a >= b);
def('math/isNaN', 'a', exact('float', 'bool'), ([a]) => Number.isNaN(a));
def('math/isInf', 'a', exact('float', 'bool'), ([a]) => a === Infinity || a === -Infinity);
def(
  'math/select',
  'condition a b',
  (t) => (t[0] === 'bool' && t[1] === t[2] ? { value: t[1] } : undefined),
  ([condition, a, b]) => (condition ? a : b),
);

const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scaled = (a: number[], k: number) => a.map((x) => x * k);
const normal = (a: number[]) => scaled(a, 1 / Math.hypot(...a));
const blend = (a: number[], b: number[], c: number) => a.map((x, i) => (1 - c) * x + c * b[i]);
/** A unit vector at right angles to `a`. */
const perpendicular = (a: number[]) =>
  normal(cross(a, Math.abs(a[0]) < Math.abs(a[1]) ? [1, 0, 0] : [0, 1, 0]));
/** Rotates `a` by the unit quaternion `r`, as the specification writes it. */
const rotate = (a: number[], r: number[]) => {
  const axis = r.slice(0, 3),
    once = cross(axis, a),
    twice = cross(axis, once);
  return a.map((x, i) => x + 2 * (twice[i] + r[3] * once[i]));
};
export const quatMul = (a: number[], b: number[]) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] + a[1] * b[3] + a[2] * b[0] - a[0] * b[2],
  a[3] * b[2] + a[2] * b[3] + a[0] * b[1] - a[1] * b[0],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
/** Spherical interpolation of unit quaternions, `c` unclamped. */
export function quatSlerp(a: number[], b: number[], c: number): number[] {
  let d = dot(a, b),
    other = b;
  if (d < 0) {
    d = -d;
    other = scaled(b, -1);
  }
  if (d > 1 - near) return a.map((x, i) => x * (1 - c) + other[i] * c);
  const omega = Math.acos(d),
    ka = Math.sin(omega * (1 - c)) / Math.sin(omega),
    kb = Math.sin(omega * c) / Math.sin(omega);
  return a.map((x, i) => x * ka + other[i] * kb);
}
const slerp = ([a, b, c]: [number[], number[], number]) => {
  const la = Math.hypot(...a),
    lb = Math.hypot(...b);
  if (la < near || lb < near) return blend(a, b, c);
  const ua = scaled(a, 1 / la),
    ub = scaled(b, 1 / lb),
    length = (1 - c) * la + c * lb;
  if (a.length === 2) {
    let theta = Math.acos(Math.min(1, Math.max(-1, dot(ua, ub))));
    if (ua[0] * ub[1] - ua[1] * ub[0] < 0) theta = -theta;
    const cos = Math.cos(c * theta),
      sin = Math.sin(c * theta);
    return [(ua[0] * cos - ua[1] * sin) * length, (ua[0] * sin + ua[1] * cos) * length];
  }
  const d = dot(ua, ub);
  if (d > 1 - near) return blend(a, b, c);
  const axis = d < -1 + near ? perpendicular(ua) : normal(cross(ua, ub)),
    half = (c * Math.acos(Math.min(1, Math.max(-1, d)))) / 2;
  return scaled(rotate(ua, [...scaled(axis, Math.sin(half)), Math.cos(half)]), length);
};
def('math/length', 'a', same(vectors, 'float'), ([a]) => Math.hypot(...a));
def(
  'math/normalize',
  'a',
  (t) => (vectors.includes(t[0]) ? { value: t[0], isValid: 'bool' } : undefined),
  ([a]) => {
    const length = Math.hypot(...a),
      isValid = length > 0 && length < Infinity;
    return { value: isValid ? scaled(a, 1 / length) : a.map(() => 0), isValid };
  },
  true,
);
def('math/dot', 'a b', same(vectors, 'float'), ([a, b]) => dot(a, b));
def('math/cross', 'a b', same(['float3'], 'float3'), ([a, b]) => cross(a, b));
def('math/rotate2D', 'a angle', exact('float2 float', 'float2'), ([a, angle]) => {
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  return [a[0] * cos - a[1] * sin, a[0] * sin + a[1] * cos];
});
def('math/rotate3D', 'a rotation', exact('float3 float4', 'float3'), ([a, r]) => rotate(a, r));
def(
  'math/transform',
  'a b',
  (t) => (vectors.includes(t[0]) && t[1] === `${t[0]}x${t[0].slice(-1)}` ? { value: t[0] } : undefined),
  ([a, b]) => a.map((_: number, r: number) => a.reduce((sum: number, x: number, c: number) => sum + b[c * a.length + r] * x, 0)),
);
def(
  'math/slerp',
  'a b c',
  (t) => (t[0] === t[1] && (t[0] === 'float2' || t[0] === 'float3') && t[2] === 'float' ? { value: t[0] } : undefined),
  (v) => slerp(v as [number[], number[], number]),
);

const size = (m: number[]) => Math.sqrt(m.length);
function determinant(m: number[]): number {
  const n = size(m);
  if (n === 1) return m[0];
  let sum = 0;
  for (let r = 0; r < n; r++) sum += (r % 2 ? -1 : 1) * m[r] * determinant(minor(m, n, 0, r));
  return sum;
}
/** `m` without column `col` and row `row`. */
const minor = (m: number[], n: number, col: number, row: number) =>
  m.filter((_, i) => Math.floor(i / n) !== col && i % n !== row);
def('math/transpose', 'a', same(matrices), ([a]) => {
  const n = size(a);
  return a.map((_: number, i: number) => a[(i % n) * n + Math.floor(i / n)]);
});
def('math/determinant', 'a', same(matrices, 'float'), ([a]) => determinant(a));
def(
  'math/inverse',
  'a',
  (t) => (matrices.includes(t[0]) ? { value: t[0], isValid: 'bool' } : undefined),
  ([a]) => {
    const whole = determinant(a),
      n = size(a);
    if (!Number.isFinite(whole) || whole === 0) return { value: a.map(() => 0), isValid: false };
    const value = a.map((_: number, i: number) => {
      const col = Math.floor(i / n),
        row = i % n;
      return (((col + row) % 2 ? -1 : 1) * determinant(minor(a, n, row, col))) / whole;
    });
    return { value, isValid: true };
  },
  true,
);
def('math/matMul', 'a b', same(matrices), ([a, b]) => {
  const n = size(a);
  return a.map((_: number, i: number) => {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += a[k * n + (i % n)] * b[Math.floor(i / n) * n + k];
    return sum;
  });
});
def('math/matCompose', 'translation rotation scale', exact('float3 float4 float3', 'float4x4'), ([t, r, s]) =>
  Array.from(composeMatrix(t, r, s, new Float64Array(16))),
);
/** The translation, rotation and scale of a 4x4 matrix, as `math/matDecompose` defines them. */
function decompose(a: number[]): { translation: number[]; rotation: number[]; scale: number[] } {
  const translation = a.slice(12, 15);
  let [x, y, z] = [0, 4, 8].map((c) => Math.hypot(a[c], a[c + 1], a[c + 2]));
  if (![x, y, z].every((s) => Number.isFinite(s) && s !== 0))
    return { translation, rotation: [0, 0, 0, 1], scale: [x, y, z] };
  if (determinant([a[0], a[1], a[2], a[4], a[5], a[6], a[8], a[9], a[10]]) < 0) x = -x;
  return { translation, rotation: rotationToQuaternion(a, [0, 0, 0, 0], x, y, z), scale: [x, y, z] };
}
def(
  'math/matDecompose',
  'a',
  (t) => (t[0] === 'float4x4' ? { translation: 'float3', rotation: 'float4', scale: 'float3' } : undefined),
  ([a]) => decompose(a),
  true,
);

def('math/quatConjugate', 'a', exact('float4', 'float4'), ([a]) => [-a[0], -a[1], -a[2], a[3]]);
def('math/quatMul', 'a b', exact('float4 float4', 'float4'), ([a, b]) => quatMul(a, b));
def('math/quatAngleBetween', 'a b', exact('float4 float4', 'float'), ([a, b]) => 2 * Math.acos(dot(a, b)));
def('math/quatFromAxisAngle', 'axis angle', exact('float3 float', 'float4'), ([axis, angle]) => [
  ...scaled(axis, Math.sin(0.5 * angle)),
  Math.cos(0.5 * angle),
]);
def(
  'math/quatToAxisAngle',
  'a',
  exact('float4', { axis: 'float3', angle: 'float' }),
  ([a]) => {
    if (Math.abs(Math.abs(a[3]) - 1) < near) return { axis: [1, 0, 0], angle: 0 };
    return { axis: scaled(a.slice(0, 3), 1 / Math.sqrt(1 - a[3] * a[3])), angle: 2 * Math.acos(a[3]) };
  },
  true,
);
def('math/quatFromDirections', 'a b', exact('float3 float3', 'float4'), ([a, b]) => {
  const c = dot(a, b);
  if (c > 1 - near) return [0, 0, 0, 1];
  if (c < -1 + near) return [...perpendicular(a), 0];
  return [...scaled(normal(cross(a, b)), Math.sqrt(0.5 - 0.5 * c)), Math.sqrt(0.5 + 0.5 * c)];
});
def('math/quatFromUpForward', 'up forward', exact('float3 float3', 'float4'), ([up, forward]) => {
  const across = cross(up, forward),
    s = Math.hypot(...across) < near ? perpendicular(forward) : normal(across),
    t = cross(forward, s);
  return rotationToQuaternion([...s, 0, ...t, 0, ...forward], [0, 0, 0, 0]);
});
def('math/quatSlerp', 'a b c', exact('float4 float4 float', 'float4'), ([a, b, c]) => quatSlerp(a, b, c));

const letters = 'abcdefghijklmnop';
for (const [name, type, count] of [
  ['2', 'float2', 2],
  ['3', 'float3', 3],
  ['4', 'float4', 4],
  ['2x2', 'float2x2', 4],
  ['3x3', 'float3x3', 9],
  ['4x4', 'float4x4', 16],
] as const) {
  const inputs = [...letters.slice(0, count)].join(' ');
  def(`math/combine${name}`, inputs, exact(Array(count).fill('float').join(' '), type), (v) => v.slice());
  const outs = Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), 'float']));
  def(`math/extract${name}`, 'a', exact(type, outs), ([a]) => ({ ...a }), true);
}

const bits = (name: string, int: (a: number, b: number) => number, bool: (a: boolean, b: boolean) => boolean) =>
  def(`math/${name}`, 'a b', same(['int', 'bool']), ([a, b], t) => (t[0] === 'int' ? int(a, b) : bool(a, b)));
def('math/not', 'a', same(['int', 'bool']), ([a], t) => (t[0] === 'int' ? ~a : !a));
bits('and', (a, b) => a & b, (a, b) => a && b);
bits('or', (a, b) => a | b, (a, b) => a || b);
bits('xor', (a, b) => a ^ b, (a, b) => a !== b);
const ints = (name: string, inputs: string, f: (...a: number[]) => number) =>
  def(`math/${name}`, inputs, same(['int']), (v) => f(...v));
ints('asr', 'a b', (a, b) => a >> b);
ints('lsl', 'a b', (a, b) => a << b);
ints('clz', 'a', Math.clz32);
ints('ctz', 'a', (a) => (a ? 31 - Math.clz32(a & -a) : 32));
ints('popcnt', 'a', (a) => {
  let count = 0;
  for (let v = a; v; v &= v - 1) count++;
  return count;
});

const row = (m: number[], a: number, b: number, c: number) => m[0] * a + m[1] * b + m[2] * c;
const threeFloats = 'float float float';
def(
  'math/rgbToOkLCh',
  'r g b',
  exact(threeFloats, { l: 'float', c: 'float', h: 'float' }),
  ([r, g, b]) => {
    const l = Math.cbrt(row([0.4122214708, 0.5363325363, 0.0514459929], r, g, b)),
      m = Math.cbrt(row([0.2119034982, 0.6806995451, 0.1073969566], r, g, b)),
      s = Math.cbrt(row([0.0883024619, 0.2817188376, 0.6299787005], r, g, b)),
      x = row([1.9779984951, -2.428592205, 0.4505937099], l, m, s),
      y = row([0.0259040371, 0.7827717662, -0.808675766], l, m, s);
    return {
      l: row([0.2104542553, 0.793617785, -0.0040720468], l, m, s),
      c: Math.sqrt(x * x + y * y),
      h: Math.atan2(y, x),
    };
  },
  true,
);
def(
  'math/rgbFromOkLCh',
  'l c h',
  exact(threeFloats, { r: 'float', g: 'float', b: 'float' }),
  ([l, c, h]) => {
    const x = c * Math.cos(h),
      y = c * Math.sin(h),
      p = row([1, 0.3963377774, 0.2158037573], l, x, y) ** 3,
      q = row([1, -0.1055613458, -0.0638541728], l, x, y) ** 3,
      s = row([1, -0.0894841775, -1.291485548], l, x, y) ** 3;
    return {
      r: row([4.0767416621, -3.3077115913, 0.2309699292], p, q, s),
      g: row([-1.2684380046, 2.6097574011, -0.3413193965], p, q, s),
      b: row([-0.0041960863, -0.7034186147, 1.707614701], p, q, s),
    };
  },
  true,
);

def('ref/eq', 'a b', exact('ref ref', 'bool'), ([a, b]) => a === b);
const convert = (name: string, from: string, to: string, f: (a: any) => GraphValue) =>
  def(`type/${name}`, 'a', exact(from, to), ([a]) => f(a));
convert('boolToInt', 'bool', 'int', (a) => (a ? 1 : 0));
convert('boolToFloat', 'bool', 'float', (a) => (a ? 1 : 0));
convert('intToBool', 'int', 'bool', (a) => a !== 0);
convert('intToFloat', 'int', 'float', (a) => a + 0);
convert('floatToBool', 'float', 'bool', (a) => !!a);
convert('floatToInt', 'float', 'int', (a) => a | 0);
