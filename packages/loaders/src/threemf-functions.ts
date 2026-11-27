// Evaluates the functions of the 3MF Volumetric and Implicit Extensions
// (https://github.com/3MFConsortium/spec_volumetric): image samplers (section 2.2) and graphs of native nodes (implicit
// chapter 5). A graph compiles into one list of steps over fixed buffers; a called function is inlined. A value that is
// undefined is NaN, and so is everything computed from it (implicit section 6.2).
import type { ThreeMFFunctionNode, ThreeMFImageSampler, ThreeMFImplicit, ThreeMFPort } from './threemf-volumetric.js';
import { LoaderError } from './types.js';

const F = '3MF';
const SIZE = { scalar: 1, vector: 3, matrix: 16, resourceid: 0 } as const;
const MAX_STEPS = 100_000;

/** A buffer of 1, 3 or 16 numbers, or the id of a resource, which is known before anything runs. */
export type FieldValue = Float64Array | string;
type Step = () => void;

/** The voxels of an image stack: RGBA, 16 bits a sample, sheet by sheet, each top row first. */
export interface Voxels {
  columns: number;
  rows: number;
  sheets: number;
  data: Uint16Array;
}

/** What the functions of one model part read. */
export interface FieldScope {
  functions: ReadonlyMap<string, ThreeMFImageSampler | ThreeMFImplicit>;
  /** The voxels of an `image3d`. */
  voxels(imageId: string): Voxels;
  /** The signed distance to a mesh object (negative inside), or the unsigned one. */
  distance(objectId: string, signed: boolean): (x: number, y: number, z: number) => number;
}

const bad = (message: string): never => {
  throw new LoaderError(F, 'syntax', message);
};

/** A voxel index outside `0..size - 1` under a tile style. */
const tiled = (style: string, i: number, size: number): number => {
  if (style === 'clamp') return Math.min(size - 1, Math.max(i, 0));
  const turns = Math.floor(i / size);
  return style === 'mirror' && turns % 2 !== 0 ? (turns + 1) * size - i - 1 : i - turns * size;
};

function sampler(f: ThreeMFImageSampler, voxels: Voxels, pos: Float64Array, out: Map<string, Float64Array>): Step {
  const { columns, rows, sheets, data } = voxels,
    rgba = new Float64Array(4),
    [tileU, tileV, tileW] = f.tile,
    color = out.get('color')!,
    channels = ['red', 'green', 'blue', 'alpha'].map((name) => out.get(name)!);
  /** A coordinate brought into 0..1 by its tile style, so a far point keeps its precision. */
  const wrapped = (style: string, s: number): number =>
    style === 'clamp'
      ? Math.min(1, Math.max(0, s))
      : style === 'mirror'
        ? 1 - Math.abs(s - 2 * Math.floor(s / 2) - 1)
        : s - Math.floor(s);
  return () => {
    if (!Number.isFinite(pos[0] + pos[1] + pos[2])) rgba.fill(NaN);
    else {
      // Voxel centres are at halves; rows run down as v runs up (section 3.2).
      const c = wrapped(tileU, pos[0]) * columns - 0.5,
        r = (1 - wrapped(tileV, pos[1])) * rows - 0.5,
        s = wrapped(tileW, pos[2]) * sheets - 0.5;
      const add = (i: number, j: number, k: number, weight: number): void => {
        const at = ((tiled(tileW, k, sheets) * rows + tiled(tileV, i, rows)) * columns + tiled(tileU, j, columns)) * 4;
        for (let n = 0; n < 4; n++) rgba[n] += (data[at + n] / 65535) * weight;
      };
      rgba.fill(0);
      if (f.filter === 'nearest') {
        // The nearest centre; halfway between two, the one of lower index.
        const lower = (x: number): number => Math.ceil(x - 0.5 - 1e-9);
        add(lower(r), lower(c), lower(s), 1);
      } else {
        const i = Math.floor(r),
          j = Math.floor(c),
          k = Math.floor(s);
        for (let n = 0; n < 8; n++) {
          const di = (n >> 1) & 1,
            dj = n & 1,
            dk = n >> 2,
            weight = (di ? r - i : 1 - r + i) * (dj ? c - j : 1 - c + j) * (dk ? s - k : 1 - s + k);
          add(i + di, j + dj, k + dk, weight);
        }
      }
    }
    for (let n = 0; n < 4; n++) channels[n][0] = rgba[n] * f.scale + f.offset;
    for (let n = 0; n < 3; n++) color[n] = channels[n][0];
  };
}

