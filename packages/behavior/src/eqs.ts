// Environment queries: collect candidate points, throw out those that fail a condition, score the rest and take the
// best, trying fallback options in order. After M. Jack, "Tactical Position Selection: An Architecture and Query
// Language", Game AI Pro, chapter 26, 2013, which also gives the evaluation order: cheap conditions, cheap weights,
// then expensive criteria on the point that can still score highest, so a point that cannot win never pays for its
// line of sight tests and the result is the same as evaluating everything.

/** A position or direction, `[x, y, z]`. */
export type Point = ArrayLike<number>;

/** A point to consider. */
export interface Candidate<T = unknown> {
  /** World position. */
  readonly position: Point;
  /** For a cover spot, the direction cover faces: from the spot toward what it hides from. */
  readonly facing?: Point;
  /** Anything of yours, handed back in the result: an id, a cover type, an entity. */
  readonly data?: T;
}

/** Something to measure about a candidate. Use it as a condition, a weight, or both. */
export interface Criterion<T = unknown> {
  /** The raw value. Must be finite. */
  value(candidate: Candidate<T>): number;
  /** The range a weight scales to 0..1, clamping outside it. Conditions use the raw value (default `[0, 1]`). */
  readonly limits?: readonly [number, number];
  /** `true` for anything slow, such as a ray or a route: it runs late and only where it can change the answer. */
  readonly expensive?: boolean;
}

/** A filter: a candidate passes when the criterion's raw value is within `min` and `max`. */
export interface QueryCondition<T = unknown> {
  /** What to measure. */
  readonly test: Criterion<T>;
  /** Lowest value that passes (default none). */
  readonly min?: number;
  /** Highest value that passes (default none). */
  readonly max?: number;
}

/** A score: the criterion's value scaled to 0..1 by its limits, times `weight`. */
export interface QueryWeight<T = unknown> {
  /** What to measure. */
  readonly test: Criterion<T>;
  /** Any finite number; negative prefers low values. */
  readonly weight: number;
}

/** One way of finding a point. */
export interface QueryOption<T = unknown> {
  /** The candidates, or a function that makes them on each run; see {@link gridAround} and {@link ringsAround}. */
  readonly candidates: Iterable<Candidate<T>> | (() => Iterable<Candidate<T>>);
  /** Every condition must pass (default none). */
  readonly conditions?: readonly QueryCondition<T>[];
  /** The score is the sum of these (default none: every candidate scores 0 and the first wins). */
  readonly weights?: readonly QueryWeight<T>[];
}

/** A scored candidate. */
export interface QueryResult<T = unknown> extends Candidate<T> {
  /** Sum of the weights; the highest wins. */
  readonly score: number;
  /** Index of the option that found it. */
  readonly option: number;
}

/** Why a candidate was or was not chosen, from {@link explainQuery}. */
export interface QueryExplanation<T = unknown> extends QueryResult<T> {
  /** Index in `conditions` of the first condition it failed, or -1 when it passed. */
  readonly failed: number;
}

/** Options of {@link queryPoints}. */
export interface QueryRunOptions {
  /** Most results to return, best first; more results means more points fully evaluated (default 1). */
  count?: number;
}

const checkPoint = (value: Point, label: string): void => {
  if (
    value == null ||
    value.length < 3 ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1]) ||
    !Number.isFinite(value[2])
  )
    throw new RangeError(`${label} must be [x, y, z] with finite numbers`);
};
const between = (a: Point, b: Point): number =>
  Math.hypot(
    (a[0] as number) - (b[0] as number),
    (a[1] as number) - (b[1] as number),
    (a[2] as number) - (b[2] as number),
  );

