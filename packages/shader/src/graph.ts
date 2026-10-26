import * as s from './node.js';
import { NodeMaterial, type NodeMaterialOptions } from './material.js';

/** Portable, bounded surface expression operations. Inputs are ordered node ids. */
export type SurfaceOperation =
  | 'float'
  | 'vec3'
  | 'position'
  | 'worldPosition'
  | 'normal'
  | 'worldNormal'
  | 'color'
  | 'uv'
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'min'
  | 'max'
  | 'pow'
  | 'mix'
  | 'clamp'
  | 'sin'
  | 'cos'
  | 'abs'
  | 'floor'
  | 'fract'
  | 'saturate'
  | 'length'
  | 'dot'
  | 'normalize'
  | 'component'
  | 'combine';
/** One expression; numeric values are immutable constants exposed as authoring parameters. */
export interface SurfaceGraphNode {
  id: string;
  op: SurfaceOperation;
  inputs: string[];
  value?: number | [number, number, number];
}
/** Constant physical values used by hosts that cannot execute surface graphs. RGB is linear. */
export interface SurfaceFallback {
  color: [number, number, number];
  emissive: [number, number, number];
  roughness: number;
  metalness: number;
  opacity: number;
}
/** Material output slots. An absent slot keeps the host material's existing value. */
export interface SurfaceOutputs {
  color?: string;
  roughness?: string;
  metalness?: string;
  emissive?: string;
  opacity?: string;
  normal?: string;
}
/** Versioned JSON surface graph; arbitrary source code and resource access are intentionally absent. */
export interface SurfaceGraph {
  version: 1;
  nodes: SurfaceGraphNode[];
  outputs: SurfaceOutputs;
  fallback: SurfaceFallback;
}
/** Hard work limits applied before native node construction. */
export const SURFACE_GRAPH_LIMITS = Object.freeze({ nodes: 128, depth: 32, work: 2048, jsonBytes: 65536 });
/** The operation catalog shared by graph editors and validators. */
export const SURFACE_OPERATIONS: Readonly<Record<SurfaceOperation, number>> = Object.freeze({
  float: 0,
  vec3: 0,
  position: 0,
  worldPosition: 0,
  normal: 0,
  worldNormal: 0,
  color: 0,
  uv: 0,
  add: 2,
  sub: 2,
  mul: 2,
  div: 2,
  min: 2,
  max: 2,
  pow: 2,
  mix: 3,
  clamp: 3,
  sin: 1,
  cos: 1,
  abs: 1,
  floor: 1,
  fract: 1,
  saturate: 1,
  length: 1,
  dot: 2,
  normalize: 1,
  component: 1,
  combine: 3,
});
type Value = number | [number, number, number];
const slots = ['color', 'roughness', 'metalness', 'emissive', 'opacity', 'normal'] as const;
const vectorSlots = new Set<string>(['color', 'emissive', 'normal']);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(Math.fround(v)) && Math.abs(v) <= 1e6;
const vec = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && finite(v[0]) && finite(v[1]) && finite(v[2]);
const fail = (message: string): never => {
  throw new TypeError(`Surface graph is invalid; ${message}`);
};
const idValid = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id);

