// Clean-room interpreter for the OGC 3D Tiles styling language. No JavaScript evaluation or host object access.
import { MargoError } from '@margoengine/math/errors';

export type Value = unknown;
export type Read = (name: string) => Value;
export type Expression = (read: Read) => Value;
class Vector extends Array<number> {}
const fail = (why: string): never => {
  throw new MargoError('state', `Tile style: ${why}; use an OGC 3D Tiles style expression`);
};
const number = (v: Value): number => (typeof v === 'number' ? v : fail('expected a number'));
const boolean = (v: Value): boolean => (typeof v === 'boolean' ? v : fail('expected a boolean'));
const string = (v: Value): string =>
  v instanceof Vector ? `(${v.join(', ')})` : Array.isArray(v) ? `[${v.map(string).join(', ')}]` : String(v);
function numeric(fn: (...n: number[]) => number, values: Value[]): Value {
  const vector = values.find((v) => v instanceof Vector) as Vector | undefined;
  if (!vector) return fn(...values.map(number));
  if (values.some((v) => v instanceof Vector && v.length !== vector.length)) fail('vector dimensions differ');
  return Vector.from(vector, (_, i) => fn(...values.map((v) => number(v instanceof Vector ? v[i] : v))));
}
function member(v: Value, key: Value): Value {
  if (v instanceof Vector && typeof key === 'string' && 'xyzwrgba'.includes(key) && key.length === 1)
    return v['xyzw'.includes(key) ? 'xyzw'.indexOf(key) : 'rgba'.indexOf(key)];
  if (v !== null && typeof v === 'object' && Object.hasOwn(v, String(key)))
    return (v as Record<string, Value>)[String(key)];
  return undefined;
}
function variable(path: string, read: Read): Value {
  if (!/^(?:[^.\[\]\s]+)(?:(?:\.[^.\[\]\s]+)|(?:\[(?:'[^']*'|"[^"]*"|\d+)\]))*$/.test(path))
    fail('invalid property path');
  const parts = path.match(/(?:[^.\[\]\s]+)|(?:\[(?:'[^']*'|"[^"]*"|\d+)\])/g);
  const names = parts!.map((p) => (p.startsWith('[') ? p.slice(1, -1).replace(/^['"]|['"]$/g, '') : p));
  if (names.length > 1 && names[0] === 'feature') names.shift();
  const root = names.shift()!;
  let value = read(root);
  if (['POSITION', 'POSITION_ABSOLUTE', 'NORMAL', 'COLOR'].includes(root) && Array.isArray(value))
    value = Vector.from(value);
  for (const name of names) value = member(value, name);
  return value;
}
const math: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  cos: Math.cos,
  sin: Math.sin,
  tan: Math.tan,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  atan2: Math.atan2,
  radians: (x) => (x * Math.PI) / 180,
  degrees: (x) => (x * 180) / Math.PI,
  sign: Math.sign,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  exp: Math.exp,
  log: Math.log,
  exp2: (x) => 2 ** x,
  log2: Math.log2,
  fract: (x) => x - Math.floor(x),
  pow: Math.pow,
  min: Math.min,
  max: Math.max,
  clamp: (x, a, b) => Math.max(a, Math.min(b, x)),
  mix: (a, b, t) => a * (1 - t) + b * t,
};
// CSS named colours are standard data, authored here from CSS Color 3 (not an engine's table).
const named: Record<string, string> = {
  black: '000000',
  silver: 'c0c0c0',
  gray: '808080',
  white: 'ffffff',
  maroon: '800000',
  red: 'ff0000',
  purple: '800080',
  fuchsia: 'ff00ff',
  green: '008000',
  lime: '00ff00',
  olive: '808000',
  yellow: 'ffff00',
  navy: '000080',
  blue: '0000ff',
  teal: '008080',
  aqua: '00ffff',
  orange: 'ffa500',
  aliceblue: 'f0f8ff',
  antiquewhite: 'faebd7',
  aquamarine: '7fffd4',
  azure: 'f0ffff',
  beige: 'f5f5dc',
  bisque: 'ffe4c4',
  blanchedalmond: 'ffebcd',
  blueviolet: '8a2be2',
  brown: 'a52a2a',
  burlywood: 'deb887',
  cadetblue: '5f9ea0',
  chartreuse: '7fff00',
  chocolate: 'd2691e',
  coral: 'ff7f50',
  cornflowerblue: '6495ed',
  cornsilk: 'fff8dc',
  crimson: 'dc143c',
  cyan: '00ffff',
  darkblue: '00008b',
  darkcyan: '008b8b',
  darkgoldenrod: 'b8860b',
  darkgray: 'a9a9a9',
  darkgreen: '006400',
  darkkhaki: 'bdb76b',
  darkmagenta: '8b008b',
  darkolivegreen: '556b2f',
  darkorange: 'ff8c00',
  darkorchid: '9932cc',
  darkred: '8b0000',
  darksalmon: 'e9967a',
  darkseagreen: '8fbc8f',
  darkslateblue: '483d8b',
  darkslategray: '2f4f4f',
  darkturquoise: '00ced1',
  darkviolet: '9400d3',
  deeppink: 'ff1493',
  deepskyblue: '00bfff',
  dimgray: '696969',
  dodgerblue: '1e90ff',
  firebrick: 'b22222',
  floralwhite: 'fffaf0',
  forestgreen: '228b22',
  gainsboro: 'dcdcdc',
  ghostwhite: 'f8f8ff',
  gold: 'ffd700',
  goldenrod: 'daa520',
  greenyellow: 'adff2f',
  honeydew: 'f0fff0',
  hotpink: 'ff69b4',
  indianred: 'cd5c5c',
  indigo: '4b0082',
  ivory: 'fffff0',
  khaki: 'f0e68c',
  lavender: 'e6e6fa',
  lavenderblush: 'fff0f5',
  lawngreen: '7cfc00',
  lemonchiffon: 'fffacd',
  lightblue: 'add8e6',
  lightcoral: 'f08080',
  lightcyan: 'e0ffff',
  lightgoldenrodyellow: 'fafad2',
  lightgray: 'd3d3d3',
  lightgreen: '90ee90',
  lightpink: 'ffb6c1',
  lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa',
  lightskyblue: '87cefa',
  lightslategray: '778899',
  lightsteelblue: 'b0c4de',
  lightyellow: 'ffffe0',
  limegreen: '32cd32',
  linen: 'faf0e6',
  magenta: 'ff00ff',
  mediumaquamarine: '66cdaa',
  mediumblue: '0000cd',
  mediumorchid: 'ba55d3',
  mediumpurple: '9370db',
  mediumseagreen: '3cb371',
  mediumslateblue: '7b68ee',
  mediumspringgreen: '00fa9a',
  mediumturquoise: '48d1cc',
  mediumvioletred: 'c71585',
  midnightblue: '191970',
  mintcream: 'f5fffa',
  mistyrose: 'ffe4e1',
  moccasin: 'ffe4b5',
  navajowhite: 'ffdead',
  oldlace: 'fdf5e6',
  olivedrab: '6b8e23',
  orangered: 'ff4500',
  orchid: 'da70d6',
  palegoldenrod: 'eee8aa',
  palegreen: '98fb98',
  paleturquoise: 'afeeee',
  palevioletred: 'db7093',
  papayawhip: 'ffefd5',
  peachpuff: 'ffdab9',
  peru: 'cd853f',
  pink: 'ffc0cb',
  plum: 'dda0dd',
  powderblue: 'b0e0e6',
  rosybrown: 'bc8f8f',
  royalblue: '4169e1',
  saddlebrown: '8b4513',
  salmon: 'fa8072',
  sandybrown: 'f4a460',
  seagreen: '2e8b57',
  seashell: 'fff5ee',
  sienna: 'a0522d',
  skyblue: '87ceeb',
  slateblue: '6a5acd',
  slategray: '708090',
  snow: 'fffafa',
  springgreen: '00ff7f',
  steelblue: '4682b4',
  tan: 'd2b48c',
  thistle: 'd8bfd8',
  tomato: 'ff6347',
  turquoise: '40e0d0',
  violet: 'ee82ee',
  wheat: 'f5deb3',
  whitesmoke: 'f5f5f5',
  yellowgreen: '9acd32',
  rebeccapurple: '663399',
};
function color(args: Value[]): Vector {
  const input = String(args[0] ?? '#fff')
    .toLowerCase()
    .replaceAll('grey', 'gray');
  let hex = named[input] ?? input.replace(/^#/, '');
  if (input === 'transparent') return new Vector(0, 0, 0, 0);
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  if (!/^[\da-f]{6}$/i.test(hex)) return fail('invalid CSS colour');
  return new Vector(
    ...[0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255),
    args[1] === undefined ? 1 : number(args[1]),
  );
}
function invoke(name: string, a: Value[]): Value {
  if (Object.hasOwn(math, name)) return numeric(math[name], a);
  if (/^vec[234]$/.test(name)) {
    const count = Number(name[3]),
      flat = a.flatMap((v) => (v instanceof Vector ? [...v] : [number(v)]));
    if (flat.length === 1) return Vector.from({ length: count }, () => flat[0]);
    if (flat.length < count) return fail('vector constructor needs more components');
    return Vector.from(flat.slice(0, count));
  }
  if (name === 'color') return color(a);
  if (name === 'rgb' || name === 'rgba')
    return new Vector(
      number(a[0]) / 255,
      number(a[1]) / 255,
      number(a[2]) / 255,
      a[3] === undefined ? 1 : number(a[3]),
    );
  if (name === 'hsl' || name === 'hsla') {
    const h = number(a[0]),
      s = number(a[1]),
      l = number(a[2]);
    const channel = (n: number) => {
      const k = (((n + h * 12) % 12) + 12) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return new Vector(channel(0), channel(8), channel(4), a[3] === undefined ? 1 : number(a[3]));
  }
  if (name === 'Boolean') return Boolean(a[0]);
  if (name === 'Number') return Number(a[0]);
  if (name === 'String') return string(a[0]);
  if (name === 'isNaN') return Number.isNaN(number(a[0]));
  if (name === 'isFinite') return Number.isFinite(number(a[0]));
  if (name === 'regExp') return new RegExp(String(a[0] ?? '(?:)'), a[1] === undefined ? undefined : String(a[1]));
  const x = a[0] as Vector,
    y = a[1] as Vector;
  if (name === 'length') return x instanceof Vector ? Math.hypot(...x) : Math.abs(number(x));
  if (name === 'distance') return invoke('length', [numeric((p, q) => p - q, a)]);
  if (name === 'normalize') return numeric((p, n) => p / n, [x, invoke('length', [x])]);
  if (name === 'dot' || name === 'cross') {
    if (!(x instanceof Vector) || !(y instanceof Vector) || x.length !== y.length)
      return fail('expected matching vectors');
    if (name === 'dot') return x.reduce((sum, v, i) => sum + v * y[i], 0);
    if (x.length !== 3) return fail('cross needs vec3 arguments');
    return new Vector(x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]);
  }
  return fail(`unknown function ${name}`);
}
function binary(op: string, a: Value, b: Value): Value {
  if (op === '===' || op === '!==') {
    const equal =
      a instanceof Vector && b instanceof Vector ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b;
    return op === '===' ? equal : !equal;
  }
  if (op === '=~' || op === '!~') {
    const regex = a instanceof RegExp ? a : b instanceof RegExp ? b : fail('match needs a regular expression');
    regex.lastIndex = 0;
    const match = regex.test(string(a instanceof RegExp ? b : a));
    return op === '=~' ? match : !match;
  }
  if (op === '+' && (typeof a === 'string' || typeof b === 'string')) return string(a) + string(b);
  const operators: Record<string, (a: number, b: number) => number> = {
    '+': (a, b) => a + b,
    '-': (a, b) => a - b,
    '*': (a, b) => a * b,
    '/': (a, b) => a / b,
    '%': (a, b) => a % b,
  };
  if (Object.hasOwn(operators, op)) return numeric(operators[op], [a, b]);
  const x = number(a),
    y = number(b);
  return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
}

/** Compiles one expression into a host-isolated property evaluator. */
export function expression(source: string): Expression {
  if (source.length > 65536) return fail('expression exceeds 65536 characters');
  const tokens =
    source.match(
      /\$\{[^}]*\}|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[\p{L}_$][\p{L}\p{N}_$]*|===|!==|<=|>=|&&|\|\||=~|!~|[^\s]/giu,
    ) ?? [];
  if (tokens.length > 4096) return fail('expression exceeds 4096 tokens');
  let at = 0,
    depth = 0;
  const take = (s: string) => tokens[at] === s && ++at > 0;
  const need = (s: string) => {
    if (!take(s)) fail(`expected ${s} at token ${at}`);
  };
  const list = (end: string): Expression[] => {
    const args: Expression[] = [];
    if (!take(end)) {
      do {
        args.push(parse(0));
      } while (take(','));
      need(end);
    }
    return args;
  };
  const primary = (): Expression => {
    const t = tokens[at++];
    let node: Expression;
    if (t === '(') {
      node = parse(0);
      need(')');
    } else if (t === '[') {
      const items = list(']');
      node = (read) => items.map((item) => item(read));
    } else if (t === '!' || t === '+' || t === '-') {
      const right = parse(7);
      node = (read) => (t === '!' ? !boolean(right(read)) : numeric((v) => (t === '-' ? -v : v), [right(read)]));
    } else if (t?.startsWith('${')) node = (read) => variable(t.slice(2, -1), read);
    else if (/^['"`]/.test(t ?? '')) {
      const raw = t
        .slice(1, -1)
        .replace(/\\(u[\da-f]{4}|x[\da-f]{2}|.)/gi, (_, c: string) =>
          c[0] === 'u' || c[0] === 'x'
            ? String.fromCharCode(parseInt(c.slice(1), 16))
            : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' }[c] ?? c),
        );
      node = (read) => raw.replace(/\$\{([^}]+)\}/g, (_, path) => string(variable(path, read)));
    } else if (/^(?:\d|\.\d)/.test(t ?? '')) node = () => Number(t);
    else if (t === 'Math') {
      need('.');
      const c = tokens[at++];
      if (c !== 'PI' && c !== 'E') fail('only Math.PI and Math.E are constants');
      node = () => (c === 'PI' ? Math.PI : Math.E);
    } else if (['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'].includes(t))
      node = () => ({ true: true, false: false, null: null, undefined: undefined, NaN: NaN, Infinity: Infinity })[t];
    else if (/^[\p{L}_$]/u.test(t ?? '') && take('(')) {
      const args = list(')');
      node = (read) =>
        invoke(
          t,
          args.map((arg) => arg(read)),
        );
    } else return fail(`unexpected token ${t ?? 'end'}`);
    while (tokens[at] === '.' || tokens[at] === '[') {
      const parent = node;
      if (take('[')) {
        const key = parse(0);
        need(']');
        node = (read) => member(parent(read), key(read));
      } else {
        need('.');
        const key = tokens[at++];
        if (take('(')) {
          const args = list(')');
          if (!['test', 'exec', 'toString'].includes(key)) fail(`method ${key} is unavailable`);
          node = (read) => {
            const object = parent(read);
            if (key === 'toString') return string(object);
            if (!(object instanceof RegExp)) return fail('test/exec needs a regular expression');
            object.lastIndex = 0;
            return key === 'test'
              ? object.test(string(args[0]?.(read)))
              : (object.exec(string(args[0]?.(read)))?.[1] ?? null);
          };
        } else node = (read) => member(parent(read), key);
      }
    }
    return node;
  };
  const precedence: Record<string, number> = {
    '||': 1,
    '&&': 2,
    '===': 3,
    '!==': 3,
    '=~': 3,
    '!~': 3,
    '<': 4,
    '>': 4,
    '<=': 4,
    '>=': 4,
    '+': 5,
    '-': 5,
    '*': 6,
    '/': 6,
    '%': 6,
  };
  const parse = (minimum: number): Expression => {
    if (++depth > 128) return fail('expression nesting exceeds 128');
    let left = primary();
    while (Object.hasOwn(precedence, tokens[at]) && precedence[tokens[at]] >= minimum) {
      const op = tokens[at++],
        a = left,
        b = parse(precedence[op] + 1);
      left = (read) =>
        op === '&&'
          ? boolean(a(read)) && boolean(b(read))
          : op === '||'
            ? boolean(a(read)) || boolean(b(read))
            : binary(op, a(read), b(read));
    }
    if (minimum === 0 && take('?')) {
      const test = left,
        yes = parse(0);
      need(':');
      const no = parse(0);
      left = (read) => (boolean(test(read)) ? yes(read) : no(read));
    }
    depth--;
    return left;
  };
  const result = parse(0);
  if (at !== tokens.length) fail(`unexpected token ${tokens[at]}`);
  return result;
}
