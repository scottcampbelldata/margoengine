import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface Builds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export interface NativeSoil {
  stamp(
    patch: number,
    areas: number,
    peak: number,
    change: number,
    dust: number,
    rim: number,
    pressure: number,
    heights: number,
    floor: number,
    floorGrid: number,
    budget: number,
    work: number,
    faces: number,
    nx: number,
    nz: number,
    dx: number,
    dz: number,
    originX: number,
    originZ: number,
  ): number;
  repose(
    areas: number,
    change: number,
    pressure: number,
    heights: number,
    faces: number,
    work: number,
    nx: number,
    nz: number,
    dx: number,
    dz: number,
  ): number;
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  if (url.protocol === 'file:') {
    url.search = '';
    const node = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ node);
    return WebAssembly.compile(await readFile(url, { signal }));
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new MargoError(
      'failed',
      `Terramechanics kernel returned HTTP ${response.status}. Use a host serving the optional Wasm assets.`,
    );
  return WebAssembly.compile(await response.arrayBuffer());
}

export async function loadSoil(signal?: AbortSignal): Promise<Builds> {
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './terramechanics-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './terramechanics-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  signal?.throwIfAborted();
  return { plain, shared };
}

export function bindSoil(host: SolverHost, builds: Builds): NativeSoil {
  const shared = typeof SharedArrayBuffer !== 'undefined' && host.memory.buffer instanceof SharedArrayBuffer;
  const module = shared ? builds.shared : builds.plain;
  if (!module)
    throw new MargoError('unsupported', 'The shared soil kernel is unavailable. Create a plain-memory world.');
  const stack = host.allocate('soil-stack', STACK_BYTES, 'u8', 1);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  if (
    !(exports.__stack_pointer instanceof WebAssembly.Global) ||
    typeof exports.stamp !== 'function' ||
    typeof exports.repose !== 'function'
  )
    throw new MargoError('failed', 'Unexpected terramechanics kernel ABI. Run the build for both native variants.');
  exports.__stack_pointer.value = stack.byteOffset + stack.byteLength;
  return exports as unknown as NativeSoil;
}
