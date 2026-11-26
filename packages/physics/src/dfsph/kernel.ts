import type { SolverHost } from '../world/solver.js';
import { bindLiquidKernel, loadLiquidKernel } from '../pbf/kernel.js';

export async function loadDfsphKernel(memory: WebAssembly.Memory, signal?: AbortSignal): Promise<WebAssembly.Module> {
  const shared = typeof SharedArrayBuffer !== 'undefined' && memory.buffer instanceof SharedArrayBuffer;
  const url = shared
    ? new URL(/* @vite-ignore */ './dfsph-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './dfsph-kernel.wasm?no-inline', import.meta.url);
  return loadLiquidKernel(url, 'DFSPH', signal);
}

export function bindDfsphKernel(host: SolverHost, module: WebAssembly.Module, memory: WebAssembly.Memory) {
  return bindLiquidKernel(host, module, memory, 'dfsph');
}
