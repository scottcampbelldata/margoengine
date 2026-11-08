// Placement rule graphs (entry `@margoengine/biomes/graph`): a small data-flow graph of rules, as plain JSON, that
// gives each species a density factor from the fields at a candidate: ranges on climate and terrain (the Wendland bands
// of suitability), world-anchored value noise, constants, and arithmetic, curve and blend nodes. Nodes are evaluated in
// topological order (Kahn 1962) once per candidate, on Q16.16 integers, so a graph decides the same objects on every
// machine, in a worker and on the GPU path, whose shared CPU tail reads the same factor. Placement multiplies a
// species' density by every output that selects it (thinning by density, Lane and Prusinkiewicz 2002).
import { rangeError, typeError } from '../../shared/errors.js';
import { type Dimension, fieldDimension, type Range } from './define.js';
import { clampInt, divFloor, ONE, qmul, wendland } from './fixed.js';
import { graphHook, type GraphFactor } from './graph-hook.js';
import { valueNoise } from './hash.js';
import { DEFAULT_LAYERS } from './layers.js';
import type { BiomeTile } from './world.js';

/** Fields a `range` node reads, in the units of {@link ClimateEnvelope} (curvature in 1/m). */
export type GraphField =
  | 'temperature'
  | 'coldest'
  | 'warmest'
  | 'gdd5'
  | 'season'
  | 'treeline'
  | 'rainfall'
  | 'moistureIndex'
  | 'moisture'
  | 'height'
  | 'slope'
  | 'exposure'
  | 'soil'
  | 'waterDistance'
  | 'curvature';

/** One rule of a {@link PlacementGraph}. Every value is 0..1; `id` is `[A-Za-z0-9_-]`, unique in the graph. */
export type GraphNode =
  /** A fixed value. */
  | { readonly id: string; readonly op: 'constant'; readonly value: number }
  /** 1 inside the range of a field, 0 beyond it, a Wendland band across each bound (`blend` of the width, 0.15). */
  | {
      readonly id: string;
      readonly op: 'range';
      readonly field: GraphField;
      readonly range: Range;
      readonly blend?: number;
    }
  /** World-anchored value noise with lattice cells `scale` whole metres across (1..100,000), and an integer seed. */
  | { readonly id: string; readonly op: 'noise'; readonly scale: number; readonly seed?: number }
  /** Product, minimum, maximum, or sum (capped at 1) of two or more inputs. */
  | { readonly id: string; readonly op: 'multiply' | 'min' | 'max' | 'add'; readonly inputs: readonly string[] }
  /** The first input less the second, at least 0. */
  | { readonly id: string; readonly op: 'subtract'; readonly inputs: readonly [string, string] }
  /** 1 less the input. */
  | { readonly id: string; readonly op: 'invert'; readonly input: string }
  /** A piecewise linear curve through `points` `[x, y]` (x increasing, 2..16 points), flat past both ends. */
  | {
      readonly id: string;
      readonly op: 'curve';
      readonly input: string;
      readonly points: readonly (readonly [number, number])[];
    }
  /** `a + (b - a) * by`: the first input where `by` is 0, the second where it is 1. */
  | { readonly id: string; readonly op: 'blend'; readonly inputs: readonly [string, string]; readonly by: string };

/** A placement rule graph as plain, JSON-serialisable data. */
export interface PlacementGraph {
  /** Up to 256 nodes, in any order; inputs name other nodes and must not form a cycle. */
  readonly nodes: readonly GraphNode[];
  /**
   * Density factors: a species selector to a node id. A selector is `'<biome>/<species>'`, a species id, or
   * `'#<tag>'` (every species with that tag). A species' density is multiplied by every output that selects it; a
   * species no output selects keeps its density. `BiomePlacement.attach` rejects a selector that selects nothing.
   */
  readonly outputs: Readonly<Record<string, string>>;
}

