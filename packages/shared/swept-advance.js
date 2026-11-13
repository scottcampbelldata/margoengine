// Conservative advancement, the stepping every swept check shares (sweepChain and sweepHull in kinematics-constraints,
// sweepRobot in robot-planning): B. Mirtich, "Impulse-based dynamic simulation of rigid body systems", PhD thesis, UC
// Berkeley, 1996, with the per-link motion bound of F. Schwarzer, M. Saha and J.-C. Latombe, "Exact collision checking
// of robot paths", WAFR 2002. A shape `gap` from a static collider whose points move no faster than `speed` cannot touch
// it for `gap / speed` of the path's time, so the check steps that far and looks again. Written clean room from those
// publications.
import { rangeError } from './errors.js';

/** The settings of every swept check, with their defaults, checked. */
export function sweepSettings(options) {
  const minClearance = options?.minClearance ?? 0,
    tolerance = options?.tolerance ?? 1e-4,
    maxSteps = options?.maxSteps ?? 4096;
  if (!(minClearance >= 0) || !Number.isFinite(minClearance))
    throw rangeError('Sweep minClearance must be 0 or more', 'kinematics');
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) throw rangeError('Sweep tolerance must be above 0', 'kinematics');
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1)
    throw rangeError('Sweep maxSteps must be a positive integer', 'kinematics');
  return { minClearance, tolerance, maxSteps };
}

/** Steps `motion` from time 0 to 1 against still colliders; swept-advance.d.ts describes the motion and the result. */
export function advance(motion, colliders, minClearance, tolerance, maxSteps) {
  const { count, speed } = motion,
    pairs = motion.pairs,
    result = {
      clear: false,
      exhausted: false,
      time: 0,
      clearance: Infinity,
      steps: 0,
      shape: -1,
      collider: -1,
    };
  let t = 0;
  for (;;) {
    motion.place(t);
    result.steps++;
    let step = Infinity;
    for (let s = 0; s < count; s++) {
      const moving = speed[s];
      // A shape that does not move stands where it stood at the start.
      if (moving === 0 && t > 0) continue;
      let least = Infinity;
      for (let c = 0; c < colliders.length; c++) {
        const gap = motion.gap(s, colliders[c]) - minClearance;
        if (Number.isNaN(gap)) throw rangeError('A collider gave no finite clearance', 'kinematics');
        if (gap < result.clearance) result.clearance = gap;
        if (gap <= tolerance) {
          result.time = t;
          result.shape = s;
          result.collider = c;
          return result;
        }
        if (gap < least) least = gap;
      }
      if (moving > 0 && least / moving < step) step = least / moving;
    }
    if (pairs) {
      for (let i = 0; i < pairs.length; i += 2) {
        const a = pairs[i],
          b = pairs[i + 1],
          moving = speed[a] + speed[b];
        if (moving === 0 && t > 0) continue;
        const gap = motion.pairGap(a, b) - minClearance;
        if (Number.isNaN(gap)) throw rangeError('A pair of shapes gave no finite clearance', 'kinematics');
        if (gap < result.clearance) result.clearance = gap;
        if (gap <= tolerance) {
          result.time = t;
          result.shape = a;
          result.collider = -2 - b;
          return result;
        }
        if (moving > 0 && gap / moving < step) step = gap / moving;
      }
    }
    result.time = t;
    if (t >= 1 || step === Infinity) {
      result.time = 1;
      result.clear = true;
      return result;
    }
    if (result.steps >= maxSteps) {
      result.exhausted = true;
      return result;
    }
    t = Math.min(1, t + step);
  }
}
