import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface IcebergBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export interface IcebergKernel {
  iceberg_step(state: number, count: number, settings: number, dt: number): number;
}

export async function loadIcebergBuilds(signal?: AbortSignal): Promise<IcebergBuilds> {
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './iceberg-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './iceberg-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        `Iceberg Wasm request returned HTTP ${response.status}; serve the iceberg kernel asset.`,
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
        'Iceberg Wasm failed to load; use a SIMD runtime and serve the optional iceberg kernel.',
      ),
      { cause },
    );
  }
}

export function bindIcebergKernel(host: SolverHost, builds: IcebergBuilds): IcebergKernel {
  const shared = typeof SharedArrayBuffer !== 'undefined' && host.memory.buffer instanceof SharedArrayBuffer;
  const wasm = shared ? builds.shared : builds.plain;
  if (!wasm)
    throw new MargoError('unsupported', 'The shared iceberg kernel is unavailable; create a plain-memory world.');
  const stack = host.allocate('iceberg-kernel-stack', STACK_BYTES, 'u8', 1);
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError('failed', 'The iceberg kernel has no stack pointer; rebuild the optional Wasm assets.');
  pointer.value = stack.byteOffset + stack.byteLength;
  return exports as unknown as IcebergKernel;
}
