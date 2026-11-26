// A serializable geometry graph: sources, setters, instantiate on vertices and faces, conditionals, noise, merge and
// material ids, evaluated into one mesh. The graph is plain JSON (`{format, version, nodes, output}`); `GeometryGraph`
// builds, validates, saves and runs it. Gradient noise follows Perlin, "Improving Noise" (SIGGRAPH 2002), with the
// permutation table shuffled by a seeded generator. No editor: that is in docs/do-later.md.
import {
  boxGeometry,
  capsuleGeometry,
  circleGeometry,
  coneGeometry,
  cylinderGeometry,
  planeGeometry,
  sphereGeometry,
  torusGeometry,
} from './primitives.js';
import type { GeometryData, GeometryGroup } from './data.js';

/** A graph input: a number, a boolean, a vector `[x, y, z]`, or the output of another node. */
export type GraphValue = number | boolean | number[] | { node: string };
/** Parameter values are plain JSON: numbers, booleans and strings. */
export type GraphParam = number | boolean | string;

/** One node: its `type`, constant `params` and `inputs` wired to literals or other nodes. */
export interface GraphNode {
  id: string;
  type: string;
  params?: Record<string, GraphParam>;
  inputs?: Record<string, GraphValue | GraphValue[]>;
}

/** The saved form of a graph. */
export interface GeometryGraphJSON {
  format: 'margo-geometry-graph';
  version: 1;
  nodes: GraphNode[];
  /** Id of the geometry node whose result is the mesh. */
  output: string;
}

/** A built mesh: `GeometryData` plus optional rgba vertex colours. Groups are per material id, sorted by it. */
export interface GraphGeometry extends GeometryData {
  /** rgba per vertex, present when a setter or an input gave colours. */
  colors?: Float32Array;
}

/** Limits and inputs of {@link GeometryGraph.build} and {@link parseGeometryGraph}. */
export interface GraphOptions {
  /** Most nodes. Default 4096. */
  maxNodes?: number;
  /** Longest chain of nodes from the output back to a leaf. Default 256. */
  maxDepth?: number;
  /** Most vertices in any geometry the graph makes. Default 4,000,000. */
  maxVertices?: number;
  /** Most triangles in any geometry the graph makes. Default 8,000,000. */
  maxTriangles?: number;
  /** Most field evaluations: one for each vertex, face or instance a setter or instancer visits. Default 100,000,000. */
  maxEvaluations?: number;
  /** Geometry the `input` nodes read, by name. */
  inputs?: Record<string, GeometryData & { colors?: ArrayLike<number> }>;
  /** Added to every seed: change it for another random arrangement. Default 0. */
  seed?: number;
  /** Aborts a long build between vertices; the build throws `signal.reason`. */
  signal?: AbortSignal;
}

type Kind = 'geometry' | 'value' | 'bool' | 'any';
interface ParamSpec {
  default: GraphParam;
  /** `int` and `number` bounds, or the allowed strings. */
  min?: number;
  max?: number;
  values?: readonly string[];
  int?: boolean;
}
interface InputSpec {
  kind: Kind;
  default?: GraphValue;
  /** The input takes a list of nodes (merge). */
  list?: boolean;
}
interface TypeSpec {
  out: Kind;
  params: Record<string, ParamSpec>;
  inputs: Record<string, InputSpec>;
}

const seg = (def: number, min = 1): ParamSpec => ({ default: def, min, max: 4096, int: true });
const num = (def: number, min?: number, max?: number): ParamSpec => ({ default: def, min, max });
const size = (def: number): ParamSpec => ({ default: def, min: 0, max: 1e9 });
const val = (def?: GraphValue): InputSpec => ({ kind: 'value', default: def });
const geo: InputSpec = { kind: 'geometry' };
const OPS = ['<', '<=', '>', '>=', '==', '!='] as const;

