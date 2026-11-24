/**
 * What two coefficients make under a combine rule, as the solver mixes them (`kernel/src/solver.rs`). The rule is a code of
 * `combines` in kernel.ts: 0 average, 1 min, 2 multiply, 3 max, 4 clampedSum (the sum, from 0 to 1), 5 geometricMean (the
 * square root of the product, 0 if either is 0). Kept apart from the step path, which holds no `Math`.
 */
export function mixCoefficients(x: number, y: number, rule: number): number {
  if (rule === 5) return x * y > 0 ? Math.sqrt(x * y) : 0;
  if (rule === 4) return x + y > 1 ? 1 : x + y > 0 ? x + y : 0;
  if (rule === 3) return x > y ? x : y;
  if (rule === 2) return x * y;
  if (rule === 1) return x < y ? x : y;
  return (x + y) / 2;
}
