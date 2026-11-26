import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

export interface ThinFilmBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

export interface ThinFilmKernel {
  thin_film_step(
    state: number,
    base: number,
    rain: number,
    drips: number,
    budget: number,
    model: number,
    forcing: number,
    workspace: number,
    nx: number,
    ny: number,
    dt: number,
    wetting: number,
    wettingMap: number,
  ): number;
}

export async function loadThinFilmBuilds(signal?: AbortSignal): Promise<ThinFilmBuilds> {
  signal?.throwIfAborted();
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './thin-film-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './thin-film-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        `ThinFilm Wasm request returned HTTP ${response.status}; serve the thin-film kernel asset.`,
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
        'ThinFilm Wasm failed to load; use a SIMD runtime and serve the optional thin-film kernel.',
      ),
      { cause },
    );
  }
}

export function bindThinFilmKernel(host: SolverHost, builds: ThinFilmBuilds): ThinFilmKernel {
  const shared = typeof SharedArrayBuffer !== 'undefined' && host.memory.buffer instanceof SharedArrayBuffer;
  const wasm = shared ? builds.shared : builds.plain;
  if (!wasm)
    throw new MargoError('unsupported', 'The shared thin-film kernel is unavailable; create a plain-memory world.');
  const stack = host.allocate('thin-film-kernel-stack', STACK_BYTES, 'u8', 1);
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError('failed', 'The thin-film kernel has no stack pointer; rebuild the optional Wasm assets.');
  pointer.value = stack.byteOffset + stack.byteLength;
  return exports as unknown as ThinFilmKernel;
}
