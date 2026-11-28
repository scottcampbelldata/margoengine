import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface TsunamiBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export interface TsunamiKernel {
  tsunami_step(
    water: number,
    rk: number,
    trial: number,
    bed: number,
    pressure: number,
    model: number,
    nx: number,
    nz: number,
    log: number,
    budget: number,
    dt: number,
    time: number,
    incoming: number,
  ): number;
  tsunami_sources(
    water: number,
    pressure: number,
    nx: number,
    nz: number,
    model: number,
    sources: number,
    count: number,
    dx: number,
    dz: number,
    inject: number,
    report: number,
  ): number;
  tsunami_bottom(
    water: number,
    previous: number,
    next: number,
    model: number,
    nx: number,
    nz: number,
    depth: number,
    scratch: number,
  ): number;
  tsunami_travel(bed: number, out: number, model: number, nx: number, nz: number, cell: number): number;
}

export async function loadTsunamiBuilds(signal?: AbortSignal): Promise<TsunamiBuilds> {
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './tsunami-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './tsunami-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        `Tsunami Wasm request returned HTTP ${response.status}. Use an HTTP route that serves the tsunami kernel asset.`,
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
        'Tsunami Wasm failed to load. Use a SIMD runtime and serve the optional tsunami kernel.',
      ),
      { cause },
    );
  }
}

export function bindTsunamiKernel(host: SolverHost, builds: TsunamiBuilds): TsunamiKernel {
  const shared = typeof SharedArrayBuffer !== 'undefined' && host.memory.buffer instanceof SharedArrayBuffer;
  const wasm = shared ? builds.shared : builds.plain;
  if (!wasm)
    throw new MargoError('unsupported', 'The shared tsunami kernel is unavailable. Create a plain-memory world.');
  const stack = host.allocate('tsunami-kernel-stack', STACK_BYTES, 'u8', 1);
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError('failed', 'The tsunami kernel has no stack pointer. Run the optional Wasm build.');
  pointer.value = stack.byteOffset + stack.byteLength;
  return exports as unknown as TsunamiKernel;
}
