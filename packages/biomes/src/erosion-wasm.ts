/// <reference lib="esnext.disposable" preserve="true" />
import { fault, wasmError } from '../../shared/errors.js';
import type { HeightGrid } from './hydrology.js';
import type { Erosion, ErosionOptions } from './erosion.js';
import { erosionSettings } from './erosion-settings.js';

/** Loading options for the feature-local SIMD Wasm kernel. */
export interface ErosionKernelOptions {
  /** Abort loading; rejects with the signal's reason. Default undefined. */
  signal?: AbortSignal;
}
/** Settings of a synchronous erosion call. */
export interface WasmErosionOptions extends ErosionOptions {
  /** Checked before work. Use a worker to interrupt a call in flight. Default undefined. */
  signal?: AbortSignal;
}
/** Owned output with deterministic work and memory diagnostics, not elapsed-time measurements. */
export interface WasmErosion extends Erosion {
  /** Wasm linear-memory high water, including allocator overhead and retained free pages. */
  readonly memoryBytes: number;
  /** Four-cell SIMD blocks in the final wear/deposit pass. */
  readonly vectorBlocks: number;
}
interface Kernel {
  memory: WebAssembly.Memory;
  allocate(n: number): number;
  free_input(pointer: number, n: number): void;
  erode(
    input: number,
    nx: number,
    nz: number,
    step: bigint,
    rounds: number,
    thermal: bigint,
    straight: bigint,
    diagonal: bigint,
    capacity: bigint,
    incision: bigint,
    deposition: bigint,
    sea: number,
  ): number;
  result_array(result: number, field: number): number;
  result_outflow(result: number): number;
  result_vector_blocks(result: number): number;
  free_result(result: number): void;
}
/** One lazy Wasm instance; returned arrays never alias its memory. */
export interface ErosionKernel {
  /** Erode 2x2 through 4,194,304 cells, with exactly the integer CPU result. Does not mutate input. */
  erode(grid: HeightGrid, options?: WasmErosionOptions): WasmErosion;
  /** Release the instance and its high-water memory. Idempotent; outputs remain valid. */
  dispose(): void;
  [Symbol.dispose](): void;
}
class Eroder implements ErosionKernel {
  constructor(private kernel: Kernel | undefined) {}
  erode(grid: HeightGrid, options: WasmErosionOptions = {}): WasmErosion {
    const k = this.kernel;
    if (!k) throw fault('disposed', 'ErosionKernel is disposed; create a new kernel', 'biomes');
    options?.signal?.throwIfAborted();
    const { height, nx, nz, step } = grid,
      { iterations, thermal, straight, diagonal, rates, sea } = settings(grid, options),
      n = nx * nz,
      input = k.allocate(n);
    if (!input) throw fault('failed', 'Erosion input allocation failed', 'biomes');
    let result = 0;
    try {
      new Int32Array(k.memory.buffer, input, n).set(height);
      result = k.erode(
        input,
        nx,
        nz,
        BigInt(step),
        iterations,
        BigInt(thermal),
        BigInt(straight),
        BigInt(diagonal),
        BigInt(rates[0]),
        BigInt(rates[1]),
        BigInt(rates[2]),
        sea ?? NaN,
      );
      if (!result) throw fault('failed', 'Erosion kernel rejected validated input', 'biomes');
      // Re-read memory.buffer after the call: allocation can grow memory and detach older views.
      const ints = (field: number) => new Int32Array(new Int32Array(k.memory.buffer, k.result_array(result, field), n));
      return {
        height: ints(0),
        flow: ints(1),
        direction: new Int8Array(new Int8Array(k.memory.buffer, k.result_array(result, 2), n)),
        wear: ints(3),
        deposit: ints(4),
        outflow: k.result_outflow(result),
        nx,
        nz,
        step,
        memoryBytes: k.memory.buffer.byteLength,
        vectorBlocks: k.result_vector_blocks(result),
      };
    } catch (error) {
      throw wasmError(error);
    } finally {
      if (result) k.free_result(result);
      k.free_input(input, n);
    }
  }
  dispose(): void {
    this.kernel = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
function settings(grid: HeightGrid, options: WasmErosionOptions) {
  try {
    return erosionSettings(grid, options, 4194304);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw Object.assign(error, { code: 'failed' });
    throw error;
  }
}
/** Load only this feature's Rust/SIMD module. Works without WebGPU, including WebGL2 and Node. */
export async function createErosionKernel({ signal }: ErosionKernelOptions = {}): Promise<ErosionKernel> {
  signal?.throwIfAborted();
  try {
    const url = new URL(/* @vite-ignore */ './erosion.wasm?no-inline', import.meta.url);
    let bytes: ArrayBuffer;
    if (url.protocol === 'file:') {
      url.search = '';
      const name = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
      const data: Uint8Array<ArrayBuffer> = await readFile(url, { signal });
      bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok) throw fault('failed', `Erosion Wasm fetch returned HTTP ${response.status}`, 'biomes');
      bytes = await response.arrayBuffer();
    }
    const { instance } = await WebAssembly.instantiate(bytes);
    signal?.throwIfAborted();
    return new Eroder(instance.exports as unknown as Kernel);
  } catch (error) {
    signal?.throwIfAborted();
    const translated = wasmError(error);
    if (translated !== error || (error instanceof Error && error.name === 'MargoError')) throw translated;
    throw Object.assign(fault('failed', 'Erosion Wasm could not load; serve valid SIMD package assets', 'biomes'), {
      cause: error,
    });
  }
}
