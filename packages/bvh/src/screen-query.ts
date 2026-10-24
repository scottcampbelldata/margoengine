import type { MutableVec3 } from '@margoengine/math';
import { readPoint, type RaycastProjectedPoint, type RaycastProjection } from './projection.js';

/** Owned world point, captured CSS point/depth and distance in CSS pixels from the queried canvas coordinate. */
export interface RaycastSegmentPoint {
  /** World point. */
  point: MutableVec3;
  /** Its CSS canvas point and camera depth. */
  screen: RaycastProjectedPoint;
  /** CSS-pixel distance from `screen` to the queried canvas coordinate. */
  distance: number;
}

/**
 * Immutable inclusive CSS rectangle borrowing one RaycastProjection. It contains no scene or visibility policy.
 * Near rejection and the captured camera belong to the frame, which must outlive this rectangle and its iterators.
 */
export interface RaycastScreenRectangle {
  /** Owned projection when the point is at/after near and inside the inclusive rectangle; otherwise null. */
  project(point: ArrayLike<number>): RaycastProjectedPoint | null;
  /** Owned CSS coordinates in top-left,top-right,bottom-left,bottom-right,center order; duplicates are retained. */
  canvasSamples(): [number, number][];
  /**
   * Copy/validate both endpoints immediately, then lazily sample their projected rectangle intersection at fractions
   * .5,.15,.85,0,1. Endpoint-near rejection and zero-CSS-length endpoint a behavior are retained. Reconstruct each
   * CSS coordinate through closestSegmentPoint, not direct world interpolation; duplicate samples are retained.
   * Every next(), including after exhaustion, rejects after frame/engine disposal. No visibility callback is run.
   * @throws TypeError for malformed XYZ; RangeError for nonfinite/overflowing inputs or reconstruction;
   * MargoError disposed for a dead borrowed frame. Repair inputs or capture a live frame.
   */
  segmentSamples(a: ArrayLike<number>, b: ArrayLike<number>): IterableIterator<RaycastSegmentPoint>;
}

// Segment samples, as fractions of the clipped span, in the order they are yielded.
const FRACTIONS = [0.5, 0.15, 0.85, 0, 1] as const;

/** @internal Finite CSS coordinate validation without coercing caller values. */
export function finiteCanvasPoint(x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new RangeError('Projection canvas coordinates must be finite; supply CSS pixel numbers.');
}

/** @internal Immutable rectangle construction; all externally observable results own their numeric data. */
export function createScreenRectangle(
  projection: RaycastProjection,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  assertLive: () => void,
): RaycastScreenRectangle {
  assertLive();
  finiteCanvasPoint(x1, y1);
  finiteCanvasPoint(x2, y2);
  const left = Math.min(x1, x2),
    right = Math.max(x1, x2),
    top = Math.min(y1, y2),
    bottom = Math.max(y1, y2);
  return Object.freeze({
    project(point: ArrayLike<number>): RaycastProjectedPoint | null {
      assertLive();
      const screen = projection.project(point);
      assertLive();
      return screen && screen.x >= left && screen.x <= right && screen.y >= top && screen.y <= bottom ? screen : null;
    },
    canvasSamples(): [number, number][] {
      assertLive();
      const x = (left + right) / 2,
        y = (top + bottom) / 2;
      if (!Number.isFinite(x) || !Number.isFinite(y))
        throw new RangeError('Projection rectangle center overflowed; reduce canvas coordinates.');
      return [
        [left, top],
        [right, top],
        [left, bottom],
        [right, bottom],
        [x, y],
      ];
    },
    segmentSamples(a: ArrayLike<number>, b: ArrayLike<number>): IterableIterator<RaycastSegmentPoint> {
      assertLive();
      const first = readPoint(a),
        second = readPoint(b);
      assertLive();
      const start = projection.project(first),
        end = projection.project(second);
      let from = 0,
        to = 1,
        accepted = !!start && !!end;
      if (start && end) {
        for (const [p, q] of [
          [start.x - end.x, start.x - left],
          [end.x - start.x, right - start.x],
          [start.y - end.y, start.y - top],
          [end.y - start.y, bottom - start.y],
        ]) {
          if (!Number.isFinite(p) || !Number.isFinite(q))
            throw new RangeError('Projection rectangle segment span overflowed; reduce canvas or world coordinates.');
          if (!p) {
            if (q < 0) {
              accepted = false;
              break;
            }
            continue;
          }
          const t = q / p;
          // Finite bounds may produce an infinite ratio; min/max still clip it exactly to the finite span.
          if (p < 0) from = Math.max(from, t);
          else to = Math.min(to, t);
          if (from > to) {
            accepted = false;
            break;
          }
        }
      }
      assertLive();
      let index = 0;
      const iterator: IterableIterator<RaycastSegmentPoint> = {
        next(): IteratorResult<RaycastSegmentPoint> {
          assertLive();
          while (accepted && start && end && index < FRACTIONS.length) {
            const t = from + (to - from) * FRACTIONS[index++],
              candidate = projection.closestSegmentPoint(
                first,
                second,
                start.x + (end.x - start.x) * t,
                start.y + (end.y - start.y) * t,
              );
            assertLive();
            if (candidate) return { done: false, value: candidate };
          }
          return { done: true, value: undefined };
        },
        [Symbol.iterator](): IterableIterator<RaycastSegmentPoint> {
          assertLive();
          return this;
        },
      };
      return iterator;
    },
  });
}
