/// <reference lib="esnext.disposable" preserve="true" />
import type { ComputeContext, GpuArray, Kernel } from '@margoengine/compute';
import { fault } from '../../shared/errors.js';
import type { Graph } from './graph.js';
import { graphData, invalid } from './graph-gpu-data.js';
import * as shaders from './graph-gpu-shaders.js';
import type { GPUGraphOptions, GPUGraphWork } from './graph-gpu-types.js';
export type { GPUGraphOptions, GPUGraphWork, GPUGraph, GraphForceModel } from './graph-gpu-types.js';
export { GraphLayoutReference } from './graph-gpu-reference.js';
export { bundleGraphEdges, bundleGraphEdgesReference, edgeCompatibility } from './graph-gpu-bundle.js';
export type { GraphBundleOptions, GraphBundles } from './graph-gpu-bundle.js';
export { gpuGraphLayer, GPUGraphLayer, placeGraphLabels } from './graph-gpu-draw.js';
export type { GPUGraphLayerOptions, GraphLabelBox } from './graph-gpu-draw.js';

/**
 * Device-resident FR/ForceAtlas2 layout, including a GPU-sorted Morton grid and stackless Barnes-Hut traversal.
 * The caller owns the ComputeContext. The CPU reference remains available through sciviz/graph and this entry.
 */
export class GPUGraphLayout {
  /** Snapshotted graph connectivity, used by drawing and bundling. */
  readonly graph: Graph;
  /** Caller-owned compute context. */
  readonly gpu: ComputeContext;
  /** Fully resolved layout settings. */
  readonly settings: ReturnType<typeof graphData>['settings'];
  readonly #arrays: GpuArray[] = [];
  readonly #programs = new Map<string, Kernel>();
  #positions: GpuArray<'f32'>;
  #spare: GpuArray<'f32'>;
  #previous: GpuArray<'f32'>;
  #force: GpuArray<'f32'>;
  readonly #attrs: GpuArray<'f32'>;
  readonly #repulsion: GpuArray<'f32'>;
  readonly #offsets: GpuArray<'u32'>;
  readonly #adjacency: GpuArray<'u32'>;
  readonly #edgeData: GpuArray<'f32'>;
  readonly #tree: GpuArray<'f32'>;
  readonly #treeSpare: GpuArray<'f32'>;
  readonly #ranges: GpuArray<'u32'>;
  #keys: GpuArray<'u32'>;
  #keysSpare: GpuArray<'u32'>;
  readonly #stats: GpuArray<'f32'>;
  #state: GpuArray<'f32'>;
  #stateSpare: GpuArray<'f32'>;
  readonly #padded: number;
  readonly #leaves: number;
  readonly #base: number;
  readonly #fan: number;
  readonly #entries: number;
  #iterations = 0;
  #dispatches = 0;
  #comparisons = 0;
  #temperature: number;
  #disposed = false;