/** Ops and the node fields each one takes (beyond id and op). */
const OPS: Readonly<Record<string, readonly string[]>> = {
  constant: ['value'],
  range: ['field', 'range', 'blend'],
  noise: ['scale', 'seed'],
  multiply: ['inputs'],
  min: ['inputs'],
  max: ['inputs'],
  add: ['inputs'],
  subtract: ['inputs'],
  invert: ['input'],
  curve: ['input', 'points'],
  blend: ['inputs', 'by'],
};
const FIELD_NAMES = new Set<string>([
  'temperature',
  'coldest',
  'warmest',
  'gdd5',
  'season',
  'treeline',
  'rainfall',
  'moistureIndex',
  'moisture',
  'height',
  'slope',
  'exposure',
  'soil',
  'waterDistance',
  'curvature',
]);
const unit = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;
const q16 = (v: number) => Math.round(v * ONE);

/** A compiled node: reads earlier values and the fields at cell `k`, at world position x, z (ticks). */
type Step = (
  v: Int32Array,
  layers: Readonly<Record<string, ArrayLike<number>>>,
  k: number,
  x: number,
  z: number,
) => number;

/** A validated graph: its steps in evaluation order and each node's slot. */
interface Compiled {
  readonly steps: readonly Step[];
  readonly slot: ReadonlyMap<string, number>;
  readonly layers: readonly string[];
}

const compiled = new WeakMap<PlacementGraph, Compiled>();

function band(d: Dimension): Step {
  return (_v, layers, k) => {
    const value = layers[d.layer][k],
      dist = Math.max(d.lo - value, value - d.hi);
    return wendland(clampInt(divFloor((dist + (d.width >> 1)) * ONE, d.width), 0, ONE));
  };
}

function curve(input: number, points: readonly (readonly [number, number])[]): Step {
  const xs = points.map(([x]) => q16(x)),
    ys = points.map(([, y]) => q16(y)),
    last = xs.length - 1;
  return (v) => {
    const t = v[input];
    if (t <= xs[0]) return ys[0];
    if (t >= xs[last]) return ys[last];
    let i = 1;
    while (xs[i] < t) i++;
    // xs[i] > xs[i - 1]: validated strictly increasing.
    return ys[i - 1] + divFloor((ys[i] - ys[i - 1]) * (t - xs[i - 1]), xs[i] - xs[i - 1]);
  };
}

