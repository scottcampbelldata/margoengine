import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

interface KernelExports extends WebAssembly.Exports {
  __stack_pointer: WebAssembly.Global;
  falling_step(
    models: number,
    sections: number,
    air: number,
    state: number,
    next: number,
    count: number,
    dt: number,
  ): number;
}

export interface FallingBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  let bytes: BufferSource;
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      bytes = await readFile(url, { signal });
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw new MargoError(
          'failed',
          'Falling solver Wasm request failed. Provide its Wasm assets at the expected URL.',
        );
      bytes = await response.arrayBuffer();
    }
    const module = await WebAssembly.compile(bytes);
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError(
        'failed',
        'Falling solver Wasm failed to load. Use a SIMD-capable runtime and serve its kernel assets.',
      ),
      { cause },
    );
  }
}

export async function loadFallingBuilds(signal?: AbortSignal): Promise<FallingBuilds> {
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './falling-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './falling-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  return { plain, shared };
}

export function fallingStep(host: SolverHost, builds: FallingBuilds): KernelExports['falling_step'] {
  const module = isShared(host.memory) ? builds.shared : builds.plain;
  if (!module)
    throw new MargoError(
      'unsupported',
      'Shared falling solver Wasm is unavailable. Use plain world memory on this host.',
    );
  const stack = host.allocate('falling-kernel-stack', STACK_BYTES + 8, 'u8', 1);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  if (!(exports.__stack_pointer instanceof WebAssembly.Global) || typeof exports.falling_step !== 'function')
    throw new MargoError('version', 'Falling solver Wasm has incompatible exports. Run the falling kernel build.');
  exports.__stack_pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
  return exports.falling_step as KernelExports['falling_step'];
}
