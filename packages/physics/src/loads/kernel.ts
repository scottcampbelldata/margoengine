import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

/**
 * f64 words of each packed row: row and mass, force xyz, torque xyz, 3×3 added translation and rotation, then
 * dry inverse inertia in world axes [xx, xy, xz, yy, yz, zz]. Both added matrices are row-major.
 */
export const LOADS_KERNEL_WORDS = 32;

export interface LoadsBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export interface LoadsKernel {
  /** Adds held wrenches into the selected output rows. Success is 0, invalid arguments -1, bad row index + 1. */
  loads_hold(scratch: number, count: number, forceRegion: number, forceRows: number, gravity: number): number;
}

export async function loadLoadsBuilds(signal?: AbortSignal): Promise<LoadsBuilds> {
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './loads-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './loads-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  return { plain, shared };
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    let module: WebAssembly.Module;
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      module = await WebAssembly.compile(await readFile(url, { signal }));
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw new MargoError(
          'failed',
          `Loads Wasm request returned HTTP ${response.status}; serve the loads kernel asset.`,
        );
      module =
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
          ? await WebAssembly.compileStreaming(response)
          : await WebAssembly.compile(await response.arrayBuffer());
    }
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError('failed', 'Loads Wasm failed to load; use a SIMD runtime and serve the optional loads kernel.'),
      { cause },
    );
  }
}

export function bindLoadsKernel(host: SolverHost, builds: LoadsBuilds): LoadsKernel {
  const shared = typeof SharedArrayBuffer !== 'undefined' && host.memory.buffer instanceof SharedArrayBuffer;
  const module = shared ? builds.shared : builds.plain;
  if (!module)
    throw new MargoError(
      'unsupported',
      'The shared loads kernel is unavailable; use the matching shared build or a plain world.',
    );
  const stack = host.allocate('loads-kernel-stack', STACK_BYTES + 8, 'u8', 1);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  if (!(exports.__stack_pointer instanceof WebAssembly.Global) || typeof exports.loads_hold !== 'function')
    throw new MargoError('failed', 'The loads kernel ABI is invalid; rebuild the optional Wasm assets.');
  exports.__stack_pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
  return exports as unknown as LoadsKernel;
}
