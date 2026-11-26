import { exp } from '@margoengine/math/pinned';
import { bounded, oneMinusExp } from './processes.js';

/** Diffuse reflectance and transmittance of a finite layer on a black backing. */
export interface WeatheringFilm {
  readonly reflectance: number;
  readonly transmittance: number;
}

/** Two-flux Kubelka–Munk layer. Absorption and scattering are in inverse metres, thickness is in metres. */
export function weatheringFilm(absorption: number, scattering: number, thickness: number): WeatheringFilm {
  bounded(absorption, 0, 1e15, 'film absorption');
  bounded(scattering, 0, 1e15, 'film scattering');
  bounded(thickness, 0, 1e9, 'film thickness');
  return film(absorption, scattering, thickness);
}

function film(absorption: number, scattering: number, thickness: number): WeatheringFilm {
  const mode = Math.sqrt(absorption) * Math.sqrt(absorption + 2 * scattering);
  if (mode === 0) {
    const scatteringDepth = scattering * thickness;
    return { reflectance: scatteringDepth / (1 + scatteringDepth), transmittance: 1 / (1 + scatteringDepth) };
  }
  const depth = mode * thickness;
  const e = exp(-depth);
  const u = oneMinusExp(2 * depth);
  const denominator = (absorption + scattering) * u + mode * (1 + e * e);
  return { reflectance: (scattering * u) / denominator, transmittance: (2 * mode * e) / denominator };
}

export type Rgb = readonly [number, number, number];

export function backedFilm(surface: number, filmAlbedo: number, scattering: number, thickness: number): number {
  // Invert the semi-infinite Kubelka–Munk solution to author the pigment in linear reflectance.
  const delta = 1 - filmAlbedo;
  const abs = (scattering * delta * delta) / (2 * filmAlbedo);
  const { reflectance, transmittance } = film(abs, scattering, thickness);
  return reflectance + (transmittance * transmittance * surface) / (1 - reflectance * surface);
}
