import { MargoError } from '@margoengine/math/errors';
import { STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface WireKernel {
  rail_wire_step(
    position: number,
    velocity: number,
    force: number,
    nodes: number,
    intervals: number,
    tensionPerMassSpacingSquared: number,
    inverseMass: number,
    damping: number,
    dt: number,
  ): void;
}

export async function loadWireKernel(memory: WebAssembly.Memory, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  const shared = typeof SharedArrayBuffer !== 'undefined' && memory.buffer instanceof SharedArrayBuffer;
  const url = shared
    ? new URL(/* @vite-ignore */ './rail-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './rail-kernel.wasm?no-inline', import.meta.url);
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
    if (!response.ok) throw new MargoError('failed', 'Serve the optional railway solver Wasm from its package URL.');
    const module =
      response.headers.get('content-type')?.split(';')[0] === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(new MargoError('failed', 'Use a SIMD runtime and serve the optional railway solver Wasm.'), {
      cause,
    });
  }
}

export function bindWireKernel(host: SolverHost, module: WebAssembly.Module): WireKernel {
  const stack = host.allocate('rail-stack', STACK_BYTES, 'u8', 1);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError('failed', 'Build the railway solver Wasm with its exported stack pointer.');
  pointer.value = stack.byteOffset + stack.byteLength;
  return exports as unknown as WireKernel;
}
