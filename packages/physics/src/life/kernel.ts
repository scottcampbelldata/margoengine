import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface SwimKernelBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

type SwimStep = (
  body: number,
  parameters: number,
  medium: number,
  next: number,
  kinematics: number,
  wake: number,
  count: number,
  dt: number,
) => number;

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const name = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
      const module = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return module;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw new MargoError('failed', 'The swimming asset returned HTTP ' + response.status + '. Check its URL.');
    const module = await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError(
        'failed',
        'The swimming kernel could not load. Serve its Wasm asset and use a SIMD-capable runtime.',
      ),
      { cause },
    );
  }
}

export async function loadSwimKernel(signal?: AbortSignal): Promise<SwimKernelBuilds> {
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './swim-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './swim-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  return { plain, shared };
}

export function instantiateSwimKernel(host: SolverHost, builds: SwimKernelBuilds): SwimStep {
  const module = isShared(host.memory) ? builds.shared : builds.plain;
  if (!module)
    throw new MargoError(
      'unsupported',
      'The shared swimming kernel is unavailable. Use plain world memory on this host.',
    );
  const stack = host.allocate('swim-kernel-stack', STACK_BYTES + 16, 'u8', 1);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global) || typeof exports.swim_step !== 'function')
    throw new MargoError(
      'failed',
      'The swimming kernel is missing exports. Run the Physics package and swimming Wasm builds.',
    );
  pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
  return exports.swim_step as SwimStep;
}
