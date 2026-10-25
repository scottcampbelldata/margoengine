// Margo voxel expressions, language version 1: one bounded scalar expression evaluated for every cell of an indexed
// voxel grid, with snapshot reads of the grid and a previous frame and a seeded lattice hash and value noise. It is
// Margo Voxel Studio's original expression language moved into the engine unchanged, so saved expression text keeps
// its exact results; it is not GLSL, WGSL or a host-language runtime, and evaluates nothing but its own syntax tree.
import type { Vec3 } from '@margoengine/math';

/** The language version this module evaluates. Version 1's syntax, functions and results are frozen. */
export const VOXEL_EXPRESSION_VERSION = 1;

/**
 * The fixed bounds of version 1, checked before any output is allocated: source characters, tokens, syntax-tree
 * nodes, nesting depth, parameters, iterations, grid cells, buffer bytes (`cells * (3 + previous ? 1 : 0)`) and
 * work (`cells * iterations * workPerCell`).
 */
export const VOXEL_EXPRESSION_LIMITS: Readonly<{
  source: 8192;
  tokens: 4096;
  nodes: 2048;
  depth: 64;
  parameters: 32;
  iterations: 32;
  cells: 16_777_216;
  bytes: 67_108_864;
  work: 67_108_864;
}> = /* @__PURE__ */ Object.freeze({
  source: 8192,
  tokens: 4096,
  nodes: 2048,
  depth: 64,
  parameters: 32,
  iterations: 32,
  cells: 16_777_216,
  bytes: 67_108_864,
  work: 67_108_864,
} as const);

/** What `runVoxelExpression` evaluates. The grid layout is voxel-edit's: cell (x, y, z) is `voxels[x + sx * (z + sz * y)]`, Y up. */
export interface VoxelExpressionInput {
  /** The expression, 1 to 8192 characters. */
  source: string;
  /** Cells along x, y and z, integers 1 to 1024. */
  size: Vec3;
  /** Palette indexes (0 air, 1-255 filled), `sx * sy * sz` of them; read through `color` and `voxel()`, never changed. */
  voxels: Uint8Array;
  /** A previous frame of the same size read by `prev()`; without it `prev()` reads 0. Never changed. */
  previous?: Uint8Array;
  /** Value of `frame`, an integer 0 to 2,147,483,647. Default 0. */
  frame?: number;
  /** Named numbers the expression reads as variables: at most 32, finite, within ±1e9. */
  parameters?: Record<string, number>;
  /** Times the expression runs, each pass reading the previous pass's grid, 1 to 32. Default 1. */
  iterations?: number;
  /** Value of `seed` and the seed of `hash()` and `noise()`, an unsigned 32-bit integer. Default 0. */
  seed?: number;
}

/** A new grid the caller owns, and how much ran. */
export interface VoxelExpressionResult {
  /** Same size as the input. */
  size: [number, number, number];
  /** One palette index per cell, the last iteration's output. */
  voxels: Uint8Array;
  /** Cells per iteration, iterations run and expression evaluations (`cells * iterations`). */
  stats: { cells: number; iterations: number; evaluations: number };
}

/** A checked expression: its source, syntax-tree size and cost per cell (the unit of the work budget). */
export interface CompiledVoxelExpression {
  readonly source: string;
  /** Syntax-tree nodes, at most 2048. */
  readonly nodeCount: number;
  /** Work units per evaluation: 1 per node plus the extra cost of the functions called (see {@link VOXEL_EXPRESSION_FUNCTIONS}). */
  readonly workPerCell: number;
}

/**
 * Why a {@link VoxelExpressionError} was thrown: `'syntax'` (the source does not parse, or names an unknown variable or
 * function), `'limit'` (the source exceeds a token, node or depth bound) or `'evaluation'` (a value was not finite,
 * a function argument was invalid, or the output was not a palette index).
 */
export type VoxelExpressionErrorCode = 'syntax' | 'limit' | 'evaluation';

