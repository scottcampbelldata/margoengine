/// <reference lib="esnext.disposable" preserve="true" />
import type { ComputeContext, GpuArray } from '@margoengine/compute';
import type { Graph } from './graph.js';
import { graphData, invalid } from './graph-gpu-data.js';
import { fault } from '../../shared/errors.js';

/** Holten and van Wijk's subdivision/spring/electrostatic bundling schedule. */
export interface GraphBundleOptions {
  /** Compatibility threshold in [0,1]. Default 0.6. */ readonly compatibility?: number;
  /** Spring stiffness K, default 0.1. */ readonly stiffness?: number;
  /** Initial integration step, halved per cycle. Default 0.1. */ readonly step?: number;
  /** Cycles, with 1,2,4,... interior points. Default 6, maximum 9. */ readonly cycles?: number;
  /** First-cycle iterations, multiplied by 2/3 each cycle. Default 50. */ readonly iterations?: number;
  /** Cancels between completed GPU iterations and during reads. */ readonly signal?: AbortSignal;
}
type Point = readonly [number, number, number];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Point) => Math.hypot(...a);
const midpoint = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
function visibility(a: Point, b: Point, c: Point, d: Point): number {
  const v = sub(b, a),
    len2 = dot(v, v);
  if (len2 < 1e-20) return 0;
  const project = (p: Point): Point => {
    const t = dot(sub(p, a), v) / len2;
    return [a[0] + t * v[0], a[1] + t * v[1], a[2] + t * v[2]];
  };
  const c1 = project(c),
    d1 = project(d),
    length = norm(sub(c1, d1));
  return length > 1e-10 ? Math.max(0, 1 - (2 * norm(sub(midpoint(a, b), midpoint(c1, d1)))) / length) : 0;
}
/** Angle, scale, position and symmetric visibility product, equations 2..5 of Holten and van Wijk (2009). */
export function edgeCompatibility(a: Point, b: Point, c: Point, d: Point): number {
  const u = sub(b, a),
    v = sub(d, c),
    p = norm(u),
    q = norm(v),
    average = (p + q) / 2;
  if (p < 1e-10 || q < 1e-10) return 0;
  return (
    ((((Math.abs(dot(u, v) / (p * q)) * 2) / (average / Math.min(p, q) + Math.max(p, q) / average)) * average) /
      (average + norm(sub(midpoint(a, b), midpoint(c, d))))) *
    Math.min(visibility(a, b, c, d), visibility(c, d, a, b))
  );
}
function settings(o: GraphBundleOptions) {
  o.signal?.throwIfAborted();
  const s = {
    compatibility: o.compatibility ?? 0.6,
    stiffness: o.stiffness ?? 0.1,
    step: o.step ?? 0.1,
    cycles: o.cycles ?? 6,
    iterations: o.iterations ?? 50,
  };
  if (
    !Object.values(s).every((v) => Number.isFinite(v) && v >= 0) ||
    s.step <= 0 ||
    s.cycles < 1 ||
    s.iterations < 1 ||
    s.compatibility > 1 ||
    !Number.isInteger(s.cycles) ||
    s.cycles > 9 ||
    !Number.isInteger(s.iterations) ||
    s.iterations > 10000
  )
    throw invalid('Invalid bundling threshold, spring, step, cycles or iterations');
  return s;
}
const bundleWGSL = `struct Config { edges: u32, points: u32, oldPoints: u32, unused: u32, threshold: f32, stiffness: f32, step: f32, pad: f32 }
@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var<storage, read> nodes: array<vec4f>;
@group(0) @binding(2) var<storage, read> edges: array<vec2u>;
@group(0) @binding(3) var<storage, read> src: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> dst: array<vec4f>;
fn visibility(a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> f32 {
  let v = b - a; let v2 = dot(v,v); if (v2 < 1e-20) { return 0.0; }
  let c1 = a + v * dot(c-a,v) / v2; let d1 = a + v * dot(d-a,v) / v2;
  let len = distance(c1,d1); if (len < 1e-10) { return 0.0; }
  return max(0.0, 1.0 - 2.0 * distance((a+b)*0.5, (c1+d1)*0.5) / len);
}
fn compatibility(a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> f32 {
  let u = b-a; let v = d-c; let p = length(u); let q = length(v); let avg = (p+q)*0.5;
  if (min(p,q) < 1e-10) { return 0.0; }
  return abs(dot(u,v)/(p*q)) * 2.0 / (avg/min(p,q)+max(p,q)/avg) * avg / (avg+distance((a+b)*0.5,(c+d)*0.5)) * min(visibility(a,b,c,d), visibility(c,d,a,b));
}
fn at(edge: u32, point: u32) -> vec3f { return src[edge * cfg.oldPoints + point].xyz; }
@compute @workgroup_size(64) fn resample(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + id.y * 65536u; if (i >= cfg.edges * cfg.points) { return; }
  let e = i / cfg.points; let point = i % cfg.points; let ends = edges[e];
  var p = mix(nodes[ends.x].xyz, nodes[ends.y].xyz, f32(point) / f32(cfg.points-1u));
  if (cfg.oldPoints > 0u) {
    var total = 0.0;
    for (var j = 1u; j < cfg.oldPoints; j++) { total += distance(at(e,j-1u), at(e,j)); }
    let distanceAlong = total * f32(point) / f32(cfg.points-1u); var walked = 0.0;
    for (var j = 1u; j < cfg.oldPoints; j++) {
      let a = at(e,j-1u); let b = at(e,j); let len = distance(a,b);
      if (walked + len >= distanceAlong && len > 0.0) { p = mix(a,b,(distanceAlong-walked)/len); break; }
      walked += len;
    }
  }
  if (point == 0u) { p = nodes[ends.x].xyz; }
  if (point == cfg.points-1u) { p = nodes[ends.y].xyz; }
  dst[i] = vec4f(p,1.0);
}
@compute @workgroup_size(64) fn bundle(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + id.y * 65536u; if (i >= cfg.edges * cfg.points) { return; }
  let e = i / cfg.points; let point = i % cfg.points; let p = src[i].xyz;
  if (point == 0u || point == cfg.points-1u) { dst[i] = src[i]; return; }
  let ends = edges[e]; let a = nodes[ends.x].xyz; let b = nodes[ends.y].xyz; let len = distance(a,b);
  var f = (src[i-1u].xyz + src[i+1u].xyz - 2.0*p) * cfg.stiffness / max(len * f32(cfg.points-1u),1e-10);
  for (var other = 0u; other < cfg.edges; other++) {
    if (other == e) { continue; }
    let end2 = edges[other]; let c = nodes[end2.x].xyz; let d = nodes[end2.y].xyz;
    let comp = compatibility(a,b,c,d);
    if (comp >= cfg.threshold && comp > 0.0) {
      let q = select(cfg.points-1u-point, point, dot(b-a,d-c) >= 0.0);
      let delta = src[other * cfg.points+q].xyz-p; let d2 = dot(delta,delta);
      if (d2 > 1e-12) { f += delta * comp / d2; }
    }
  }
  dst[i] = vec4f(p + cfg.step * f, 1.0);
}`;