function structure(value: unknown): { graph: SurfaceGraph; order: SurfaceGraphNode[] } {
  if (!object(value) || value.version !== 1) return fail('set version to 1');
  if (!Array.isArray(value.nodes) || value.nodes.length > SURFACE_GRAPH_LIMITS.nodes)
    fail('nodes must be an array with at most 128 entries');
  if (
    !object(value.outputs) ||
    Object.keys(value.outputs).some((key) => !slots.includes(key as (typeof slots)[number]))
  )
    fail('outputs must contain supported surface slots');
  const f = value.fallback;
  if (
    !object(f) ||
    !vec(f.color) ||
    !vec(f.emissive) ||
    !finite(f.roughness) ||
    !finite(f.metalness) ||
    !finite(f.opacity) ||
    [...f.color, ...f.emissive].some((n) => n < 0) ||
    [f.roughness, f.metalness, f.opacity].some((n) => n < 0 || n > 1)
  )
    fail('fallback requires finite nonnegative RGB and physical scalar values in 0..1');
  const graph = value as unknown as SurfaceGraph,
    byId = new Map<string, SurfaceGraphNode>();
  let work = 0;
  for (const node of graph.nodes) {
    if (!object(node) || !idValid(node.id) || byId.has(node.id)) fail('use unique node ids beginning with a letter');
    if (typeof node.op !== 'string' || !Object.hasOwn(SURFACE_OPERATIONS, node.op))
      fail(`use a supported operation on ${node.id}`);
    if (
      !Array.isArray(node.inputs) ||
      node.inputs.length !== SURFACE_OPERATIONS[node.op] ||
      !node.inputs.every(idValid)
    )
      fail(`${node.id} needs the right number of inputs and valid node ids`);
    if (node.op === 'float' && !finite(node.value)) fail(`${node.id} needs a finite float value within ±1000000`);
    if (node.op === 'vec3' && !vec(node.value)) fail(`${node.id} needs three finite values within ±1000000`);
    if (node.op === 'component' && (!Number.isInteger(node.value) || Number(node.value) < 0 || Number(node.value) > 2))
      fail(`${node.id} component must be 0, 1 or 2`);
    if (!['float', 'vec3', 'component'].includes(node.op) && node.value !== undefined)
      fail(`remove the parameter value from ${node.id}`);
    work += ['sin', 'cos', 'pow', 'normalize'].includes(node.op) ? 16 : 1;
    byId.set(node.id, node);
  }
  if (work > SURFACE_GRAPH_LIMITS.work)
    throw new RangeError('Surface graph exceeds 2048 work units; remove expensive nodes');
  const state = new Map<string, number>(),
    depth = new Map<string, number>(),
    order: SurfaceGraphNode[] = [];
  const visit = (id: string): number => {
    const node = byId.get(id);
    if (!node) return fail(`add the missing input node ${id}`);
    if (state.get(id) === 1) return fail(`cycle at ${id}; remove the connection`);
    if (state.get(id) === 2) return depth.get(id)!;
    state.set(id, 1);
    const d = 1 + Math.max(0, ...node.inputs.map(visit));
    if (d > SURFACE_GRAPH_LIMITS.depth)
      throw new RangeError('Surface graph depth exceeds 32; shorten the expression chain');
    state.set(id, 2);
    depth.set(id, d);
    order.push(node);
    return d;
  };
  graph.nodes.forEach((node) => visit(node.id));
  for (const slot of slots)
    if (graph.outputs[slot] !== undefined && (!idValid(graph.outputs[slot]) || !byId.has(graph.outputs[slot]!)))
      fail(`add the missing ${slot} output node`);
  return { graph, order };
}

