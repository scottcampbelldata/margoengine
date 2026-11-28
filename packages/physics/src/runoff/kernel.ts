import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface RunoffBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export interface RunoffKernel extends WebAssembly.Exports {
  runoff_step(
    state: number,
    coefficients: number,
    topology: number,
    forcing: number,
    scratch: number,
    budget: number,
    count: number,
    area: number,
    topographicScale: number,
    dt: number,
  ): number;
  runoff_thread_begin(job: number): number;
  runoff_thread_phase(job: number, stage: number, part: number, parts: number): number;
  runoff_thread_finish(job: number): number;
}

async function readAsset(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    url.search = '';
    const fsSpecifier = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fsSpecifier);
    return WebAssembly.compile(await readFile(url, { signal }));
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new MargoError('failed', `Runoff kernel returned HTTP ${response.status}. Serve the runoff Wasm asset.`);
  return WebAssembly.compile(await response.arrayBuffer());
}

export async function loadRunoffBuilds(signal?: AbortSignal): Promise<RunoffBuilds> {
  try {
    const [plain, shared] = await Promise.all([
      readAsset(new URL(/* @vite-ignore */ './runoff-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? readAsset(new URL(/* @vite-ignore */ './runoff-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    return { plain, shared };
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError('failed', 'Runoff Wasm failed to load. Use a SIMD runtime and serve the runoff kernel.'),
      {
        cause,
      },
    );
  }
}

export function instantiateRunoff(host: SolverHost, builds: RunoffBuilds): RunoffKernel {
  const module = isShared(host.memory) ? builds.shared : builds.plain;
  if (!module)
    throw new MargoError('unsupported', 'Runoff has no shared Wasm build on this host. Create a plain-memory world.');
  const stack = host.allocate('runoff-stack', STACK_BYTES + 8, 'u8', 1);
  const exports = new WebAssembly.Instance(module, { env: { memory: host.memory } }).exports as RunoffKernel;
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError('failed', 'Runoff Wasm has no instance stack pointer. Rebuild the runoff kernel assets.');
  pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
  return exports;
}
