// Clean-room precedence climbing from Pratt (1973). Only scalar nodes reach either evaluator.
import { rangeError } from '../../shared/errors.js';

export interface ScalarNode {
  op: string;
  args: ScalarNode[];
  value?: number;
  column?: number;
}
export interface Column {
  values: ArrayLike<number>;
  width: number;
  offset: number;
}
const bad = (message: string): never => {
  throw rangeError(`Calculator: ${message}`, 'sciviz');
};
const node = (op: string, ...args: ScalarNode[]): ScalarNode => ({ op, args });
const literal = (value: number): ScalarNode => ({ op: 'literal', args: [], value });
const unary = new Set([
  'abs',
  'sqrt',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'exp',
  'log',
  'log2',
  'floor',
  'ceil',
  'sign',
]);
const binary = new Set(['min', 'max', 'pow', 'atan2']);

/** @internal Statically typed scalar/vector grammar, without execution of caller code. */
export function expression(source: string, columns: ReadonlyMap<string, Column>, options: {
  precision?: 'f32' | 'f64';
  predicates?: boolean;
  reduce?: (op: string, args: ScalarNode[]) => ScalarNode[];
} = {}): ScalarNode[] {
  if (typeof source !== 'string' || source.length > 4096) bad('expression must be a string of at most 4096 characters');
  const tokens: string[] = [];
  let at = 0;
  const pattern =
    /\s*(?:(\d*\.\d+(?:[eE][+-]?\d+)?|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|(`[^`]+`)|(&&|\|\||<=|>=|==|!=|[!<>+*/%^(),\[\]-]))/y;
  while (at < source.length && source.slice(at).trim()) {
    pattern.lastIndex = at;
    const match = pattern.exec(source);
    if (!match) bad(`unexpected character at ${at}`);
    tokens.push(match![1] ?? match![2] ?? match![3] ?? match![4]);
    at = pattern.lastIndex;
  }
  let cursor = 0,
    depth = 0,
    nodes = 0;
  const take = (expected: string) => {
    if (tokens[cursor++] !== expected) bad(`expected ${expected}`);
  };
  const combine = (op: string, a: ScalarNode[], b: ScalarNode[]) => {
    if (a.length !== b.length && a.length !== 1 && b.length !== 1) bad('incompatible vector widths');
    return Array.from({ length: Math.max(a.length, b.length) }, (_, k) => node(op, a[k % a.length], b[k % b.length]));
  };
  const sum = (a: ScalarNode[]) => a.reduce((x, y) => node('+', x, y), literal(0));
  const parse = (minimum = 0): ScalarNode[] => {
    if (++depth > 64 || ++nodes > 512) bad('expression exceeds 64 nesting levels or 512 nodes');
    const token = tokens[cursor++];
    let a: ScalarNode[];
    if (token === '!' && options.predicates) a = parse(25).map((x) => node('!', x));
    else if (token === '+' || token === '-') {
      a = parse(25);
      if (token === '-') a = a.map((x) => node('neg', x));
    } else if (token === '(') {
      a = parse();
      take(')');
    } else if (token && /^\d|^\.\d/.test(token)) {
      const value = options.precision === 'f64' ? Number(token) : Math.fround(Number(token));
      if (!Number.isFinite(value)) bad('literal exceeds float32');
      a = [literal(value)];
    } else if (token && tokens[cursor] === '(') {
      cursor++;
      const args: ScalarNode[][] = [];
      if (tokens[cursor] !== ')') {
        do {
          args.push(parse());
          if (tokens[cursor] !== ',') break;
          cursor++;
        } while (true);
      }
      take(')');
      if (token === 'vec' && args.length === 3 && args.every((x) => x.length === 1)) a = args.flat();
      else if ((token === 'mag' || token === 'normalize') && args.length === 1) {
        const length = node('sqrt', sum(args[0].map((x) => node('*', x, x))));
        a = token === 'mag' ? [length] : args[0].map((x) => node('/', x, length));
      } else if (token === 'dot' && args.length === 2 && args[0].length === args[1].length)
        a = [sum(combine('*', args[0], args[1]))];
      else if (token === 'cross' && args.length === 2 && args.every((x) => x.length === 3))
        a = [0, 1, 2].map((k) =>
          node(
            '-',
            node('*', args[0][(k + 1) % 3], args[1][(k + 2) % 3]),
            node('*', args[0][(k + 2) % 3], args[1][(k + 1) % 3]),
          ),
        );
      else if (options.reduce && ['min', 'max', 'sum', 'mean', 'count'].includes(token) && args.length === 1)
        a = options.reduce(token, args[0]);
      else if (unary.has(token) && args.length === 1) a = args[0].map((x) => node(token, x));
      else if (binary.has(token) && args.length === 2) a = combine(token, args[0], args[1]);
      else if (token === 'clamp' && args.length === 3) a = combine('min', combine('max', args[0], args[1]), args[2]);
      else bad(`unknown function or wrong arguments: ${token}`);
    } else if (token === 'pi' || token === 'e') {
      const value = token === 'pi' ? Math.PI : Math.E;
      a = [literal(options.precision === 'f64' ? value : Math.fround(value))];
    }
    else if (token === 'iHat' || token === 'jHat' || token === 'kHat')
      a = [0, 1, 2].map((k) => literal(k === ['iHat', 'jHat', 'kHat'].indexOf(token) ? 1 : 0));
    else {
      const key = token?.startsWith('`') ? token.slice(1, -1) : token,
        col = key === undefined ? undefined : columns.get(key);
      if (!col) bad(`unknown array ${token ?? '<end>'}`);
      a = Array.from({ length: col!.width }, (_, k) => ({ op: 'column', args: [], column: col!.offset + k }));
    }
    while (tokens[cursor] === '[') {
      cursor++;
      const index = Number(tokens[cursor++]);
      if (!Number.isInteger(index) || index < 0 || index >= a!.length) bad('invalid component index');
      take(']');
      a = [a![index]];
    }
    while (true) {
      const op = tokens[cursor],
        power = op === '+' || op === '-' ? 10 : op === '*' || op === '/' || op === '%' ? 20 : op === '^' ? 30
          : options.predicates ? op === '||' ? 1 : op === '&&' ? 2 : ['==', '!='].includes(op) ? 3 : ['<', '>', '<=', '>='].includes(op) ? 4 : 0 : 0;
      if (power === 0 || power < minimum) break;
      cursor++;
      a = combine(op, a!, parse(power + (op === '^' ? 0 : 1)));
    }
    depth--;
    return a!;
  };
  const result = parse();
  if (cursor !== tokens.length) bad('unexpected trailing token');
  return result;
}

