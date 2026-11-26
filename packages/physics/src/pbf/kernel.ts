import { MargoError } from '@margoengine/math/errors';
import { STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface PbfKernel {
  solve_pbf(
    particles: number,
    count: number,
    workspace: number,
    buckets: number,
    bucketCount: number,
    next: number,
    used: number,
    boundaries: number,
    boundaryCount: number,
    shapes: number,
    shapeCount: number,
    impulses: number,
    pressureImpulses: number,
    bodyCount: number,
    settings: number,
    stats: number,
    dt: number,
  ): number;
}

export async function loadPbfKernel(memory: WebAssembly.Memory, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  const shared = typeof SharedArrayBuffer !== 'undefined' && memory.buffer instanceof SharedArrayBuffer;
  const url = shared
    ? new URL(/* @vite-ignore */ './pbf-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './pbf-kernel.wasm?no-inline', import.meta.url);
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ fs);
      const module = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return module;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw new MargoError(
        'failed',
        'PBF Wasm could not load. Use a server that serves the native asset next to its package entry.',
      );
    const module =
      response.headers.get('content-type')?.split(';')[0] === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(new MargoError('failed', 'Use a SIMD runtime and serve the optional PBF Wasm.'), { cause });
  }
}

export function bindPbfKernel(
  host: SolverHost,
  module: WebAssembly.Module,
  sourceMemory: WebAssembly.Memory,
): PbfKernel {
  if (host.memory !== sourceMemory)
    throw new MargoError(
      'state',
      'The PBF kernel was loaded for another world. Pass the destination world memory to load.',
    );
  const stack = host.allocate('pbf-stack', STACK_BYTES, 'u8', 1);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  if (!(exports.__stack_pointer instanceof WebAssembly.Global) || typeof exports.solve_pbf !== 'function')
    throw new MargoError(
      'failed',
      'PBF Wasm lacks the stack or solver export. Use the native assets from this package release.',
    );
  exports.__stack_pointer.value = stack.byteOffset + stack.byteLength;
  return exports as unknown as PbfKernel;
}