const MATH1 = ['negate', 'abs', 'floor', 'ceil', 'fract', 'sin', 'cos', 'sqrt', 'normalize', 'length'] as const;
const MATH2 = ['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'pow', 'dot', 'cross', 'distance'] as const;

const TYPES: Record<string, TypeSpec> = {
  box: {
    out: 'geometry',
    inputs: {},
    params: {
      width: size(1),
      height: size(1),
      depth: size(1),
      widthSegments: seg(1),
      heightSegments: seg(1),
      depthSegments: seg(1),
    },
  },
  sphere: {
    out: 'geometry',
    inputs: {},
    params: { radius: size(1), widthSegments: seg(32, 3), heightSegments: seg(16, 2) },
  },
  cylinder: {
    out: 'geometry',
    inputs: {},
    params: {
      radiusTop: size(1),
      radiusBottom: size(1),
      height: size(1),
      radialSegments: seg(32, 3),
      heightSegments: seg(1),
      openEnded: { default: false },
    },
  },
  cone: {
    out: 'geometry',
    inputs: {},
    params: {
      radius: size(1),
      height: size(1),
      radialSegments: seg(32, 3),
      heightSegments: seg(1),
      openEnded: { default: false },
    },
  },
  plane: {
    out: 'geometry',
    inputs: {},
    params: { width: size(1), height: size(1), widthSegments: seg(1), heightSegments: seg(1) },
  },
  circle: { out: 'geometry', inputs: {}, params: { radius: size(1), segments: seg(32, 3) } },
  torus: {
    out: 'geometry',
    inputs: {},
    params: { radius: size(1), tube: size(0.4), radialSegments: seg(12, 3), tubularSegments: seg(48, 3) },
  },
  capsule: {
    out: 'geometry',
    inputs: {},
    params: {
      radius: size(1),
      height: size(1),
      capSegments: seg(4),
      radialSegments: seg(8, 3),
      heightSegments: seg(1),
    },
  },
  empty: { out: 'geometry', inputs: {}, params: {} },
  input: { out: 'geometry', inputs: {}, params: { name: { default: '' } } },
  // Per-element context: position, normal, uv, colour, vertex or face index, face centre, instance number.
  context: {
    out: 'value',
    inputs: {},
    params: {
      field: {
        default: 'position',
        values: ['position', 'normal', 'uv', 'color', 'index', 'count', 'faceIndex', 'instanceIndex'],
      },
    },
  },
  vec3: { out: 'value', inputs: { x: val(0), y: val(0), z: val(0) }, params: {} },
  swizzle: {
    out: 'value',
    inputs: { value: val(0) },
    params: { component: { default: 'x', values: ['x', 'y', 'z'] } },
  },
  random: { out: 'value', inputs: { min: val(0), max: val(1), seed: val(0), index: val() }, params: {} },
  noise: {
    out: 'value',
    inputs: { position: val([0, 0, 0]), scale: val(1) },
    params: {
      octaves: seg(1),
      lacunarity: num(2, 1, 16),
      gain: num(0.5, 0, 1),
      seed: num(0, 0, 4294967295),
      output: { default: 'float', values: ['float', 'vector'] },
    },
  },
  mix: { out: 'value', inputs: { a: val(0), b: val(1), t: val(0.5) }, params: {} },
  clamp: { out: 'value', inputs: { value: val(0), min: val(0), max: val(1) }, params: {} },
  compare: { out: 'bool', inputs: { a: val(0), b: val(0) }, params: { op: { default: '<', values: OPS } } },
  logic: {
    out: 'bool',
    inputs: { a: { kind: 'bool', default: false }, b: { kind: 'bool', default: false } },
    params: { op: { default: 'and', values: ['and', 'or', 'not'] } },
  },
  // Picks `then` or `otherwise` by `condition`; the branch not taken is never evaluated. Geometry or values.
  conditional: {
    out: 'any',
    inputs: { condition: { kind: 'bool', default: false }, then: { kind: 'any' }, otherwise: { kind: 'any' } },
    params: {},
  },
  setPositions: {
    out: 'geometry',
    inputs: { geometry: geo, positions: val() },
    params: { recomputeNormals: { default: true } },
  },
  setNormals: { out: 'geometry', inputs: { geometry: geo, normals: val() }, params: {} },
  setUVs: { out: 'geometry', inputs: { geometry: geo, uvs: val() }, params: {} },
  setColors: { out: 'geometry', inputs: { geometry: geo, colors: val() }, params: {} },
  setMaterialId: { out: 'geometry', inputs: { geometry: geo, id: val(0) }, params: {} },
  transform: {
    out: 'geometry',
    inputs: { geometry: geo, translation: val([0, 0, 0]), rotation: val([0, 0, 0]), scale: val(1) },
    params: {},
  },
  merge: { out: 'geometry', inputs: { geometries: { kind: 'geometry', list: true } }, params: {} },
  instantiateOnVertices: {
    out: 'geometry',
    inputs: { target: geo, instance: geo, scale: val(1), rotation: val([0, 0, 0]) },
    params: {
      alignToNormal: { default: false },
      uniqueVertices: { default: true },
      every: seg(1),
      keepTarget: { default: false },
    },
  },
  instantiateOnFaces: {
    out: 'geometry',
    inputs: { target: geo, instance: geo, scale: val(1), rotation: val([0, 0, 0]) },
    params: {
      alignToNormal: { default: false },
      perFace: seg(1),
      seed: num(0, 0, 4294967295),
      every: seg(1),
      keepTarget: { default: false },
    },
  },
};
for (const op of MATH1) TYPES[op] = { out: 'value', inputs: { value: val(0) }, params: {} };
for (const op of MATH2) TYPES[op] = { out: 'value', inputs: { a: val(0), b: val(0) }, params: {} };

/** The node types a graph may use. */
export const GRAPH_NODE_TYPES: readonly string[] = Object.keys(TYPES);

const FIELD_NODES = new Set([
  'setPositions',
  'setNormals',
  'setUVs',
  'setColors',
  'instantiateOnVertices',
  'instantiateOnFaces',
]);
const DEFAULTS = {
  maxNodes: 4096,
  maxDepth: 256,
  maxVertices: 4_000_000,
  maxTriangles: 8_000_000,
  maxEvaluations: 100_000_000,
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRef = (v: unknown): v is { node: string } => isObject(v) && typeof v.node === 'string';
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function limitOf(options: GraphOptions, key: keyof typeof DEFAULTS): number {
  const v = options[key] ?? DEFAULTS[key];
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`Graph ${key} must be a non-negative integer`);
  return v;
}

/**
 * Checks a graph document and returns a normalised deep copy: the format, every node's type, parameter (with bounds) and
 * input (with kinds), references to nodes that exist, no cycles, a longest chain within `maxDepth`, and an output that is
 * a geometry. Accepts the object or its JSON text. Throws `TypeError` for a wrong shape and `RangeError` for a value out of
 * range, a missing node or a limit.
 */
export function parseGeometryGraph(input: string | object, options: GraphOptions = {}): GeometryGraphJSON {
  const maxNodes = limitOf(options, 'maxNodes'),
    maxDepth = limitOf(options, 'maxDepth');
  let doc: unknown = input;
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input);
    } catch (e) {
      throw new TypeError(
        `Graph JSON is not valid: ${(e as Error).message.slice(0, 80)}; pass the graph object or the text of GeometryGraph.stringify()`,
      );
    }
  }
  if (!isObject(doc) || doc.format !== 'margo-geometry-graph')
    throw new TypeError("Graph format must be 'margo-geometry-graph'");
  if (doc.version !== 1)
    throw new RangeError(`Graph version ${String(doc.version)} is not supported; this reads version 1`);
  if (!Array.isArray(doc.nodes)) throw new TypeError('Graph nodes must be an array');
  if (doc.nodes.length > maxNodes)
    throw new RangeError(
      `Graph has ${doc.nodes.length} nodes, past the limit of ${maxNodes}; raise maxNodes or remove nodes`,
    );
  if (typeof doc.output !== 'string') throw new TypeError('Graph output must be a node id');
  const nodes: GraphNode[] = [];
  const byId = new Map<string, GraphNode>();
  for (const raw of doc.nodes as unknown[]) {
    if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 256)
      throw new TypeError('Graph node needs a string id of 1 to 256 characters');
    const id = raw.id;
    if (byId.has(id)) throw new RangeError(`Graph node id "${id}" is used twice; give each node its own id`);
    if (typeof raw.type !== 'string' || !own(TYPES, raw.type))
      throw new RangeError(
        `Graph node "${id}" has unknown type ${JSON.stringify(raw.type)}; use a type from GRAPH_NODE_TYPES`,
      );
    const spec = TYPES[raw.type];
    const node: GraphNode = { id, type: raw.type };
    const params = raw.params === undefined ? {} : raw.params;
    if (!isObject(params)) throw new TypeError(`Graph node "${id}" params must be an object`);
    const outParams: Record<string, GraphParam> = {};
    for (const [k, v] of Object.entries(params)) {
      if (!own(spec.params, k))
        throw new RangeError(
          `Graph node "${id}" (${raw.type}) has no parameter "${k}"; remove it, ${raw.type} takes ${Object.keys(spec.params).join(', ') || 'no parameters'}`,
        );
      const p = spec.params[k];
      if (typeof p.default === 'boolean') {
        if (typeof v !== 'boolean') throw new TypeError(`Graph node "${id}" parameter ${k} must be a boolean`);
      } else if (typeof p.default === 'string') {
        if (typeof v !== 'string' || (p.values && !p.values.includes(v)))
          throw new RangeError(
            `Graph node "${id}" parameter ${k} must be ${p.values ? p.values.map((x) => JSON.stringify(x)).join(', ') : 'a string'}`,
          );
        if (v.length > 256)
          throw new RangeError(`Graph node "${id}" parameter ${k} is too long; keep it to 256 characters`);
      } else {
        if (typeof v !== 'number' || !Number.isFinite(v))
          throw new TypeError(`Graph node "${id}" parameter ${k} must be a finite number`);
        if (p.int && !Number.isInteger(v)) throw new TypeError(`Graph node "${id}" parameter ${k} must be an integer`);
        if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max))
          throw new RangeError(`Graph node "${id}" parameter ${k} must be ${p.min ?? '-inf'} to ${p.max ?? 'inf'}`);
      }
      outParams[k] = v;
    }
    if (Object.keys(outParams).length) node.params = outParams;
    const inputs = raw.inputs === undefined ? {} : raw.inputs;
    if (!isObject(inputs)) throw new TypeError(`Graph node "${id}" inputs must be an object`);
    const outInputs: Record<string, GraphValue | GraphValue[]> = {};
    for (const [k, v] of Object.entries(inputs)) {
      if (!own(spec.inputs, k))
        throw new RangeError(
          `Graph node "${id}" (${raw.type}) has no input "${k}"; remove it, ${raw.type} takes ${Object.keys(spec.inputs).join(', ') || 'no inputs'}`,
        );
      const check = (x: unknown): GraphValue => {
        if (isRef(x)) return { node: x.node };
        if (typeof x === 'boolean') return x;
        if (typeof x === 'number' && Number.isFinite(x)) return x;
        if (
          Array.isArray(x) &&
          x.length >= 2 &&
          x.length <= 4 &&
          x.every((n) => typeof n === 'number' && Number.isFinite(n))
        )
          return x.slice();
        throw new TypeError(`Graph node "${id}" input ${k} must be a number, boolean, vector or { node }`);
      };
      if (spec.inputs[k].list) {
        if (!Array.isArray(v) || v.length > maxNodes)
          throw new TypeError(`Graph node "${id}" input ${k} must be a list of nodes`);
        outInputs[k] = v.map((x) => {
          if (!isRef(x)) throw new TypeError(`Graph node "${id}" input ${k} must hold only { node } references`);
          return check(x);
        });
      } else {
        if (Array.isArray(v) && v.length > 0 && v.every(isRef))
          throw new TypeError(
            `Graph node "${id}" input ${k} takes one value, not a list; wire one value, or merge nodes first`,
          );
        const checked = check(v);
        if (spec.inputs[k].kind === 'geometry' && !isRef(checked))
          throw new RangeError(`Graph node "${id}" input ${k} needs a geometry node`);
        outInputs[k] = checked;
      }
    }
    if (Object.keys(outInputs).length) node.inputs = outInputs;
    nodes.push(node);
    byId.set(id, node);
  }
  const outputOf = (n: GraphNode): Kind => TYPES[n.type].out;
  const refs = (n: GraphNode): { name: string; ref: string }[] => {
    const out: { name: string; ref: string }[] = [];
    for (const [k, v] of Object.entries(n.inputs ?? {}))
      for (const x of Array.isArray(v) && TYPES[n.type].inputs[k].list ? v : [v])
        if (isRef(x)) out.push({ name: k, ref: x.node });
    return out;
  };
  // A conditional's kind follows its branches, so kinds are resolved after the references are known.
  const kindMemo = new Map<string, Kind>();
  const kindOf = (id: string, seen = new Set<string>()): Kind => {
    const known = kindMemo.get(id);
    if (known) return known;
    const n = byId.get(id)!;
    let k = outputOf(n);
    if (k === 'any') {
      if (seen.has(id)) return 'any';
      seen.add(id);
      const t = n.inputs?.then,
        o = n.inputs?.otherwise;
      const branch = (x: unknown): Kind => (isRef(x) && byId.has(x.node) ? kindOf(x.node, seen) : 'value');
      const a = branch(t),
        b = branch(o);
      k = a === 'geometry' || b === 'geometry' ? 'geometry' : 'value';
    }
    kindMemo.set(id, k);
    return k;
  };
  for (const n of nodes)
    for (const { name, ref } of refs(n)) {
      if (!byId.has(ref))
        throw new RangeError(
          `Graph node "${n.id}" input ${name} names node "${ref}", which does not exist; add that node or fix the id`,
        );
      const want = TYPES[n.type].inputs[name].kind,
        have = kindOf(ref);
      const ok = want === 'any' || (want === 'value' ? have === 'value' || have === 'bool' : want === have);
      if (!ok) throw new RangeError(`Graph node "${n.id}" input ${name} needs ${want}, node "${ref}" makes ${have}`);
    }
  // Cycle and depth check, iterative.
  const depth = new Map<string, number>();
  const state = new Map<string, 1 | 2>();
  for (const start of nodes) {
    if (state.has(start.id)) continue;
    const stack: { id: string; next: { ref: string }[]; at: number }[] = [{ id: start.id, next: refs(start), at: 0 }];
    state.set(start.id, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.at < top.next.length) {
        const ref = top.next[top.at++].ref;
        const s = state.get(ref);
        if (s === 1)
          throw new RangeError(`Graph has a cycle through node "${ref}"; remove the wire that leads back to it`);
        if (!s) {
          state.set(ref, 1);
          stack.push({ id: ref, next: refs(byId.get(ref)!), at: 0 });
        }
      } else {
        let d = 0;
        for (const r of top.next) d = Math.max(d, depth.get(r.ref)!);
        depth.set(top.id, d + 1);
        if (d + 1 > maxDepth)
          throw new RangeError(
            `Graph chains ${d + 1} nodes deep, past the limit of ${maxDepth}; raise maxDepth or shorten the chain`,
          );
        state.set(top.id, 2);
        stack.pop();
      }
    }
  }
  if (!byId.has(doc.output))
    throw new RangeError(`Graph output "${doc.output}" is not a node; set the output to the id of a geometry node`);
  if (kindOf(doc.output) !== 'geometry')
    throw new RangeError(
      `Graph output "${doc.output}" is not a geometry node; set the output to the id of a geometry node`,
    );
  return { format: 'margo-geometry-graph', version: 1, nodes, output: doc.output };
}