/** An error in the expression text or its evaluation, located at a 1-based line and column of the source. */
export class VoxelExpressionError extends Error {
  /** Machine-readable reason. */
  readonly code: VoxelExpressionErrorCode;
  /** 1-based line of the token or operator at fault. */
  readonly line: number;
  /** 1-based column (in code points) of the token or operator at fault. */
  readonly column: number;
  /** The message without its location, for an editor that marks the position itself. */
  readonly detail: string;
  /** @param code Why. @param detail Problem and fix. @param line 1-based line. @param column 1-based column. */
  constructor(code: VoxelExpressionErrorCode, detail: string, line = 1, column = 1) {
    super(`${detail} (line ${line}, column ${column})`);
    this.name = 'VoxelExpressionError';
    this.code = code;
    this.line = line;
    this.column = column;
    this.detail = detail;
  }
}

/** The variables of version 1: cell coordinates, grid size, the cell's palette index, clocks, the seed and constants. */
export const VOXEL_EXPRESSION_VARIABLES: readonly string[] = [
  'x',
  'y',
  'z',
  'sx',
  'sy',
  'sz',
  'color',
  'frame',
  'iteration',
  'seed',
  'pi',
  'e',
  'true',
  'false',
];

/**
 * Integer lattice hash of version 1, in [0, 1]: Margo Voxel Studio's `hash()`. Each coordinate is converted to a
 * 32-bit integer as `x | 0` (truncation, wrapping modulo 2^32) and the seed as an unsigned 32-bit value; then
 * `h = imul(x, 0x1f123bb5) ^ imul(y, 0x5f356495) ^ imul(z, 0x6c8e9cf5) ^ seed`, `h = imul(h ^ (h >>> 16), 0x7feb352d)`,
 * `h = imul(h ^ (h >>> 15), 0x846ca68b)` and the result is `((h ^ (h >>> 16)) >>> 0) / 4294967295`. Not
 * `@margoengine/procedural/noise`'s hash, whose constants differ; this one is frozen with the language.
 */
export function voxelHash(x: number, y: number, z: number, seed: number): number {
  let value = Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(y | 0, 0x5f356495) ^ Math.imul(z | 0, 0x6c8e9cf5) ^ seed;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

/**
 * Value noise of version 1, in [0, 1]: {@link voxelHash} at the 8 integer corners around (x, y, z), blended
 * trilinearly with the smoothstep fade `t * t * (3 - 2 * t)` of each fractional coordinate, x first, then y, then z
 * (`mix(a, b, t) = a + (b - a) * t`). Continuous, but not gradient (Perlin/simplex) noise; integer points return the
 * corner hash exactly.
 */
export function voxelNoise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z),
    fade = (t: number) => t * t * (3 - 2 * t),
    fx = fade(x - ix),
    fy = fade(y - iy),
    fz = fade(z - iz),
    mix = (a: number, b: number, t: number) => a + (b - a) * t,
    h = (dx: number, dy: number, dz: number) => voxelHash(ix + dx, iy + dy, iz + dz, seed);
  return mix(
    mix(mix(h(0, 0, 0), h(1, 0, 0), fx), mix(h(0, 1, 0), h(1, 1, 0), fx), fy),
    mix(mix(h(0, 0, 1), h(1, 0, 1), fx), mix(h(0, 1, 1), h(1, 1, 1), fx), fy),
    fz,
  );
}

// ---------------------------------------------------------------------------------------------------- functions

