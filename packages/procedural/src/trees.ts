import { fault } from '../../shared/errors.js';
import { loadKernel } from './wasm.js';

/** Bounded space-colonisation skeleton settings, in metres. */
export interface TreeOptions {
  /** XYZ triples, finite coordinates within +/-1e6, at most 8192 points. Empty means root only. Default seeded crown. */
  attractionPoints?: Float64Array;
  /** Root XYZ, each finite and within +/-1e6. Default [0, 0, 0]. */
  root?: readonly [number, number, number];
  /** Default crown point count, 1..8192; ignored with custom points. Default 512. */
  attractionCount?: number;
  /** Unsigned 32-bit seed; zero uses seed one's stream. Default 1. */
  seed?: number;
  /** Segment length, 0.0001..10000. Default 0.2. */
  segmentLength?: number;
  /** Maximum attraction distance, 0.0001..1e6. Default 3. */
  influenceRadius?: number;
  /** Consume points within this radius, segmentLength/2..influenceRadius. Default 0.3. */
  killRadius?: number;
  /** Node cap including root, 1..16384. Default 2048. */
  maxNodes?: number;
  /** Growth round cap, 1..512. Default 128. */
  maxIterations?: number;
  /** Checked before synchronous generation; use a worker for interruption in flight. */
  signal?: AbortSignal;
}
/** Caller-owned skeleton and reproducibility data. */
export interface TreeSkeleton {
  /** Packed XYZ positions in insertion order, root first. */
  positions: Float64Array;
  /** One parent per node: root -1, every other parent precedes its child. */
  parents: Int32Array;
  /** Input attraction cloud, including points consumed during growth. */
  attractionPoints: Float64Array;
  /** Number of points not reached, including points outside all influence radii. */
  remainingAttractions: number;
  /** Number of growth rounds performed. */
  iterations: number;
  /** Exact nearest-node squared-distance tests, including final consumption. */
  distanceTests: number;
  /** Complete consumes all points; stalled includes balanced or unreachable points. */
  stopped: 'complete' | 'stalled' | 'maxNodes' | 'maxIterations';
}
interface Kernel {
  memory: WebAssembly.Memory;
  allocate(length: number): number;
  generate(
    pointer: number,
    count: number,
    defaultCount: number,
    seed: number,
    x: number,
    y: number,
    z: number,
    segment: number,
    influence: number,
    kill: number,
    maxNodes: number,
    maxIterations: number,
  ): number;
  release(pointer: number, length: number): void;
}
const invalid = () =>
  fault(
    'failed',
    'Invalid tree settings; use finite bounded coordinates and radii, uint32 seed, and attractionCount * maxNodes * maxIterations <= 134217728',
    'procedural',
  );
const integer = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
const finite = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
/** Lifecycle of a lazy Rust/Wasm branching skeleton generator. */
export interface TreeGenerator {
  /** Grow towards the closest influence points, with stable lowest-index distance ties. */
  generate(options?: TreeOptions): TreeSkeleton;
  /** Release the instance; existing outputs remain usable. */
  dispose(): void;
  [Symbol.dispose](): void;
}
class Generator implements TreeGenerator {
  private kernel: Kernel | undefined;
  constructor(kernel: Kernel) {
    this.kernel = kernel;
  }
  generate(options: TreeOptions = {}): TreeSkeleton {
    const kernel = this.kernel;
    if (!kernel) throw fault('disposed', 'TreeGenerator is disposed; create a new generator', 'procedural');
    options?.signal?.throwIfAborted();
    const points = options?.attractionPoints,
      root = options?.root ?? [0, 0, 0],
      count = options?.attractionCount ?? 512,
      seed = options?.seed ?? 1,
      segment = options?.segmentLength ?? 0.2,
      influence = options?.influenceRadius ?? 3,
      kill = options?.killRadius ?? 0.3,
      maximum = options?.maxNodes ?? 2048,
      iterations = options?.maxIterations ?? 128;
    if (
      !integer(seed, 0, 0xffffffff) ||
      !integer(maximum, 1, 16384) ||
      !integer(iterations, 1, 512) ||
      !finite(segment, 0.0001, 10000) ||
      !finite(influence, 0.0001, 1e6) ||
      !finite(kill, segment / 2, influence) ||
      !Array.isArray(root) ||
      root.length !== 3 ||
      !root.every((v) => finite(v, -1e6, 1e6)) ||
      (points !== undefined &&
        (!(points instanceof Float64Array) || points.length % 3 !== 0 || points.length > 8192 * 3)) ||
      (points === undefined && !integer(count, 1, 8192))
    )
      throw invalid();
    const pointCount = points === undefined ? count : points.length / 3;
    if (pointCount * maximum * iterations > 134217728 || (points && !points.every((v) => finite(v, -1e6, 1e6))))
      throw invalid();
    const inputLength = points?.length ?? 0,
      input = kernel.allocate(inputLength);
    let pointer: number;
    try {
      if (points) new Float64Array(kernel.memory.buffer, input, inputLength).set(points);
      pointer = kernel.generate(
        input,
        points?.length ? pointCount : 0,
        points === undefined ? count : 0,
        seed,
        root[0],
        root[1],
        root[2],
        segment,
        influence,
        kill,
        maximum,
        iterations,
      );
    } finally {
      kernel.release(input, inputLength);
    }
    const header = new Float64Array(kernel.memory.buffer, pointer, 7),
      length = header[0],
      nodes = header[1],
      remainingAttractions = header[2],
      rounds = header[3],
      distanceTests = header[4],
      reason = header[5];
    try {
      if (!nodes) throw invalid();
      const data = new Float64Array(kernel.memory.buffer, pointer, length);
      return {
        positions: data.slice(7, 7 + nodes * 3),
        parents: Int32Array.from(data.subarray(7 + nodes * 3, 7 + nodes * 4)),
        attractionPoints: data.slice(7 + nodes * 4),
        remainingAttractions,
        iterations: rounds,
        distanceTests,
        stopped: (['complete', 'stalled', 'maxNodes', 'maxIterations'] as const)[reason - 1],
      };
    } finally {
      kernel.release(pointer, length);
    }
  }
  dispose(): void {
    this.kernel = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Load the feature-local Wasm asset. No GPU context or side effect on import. */
export async function createTreeGenerator(options: { signal?: AbortSignal } = {}): Promise<TreeGenerator> {
  const url = new URL(/* @vite-ignore */ './trees.wasm?no-inline', import.meta.url);
  return new Generator(await loadKernel<Kernel>(url, 'Trees', options.signal));
}