// ---- evaluation -----------------------------------------------------------------------------------------------------

/** A mesh in the middle of a build: per-triangle material ids instead of groups. */
interface Work {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors?: Float32Array;
  indices: Uint32Array;
  material: Uint32Array;
}
type Vec = number[];
type Value = number | boolean | Vec | Work;
interface Ctx {
  index: number;
  count: number;
  position: Vec;
  normal: Vec;
  uv: Vec;
  color: Vec;
  faceIndex: number;
  instance: number;
}
const ROOT: Ctx = {
  index: 0,
  count: 0,
  position: [0, 0, 0],
  normal: [0, 1, 0],
  uv: [0, 0],
  color: [1, 1, 1, 1],
  faceIndex: 0,
  instance: 0,
};

function hash(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
const unit = (h: number): number => h / 4294967296;

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Improved Perlin noise (2002): fade 6t^5 - 15t^4 + 10t^3 and the 12 edge-centre gradients, over a seeded permutation. */
class Perlin {
  private p = new Uint8Array(512);
  constructor(seed: number) {
    const base = Array.from({ length: 256 }, (_, i) => i),
      rand = mulberry(seed ^ 0x51ed270b);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [base[i], base[j]] = [base[j], base[i]];
    }
    for (let i = 0; i < 512; i++) this.p[i] = base[i & 255];
  }
  private grad(h: number, x: number, y: number, z: number): number {
    const u = (h & 15) < 8 ? x : y,
      v = (h & 15) < 4 ? y : (h & 15) === 12 || (h & 15) === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }
  at(x: number, y: number, z: number): number {
    const p = this.p;
    const X = Math.floor(x) & 255,
      Y = Math.floor(y) & 255,
      Z = Math.floor(z) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    z -= Math.floor(z);
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10),
      lerp = (t: number, a: number, b: number) => a + t * (b - a);
    const u = fade(x),
      v = fade(y),
      w = fade(z);
    const A = p[X] + Y,
      AA = p[A] + Z,
      AB = p[A + 1] + Z,
      B = p[X + 1] + Y,
      BA = p[B] + Z,
      BB = p[B + 1] + Z;
    return lerp(
      w,
      lerp(
        v,
        lerp(u, this.grad(p[AA], x, y, z), this.grad(p[BA], x - 1, y, z)),
        lerp(u, this.grad(p[AB], x, y - 1, z), this.grad(p[BB], x - 1, y - 1, z)),
      ),
      lerp(
        v,
        lerp(u, this.grad(p[AA + 1], x, y, z - 1), this.grad(p[BA + 1], x - 1, y, z - 1)),
        lerp(u, this.grad(p[AB + 1], x, y - 1, z - 1), this.grad(p[BB + 1], x - 1, y - 1, z - 1)),
      ),
    );
  }
}