interface Context {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  current: Uint8Array;
  previous?: Uint8Array;
  frame: number;
  iteration: number;
  seed: number;
  parameters: Record<string, number>;
}
interface Builtin {
  min: number;
  max: number;
  cost: number;
  run: (args: number[], context: Context) => number;
}
const builtin = (arity: number, run: Builtin['run'], cost = 1): Builtin => ({ min: arity, max: arity, cost, run });
// A function's argument errors become VoxelExpressionErrors at the call's location.
function sample(bytes: Uint8Array | undefined, args: number[], context: Context): number {
  if (args.some((value) => !Number.isInteger(value))) throw new RangeError('Voxel coordinates must be integers.');
  const [x, y, z] = args,
    { sx, sy, sz } = context;
  return !bytes || x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : bytes[x + sx * (z + sz * y)];
}
const FUNCTIONS: Record<string, Builtin> = {
  abs: builtin(1, (a) => Math.abs(a[0])),
  floor: builtin(1, (a) => Math.floor(a[0])),
  ceil: builtin(1, (a) => Math.ceil(a[0])),
  round: builtin(1, (a) => Math.round(a[0])),
  sqrt: builtin(1, (a) => Math.sqrt(a[0]), 2),
  sin: builtin(1, (a) => Math.sin(a[0]), 4),
  cos: builtin(1, (a) => Math.cos(a[0]), 4),
  tan: builtin(1, (a) => Math.tan(a[0]), 4),
  pow: builtin(2, (a) => Math.pow(a[0], a[1]), 4),
  min: { min: 2, max: 8, cost: 1, run: (a) => Math.min(...a) },
  max: { min: 2, max: 8, cost: 1, run: (a) => Math.max(...a) },
  clamp: builtin(3, (a) => Math.min(Math.max(a[0], Math.min(a[1], a[2])), Math.max(a[1], a[2]))),
  mix: builtin(3, (a) => (1 - a[2]) * a[0] + a[2] * a[1]),
  smoothstep: builtin(3, (a) => {
    if (a[0] === a[1]) throw new RangeError('smoothstep edges must differ.');
    const t = Math.min(1, Math.max(0, (a[2] - a[0]) / (a[1] - a[0])));
    return t * t * (3 - 2 * t);
  }),
  length: builtin(3, (a) => Math.hypot(a[0], a[1], a[2]), 2),
  sphere: builtin(
    4,
    (a) => {
      if (a[3] < 0) throw new RangeError('Sphere radius must be nonnegative.');
      return Math.hypot(a[0], a[1], a[2]) - a[3];
    },
    3,
  ),
  box: builtin(
    6,
    (a) => {
      if (a[3] < 0 || a[4] < 0 || a[5] < 0) throw new RangeError('Box half-extents must be nonnegative.');
      const x = Math.abs(a[0]) - a[3],
        y = Math.abs(a[1]) - a[4],
        z = Math.abs(a[2]) - a[5];
      return Math.hypot(Math.max(x, 0), Math.max(y, 0), Math.max(z, 0)) + Math.min(Math.max(x, y, z), 0);
    },
    5,
  ),
  torus: builtin(
    5,
    (a) => {
      if (a[3] < 0 || a[4] < 0) throw new RangeError('Torus radii must be nonnegative.');
      return Math.hypot(Math.hypot(a[0], a[2]) - a[3], a[1]) - a[4];
    },
    5,
  ),
  hash: builtin(3, (a, c) => voxelHash(Math.floor(a[0]), Math.floor(a[1]), Math.floor(a[2]), c.seed), 4),
  noise: builtin(3, (a, c) => voxelNoise(a[0], a[1], a[2], c.seed), 32),
  voxel: builtin(3, (a, c) => sample(c.current, a, c)),
  prev: builtin(3, (a, c) => sample(c.previous, a, c)),
};

/**
 * The functions of version 1 with their arities and extra work cost per call (on top of 1 per syntax node):
 * `abs floor ceil round` (1 argument), `sqrt` (1, cost 2), `sin cos tan` (1, cost 4), `pow` (2, cost 4),
 * `min max` (2-8), `clamp(v, a, b)` (bounds in either order), `mix(a, b, t)`, `smoothstep(e0, e1, v)` (edges differ),
 * `length(x, y, z)` (cost 2), `sphere(x, y, z, r)` (cost 3), `box(x, y, z, hx, hy, hz)` and `torus(x, y, z, R, r)`
 * (signed distances, cost 5), `hash(x, y, z)` ({@link voxelHash} of the floored point and `seed`, cost 4),
 * `noise(x, y, z)` ({@link voxelNoise} with `seed`, cost 32), `voxel(x, y, z)` and `prev(x, y, z)` (integer cell reads of
 * the current iteration's input and of `previous`; outside the grid they read 0).
 */
export const VOXEL_EXPRESSION_FUNCTIONS: readonly { name: string; min: number; max: number; cost: number }[] =
  /* @__PURE__ */ Object.entries(FUNCTIONS).map(([name, { min, max, cost }]) => ({ name, min, max, cost }));

// ---------------------------------------------------------------------------------------------------- parser