const UNARY: Record<string, (a: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  abs: Math.abs,
  sqrt: Math.sqrt,
  exp: Math.exp,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  cosh: Math.cosh,
  sinh: Math.sinh,
  tanh: Math.tanh,
  round: (a) => Math.sign(a) * Math.round(Math.abs(a)),
  ceil: Math.ceil,
  floor: Math.floor,
  sign: Math.sign,
  fract: (a) => a - Math.floor(a),
};
const BINARY: Record<string, (a: number, b: number) => number> = {
  addition: (a, b) => a + b,
  subtraction: (a, b) => a - b,
  multiplication: (a, b) => a * b,
  division: (a, b) => a / b,
  atan2: Math.atan2,
  min: Math.min,
  max: Math.max,
  fmod: (a, b) => a % b,
  mod: (a, b) => a - b * Math.floor(a / b),
  // Math.pow gives 1 for an undefined base to the power 0.
  pow: (a, b) => (a !== a || b !== b ? NaN : a ** b),
};

/** Writes the inverse of a row-major 4 x 4 matrix, or NaN for one without. Gauss-Jordan with row pivoting. */
function invert(m: Float64Array, out: Float64Array): void {
  const a = Array.from({ length: 4 }, (_, r) => [
    ...m.subarray(r * 4, r * 4 + 4),
    ...[0, 1, 2, 3].map((c) => +(r === c)),
  ]);
  for (let c = 0; c < 4; c++) {
    let pivot = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (!(Math.abs(a[pivot][c]) > 0)) return void out.fill(NaN);
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const scale = a[c][c];
    for (let k = 0; k < 8; k++) a[c][k] /= scale;
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const factor = a[r][c];
      for (let k = 0; k < 8; k++) a[r][k] -= factor * a[c][k];
    }
  }
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) out[r * 4 + c] = Number.isFinite(a[r][4 + c]) ? a[r][4 + c] : NaN;
}

/**
 * Compiles function `id` of a scope over `inputs`, whose buffers the caller writes before each `run`. `outputs` holds
 * the function's outputs by name.
 *
 * @throws LoaderError for a missing or mistyped input, a node this evaluator does not know, and functions that call
 * themselves.
 */
export function compileField(
  scope: FieldScope,
  id: string,
  inputs: ReadonlyMap<string, FieldValue>,
): { run: Step; outputs: Map<string, FieldValue> } {
  const steps: Step[] = [],
    budget = { steps: MAX_STEPS };
  const outputs = inline(scope, id, inputs, steps, [], budget);
  return {
    outputs,
    run: () => {
      for (const step of steps) step();
    },
  };
}

function inline(
  scope: FieldScope,
  id: string,
  inputs: ReadonlyMap<string, FieldValue>,
  steps: Step[],
  calls: readonly string[],
  budget: { steps: number },
): Map<string, FieldValue> {
  const f = scope.functions.get(id) ?? bad(`function ${id.slice(0, 32)} is not defined`),
    label = `function ${id.slice(0, 32)}`;
  if (calls.includes(id) || calls.length > 64) bad(`${label} calls itself`);
  const outputs = new Map<string, FieldValue>();
  if (f.kind === 'image') {
    const pos = inputs.get('pos');
    if (!(pos instanceof Float64Array) || pos.length !== 3) bad(`${label} needs the vector input pos`);
    const out = new Map(['color', 'red', 'green', 'blue', 'alpha'].map((n, i) => [n, new Float64Array(i ? 1 : 3)]));
    steps.push(sampler(f, scope.voxels(f.imageId), pos as Float64Array, out));
    return out;
  }
  const values = new Map<string, FieldValue>();
  for (const { name, type } of f.inputs) {
    const value = inputs.get(name);
    if (value === undefined || (type === 'resourceid') !== (typeof value === 'string'))
      bad(`${label} is called without its ${type} input ${name.slice(0, 64)}`);
    if (value instanceof Float64Array && value.length !== SIZE[type])
      bad(`${label} is called with another type for ${name.slice(0, 64)}`);
    values.set(`inputs.${name}`, value!);
  }
  const read = (port: ThreeMFPort): FieldValue =>
    values.get(port.ref!) ?? bad(`${label}: ${String(port.ref).slice(0, 64)} is not an earlier output`);
  for (const node of f.nodes) {
    if (--budget.steps < 0) throw new LoaderError(F, 'limit', `${label} expands to more than ${MAX_STEPS} nodes`);
    compileNode(scope, node, label, read, values, steps, [...calls, id], budget);
  }
  for (const port of f.outputs) outputs.set(port.name, read(port));
  return outputs;
}