const isVec = (v: Value): v is Vec => Array.isArray(v);
const isWork = (v: Value): v is Work => typeof v === 'object' && !Array.isArray(v);
const bad = (m: string): never => {
  throw new TypeError(m);
};
function vec3(v: Value, what: string): [number, number, number] {
  if (typeof v === 'number') return [v, v, v];
  if (isVec(v) && v.length >= 3) return [v[0], v[1], v[2]];
  return bad(`Graph ${what} needs a number or a vector of 3`);
}
function scalar(v: Value, what: string): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return bad(`Graph ${what} needs a number`);
}
function lift(a: Value, b: Value, f: (x: number, y: number) => number, what: string): number | Vec {
  if (typeof a === 'number' && typeof b === 'number') return f(a, b);
  const x = vec3(a, what),
    y = vec3(b, what);
  return [f(x[0], y[0]), f(x[1], y[1]), f(x[2], y[2])];
}
function map1(a: Value, f: (x: number) => number, what: string): number | Vec {
  if (typeof a === 'number') return f(a);
  const x = vec3(a, what);
  return [f(x[0]), f(x[1]), f(x[2])];
}

// 3x3 plus translation, row-major in the arrays below: applies scale, then euler XYZ rotation (X first), then alignment.
function rotationMatrix(rx: number, ry: number, rz: number): number[] {
  const [sx, cx, sy, cy, sz, cz] = [Math.sin(rx), Math.cos(rx), Math.sin(ry), Math.cos(ry), Math.sin(rz), Math.cos(rz)];
  // R = Rz * Ry * Rx
  return [
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,
    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,
    -sy,
    cy * sx,
    cy * cx,
  ];
}
const mul3 = (a: number[], b: number[]): number[] => {
  const o: number[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) o.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  return o;
};
/** The rotation taking +Y onto the unit vector `n` along the shortest arc. */
function alignY(n: Vec): number[] {
  const [x, y, z] = n;
  if (y > 0.999999) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (y < -0.999999) return [1, 0, 0, 0, -1, 0, 0, 0, -1];
  // axis = Y x n = (z, 0, -x); angle cos = y
  const ax = z,
    az = -x,
    s = Math.hypot(ax, az),
    c = y;
  const kx = ax / s,
    kz = az / s,
    k = 1 - c;
  return [c + kx * kx * k, -kz * s, kx * kz * k, kz * s, c, -kx * s, kx * kz * k, kx * s, c + kz * kz * k];
}

/**
 * A geometry graph: add nodes, wire them, save and load it as JSON, and build the mesh.
 *
 * Node kinds: sources (`box`, `sphere`, `cylinder`, `cone`, `plane`, `circle`, `torus`, `capsule`, `empty`, `input`),
 * per-element `context` fields, vector and math nodes, `random`, `noise`, `compare`/`logic`/`conditional`, setters
 * (`setPositions`, `setNormals`, `setUVs`, `setColors`, `setMaterialId`), `transform`, `merge`, and `instantiateOnVertices`
 * and `instantiateOnFaces`. The input of a setter or instancer that is not a geometry is a field: it is evaluated once per
 * vertex or face with the `context` node reading that element.
 */
export class GeometryGraph {
  nodes: GraphNode[] = [];
  output = '';

  /** Adds a node and returns a reference to wire into other nodes' inputs. `id` defaults to `type_n`. */
  add(
    type: string,
    spec: { id?: string; params?: Record<string, GraphParam>; inputs?: Record<string, GraphValue | GraphValue[]> } = {},
  ): { node: string } {
    const id = spec.id ?? `${type}_${this.nodes.length}`;
    const node: GraphNode = { id, type };
    if (spec.params) node.params = spec.params;
    if (spec.inputs) node.inputs = spec.inputs;
    this.nodes.push(node);
    return { node: id };
  }

  /** Marks the geometry node whose result {@link build} returns. */
  setOutput(ref: { node: string } | string): this {
    this.output = typeof ref === 'string' ? ref : ref.node;
    return this;
  }

  /** The graph as a plain document, checked. */
  toJSON(options: GraphOptions = {}): GeometryGraphJSON {
    return parseGeometryGraph(
      { format: 'margo-geometry-graph', version: 1, nodes: this.nodes, output: this.output },
      options,
    );
  }

  /** The graph as JSON text. */
  stringify(options: GraphOptions = {}): string {
    return JSON.stringify(this.toJSON(options));
  }

  /** Reads a graph from its document or JSON text; see {@link parseGeometryGraph} for the checks. */
  static fromJSON(input: string | object, options: GraphOptions = {}): GeometryGraph {
    const doc = parseGeometryGraph(input, options),
      g = new GeometryGraph();
    g.nodes = doc.nodes;
    g.output = doc.output;
    return g;
  }

  /** Evaluates the graph into a mesh. */
  build(options: GraphOptions = {}): GraphGeometry {
    return runGraph(this.toJSON(options), options);
  }
}

/** Builds a graph document (or its JSON text) into a mesh, with every limit enforced. */
export function buildGeometryGraph(input: string | object, options: GraphOptions = {}): GraphGeometry {
  return runGraph(parseGeometryGraph(input, options), options);
}

