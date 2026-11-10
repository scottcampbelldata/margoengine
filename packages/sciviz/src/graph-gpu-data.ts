import { rangeError } from '../../shared/errors.js';
import type { Graph } from './graph.js';
import type { GPUGraphOptions } from './graph-gpu-types.js';

export const invalid = (message: string) =>
  rangeError(`${message}; choose finite graph data and supported options`, 'sciviz');
export function graphData(graph: Graph, options: GPUGraphOptions) {
  const n = graph.nodes;
  if (!Number.isInteger(n) || n < 1 || n > 16777216 || graph.edges.length % 2)
    throw invalid('Graph needs 1..16777216 nodes and pairs of edge indices');
  const edges = Uint32Array.from(graph.edges);
  for (let i = 0; i < edges.length; i++)
    if (edges[i] !== graph.edges[i] || edges[i] >= n) throw invalid('Edge index is outside the graph');
  if (graph.weights && graph.weights.length * 2 !== edges.length) throw invalid('Provide one weight per edge');
  const weights = graph.weights ? Float32Array.from(graph.weights) : new Float32Array(edges.length / 2).fill(1);
  if (!weights.every((v) => Number.isFinite(v) && v >= 0)) throw invalid('Weights must be finite and nonnegative');
  const dimensions = options.dimensions ?? 2,
    model = options.model ?? 'forceatlas2';
  if (![2, 3].includes(dimensions) || !['forceatlas2', 'fruchterman-reingold'].includes(model))
    throw invalid('Unknown force model or dimensionality');
  const side = dimensions === 2 ? Math.sqrt(n) : Math.cbrt(n),
    length = options.length ?? 1;
  const settings = {
    dimensions,
    model,
    length,
    temperature: options.temperature ?? Math.max(1, side / 10) * length,
    cooling: options.cooling ?? 0.97,
    simmer: (options.simmer ?? 0.05) * length,
    gravity: options.gravity ?? (model === 'forceatlas2' ? 1 : 0.01),
    scaling: options.scaling ?? 2,
    theta: options.theta ?? 0.7,
    jitterTolerance: options.jitterTolerance ?? 1,
    weightInfluence: options.weightInfluence ?? 1,
    linLog: options.linLog ?? false,
    strongGravity: options.strongGravity ?? false,
    dissuadeHubs: options.dissuadeHubs ?? false,
    gridSide: options.gridSide ?? (dimensions === 2 ? 128 : 16),
    side: side * length,
  };
  if (
    !Object.values(settings).every((v) => typeof v !== 'number' || (Number.isFinite(v) && v >= 0)) ||
    length <= 0 ||
    settings.temperature <= 0 ||
    settings.cooling <= 0 ||
    settings.cooling > 1 ||
    settings.scaling <= 0 ||
    settings.jitterTolerance <= 0 ||
    settings.gridSide < 2 ||
    settings.gridSide > (dimensions === 2 ? 512 : 64) ||
    !Number.isInteger(Math.log2(settings.gridSide))
  )
    throw invalid('Invalid positive length, temperature, scaling, tolerance, cooling or power-of-two grid');
  for (const [name, value, size] of [
    ['positions', options.positions, n * 3],
    ['radii', options.radii, n],
    ['fixed', options.fixed, n],
  ] as const) {
    if (
      value &&
      (value.length !== size ||
        Array.from(value).some(
          (v) => !Number.isFinite(v) || !Number.isFinite(Math.fround(v)) || (name === 'radii' && v < 0),
        ))
    )
      throw invalid(`Invalid ${name} length or finite values`);
  }
  if (!Number.isInteger(options.seed ?? 1)) throw invalid('Seed must be an integer');
  const offsets = new Uint32Array(n + 1),
    degree = new Uint32Array(n);
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e],
      b = edges[e + 1];
    degree[a]++;
    degree[b]++;
    if (a !== b) {
      offsets[a + 1]++;
      offsets[b + 1]++;
    }
  }
  for (let i = 0; i < n; i++) offsets[i + 1] += offsets[i];
  const adjacency = new Uint32Array(offsets[n] * 2),
    cursor = offsets.slice();
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e],
      b = edges[e + 1];
    if (a === b) continue;
    adjacency[cursor[a]++ * 2] = b;
    adjacency[(cursor[a] - 1) * 2 + 1] = e / 2;
    adjacency[cursor[b]++ * 2] = a;
    adjacency[(cursor[b] - 1) * 2 + 1] = e / 2;
  }
  let seed = (options.seed ?? 1) >>> 0;
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const positions = new Float32Array(n * 4),
    attributes = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++)
      positions[i * 4 + a] =
        a === 2 && dimensions === 2
          ? 0
          : options.positions
            ? options.positions[i * 3 + a]
            : (random() - 0.5) * settings.side;
    positions[i * 4 + 3] = model === 'forceatlas2' ? degree[i] + 1 : 1;
    attributes[i * 4] = options.radii?.[i] ?? 0;
    attributes[i * 4 + 1] = options.fixed?.[i] ? 1 : 0;
    attributes[i * 4 + 2] = degree[i] + 1;
  }
  const edgeData = new Float32Array(weights.length * 2);
  for (let i = 0; i < weights.length; i++) {
    edgeData[i * 2] = model === 'forceatlas2' ? weights[i] ** settings.weightInfluence : weights[i];
    edgeData[i * 2 + 1] = settings.dissuadeHubs ? degree[edges[i * 2]] + 1 : 1;
    if (!Number.isFinite(edgeData[i * 2])) throw invalid('Weight exponent overflows float32');
  }
  return { n, edges, offsets, adjacency, edgeData, positions, attributes, settings };
}
export type PreparedGraph = ReturnType<typeof graphData>;
