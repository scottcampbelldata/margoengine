// Utility-AI scoring: response curves that map a normalised input to a score in [0, 1], the product of several
// considerations with the compensation factor described by D. Mark and K. Dill ("Improving AI decision modeling through
// utility theory", GDC AI Summit 2010; "Building a better centaur: AI at massive scale", GDC 2015), and a plain
// best-option chooser for code that does not need a behaviour tree.

/** A response curve: maps an input (clamped to [0, 1]) to a score in [0, 1]. */
export type ResponseCurve = (x: number) => number;

const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const finite = (value: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${label} must be a finite number`);
  return value;
};

/**
 * Response curves. Each takes shape parameters and returns a {@link ResponseCurve}; inputs and outputs are clamped
 * to [0, 1], so a consideration can feed `distance / maxDistance` without checking its range.
 */
export const curves = {
  /** `m x + b` (default the identity). */
  linear(slope = 1, intercept = 0): ResponseCurve {
    finite(slope, 'Curve slope');
    finite(intercept, 'Curve intercept');
    return (x) => clamp01(slope * clamp01(x) + intercept);
  },
  /** `x^exponent` (default 2: slow start, fast finish; below 1: fast start). */
  power(exponent = 2): ResponseCurve {
    if (!(finite(exponent, 'Curve exponent') > 0)) throw new RangeError('Curve exponent must be above 0');
    return (x) => clamp01(clamp01(x) ** exponent);
  },
  /** Logistic S-curve centred on `midpoint`, steeper for larger `steepness` (default 10, 0.5). */
  logistic(steepness = 10, midpoint = 0.5): ResponseCurve {
    finite(steepness, 'Curve steepness');
    finite(midpoint, 'Curve midpoint');
    return (x) => clamp01(1 / (1 + Math.exp(-steepness * (clamp01(x) - midpoint))));
  },
  /** 0 below `threshold`, 1 from it on (default 0.5). */
  step(threshold = 0.5): ResponseCurve {
    finite(threshold, 'Curve threshold');
    return (x) => (clamp01(x) >= threshold ? 1 : 0);
  },
  /** `1 - x`: a high input gives a low score. */
  inverse(): ResponseCurve {
    return (x) => 1 - clamp01(x);
  },
} as const;

/**
 * Combine consideration scores (each in [0, 1]) into one score by multiplying them, with Mark and Dill's compensation
 * so an option with many considerations is not punished just for having more of them: each score `s` is raised by
 * `(1 - s) * (1 - 1/n) * s` before the product. Returns 0 when any consideration is 0, and 1 for none.
 * @throws RangeError for a score outside [0, 1] or not finite.
 */
export function combineConsiderations(scores: readonly number[]): number {
  const n = scores.length;
  if (!n) return 1;
  const modification = 1 - 1 / n;
  let total = 1;
  for (const score of scores) {
    if (!(score >= 0 && score <= 1))
      throw new RangeError('Consideration scores must be finite numbers in [0, 1]; pass them through a curve');
    total *= score + (1 - score) * modification * score;
  }
  return total;
}

/** One candidate of {@link chooseBest}. */
export interface UtilityChoice<T> {
  /** What to return when this option wins. */
  value: T;
  /** Its score; non-finite scores are rejected. */
  score: number;
}

/**
 * The value of the highest-scoring option above `threshold` (ties go to the first), or `undefined` when none
 * scores above it.
 * @throws RangeError for a non-finite score.
 */
export function chooseBest<T>(options: Iterable<UtilityChoice<T>>, threshold = 0): T | undefined {
  let best: T | undefined,
    bestScore = Number.NEGATIVE_INFINITY;
  for (const option of options) {
    finite(option.score, 'Utility score');
    if (option.score > threshold && option.score > bestScore) {
      best = option.value;
      bestScore = option.score;
    }
  }
  return best;
}
