/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { NavMesh } from './index.js';
import type { NavigationOptions } from './build.js';
import type { TiledNavMesh, TiledNavMeshOptions } from './tiles.js';

/** Loading and execution controls for one dedicated build worker. */
export interface NavBuildWorkerOptions {
  /** Cancels loading and terminates an in-flight build. Default no signal. */
  signal?: AbortSignal;
  /** Hard limit including startup and loading, in milliseconds. Default 60000, 1..2147483647. */
  timeout?: number;
  /** Override hosting of the feature-local worker script. Default package workers/navmesh-build.js. */
  workerURL?: URL;
  /** Override hosting of the feature-local SIMD kernel. Default package navmesh-raster.wasm. */
  wasmURL?: URL;
}

/** Deterministic work and memory counts from the raster kernel, aggregated across tiles. */
export interface NavBuildWork {
  /** Triangle/cell clipping candidates, identical to the TypeScript rasterizer. */
  cells: number;
  /** Clipped edge intersections, identical to the TypeScript rasterizer. */
  intersections: number;
  /** Two-lane f64 SIMD interpolation pairs, one per intersection. */
  vectorPairs: number;
  /** Batched kernel calls, one for a nonempty tile or whole-mesh build. */
  rasterCalls: number;
  /** Highest Wasm linear-memory byte length observed in this build. */
  memoryBytes: number;
}

/** A ready mesh and the measured work that built it. */
export interface NavWorkerResult<T extends NavMesh | TiledNavMesh> {
  /** Ordinary mesh, with the same polygons and capabilities as the TypeScript builder's result. */
  mesh: T;
  /** CPU work counters; no elapsed-time speed claim. */
  work: NavBuildWork;
}

const fault = (code: 'failed' | 'unsupported' | 'timeout', message: string) =>
  new MargoError(code, `${message}. Help: https://margoengine.com/docs/navmesh`);

async function wasmBytes(url: URL, signal: AbortSignal): Promise<ArrayBuffer> {
  if (url.protocol === 'file:') {
    const path = new URL(url);
    path.search = '';
    const specifier = 'node:fs/promises',
      fs: { readFile(path: URL, options: { signal: AbortSignal }): Promise<Uint8Array<ArrayBuffer>> } = await import(
        /* @vite-ignore */ /* webpackIgnore: true */ specifier
      );
    const bytes = await fs.readFile(path, { signal });
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw fault('failed', `Navmesh Wasm fetch returned HTTP ${response.status}; serve the package assets`);
  return response.arrayBuffer();
}

async function build(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  options: NavigationOptions | TiledNavMeshOptions,
  controls: NavBuildWorkerOptions,
  tiled: boolean,
): Promise<{ bytes: Uint8Array; work: NavBuildWork }> {
  const { signal, timeout = 60000 } = controls;
  signal?.throwIfAborted();
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647)
    throw new RangeError('Build timeout must be an integer from 1 to 2147483647 ms; choose a bounded deadline.');
  if (typeof globalThis.Worker !== 'function')
    throw fault('unsupported', 'Navmesh worker builds need Web Workers; provide a browser Worker host');
  const abort = new AbortController(),
    onAbort = () => abort.abort(signal!.reason),
    timer = setTimeout(
      () => abort.abort(fault('timeout', 'Navmesh worker build exceeded timeout; reduce the level or raise timeout')),
      timeout,
    );
  signal?.addEventListener('abort', onAbort, { once: true });
  let worker: Worker | undefined;
  try {
    const wasm = await wasmBytes(
      controls.wasmURL ?? new URL(/* @vite-ignore */ './navmesh-raster.wasm?no-inline', import.meta.url),
      abort.signal,
    );
    abort.signal.throwIfAborted();
    const points = Float64Array.from(positions),
      triangles = Float64Array.from(indices);
    worker = new Worker(
      controls.workerURL ?? new URL(/* @vite-ignore */ './workers/navmesh-build.js?no-inline', import.meta.url),
      { name: 'margoengine-navmesh-build' },
    );
    const port = worker;
    return await new Promise((resolve, reject) => {
      const cancelled = () => reject(abort.signal.reason);
      abort.signal.addEventListener('abort', cancelled, { once: true });
      const finish = (error?: unknown, result?: { bytes: Uint8Array; work: NavBuildWork }) => {
        abort.signal.removeEventListener('abort', cancelled);
        if (result) resolve(result);
        else reject(error);
      };
      port.onerror = (event) => {
        event.preventDefault?.();
        finish(fault('failed', `Navmesh worker failed: ${event.message}; check worker hosting`));
      };
      port.onmessageerror = () =>
        finish(fault('failed', 'Navmesh worker reply could not be deserialized; check worker hosting'));
      port.onmessage = ({ data }) => {
        if (data?.error) {
          const e = data.error,
            error =
              e.name === 'RangeError'
                ? new RangeError(e.message)
                : e.name === 'TypeError'
                  ? new TypeError(e.message)
                  : new MargoError(e.code ?? 'failed', e.message);
          finish(error);
        } else if (data?.bytes instanceof Uint8Array && data?.work) finish(undefined, data);
        else finish(fault('failed', 'Navmesh worker returned an invalid result; rebuild matching package assets'));
      };
      try {
        port.postMessage({ positions: points, indices: triangles, options, tiled, wasm }, [
          points.buffer,
          triangles.buffer,
          wasm,
        ]);
      } catch (error) {
        finish(error);
      }
      if (abort.signal.aborted) cancelled();
    });
  } catch (error) {
    abort.signal.throwIfAborted();
    if (error instanceof MargoError || error instanceof RangeError || error instanceof TypeError) throw error;
    throw Object.assign(
      fault('failed', 'Navmesh worker could not load or execute; serve valid matching package assets'),
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
    }
  }
}

/**
 * Builds off the calling thread with the feature-local Rust SIMD rasterizer and the normal polygon pipeline.
 * Inputs are copied, never detached. The worker is terminated after success, error, abort or timeout.
 * @throws RangeError for invalid geometry/options/deadline; MargoError for unsupported workers, loading or build failure; use valid geometry and serve package assets.
 */
export async function buildNavMeshInWorker(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  options: NavigationOptions = {},
  controls: NavBuildWorkerOptions = {},
): Promise<NavWorkerResult<NavMesh>> {
  const result = await build(positions, indices, options, controls, false),
    { decodeNavMesh } = await import('./codec.js');
  controls.signal?.throwIfAborted();
  return { mesh: decodeNavMesh(result.bytes), work: result.work };
}

/**
 * Builds tiled polygons off-thread with identical tile geometry and a retained level for normal runtime rebuilds.
 * Subsequent mesh.update() uses ./tiles; call this function again for a new off-thread whole-level build.
 * @throws RangeError for invalid geometry/options/deadline; MargoError for unsupported workers, loading or build failure; use valid geometry and serve package assets.
 */
export async function buildTiledNavMeshInWorker(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  options: TiledNavMeshOptions = {},
  controls: NavBuildWorkerOptions = {},
): Promise<NavWorkerResult<TiledNavMesh>> {
  const result = await build(positions, indices, options, controls, true),
    { decodeTiledNavMesh } = await import('./codec.js');
  controls.signal?.throwIfAborted();
  return { mesh: decodeTiledNavMesh(result.bytes), work: result.work };
}
