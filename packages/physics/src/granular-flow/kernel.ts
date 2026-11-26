import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface GranularFlowBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export interface GranularFlowKernel {
  granular_step(
    work: number,
    trial: number,
    nx: number,
    nz: number,
    dt: number,
    dx: number,
    dz: number,
    gravity: number,
    friction: number,
    turbulence: number,
  ): number;
}

export async function loadGranularFlowBuilds(signal?: AbortSignal): Promise<GranularFlowBuilds> {
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './granular-flow-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './granular-flow-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        `Granular flow Wasm request returned HTTP ${response.status}. Use an HTTP route that serves the granular flow kernel asset.`,
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
        'Granular flow Wasm failed to load. Use a SIMD runtime and serve the optional granular flow kernel.',
      ),
      { cause },
    );
  }
}

export function bindGranularFlowKernel(host: SolverHost, builds: GranularFlowBuilds): GranularFlowKernel {
  const shared = typeof SharedArrayBuffer !== 'undefined' && host.memory.buffer instanceof SharedArrayBuffer;
  const wasm = shared ? builds.shared : builds.plain;
  if (!wasm)
    throw new MargoError('unsupported', 'The shared granular flow kernel is unavailable. Create a plain-memory world.');
  const stack = host.allocate('granular-flow-kernel-stack', STACK_BYTES, 'u8', 1);
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError('failed', 'The granular flow kernel has no stack pointer. Run the optional Wasm build.');
  pointer.value = stack.byteOffset + stack.byteLength;
  return exports as unknown as GranularFlowKernel;
}
