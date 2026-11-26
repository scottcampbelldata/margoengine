import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface LavaBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export interface LavaKernel {
  lava_step(
    state: number,
    trial: number,
    bed: number,
    vents: number,
    model: number,
    nx: number,
    nz: number,
    ice: number,
    budget: number,
    dt: number,
    start: number,
  ): number;
  lava_publish(
    state: number,
    bed: number,
    model: number,
    samples: number,
    deposits: number,
    sources: number,
    previous: number,
    nx: number,
    nz: number,
    x: number,
    z: number,
    budget: number,
    initial: number,
  ): void;
}

export async function loadLavaBuilds(signal?: AbortSignal): Promise<LavaBuilds> {
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './lava-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './lava-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        `Lava Wasm request returned HTTP ${response.status}. Use an HTTP route that serves the lava kernel asset.`,
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
      new MargoError('failed', 'Lava Wasm failed to load. Use a SIMD runtime and serve the optional lava kernel.'),
      { cause },
    );
  }
}

export function bindLavaKernel(host: SolverHost, builds: LavaBuilds): LavaKernel {
  const shared = typeof SharedArrayBuffer !== 'undefined' && host.memory.buffer instanceof SharedArrayBuffer;
  const wasm = shared ? builds.shared : builds.plain;
  if (!wasm) throw new MargoError('unsupported', 'The shared lava kernel is unavailable. Create a plain-memory world.');
  const stack = host.allocate('lava-kernel-stack', STACK_BYTES, 'u8', 1);
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError('failed', 'The lava kernel has no stack pointer. Run the optional Wasm build.');
  pointer.value = stack.byteOffset + stack.byteLength;
  return exports as unknown as LavaKernel;
}