function compile(graph: PlacementGraph): Compiled {
  const done = compiled.get(graph);
  if (done) return done;
  if (typeof graph !== 'object' || graph === null || !Array.isArray(graph.nodes))
    throw typeError('A placement graph is { nodes: [...], outputs: { selector: node id } }', 'biomes');
  if (graph.nodes.length < 1 || graph.nodes.length > 256)
    throw rangeError('A placement graph has 1 to 256 nodes', 'biomes');
  const byId = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (typeof node !== 'object' || node === null || typeof node.id !== 'string' || !/^[\w-]{1,64}$/.test(node.id))
      throw rangeError('A placement graph node has an id of letters, digits, _ and - (1 to 64)', 'biomes');
    if (byId.has(node.id)) throw rangeError(`Two placement graph nodes are named ${node.id}`, 'biomes');
    const fields = OPS[node.op as string];
    if (!fields)
      throw rangeError(
        'A placement graph op is constant, range, noise, multiply, min, max, add, subtract, invert, curve or blend',
        'biomes',
      );
    for (const key of Object.keys(node))
      if (key !== 'id' && key !== 'op' && !fields.includes(key))
        throw rangeError(`A placement graph ${node.op} node takes ${fields.join(', ')}`, 'biomes');
    byId.set(node.id, node);
  }
  const inputsOf = (n: GraphNode): readonly string[] =>
    'inputs' in n ? [...n.inputs, ...('by' in n ? [n.by] : [])] : 'input' in n ? [n.input] : [];
  // Kahn's order: a node runs once every input has.
  const order: GraphNode[] = [],
    waiting = new Map<string, number>(),
    users = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const ins = inputsOf(n);
    if (!Array.isArray(ins) || ins.some((i) => typeof i !== 'string' || !byId.has(i)))
      throw rangeError(`Placement graph node ${n.id} names an input that is not a node of the graph`, 'biomes');
    waiting.set(n.id, ins.length);
    for (const i of ins) users.set(i, [...(users.get(i) ?? []), n.id]);
  }
  const ready = graph.nodes.filter((n) => waiting.get(n.id) === 0).map((n) => n.id);
  while (ready.length) {
    const id = ready.shift()!;
    order.push(byId.get(id)!);
    for (const u of users.get(id) ?? []) {
      const left = waiting.get(u)! - 1;
      waiting.set(u, left);
      if (left === 0) ready.push(u);
    }
  }
  if (order.length !== graph.nodes.length) throw rangeError('A placement graph has a cycle', 'biomes');
  const slot = new Map(order.map((n, i) => [n.id, i])),
    layers = new Set<string>(),
    steps = order.map((n): Step => {
      const at = (id: string) => slot.get(id)!;
      switch (n.op) {
        case 'constant': {
          if (!unit(n.value)) throw rangeError('A placement graph constant is 0..1', 'biomes');
          const c = q16(n.value);
          return () => c;
        }
        case 'range': {
          if (!FIELD_NAMES.has(n.field))
            throw rangeError(`A placement graph range reads one of ${[...FIELD_NAMES].join(', ')}`, 'biomes');
          const r = n.range,
            ok =
              Array.isArray(r) &&
              r.length === 2 &&
              r.every((b) => b === null || (typeof b === 'number' && Number.isFinite(b))) &&
              !(r[0] !== null && r[1] !== null && r[0] > r[1]);
          if (!ok) throw rangeError('A placement graph range is [min, max] with null for an open side', 'biomes');
          if (n.blend !== undefined && !(n.blend > 0 && n.blend <= 1))
            throw rangeError('A placement graph range blend is above 0 and at most 1', 'biomes');
          const d = fieldDimension(n.field, r, n.blend ?? 0.15);
          layers.add(d.layer);
          return band(d);
        }
        case 'noise': {
          if (!Number.isInteger(n.scale) || n.scale < 1 || n.scale > 100000)
            throw rangeError('A placement graph noise scale is a whole number of metres, 1..100,000', 'biomes');
          if (n.seed !== undefined && !Number.isSafeInteger(n.seed))
            throw rangeError('A placement graph noise seed is an integer', 'biomes');
          const s = n.scale,
            seed = n.seed ?? 0;
          // Ticks (1/256 m) to Q16 lattice units: x * 65,536 / (256 * scale) = x * 256 / scale.
          return (_v, _l, _k, x, z) => valueNoise(seed, divFloor(x * 256, s), divFloor(z * 256, s));
        }
        case 'multiply':
        case 'min':
        case 'max':
        case 'add': {
          if (n.inputs.length < 2 || n.inputs.length > 16)
            throw rangeError(`A placement graph ${n.op} node takes 2 to 16 inputs`, 'biomes');
          const ins = n.inputs.map(at);
          if (n.op === 'multiply')
            return (v) => {
              let p = v[ins[0]];
              for (let i = 1; i < ins.length; i++) p = qmul(p, v[ins[i]]);
              return p;
            };
          const op = n.op;
          return (v) => {
            let p = v[ins[0]];
            for (let i = 1; i < ins.length; i++) {
              const w = v[ins[i]];
              p = op === 'min' ? Math.min(p, w) : op === 'max' ? Math.max(p, w) : Math.min(ONE, p + w);
            }
            return p;
          };
        }
        case 'subtract': {
          if (n.inputs.length !== 2) throw rangeError('A placement graph subtract node takes 2 inputs', 'biomes');
          const [a, b] = n.inputs.map(at);
          return (v) => Math.max(0, v[a] - v[b]);
        }
        case 'invert': {
          const a = at(n.input);
          return (v) => ONE - v[a];
        }
        case 'curve': {
          const p = n.points,
            ok =
              Array.isArray(p) &&
              p.length >= 2 &&
              p.length <= 16 &&
              p.every(
                (pt, i) =>
                  Array.isArray(pt) &&
                  pt.length === 2 &&
                  unit(pt[0]) &&
                  unit(pt[1]) &&
                  (i === 0 || q16(pt[0]) > q16(p[i - 1][0])),
              );
          if (!ok)
            throw rangeError('A placement graph curve has 2 to 16 points [x, y] in 0..1, x increasing', 'biomes');
          return curve(at(n.input), p);
        }
        case 'blend': {
          if (n.inputs.length !== 2) throw rangeError('A placement graph blend node takes 2 inputs and by', 'biomes');
          const [a, b] = n.inputs.map(at),
            t = at(n.by);
          return (v) => v[a] + qmul(v[b] - v[a], v[t]);
        }
      }
    });
  for (const layer of layers)
    if (!DEFAULT_LAYERS.includes(layer))
      throw rangeError(`A placement graph reads layer ${layer}, which tiles do not hold`, 'biomes');
  if (typeof graph.outputs !== 'object' || graph.outputs === null)
    throw typeError('A placement graph has outputs: { selector: node id }', 'biomes');
  for (const [selector, id] of Object.entries(graph.outputs))
    if (!slot.has(id))
      throw rangeError(`Placement graph output ${selector} names ${id}, not a node of the graph`, 'biomes');
  const result = { steps, slot, layers: [...layers] };
  compiled.set(graph, result);
  return result;
}