/** Candidates on a square grid on the ground plane, `halfSize` each way from `center`, at `center`'s height. */
export function gridAround(center: Point, halfSize: number, spacing: number): () => Candidate<never>[] {
  if (!(halfSize >= 0) || !Number.isFinite(halfSize)) throw new RangeError('gridAround halfSize must be 0 or more');
  if (!(spacing > 0) || !Number.isFinite(spacing)) throw new RangeError('gridAround spacing must be above 0');
  return () => {
    checkPoint(center, 'gridAround center');
    const out: Candidate<never>[] = [];
    const steps = Math.floor(halfSize / spacing);
    for (let z = -steps; z <= steps; z++)
      for (let x = -steps; x <= steps; x++)
        out.push({
          position: [(center[0] as number) + x * spacing, center[1] as number, (center[2] as number) + z * spacing],
        });
    return out;
  };
}

/** Candidates in `rings` circles out to `radius` on the ground plane, `perRing` points each. */
export function ringsAround(center: Point, radius: number, rings = 3, perRing = 12): () => Candidate<never>[] {
  if (!(radius > 0) || !Number.isFinite(radius)) throw new RangeError('ringsAround radius must be above 0');
  if (!Number.isInteger(rings) || rings < 1 || !Number.isInteger(perRing) || perRing < 1)
    throw new RangeError('ringsAround rings and perRing must be whole numbers of 1 or more');
  return () => {
    checkPoint(center, 'ringsAround center');
    const out: Candidate<never>[] = [];
    for (let ring = 1; ring <= rings; ring++) {
      const r = (radius * ring) / rings;
      for (let i = 0; i < perRing; i++) {
        const angle = (2 * Math.PI * i) / perRing;
        out.push({
          position: [
            (center[0] as number) + r * Math.cos(angle),
            center[1] as number,
            (center[2] as number) + r * Math.sin(angle),
          ],
        });
      }
    }
    return out;
  };
}

/**
 * Straight distance from a candidate to `from`. As a weight it scales 0 to `limit`, clamped, so a far point cannot
 * swamp the other weights. `from` is read on every run, so pass the agent's live position.
 */
export function distance(from: Point, limit = 30): Criterion {
  if (!(limit > 0) || !Number.isFinite(limit)) throw new RangeError('distance limit must be above 0');
  return {
    limits: [0, limit],
    value: (candidate) => between(candidate.position, from),
  };
}

/**
 * How much closer a move gets `from` to `goal` for the distance walked (equation 26.1): 1 is straight at it, -1
 * straight away, near 0 is sideways, which makes flanking a condition of `min: -0.1, max: 0.1`. A candidate at `from`
 * scores 0.
 */
export function directness(from: Point, goal: Point): Criterion {
  return {
    limits: [-1, 1],
    value: (candidate) => {
      const walked = between(from, candidate.position);
      return walked === 0 ? 0 : (between(from, goal) - between(candidate.position, goal)) / walked;
    },
  };
}

/**
 * 1 when the candidate is nearer `me` than `rival`, else 0: reaching it first, at equal speeds. Use it as a condition
 * with `min: 1`.
 */
export function reachBefore(me: Point, rival: Point): Criterion {
  return {
    value: (candidate) => (between(candidate.position, me) < between(candidate.position, rival) ? 1 : 0),
  };
}

/**
 * 1 when the line from `from` to the candidate is clear, else 0. Expensive, since a ray is. `min: 1` keeps points in
 * view of a threat and `max: 0` keeps points hidden from it. `height` lifts the candidate end, for a chest or eye
 * height (default 0).
 */
export function visibleFrom(from: Point, lineOfSight: (from: Point, to: Point) => boolean, height = 0): Criterion {
  if (typeof lineOfSight !== 'function') throw new TypeError('visibleFrom lineOfSight must be a function');
  if (!Number.isFinite(height)) throw new RangeError('visibleFrom height must be a finite number');
  const end: [number, number, number] = [0, 0, 0];
  return {
    expensive: true,
    value: (candidate) => {
      end[0] = candidate.position[0] as number;
      end[1] = (candidate.position[1] as number) + height;
      end[2] = candidate.position[2] as number;
      return lineOfSight(from, end) ? 1 : 0;
    },
  };
}

/**
 * 1 when `threat` is within `halfAngle` radians of a candidate's `facing`, else 0: this spot's cover works against
 * that threat. A candidate with no `facing` scores 0. Costs one dot product, no ray.
 */