const VARIABLES = /* @__PURE__ */ new Set(VOXEL_EXPRESSION_VARIABLES);
const FORBIDDEN = /* @__PURE__ */ new Set(['__proto__', 'prototype', 'constructor']);
const PRECEDENCE = /* @__PURE__ */ new Map<string, number>([
  ['||', 1],
  ['&&', 2],
  ['==', 3],
  ['!=', 3],
  ['<', 4],
  ['>', 4],
  ['<=', 4],
  ['>=', 4],
  ['+', 5],
  ['-', 5],
  ['*', 6],
  ['/', 6],
  ['%', 6],
  ['**', 7],
]);
const OPERATORS = [
  '**',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '!',
  '?',
  ':',
  '(',
  ')',
  ',',
];
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const hasFunction = (name: string) => Object.hasOwn(FUNCTIONS, name);
const reserved = (name: string) => VARIABLES.has(name) || hasFunction(name) || FORBIDDEN.has(name);

interface Location {
  line: number;
  column: number;
}
interface Token extends Location {
  kind: 'number' | 'identifier' | 'operator' | 'end';
  text: string;
  value?: number;
}
type Body =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; operator: string; value: Node }
  | { kind: 'binary'; operator: string; left: Node; right: Node }
  | { kind: 'conditional'; test: Node; yes: Node; no: Node }
  | { kind: 'call'; name: string; args: Node[] };
type Shape = Location & Body;
type Node = Shape & { depth: number; cost: number };
const trees = /* @__PURE__ */ new WeakMap<CompiledVoxelExpression, Node>();

function tokenize(source: string): Token[] {
  if (typeof source !== 'string') throw new TypeError('Voxel expression source must be a string.');
  if (source.length > VOXEL_EXPRESSION_LIMITS.source)
    throw new RangeError('Voxel expression source exceeds 8192 characters; shorten it.');
  if (!source.trim())
    throw new VoxelExpressionError('syntax', 'Source must contain an expression of at most 8192 characters.');
  const tokens: Token[] = [],
    number = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y,
    identifier = /[A-Za-z_][A-Za-z0-9_]*/y;
  let index = 0,
    line = 1,
    column = 1;
  const consume = (text: string) => {
    // Columns count code points, as the language always has.
    for (const char of text)
      if (char === '\n') {
        line++;
        column = 1;
      } else column++;
    index += text.length;
  };
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      consume(char);
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index);
      consume(source.slice(index, end < 0 ? source.length : end));
      continue;
    }
    const location = { line, column };
    number.lastIndex = identifier.lastIndex = index;
    let match: RegExpExecArray | null;
    if ((match = number.exec(source))) {
      const value = Number(match[0]);
      if (!Number.isFinite(value))
        throw new VoxelExpressionError('syntax', 'Numeric literals must be finite.', line, column);
      tokens.push({ ...location, kind: 'number', text: match[0], value });
      consume(match[0]);
    } else if ((match = identifier.exec(source))) {
      tokens.push({ ...location, kind: 'identifier', text: match[0] });
      consume(match[0]);
    } else {
      const operator = OPERATORS.find((value) => source.startsWith(value, index));
      if (!operator) throw new VoxelExpressionError('syntax', `Unexpected character "${char}".`, line, column);
      tokens.push({ ...location, kind: 'operator', text: operator });
      consume(operator);
    }
    if (tokens.length > VOXEL_EXPRESSION_LIMITS.tokens)
      throw new VoxelExpressionError('limit', 'Token limit exceeded.', line, column);
  }
  tokens.push({ kind: 'end', text: '', line, column });
  return tokens;
}

function checkNames(names: readonly string[]): void {
  if (names.length > VOXEL_EXPRESSION_LIMITS.parameters)
    throw new RangeError('Voxel expression parameter count exceeds the 32-parameter limit.');
  for (const name of names)
    if (typeof name !== 'string' || !NAME.test(name) || reserved(name))
      throw new RangeError(
        `Voxel expression parameter "${String(name)}" is invalid or reserved; use letters, digits and _ and avoid built-in names.`,
      );
}

/**
 * Parses and checks `source` against the language and the names of the parameters it may read, without evaluating
 * it. Throws {@link VoxelExpressionError} (`'syntax'`, `'limit'`) at the offending token, RangeError for invalid
 * parameter names or source over 8192 characters, TypeError for a non-string source.
 */
