import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface AcousticBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export interface AcousticKernel {
  underwater_trace(
    profile: number,
    profileWords: number,
    rays: number,
    rayCount: number,
    settings: number,
    dt: number,
    receipts: number,
  ): number;
  underwater_thread_phase(job: number, stage: number, part: number, parts: number): number;
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    signal?.throwIfAborted();
    let module: WebAssembly.Module;
    if (url.protocol === 'file:') {
      url.search = '';
      const source = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ source);
      module = await WebAssembly.compile(await readFile(url, { signal }));
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw new MargoError(
          'failed',
          `Underwater Wasm request returned HTTP ${response.status}. You must serve the acoustic kernel assets.`,
        );
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      module =
        type === 'application/wasm'
          ? await WebAssembly.compileStreaming(response)
          : await WebAssembly.compile(await response.arrayBuffer());
    }
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError(
        'failed',
        'Underwater Wasm could not load. Serve the acoustic kernels in a runtime with Wasm SIMD.',
      ),
      { cause },
    );
  }
}

export async function loadAcousticBuilds(signal?: AbortSignal): Promise<AcousticBuilds> {
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './underwater-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './underwater-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  return { plain, shared };
}

export function acousticStackTop(host: SolverHost, name: string): number {
  const stack = host.allocate(name, STACK_BYTES + 8, 'u8', 1);
  return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
}

export function bindAcousticKernel(host: SolverHost, module: WebAssembly.Module): AcousticKernel {
  const top = acousticStackTop(host, 'acoustic-kernel-stack');
  try {
    const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
    const pointer = exports.__stack_pointer;
    if (!(pointer instanceof WebAssembly.Global))
      throw new MargoError(
        'failed',
        'The underwater kernel has no stack pointer. You must rebuild the acoustic Wasm assets.',
      );
    pointer.value = top;
    return exports as unknown as AcousticKernel;
  } catch (cause) {
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError(
        'failed',
        'Underwater Wasm could not bind the world memory. Rebuild the matching acoustic assets.',
      ),
      { cause },
    );
  }
}