function runGraph(graph: GeometryGraphJSON, options: GraphOptions): GraphGeometry {
  const maxVertices = limitOf(options, 'maxVertices'),
    maxTriangles = limitOf(options, 'maxTriangles'),
    maxEvaluations = limitOf(options, 'maxEvaluations'),
    seed = options.seed ?? 0,
    signal = options.signal;
  if (!Number.isInteger(seed)) throw new TypeError('Graph seed must be an integer');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let evaluations = 0;
  const tick = (n = 1): void => {
    evaluations += n;
    if (evaluations > maxEvaluations)
      throw new RangeError(`Graph ran past ${maxEvaluations} evaluations; raise maxEvaluations or simplify it`);
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  };
  const checkSize = (vertices: number, triangles: number): void => {
    if (vertices > maxVertices)
      throw new RangeError(
        `Graph geometry reaches ${vertices} vertices, past the limit of ${maxVertices}; raise maxVertices or lower the segments or instances`,
      );
    if (triangles > maxTriangles)
      throw new RangeError(
        `Graph geometry reaches ${triangles} triangles, past the limit of ${maxTriangles}; raise maxTriangles or lower the segments or instances`,
      );
  };

  // Which nodes read the per-element context, directly or through their inputs.
  const dynamic = new Map<string, boolean>();
  const isDynamic = (id: string): boolean => {
    let d = dynamic.get(id);
    if (d !== undefined) return d;
    const n = byId.get(id)!;
    d = n.type === 'context' || (n.type === 'random' && !n.inputs?.index);
    // A setter or an instancer reads the context inside its own fields; the geometry it makes does not depend on it.
    if (FIELD_NODES.has(n.type)) d = false;
    else if (!d)
      for (const v of Object.values(n.inputs ?? {}))
        for (const x of Array.isArray(v) && v.every((y) => isRef(y)) && v.length ? v : [v])
          if (isRef(x) && isDynamic(x.node)) d = true;
    dynamic.set(id, d);
    return d;
  };
  const perlins = new Map<number, Perlin>();
  const staticMemo = new Map<string, Value>();

  const ev = (id: string, ctx: Ctx, memo: Map<string, Value>): Value => {
    const dyn = isDynamic(id);
    const cache = dyn ? memo : staticMemo;
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const n = byId.get(id)!;
    const out = evalNode(n, ctx, memo);
    cache.set(id, out);
    return out;
  };
  const input = (n: GraphNode, name: string, ctx: Ctx, memo: Map<string, Value>): Value => {
    const spec = TYPES[n.type].inputs[name];
    const v = n.inputs?.[name] ?? spec.default;
    if (v === undefined) return bad(`Graph node "${n.id}" needs input ${name}`);
    if (isRef(v as GraphValue)) return ev((v as { node: string }).node, ctx, memo);
    return v as Value;
  };
  const geometryInput = (n: GraphNode, name: string): Work => {
    const v = n.inputs?.[name];
    if (!isRef(v as GraphValue)) return bad(`Graph node "${n.id}" needs a geometry on input ${name}`);
    const ref = (v as { node: string }).node;
    if (isDynamic(ref))
      throw new RangeError(
        `Graph node "${n.id}" input ${name} cannot depend on a per-element context; wire a value that has no context node behind it`,
      );
    const g = ev(ref, ROOT, staticMemo);
    return isWork(g) ? g : bad(`Graph node "${n.id}" input ${name} is not a geometry`);
  };
  /** Evaluates a field input for one element; a constant is returned as it is. */
  const constant = (n: GraphNode, name: string): Value => {
    const v = n.inputs?.[name];
    if (isRef(v as GraphValue) && isDynamic((v as { node: string }).node))
      throw new RangeError(
        `Graph node "${n.id}" input ${name} cannot depend on a per-element context; wire a value that has no context node behind it`,
      );
    return input(n, name, ROOT, staticMemo);
  };
  const fieldAt = (n: GraphNode, name: string, ctx: Ctx): Value => {
    tick();
    return input(n, name, ctx, new Map());
  };

  const evalNode = (n: GraphNode, ctx: Ctx, memo: Map<string, Value>): Value => {
    const p = (k: string): GraphParam => n.params?.[k] ?? TYPES[n.type].params[k].default;
    const pn = (k: string): number => p(k) as number;
    const guard = (vertices: number): void => checkSize(vertices, 0);
    const made = (data: GeometryData): Work => {
      checkSize(data.positions.length / 3, data.indices.length / 3);
      return fromData(data);
    };
    switch (n.type) {
      case 'box':
        guard(
          2 *
            ((pn('widthSegments') + 1) * (pn('heightSegments') + 1) +
              (pn('widthSegments') + 1) * (pn('depthSegments') + 1) +
              (pn('heightSegments') + 1) * (pn('depthSegments') + 1)),
        );
        return made(
          boxGeometry(
            pn('width'),
            pn('height'),
            pn('depth'),
            pn('widthSegments'),
            pn('heightSegments'),
            pn('depthSegments'),
          ),
        );
      case 'sphere':
        guard((pn('widthSegments') + 1) * (pn('heightSegments') + 1));
        return made(sphereGeometry(pn('radius'), pn('widthSegments'), pn('heightSegments')));
      case 'cylinder':
        guard((pn('radialSegments') + 1) * (pn('heightSegments') + 1) + 2 * (pn('radialSegments') + 2));
        return made(
          cylinderGeometry(
            pn('radiusTop'),
            pn('radiusBottom'),
            pn('height'),
            pn('radialSegments'),
            pn('heightSegments'),
            p('openEnded') as boolean,
          ),
        );
      case 'cone':
        guard((pn('radialSegments') + 1) * (pn('heightSegments') + 1) + 2 * (pn('radialSegments') + 2));
        return made(
          coneGeometry(
            pn('radius'),
            pn('height'),
            pn('radialSegments'),
            pn('heightSegments'),
            p('openEnded') as boolean,
          ),
        );
      case 'plane':
        guard((pn('widthSegments') + 1) * (pn('heightSegments') + 1));
        return made(planeGeometry(pn('width'), pn('height'), pn('widthSegments'), pn('heightSegments')));
      case 'circle':
        guard(pn('segments') + 2);
        return made(circleGeometry(pn('radius'), pn('segments')));
      case 'torus':
        guard((pn('radialSegments') + 1) * (pn('tubularSegments') + 1));
        return made(torusGeometry(pn('radius'), pn('tube'), pn('radialSegments'), pn('tubularSegments')));
      case 'capsule':
        guard((pn('radialSegments') + 1) * (2 * pn('capSegments') + pn('heightSegments') + 3));
        return made(
          capsuleGeometry(pn('radius'), pn('height'), pn('capSegments'), pn('radialSegments'), pn('heightSegments')),
        );
      case 'empty':
        return {
          positions: new Float32Array(0),
          normals: new Float32Array(0),
          uvs: new Float32Array(0),
          indices: new Uint32Array(0),
          material: new Uint32Array(0),
        };
      case 'input': {
        const name = p('name') as string;
        const source = options.inputs && own(options.inputs, name) ? options.inputs[name] : undefined;
        if (!source)
          throw new RangeError(
            `Graph input "${name}" was not passed in options.inputs; pass inputs['${name}'] to build()`,
          );
        checkSize(source.positions.length / 3, source.indices.length / 3);
        return fromData(source);
      }
      case 'context': {
        switch (p('field')) {
          case 'position':
            return ctx.position.slice();
          case 'normal':
            return ctx.normal.slice();
          case 'uv':
            return [ctx.uv[0], ctx.uv[1], 0];
          case 'color':
            return ctx.color.slice();
          case 'index':
            return ctx.index;
          case 'count':
            return ctx.count;
          case 'faceIndex':
            return ctx.faceIndex;
          default:
            return ctx.instance;
        }
      }
      case 'vec3':
        return [
          scalar(input(n, 'x', ctx, memo), 'x'),
          scalar(input(n, 'y', ctx, memo), 'y'),
          scalar(input(n, 'z', ctx, memo), 'z'),
        ];
      case 'swizzle': {
        const v = vec3(input(n, 'value', ctx, memo), 'swizzle');
        return v[{ x: 0, y: 1, z: 2 }[p('component') as 'x' | 'y' | 'z']];
      }
      case 'random': {
        const lo = scalar(input(n, 'min', ctx, memo), 'min'),
          hi = scalar(input(n, 'max', ctx, memo), 'max'),
          s = scalar(input(n, 'seed', ctx, memo), 'seed');
        const at = n.inputs?.index === undefined ? ctx.index : scalar(input(n, 'index', ctx, memo), 'index');
        return lo + (hi - lo) * unit(hash(hash(Math.floor(s) + seed, Math.floor(at)), 0x1234567));
      }
      case 'noise': {
        const pos = vec3(input(n, 'position', ctx, memo), 'noise position'),
          scale = scalar(input(n, 'scale', ctx, memo), 'noise scale');
        const key = pn('seed') + seed;
        let perlin = perlins.get(key);
        if (!perlin) perlins.set(key, (perlin = new Perlin(key)));
        const octaves = pn('octaves'),
          lac = pn('lacunarity'),
          gain = pn('gain');
        const sample = (ox: number, oy: number, oz: number): number => {
          let sum = 0,
            amp = 1,
            norm = 0,
            freq = scale;
          for (let o = 0; o < octaves; o++) {
            sum += amp * perlin!.at(pos[0] * freq + ox, pos[1] * freq + oy, pos[2] * freq + oz);
            norm += amp;
            amp *= gain;
            freq *= lac;
          }
          return sum / norm;
        };
        return p('output') === 'vector'
          ? [sample(0, 0, 0), sample(31.416, 47.853, 12.793), sample(-19.337, 5.271, 83.619)]
          : sample(0, 0, 0);
      }
      case 'mix': {
        const a = input(n, 'a', ctx, memo),
          b = input(n, 'b', ctx, memo),
          t = scalar(input(n, 't', ctx, memo), 't');
        return lift(a, b, (x, y) => x + (y - x) * t, 'mix');
      }
      case 'clamp': {
        const v = input(n, 'value', ctx, memo),
          lo = scalar(input(n, 'min', ctx, memo), 'min'),
          hi = scalar(input(n, 'max', ctx, memo), 'max');
        return map1(v, (x) => Math.min(hi, Math.max(lo, x)), 'clamp');
      }
      case 'compare': {
        const a = scalar(input(n, 'a', ctx, memo), 'a'),
          b = scalar(input(n, 'b', ctx, memo), 'b');
        switch (p('op')) {
          case '<':
            return a < b;
          case '<=':
            return a <= b;
          case '>':
            return a > b;
          case '>=':
            return a >= b;
          case '==':
            return a === b;
          default:
            return a !== b;
        }
      }
      case 'logic': {
        const a = input(n, 'a', ctx, memo) as boolean;
        if (p('op') === 'not') return !a;
        if (p('op') === 'and') return a ? (input(n, 'b', ctx, memo) as boolean) : false;
        return a ? true : (input(n, 'b', ctx, memo) as boolean);
      }
      case 'conditional': {
        const c = input(n, 'condition', ctx, memo);
        return input(n, c ? 'then' : 'otherwise', ctx, memo);
      }
      case 'negate':
        return map1(input(n, 'value', ctx, memo), (x) => -x, n.type);
      case 'abs':
        return map1(input(n, 'value', ctx, memo), Math.abs, n.type);
      case 'floor':
        return map1(input(n, 'value', ctx, memo), Math.floor, n.type);
      case 'ceil':
        return map1(input(n, 'value', ctx, memo), Math.ceil, n.type);
      case 'fract':
        return map1(input(n, 'value', ctx, memo), (x) => x - Math.floor(x), n.type);
      case 'sin':
        return map1(input(n, 'value', ctx, memo), Math.sin, n.type);
      case 'cos':
        return map1(input(n, 'value', ctx, memo), Math.cos, n.type);
      case 'sqrt':
        return map1(input(n, 'value', ctx, memo), (x) => Math.sqrt(Math.max(0, x)), n.type);
      case 'length':
        return Math.hypot(...vec3(input(n, 'value', ctx, memo), 'length'));
      case 'normalize': {
        const v = vec3(input(n, 'value', ctx, memo), 'normalize'),
          l = Math.hypot(v[0], v[1], v[2]) || 1;
        return [v[0] / l, v[1] / l, v[2] / l];
      }
      case 'add':
        return lift(input(n, 'a', ctx, memo), input(n, 'b', ctx, memo), (x, y) => x + y, n.type);
      case 'subtract':
        return lift(input(n, 'a', ctx, memo), input(n, 'b', ctx, memo), (x, y) => x - y, n.type);
      case 'multiply':
        return lift(input(n, 'a', ctx, memo), input(n, 'b', ctx, memo), (x, y) => x * y, n.type);
      case 'divide':
        return lift(input(n, 'a', ctx, memo), input(n, 'b', ctx, memo), (x, y) => (y === 0 ? 0 : x / y), n.type);
      case 'min':
        return lift(input(n, 'a', ctx, memo), input(n, 'b', ctx, memo), Math.min, n.type);
      case 'max':
        return lift(input(n, 'a', ctx, memo), input(n, 'b', ctx, memo), Math.max, n.type);
      case 'pow':
        return lift(
          input(n, 'a', ctx, memo),
          input(n, 'b', ctx, memo),
          (x, y) => {
            const r = x ** y;
            return Number.isFinite(r) ? r : 0;
          },
          n.type,
        );
      case 'dot': {
        const a = vec3(input(n, 'a', ctx, memo), 'dot'),
          b = vec3(input(n, 'b', ctx, memo), 'dot');
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      }
      case 'cross': {
        const a = vec3(input(n, 'a', ctx, memo), 'cross'),
          b = vec3(input(n, 'b', ctx, memo), 'cross');
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      }
      case 'distance': {
        const a = vec3(input(n, 'a', ctx, memo), 'distance'),
          b = vec3(input(n, 'b', ctx, memo), 'distance');
        return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      }
      case 'setPositions': {
        const g = clone(geometryInput(n, 'geometry'));
        const count = g.positions.length / 3;
        for (let i = 0; i < count; i++) {
          const v = vec3(fieldAt(n, 'positions', vertexCtx(g, i, count)), 'positions');
          g.positions.set(v, i * 3);
        }
        if (p('recomputeNormals')) recomputeNormals(g);
        return g;
      }
      case 'setNormals': {
        const g = clone(geometryInput(n, 'geometry'));
        const count = g.positions.length / 3;
        for (let i = 0; i < count; i++) {
          const v = vec3(fieldAt(n, 'normals', vertexCtx(g, i, count)), 'normals');
          const l = Math.hypot(v[0], v[1], v[2]) || 1;
          g.normals.set([v[0] / l, v[1] / l, v[2] / l], i * 3);
        }
        return g;
      }
      case 'setUVs': {
        const g = clone(geometryInput(n, 'geometry'));
        const count = g.positions.length / 3;
        for (let i = 0; i < count; i++) {
          const v = vec3(fieldAt(n, 'uvs', vertexCtx(g, i, count)), 'uvs');
          g.uvs[i * 2] = v[0];
          g.uvs[i * 2 + 1] = v[1];
        }
        return g;
      }
      case 'setColors': {
        const g = clone(geometryInput(n, 'geometry'));
        const count = g.positions.length / 3;
        g.colors = g.colors ? g.colors.slice() : new Float32Array(count * 4).fill(1);
        for (let i = 0; i < count; i++) {
          const v = fieldAt(n, 'colors', vertexCtx(g, i, count));
          const c =
            typeof v === 'number'
              ? [v, v, v, 1]
              : isVec(v) && v.length >= 3
                ? [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]
                : bad('Graph colors needs a number or a vector of 3 or 4');
          g.colors.set(c, i * 4);
        }
        return g;
      }
      case 'setMaterialId': {
        const g = clone(geometryInput(n, 'geometry'));
        const id = scalar(constant(n, 'id'), 'id');
        if (!Number.isInteger(id) || id < 0 || id > 65535)
          throw new RangeError('Graph material id must be an integer 0 to 65535');
        g.material.fill(id);
        return g;
      }
      case 'transform': {
        const g = clone(geometryInput(n, 'geometry'));
        const t = vec3(constant(n, 'translation'), 'translation'),
          r = vec3(constant(n, 'rotation'), 'rotation'),
          s = vec3(constant(n, 'scale'), 'scale');
        place(g, rotationMatrix(r[0], r[1], r[2]), s, t);
        return g;
      }
      case 'merge': {
        const list = (n.inputs?.geometries ?? []) as { node: string }[];
        const parts = list.map((ref) => {
          if (isDynamic(ref.node))
            throw new RangeError(
              `Graph node "${n.id}" cannot merge a per-element value; wire geometry that has no context node behind it`,
            );
          const g = ev(ref.node, ROOT, staticMemo);
          return isWork(g) ? g : bad(`Graph node "${n.id}" can merge only geometry`);
        });
        return mergeWork(parts, checkSize);
      }
      case 'instantiateOnVertices':
      case 'instantiateOnFaces': {
        const target = geometryInput(n, 'target'),
          instance = geometryInput(n, 'instance');
        const faces = n.type === 'instantiateOnFaces';
        const every = pn('every'),
          align = p('alignToNormal') as boolean;
        const targetVertices = target.positions.length / 3,
          targetTriangles = target.indices.length / 3;
        // Pick the places first, so the output is sized before anything is copied.
        const places: { position: Vec; normal: Vec; uv: Vec; color: Vec; face: number; index: number }[] = [];
        if (!faces) {
          const seen = new Set<string>();
          for (let i = 0; i < targetVertices; i += every) {
            tick();
            const q = [target.positions[i * 3], target.positions[i * 3 + 1], target.positions[i * 3 + 2]];
            if (p('uniqueVertices')) {
              const key = `${Math.round(q[0] * 1e5)},${Math.round(q[1] * 1e5)},${Math.round(q[2] * 1e5)}`;
              if (seen.has(key)) continue;
              seen.add(key);
            }
            places.push({
              position: q,
              normal: [target.normals[i * 3], target.normals[i * 3 + 1], target.normals[i * 3 + 2]],
              uv: [target.uvs[i * 2], target.uvs[i * 2 + 1]],
              color: target.colors ? Array.from(target.colors.subarray(i * 4, i * 4 + 4)) : [1, 1, 1, 1],
              face: 0,
              index: i,
            });
            if (places.length * Math.max(1, instance.positions.length / 3) > maxVertices)
              checkSize(places.length * (instance.positions.length / 3), 0);
          }
        } else {
          const perFace = pn('perFace');
          const rand = mulberry((pn('seed') + seed) >>> 0);
          for (let f = 0; f < targetTriangles; f += every) {
            const [a, b, c] = [target.indices[f * 3], target.indices[f * 3 + 1], target.indices[f * 3 + 2]];
            const P = (i: number) => [
              target.positions[i * 3],
              target.positions[i * 3 + 1],
              target.positions[i * 3 + 2],
            ];
            const pa = P(a),
              pb = P(b),
              pc = P(c);
            const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]],
              e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
            const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            const len = Math.hypot(cr[0], cr[1], cr[2]) || 1;
            const normal = [cr[0] / len, cr[1] / len, cr[2] / len];
            for (let k = 0; k < perFace; k++) {
              tick();
              let u = 1 / 3,
                v = 1 / 3;
              if (perFace > 1) {
                // uniform point on the triangle (Osada et al. 2002: sqrt-warped barycentrics)
                const r1 = Math.sqrt(rand()),
                  r2 = rand();
                u = 1 - r1;
                v = r1 * (1 - r2);
              }
              const w = 1 - u - v;
              const mixv = (arr: Float32Array, size: number, i0: number, i1: number, i2: number): number[] =>
                Array.from(
                  { length: size },
                  (_, d) => arr[i0 * size + d] * w + arr[i1 * size + d] * u + arr[i2 * size + d] * v,
                );
              places.push({
                position: [
                  pa[0] * w + pb[0] * u + pc[0] * v,
                  pa[1] * w + pb[1] * u + pc[1] * v,
                  pa[2] * w + pb[2] * u + pc[2] * v,
                ],
                normal,
                uv: mixv(target.uvs, 2, a, b, c),
                color: target.colors ? mixv(target.colors, 4, a, b, c) : [1, 1, 1, 1],
                face: f,
                index: places.length,
              });
              checkSize(places.length * (instance.positions.length / 3), places.length * (instance.indices.length / 3));
            }
          }
        }
        const iv = instance.positions.length / 3,
          it = instance.indices.length / 3;
        checkSize(
          places.length * iv + (p('keepTarget') ? targetVertices : 0),
          places.length * it + (p('keepTarget') ? targetTriangles : 0),
        );
        const copies: Work[] = places.map((q, k) => {
          const ctx: Ctx = {
            index: q.index,
            count: places.length,
            position: q.position,
            normal: q.normal,
            uv: q.uv,
            color: q.color,
            faceIndex: q.face,
            instance: k,
          };
          const s = vec3(fieldAt(n, 'scale', ctx), 'scale'),
            r = vec3(fieldAt(n, 'rotation', ctx), 'rotation');
          let m = rotationMatrix(r[0], r[1], r[2]);
          if (align) m = mul3(alignY(q.normal), m);
          const g = clone(instance);
          place(g, m, s, q.position as [number, number, number]);
          return g;
        });
        return mergeWork(p('keepTarget') ? [target, ...copies] : copies, checkSize);
      }
      default:
        return bad(`Graph node type "${n.type}" has no evaluator`);
    }
  };

  const out = ev(graph.output, ROOT, staticMemo);
  if (!isWork(out)) throw new TypeError('Graph output is not a geometry; set the output to the id of a geometry node');
  checkSize(out.positions.length / 3, out.indices.length / 3);
  return finish(out);
}