export function coverFrom(threat: Point, halfAngle = Math.PI / 4): Criterion {
  if (!(halfAngle > 0 && halfAngle <= Math.PI))
    throw new RangeError('coverFrom halfAngle must be radians up to Math.PI');
  const cosine = Math.cos(halfAngle);
  return {
    value: ({ position, facing }) => {
      if (facing == null) return 0;
      const dx = (threat[0] as number) - (position[0] as number);
      const dy = (threat[1] as number) - (position[1] as number);
      const dz = (threat[2] as number) - (position[2] as number);
      const length = Math.hypot(dx, dy, dz) * Math.hypot(facing[0] as number, facing[1] as number, facing[2] as number);
      if (length === 0) return 0;
      return (dx * (facing[0] as number) + dy * (facing[1] as number) + dz * (facing[2] as number)) / length >= cosine
        ? 1
        : 0;
    },
  };
}

const measure = <T>(test: Criterion<T>, candidate: Candidate<T>): number => {
  const value = test.value(candidate);
  if (!Number.isFinite(value)) throw new RangeError('A query criterion must return a finite number');
  return value;
};
const scale = <T>(test: Criterion<T>, value: number): number => {
  const [low, high] = test.limits ?? [0, 1];
  return Math.max(0, Math.min(1, (value - low) / (high - low)));
};
const passes = <T>(condition: QueryCondition<T>, candidate: Candidate<T>): boolean => {
  const value = measure(condition.test, candidate);
  return value >= (condition.min ?? Number.NEGATIVE_INFINITY) && value <= (condition.max ?? Number.POSITIVE_INFINITY);
};

const checkOption = <T>(option: QueryOption<T>): void => {
  if (option == null || typeof option !== 'object' || option.candidates == null)
    throw new TypeError('A query option must be {candidates, conditions, weights}');
  for (const condition of option.conditions ?? []) {
    if (typeof condition?.test?.value !== 'function')
      throw new TypeError('A query condition must be {test, min, max} with a criterion in test');
    if (condition.min === undefined && condition.max === undefined)
      throw new RangeError('A query condition must set min, max or both');
  }
  for (const entry of option.weights ?? []) {
    if (typeof entry?.test?.value !== 'function')
      throw new TypeError('A query weight must be {test, weight} with a criterion in test');
    if (!Number.isFinite(entry.weight)) throw new RangeError('A query weight must be a finite number');
    const [low, high] = entry.test.limits ?? [0, 1];
    if (!(low < high)) throw new RangeError('Criterion limits must be [low, high] with low below high');
  }
};
const collect = <T>(option: QueryOption<T>): Candidate<T>[] => {
  const source = typeof option.candidates === 'function' ? option.candidates() : option.candidates;
  const list = [...source];
  for (const candidate of list) checkPoint(candidate?.position, 'Candidate position');
  return list;
};

interface Row<T> {
  candidate: Candidate<T>;
  /** Order collected, the tie break, so equal scores give the same answer every run. */
  index: number;
  /** How many of the expensive steps have run. */
  step: number;
  /** Score so far. */
  score: number;
  /** The most the steps left can add. */
  bound: number;
}

const before = <T>(a: Row<T>, b: Row<T>): boolean =>
  a.score + a.bound > b.score + b.bound || (a.score + a.bound === b.score + b.bound && a.index < b.index);

const push = <T>(heap: Row<T>[], row: Row<T>): void => {
  let at = heap.length;
  heap.push(row);
  while (at > 0) {
    const parent = (at - 1) >> 1;
    if (!before(row, heap[parent] as Row<T>)) break;
    heap[at] = heap[parent] as Row<T>;
    at = parent;
  }
  heap[at] = row;
};
const pop = <T>(heap: Row<T>[]): Row<T> => {
  const top = heap[0] as Row<T>;
  const last = heap.pop() as Row<T>;
  if (heap.length > 0) {
    let at = 0;
    for (;;) {
      let child = at * 2 + 1;
      if (child >= heap.length) break;
      if (child + 1 < heap.length && before(heap[child + 1] as Row<T>, heap[child] as Row<T>)) child++;
      if (!before(heap[child] as Row<T>, last)) break;
      heap[at] = heap[child] as Row<T>;
      at = child;
    }
    heap[at] = last;
  }
  return top;
};

