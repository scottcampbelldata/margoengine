import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface OrbitBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export interface OrbitKernel {
  orbit_step(
    state: number,
    bodies: number,
    acceleration: number,
    config: number,
    count: number,
    substeps: number,
    fourthOrder: number,
    dt: number,
    massiveIndices: number,
    receipts: number,
  ): number;
  orbit_thread_prepare(job: number): number;
  orbit_thread_phase(job: number, phase: number, part: number, parts: number): number;
  orbit_thread_finish_accel(job: number): number;
  orbit_thread_before(job: number, stage: number): number;
  orbit_thread_after(job: number, stage: number): number;
}

export async function loadOrbitBuilds(signal?: AbortSignal): Promise<OrbitBuilds> {
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './orbit-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './orbit-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        `Orbit Wasm request returned HTTP ${response.status}; serve the orbit kernel asset.`,
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
      new MargoError('failed', 'Orbit Wasm failed to load; use a SIMD runtime and serve the optional orbit kernel.'),
      { cause },
    );
  }
}

export function orbitStackTop(host: SolverHost, name: string): number {
  const stack = host.allocate(name, STACK_BYTES + 8, 'u8', 1);
  return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
}

export function bindOrbitKernel(host: SolverHost, builds: OrbitBuilds): OrbitKernel {
  const shared = typeof SharedArrayBuffer !== 'undefined' && host.memory.buffer instanceof SharedArrayBuffer;
  const wasm = shared ? builds.shared : builds.plain;
  if (!wasm)
    throw new MargoError('unsupported', 'The shared orbit kernel is unavailable; create a plain-memory world.');
  const stackTop = orbitStackTop(host, 'orbit-kernel-stack');
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError('failed', 'The orbit kernel has no stack pointer; rebuild the optional Wasm assets.');
  pointer.value = stackTop;
  return exports as unknown as OrbitKernel;
}