  constructor(gpu: ComputeContext, graph: Graph, options: GPUGraphOptions = {}) {
    if (gpu.backend === 'cpu')
      throw fault(
        'unsupported',
        'GPU graph layout requires a WebGPU or compatibility device; use GraphLayoutReference on CPU',
        'sciviz',
      );
    const data = graphData(graph, options);
    this.gpu = gpu;
    this.graph = { nodes: data.n, edges: data.edges };
    this.settings = data.settings;
    this.#temperature = data.settings.temperature;
    this.#padded = 2 ** Math.ceil(Math.log2(data.n));
    this.#leaves = data.settings.gridSide ** data.settings.dimensions;
    this.#fan = 2 ** data.settings.dimensions;
    this.#base = (this.#leaves - 1) / (this.#fan - 1);
    const cells = this.#base + this.#leaves;
    const limit = Math.min(gpu.device.limits.maxStorageBufferBindingSize, gpu.device.limits.maxBufferSize);
    if (Math.max(data.n * 16, this.#padded * 8, cells * 48, data.adjacency.byteLength) > limit)
      throw invalid('Graph buffers exceed this device storage limit; reduce the graph or grid size');
    const upload = <T extends 'f32' | 'u32'>(src: Float32Array | Uint32Array, type: T): GpuArray<T> => {
      const a = gpu.array(src, type);
      this.#arrays.push(a);
      return a;
    };
    const zeros = <T extends 'f32' | 'u32'>(n: number, type: T): GpuArray<T> => {
      const a = gpu.zeros(Math.max(4, n), type);
      this.#arrays.push(a);
      return a;
    };
    this.#positions = upload(data.positions, 'f32');
    this.#spare = zeros(data.n * 4, 'f32');
    this.#previous = zeros(data.n * 4, 'f32');
    this.#force = zeros(data.n * 4, 'f32');
    this.#repulsion = zeros(data.n * 4, 'f32');
    this.#overlap = Number(!!options.radii);
    this.#attrs = upload(data.attributes, 'f32');
    this.#offsets = upload(data.offsets, 'u32');
    this.#adjacency = data.adjacency.length ? upload(data.adjacency, 'u32') : zeros(4, 'u32');
    this.#edgeData = data.edgeData.length ? upload(data.edgeData, 'f32') : zeros(4, 'f32');
    this.#tree = zeros(cells * 12, 'f32');
    this.#treeSpare = zeros(cells * 12, 'f32');
    this.#ranges = zeros(this.#leaves * 2, 'u32');
    this.#keys = zeros(this.#padded * 2, 'u32');
    this.#keysSpare = zeros(this.#padded * 2, 'u32');
    this.#stats = zeros(Math.ceil(data.n / 256) * 4, 'f32');
    this.#state = upload(Float32Array.of(1, 0, 0, 0), 'f32');
    this.#stateSpare = zeros(4, 'f32');
    this.#entries = data.offsets[data.n];
  }

  #check(): void {
    if (this.#disposed) throw fault('disposed', 'Graph layout disposed; create a new layout', 'sciviz');
  }
  /** Current xyz/mass GPU array, four floats per node. Reacquire after step(); never dispose it yourself. */
  get positions(): GpuArray<'f32'> {
    this.#check();
    return this.#positions;
  }
  /** Deterministic work and persistent allocation inventory. */
  get work(): GPUGraphWork {
    return {
      iterations: this.#iterations,
      dispatches: this.#dispatches,
      sortComparisons: this.#comparisons,
      adjacencyEntries: this.#entries,
      bufferBytes: this.#arrays.reduce((n, a) => n + a.buffer.size, 0),
    };
  }

  #dispatch(
    name: keyof typeof shaders,
    resources: Parameters<Kernel['run']>[0],
    count: number,
    extra: { shift?: number; stage?: number; offset?: number; count?: number } = {},
  ): void {
    let kernel = this.#programs.get(name);
    if (!kernel) {
      kernel = this.gpu.kernel(shaders[name]);
      this.#programs.set(name, kernel);
    }
    const s = this.settings;
    const cfg = {
      n: this.graph.nodes,
      padded: this.#padded,
      leaves: this.#leaves,
      base: this.#base,
      side: s.gridSide,
      dims: s.dimensions,
      fan: this.#fan,
      model: s.model === 'forceatlas2' ? 1 : 0,
      k: s.length,
      temperature: this.#temperature,
      gravity: s.gravity,
      scaling: s.scaling,
      theta: s.theta,
      jitter: s.jitterTolerance,
      space: s.side,
      linLog: Number(s.linLog),
      strong: Number(s.strongGravity),
      shift: 0,
      stage: 0,
      offset: 0,
      count,
      overlap: 0,
      pad0: 0,
      pad1: 0,
      ...extra,
    };
    cfg.overlap = this.#overlap;
    kernel.run(
      { ...resources, cfg },
      {
        workgroups: [Math.min(1024, Math.ceil(count / (name === 'speedShader' ? 1 : 64))), Math.ceil(count / 65536), 1],
      },
    );
    this.#dispatches++;
  }
  #overlap = 0;

  /** Enqueues complete iterations without reading positions back. Drawing uses the latest device buffer directly. */
  step(iterations = 1): GPUGraphWork {
    this.#check();
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10000)
      throw invalid('Iterations must be 1..10000');
    for (let iteration = 0; iteration < iterations; iteration++) {
      this.#dispatch('keyShader', { pos: this.#positions, tree: this.#tree, keys: this.#keys }, this.#padded);
      for (let stage = 2; stage <= this.#padded; stage *= 2)
        for (let shift = stage / 2; shift >= 1; shift /= 2) {
          this.#dispatch('sortShader', { src: this.#keys, dst: this.#keysSpare }, this.#padded, { stage, shift });
          [this.#keys, this.#keysSpare] = [this.#keysSpare, this.#keys];
          this.#comparisons += this.#padded;
        }
      this.#dispatch(
        'leafShader',
        { pos: this.#positions, keys: this.#keys, attrs: this.#attrs, tree: this.#tree, ranges: this.#ranges },
        this.#leaves,
      );
      let count = this.#leaves / this.#fan,
        offset = this.#base - count;
      while (count >= 1) {
        this.#dispatch('treeShader', { src: this.#tree, dst: this.#treeSpare }, count, { offset, count });
        const encoder = this.gpu.device.createCommandEncoder();
        encoder.copyBufferToBuffer(this.#treeSpare.buffer, offset * 48, this.#tree.buffer, offset * 48, count * 48);
        this.gpu.device.queue.submit([encoder.finish()]);
        count /= this.#fan;
        offset -= count;
      }
      this.#dispatch(
        'forceShader',
        {
          pos: this.#positions,
          keys: this.#keys,
          tree: this.#tree,
          ranges: this.#ranges,
          attrs: this.#attrs,
          forces: this.#repulsion,
        },
        this.graph.nodes,
      );
      this.#dispatch(
        'attractionShader',
        {
          pos: this.#positions,
          offsets: this.#offsets,
          adjacency: this.#adjacency,
          edges: this.#edgeData,
          attrs: this.#attrs,
          repulsion: this.#repulsion,
          forces: this.#force,
        },
        this.graph.nodes,
      );
      const blocks = Math.ceil(this.graph.nodes / 256);
      this.#dispatch(
        'statsShader',
        { forces: this.#force, previous: this.#previous, pos: this.#positions, attrs: this.#attrs, stats: this.#stats },
        blocks,
        { count: blocks },
      );
      this.#dispatch('speedShader', { stats: this.#stats, old: this.#state, state: this.#stateSpare }, 1, {
        count: blocks,
      });
      [this.#state, this.#stateSpare] = [this.#stateSpare, this.#state];
      this.#dispatch(
        'moveShader',
        {
          pos: this.#positions,
          forces: this.#force,
          previous: this.#previous,
          attrs: this.#attrs,
          state: this.#state,
          dst: this.#spare,
        },
        this.graph.nodes,
      );
      [this.#positions, this.#spare] = [this.#spare, this.#positions];
      [this.#force, this.#previous] = [this.#previous, this.#force];
      this.#temperature = Math.max(
        this.#temperature * this.settings.cooling,
        Math.min(this.#temperature, this.settings.simmer),
      );
      this.#iterations++;
    }
    return this.work;
  }

  /** Reads xyz per node; no readback is needed for drawing. */
  async read(options: { readonly signal?: AbortSignal } = {}): Promise<Float32Array> {
    this.#check();
    const packed = await this.#positions.read(options),
      out = new Float32Array(this.graph.nodes * 3);
    for (let i = 0; i < this.graph.nodes; i++) out.set(packed.subarray(i * 4, i * 4 + 3), i * 3);
    return out;
  }
  /** Reads the last iteration's adaptive speed, swinging, traction and evaluated many-body interactions. */
  async diagnostics(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<{ speed: number; swinging: number; traction: number; interactions: number; totalMass: number }> {
    this.#check();
    const v = await this.#state.read(options);
    const root = new Float32Array(await this.gpu.readBytes(this.#tree.buffer, 0, 16, options.signal));
    return { speed: v[0], swinging: v[1], traction: v[2], interactions: v[3], totalMass: root[3] };
  }
  /** Yields after each completed iteration, so rendering and cancellation stay responsive. Default 300 iterations. */
  async *run(
    options: { readonly iterations?: number; readonly signal?: AbortSignal } = {},
  ): AsyncGenerator<GPUGraphWork> {
    const iterations = options.iterations ?? 300;
    if (!Number.isInteger(iterations) || iterations < 0) throw invalid('Run iterations must be a nonnegative integer');
    for (let i = 0; i < iterations; i++) {
      options.signal?.throwIfAborted();
      this.step();
      await this.gpu.done(options);
      yield this.work;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  /** Frees only this layout's resources. Layers using it must be disposed first. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const a of this.#arrays) a.dispose();
    for (const p of this.#programs.values()) p.dispose();
  }
  /** Same as dispose(). */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