function build(value: unknown): { graph: SurfaceGraph; order: SurfaceGraphNode[]; nodes: Map<string, s.Node> } {
  const { graph, order } = structure(value),
    nodes = new Map<string, s.Node>();
  for (const node of order) {
    const a = node.inputs.map((id) => nodes.get(id)!);
    let result: s.Node;
    switch (node.op) {
      case 'float':
        result = s.float(node.value as number);
        break;
      case 'vec3':
        result = s.vec3(...(node.value as [number, number, number]));
        break;
      case 'position':
        result = s.positionLocal;
        break;
      case 'worldPosition':
        result = s.positionWorld;
        break;
      case 'normal':
        result = s.normalLocal;
        break;
      case 'worldNormal':
        result = s.normalWorld;
        break;
      case 'color':
        result = s.vertexColor().rgb;
        break;
      case 'uv':
        result = s.vec3(s.uv(), 0);
        break;
      case 'component':
        if (a[0].type !== 'vec3f') fail(`${node.id} component input must be vec3f`);
        result = a[0][(['x', 'y', 'z'] as const)[node.value as number]];
        break;
      case 'combine':
        if (a.some((n) => n.type !== 'f32')) fail(`${node.id} combine inputs must be f32`);
        result = s.vec3(a[0], a[1], a[2]);
        break;
      case 'mix':
        result = s.mix(a[0], a[1], a[2]);
        break;
      case 'clamp':
        result = s.clamp(a[0], a[1], a[2]);
        break;
      case 'length':
        result = s.length(a[0]);
        break;
      case 'dot':
        if (a.some((n) => n.type !== 'vec3f')) fail(`${node.id} dot inputs must be vec3f`);
        result = s.dot(a[0], a[1]);
        break;
      case 'normalize':
        if (a[0].type !== 'vec3f') fail(`${node.id} normalize input must be vec3f`);
        result = s.normalize(a[0]);
        break;
      case 'add':
        result = s.add(a[0], a[1]);
        break;
      case 'sub':
        result = s.sub(a[0], a[1]);
        break;
      case 'mul':
        result = s.mul(a[0], a[1]);
        break;
      case 'div':
        result = s.div(a[0], a[1]);
        break;
      case 'min':
        result = s.min(a[0], a[1]);
        break;
      case 'max':
        result = s.max(a[0], a[1]);
        break;
      case 'pow':
        result = s.pow(a[0], a[1]);
        break;
      default:
        result = s[node.op](a[0]);
    }
    if (result.type !== 'f32' && result.type !== 'vec3f') fail(`${node.id} must produce f32 or vec3f`);
    nodes.set(node.id, result);
  }
  for (const slot of slots) {
    const id = graph.outputs[slot],
      expected = vectorSlots.has(slot) ? 'vec3f' : 'f32';
    if (id && nodes.get(id)!.type !== expected) fail(`${slot} output must be ${expected}`);
  }
  return { graph, order, nodes };
}
/** Validate structure, cycles, all node types and bounded work using Margo's native typed nodes. */
export function validateSurfaceGraph(value: unknown): asserts value is SurfaceGraph {
  build(value);
}
/** Validated output type of every editable node, including disconnected nodes. */
export function inspectSurfaceGraph(value: SurfaceGraph): { types: Record<string, 'f32' | 'vec3f'> } {
  const { nodes } = build(value);
  return {
    types: Object.fromEntries([...nodes].map(([id, node]) => [id, node.type])) as Record<string, 'f32' | 'vec3f'>,
  };
}
/** Stable canonical JSON. Node array order is preserved for authoring; object key order is normalized. */
export function serializeSurfaceGraph(value: SurfaceGraph): string {
  validateSurfaceGraph(value);
  const outputs: SurfaceOutputs = {};
  for (const slot of slots) if (value.outputs[slot]) outputs[slot] = value.outputs[slot];
  const f = value.fallback,
    json = JSON.stringify({
      version: 1,
      nodes: value.nodes.map((n) => ({
        id: n.id,
        op: n.op,
        inputs: [...n.inputs],
        ...(n.value === undefined ? {} : { value: n.value }),
      })),
      outputs,
      fallback: {
        color: f.color,
        emissive: f.emissive,
        roughness: f.roughness,
        metalness: f.metalness,
        opacity: f.opacity,
      },
    });
  if (new TextEncoder().encode(json).length > SURFACE_GRAPH_LIMITS.jsonBytes)
    throw new RangeError('Surface graph JSON exceeds 65536 bytes; reduce node metadata');
  return json;
}
/** Parse a portable graph with a bounded input size, returning an independent canonical snapshot. */
export function parseSurfaceGraph(json: string): SurfaceGraph {
  if (typeof json !== 'string' || new TextEncoder().encode(json).length > SURFACE_GRAPH_LIMITS.jsonBytes)
    throw new RangeError('Surface graph JSON must be at most 65536 bytes');
  const value: unknown = JSON.parse(json);
  validateSurfaceGraph(value);
  return JSON.parse(serializeSurfaceGraph(value)) as SurfaceGraph;
}
/** Compile graph outputs to native NodeMaterial options; omitted outputs retain material values. */
export function compileSurfaceGraph(
  value: SurfaceGraph,
): Pick<
  NodeMaterialOptions,
  'colorNode' | 'roughnessNode' | 'metalnessNode' | 'emissiveNode' | 'opacityNode' | 'normalNode'
> {
  const { graph, nodes } = build(value),
    result: Record<string, s.Node> = {};
  for (const slot of slots) if (graph.outputs[slot]) result[`${slot}Node`] = nodes.get(graph.outputs[slot]!)!;
  return result;
}
/** Construct a native Margo surface material. Only the standard PBR raster host executes the graph. */
export function createGraphMaterial(graph: SurfaceGraph, options: NodeMaterialOptions = {}): NodeMaterial {
  const snapshot = parseSurfaceGraph(serializeSurfaceGraph(graph));
  const material = new NodeMaterial({ ...options, ...compileSurfaceGraph(snapshot) });
  material.surfaceGraph = snapshot;
  return material;
}
/** Coordinates and original material values supplied by a texture/voxel baking host. RGB is linear. */
export interface SurfaceSample {
  position: readonly number[];
  normal: readonly number[];
  worldPosition?: readonly number[];
  worldNormal?: readonly number[];
  color?: readonly number[];
  uv?: readonly number[];
}
/** Evaluated surface values in linear space. Normal is in world coordinates when supplied by the graph. */
export interface SurfaceEvaluation {
  color?: [number, number, number];
  emissive?: [number, number, number];
  roughness?: number;
  metalness?: number;
  opacity?: number;
  normal?: [number, number, number];
}
const component = (v: Value, i: number): number => (typeof v === 'number' ? v : v[i]);
const map = (values: Value[], fn: (...v: number[]) => number): Value =>
  values.every((v) => typeof v === 'number')
    ? fn(...(values as number[]))
    : ([0, 1, 2].map((i) => fn(...values.map((v) => component(v, i)))) as [number, number, number]);