/** Runs the graph once; the values of every node land in `v` (slot order). */
function run(
  c: Compiled,
  v: Int32Array,
  layers: Readonly<Record<string, ArrayLike<number>>>,
  k: number,
  x: number,
  z: number,
): void {
  for (let i = 0; i < c.steps.length; i++) v[i] = clampInt(c.steps[i](v, layers, k, x, z), 0, ONE);
}

/**
 * Checks a placement graph and freezes it: node ids, ops and their settings, inputs (no cycle, no missing node),
 * fields tiles hold, and outputs naming nodes. Selectors are checked against the world's species by
 * `BiomePlacement.attach`.
 * @throws RangeError or TypeError naming the first problem.
 */
export function definePlacementGraph(graph: PlacementGraph): PlacementGraph {
  const frozen: PlacementGraph = Object.freeze({
    nodes: Object.freeze(graph.nodes.map((n) => Object.freeze({ ...n }))),
    outputs: Object.freeze({ ...graph.outputs }),
  });
  compile(frozen);
  return frozen;
}

/**
 * One node's value over a world tile, 0..255 per cell (`cells` x `cells`, rows of increasing z), read at each cell's
 * centre: for a preview, or to write as a `mask/<name>` layer with `world.writeLayer` for envelopes and paint masks.
 * The tile must hold the layers the graph reads (a tile made with the default layers does).
 */
export function evaluateGraph(graph: PlacementGraph, node: string, tile: BiomeTile): Uint8Array {
  const c = compile(graph),
    out = c.slot.get(node);
  if (out === undefined) throw rangeError(`Placement graph node ${node} is not in the graph`, 'biomes');
  const layers: Record<string, ArrayLike<number>> = {};
  for (const name of c.layers) {
    const layer = tile.layer(name);
    if (!layer) throw rangeError(`evaluateGraph needs a tile holding the ${name} layer`, 'biomes');
    layers[name] = layer.data;
  }
  const n = tile.cells,
    cell = Math.round(tile.resolution * 256),
    x0 = tile.x * n * cell + (cell >> 1),
    z0 = tile.z * n * cell + (cell >> 1),
    v = new Int32Array(c.steps.length),
    data = new Uint8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      run(c, v, layers, j * n + i, x0 + i * cell, z0 + j * cell);
      data[j * n + i] = divFloor(v[out] * 255 + (ONE >> 1), ONE);
    }
  return data;
}

/**
 * The density factor of each species, by palette order: undefined for a species no output selects. Used by
 * placement through the graph hook.
 */
function factors(
  graph: PlacementGraph,
  species: readonly { readonly key: string; readonly id: string; readonly tags: readonly string[] }[],
): (GraphFactor | undefined)[] {
  const c = compile(graph),
    v = new Int32Array(c.steps.length),
    picks = species.map(() => [] as number[]);
  for (const [selector, id] of Object.entries(graph.outputs)) {
    let hit = false;
    species.forEach((s, i) => {
      if (selector === s.key || selector === s.id || (selector.startsWith('#') && s.tags.includes(selector.slice(1)))) {
        picks[i].push(c.slot.get(id)!);
        hit = true;
      }
    });
    if (!hit) throw rangeError(`Placement graph output ${selector} selects no species of this world`, 'biomes');
  }
  return picks.map((outs) =>
    outs.length
      ? (layers, k, x, z) => {
          run(c, v, layers, k, x, z);
          let p = v[outs[0]];
          for (let i = 1; i < outs.length; i++) p = qmul(p, v[outs[i]]);
          return p;
        }
      : undefined,
  );
}

graphHook.factors = factors;
