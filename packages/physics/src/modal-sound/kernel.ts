import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

interface KernelExports extends WebAssembly.Exports {
  __stack_pointer: WebAssembly.Global;
  modal_sound_block(
    models: number,
    states: number,
    modes: number,
    surface: number,
    drive: number,
    pcm: number,
    samples: number,
  ): void;
}

export interface ModalSoundBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  let bytes: BufferSource;
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      bytes = await readFile(url, { signal });
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw new MargoError(
          'failed',
          'Modal sound solver Wasm request failed. Provide its Wasm assets at the expected URL.',
        );
      bytes = await response.arrayBuffer();
    }
    const module = await WebAssembly.compile(bytes);
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError(
        'failed',
        'Modal sound solver Wasm failed to load. Use a SIMD-capable runtime and serve its kernel assets.',
      ),
      { cause },
    );
  }
}

export async function loadModalSoundBuilds(signal?: AbortSignal): Promise<ModalSoundBuilds> {
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './modal-sound-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './modal-sound-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  return { plain, shared };
}

export function modalSoundBlock(host: SolverHost, builds: ModalSoundBuilds): KernelExports['modal_sound_block'] {
  const module = isShared(host.memory) ? builds.shared : builds.plain;
  if (!module)
    throw new MargoError(
      'unsupported',
      'Shared modal sound solver Wasm is unavailable. Use plain world memory on this host.',
    );
  const stack = host.allocate('modal-sound-kernel-stack', STACK_BYTES + 8, 'u8', 1);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  if (!(exports.__stack_pointer instanceof WebAssembly.Global) || typeof exports.modal_sound_block !== 'function')
    throw new MargoError(
      'version',
      'Modal sound solver Wasm has incompatible exports. Run the modal sound kernel build.',
    );
  exports.__stack_pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
  return exports.modal_sound_block as KernelExports['modal_sound_block'];
}