/** Compile a deterministic CPU sampler once for many bake texels. Native node validation and semantics are shared. Nonfinite results reject the bake. */
export function surfaceGraphSampler(value: SurfaceGraph): (sample: SurfaceSample) => SurfaceEvaluation {
  const snapshot = parseSurfaceGraph(serializeSurfaceGraph(value)),
    { order } = build(snapshot);
  const byId = new Map(order.map((node) => [node.id, node])),
    reachable = new Set<string>();
  const include = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    byId.get(id)!.inputs.forEach(include);
  };
  Object.values(snapshot.outputs).forEach(include);
  const live = order.filter((node) => reachable.has(node.id));
  return (sample) => {
    const values = new Map<string, Value>();
    for (const n of live) {
      const a = n.inputs.map((id) => values.get(id)!);
      let v: Value;
      switch (n.op) {
        case 'float':
        case 'vec3':
          v = n.value as Value;
          break;
        case 'position':
          v = [...sample.position] as Value;
          break;
        case 'worldPosition':
          v = [...(sample.worldPosition ?? sample.position)] as Value;
          break;
        case 'normal':
          v = [...sample.normal] as Value;
          break;
        case 'worldNormal':
          v = [...(sample.worldNormal ?? sample.normal)] as Value;
          break;
        case 'color':
          v = [...(sample.color ?? [1, 1, 1])] as Value;
          break;
        case 'uv':
          v = [sample.uv?.[0] ?? 0, sample.uv?.[1] ?? 0, 0];
          break;
        case 'component':
          v = component(a[0], n.value as number);
          break;
        case 'combine':
          v = a as [number, number, number];
          break;
        case 'add':
          v = map(a, (x, y) => x + y);
          break;
        case 'sub':
          v = map(a, (x, y) => x - y);
          break;
        case 'mul':
          v = map(a, (x, y) => x * y);
          break;
        case 'div':
          v = map(a, (x, y) => x / y);
          break;
        case 'min':
          v = map(a, Math.min);
          break;
        case 'max':
          v = map(a, Math.max);
          break;
        case 'pow':
          v = map(a, Math.pow);
          break;
        case 'mix':
          v = map(a, (x, y, t) => x * (1 - t) + y * t);
          break;
        case 'clamp':
          v = map(a, (x, lo, hi) => Math.max(lo, Math.min(hi, x)));
          break;
        case 'sin':
          v = map(a, Math.sin);
          break;
        case 'cos':
          v = map(a, Math.cos);
          break;
        case 'abs':
          v = map(a, Math.abs);
          break;
        case 'floor':
          v = map(a, Math.floor);
          break;
        case 'fract':
          v = map(a, (x) => x - Math.floor(x));
          break;
        case 'saturate':
          v = map(a, (x) => Math.min(1, Math.max(0, x)));
          break;
        case 'length':
          v = typeof a[0] === 'number' ? Math.abs(a[0]) : Math.hypot(...a[0]);
          break;
        case 'dot':
          v = [0, 1, 2].reduce((sum, i) => sum + component(a[0], i) * component(a[1], i), 0);
          break;
        case 'normalize': {
          const length = Math.hypot(...(a[0] as number[]));
          v = map(a, (x) => x / length);
          break;
        }
      }
      if (!(typeof v === 'number' ? [v] : v).every((x) => Number.isFinite(x)))
        throw new RangeError(
          `Surface graph ${n.id} produced a nonfinite bake value; avoid zero division, zero normals and invalid powers`,
        );
      values.set(n.id, v);
    }
    const output: Record<string, Value> = {};
    for (const slot of slots)
      if (snapshot.outputs[slot]) {
        let v = values.get(snapshot.outputs[slot]!)!;
        if (slot === 'normal') {
          const length = Math.hypot(...(v as number[]));
          if (!length) throw new RangeError('Surface graph normal is zero; supply a nonzero normal');
          v = map([v], (x) => x / length);
        }
        // Roughness floor 0.045: minimum perceptual roughness, Filament design document (published engine standard).
        if (['opacity', 'metalness', 'roughness'].includes(slot))
          v = Math.max(slot === 'roughness' ? 0.045 : 0, Math.min(1, v as number));
        output[slot] = typeof v === 'number' ? v : [...v];
      }
    return output as SurfaceEvaluation;
  };
}
/** Evaluate a single sample. For bulk texture baking use surfaceGraphSampler to validate once. */
export function evaluateSurfaceGraph(graph: SurfaceGraph, sample: SurfaceSample): SurfaceEvaluation {
  return surfaceGraphSampler(graph)(sample);
}