/** @internal Float64 reference and conservative forward f32 error for finite expressions. */
export function evaluate(
  n: ScalarNode,
  row: readonly number[],
  cache = new Map<ScalarNode, { value: number; error: number }>(),
  precision: 'f32' | 'f64' = 'f32',
): { value: number; error: number } {
  const cached = cache.get(n);
  if (cached) return cached;
  if (n.op === 'literal') return { value: n.value!, error: 0 };
  if (n.op === 'column') return { value: row[n.column!], error: 0 };
  const args = n.args.map((x) => evaluate(x, row, cache, precision)),
    a = args[0].value,
    b = args[1]?.value,
    ea = args[0].error,
    eb = args[1]?.error ?? 0,
    lo = a - ea,
    hi = a + ea;
  let value: number, error: number;
  switch (n.op) {
    case '!': value = Number(!Number.isFinite(a) || a === 0); error = 0; break;
    case '&&': value = Number(Number.isFinite(a) && a !== 0 && Number.isFinite(b) && b !== 0); error = 0; break;
    case '||': value = Number((Number.isFinite(a) && a !== 0) || (Number.isFinite(b) && b !== 0)); error = 0; break;
    case '<': case '>': case '<=': case '>=': case '==': case '!=':
      value = Number(Number.isFinite(a) && Number.isFinite(b) && (n.op === '<' ? a < b : n.op === '>' ? a > b : n.op === '<=' ? a <= b : n.op === '>=' ? a >= b : n.op === '==' ? a === b : a !== b));
      error = 0; break;
    case '+':
      value = a + b;
      error = ea + eb;
      break;
    case '-':
      value = a - b;
      error = ea + eb;
      break;
    case 'neg':
      value = -a;
      error = ea;
      break;
    case '*':
      value = a * b;
      error = Math.abs(a) * eb + Math.abs(b) * ea + ea * eb;
      break;
    case '/':
      value = a / b;
      error = (ea + Math.abs(value) * eb) / (Math.abs(b) - eb);
      if (Math.abs(b) <= eb) error = Infinity;
      break;
    case '%':
      value = a - b * Math.floor(a / b);
      error = ea + (Math.abs(Math.floor(a / b)) + 1) * eb;
      if (Math.floor((a - ea) / (b + eb)) !== Math.floor((a + ea) / (b - eb))) error += Math.abs(b) + eb;
      break;
    case '^':
    case 'pow':
      value = Math.pow(a, b);
      error =
        eb === 0 && Number.isInteger(b) && b >= 0
          ? b === 0
            ? 0
            : b * Math.max(Math.abs(lo), Math.abs(hi)) ** (b - 1) * ea
          : a > ea
            ? Math.abs(value) *
              (Math.exp(
                eb * Math.max(Math.abs(Math.log(lo)), Math.abs(Math.log(hi))) + ((Math.abs(b) + eb) * ea) / lo,
              ) -
                1)
            : ea === 0 && eb === 0
              ? 0
              : Infinity;
      break;
    case 'min':
      value = Math.min(a, b);
      error = Math.max(ea, eb);
      break;
    case 'max':
      value = Math.max(a, b);
      error = Math.max(ea, eb);
      break;
    case 'atan2':
      value = Math.atan2(a, b);
      error =
        Math.hypot(ea, eb) < Math.hypot(a, b) && !(b < 0 && Math.abs(a) <= ea)
          ? (4 * Math.hypot(ea, eb)) / (Math.hypot(a, b) - Math.hypot(ea, eb))
          : Infinity;
      break;
    case 'sqrt':
      value = Math.sqrt(a);
      error = a >= 0 ? Math.sqrt(Math.max(hi, 0)) - Math.sqrt(Math.max(lo, 0)) : Infinity;
      break;
    case 'log':
    case 'log2':
      value = n.op === 'log' ? Math.log(a) : Math.log2(a);
      error = lo > 0 ? (ea / lo) * (n.op === 'log' ? 1 : Math.LOG2E) : Infinity;
      break;
    case 'exp':
      value = Math.exp(a);
      error = Math.exp(hi) * ea;
      break;
    case 'tan':
      value = Math.tan(a);
      error =
        Math.floor((lo + Math.PI / 2) / Math.PI) === Math.floor((hi + Math.PI / 2) / Math.PI)
          ? ea / Math.min(Math.cos(lo) ** 2, Math.cos(hi) ** 2)
          : Infinity;
      break;
    case 'asin':
    case 'acos':
      value = n.op === 'asin' ? Math.asin(a) : Math.acos(a);
      error =
        Math.max(Math.abs(lo), Math.abs(hi)) < 1
          ? ea / Math.sqrt(1 - Math.max(lo * lo, hi * hi))
          : ea === 0
            ? 0
            : Infinity;
      break;
    case 'floor':
    case 'ceil':
    case 'sign': {
      const fn = n.op === 'floor' ? Math.floor : n.op === 'ceil' ? Math.ceil : Math.sign;
      value = fn(a);
      error = Math.max(Math.abs(fn(lo) - value), Math.abs(fn(hi) - value));
      break;
    }
    default: {
      const fn = n.op === 'sin' ? Math.sin : n.op === 'cos' ? Math.cos : n.op === 'atan' ? Math.atan : Math.abs;
      value = fn(a);
      error = ea;
    }
  }
  if (precision === 'f64') { const result = { value, error: 0 }; cache.set(n, result); return result; }
  // Includes transcendental implementation error and subnormal flushing, not discretisation error.
  const absolute = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'log', 'log2'].includes(n.op);
  error += 32 * 2 ** -23 * (absolute ? Math.max(1, Math.abs(value)) : Math.abs(value)) + 2 ** -120;
  if (!Number.isFinite(value) || !Number.isFinite(error) || !Number.isFinite(Math.fround(value)))
    bad('nonfinite result or unbounded float32 conditioning; rescale or change the expression');
  const result = { value, error };
  cache.set(n, result);
  return result;
}

/** @internal WGSL contains only nodes emitted by the validated grammar. */
export function emit(n: ScalarNode, lines: string[], cache = new Map<ScalarNode, string>()): string {
  const cached = cache.get(n);
  if (cached) return cached;
  if (n.op === 'literal') return `f32(${n.value!})`;
  if (n.op === 'column') return `data[i*params.width+${n.column!}u]`;
  const a = n.args.map((x) => emit(x, lines, cache)),
    name = `v${cache.size}`,
    code =
      n.op === 'neg'
        ? `(-${a[0]})`
        : ['+', '-', '*', '/'].includes(n.op)
          ? `(${a[0]}${n.op}${a[1]})`
          : n.op === '%'
            ? `(${a[0]}-${a[1]}*floor(${a[0]}/${a[1]}))`
            : `${n.op === '^' || n.op === 'pow' ? 'realPow' : n.op === 'sqrt' ? 'safeSqrt' : n.op}(${a.join(',')})`;
  cache.set(n, name);
  lines.push(`let ${name}=${code};`);
  return name;
}
