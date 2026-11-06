// The standard easing families (quad to quint, sine, expo, circ, back, elastic, bounce) as they are defined in the
// public easing-function literature (R. Penner's equations; easings.net lists the same curves), written from the
// formulas. cubicBezier follows the CSS Easing Functions Level 1 definition.
import { bezierSolver } from './bezier.js';
import type { Easing } from './index.js';

const { PI, sin, cos, sqrt, pow } = Math;
const inOut =
  (easeIn: Easing): Easing =>
  (t) =>
    t < 0.5 ? easeIn(t * 2) / 2 : 1 - easeIn((1 - t) * 2) / 2;
const out =
  (easeIn: Easing): Easing =>
  (t) =>
    1 - easeIn(1 - t);

const BACK = 1.70158;
const backIn: Easing = (t) => (BACK + 1) * t * t * t - BACK * t * t;
const elasticIn: Easing = (t) =>
  t === 0 || t === 1 ? t : -pow(2, 10 * t - 10) * sin((t * 10 - 10.75) * ((2 * PI) / 3));
const bounceOut: Easing = (t) => {
  const n = 7.5625,
    d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};

/** Quadratic ease-in. */
export const easeInQuad: Easing = (t) => t * t;
/** Quadratic ease-out. */
export const easeOutQuad: Easing = out(easeInQuad);
/** Quadratic ease-in-out. */
export const easeInOutQuad: Easing = inOut(easeInQuad);
/** Cubic ease-in. */
export const easeInCubic: Easing = (t) => t * t * t;
/** Cubic ease-out. */
export const easeOutCubic: Easing = out(easeInCubic);
/** Quartic ease-in. */
export const easeInQuart: Easing = (t) => t * t * t * t;
/** Quartic ease-out. */
export const easeOutQuart: Easing = out(easeInQuart);
/** Quartic ease-in-out. */
export const easeInOutQuart: Easing = inOut(easeInQuart);
/** Quintic ease-in. */
export const easeInQuint: Easing = (t) => t * t * t * t * t;
/** Quintic ease-out. */
export const easeOutQuint: Easing = out(easeInQuint);
/** Quintic ease-in-out. */
export const easeInOutQuint: Easing = inOut(easeInQuint);
/** Sinusoidal ease-in. */
export const easeInSine: Easing = (t) => 1 - cos((t * PI) / 2);
/** Sinusoidal ease-out. */
export const easeOutSine: Easing = (t) => sin((t * PI) / 2);
/** Sinusoidal ease-in-out. */
export const easeInOutSine: Easing = (t) => -(cos(PI * t) - 1) / 2;
/** Exponential ease-in. */
export const easeInExpo: Easing = (t) => (t === 0 ? 0 : pow(2, 10 * t - 10));
/** Exponential ease-out. */
export const easeOutExpo: Easing = (t) => (t === 1 ? 1 : 1 - pow(2, -10 * t));
/** Exponential ease-in-out. */
export const easeInOutExpo: Easing = (t) =>
  t === 0 || t === 1 ? t : t < 0.5 ? pow(2, 20 * t - 10) / 2 : (2 - pow(2, -20 * t + 10)) / 2;
/** Circular ease-in. */
export const easeInCirc: Easing = (t) => 1 - sqrt(1 - t * t);
/** Circular ease-out. */
export const easeOutCirc: Easing = (t) => sqrt(1 - (t - 1) * (t - 1));
/** Circular ease-in-out. */
export const easeInOutCirc: Easing = (t) =>
  t < 0.5 ? (1 - sqrt(1 - 4 * t * t)) / 2 : (sqrt(1 - pow(-2 * t + 2, 2)) + 1) / 2;
/** Ease-in that pulls back below the start before moving (overshoot 10%). */
export const easeInBack: Easing = backIn;
/** Ease-out that overshoots the end by 10% and settles back. */
export const easeOutBack: Easing = out(backIn);
/** Ease-in-out with overshoot at both ends. */
export const easeInOutBack: Easing = (t) => {
  const c = BACK * 1.525;
  return t < 0.5
    ? (pow(2 * t, 2) * ((c + 1) * 2 * t - c)) / 2
    : (pow(2 * t - 2, 2) * ((c + 1) * (t * 2 - 2) + c) + 2) / 2;
};
/** Elastic ease-in: winds up with growing oscillation. */
export const easeInElastic: Easing = elasticIn;
/** Elastic ease-out: overshoots and rings down to the end. */
export const easeOutElastic: Easing = out(elasticIn);
/** Bounce ease-in. */
export const easeInBounce: Easing = out(bounceOut);
/** Bounce ease-out: drops to the end and bounces three times. */
export const easeOutBounce: Easing = bounceOut;
/** Bounce ease-in-out. */
export const easeInOutBounce: Easing = inOut(easeInBounce);

/**
 * CSS `cubic-bezier(x1, y1, x2, y2)` timing function (CSS Easing Functions Level 1). `x1` and `x2` must lie in [0, 1];
 * `y1` and `y2` may overshoot. Solved by Newton iterations with a bisection fallback, accurate to about 1e-6.
 * @throws RangeError when `x1` or `x2` is outside [0, 1] or any argument is not finite.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  if (![x1, y1, x2, y2].every(Number.isFinite) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1)
    throw new RangeError(
      'cubicBezier needs finite points with x1 and x2 in [0, 1]; use values like (0.25, 0.1, 0.25, 1)',
    );
  const solve = bezierSolver(x1, x2),
    cy = 3 * y1,
    by = 3 * (y2 - y1) - cy,
    ay = 1 - cy - by;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const s = solve(t);
    return ((ay * s + by) * s + cy) * s;
  };
}

/**
 * CSS `steps(count, jump-end)`-style staircase: `count` equal jumps, the first at the start when `jumpStart` is true.
 * @throws RangeError when `count` is not a positive integer.
 */
export function steps(count: number, jumpStart = false): Easing {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('steps needs a positive integer count; use steps(4)');
  return (t) => (jumpStart ? Math.min(1, Math.ceil(t * count) / count) : Math.min(1, Math.floor(t * count) / count));
}
