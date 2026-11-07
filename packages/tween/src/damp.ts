/** A mutable vector of numbers: the shapes `smoothDamp` writes to. */
export type DampArray = number[] | Float32Array | Float64Array;

/** Rate times seconds beyond which the decay `exp(-x)` is zero for practical purposes (it is 1e-304 here). */
const SETTLED = 700;

/** Where {@link measure} leaves its result: a returned fractional number is boxed on the heap in unoptimized code. */
const measured = new Float64Array(1);

/** Writes the Euclidean length of `a - b` (or of `a` alone) to `measured`, scaled by the largest term so squares cannot overflow. */
function measure(a: ArrayLike<number>, b: ArrayLike<number> | undefined, n: number): void {
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(b ? a[i] - b[i] : a[i]);
    if (v > peak) peak = v;
  }
  if (peak === 0 || peak === Infinity) {
    measured[0] = peak;
    return;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = (b ? a[i] - b[i] : a[i]) / peak;
    sum += v * v;
  }
  measured[0] = peak * Math.sqrt(sum);
}

/** The new position and velocity, computed here first so each caller array is written by one store loop for its kind. */
let nextOut = new Float64Array(4),
  nextVelocity = new Float64Array(4);

/**
 * Copies `src` into `dst`. One store site that sees plain arrays (including a small integer array turning into a
 * double one) beside typed arrays falls back to a generic store that boxes every number it writes, so plain arrays and
 * typed arrays get a loop each and both stay specialized whatever mix of kinds callers pass.
 */
function write(dst: DampArray, src: Float64Array, n: number): void {
  if (Array.isArray(dst)) for (let i = 0; i < n; i++) dst[i] = src[i];
  else for (let i = 0; i < n; i++) dst[i] = src[i];
}

function check(name: string, values: ArrayLike<number>, n: number): void {
  if (!values || typeof values.length !== 'number' || values.length !== n)
    throw new RangeError(`smoothDamp ${name} needs ${n} numbers, the length of current; pass arrays of one length`);
  for (let i = 0; i < n; i++)
    if (!Number.isFinite(values[i]))
      throw new RangeError(`smoothDamp ${name}[${i}] is not finite; pass finite numbers`);
}

/**
 * Critically damped smoothing toward a target, the way cameras and followers want it: `current` eases to `target`
 * with no oscillation, taking roughly `smoothTime` seconds, and `velocity` carries across frames so a moving target
 * stays smooth. Each component is the exact closed-form critically damped spring (the same motion as a {@link Spring}
 * with stiffness `(2 / smoothTime)^2` and damping `4 / smoothTime`), so any `dt`, even a long hitch, is stable.
 * Works on vectors of any length; it creates no objects, so it is safe in a frame loop.
 *
 * `maxSpeed` limits the vector speed: the pull toward the target is capped so the point never moves faster than
 * `maxSpeed` units per second, and `velocity` is scaled down to `maxSpeed` if it exceeds it (before and after the
 * step). It is the length of the whole vector, so the direction of travel is kept. A velocity that carries the point
 * toward the target can still overshoot it once, as a {@link Spring} does.
 *
 * `out` may be `current` (update in place); `velocity` is read and updated in place and must be a different array
 * from `out`.
 *
 * ```ts
 * const position = new Float32Array(3), velocity = new Float32Array(3), target = new Float32Array([0, 1, 2]);
 * smoothDamp(position, target, velocity, 0.3, Infinity, 1 / 60, position); // call every frame
 * ```
 *
 * @param current Where the point is now.
 * @param target Where it is heading.
 * @param velocity Current velocity in units per second; updated in place.
 * @param smoothTime Approximate seconds to reach the target, finite and >= 0. Zero lands on the target at once
 * (`maxSpeed` does not apply) and zeroes `velocity`.
 * @param maxSpeed Fastest allowed speed in units per second, >= 0 (`Infinity` for no limit); 0 holds the point still.
 * @param dt Seconds since the last call, finite and >= 0. Zero leaves `velocity` alone and writes `current` to `out`.
 * @param out Receives the new position.
 * @returns `out`.
 * @throws RangeError when the arrays differ in length or hold a non-finite number, `smoothTime`, `maxSpeed` or `dt`
 * is out of range, or `out` is `velocity`.
 */
export function smoothDamp<T extends DampArray>(
  current: ArrayLike<number>,
  target: ArrayLike<number>,
  velocity: DampArray,
  smoothTime: number,
  maxSpeed: number,
  dt: number,
  out: T,
): T {
  const n = current?.length;
  if (!Number.isSafeInteger(n) || n < 1)
    throw new RangeError('smoothDamp current needs at least one number; pass an array or typed array');
  if (!Number.isFinite(smoothTime) || smoothTime < 0)
    throw new RangeError('smoothDamp smoothTime must be a finite number of seconds >= 0');
  if (!(maxSpeed >= 0)) throw new RangeError('smoothDamp maxSpeed must be a number >= 0 (Infinity for no limit)');
  if (!Number.isFinite(dt) || dt < 0) throw new RangeError('smoothDamp dt must be a finite number of seconds >= 0');
  if ((out as unknown) === velocity) throw new RangeError('smoothDamp out and velocity must be different arrays');
  check('current', current, n);
  check('target', target, n);
  check('velocity', velocity, n);
  if (out.length !== n) throw new RangeError(`smoothDamp out needs ${n} numbers, the length of current`);
  if (n > nextOut.length) {
    nextOut = new Float64Array(n);
    nextVelocity = new Float64Array(n);
  }
  const next = nextOut,
    moving = nextVelocity;
  if (dt === 0 || smoothTime === 0) {
    // No time passed: stay put and keep the velocity. No smoothing: land on the target at rest.
    for (let i = 0; i < n; i++) {
      next[i] = dt === 0 ? current[i] : target[i];
      moving[i] = dt === 0 ? velocity[i] : 0;
    }
  } else {
    const rate = 2 / smoothTime;
    // Cap the pull: aim at a virtual target no farther than maxSpeed * smoothTime behind the point.
    const reach = maxSpeed * smoothTime,
      distance = reach < Infinity ? (measure(current, target, n), measured[0]) : 0,
      pull = distance > reach ? reach / distance : 1;
    if (rate * dt >= SETTLED) {
      // Settled within this step: the decay underflows to zero, so arrive at the (virtual) target at rest.
      for (let i = 0; i < n; i++) {
        next[i] = pull === 1 ? target[i] : current[i] - (current[i] - target[i]) * pull;
        moving[i] = 0;
      }
    } else {
      let hold = 1;
      if (maxSpeed < Infinity) {
        measure(velocity, undefined, n);
        const speed = measured[0];
        if (speed > maxSpeed) hold = maxSpeed / speed;
      }
      const decay = Math.exp(-rate * dt);
      for (let i = 0; i < n; i++) {
        const from = current[i],
          change = pull === 1 ? from - target[i] : (from - target[i]) * pull,
          anchor = pull === 1 ? target[i] : from - change,
          v = velocity[i] * hold,
          push = v + rate * change;
        next[i] = anchor + (change + push * dt) * decay;
        moving[i] = (v - rate * push * dt) * decay;
      }
      if (maxSpeed < Infinity) {
        measure(moving, undefined, n);
        const speed = measured[0];
        if (speed > maxSpeed) {
          const scale = maxSpeed / speed;
          for (let i = 0; i < n; i++) moving[i] *= scale;
        }
      }
    }
  }
  write(out, next, n);
  write(velocity, moving, n);
  return out;
}
