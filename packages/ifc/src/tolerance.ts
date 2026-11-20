// IDS 1.0 equality for real numbers (Documentation/ImplementersDocumentation/tolerance.md): x equals v when it lies
// within v -/+ (|v| 1e-6 + 1e-6). The published test cases put values exactly on that band's edges and expect them to
// pass, so an edge is accepted to within the rounding of computing it (8 units in the last place).

/** IDS 1.0's real comparison: `value` lies within target -/+ (|target| 1e-6 + 1e-6), edges included, for either sign. */
export function nearlyEqual(value: number, target: number): boolean {
  const band = Math.abs(target) * 1e-6 + 1e-6,
    slack = 8 * Number.EPSILON * (Math.abs(target) + band);
  return value >= target - band - slack && value <= target + band + slack;
}