function compileNode(
  scope: FieldScope,
  node: ThreeMFFunctionNode,
  label: string,
  read: (port: ThreeMFPort) => FieldValue,
  values: Map<string, FieldValue>,
  steps: Step[],
  calls: readonly string[],
  budget: { steps: number },
): void {
  const { op, attributes } = node,
    what = `${label}: node ${node.id.slice(0, 64)} (${op.slice(0, 32)})`,
    port = (name: string): ThreeMFPort =>
      node.inputs.find((p) => p.name === name) ?? bad(`${what} needs the input ${name}`),
    value = (name: string, size?: number): Float64Array => {
      const v = read(port(name));
      if (!(v instanceof Float64Array) || (size !== undefined && v.length !== size))
        bad(`${what}: input ${name} has the wrong type`);
      return v as Float64Array;
    },
    resource = (name: string): string => {
      const v = read(port(name));
      return typeof v === 'string' ? v : bad(`${what}: input ${name} is not a resource`);
    };
  const store = (name: string, v: FieldValue): void => void values.set(`${node.id}.${name}`, v);
  /** A buffer for the output `name`, or the node's only output. */
  const result = (size: number, name?: string): Float64Array => {
    const out = name === undefined ? node.outputs[0] : node.outputs.find((p) => p.name === name),
      buffer = new Float64Array(size);
    if (!out) {
      if (name === undefined) bad(`${what} has no output`);
      return buffer;
    }
    if (SIZE[out.type] !== size) bad(`${what}: output ${out.name.slice(0, 64)} has the wrong type`);
    store(out.name, buffer);
    return buffer;
  };
  const defined = (x: number): number => (Number.isFinite(x) ? x : NaN);
  const numbers = (list: readonly (string | undefined)[]): number[] =>
    list.map((text) => {
      const n = Number(text);
      return text?.trim() && Number.isFinite(n) ? n : bad(`${what}: invalid constant`);
    });
  if (Object.hasOwn(UNARY, op)) {
    const apply = UNARY[op],
      a = value('A'),
      out = result(a.length);
    steps.push(() => {
      for (let i = 0; i < out.length; i++) out[i] = defined(apply(a[i]));
    });
  } else if (Object.hasOwn(BINARY, op)) {
    const apply = BINARY[op],
      a = value('A'),
      b = value('B', a.length),
      out = result(a.length);
    steps.push(() => {
      for (let i = 0; i < out.length; i++) out[i] = defined(apply(a[i], b[i]));
    });
  } else if (op === 'constant' || op === 'constvec' || op === 'constmat') {
    const list =
        op === 'constant'
          ? [attributes.value]
          : op === 'constvec'
            ? [attributes.x, attributes.y, attributes.z]
            : (attributes.matrix ?? '').trim().split(/\s+/),
      size = op === 'constant' ? 1 : op === 'constvec' ? 3 : 16;
    if (list.length !== size) bad(`${what}: invalid constant`);
    result(size).set(numbers(list));
  } else if (op === 'constresourceid') {
    const out = node.outputs[0] ?? bad(`${what} has no output`);
    store(out.name, attributes.value ?? attributes.resourceid ?? bad(`${what} needs a value`));
  } else if (op === 'composevector' || op === 'composematrix') {
    const names =
        op === 'composevector'
          ? ['x', 'y', 'z']
          : Array.from({ length: 16 }, (_, i) => `m${Math.floor(i / 4)}${i % 4}`),
      from = names.map((name) => value(name, 1)),
      out = result(names.length);
    steps.push(() => from.forEach((v, i) => (out[i] = v[0])));
  } else if (op === 'vectorfromscalar') {
    const a = value('A', 1),
      out = result(3);
    steps.push(() => void out.fill(a[0]));
  } else if (op === 'decomposevector') {
    const a = value('A', 3),
      out = ['x', 'y', 'z'].map((name) => result(1, name));
    steps.push(() => out.forEach((v, i) => (v[0] = a[i])));
  } else if (op === 'matrixfromcolumns' || op === 'matrixfromrows') {
    const from = ['A', 'B', 'C', 'D'].map((name) => value(name, 3)),
      rows = op === 'matrixfromrows',
      out = result(16);
    steps.push(() => {
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 4; c++)
          out[r * 4 + c] = (rows ? c < 3 : r < 3) ? (rows ? from[r][c] : from[c][r]) : +(r === 3 && c === 3);
    });
  } else if (op === 'dot') {
    const a = value('A', 3),
      b = value('B', 3),
      out = result(1);
    steps.push(() => (out[0] = defined(a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  } else if (op === 'cross') {
    const a = value('A', 3),
      b = value('B', 3),
      out = result(3);
    steps.push(() => {
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3,
          k = (i + 2) % 3;
        out[i] = defined(a[j] * b[k] - a[k] * b[j]);
      }
    });
  } else if (op === 'length') {
    const a = value('A', 3),
      out = result(1);
    steps.push(() => (out[0] = defined(Math.hypot(a[0], a[1], a[2]))));
  } else if (op === 'matrixvectormultiplication' || op === 'matvecmultiplication') {
    const m = value('A', 16),
      v = value('B', 3),
      out = result(3);
    steps.push(() => {
      for (let r = 0; r < 3; r++)
        out[r] = defined(m[r * 4] * v[0] + m[r * 4 + 1] * v[1] + m[r * 4 + 2] * v[2] + m[r * 4 + 3]);
    });
  } else if (op === 'transpose') {
    const m = value('A', 16),
      out = result(16);
    steps.push(() => {
      for (let i = 0; i < 16; i++) out[i] = m[(i % 4) * 4 + Math.floor(i / 4)];
    });
  } else if (op === 'inverse') {
    const m = value('A', 16),
      out = result(16);
    steps.push(() => invert(m, out));
  } else if (op === 'clamp') {
    const a = value('A'),
      low = value('min', a.length),
      high = value('max', a.length),
      out = result(a.length);
    steps.push(() => {
      for (let i = 0; i < out.length; i++) out[i] = Math.max(low[i], Math.min(a[i], high[i]));
    });
  } else if (op === 'select') {
    const a = value('A'),
      b = value('B', a.length),
      c = value('C', a.length),
      d = value('D', a.length),
      out = result(a.length);
    steps.push(() => {
      for (let i = 0; i < out.length; i++) out[i] = a[i] !== a[i] || b[i] !== b[i] ? NaN : a[i] < b[i] ? c[i] : d[i];
    });
  } else if (op === 'mesh' || op === 'unsignedmesh') {
    const pos = value('pos', 3),
      distance = scope.distance(resource('mesh'), op === 'mesh'),
      out = result(1);
    steps.push(
      () => (out[0] = Number.isFinite(pos[0] + pos[1] + pos[2]) ? defined(distance(pos[0], pos[1], pos[2])) : NaN),
    );
  } else if (op === 'functioncall') {
    const called = resource('functionID'),
      given = new Map(node.inputs.filter((p) => p.name !== 'functionID').map((p) => [p.name, read(p)])),
      returned = inline(scope, called, given, steps, calls, budget);
    for (const { name, type } of node.outputs) {
      const v = returned.get(name);
      if (v === undefined || (v instanceof Float64Array && v.length !== SIZE[type]))
        bad(`${what}: function ${called.slice(0, 32)} has no ${type} output ${name.slice(0, 64)}`);
      store(name, v!);
    }
  } else if (op === 'functiongradient' || op === 'normalizedistance') {
    const called = resource('functionID'),
      { scalaroutput, vectorinput } = attributes;
    if (!scalaroutput || !vectorinput) bad(`${what} needs scalaroutput and vectorinput`);
    const at = value(vectorinput, 3),
      step = value('step', 1),
      moved = new Float64Array(3),
      given = new Map(
        node.inputs.filter((p) => p.name !== 'functionID' && p.name !== 'step').map((p) => [p.name, read(p)]),
      ),
      own: Step[] = [];
    given.set(vectorinput, moved);
    const f = inline(scope, called, given, own, calls, budget).get(scalaroutput);
    if (!(f instanceof Float64Array) || f.length !== 1)
      bad(`${what}: function ${called.slice(0, 32)} has no scalar output ${scalaroutput.slice(0, 64)}`);
    const scalar = f as Float64Array,
      gradient = new Float64Array(3);
    const sample = (axis: number, by: number): number => {
      moved.set(at);
      if (axis >= 0) moved[axis] += by;
      for (const run of own) run();
      return scalar[0];
    };
    // Central differences, the step at least 1e-8.
    const differentiate = (): number => {
      const h = Math.max(step[0], 1e-8);
      for (let k = 0; k < 3; k++) gradient[k] = defined((sample(k, h) - sample(k, -h)) / (2 * h));
      return Math.hypot(gradient[0], gradient[1], gradient[2]);
    };
    if (op === 'functiongradient') {
      const direction = result(3, 'vector'),
        raw = result(3, 'gradient'),
        magnitude = result(1, 'magnitude');
      steps.push(() => {
        const length = differentiate();
        raw.set(gradient);
        magnitude[0] = length;
        for (let k = 0; k < 3; k++) direction[k] = defined(gradient[k] / length);
      });
    } else {
      const out = result(1);
      steps.push(() => {
        const length = differentiate();
        out[0] = defined(sample(-1, 0) / Math.max(length, 1e-8));
      });
    }
  } else
    throw new LoaderError(F, 'unsupported', `${what}: this node is not evaluated; tessellate level sets elsewhere`);
}