export function compileVoxelExpression(source: string, parameters: readonly string[] = []): CompiledVoxelExpression {
  checkNames(parameters);
  const names = new Set(parameters),
    tokens = tokenize(source),
    limits = VOXEL_EXPRESSION_LIMITS;
  let position = 0,
    nodes = 0,
    recursion = 0;
  const current = () => tokens[position];
  const fail = (message: string, token = current(), code: VoxelExpressionErrorCode = 'syntax'): never => {
    throw new VoxelExpressionError(code, message, token.line, token.column);
  };
  const take = (text: string) => {
    if (current().text !== text) fail(`Expected "${text}".`);
    position++;
  };
  const make = (node: Shape, children: Node[] = [], cost = 1): Node => {
    if (++nodes > limits.nodes) fail('AST node limit exceeded.', current(), 'limit');
    let depth = 0,
      total = cost;
    for (const child of children) {
      depth = Math.max(depth, child.depth);
      total += child.cost;
    }
    if (++depth > limits.depth) fail('Expression nesting depth limit exceeded.', current(), 'limit');
    return { ...node, depth, cost: total } as Node;
  };
  const enter = () => {
    if (++recursion > limits.depth) fail('Expression nesting depth limit exceeded.', current(), 'limit');
  };
  const unary = (): Node => {
    enter();
    try {
      const token = current(),
        at = { line: token.line, column: token.column };
      if (token.kind === 'operator' && (token.text === '+' || token.text === '-' || token.text === '!')) {
        position++;
        const value = unary();
        return make({ ...at, kind: 'unary', operator: token.text, value }, [value]);
      }
      if (token.kind === 'number') {
        position++;
        return make({ ...at, kind: 'number', value: token.value as number });
      }
      if (token.text === '(') {
        position++;
        const result = expression(0);
        take(')');
        return result;
      }
      if (token.kind === 'identifier') {
        position++;
        const name = token.text;
        if (current().text === '(') {
          if (!hasFunction(name)) fail(`Unknown function "${name}".`, token);
          position++;
          const args: Node[] = [];
          if (current().text !== ')')
            for (;;) {
              args.push(expression(0));
              if (current().text !== ',') break;
              position++;
            }
          take(')');
          const fn = FUNCTIONS[name];
          if (args.length < fn.min || args.length > fn.max)
            fail(`Function "${name}" requires ${fn.min === fn.max ? fn.min : `${fn.min}-${fn.max}`} arguments.`, token);
          return make({ ...at, kind: 'call', name, args }, args, fn.cost);
        }
        if (FORBIDDEN.has(name) || (!VARIABLES.has(name) && !names.has(name)))
          fail(`Unknown variable "${name}".`, token);
        return make({ ...at, kind: 'variable', name });
      }
      return fail('Expected a number, variable, function or parenthesized expression.', token);
    } finally {
      recursion--;
    }
  };
  const expression = (minimum: number): Node => {
    enter();
    try {
      let left = unary();
      for (;;) {
        const token = current(),
          precedence = token.kind === 'operator' ? PRECEDENCE.get(token.text) : undefined;
        if (precedence === undefined || precedence < minimum) break;
        position++;
        const right = expression(precedence + (token.text === '**' ? 0 : 1));
        left = make({ line: token.line, column: token.column, kind: 'binary', operator: token.text, left, right }, [
          left,
          right,
        ]);
      }
      if (minimum === 0 && current().text === '?') {
        const token = current();
        position++;
        const yes = expression(0);
        take(':');
        const no = expression(0);
        left = make({ line: token.line, column: token.column, kind: 'conditional', test: left, yes, no }, [
          left,
          yes,
          no,
        ]);
      }
      return left;
    } finally {
      recursion--;
    }
  };
  const root = expression(0);
  if (current().kind !== 'end') fail('Unexpected token after expression.');
  const compiled: CompiledVoxelExpression = Object.freeze({ source, nodeCount: nodes, workPerCell: root.cost });
  trees.set(compiled, root);
  return compiled;
}

// ---------------------------------------------------------------------------------------------------- evaluation

/** The checked shape of an input: compiled expression, cell count and resolved defaults. */
export interface CheckedVoxelExpressionInput {
  program: CompiledVoxelExpression;
  cells: number;
  iterations: number;
  frame: number;
  seed: number;
}