const runOption = <T>(option: QueryOption<T>, index: number, count: number): QueryResult<T>[] => {
  const conditions = option.conditions ?? [];
  const weights = option.weights ?? [];
  const lateConditions = conditions.filter(({ test }) => test.expensive);
  const lateWeights = weights.filter(({ test }) => test.expensive);
  const earlyConditions = conditions.filter(({ test }) => !test.expensive);
  const earlyWeights = weights.filter(({ test }) => !test.expensive);
  // Remaining[i] is the most the expensive weights from step i on can add; a condition adds nothing.
  const steps = lateConditions.length + lateWeights.length;
  const remaining = new Float64Array(steps + 1);
  for (let i = steps - 1; i >= 0; i--) {
    const entry = i >= lateConditions.length ? (lateWeights[i - lateConditions.length] as QueryWeight<T>) : null;
    remaining[i] = (remaining[i + 1] as number) + (entry ? Math.max(0, entry.weight) : 0);
  }
  const heap: Row<T>[] = [];
  const candidates = collect(option);
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i] as Candidate<T>;
    if (!earlyConditions.every((condition) => passes(condition, candidate))) continue;
    let score = 0;
    for (const { test, weight } of earlyWeights) score += weight * scale(test, measure(test, candidate));
    push(heap, { candidate, index: i, step: 0, score, bound: remaining[0] as number });
  }
  const results: QueryResult<T>[] = [];
  while (heap.length > 0 && results.length < count) {
    const row = pop(heap);
    if (row.step === steps) {
      results.push({ ...row.candidate, score: row.score, option: index });
      continue;
    }
    if (row.step < lateConditions.length) {
      if (!passes(lateConditions[row.step] as QueryCondition<T>, row.candidate)) continue;
    } else {
      const { test, weight } = lateWeights[row.step - lateConditions.length] as QueryWeight<T>;
      row.score += weight * scale(test, measure(test, row.candidate));
    }
    row.step++;
    row.bound = remaining[row.step] as number;
    push(heap, row);
  }
  return results;
};

/**
 * Run a query: the first option that finds anything gives the answer, best first. An empty result means no option
 * had a valid point, which is worth telling your behaviour tree: this behaviour does not fit here. The answer is the
 * one full evaluation gives, ties going to the candidate collected first, but expensive criteria run only on points
 * that could still win.
 * @param options The options to try in order.
 * @throws TypeError or RangeError for a malformed option, or a criterion returning something not finite.
 */
export function queryPoints<T>(options: readonly QueryOption<T>[], run: QueryRunOptions = {}): QueryResult<T>[] {
  const count = run.count ?? 1;
  if (!Number.isInteger(count) || count < 1) throw new RangeError('Query count must be a whole number of 1 or more');
  if (!Array.isArray(options)) throw new TypeError('A query must be an array of options');
  for (const option of options) checkOption(option);
  for (let i = 0; i < options.length; i++) {
    const results = runOption(options[i] as QueryOption<T>, i, count);
    if (results.length > 0) return results;
  }
  return [];
}

/**
 * Every candidate of one option with its score and the first condition it failed, best first, for drawing in a debug
 * view. It runs every criterion on every candidate up to the failure, so keep it out of shipped frames.
 */
export function explainQuery<T>(option: QueryOption<T>): QueryExplanation<T>[] {
  checkOption(option);
  const conditions = option.conditions ?? [];
  const out = collect(option).map((candidate) => {
    const failed = conditions.findIndex((condition) => !passes(condition, candidate));
    let score = 0;
    if (failed < 0)
      for (const { test, weight } of option.weights ?? []) score += weight * scale(test, measure(test, candidate));
    return { ...candidate, score, option: 0, failed };
  });
  return out.sort((a, b) => Number(a.failed >= 0) - Number(b.failed >= 0) || b.score - a.score);
}
