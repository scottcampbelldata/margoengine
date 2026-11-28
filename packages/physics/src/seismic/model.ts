import { exp } from '@margoengine/math/pinned';
import { seismicError } from './errors.js';

/** Cumulative share of a Brune-shaped moment released by a causal pulse with timescale `tau`. */
export function momentFraction(seconds: number, tau: number): number {
  if (!Number.isFinite(seconds) || !(tau > 0 && Number.isFinite(tau)))
    throw seismicError('Invalid seismic pulse. Pass finite seconds and a positive timescale.');
  if (seconds <= 0) return 0;
  const x = seconds / tau;
  if (!Number.isFinite(x)) return 1;
  if (x < 1e-3) return x * x * (0.5 + x * (-1 / 3 + x * (1 / 8 - x / 30)));
  return 1 - (1 + x) * exp(-x);
}

/** Seed–Idriss cyclic stress demand in saturated soil. Acceleration and gravity are in m/s². */
export function seismicCyclicStress(
  peakGroundAcceleration: number,
  gravity: number,
  overburdenRatio: number,
  depthReduction: number,
): number {
  if (
    !(peakGroundAcceleration >= 0 && Number.isFinite(peakGroundAcceleration)) ||
    !(gravity > 0 && Number.isFinite(gravity)) ||
    !(overburdenRatio >= 1 && Number.isFinite(overburdenRatio)) ||
    !(depthReduction > 0 && depthReduction <= 1)
  )
    throw seismicError(
      'Invalid cyclic stress inputs. Pass nonnegative acceleration, positive gravity, a stress ratio at least 1, and a depth reduction in (0, 1].',
    );
  const demand = (0.65 * peakGroundAcceleration * overburdenRatio * depthReduction) / gravity;
  if (!Number.isFinite(demand))
    throw seismicError(
      'The cyclic stress ratio exceeds numeric range. Use finite SI acceleration and a physical stress ratio.',
    );
  return demand;
}
