import { MargoError } from '@margoengine/math/errors';
import type { Region, SolverHost } from '../world/solver.js';

// Static data, a per-instance downward-growing stack and a step-local heap occupy one arena lease.
const STATIC_BYTES = 4096;
const STACK_BYTES = 65536;
const ALIGNMENT = 16;

type KernelExports = WebAssembly.Exports & {
  __wasm_apply_data_relocs?(): void;
  school_intent(
    bodies: number,
    count: number,
    predators: number,
    predatorCount: number,
    output: number,
    repulsion: number,
    orientation: number,
    attraction: number,
    vision: number,
    neighbours: number,
    threat: number,
    prediction: number,
  ): number;
};

export async function loadSchoolKernel(signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  const url = new URL(/* @vite-ignore */ './school-kernel.wasm?no-inline', import.meta.url);
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const nodeFs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ nodeFs);
      const module = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return module;
    }
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('School Wasm HTTP ' + response.status);
    const module = await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    throw Object.assign(
      new MargoError('failed', 'School kernel failed to load. Use Wasm SIMD and serve the school-kernel.wasm asset.'),
      { cause },
    );
  }
}

export function schoolKernel(
  module: WebAssembly.Module,
  host: SolverHost,
  memberCount: number,
): KernelExports['school_intent'] {
  // Geometric Vec growth leaves less than four items allocated per live item in each growing
  // buffer. A point is 12 B, two key–id pairs 64 B, a key 16 B, two counters 8 B and a ranking
  // entry 16 B. 512 B/member also covers reserve rounding and alignment inside the kernel.
  const bytes = STATIC_BYTES + STACK_BYTES + ALIGNMENT + 512 * memberCount;
  const lease: Region = host.allocate('school-kernel-scratch', bytes, 'u8', 1);
  const base = Math.ceil(lease.byteOffset / ALIGNMENT) * ALIGNMENT;
  const stackTop = base + STATIC_BYTES + STACK_BYTES;
  const limit = lease.byteOffset + lease.byteLength;
  const stack = new WebAssembly.Global({ value: 'i32', mutable: true }, stackTop);
  let cursor = stackTop;

  const instance = new WebAssembly.Instance(module, {
    env: {
      memory: host.memory,
      __memory_base: base,
      __table_base: 0,
      __stack_pointer: stack,
      school_alloc: (size: number, alignment: number) => {
        const offset = Math.ceil(cursor / alignment) * alignment;
        const end = offset + (size >>> 0);
        if (end > limit) throw new MargoError('state', 'School kernel exceeded its neighbour scratch lease.');
        cursor = end;
        return offset;
      },
    },
  });
  const kernel = instance.exports as KernelExports;
  kernel.__wasm_apply_data_relocs?.();
  return (...args) => {
    cursor = stackTop;
    stack.value = stackTop;
    return kernel.school_intent(...args);
  };
}