function fromData(data: GeometryData & { colors?: ArrayLike<number> }): Work {
  const nv = data.positions.length / 3,
    nt = data.indices.length / 3;
  const material = new Uint32Array(nt);
  for (const g of data.groups ?? []) {
    const first = Math.floor(g.start / 3),
      last = Math.min(nt, Math.floor((g.start + g.count) / 3));
    for (let t = first; t < last; t++) material[t] = g.materialIndex;
  }
  const w: Work = {
    positions: Float32Array.from(data.positions),
    normals: data.normals.length === data.positions.length ? Float32Array.from(data.normals) : new Float32Array(nv * 3),
    uvs: data.uvs.length === nv * 2 ? Float32Array.from(data.uvs) : new Float32Array(nv * 2),
    indices: Uint32Array.from(data.indices),
    material,
  };
  if (data.colors && data.colors.length === nv * 4) w.colors = Float32Array.from(data.colors);
  for (const i of w.indices)
    if (i >= nv)
      throw new RangeError(
        'Graph geometry has an index past its vertices; pass indices below the vertex count in options.inputs',
      );
  if (w.indices.length % 3) throw new RangeError('Graph geometry indices must be a multiple of 3');
  return w;
}
const clone = (g: Work): Work => ({
  positions: g.positions.slice(),
  normals: g.normals.slice(),
  uvs: g.uvs.slice(),
  colors: g.colors?.slice(),
  indices: g.indices.slice(),
  material: g.material.slice(),
});
function vertexCtx(g: Work, i: number, count: number): Ctx {
  return {
    index: i,
    count,
    position: [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]],
    normal: [g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]],
    uv: [g.uvs[i * 2], g.uvs[i * 2 + 1]],
    color: g.colors ? [g.colors[i * 4], g.colors[i * 4 + 1], g.colors[i * 4 + 2], g.colors[i * 4 + 3]] : [1, 1, 1, 1],
    faceIndex: 0,
    instance: 0,
  };
}
/** In place: scale, then rotate (3x3, row-major), then translate. Normals take the inverse transpose; a mirror flips winding. */
function place(g: Work, m: number[], s: [number, number, number], t: ArrayLike<number>): void {
  const n = g.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const x = g.positions[i * 3] * s[0],
      y = g.positions[i * 3 + 1] * s[1],
      z = g.positions[i * 3 + 2] * s[2];
    g.positions[i * 3] = m[0] * x + m[1] * y + m[2] * z + t[0];
    g.positions[i * 3 + 1] = m[3] * x + m[4] * y + m[5] * z + t[1];
    g.positions[i * 3 + 2] = m[6] * x + m[7] * y + m[8] * z + t[2];
    const nx = s[0] ? g.normals[i * 3] / s[0] : 0,
      ny = s[1] ? g.normals[i * 3 + 1] / s[1] : 0,
      nz = s[2] ? g.normals[i * 3 + 2] / s[2] : 0;
    const a = m[0] * nx + m[1] * ny + m[2] * nz,
      b = m[3] * nx + m[4] * ny + m[5] * nz,
      c = m[6] * nx + m[7] * ny + m[8] * nz,
      l = Math.hypot(a, b, c) || 1;
    g.normals[i * 3] = a / l;
    g.normals[i * 3 + 1] = b / l;
    g.normals[i * 3 + 2] = c / l;
  }
  if (s[0] * s[1] * s[2] < 0)
    for (let i = 0; i < g.indices.length; i += 3) {
      const tmp = g.indices[i + 1];
      g.indices[i + 1] = g.indices[i + 2];
      g.indices[i + 2] = tmp;
    }
}
function recomputeNormals(g: Work): void {
  g.normals.fill(0);
  for (let i = 0; i < g.indices.length; i += 3) {
    const [a, b, c] = [g.indices[i] * 3, g.indices[i + 1] * 3, g.indices[i + 2] * 3];
    const e1 = [
        g.positions[b] - g.positions[a],
        g.positions[b + 1] - g.positions[a + 1],
        g.positions[b + 2] - g.positions[a + 2],
      ],
      e2 = [
        g.positions[c] - g.positions[a],
        g.positions[c + 1] - g.positions[a + 1],
        g.positions[c + 2] - g.positions[a + 2],
      ];
    const nx = e1[1] * e2[2] - e1[2] * e2[1],
      ny = e1[2] * e2[0] - e1[0] * e2[2],
      nz = e1[0] * e2[1] - e1[1] * e2[0];
    for (const v of [a, b, c]) {
      g.normals[v] += nx;
      g.normals[v + 1] += ny;
      g.normals[v + 2] += nz;
    }
  }
  for (let i = 0; i < g.normals.length; i += 3) {
    const l = Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]);
    if (l > 0) {
      g.normals[i] /= l;
      g.normals[i + 1] /= l;
      g.normals[i + 2] /= l;
    } else g.normals[i + 1] = 1;
  }
}
function mergeWork(parts: Work[], checkSize: (v: number, t: number) => void): Work {
  let nv = 0,
    nt = 0,
    colors = false;
  for (const g of parts) {
    nv += g.positions.length / 3;
    nt += g.indices.length / 3;
    if (g.colors) colors = true;
  }
  checkSize(nv, nt);
  const out: Work = {
    positions: new Float32Array(nv * 3),
    normals: new Float32Array(nv * 3),
    uvs: new Float32Array(nv * 2),
    indices: new Uint32Array(nt * 3),
    material: new Uint32Array(nt),
  };
  if (colors) out.colors = new Float32Array(nv * 4).fill(1);
  let v = 0,
    t = 0;
  for (const g of parts) {
    const gv = g.positions.length / 3,
      gt = g.indices.length / 3;
    out.positions.set(g.positions, v * 3);
    out.normals.set(g.normals, v * 3);
    out.uvs.set(g.uvs, v * 2);
    if (g.colors) out.colors!.set(g.colors, v * 4);
    for (let i = 0; i < gt * 3; i++) out.indices[t * 3 + i] = g.indices[i] + v;
    out.material.set(g.material, t);
    v += gv;
    t += gt;
  }
  return out;
}
/** Sorts triangles by material id (stable) and emits one group per id; no groups when every triangle is material 0. */
function finish(g: Work): GraphGeometry {
  const nt = g.indices.length / 3;
  const out: GraphGeometry = { positions: g.positions, normals: g.normals, uvs: g.uvs, indices: g.indices };
  if (g.colors) out.colors = g.colors;
  let sorted = true,
    any = false;
  for (let t = 0; t < nt; t++) {
    if (g.material[t]) any = true;
    if (t && g.material[t] < g.material[t - 1]) sorted = false;
  }
  if (!any) return out;
  let order = Array.from({ length: nt }, (_, i) => i);
  if (!sorted) {
    order = order.sort((a, b) => g.material[a] - g.material[b] || a - b);
    const indices = new Uint32Array(nt * 3);
    order.forEach((src, dst) => indices.set(g.indices.subarray(src * 3, src * 3 + 3), dst * 3));
    out.indices = indices;
  }
  const groups: GeometryGroup[] = [];
  for (let k = 0; k < nt; k++) {
    const m = g.material[order[k]];
    const last = groups[groups.length - 1];
    if (last && last.materialIndex === m) last.count += 3;
    else groups.push({ start: k * 3, count: 3, materialIndex: m });
  }
  out.groups = groups;
  return out;
}
