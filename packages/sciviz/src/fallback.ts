// Optional CPU extraction for the WebGL2 path. No renderer, global patch or Wasm load on import.
import { fault, rangeError, wasmError } from '../../shared/errors.js';
import { cubeTables } from './cubes.js';

/** Options for CPU marching cubes, using the same cases and vertex layout as the WebGPU extractor. */
export interface CpuIsosurfaceOptions {
  /** Samples along x, y and z, x fastest. Each dimension must be at least two. */
  readonly dims: readonly [number, number, number];
  /** Maximum output triangles, checked before allocating vertices. Default floor(128 MiB / 96). */
  readonly maxTriangles?: number;
  /** Cancels loading and extraction, including between bounded chunks of CPU work. */
  readonly signal?: AbortSignal;
}

/** Caller-owned output, independent of the Wasm instance and the input array. */
export interface CpuIsosurface {
  /** Position xyzw, then outward gradient xyzw. Positions span [0, 1]; w is 1 for positions, 0 for gradients. */
  readonly vertices: Float32Array;
  /** Number of triangles (three vertices, 96 bytes per triangle). */
  readonly triangles: number;
}

interface Kernel {
  memory: WebAssembly.Memory;
  allocate(words: number): number;
  release(pointer: number, words: number): void;
  classify(
    field: number,
    counts: number,
    cases: number,
    nx: number,
    ny: number,
    nz: number,
    level: number,
    start: number,
    end: number,
  ): number;
  generate(
    field: number,
    counts: number,
    edges: number,
    cases: number,
    output: number,
    nx: number,
    ny: number,
    nz: number,
    stride: number,
    level: number,
    start: number,
    end: number,
    first: number,
  ): number;
}

const CHUNK = 16_384;
const MAX_WORDS = 0x1fffffff;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function load(signal?: AbortSignal): Promise<Kernel> {
  signal?.throwIfAborted();
  const url = new URL(/* @vite-ignore */ './fallback.wasm?no-inline', import.meta.url);
  try {
    let bytes: Uint8Array<ArrayBuffer>;
    if (url.protocol === 'file:') {
      url.search = '';
      const module = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ module);
      bytes = await readFile(url, { signal });
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw fault('failed', `Marching cubes Wasm HTTP ${response.status}; serve the package assets`, 'sciviz');
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    signal?.throwIfAborted();
    const { instance } = await WebAssembly.instantiate(bytes);
    signal?.throwIfAborted();
    return instance.exports as unknown as Kernel;
  } catch (error) {
    signal?.throwIfAborted();
    const translated = wasmError(error);
    if (translated !== error || (error instanceof Error && error.name === 'MargoError')) throw translated;
    throw Object.assign(fault('failed', 'Marching cubes Wasm could not load; serve valid package assets', 'sciviz'), {
      cause: error,
    });
  }
}

/**
 * Extract values strictly above `level`, with sciviz's derived marching-cubes cases, winding and gradients.
 * Rust/Wasm classifies four adjacent x cells with SIMD. Each call owns its instance; concurrent calls are isolated.
 * Work yields every 16,384 cells in both passes so aborts and rendering can run. No WebGPU device is requested.
 */
export async function marchingCubes(
  data: ArrayLike<number>,
  level: number,
  options: CpuIsosurfaceOptions,
): Promise<CpuIsosurface> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const dims = options?.dims;
  if (!dims || dims.length !== 3 || dims.some((n) => !Number.isInteger(n) || n < 2))
    throw rangeError('CPU isosurface dims need three integers of at least 2 samples', 'sciviz');
  const [nx, ny, nz] = dims;
  const samples = nx * ny * nz;
  const cells = (nx - 1) * (ny - 1) * (nz - 1);
  const max = options.maxTriangles ?? Math.floor((128 * 1024 * 1024) / 96);
  if (!Number.isSafeInteger(samples) || samples > MAX_WORDS || samples !== data?.length)
    throw rangeError(
      `CPU isosurface dims [${dims.join(', ')}] do not hold ${data?.length} values within the 2 GiB input limit`,
      'sciviz',
    );
  if (!Number.isFinite(level) || !Number.isFinite(Math.fround(level)))
    throw rangeError('CPU isosurface level must be finite in float32', 'sciviz');
  if (!Number.isInteger(max) || max < 0 || max > Math.floor(MAX_WORDS / 24))
    throw rangeError(
      `CPU isosurface maxTriangles must be an integer from 0 to ${Math.floor(MAX_WORDS / 24)}`,
      'sciviz',
    );
  const table = cubeTables();
  const inputWords = samples + cells + table.counts.length + table.edges.length;
  if (inputWords > MAX_WORDS)
    throw rangeError(
      'CPU isosurface input and cases exceed the 2 GiB working-memory limit; use a coarser grid',
      'sciviz',
    );
  const kernel = await load(signal);
  signal?.throwIfAborted();
  const buffers: [number, number][] = [];
  const allocate = (words: number) => {
    const pointer = kernel.allocate(words);
    buffers.push([pointer, words]);
    return pointer;
  };
  try {
    const field = allocate(samples);
    const counts = allocate(table.counts.length);
    const edges = allocate(table.edges.length);
    const cases = allocate(cells);
    // Growth invalidates memory views: take each after all allocations, and never retain one across a kernel call.
    new Float32Array(kernel.memory.buffer, field, samples).set(data);
    new Uint32Array(kernel.memory.buffer, counts, table.counts.length).set(table.counts);
    new Uint32Array(kernel.memory.buffer, edges, table.edges.length).set(table.edges);
    let triangles = 0;
    for (let start = 0; start < cells; start += CHUNK) {
      signal?.throwIfAborted();
      triangles += kernel.classify(field, counts, cases, nx, ny, nz, level, start, Math.min(cells, start + CHUNK));
      if (triangles > max)
        throw rangeError(
          `CPU isosurface exceeds maxTriangles ${max}; use a coarser grid or raise the output budget`,
          'sciviz',
        );
      await pause();
    }
    signal?.throwIfAborted();
    if (!triangles) return { triangles: 0, vertices: new Float32Array() };
    if (inputWords + triangles * 24 > MAX_WORDS)
      throw rangeError('CPU isosurface vertices exceed the 2 GiB working-memory limit; use a coarser grid', 'sciviz');
    const output = allocate(triangles * 24);
    let first = 0;
    for (let start = 0; start < cells; start += CHUNK) {
      signal?.throwIfAborted();
      first = kernel.generate(
        field,
        counts,
        edges,
        cases,
        output,
        nx,
        ny,
        nz,
        table.stride,
        level,
        start,
        Math.min(cells, start + CHUNK),
        first,
      );
      await pause();
    }
    signal?.throwIfAborted();
    return { triangles, vertices: new Float32Array(kernel.memory.buffer, output, triangles * 24).slice() };
  } catch (error) {
    throw wasmError(error);
  } finally {
    for (const [pointer, words] of buffers.reverse()) kernel.release(pointer, words);
  }
}
