// Force-directed graph layout and drawing for networks with millions of edges. The forces are those of T. M. J.
// Fruchterman and E. M. Reingold, "Graph drawing by force-directed placement", Software: Practice and Experience
// 21(11), 1991: edges pull with d^2 / k, every pair of nodes pushes with k^2 / d, and each node moves at most a
// temperature that cools quickly and then simmers at a low constant. In place of their frame walls a weak pull toward
// the origin keeps parts that are not connected near. The all-pairs push is approximated by the tree code of J. Barnes
// and P. Hut (Nature 324, 1986; described in full in their "Error analysis of a tree code", ApJS 70, 1989, appendix A):
// nodes go into a quadtree (2D) or octree (3D), and a cell of side s acts as one body at its centre of mass when
// d > s / theta + delta, d the distance to that centre and delta its offset from the cell's middle (Barnes's 1994
// test, as in J. Dubinski, New Astronomy 1, 1996), and the node is not inside the cell. One iteration costs
// O(E + N log N). Positions are a Float32Array the layer draws from directly:
// edges as GPU lines read from a storage buffer by index, nodes as screen-space discs coloured through a colour map.
import { hexColor, SRGBToLinear } from '@margoengine/math/color';
import { rangeError, typeError } from '../../shared/errors.js';
import { colormapTexture, resolveColormap, type Bounds, type ColormapSource } from './layer.js';
import { frameWGSL, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import type { Colormap } from './colormaps.js';
import type { Figure } from './figure.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** A graph: `nodes` nodes and edges as pairs of node indices. */
export interface Graph {
  readonly nodes: number;
  /** Two node indices per edge. */
  readonly edges: ArrayLike<number>;
  /** Weight per edge (pull strength). Default 1 each. */
  readonly weights?: ArrayLike<number>;
}

/** Options of {@link ForceLayout}. */
export interface ForceLayoutOptions {
  /** 2 lays out in the z = 0 plane; 3 in space. Default 2. */
  readonly dimensions?: 2 | 3;
  /** Barnes-Hut opening angle: larger is faster and coarser; 0 is exact all pairs. Default 0.9. */
  readonly theta?: number;
  /** Ideal edge length k. Default sqrt(area / n) for a square or cube of side sqrt(n) (so k is about 1). */
  readonly length?: number;
  /** First temperature (largest step), in data units. Default a tenth of the start square's side, at least k. */
  readonly temperature?: number;
  /** Cooling factor per iteration. Default 0.97. */
  readonly cooling?: number;
  /**
   * Lowest temperature, in units of k: the layout cools quickly to it and then simmers there (Fruchterman and
   * Reingold's quench and simmer schedule). Default 0.05.
   */
  readonly simmer?: number;
  /** Pull toward the centre, so parts that are not connected stay near. Default 0.01. */
  readonly gravity?: number;
  /** Seed of the start positions (a square or cube of side sqrt(n) k). Default 1. */
  readonly seed?: number;
  /** Start positions, xyz per node (a 2D layout sets z to 0). Default random from `seed`. */
  readonly positions?: ArrayLike<number>;
}

/** What one iteration reports. */
export interface LayoutStep {
  /** Iterations done so far. */
  readonly iteration: number;
  /** The step limit of this iteration. */
  readonly temperature: number;
  /** Largest move of any node this iteration. */
  readonly moved: number;
  /** xyz per node (the layout's own array; copy it to keep a snapshot). */
  readonly positions: Float32Array;
}

// Mulberry32: a small seeded generator for the start positions.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A force-directed layout of a graph, run one iteration at a time (`step()`) or as an async iterator (`run()`) that
 * yields to the page between iterations.
 */
export class ForceLayout {
  /** xyz per node. */
  readonly positions: Float32Array;
  readonly nodes: number;
  readonly dimensions: 2 | 3;
  #iteration = 0;
  #temperature: number;
  readonly #k: number;
  readonly #theta: number;
  readonly #cooling: number;
  readonly #simmer: number;
  readonly #next: Int32Array;
  readonly #leafOf: Int32Array;
  readonly #gravity: number;
  readonly #edges: Uint32Array;
  readonly #weights: Float32Array | undefined;
  readonly #force: Float64Array;
  // Tree storage, reused: per cell its centre of mass, mass, size, centre and first child (-1 for a leaf).
  #cellMass = new Float64Array(0);
  #cellX = new Float64Array(0);
  #cellY = new Float64Array(0);
  #cellZ = new Float64Array(0);
  #cellSize = new Float64Array(0);
  #cellCx = new Float64Array(0);
  #cellCy = new Float64Array(0);
  #cellCz = new Float64Array(0);
  #cellChild = new Int32Array(0);
  #cellBody = new Int32Array(0);
  #cells = 0;

  constructor(graph: Graph, options: ForceLayoutOptions = {}) {
    const n = graph.nodes;
    if (!Number.isInteger(n) || n < 1) throw rangeError(`A graph needs a whole number of nodes, got ${n}`, 'sciviz');
    if (graph.edges.length % 2) throw rangeError('Graph edges hold two node indices per edge', 'sciviz');
    this.#edges = Uint32Array.from(graph.edges as ArrayLike<number>);
    for (let i = 0; i < this.#edges.length; i++)
      if (this.#edges[i] >= n || this.#edges[i] !== graph.edges[i])
        throw rangeError(`Graph edge ${i >> 1} names node ${graph.edges[i]} of ${n}`, 'sciviz');
    if (graph.weights && graph.weights.length * 2 !== this.#edges.length)
      throw rangeError('Graph weights hold one value per edge', 'sciviz');
    this.#weights = graph.weights ? Float32Array.from(graph.weights) : undefined;
    this.nodes = n;
    this.dimensions = options.dimensions ?? 2;
    if (this.dimensions !== 2 && this.dimensions !== 3)
      throw rangeError('Graph layout dimensions are 2 or 3', 'sciviz');
    const side = this.dimensions === 2 ? Math.sqrt(n) : Math.cbrt(n);
    this.#k = options.length ?? 1;
    this.#theta = options.theta ?? 0.9;
    this.#cooling = options.cooling ?? 0.97;
    this.#gravity = options.gravity ?? 0.01;
    this.#simmer = (options.simmer ?? 0.05) * this.#k;
    this.#temperature = options.temperature ?? Math.max(1, side * 0.1) * this.#k;
    if (
      !(this.#k > 0) ||
      !(this.#theta >= 0) ||
      !(this.#cooling > 0 && this.#cooling <= 1) ||
      !(this.#gravity >= 0) ||
      !(this.#simmer >= 0)
    )
      throw rangeError(
        'Graph layout length > 0, theta >= 0, cooling in (0, 1], gravity >= 0 and simmer >= 0',
        'sciviz',
      );
    this.positions = new Float32Array(n * 3);
    if (options.positions) {
      if (options.positions.length !== n * 3)
        throw rangeError(`Graph start positions need xyz for ${n} nodes`, 'sciviz');
      this.positions.set(options.positions);
      // A 2D layout lies on z = 0: a given z would count in the distances but never move.
      if (this.dimensions === 2) for (let i = 0; i < n; i++) this.positions[i * 3 + 2] = 0;
    } else {
      const next = random(options.seed ?? 1);
      for (let i = 0; i < n; i++) {
        this.positions[i * 3] = (next() - 0.5) * side * this.#k;
        this.positions[i * 3 + 1] = (next() - 0.5) * side * this.#k;
        this.positions[i * 3 + 2] = this.dimensions === 3 ? (next() - 0.5) * side * this.#k : 0;
      }
    }
    this.#force = new Float64Array(n * 3);
    this.#next = new Int32Array(n);
    this.#leafOf = new Int32Array(n);
  }

  /** Iterations done. */
  get iteration(): number {
    return this.#iteration;
  }

  /** Current step limit. */
  get temperature(): number {
    return this.#temperature;
  }

  #build(): void {
    const n = this.nodes,
      p = this.positions,
      three = this.dimensions === 3,
      fan = three ? 8 : 4;
    const max = Math.max(16, n * 4 * (three ? 2 : 1));
    if (this.#cellMass.length < max) {
      this.#cellMass = new Float64Array(max);
      this.#cellX = new Float64Array(max);
      this.#cellY = new Float64Array(max);
      this.#cellZ = new Float64Array(max);
      this.#cellSize = new Float64Array(max);
      this.#cellCx = new Float64Array(max);
      this.#cellCy = new Float64Array(max);
      this.#cellCz = new Float64Array(max);
      this.#cellChild = new Int32Array(max);
      this.#cellBody = new Int32Array(max);
    }
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = p[i * 3],
        y = p[i * 3 + 1],
        z = p[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const size = Math.max(maxX - minX, maxY - minY, three ? maxZ - minZ : 0, 1e-9) * 1.0001;
    this.#cells = 0;
    const make = (cx: number, cy: number, cz: number, s: number): number => {
      const c = this.#cells++;
      if (c >= this.#cellMass.length) this.#grow();
      this.#cellMass[c] = 0;
      this.#cellX[c] = this.#cellY[c] = this.#cellZ[c] = 0;
      this.#cellSize[c] = s;
      this.#cellCx[c] = cx;
      this.#cellCy[c] = cy;
      this.#cellCz[c] = cz;
      this.#cellChild[c] = -1;
      this.#cellBody[c] = -1;
      return c;
    };
    make((minX + maxX) / 2, (minY + maxY) / 2, three ? (minZ + maxZ) / 2 : 0, size);
    const quadrant = (c: number, x: number, y: number, z: number) =>
      (x >= this.#cellCx[c] ? 1 : 0) | (y >= this.#cellCy[c] ? 2 : 0) | (three && z >= this.#cellCz[c] ? 4 : 0);
    const split = (c: number) => {
      const first = this.#cells,
        h = this.#cellSize[c] / 2,
        q = h / 2;
      for (let k = 0; k < fan; k++)
        make(
          this.#cellCx[c] + (k & 1 ? q : -q),
          this.#cellCy[c] + (k & 2 ? q : -q),
          three ? this.#cellCz[c] + (k & 4 ? q : -q) : 0,
          h,
        );
      this.#cellChild[c] = first;
    };
    // Barnes and Hut's insertion: walk down to the leaf the body falls in; a leaf that already holds a body splits and
    // both go further down. A leaf keeps a chain of bodies (#next) when they share one position, or past depth 40.
    const next = this.#next,
      leafOf = this.#leafOf;
    for (let i = 0; i < n; i++) {
      const x = p[i * 3],
        y = p[i * 3 + 1],
        z = p[i * 3 + 2];
      let c = 0,
        depth = 0;
      for (;;) {
        // Accumulate mass and centre of mass on the way down.
        const m = this.#cellMass[c];
        this.#cellX[c] = (this.#cellX[c] * m + x) / (m + 1);
        this.#cellY[c] = (this.#cellY[c] * m + y) / (m + 1);
        this.#cellZ[c] = (this.#cellZ[c] * m + z) / (m + 1);
        this.#cellMass[c] = m + 1;
        if (this.#cellChild[c] >= 0) {
          c = this.#cellChild[c] + quadrant(c, x, y, z);
          depth++;
          continue;
        }
        const head = this.#cellBody[c];
        if (head < 0 || depth >= 40 || (p[head * 3] === x && p[head * 3 + 1] === y && p[head * 3 + 2] === z)) {
          next[i] = head;
          this.#cellBody[c] = i;
          leafOf[i] = c;
          break;
        }
        // Split: the chain (one position, as it is above depth 40) moves whole into its child, then the body goes on.
        split(c);
        const hx = p[head * 3],
          hy = p[head * 3 + 1],
          hz = p[head * 3 + 2],
          child = this.#cellChild[c] + quadrant(c, hx, hy, hz);
        this.#cellMass[child] = m;
        this.#cellX[child] = hx;
        this.#cellY[child] = hy;
        this.#cellZ[child] = hz;
        this.#cellBody[child] = head;
        for (let b = head; b >= 0; b = next[b]) leafOf[b] = child;
        this.#cellBody[c] = -1;
        c = this.#cellChild[c] + quadrant(c, x, y, z);
        depth++;
      }
    }
  }

  #grow(): void {
    const grow = <T extends Float64Array | Int32Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(a.length * 2);
      b.set(a);
      return b;
    };
    this.#cellMass = grow(this.#cellMass);
    this.#cellX = grow(this.#cellX);
    this.#cellY = grow(this.#cellY);
    this.#cellZ = grow(this.#cellZ);
    this.#cellSize = grow(this.#cellSize);
    this.#cellCx = grow(this.#cellCx);
    this.#cellCy = grow(this.#cellCy);
    this.#cellCz = grow(this.#cellCz);
    this.#cellChild = grow(this.#cellChild);
    this.#cellBody = grow(this.#cellBody);
  }

  /** One iteration: forces, then each node moves along its force by at most the temperature. */
  step(): LayoutStep {
    const n = this.nodes,
      p = this.positions,
      f = this.#force,
      k2 = this.#k * this.#k,
      three = this.dimensions === 3,
      fan = three ? 8 : 4;
    f.fill(0);
    // Repulsion k^2 / d between every pair, through the tree (exact when theta is 0).
    this.#build();
    const stack = new Int32Array(64 * fan + 8);
    for (let i = 0; i < n; i++) {
      const x = p[i * 3],
        y = p[i * 3 + 1],
        z = p[i * 3 + 2];
      let fx = 0,
        fy = 0,
        fz = 0,
        top = 0;
      stack[top++] = 0;
      while (top) {
        const c = stack[--top],
          m = this.#cellMass[c];
        if (!m) continue;
        const leaf = this.#cellChild[c] < 0,
          own = leaf && this.#leafOf[i] === c,
          mass = own ? m - 1 : m;
        if (!mass) continue;
        // A leaf holding this node acts with the others' centre of mass: the cell's, less this node.
        const cx = own ? (this.#cellX[c] * m - x) / mass : this.#cellX[c],
          cy = own ? (this.#cellY[c] * m - y) / mass : this.#cellY[c],
          cz = own ? (this.#cellZ[c] * m - z) / mass : this.#cellZ[c],
          dx = x - cx,
          dy = y - cy,
          dz = z - cz,
          d2 = dx * dx + dy * dy + dz * dz,
          s = this.#cellSize[c],
          h = s / 2;
        // A cell is taken as one body when d > s / theta + delta, delta the distance from its centre of mass to its
        // geometric centre: Barnes's 1994 change to the Barnes and Hut test d > s / theta (J. Dubinski, "A parallel
        // tree code", New Astronomy 1, 1996, eqs. 1 and 2). The plain test fails when the mass sits near the cell's
        // far side (Salmon and Warren, J. Comp. Phys. 111, 1994): above theta 0.71 in 2D a node just outside the
        // near side then takes the cell as one far body, though nodes inside it are next to it. A ring whose two edges
        // crossed so kept the crossing for ever at theta 0.9 (seed 3, edges 13 % uneven), as exact forces never do.
        // The 1989 appendix's note that a cell holding the node can pass a large theta stands: such a cell stays open.
        const ox = this.#cellX[c] - this.#cellCx[c],
          oy = this.#cellY[c] - this.#cellCy[c],
          oz = this.#cellZ[c] - this.#cellCz[c],
          reach = Math.sqrt(d2) - Math.sqrt(ox * ox + oy * oy + oz * oz),
          inside =
            Math.abs(x - this.#cellCx[c]) <= h &&
            Math.abs(y - this.#cellCy[c]) <= h &&
            (!three || Math.abs(z - this.#cellCz[c]) <= h);
        if (leaf || (reach > 0 && s < this.#theta * reach && !inside)) {
          if (d2 > 0) {
            const f = (k2 * mass) / d2;
            fx += dx * f;
            fy += dy * f;
            fz += dz * f;
          } else {
            // Coincident nodes: Fruchterman and Reingold treat them as a small distance apart in some direction, a
            // violent push. The direction is fixed by the node's index (a golden-angle spiral) so runs repeat.
            const a = i * 2.399963229728653,
              u = three ? 1 - 2 * ((i * 0.6180339887498949) % 1) : 0,
              r = Math.sqrt(1 - u * u),
              f = (k2 * mass) / (0.01 * this.#k);
            fx += Math.cos(a) * r * f;
            fy += Math.sin(a) * r * f;
            fz += u * f;
          }
          continue;
        }
        const first = this.#cellChild[c];
        for (let q = 0; q < fan; q++) if (this.#cellMass[first + q]) stack[top++] = first + q;
      }
      f[i * 3] += fx;
      f[i * 3 + 1] += fy;
      f[i * 3 + 2] += fz;
    }
    // Attraction d^2 / k along every edge, weighted.
    const e = this.#edges,
      w = this.#weights,
      inverseK = 1 / this.#k;
    for (let j = 0; j < e.length; j += 2) {
      const a = e[j],
        b = e[j + 1];
      if (a === b) continue;
      const dx = p[b * 3] - p[a * 3],
        dy = p[b * 3 + 1] - p[a * 3 + 1],
        dz = p[b * 3 + 2] - p[a * 3 + 2],
        d = Math.sqrt(dx * dx + dy * dy + dz * dz),
        s = d * inverseK * (w ? w[j >> 1] : 1);
      f[a * 3] += dx * s;
      f[a * 3 + 1] += dy * s;
      f[a * 3 + 2] += dz * s;
      f[b * 3] -= dx * s;
      f[b * 3 + 1] -= dy * s;
      f[b * 3 + 2] -= dz * s;
    }
    // Gravity toward the origin, then the capped move.
    const g = this.#gravity * this.#k,
      t = this.#temperature;
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let fx = f[i * 3] - g * p[i * 3],
        fy = f[i * 3 + 1] - g * p[i * 3 + 1],
        fz = three ? f[i * 3 + 2] - g * p[i * 3 + 2] : 0;
      const length = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (!(length > 0)) continue;
      const s = Math.min(length, t) / length;
      fx *= s;
      fy *= s;
      fz *= s;
      p[i * 3] += fx;
      p[i * 3 + 1] += fy;
      p[i * 3 + 2] += fz;
      const step = Math.min(length, t);
      if (step > moved) moved = step;
    }
    this.#iteration++;
    this.#temperature = Math.max(t * this.#cooling, Math.min(t, this.#simmer));
    return { iteration: this.#iteration, temperature: t, moved, positions: p };
  }

  /**
   * Runs iterations as an async iterator, yielding after each so the page can draw. Stops after `iterations`, once
   * no node moves more than `tolerance` times k, or when `signal` aborts.
   */
  async *run(
    options: { readonly iterations?: number; readonly tolerance?: number; readonly signal?: AbortSignal } = {},
  ): AsyncGenerator<LayoutStep, void, undefined> {
    const iterations = options.iterations ?? 300,
      tolerance = (options.tolerance ?? 0.001) * this.#k;
    for (let i = 0; i < iterations; i++) {
      options.signal?.throwIfAborted();
      const step = this.step();
      yield step;
      if (step.moved <= tolerance) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

/** Options for a graph layer. */
export interface GraphLayerOptions {
  /** Node disc diameter in CSS pixels. Default 4. */
  readonly nodeSize?: number;
  /** Value per node for its colour. Default the node's degree. */
  readonly values?: ArrayLike<number>;
  /** Colour map of the nodes. Default `'aurora'`. */
  readonly colormap?: ColormapSource;
  /** Value range the colour map spans. Default the values' min and max. */
  readonly range?: readonly [number, number];
  /** Edge colour, a hex colour such as `#rrggbb`. Default `'#7f8ea3'`. */
  readonly edgeColor?: string;
  /** Edge opacity, 0 to 1. Default 0.35. */
  readonly edgeOpacity?: number;
  /** Bounds the figure frames. Default the positions' box at creation. */
  readonly bounds?: Bounds;
}

const graphShader = /* wgsl */ `${frameWGSL}
struct Graph { model: mat4x4f, style: vec4f, edge: vec4f, scale: vec4f }
@group(1) @binding(0) var<uniform> graph: Graph;
@group(1) @binding(1) var<storage, read> nodes: array<f32>;
@group(1) @binding(2) var<storage, read> edges: array<u32>;
@group(1) @binding(3) var<storage, read> values: array<f32>;
@group(1) @binding(4) var colours: texture_2d<f32>;
@group(1) @binding(5) var colourSampler: sampler;
fn node(i: u32) -> vec3f { return vec3f(nodes[i * 3u], nodes[i * 3u + 1u], nodes[i * 3u + 2u]); }
@vertex fn edgeVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let n = edges[index];
  return frame.clip * (graph.model * vec4f(node(n), 1.0));
}
@fragment fn edgeFragment() -> @location(0) vec4f {
  return vec4f(toOutput(graph.edge.rgb) * graph.edge.a, graph.edge.a);
}
struct NodeOut { @builtin(position) clip: vec4f, @location(0) corner: vec2f, @location(1) value: f32 }
@vertex fn nodeVertex(@builtin(vertex_index) index: u32, @builtin(instance_index) instance: u32) -> NodeOut {
  let quad = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = quad[index];
  var clip = frame.clip * (graph.model * vec4f(node(instance), 1.0));
  // The disc's radius in device pixels, over half the viewport, times w: the same size at every depth.
  clip = vec4f(clip.xy + c * graph.style.z * clip.w / frame.viewport.xy, clip.zw);
  var out: NodeOut;
  out.clip = clip;
  out.corner = c;
  out.value = values[instance];
  return out;
}
@fragment fn nodeFragment(in: NodeOut) -> @location(0) vec4f {
  let r = dot(in.corner, in.corner);
  if (r > 1.0) { discard; }
  let t = clamp((in.value - graph.style.x) / max(graph.style.y - graph.style.x, 1e-30), 0.0, 1.0);
  let albedo = textureSampleLevel(colours, colourSampler, vec2f(t, 0.5), 0.0).rgb;
  // A darker rim so touching nodes stay apart.
  let rim = select(1.0, 0.55, r > 0.6);
  return vec4f(toOutput(albedo * rim), 1.0);
}`;

/**
 * A graph drawn from node positions on the GPU: edges as lines, nodes as discs a fixed number of pixels across.
 * Create it with {@link graphLayer}; `setPositions(layout.positions)` after each layout step moves it.
 */
export class GraphLayer implements Drawable {
  visible = true;
  /** Nodes draw opaque after the blended edges are sorted in; the layer counts as blended. */
  readonly transparent = true;
  readonly nodes: number;
  readonly edges: number;
  readonly colormap: Colormap;
  readonly #renderer: SciRenderer;
  readonly #bounds: Bounds;
  readonly #nodeBuffer: GPUBuffer;
  readonly #edgeBuffer: GPUBuffer;
  readonly #valueBuffer: GPUBuffer;
  readonly #uniform: GPUBuffer;
  readonly #texture: GPUTexture;
  readonly #layout: GPUBindGroupLayout;
  readonly #group: GPUBindGroup;
  readonly #range: [number, number];
  readonly #edge: [number, number, number, number];
  readonly #size: number;
  readonly #model = new Float32Array(16);
  readonly #values = new Float32Array(28);
  #disposed = false;

  /** @internal Use {@link graphLayer}. */
  constructor(renderer: SciRenderer, graph: Graph, positions: Float32Array, options: GraphLayerOptions = {}) {
    this.#renderer = renderer;
    const n = graph.nodes;
    if (positions.length !== n * 3) throw rangeError(`Graph positions need xyz for ${n} nodes`, 'sciviz');
    if (graph.edges.length % 2) throw rangeError('Graph edges hold two node indices per edge', 'sciviz');
    this.nodes = n;
    this.edges = graph.edges.length / 2;
    let values = options.values;
    if (!values) {
      const degree = new Float32Array(n);
      for (let i = 0; i < graph.edges.length; i++) degree[graph.edges[i]]++;
      values = degree;
    }
    if (values.length !== n) throw rangeError(`Graph values need one value per node (${n})`, 'sciviz');
    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i < n; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    this.#range = options.range
      ? [options.range[0], options.range[1]]
      : min < max
        ? [min, max]
        : [min - 0.5, min + 0.5];
    this.colormap = resolveColormap(options.colormap);
    const rgb = hexColor(options.edgeColor ?? '#7f8ea3'),
      opacity = options.edgeOpacity ?? 0.35;
    if (!rgb) throw typeError(`Graph edgeColor ${options.edgeColor} is not a hex colour such as #rrggbb`, 'sciviz');
    if (!(opacity >= 0 && opacity <= 1)) throw rangeError('Graph edgeOpacity must be in [0, 1]', 'sciviz');
    this.#edge = [SRGBToLinear(rgb[0]), SRGBToLinear(rgb[1]), SRGBToLinear(rgb[2]), opacity];
    this.#size = options.nodeSize ?? 4;
    if (!(this.#size > 0)) throw rangeError('Graph nodeSize must be above 0', 'sciviz');
    this.#bounds = options.bounds ?? boundsOf(positions);
    const device = renderer.device!,
      limit = device.limits.maxStorageBufferBindingSize;
    if (graph.edges.length * 4 > limit)
      throw rangeError(`Graph of ${this.edges} edges is over this GPU's storage limit of ${limit} bytes`, 'sciviz');
    const storage = (bytes: number) =>
      device.createBuffer({
        size: Math.max(16, Math.ceil(bytes / 16) * 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    this.#nodeBuffer = storage(n * 12);
    this.#edgeBuffer = storage(graph.edges.length * 4);
    this.#valueBuffer = storage(n * 4);
    device.queue.writeBuffer(this.#edgeBuffer, 0, Uint32Array.from(graph.edges));
    device.queue.writeBuffer(this.#valueBuffer, 0, Float32Array.from(values));
    this.#uniform = device.createBuffer({
      size: this.#values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#texture = colormapTexture(device, this.colormap);
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.#group = device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: this.#uniform } },
        { binding: 1, resource: { buffer: this.#nodeBuffer } },
        { binding: 2, resource: { buffer: this.#edgeBuffer } },
        { binding: 3, resource: { buffer: this.#valueBuffer } },
        { binding: 4, resource: this.#texture.createView() },
        { binding: 5, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
      ],
    });
    this.setPositions(positions);
  }

  /** Data bounds the figure frames. */
  get bounds(): Bounds {
    return this.#bounds;
  }

  /** Uploads new node positions (xyz per node), such as a layout's after a step. */
  setPositions(positions: ArrayLike<number>): void {
    if (this.#disposed) throw typeError('Graph layer disposed; create a new one', 'sciviz');
    if (positions.length !== this.nodes * 3)
      throw rangeError(`Graph positions need xyz for ${this.nodes} nodes`, 'sciviz');
    const data = positions instanceof Float32Array ? positions : Float32Array.from(positions);
    this.#renderer.device!.queue.writeBuffer(this.#nodeBuffer, 0, data);
  }

  /** @internal */
  setModel(model: Float32Array): void {
    this.#model.set(model);
  }

  /** @internal */
  center(): readonly [number, number, number] {
    const [x0, x1, y0, y1, z0, z1] = this.#bounds,
      m = this.#model,
      c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    return [0, 1, 2].map((r) => m[r] * c[0] + m[4 + r] * c[1] + m[8 + r] * c[2] + m[12 + r]) as unknown as [
      number,
      number,
      number,
    ];
  }

  /** @internal */
  prepare(context: GpuContext): void {
    const v = this.#values,
      ratio = (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
    v.set(this.#model, 0);
    v.set([this.#range[0], this.#range[1], this.#size * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1), 0], 16);
    v.set(this.#edge, 20);
    v.set([0, 0, 0, 0], 24);
    this.#renderer.device!.queue.writeBuffer(this.#uniform, 0, v);
  }

  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    const device = renderer.device!,
      layout = () => device.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout] });
    const module = () => device.createShaderModule({ code: graphShader, label: 'sciviz graph' });
    const edges = renderer.pipeline('graph-edges', context, (target) => {
      const m = module();
      return {
        label: 'sciviz graph edges',
        layout: layout(),
        vertex: { module: m, entryPoint: 'edgeVertex' },
        fragment: {
          module: m,
          entryPoint: 'edgeFragment',
          targets: [
            {
              format: target.format,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
          ],
        },
        primitive: { topology: 'line-list' },
        multisample: target.multisample,
        depthStencil: { format: target.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      };
    });
    const nodes = renderer.pipeline('graph-nodes', context, (target) => {
      const m = module();
      return {
        label: 'sciviz graph nodes',
        layout: layout(),
        vertex: { module: m, entryPoint: 'nodeVertex' },
        fragment: { module: m, entryPoint: 'nodeFragment', targets: [{ format: target.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: target.multisample,
        depthStencil: { format: target.depth, depthWriteEnabled: true, depthCompare: 'greater-equal' },
      };
    });
    pass.setBindGroup(1, this.#group);
    if (this.edges) {
      pass.setPipeline(edges);
      pass.draw(this.edges * 2);
    }
    pass.setPipeline(nodes);
    pass.draw(6, this.nodes);
  }

  /** Frees the GPU resources and leaves the figure's renderer. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#renderer.remove(this);
    for (const b of [this.#nodeBuffer, this.#edgeBuffer, this.#valueBuffer, this.#uniform]) b.destroy();
    this.#texture.destroy();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** The box of xyz positions. */
export function boundsOf(positions: ArrayLike<number>): Bounds {
  const b: Bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < b[a * 2]) b[a * 2] = v;
      if (v > b[a * 2 + 1]) b[a * 2 + 1] = v;
    }
  for (let a = 0; a < 3; a++) {
    if (!(b[a * 2] <= b[a * 2 + 1])) b[a * 2] = b[a * 2 + 1] = 0;
    if (b[a * 2] === b[a * 2 + 1]) (b[a * 2] -= 0.5), (b[a * 2 + 1] += 0.5);
  }
  return b;
}

/** Draws a graph in a figure (3D mode; a 2D layout lies in z = 0). */
export function graphLayer(
  figure: Figure,
  graph: Graph,
  positions: Float32Array,
  options: GraphLayerOptions = {},
): GraphLayer {
  const layer = new GraphLayer(figure.renderer, graph, positions, options);
  figure.renderer.add(layer);
  return figure.addLayer(layer);
}
