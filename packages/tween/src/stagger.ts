import { createRandom } from '@margoengine/math/mathutils';
import type { Easing, Timeline, TimelineTweenOptions, Tween, TweenOptions } from './index.js';

/** Where a stagger starts: an end of the list, its middle, both ends at once, a shuffled order, or an index. */
export type StaggerFrom = 'start' | 'end' | 'center' | 'edges' | 'random' | number;

/** How the start times of a stagger are spread. Give `each` or `amount`; a bare number means `each`. */
export interface StaggerOptions {
  /** Seconds between neighbours, finite and >= 0. Default 0.1 when `amount` is not given. */
  each?: number;
  /** Seconds from the first start to the last, shared across all targets; finite and >= 0. */
  amount?: number;
  /** Which target starts first. Default 'start'. */
  from?: StaggerFrom;
  /** Bends the spread: 0..1 position in the order in, 0..1 share of the total out. Default even. Below 0 counts as 0. */
  easing?: Easing;
  /** `[columns, rows]`: targets are a grid, read row by row, and the stagger spreads from a cell by distance. */
  grid?: readonly [number, number];
  /** Seed of `from: 'random'`; the same seed gives the same order. Default 1. */
  seed?: number;
}

/** {@link TweenOptions} plus the spread. `delay` is added to every target; `onComplete` runs once, after the last. */
export interface StaggerTweenOptions extends TweenOptions {
  stagger: number | StaggerOptions;
}

/** {@link TimelineTweenOptions} plus the spread. `at` places the first start. */
export interface StaggerTimelineOptions extends TimelineTweenOptions {
  stagger: number | StaggerOptions;
}

/** The end value of every target, or a function of the target and its index in the list. */
export type StaggerValue<T> = number | ((target: T, index: number) => number);

const even: Easing = (t) => t;
const FROM = new Set<unknown>(['start', 'end', 'center', 'edges', 'random']);

/** A shuffled order: `out[i]` is the rank of target `i`. */
function shuffled(count: number, seed: number): Float64Array {
  const order = Array.from({ length: count }, (_, i) => i),
    random = createRandom(seed),
    out = new Float64Array(count);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  order.forEach((target, rank) => {
    out[target] = rank;
  });
  return out;
}

/** How far each target sits from where the stagger starts: index steps, or cells on a grid. */
function distances(count: number, from: StaggerFrom, grid: readonly [number, number] | undefined): Float64Array {
  const out = new Float64Array(count),
    [columns, rows] = grid ?? [count, 1],
    last = count - 1;
  // The cell it spreads from. 'end' is the last target, which need not be the corner of a grid with a short last row.
  const origin = from === 'start' ? 0 : from === 'end' ? last : typeof from === 'number' ? from : undefined,
    x0 = origin === undefined ? (columns - 1) / 2 : origin % columns,
    y0 = origin === undefined ? (rows - 1) / 2 : Math.floor(origin / columns);
  for (let i = 0; i < count; i++) {
    const x = i % columns,
      y = Math.floor(i / columns);
    out[i] =
      from === 'edges'
        ? grid
          ? Math.min(x, columns - 1 - x, y, rows - 1 - y)
          : Math.min(i, last - i)
        : Math.hypot(x - x0, y - y0);
  }
  return out;
}

/**
 * The start offset in seconds of each of `count` targets; the earliest is 0.
 * @throws RangeError for a bad count or option, both `each` and `amount`, or a `from` index outside the list.
 */
export function staggerDelays(count: number, options: number | StaggerOptions = {}): Float64Array {
  const {
    each,
    amount,
    from = 'start',
    easing = even,
    grid,
    seed = 1,
  }: StaggerOptions = typeof options === 'number' ? { each: options } : options;
  const gap = each ?? 0.1;
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    (each !== undefined && amount !== undefined) ||
    !Number.isFinite(gap) ||
    gap < 0 ||
    (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) ||
    typeof easing !== 'function' ||
    !Number.isFinite(seed)
  )
    throw new RangeError(
      'Invalid stagger; use an integer count, and each or amount (not both) as finite seconds >= 0 with an easing function',
    );
  if (typeof from === 'number' ? !Number.isInteger(from) || from < 0 || (count > 0 && from >= count) : !FROM.has(from))
    throw new RangeError("Invalid stagger from; use 'start', 'end', 'center', 'edges', 'random' or a target index");
  if (grid && (grid.length !== 2 || !grid.every((n) => Number.isInteger(n) && n > 0) || grid[0] * grid[1] < count))
    throw new RangeError('Invalid stagger grid; use [columns, rows] of whole numbers with room for every target');
  const out = from === 'random' ? shuffled(count, seed) : distances(count, from, grid);
  let low = Infinity,
    high = -Infinity;
  for (const d of out) {
    low = Math.min(low, d);
    high = Math.max(high, d);
  }
  const span = high - low,
    total = amount ?? gap * span;
  for (let i = 0; i < count; i++) {
    const offset = span > 0 ? total * easing((out[i] - low) / span) : 0;
    if (!Number.isFinite(offset)) throw new RangeError('A stagger easing must return a finite number');
    out[i] = Math.max(0, offset);
  }
  return out;
}

const endValue = <T>(to: StaggerValue<T>, target: T, index: number): number =>
  typeof to === 'function' ? to(target, index) : to;

/**
 * Start the same tween on every target, each later than the one before, from one call. Returns a function that cancels
 * them all. With no targets, `onComplete` runs at once.
 *
 * ```ts
 * stagger(tween, lamps, 'intensity', 3, {duration: 0.5, stagger: {each: 0.05, from: 'center'}});
 * ```
 * @throws RangeError for anything {@link staggerDelays} or `Tween.to` refuses; then no target is left running.
 */
export function stagger<T extends object>(
  tween: Tween,
  targets: Iterable<T>,
  key: keyof T & string,
  to: StaggerValue<T>,
  { stagger: spread, delay = 0, onComplete, ...options }: StaggerTweenOptions,
): () => void {
  const list = Array.from(targets),
    delays = staggerDelays(list.length, spread),
    cancels: (() => void)[] = [],
    cancel = () => {
      for (const stop of cancels) stop();
    };
  if (!list.length) onComplete?.();
  let left = list.length;
  const finished = onComplete && (() => void (--left || onComplete()));
  try {
    list.forEach((target, i) => {
      const track = { ...options, delay: delay + delays[i], onComplete: finished };
      cancels.push(tween.to(target as Record<string, number>, key, endValue(to, target, i), track));
    });
  } catch (error) {
    cancel();
    throw error;
  }
  return cancel;
}

/**
 * Add the same tween of every target to a timeline, each later than the one before. Returns the timeline.
 *
 * ```ts
 * timeline.label('in');
 * staggerTimeline(timeline, cards, 'opacity', 1, {duration: 0.4, at: 'in', stagger: {amount: 0.6}});
 * ```
 * @throws RangeError for anything {@link staggerDelays} or `Timeline.to` refuses.
 */
export function staggerTimeline<T extends object>(
  timeline: Timeline,
  targets: Iterable<T>,
  key: keyof T & string,
  to: StaggerValue<T>,
  { stagger: spread, at = timeline.duration, ...options }: StaggerTimelineOptions,
): Timeline {
  const list = Array.from(targets),
    delays = staggerDelays(list.length, spread);
  list.forEach((target, i) => {
    // A label takes its offset as text; nine places is a nanosecond.
    const start = typeof at === 'number' ? at + delays[i] : `${at}+${delays[i].toFixed(9)}`;
    timeline.to(target as Record<string, number>, key, endValue(to, target, i), { ...options, at: start });
  });
  return timeline;
}
