import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';
import type { WaveSpectrumSample } from '@margoengine/math/fields';

export function rogueError(code: MargoErrorCode, message: string): MargoError {
  return new MargoError(code, `${message} See https://margoengine.com/errors#nonlinear-sea`);
}

export function checkSpectrum(spectrum: WaveSpectrumSample): void {
  const { frequencies, directions, energy } = spectrum ?? {};
  if (!frequencies?.length || !directions?.length || energy?.length !== frequencies.length * directions.length) {
    throw rogueError(
      'unsupported',
      'A spectrum needs nonempty frequency and direction grids and one energy value per bin; pass a complete spectrum.',
    );
  }
  let lower = 0;
  for (const frequency of frequencies) {
    if (!(frequency > lower && Number.isFinite(frequency))) {
      throw rogueError(
        'unsupported',
        'Spectrum frequencies must increase strictly from positive finite hertz; sort or rebuild the grid.',
      );
    }
    lower = frequency;
  }
  for (const direction of directions) {
    if (!Number.isFinite(direction)) {
      throw rogueError('unsupported', 'Spectrum directions must be finite radians; fix the direction grid.');
    }
  }
  for (const value of energy) {
    if (!(value >= 0 && Number.isFinite(value))) {
      throw rogueError('unsupported', 'Spectrum energy must be finite and nonnegative; fix the energy bins.');
    }
  }
  if (!(spectrum.depth > 0) || !Number.isFinite(spectrum.density)) {
    throw rogueError(
      'unsupported',
      'A sea needs a wet spectrum and finite water density; sample a wet cell, or pass Infinity for deep water with a finite density.',
    );
  }
}
