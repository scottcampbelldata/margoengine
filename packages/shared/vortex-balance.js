import { exp, ln, pow } from '@margoengine/math/pinned';

/** Radius and velocity at the Burgers–Rott tangential maximum, relative to r0 and Γ/(2πr0). */
export const BURGERS_PEAK_RADIUS = 1.1209064204856645;
export const BURGERS_PEAK_WIND = 0.6381726863389515;

/** 1 − exp(−x), including the cancellation limit at the eye of an axial vortex. */
export function oneMinusDecay(x) {
  if (x < 1e-3) return x * (1 + x * (-0.5 + x * (1 / 6 + x * (-1 / 24 + x / 120))));
  return 1 - exp(-x);
}

/** Holland 1980 radial pressure deficit in Pa. */
export function hollandDeficit(radius, maximumRadius, shape, deficit) {
  if (radius <= 0) return deficit;
  return deficit * oneMinusDecay(pow(maximumRadius / radius, shape));
}

/** Holland 1980 gradient balance, rationalized to retain weak outer winds. */
export function hollandGradient(radius, maximumRadius, shape, deficit, density, coriolis) {
  if (radius <= 0) return 0;
  const scaled = pow(maximumRadius / radius, shape);
  if (!Number.isFinite(scaled)) return 0;
  const forcing = (shape * deficit * scaled * exp(-scaled)) / density;
  const half = (radius * coriolis) / 2;
  return forcing > 0 ? forcing / (Math.sqrt(forcing + half * half) + half) : 0;
}

/** Exponential integral E1, with the Abramowitz and Stegun series and continued fraction. */
export function expIntegral(x) {
  if (!(x > 0)) return x === 0 ? Infinity : NaN;
  if (x <= 1) {
    let sum = 0,
      term = 1;
    for (let k = 1; k < 40; k++) {
      term *= -x / k;
      sum -= term / k;
      if (Math.abs(term / k) < 1e-17) break;
    }
    return -0.5772156649015329 - ln(x) + sum;
  }
  let b = x + 1,
    c = 1e300,
    d = 1 / b,
    h = d;
  for (let i = 1; i < 200; i++) {
    const a = -i * i;
    b += 2;
    d = 1 / (a * d + b);
    c = b + a / c;
    const delta = c * d;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return h * exp(-x);
}

/** Circumferential peak speed of a compact cyclostrophic vortex. */
export function compactPeakWind(deficit, density, decay, burgers) {
  return burgers
    ? BURGERS_PEAK_WIND * Math.sqrt(deficit / (density * Math.LN2))
    : Math.sqrt(deficit / (density * (0.5 + 0.5 / decay)));
}

/** Normalized combined Rankine or Burgers–Rott velocity, with radius normalized by the peak-wind radius. */
export function compactTangential(radius, peak, decay, burgers) {
  if (!(radius > 0)) return 0;
  if (!burgers) return radius <= 1 ? peak * radius : peak * pow(1 / radius, decay);
  const scaled = radius * BURGERS_PEAK_RADIUS;
  return (peak * oneMinusDecay(scaled * scaled)) / (BURGERS_PEAK_WIND * scaled);
}

/** Exact cyclostrophic pressure integral of the same compact wind profile. */
export function compactDeficit(radius, deficit, decay, burgers) {
  if (!burgers) {
    const tail = 1 / decay;
    return (
      deficit * (radius <= 1 ? (tail + 1 - radius * radius) / (tail + 1) : pow(1 / radius, 2 * decay) / (1 + decay))
    );
  }
  const scaled = radius * BURGERS_PEAK_RADIUS,
    x = scaled * scaled;
  if (x < 1e-8) return deficit * (1 - x / (2 * Math.LN2));
  if (x > 300) return deficit / (2 * Math.LN2 * x);
  const e = oneMinusDecay(x);
  return (deficit * ((e * e) / x + 2 * (expIntegral(x) - expIntegral(2 * x)))) / (2 * Math.LN2);
}
