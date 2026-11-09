import { fault, wasmError } from '../../shared/errors.js';

/** Bounded dart-throwing settings; coordinates and spacing use the same units. */
export interface PoissonOptions {
  /** Minimum Euclidean separation, 0.000001..1000000. Required. */
  radius: number;
  /** Unsigned 32-bit seed; zero shares seed one's stream. Default 1. */
  seed?: number;
  /** Maximum returned points, 0..65536. Default 4096. */
  maxPoints?: number;
  /** Candidate budget, 0..2000000. Default 100000. A finite budget need not fill the surface. */
  attempts?: number;
  /** Checked before synchronous sampling; use a worker to interrupt work in flight. */
  signal?: AbortSignal;
}
/** Caller-owned coordinates, packed XY or XYZ, and deterministic work diagnostics. */
export interface PoissonSamples {
  /** Fresh float64 coordinates; no live view into Wasm memory. */
  positions: Float64Array;
  /** Coordinate stride, 2 for a rectangle and 3 for a triangle surface. */
  dimensions: 2 | 3;
  /** Candidates actually considered, before reaching the point limit or budget. */
  attempts: number;
  /** Squared-distance tests against accepted neighbours. */
  comparisons: number;
}
interface Kernel {
  memory: WebAssembly.Memory;
  allocate(length: number): number;
  release(pointer: number, length: number): void;
  sample(
    pointer: number,
    length: number,
    radius: number,
    seed: number,
    limit: number,
    budget: number,
    mode: number,
  ): number;
}
const invalid = () =>
  fault(
    'failed',
    'Poisson sampling requires finite coordinates within +/-1000000, valid bounds, triangle triples and documented option ranges',
    'procedural',
  );

/** Sampler lifecycle and coordinate-generation methods. */
export interface PoissonSampler {
  /** Generate XY coordinates inside [minX,minY,maxX,maxY]. */
  rectangle(bounds: readonly number[], options: PoissonOptions): PoissonSamples;
  /** Generate XYZ coordinates on a triangle soup, nine numbers per triangle. */
  surface(triangles: Float32Array | Float64Array, options: PoissonOptions): PoissonSamples;
  /** Release the Wasm instance. Returned coordinates remain usable. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/** A lazy Rust/Wasm sampler, independent of the rendering device. Dispose to release its instance. */
class Sampler implements PoissonSampler {
  private kernel: Kernel | undefined;
  /** @internal Use createPoissonSampler(). */
  constructor(kernel: Kernel) {
    this.kernel = kernel;
  }
  /** Rectangle [minX,minY,maxX,maxY], with strictly positive width and height. */
  rectangle(bounds: readonly number[], options: PoissonOptions): PoissonSamples {
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every((v) => typeof v === 'number')) throw invalid();
    return this.run(bounds, options, 0);
  }
  /** Triangle soup, nine numbers per triangle. Degenerate triangles carry no area; an empty surface returns no points. */
  surface(triangles: Float32Array | Float64Array, options: PoissonOptions): PoissonSamples {
    if (
      !(triangles instanceof Float32Array || triangles instanceof Float64Array) ||
      triangles.length % 9 ||
      triangles.length > 589824
    )
      throw invalid();
    return this.run(triangles, options, 1);
  }
  private run(data: ArrayLike<number>, options: PoissonOptions, mode: number): PoissonSamples {
    const kernel = this.kernel;
    if (!kernel) throw fault('disposed', 'PoissonSampler is disposed; create a new sampler', 'procedural');
    options?.signal?.throwIfAborted();
    const radius = options?.radius,
      seed = options?.seed ?? 1,
      limit = options?.maxPoints ?? 4096,
      budget = options?.attempts ?? 100000;
    if (
      !Number.isFinite(radius) ||
      radius < 1e-6 ||
      radius > 1e6 ||
      !Number.isInteger(seed) ||
      seed < 0 ||
      seed > 0xffffffff ||
      !Number.isInteger(limit) ||
      limit < 0 ||
      limit > 65536 ||
      !Number.isInteger(budget) ||
      budget < 0 ||
      budget > 2000000
    )
      throw invalid();
    const input = kernel.allocate(data.length);
    let output = 0,
      outputLength = 0;
    try {
      new Float64Array(kernel.memory.buffer, input, data.length).set(data);
      output = kernel.sample(input, data.length, radius, seed, limit, budget, mode);
      const header = new Float64Array(kernel.memory.buffer, output, 3);
      const count = header[0],
        attempts = header[1],
        comparisons = header[2];
      const dimensions = mode === 0 ? 2 : 3;
      outputLength = count < 0 ? 3 : 3 + count * dimensions;
      if (count < 0) throw invalid();
      return {
        positions: new Float64Array(kernel.memory.buffer, output + 24, count * dimensions).slice(),
        dimensions,
        attempts,
        comparisons,
      };
    } finally {
      if (output) kernel.release(output, outputLength);
      kernel.release(input, data.length);
    }
  }
  /** Idempotent; returned coordinate arrays remain usable. */
  dispose(): void {
    this.kernel = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Load one feature-local Wasm module only when requested. No rendering context is required. */
export async function createPoissonSampler(options: { signal?: AbortSignal } = {}): Promise<PoissonSampler> {
  options.signal?.throwIfAborted();
  const url = new URL(/* @vite-ignore */ './poisson.wasm?no-inline', import.meta.url);
  let bytes: ArrayBuffer;
  if (url.protocol === 'file:') {
    url.search = '';
    const nodeModule = 'node:fs/promises';
    const { readFile }: { readFile(path: URL, options: { signal?: AbortSignal }): Promise<Uint8Array<ArrayBuffer>> } =
      await import(/* @vite-ignore */ /* webpackIgnore: true */ nodeModule);
    const file = await readFile(url, { signal: options.signal });
    bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  } else {
    const response = await fetch(url, { signal: options.signal });
    if (!response.ok)
      throw fault(
        'failed',
        `Poisson Wasm fetch returned HTTP ${response.status}; serve the package assets`,
        'procedural',
      );
    bytes = await response.arrayBuffer();
  }
  let result: WebAssembly.WebAssemblyInstantiatedSource;
  try {
    result = await WebAssembly.instantiate(bytes);
  } catch (error) {
    throw wasmError(error);
  }
  options.signal?.throwIfAborted();
  return new Sampler(result.instance.exports as unknown as Kernel);
}
