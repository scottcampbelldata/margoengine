import type { ComputeContext } from '@margoengine/compute';
import { graph } from '@margoengine/compute/graph';
import type { CsrMatrix } from '@margoengine/compute/sparse';
import type { Spline } from '@margoengine/splines';
import { fault } from '../../shared/errors.js';

/** One road between explicitly authored junction vertices. Units are metres and seconds. */
export interface RoadLink {
  /** Junction at the spline start, an integer vertex index. */
  from: number;
  /** Junction at the spline end, an integer vertex index. */
  to: number;
  /** Centre line; its existing arc length determines travel time. */
  curve: Spline;
  /** Metres per second, finite and positive. Default 50 / 3.6 (50 km/h). */
  speed?: number;
  /** Allowed travel relative to from/to. Default 'both'. */
  direction?: 'both' | 'forward' | 'reverse';
  /** Travel time multiplier, finite and at least 1. Default 1. */
  traffic?: number;
  /** Additional finite nonnegative seconds, applied in each allowed direction. Default 0. */
  delay?: number;
}

/** Explicit topology and road costs. No spatial welding or intersection detection occurs. */
export interface RoadGraphOptions {
  /** Number of junction vertices, an integer 0..65536. Includes isolated vertices. */
  vertices: number;
  /** At most 65536 roads; omit closed roads. Empty by default. */
  roads?: readonly RoadLink[];
  /** Checks before input reading and before synchronous upload. Default none. */
  signal?: AbortSignal;
}

/** Build a caller-owned compute graph with travel seconds as weights; reuse compute/graph for routing. */
export function roadGraph(gpu: ComputeContext, { vertices, roads = [], signal }: RoadGraphOptions): CsrMatrix {
  signal?.throwIfAborted();
  const invalid = () => fault('failed', 'Road graph needs 0..65536 vertices/roads, valid junction indices, positive finite lengths/speeds and normal float32 travel seconds', 'road');
  if (!Number.isInteger(vertices) || vertices < 0 || vertices > 65536 || !Array.isArray(roads) || roads.length > 65536) throw invalid();
  const sources: number[] = [], targets: number[] = [], weights: number[] = [];
  for (const link of roads) {
    if (!link) throw invalid();
    const { from, to, curve, speed = 50 / 3.6, direction = 'both', traffic = 1, delay = 0 } = link;
    const length = curve?.length;
    if (![from, to].every(v => Number.isInteger(v) && v >= 0 && v < vertices) ||
      ![length, speed].every(v => Number.isFinite(v) && v > 0) ||
      !Number.isFinite(traffic) || traffic < 1 || !Number.isFinite(delay) || delay < 0 ||
      !['both', 'forward', 'reverse'].includes(direction)) throw invalid();
    const weight = Math.fround(length / speed * traffic + delay);
    // Keep every simple path's sum finite and avoid backend-dependent subnormal flushing.
    if (!(weight >= 2 ** -126 && weight <= 2 ** 127 / Math.max(1, vertices))) throw invalid();
    if (direction !== 'reverse') { sources.push(from); targets.push(to); weights.push(weight); }
    if (direction !== 'forward') { sources.push(to); targets.push(from); weights.push(weight); }
  }
  signal?.throwIfAborted();
  return graph(gpu, { vertices, sources, targets, weights });
}