function parameterNames(parameters: Record<string, number> | undefined): string[] {
  if (parameters === undefined) return [];
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))
    throw new TypeError('Voxel expression parameters must be an object of finite numbers.');
  const names = Object.keys(parameters);
  checkNames(names);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(parameters, name);
    if (
      !descriptor ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'number' ||
      !Number.isFinite(descriptor.value) ||
      Math.abs(descriptor.value) > 1e9
    )
      throw new RangeError(`Voxel expression parameter "${name}" must be a finite number within ±1,000,000,000.`);
  }
  return names;
}

/**
 * Checks an input without evaluating it: the parameters, the expression (compiled against them), the grid, the
 * clocks and the memory and work budgets. Throws what {@link compileVoxelExpression} throws, TypeError for a wrong
 * shape and RangeError for a value out of range or over a budget.
 */
export function validateVoxelExpressionInput(input: VoxelExpressionInput): CheckedVoxelExpressionInput {
  if (!input || typeof input !== 'object') throw new TypeError('Voxel expression input must be an object.');
  const names = parameterNames(input.parameters),
    program = compileVoxelExpression(input.source, names),
    size = input.size,
    limits = VOXEL_EXPRESSION_LIMITS;
  if (
    !Array.isArray(size) ||
    size.length !== 3 ||
    size.some((value) => !Number.isInteger(value) || value < 1 || value > 1024)
  )
    throw new RangeError('Voxel expression volume requires three integer dimensions from 1 to 1024.');
  const cells = size[0] * size[1] * size[2];
  if (cells > limits.cells)
    throw new RangeError('Voxel expression volume exceeds the 16,777,216-cell limit; resize the model first.');
  if (!(input.voxels instanceof Uint8Array) || input.voxels.length !== cells)
    throw new RangeError('Voxel expression voxel buffer length must match the volume size.');
  if (input.previous !== undefined && (!(input.previous instanceof Uint8Array) || input.previous.length !== cells))
    throw new RangeError('Voxel expression previous-frame buffer length must match the current volume size.');
  const iterations = input.iterations ?? 1,
    frame = input.frame ?? 0,
    seed = input.seed ?? 0;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > limits.iterations)
    throw new RangeError('Voxel expression iterations must be an integer from 1 to 32.');
  if (!Number.isInteger(frame) || frame < 0 || frame > 2_147_483_647)
    throw new RangeError('Voxel expression frame must be an integer from 0 to 2,147,483,647.');
  if (!Number.isInteger(seed) || seed < 0 || seed > 4_294_967_295)
    throw new RangeError('Voxel expression seed must be an unsigned 32-bit integer.');
  if (cells * (3 + (input.previous ? 1 : 0)) > limits.bytes)
    throw new RangeError('Voxel expression buffer memory exceeds the 64 MiB limit; resize the model first.');
  if (cells * iterations * program.workPerCell > limits.work)
    throw new RangeError(
      'Voxel expression work budget exceeded; reduce the volume, iterations or expression complexity.',
    );
  return { program, cells, iterations, frame, seed };
}

type Evaluate = (context: Context) => number;
const finite = (value: number, node: Node): number => {
  if (!Number.isFinite(value))
    throw new VoxelExpressionError(
      'evaluation',
      'Expression produced a non-finite number or division by zero.',
      node.line,
      node.column,
    );
  return value;
};

