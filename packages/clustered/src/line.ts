import type { Vec3 } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import type { PointLight } from './index.js';
import type { FlickerOptions } from './flicker.js';

/** Most points `lineLights` places on one segment. */
export const MAX_LINE_SAMPLES = 8;
/**
 * Width of a disc light's 10-90% penumbra in units of `radius * (receiver - blocker) / blocker`: the visible share of
 * a disc past offset t (in radii) is `(acos(t) - t sqrt(1 - t^2)) / pi`, which is 0.1 and 0.9 at t = +-0.687.
 */
export const DISC_PENUMBRA_10_90 = 1.374;

/** `lineLights` settings: a straight light source such as a flame line, a tube or a neon bar. */
export interface LineLightOptions {
  /** One end of the segment, world units. */
  start: Vec3;
  /** The other end. */
  end: Vec3;
  /** Distance where each point's light ends (`PointLight.range`); 0 is unlimited and needs a shadow `far`. */
  range: number;
  /** The whole line's radiance multiplier, shared out by the quadrature weights. Default 1. */
  intensity?: number;
  /** Linear RGB. Default [1, 1, 1]. */
  color?: Vec3;
  /** `PointLight.decay` of every point. Default unset (inverse square). */
  decay?: number;
  /** Gauss-Legendre points along the segment, an integer from 1 to {@link MAX_LINE_SAMPLES}. Default 2. */
  samples?: number;
  /**
   * Size of each point, world units, 0 or more: its sphere radius (`PointLight.radius`, so a highlight on a nearby
   * metal is the source's disc and bounded, never a point's spike) and its shadow radius (`shadow.radius`, PCSS through
   * `LocalShadows`). Default: half the segment's length over `samples`, raised where needed so the penumbrae of
   * neighbouring points meet ({@link lineShadowRadius}). 0 gives hard shadows and point highlights.
   */
  radius?: number;
  /** Shadowed by `LocalShadows` (`@margoengine/clustered/shadows`). Default true; each point renders six cube faces. */
  castShadow?: boolean;
  /** Map settings of every point's shadow besides `radius`. Default `{ near: 0.05 }`. */
  shadow?: { near?: number; far?: number; resolution?: number | readonly [number, number] };
  /**
   * One flicker for the whole line (`animateFlicker` from `@margoengine/clustered/flicker`): every point gets it with
   * the same seed (default 0), so the line brightens and dims as one source.
   */
  flicker?: FlickerOptions;
}
/** A point light made by `lineLights`, with the line's flicker if it has one. */
export type LineLight = PointLight & { flicker?: FlickerOptions };

const cache = new Map<number, { nodes: readonly number[]; weights: readonly number[] }>();
/**
 * Nodes (ascending, in -1 to 1) and weights (summing to 2) of the `n`-point Gauss-Legendre rule, exact for polynomials
 * of degree up to 2n - 1. Newton's method on the Legendre three-term recurrence from the Chebyshev-like first guess
 * cos(pi (i - 1/4) / (n + 1/2)); weight 2 / ((1 - x^2) P_n'(x)^2) (Abramowitz and Stegun 25.4.29).
 * @throws RangeError unless `n` is an integer from 1 to 64.
 */
export function gaussLegendre(n: number): { nodes: readonly number[]; weights: readonly number[] } {
  if (!Number.isInteger(n) || n < 1 || n > 64)
    throw new RangeError('Gauss-Legendre order must be an integer from 1 to 64');
  const hit = cache.get(n);
  if (hit) return hit;
  const nodes = new Array<number>(n),
    weights = new Array<number>(n);
  for (let i = 0; i < Math.ceil(n / 2); i++) {
    let x = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5)),
      slope = 0;
    for (let k = 0; k < 100; k++) {
      let p0 = 1,
        p1 = x;
      for (let j = 2; j <= n; j++) {
        const p2 = ((2 * j - 1) * x * p1 - (j - 1) * p0) / j;
        p0 = p1;
        p1 = p2;
      }
      // n = 1: P_1 = x, P_0 = 1, slope 1.
      slope = n === 1 ? 1 : (n * (x * p1 - p0)) / (x * x - 1);
      const step = p1 / slope;
      x -= step;
      if (Math.abs(step) < 1e-15) break;
    }
    const w = 2 / ((1 - x * x) * slope * slope);
    nodes[n - 1 - i] = x;
    nodes[i] = -x;
    weights[i] = weights[n - 1 - i] = w;
  }
  if (n % 2) nodes[(n - 1) / 2] = 0;
  const rule = { nodes: Object.freeze(nodes), weights: Object.freeze(weights) };
  cache.set(n, rule);
  return rule;
}

