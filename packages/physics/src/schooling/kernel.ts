import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';

// A per-instance downward-growing stack and a step-local workspace occupy one arena lease.
const ALIGNMENT = 16;

type KernelExports = WebAssembly.Exports & {
  __stack_pointer: WebAssembly.Global;
  school_intent(
    bodies: number,
    count: number,
    medium: number,
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

export interface SchoolKernelBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export async function loadSchoolKernel(signal?: AbortSignal): Promise<SchoolKernelBuilds> {
  signal?.throwIfAborted();
  const plainUrl = new URL(/* @vite-ignore */ './school-kernel.wasm?no-inline', import.meta.url);
  const [plain, shared] = await Promise.all([
    compile(plainUrl, signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './school-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  return { plain, shared };
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
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
    if (!response.ok)
      throw new MargoError('failed', 'School Wasm request returned HTTP ' + response.status + '. Check the asset URL.');
    const module = await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError('failed', 'School kernel failed to load. Use Wasm SIMD and serve the school-kernel.wasm asset.'),
      { cause },
    );
  }
}

export function schoolKernel(
  builds: SchoolKernelBuilds,
  host: SolverHost,
  memberCount: number,
): KernelExports['school_intent'] {
  // Geometric Vec growth leaves less than four items allocated per live item in each growing
  // buffer. A point is 12 B, two key–id pairs 64 B, a key 16 B, two counters 8 B and a ranking
  // entry 16 B. 512 B/member also covers reserve rounding and alignment inside the kernel.
  const module = isShared(host.memory) ? builds.shared : builds.plain;
  if (!module)
    throw new MargoError(
      'unsupported',
      'The shared school kernel is unavailable. Use plain world memory on this host.',
    );
  const bytes = STACK_BYTES + ALIGNMENT + 512 * memberCount;
  const lease: Region = host.allocate('school-kernel-scratch', bytes, 'u8', 1);
  const base = Math.ceil(lease.byteOffset / ALIGNMENT) * ALIGNMENT;
  const stackTop = base + STACK_BYTES;
  const limit = lease.byteOffset + lease.byteLength;
  let cursor = stackTop;

  const instance = new WebAssembly.Instance(module, {
    env: {
      memory: host.memory,
      school_alloc: (size: number, alignment: number) => {
        const offset = Math.ceil(cursor / alignment) * alignment;
        const end = offset + (size >>> 0);
        if (end > limit)
          throw new MargoError(
            'state',
            'School kernel exceeded its scratch region. Run the schooling package build to install matching JavaScript and Wasm.',
          );
        cursor = end;
        return offset;
      },
    },
  });
  const kernel = instance.exports as KernelExports;
  const stack = kernel.__stack_pointer;
  if (!(stack instanceof WebAssembly.Global))
    throw new MargoError('failed', 'The school kernel has no stack pointer. Run the schooling package build.');
  return (...args) => {
    cursor = stackTop;
    stack.value = stackTop;
    return kernel.school_intent(...args);
  };
}
