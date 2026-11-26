import { MargoError } from '@margoengine/math/errors';
import type { WaveSpectrumSample } from '@margoengine/math/fields';
import { cos, exp, sin } from '@margoengine/math/pinned';
import { bandWidth, wavenumber } from './waves/spectral.js';

const TWO_PI = 2 * Math.PI;

interface DriftBand {
  decay: number;
  x: number;
  z: number;
}

export interface StokesProfile {
  depth: number;
  bands: readonly DriftBand[];
}

/** Collapse the directional bins into one horizontal moment per frequency. */
export function stokesProfile(spectrum: WaveSpectrumSample, gravity: number): StokesProfile {
  const { frequencies, directions, energy, depth } = spectrum;
  if (
    !(
      depth > 0 &&
      gravity > 0 &&
      Number.isFinite(gravity) &&
      frequencies.length > 0 &&
      directions.length > 0 &&
      energy.length === frequencies.length * directions.length &&
      frequencies.every((f, i) => Number.isFinite(f) && f > (frequencies[i - 1] ?? 0)) &&
      directions.every(Number.isFinite) &&
      energy.every((value) => Number.isFinite(value) && value >= 0)
    )
  )
    throw new MargoError(
      'unsupported',
      'The tracer Stokes spectrum is invalid; supply positive depth and gravity, ascending frequencies, and a finite nonnegative energy grid.',
    );
  const directionWidth = TWO_PI / directions.length;
  const axes = Array.from(directions, (direction) => {
    const angle = direction - TWO_PI * Math.floor(direction / TWO_PI);
    return [cos(angle), sin(angle)] as const;
  });
  const bands: DriftBand[] = [];
  for (const [i, f] of frequencies.entries()) {
    let x = 0;
    let z = 0;
    for (const [j, [cx, cz]] of axes.entries()) {
      const variance = energy[i * directions.length + j]!;
      x += variance * cx;
      z += variance * cz;
    }
    if (x === 0 && z === 0) continue;
    const decay = 2 * wavenumber(f, depth, gravity);
    // Kenyon (1969), expressed as decaying exponentials. In deep water the denominator is one.
    const denominator = 1 - exp(-decay * depth);
    const factor = (TWO_PI * f * decay * bandWidth(frequencies, i) * directionWidth) / (denominator * denominator);
    if (!(decay > 0 && Number.isFinite(decay) && Number.isFinite(x * factor) && Number.isFinite(z * factor)))
      throw new MargoError(
        'unsupported',
        'A tracer Stokes band exceeds numeric range; use physical frequencies, energies, depth and gravity.',
      );
    bands.push({ decay, x: x * factor, z: z * factor });
  }
  return { depth, bands };
}

export function stokesAt(profile: StokesProfile, depth: number, out: [number, number]): void {
  const bed = profile.depth;
  if (depth > bed) {
    out[0] = out[1] = 0;
    return;
  }
  const below = Math.max(0, depth);
  let x = 0;
  let z = 0;
  for (const band of profile.bands) {
    const surface = exp(-band.decay * below);
    const reflected = bed < Infinity ? exp(-band.decay * (bed + (bed - below))) : 0;
    const weight = surface + reflected;
    x += weight * band.x;
    z += weight * band.z;
  }
  out[0] = x;
  out[1] = z;
}
