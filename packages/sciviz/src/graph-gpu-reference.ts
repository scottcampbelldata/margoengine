import type { Graph } from './graph.js';
import { graphData } from './graph-gpu-data.js';
import type { GPUGraphOptions } from './graph-gpu-types.js';

/** Exact all-pairs CPU reference for FR and ForceAtlas2. Intended for validation and small graphs. */
export class GraphLayoutReference {
  /** xyz per node. */
  readonly positions: Float32Array;
  readonly #data: ReturnType<typeof graphData>;
  #previous: Float64Array;
  #temperature: number;
  #speed = 1;
  #iterations = 0;
  constructor(graph: Graph, options: GPUGraphOptions = {}) {
    this.#data = graphData(graph, options);
    this.positions = new Float32Array(graph.nodes * 3);
    for (let i = 0; i < graph.nodes; i++) this.positions.set(this.#data.positions.subarray(i * 4, i * 4 + 3), i * 3);
    this.#previous = new Float64Array(graph.nodes * 3);
    this.#temperature = this.#data.settings.temperature;
    this.#overlap = !!options.radii;
  }
  readonly #overlap: boolean;
  /** Completed iterations. */
  get iteration(): number {
    return this.#iterations;
  }
  /** Adaptive global FA2 speed. */
  get speed(): number {
    return this.#speed;
  }
  /** Runs one exact iteration, returning the layout's xyz array. */
  step(): Float32Array {
    const { n, positions: packed, attributes: attrs, offsets, adjacency, edgeData, settings: s } = this.#data;
    const p = this.positions,
      f = new Float64Array(p.length),
      fa = s.model === 'forceatlas2',
      eps = 0.01 * s.length;
    for (let i = 0; i < n; i++) {
      const mass = packed[i * 4 + 3],
        off = i * 3;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        let dx = p[off] - p[j * 3],
          dy = p[off + 1] - p[j * 3 + 1],
          dz = p[off + 2] - p[j * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz,
          d = Math.sqrt(d2),
          m = mass * packed[j * 4 + 3];
        if (d2 === 0) {
          const angle = Math.fround(i) * 2.39996323,
            z = s.dimensions === 3 ? 1 - 2 * ((i * 0.61803399) % 1) : 0,
            r = Math.sqrt(1 - z * z);
          dx = Math.cos(angle) * r * eps;
          dy = Math.sin(angle) * r * eps;
          dz = z * eps;
        }
        let scale = ((fa ? s.scaling : s.length * s.length) * m) / Math.max(d2, eps * eps);
        if (fa && this.#overlap) {
          const gap = d - attrs[i * 4] - attrs[j * 4];
          scale = gap < 0 ? 100 * s.scaling * m : (s.scaling * m) / Math.max(gap * gap, eps * eps);
        }
        f[off] += dx * scale;
        f[off + 1] += dy * scale;
        f[off + 2] += dz * scale;
      }
      for (let e = offsets[i]; e < offsets[i + 1]; e++) {
        const j = adjacency[e * 2],
          edge = adjacency[e * 2 + 1],
          dx = p[j * 3] - p[off],
          dy = p[j * 3 + 1] - p[off + 1],
          dz = p[j * 3 + 2] - p[off + 2];
        const d = Math.hypot(dx, dy, dz);
        let factor = fa ? 1 / edgeData[edge * 2 + 1] : d / s.length;
        if (fa && s.linLog) factor *= Math.log1p(d) / Math.max(d, 1e-20);
        if (fa && this.#overlap && d <= attrs[i * 4] + attrs[j * 4]) factor = 0;
        const weight = factor * edgeData[edge * 2];
        f[off] += dx * weight;
        f[off + 1] += dy * weight;
        f[off + 2] += dz * weight;
      }
      const g = fa
        ? (s.gravity * mass) / (s.strongGravity ? 1 : Math.max(Math.hypot(p[off], p[off + 1], p[off + 2]), 1e-20))
        : s.gravity * s.length;
      for (let a = 0; a < 3; a++) f[off + a] -= p[off + a] * g;
      if (s.dimensions === 2) f[off + 2] = 0;
    }
    let swing = 0,
      traction = 0;
    for (let i = 0; i < n; i++) {
      if (attrs[i * 4 + 1]) continue;
      const k = i * 3,
        mass = packed[i * 4 + 3],
        old = this.#previous;
      swing += mass * Math.hypot(f[k] - old[k], f[k + 1] - old[k + 1], f[k + 2] - old[k + 2]);
      traction += (mass * Math.hypot(f[k] + old[k], f[k + 1] + old[k + 1], f[k + 2] + old[k + 2])) / 2;
    }
    if (swing > 0) this.#speed = Math.min((s.jitterTolerance ** 2 * traction) / swing, this.#speed * 1.5);
    for (let i = 0; i < n; i++) {
      if (attrs[i * 4 + 1]) continue;
      const k = i * 3,
        d = Math.hypot(f[k], f[k + 1], f[k + 2]);
      if (d === 0) continue;
      const localSwing =
        packed[i * 4 + 3] *
        Math.hypot(f[k] - this.#previous[k], f[k + 1] - this.#previous[k + 1], f[k + 2] - this.#previous[k + 2]);
      const factor = fa
        ? Math.min(
            ((0.1 * this.#speed) / (1 + this.#speed * Math.sqrt(localSwing))) * (this.#overlap ? 0.1 : 1),
            10 / d,
          )
        : Math.min(d, this.#temperature) / d;
      for (let a = 0; a < 3; a++) p[k + a] += f[k + a] * factor;
    }
    this.#previous = f;
    this.#iterations++;
    this.#temperature = Math.max(this.#temperature * s.cooling, Math.min(this.#temperature, s.simmer));
    return p;
  }
}
