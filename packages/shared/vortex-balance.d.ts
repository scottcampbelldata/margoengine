/** Radius of maximum wind of a Burgers-Rott vortex over its r0. */
export const BURGERS_PEAK_RADIUS = 1.1209064204856645;
/** Peak wind of a Burgers-Rott vortex over G / (2 pi r0). */
export const BURGERS_PEAK_WIND = 0.6381726863389515;

export function oneMinusDecay(x: number): number;
export function hollandDeficit(radius: number, maximumRadius: number, shape: number, deficit: number): number;
export function hollandGradient(
  radius: number,
  maximumRadius: number,
  shape: number,
  deficit: number,
  density: number,
  coriolis: number,
): number;
/** The exponential integral E1(x) for x > 0: its series below 1, a continued fraction above (Abramowitz and Stegun 5.1). */
export function expIntegral(x: number): number;
export function compactPeakWind(deficit: number, density: number, decay: number, burgers: boolean): number;
export function compactTangential(radius: number, peak: number, decay: number, burgers: boolean): number;
export function compactDeficit(radius: number, deficit: number, decay: number, burgers: boolean): number;