/**
 * The default shadow radius of `samples` points on a segment `length` long: `length / (2 samples)`, each point's share
 * of the source, or the radius whose disc penumbra ({@link DISC_PENUMBRA_10_90}) covers half the widest gap between
 * neighbouring points if that is larger (from 6 samples up), so their shadows merge into one at every receiver distance
 * instead of showing as separate copies.
 */
export function lineShadowRadius(length: number, samples = 2): number {
  if (!(length >= 0 && Number.isFinite(length))) throw new RangeError('Line length must be a finite number of 0 or more');
  const { nodes } = gaussLegendre(samples);
  let gap = 0;
  for (let i = 1; i < nodes.length; i++) gap = Math.max(gap, ((nodes[i] - nodes[i - 1]) * length) / 2);
  return Math.max(length / (2 * samples), gap / (2 * DISC_PENUMBRA_10_90));
}

/**
 * Point lights that stand for a straight light source from `start` to `end`: one at each Gauss-Legendre node of the
 * segment, carrying its share of `intensity` (the node's weight / 2), so their summed light on a receiver integrates
 * the line's (exact for an integrand that is a polynomial of degree up to 2 samples - 1 along it). Each is a sphere
 * light that casts a soft shadow, both of {@link lineShadowRadius} by default. Pass them to `Clustered.setLights`, a light group
 * (`@margoengine/clustered/groups`) or `animateFlicker`. Returns new objects each call.
 * @throws TypeError for an end that is not three finite numbers; RangeError for a sample count, intensity, range or
 * radius out of range.
 */
export function lineLights(options: LineLightOptions): LineLight[] {
  const { start, end, range, intensity = 1, color, decay, samples = 2, castShadow = true, shadow, flicker } = options;
  finiteVector(start, 3, 'Line start');
  finiteVector(end, 3, 'Line end');
  if (!Number.isInteger(samples) || samples < 1 || samples > MAX_LINE_SAMPLES)
    throw new RangeError(`Line samples must be an integer from 1 to ${MAX_LINE_SAMPLES}`);
  if (!(intensity >= 0 && Number.isFinite(intensity)))
    throw new RangeError('Line intensity must be a finite number of 0 or more');
  if (!(range >= 0 && Number.isFinite(range))) throw new RangeError('Line range must be a finite number of 0 or more');
  const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]),
    radius = options.radius ?? lineShadowRadius(length, samples);
  if (!(radius >= 0 && Number.isFinite(radius)))
    throw new RangeError('Line shadow radius must be a finite number of 0 or more (world units)');
  const { nodes, weights } = gaussLegendre(samples);
  return nodes.map((x, i) => {
    const t = (x + 1) / 2,
      light: LineLight = {
        position: [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t, start[2] + (end[2] - start[2]) * t],
        range,
        intensity: (intensity * weights[i]) / 2,
        // Each point stands for its share of the line: a sphere of that size, so its reflection on a metal a hand
        // away is bounded by the source's radiance (Karis 2013) instead of a point light's unbounded peak.
        radius,
      };
    if (color) light.color = [color[0], color[1], color[2]];
    if (decay !== undefined) light.decay = decay;
    if (castShadow) {
      light.castShadow = true;
      light.shadow = { near: 0.05, ...shadow, radius };
    }
    if (flicker) light.flicker = { seed: 0, ...flicker };
    return light;
  });
}
