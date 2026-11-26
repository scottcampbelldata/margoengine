import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface LocomotionBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export interface LocomotionKernel {
  prepare(body: number, profile: number, actuators: number, anchors: number, geometry: number, count: number): void;
  step(
    body: number,
    profile: number,
    actuators: number,
    anchors: number,
    geometry: number,
    contacts: number,
    count: number,
    dt: number,
    gravityX: number,
    gravityY: number,
    gravityZ: number,
  ): number;
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const name = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }

    const response = await fetch(url, { signal });
    if (!response.ok)
      throw new MargoError(
        'failed',
        'The ground locomotion asset returned HTTP ' + response.status + '. Check its URL.',
      );
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError(
        'failed',
        'The ground locomotion kernel could not load. Serve its Wasm asset and use a SIMD-capable runtime.',
      ),
      { cause },
    );
  }
}

export async function loadLocomotionBuilds(signal?: AbortSignal): Promise<LocomotionBuilds> {
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './locomotion-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './locomotion-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  signal?.throwIfAborted();
  return { plain, shared };
}

export function bindLocomotionKernel(host: SolverHost, builds: LocomotionBuilds): LocomotionKernel {
  const module = isShared(host.memory) ? builds.shared : builds.plain;
  if (!module)
    throw new MargoError(
      'unsupported',
      'The shared locomotion kernel is unavailable. Pass plain world memory on this host.',
    );
  const stack = host.allocate('locomotion-kernel-stack', STACK_BYTES + 16, 'u8', 1);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  const prepare = exports.locomotion_prepare;
  const step = exports.locomotion_step;
  if (!(pointer instanceof WebAssembly.Global) || typeof prepare !== 'function' || typeof step !== 'function')
    throw new MargoError(
      'failed',
      'The locomotion kernel is missing exports. Run the Physics package and locomotion Wasm builds.',
    );
  pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
  return { prepare: prepare as LocomotionKernel['prepare'], step: step as LocomotionKernel['step'] };
}