/** Owned device-resident edge polylines; every edge has pointsPerEdge vec4 vertices. */
export class GraphBundles {
  /** Number of edges. */ readonly edges: number;
  /** Vertices per edge, endpoints included. */ readonly pointsPerEdge: number;
  /** Device positions, four floats per vertex. */ readonly points: GpuArray<'f32'>;
  /** Completed relaxation dispatches. */ readonly dispatches: number;
  /** @internal */ constructor(points: GpuArray<'f32'>, edges: number, pointsPerEdge: number, dispatches: number) {
    this.points = points;
    this.edges = edges;
    this.pointsPerEdge = pointsPerEdge;
    this.dispatches = dispatches;
  }
  /** Reads packed xyzw vertices. */ read(options: { readonly signal?: AbortSignal } = {}): Promise<Float32Array> {
    return this.points.read(options);
  }
  /** Frees the polyline buffer. Dispose layers that use it first. */ dispose(): void {
    this.points.dispose();
  }
  /** Same as dispose(). */ [Symbol.dispose](): void {
    this.dispose();
  }
}
/** GPU FDEB, with angle/scale/position/visibility compatibility and arc-length resampling between cycles. */
export async function bundleGraphEdges(
  gpu: ComputeContext,
  graph: Graph,
  positions: Float32Array | GpuArray<'f32'>,
  options: GraphBundleOptions = {},
): Promise<GraphBundles> {
  const s = settings(options),
    data = graphData(graph, positions instanceof Float32Array ? { positions, dimensions: 3 } : {});
  if (gpu.backend === 'cpu')
    throw fault(
      'unsupported',
      'GPU bundling needs WebGPU or compatibility; use bundleGraphEdgesReference on CPU',
      'sciviz',
    );
  if (
    !(positions instanceof Float32Array) &&
    (positions.context !== gpu || positions.size !== graph.nodes * 4 || positions.offset !== 0)
  )
    throw invalid('Use contiguous vec4 positions from this compute context');
  const e = data.edges.length / 2,
    maxBytes = Math.max(16, e * (2 ** (s.cycles - 1) + 2) * 16);
  if (maxBytes > gpu.device.limits.maxStorageBufferBindingSize)
    throw invalid('Bundled polylines exceed this device storage limit');
  const nodes = positions instanceof Float32Array ? gpu.array(data.positions) : positions,
    edges = gpu.array(data.edges.length ? data.edges : new Uint32Array(2), 'u32');
  const resample = gpu.kernel(bundleWGSL, { entryPoint: 'resample' }),
    relax = gpu.kernel(bundleWGSL, { entryPoint: 'bundle' });
  let current = gpu.zeros(4),
    spare: GpuArray<'f32'> | undefined,
    oldPoints = 0,
    dispatches = 0,
    points = 0;
  try {
    for (let cycle = 0; cycle < s.cycles; cycle++) {
      options.signal?.throwIfAborted();
      points = 2 ** cycle + 2;
      spare = gpu.zeros(Math.max(4, e * points * 4));
      const cfg = {
        edges: e,
        points,
        oldPoints,
        unused: 0,
        threshold: s.compatibility,
        stiffness: s.stiffness,
        step: s.step / 2 ** cycle,
        pad: 0,
      };
      const workgroups: [number, number, number] = [
        Math.min(1024, Math.ceil((e * points) / 64)),
        Math.max(1, Math.ceil((e * points) / 65536)),
        1,
      ];
      if (e) resample.run({ cfg, nodes, edges, src: current, dst: spare }, { workgroups });
      current.dispose();
      current = spare;
      spare = gpu.zeros(Math.max(4, e * points * 4));
      for (let i = 0; i < Math.ceil(s.iterations * (2 / 3) ** cycle); i++) {
        options.signal?.throwIfAborted();
        if (e) {
          relax.run({ cfg, nodes, edges, src: current, dst: spare }, { workgroups });
          dispatches++;
        }
        [current, spare] = [spare, current];
        await gpu.done({ signal: options.signal });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      spare.dispose();
      spare = undefined;
      oldPoints = points;
    }
    const result = new GraphBundles(current, e, points, dispatches);
    current = undefined!;
    return result;
  } finally {
    current?.dispose();
    spare?.dispose();
    edges.dispose();
    resample.dispose();
    relax.dispose();
    if (positions instanceof Float32Array) nodes.dispose();
  }
}

/** Exact CPU reference for the same compatible spring/electrostatic cycles; intended for small edge sets. */
export function bundleGraphEdgesReference(
  graph: Graph,
  positions: Float32Array,
  options: GraphBundleOptions = {},
): { positions: Float32Array; pointsPerEdge: number } {
  const s = settings(options),
    data = graphData(graph, { positions, dimensions: 3 }),
    e = data.edges.length / 2;
  const node = (i: number): Point => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const ends = Array.from({ length: e }, (_, i) => [node(data.edges[i * 2]), node(data.edges[i * 2 + 1])] as const);
  let current = new Float32Array(0),
    oldPoints = 0,
    points = 0;
  for (let cycle = 0; cycle < s.cycles; cycle++) {
    options.signal?.throwIfAborted();
    points = 2 ** cycle + 2;
    const next = new Float32Array(e * points * 4),
      at = (edge: number, j: number): Point => [
        current[(edge * oldPoints + j) * 4],
        current[(edge * oldPoints + j) * 4 + 1],
        current[(edge * oldPoints + j) * 4 + 2],
      ];
    for (let edge = 0; edge < e; edge++)
      for (let j = 0; j < points; j++) {
        const [a, b] = ends[edge],
          t = j / (points - 1);
        let p: Point = [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];
        if (oldPoints) {
          let length = 0;
          for (let k = 1; k < oldPoints; k++) length += norm(sub(at(edge, k), at(edge, k - 1)));
          const target = length * t;
          let walked = 0;
          for (let k = 1; k < oldPoints; k++) {
            const u = at(edge, k - 1),
              v = at(edge, k),
              len = norm(sub(v, u));
            if (walked + len >= target && len > 0) {
              const f = (target - walked) / len;
              p = [u[0] * (1 - f) + v[0] * f, u[1] * (1 - f) + v[1] * f, u[2] * (1 - f) + v[2] * f];
              break;
            }
            walked += len;
          }
        }
        if (j === 0) p = a;
        if (j === points - 1) p = b;
        next.set([...p, 1], (edge * points + j) * 4);
      }
    current = next;
    for (let iteration = 0; iteration < Math.ceil(s.iterations * (2 / 3) ** cycle); iteration++) {
      const dst = current.slice();
      for (let edge = 0; edge < e; edge++)
        for (let j = 1; j < points - 1; j++) {
          const off = (edge * points + j) * 4,
            [a, b] = ends[edge],
            spring = s.stiffness / Math.max(norm(sub(b, a)) * (points - 1), 1e-10);
          const force = [0, 1, 2].map(
            (k) => (current[off - 4 + k] + current[off + 4 + k] - 2 * current[off + k]) * spring,
          );
          for (let other = 0; other < e; other++) {
            if (other === edge) continue;
            const [c, d] = ends[other],
              comp = edgeCompatibility(a, b, c, d);
            if (comp < s.compatibility || comp === 0) continue;
            const q = dot(sub(b, a), sub(d, c)) >= 0 ? j : points - 1 - j,
              delta = [0, 1, 2].map((k) => current[(other * points + q) * 4 + k] - current[off + k]),
              d2 = delta.reduce((v, k) => v + k * k, 0);
            if (d2 > 1e-12) for (let k = 0; k < 3; k++) force[k] += (delta[k] * comp) / d2;
          }
          for (let k = 0; k < 3; k++) dst[off + k] += (s.step / 2 ** cycle) * force[k];
        }
      current = dst;
    }
    oldPoints = points;
  }
  return { positions: current, pointsPerEdge: points };
}
