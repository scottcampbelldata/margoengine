import { MargoError } from '@margoengine/math/errors';
import type { RealFft2 } from '@margoengine/math/fft';

export type WakeFft = Pick<RealFft2, 'forward' | 'inverse'>;

export async function loadWakeFft(signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  const url = new URL(/* @vite-ignore */ './wake-fft.wasm?no-inline', import.meta.url);
  try {
    let module: WebAssembly.Module;
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      module = await WebAssembly.compile(await readFile(url, { signal }));
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw new MargoError('failed', `Wake FFT request returned HTTP ${response.status}; serve the wake FFT asset.`);
      module =
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
          ? await WebAssembly.compileStreaming(response)
          : await WebAssembly.compile(await response.arrayBuffer());
    }
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(new MargoError('failed', 'Load the wake FFT asset in a Wasm SIMD runtime.'), { cause });
  }
}

export function bindWakeFft(
  module: WebAssembly.Module,
  nx: number,
  nz: number,
  instance = new WebAssembly.Instance(module),
): WakeFft {
  const { exports } = instance;
  const { memory, wake_fft_init: init, wake_fft_buffer: buffer, wake_fft_transform: transform } = exports;
  if (
    !(memory instanceof WebAssembly.Memory) ||
    typeof init !== 'function' ||
    typeof buffer !== 'function' ||
    typeof transform !== 'function'
  )
    throw new MargoError('failed', 'You must rebuild the wake FFT asset with its memory and transform exports.');
  if (nx !== nx >>> 0 || nz !== nz >>> 0 || init(nx, nz) !== 0)
    throw new MargoError('state', 'Use an even wake FFT width and lengths of 4 to 4096 with factors 2, 3 and 5.');
  const spatial = nx * nz,
    spectral = (nx + 2) * nz;
  const words = buffer() as number;
  const scratchMemory = memory;
  const execute = transform;

  function run(input: Float64Array, output: Float64Array, inverse: boolean): Float64Array {
    const fromLength = inverse ? spectral : spatial,
      toLength = inverse ? spatial : spectral;
    if (input.length !== fromLength || output.length !== toLength)
      throw new MargoError('state', `Pass ${fromLength} wake FFT input words and ${toLength} output words.`);
    new Float64Array(scratchMemory.buffer, words, fromLength).set(input);
    if (execute(Number(inverse)) !== 0)
      throw new MargoError('failed', 'Initialise the wake FFT plan before transforming its buffers.');
    output.set(new Float64Array(scratchMemory.buffer, words, toLength));
    return output;
  }

  return {
    forward: (input, out = new Float64Array(spectral)) => run(input, out, false),
    inverse: (input, out = new Float64Array(spatial)) => run(input, out, true),
  };
}
