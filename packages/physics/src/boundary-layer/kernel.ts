import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface BoundaryLayerBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export interface BoundaryLayerKernel {
  boundary_layer_sample(job: number): number;
  boundary_layer_thread_phase(job: number, stage: number, part: number, parts: number): number;
}

async function compile(asset: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    signal?.throwIfAborted();
    let module: WebAssembly.Module;
    if (asset.protocol === 'file:') {
      asset.search = '';
      const source = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ source);
      module = await WebAssembly.compile(await readFile(asset, { signal }));
    } else {
      const response = await fetch(asset, { signal });
      if (!response.ok)
        throw new MargoError(
          'failed',
          `Boundary-layer kernel request returned HTTP ${response.status}. You must serve the matching wind Wasm asset.`,
        );
      module = await WebAssembly.compile(await response.arrayBuffer());
    }
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError('failed', 'Wind Wasm could not load. Serve the matching boundary-layer assets in a SIMD runtime.'),
      { cause },
    );
  }
}

export async function loadBoundaryLayerBuilds(signal?: AbortSignal): Promise<BoundaryLayerBuilds> {
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './boundary-layer-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './boundary-layer-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  return { plain, shared };
}

export function windStackTop(host: SolverHost, name: string): number {
  const stack = host.allocate(name, STACK_BYTES + 8, 'u8', 1);
  return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
}

export function bindWind(host: SolverHost, module: WebAssembly.Module): BoundaryLayerKernel {
  const top = windStackTop(host, 'boundary-layer-kernel-stack');
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const stack = exports.__stack_pointer;
  if (!(stack instanceof WebAssembly.Global))
    throw new MargoError('failed', 'Wind Wasm has no stack pointer. You must rebuild the boundary-layer assets.');
  stack.value = top;
  return exports as unknown as BoundaryLayerKernel;
}
