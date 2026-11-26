import { MargoError } from '@margoengine/math/errors';

import { canShareMemory, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface ThermalKernelBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

/** Compiles the thermal builds this runtime can instantiate. Loading remains independent of the world. */
export async function loadThermalKernel(signal?: AbortSignal): Promise<ThermalKernelBuilds> {
  signal?.throwIfAborted();
  const plainUrl = new URL(/* @vite-ignore */ './thermal-kernel.wasm?no-inline', import.meta.url);
  const [plain, shared] = await Promise.all([
    compileThermalAsset(plainUrl, signal),
    canShareMemory()
      ? compileThermalAsset(
          new URL(/* @vite-ignore */ './thermal-kernel-shared.wasm?no-inline', import.meta.url),
          signal,
        )
      : undefined,
  ]);
  return { plain, shared };
}

/** Binds the matching compiled build and gives the instance a stack in the host's arena. */
export function instantiateThermalKernel(host: SolverHost, builds: ThermalKernelBuilds): WebAssembly.Exports {
  const shared = typeof SharedArrayBuffer !== 'undefined' && host.memory.buffer instanceof SharedArrayBuffer;
  const module = shared ? builds.shared : builds.plain;
  if (!module)
    throw new MargoError(
      'unsupported',
      'The shared thermal kernel is unavailable. Use plain world memory on this host.',
    );
  const stack = host.allocate('thermal-kernel-stack', STACK_BYTES, 'u8', 1);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError(
      'failed',
      'The thermal kernel has no stack pointer. Run the thermal kernel build to restore its Wasm assets.',
    );
  pointer.value = stack.byteOffset + stack.byteLength;
  return exports;
}

async function compileThermalAsset(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const nodeFs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ nodeFs);
      const bytes = await readFile(url, { signal });
      signal?.throwIfAborted();
      const module = await WebAssembly.compile(bytes);
      signal?.throwIfAborted();
      return module;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw new MargoError(
        'failed',
        'Thermal kernel request returned HTTP ' + response.status + '; serve the thermal Wasm asset.',
      );
    const module =
      response.headers.get('content-type')?.trim().toLowerCase() === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError(
        'failed',
        'Thermal Wasm failed to load; use a SIMD-capable runtime and serve the thermal Wasm asset.',
      ),
      { cause },
    );
  }
}