// Turns the syntax tree into closures. Every operation, its order and its checks are those of the reference
// tree-walking interpreter, so results are bit-identical; only the dispatch is faster.
function lower(node: Node): Evaluate {
  switch (node.kind) {
    case 'number': {
      const value = node.value;
      return () => value;
    }
    case 'variable': {
      const name = node.name;
      switch (name) {
        case 'x':
        case 'y':
        case 'z':
        case 'sx':
        case 'sy':
        case 'sz':
        case 'frame':
        case 'iteration':
        case 'seed':
          return (c) => c[name];
        case 'color':
          return (c) => c.current[c.x + c.sx * (c.z + c.sz * c.y)];
        case 'pi':
          return () => Math.PI;
        case 'e':
          return () => Math.E;
        case 'true':
          return () => 1;
        case 'false':
          return () => 0;
        default:
          return (c) => c.parameters[name];
      }
    }
    case 'conditional': {
      const test = lower(node.test),
        yes = lower(node.yes),
        no = lower(node.no);
      return (c) => (test(c) !== 0 ? yes(c) : no(c));
    }
    case 'unary': {
      const value = lower(node.value);
      if (node.operator === '!') return (c) => finite(Number(value(c) === 0), node);
      if (node.operator === '-') return (c) => finite(-value(c), node);
      return (c) => finite(value(c), node);
    }
    case 'binary': {
      const left = lower(node.left),
        right = lower(node.right);
      switch (node.operator) {
        case '&&':
          return (c) => (left(c) !== 0 ? Number(right(c) !== 0) : 0);
        case '||':
          return (c) => (left(c) !== 0 ? 1 : Number(right(c) !== 0));
        case '+':
          return (c) => finite(left(c) + right(c), node);
        case '-':
          return (c) => finite(left(c) - right(c), node);
        case '*':
          return (c) => finite(left(c) * right(c), node);
        case '/':
          return (c) => finite(left(c) / right(c), node);
        case '%':
          return (c) => finite(left(c) % right(c), node);
        case '**':
          return (c) => finite(left(c) ** right(c), node);
        case '<':
          return (c) => Number(left(c) < right(c));
        case '<=':
          return (c) => Number(left(c) <= right(c));
        case '>':
          return (c) => Number(left(c) > right(c));
        case '>=':
          return (c) => Number(left(c) >= right(c));
        case '==':
          return (c) => Number(left(c) === right(c));
        default:
          return (c) => Number(left(c) !== right(c));
      }
    }
    case 'call': {
      const fn = FUNCTIONS[node.name],
        args = node.args.map(lower),
        count = args.length;
      return (c) => {
        const values = new Array<number>(count);
        for (let i = 0; i < count; i++) values[i] = args[i](c);
        let result: number;
        try {
          result = fn.run(values, c);
        } catch (error) {
          throw new VoxelExpressionError(
            'evaluation',
            error instanceof Error ? error.message : 'Function failed.',
            node.line,
            node.column,
          );
        }
        return finite(result, node);
      };
    }
  }
}

/**
 * Evaluates the expression for every cell and returns a new grid: cell (x, y, z) of iteration i gets the expression's
 * value, which must be an integer palette index 0-255. Each iteration reads the previous iteration's output (the
 * input for the first) through `color` and `voxel()`; `prev()` reads `previous`. The input arrays are never changed.
 * Checks `signal` every 1,024 cells and throws its reason when aborted. Throws what
 * {@link validateVoxelExpressionInput} throws, and {@link VoxelExpressionError} `'evaluation'` at the operator or
 * function that failed (with the cell and iteration for a bad output).
 */
export function runVoxelExpression(input: VoxelExpressionInput, signal?: AbortSignal): VoxelExpressionResult {
  signal?.throwIfAborted();
  const { program, cells, iterations, frame, seed } = validateVoxelExpressionInput(input),
    root = trees.get(program) as Node,
    evaluate = lower(root),
    [sx, sy, sz] = input.size;
  let current = input.voxels.slice(),
    next = new Uint8Array(cells);
  const context: Context = {
    x: 0,
    y: 0,
    z: 0,
    sx,
    sy,
    sz,
    current,
    previous: input.previous,
    frame,
    iteration: 0,
    seed,
    parameters: { ...input.parameters },
  };
  for (let iteration = 0; iteration < iterations; iteration++) {
    context.iteration = iteration;
    context.current = current;
    for (let index = 0; index < cells; index++) {
      if ((index & 1023) === 0) signal?.throwIfAborted();
      context.x = index % sx;
      context.y = Math.floor(index / (sx * sz));
      context.z = Math.floor(index / sx) % sz;
      const value = evaluate(context);
      if (!Number.isInteger(value) || value < 0 || value > 255)
        throw new VoxelExpressionError(
          'evaluation',
          `Output must be an integer palette index 0-255; got ${value} at voxel (${context.x},${context.y},${context.z}), iteration ${iteration}.`,
          root.line,
          root.column,
        );
      next[index] = value;
    }
    [current, next] = [next, current];
  }
  return { size: [sx, sy, sz], voxels: current, stats: { cells, iterations, evaluations: cells * iterations } };
}
