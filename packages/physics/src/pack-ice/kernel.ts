import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface PackIceBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export interface PackIceKernel {
  pack_ice_step(
    state: number,
    forcing: number,
    count: number,
    vessels: number,
    vesselCount: number,
    settings: number,
    grid: number,
    gridCapacity: number,
    links: number,
    impulses: number,
    stats: number,
    dt: number,
  ): number;
}

export async function loadPackIceBuilds(signal?: AbortSignal): Promise<PackIceBuilds> {
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './pack-ice-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './pack-ice-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  return { plain, shared };
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const module = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ module);
      const wasm = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return wasm;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw new MargoError(
        'failed',
        `PackIce Wasm request returned HTTP ${response.status}; serve the pack-ice kernel asset.`,
      );
    const wasm =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return wasm;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError(
        'failed',
        'PackIce Wasm failed to load; use a SIMD runtime and serve the optional pack-ice kernel.',
      ),
      { cause },
    );
  }
}

export function bindPackIceKernel(host: SolverHost, builds: PackIceBuilds): PackIceKernel {
  const shared = typeof SharedArrayBuffer !== 'undefined' && host.memory.buffer instanceof SharedArrayBuffer;
  const wasm = shared ? builds.shared : builds.plain;
  if (!wasm)
    throw new MargoError('unsupported', 'The shared pack-ice kernel is unavailable; create a plain-memory world.');
  const stack = host.allocate('pack-ice-kernel-stack', STACK_BYTES, 'u8', 1);
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError('failed', 'The pack-ice kernel has no stack pointer; rebuild the optional Wasm assets.');
  pointer.value = stack.byteOffset + stack.byteLength;
  return exports as unknown as PackIceKernel;
}
