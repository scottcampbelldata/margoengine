import type { Spline } from '@margoengine/splines';

/** One periodic road frame sample; open roads retain their one-sided end tangents. */
export function sampleRoadFrame(
  curve: Spline,
  distance: number,
  epsilon: number,
  center: Float64Array,
  before: Float64Array,
  after: Float64Array,
): void {
  const length = curve.length;
  const d = curve.closed && distance === length ? 0 : distance;
  curve.atDistance(d, center);
  const low = d - epsilon,
    high = d + epsilon;
  curve.atDistance(curve.closed && low < 0 ? low + length : Math.max(0, low), before);
  curve.atDistance(curve.closed && high > length ? high - length : Math.min(length, high), after);
}
