import { MargoError } from '@margoengine/math/errors';

export type MannFftCells = readonly [number, number, number];

export type MannFftRequest =
  | { readonly module: WebAssembly.Module; readonly cells: MannFftCells }
  | { readonly buffer: ArrayBuffer; readonly inverse: boolean };

export type MannFftReply =
  | { readonly ready: true }
  | { readonly buffer: ArrayBuffer; readonly products: number }
  | { readonly error: string };

/** All complex values are interleaved, x fastest. The native result counts rotations executed by the plan. */
export function bindMannFft(module: WebAssembly.Module, cells: MannFftCells) {
  const {
    memory,
    mann_fft_init: init,
    mann_fft_buffer: buffer,
    mann_fft_transform: transform,
  } = new WebAssembly.Instance(module).exports;
  if (
    !(memory instanceof WebAssembly.Memory) ||
    typeof init !== 'function' ||
    typeof buffer !== 'function' ||
    typeof transform !== 'function'
  )
    throw new MargoError('failed', 'Rebuild the Mann FFT asset with its private memory and three ABI functions.');
  if (cells.some((n) => n !== n >>> 0) || init(...cells) !== 0)
    throw new MargoError('failed', 'Use a smaller Mann FFT grid with integer lengths whose factors are 2, 3 and 5.');
  const words = 2 * cells[0] * cells[1] * cells[2];
  const offset = Number(buffer()) >>> 0;
  const scratch = memory;
  const run = transform;
  return (field: Float64Array, inverse: boolean): number => {
    if (field.length !== words)
      throw new MargoError('failed', `Pass ${words} interleaved f64 words per Mann FFT component.`);
    new Float64Array(scratch.buffer, offset, words).set(field);
    const products = Number(run(Number(inverse)));
    if (!Number.isSafeInteger(products) || products < 0)
      throw new MargoError('failed', 'Initialise the Mann FFT plan before transforming each component.');
    field.set(new Float64Array(scratch.buffer, offset, words));
    return products;
  };
}
