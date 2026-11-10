/** Serializable membership shape. Parameters are world/domain units, not normalized inputs. */
export interface FuzzySet {
  kind: 'triangle' | 'trapezoid' | 'left' | 'right' | 'sLeft' | 'sRight' | 'gaussian' | 'singleton';
  points: readonly number[];
}
/** Linguistic variable: named sets and an optional explicit finite sampling domain. */
export interface FuzzyVariable {
  sets: Readonly<Record<string, FuzzySet>>;
  range?: readonly [number, number];
}
/** A named linguistic proposition, compound logic or a linguistic hedge. */
export type FuzzyTerm =
  | { variable: string; set: string }
  | { op: 'and' | 'or'; terms: readonly FuzzyTerm[] }
  | { op: 'not' | 'very' | 'fairly'; term: FuzzyTerm };
/** Mamdani rule. Weight scales antecedent activation (default 1); consequences aggregate by max. */
export interface FuzzyRule {
  if: FuzzyTerm;
  then: { variable: string; set: string } | readonly { variable: string; set: string }[];
  weight?: number;
}
/** A reusable, JSON-serializable rule system. Input and output variables are distinct. */
export interface FuzzyDocument {
  inputs: Readonly<Record<string, FuzzyVariable>>;
  outputs: Readonly<Record<string, FuzzyVariable>>;
  rules: readonly FuzzyRule[];
}
/** Crisp output selection: sampled centroid, sampled mean of maxima or weighted set representatives. */
export type Defuzzification = 'centroid' | 'mean-of-max' | 'max-average';
/** Integration settings. Sampling uses equal-width cell midpoints, including explicit singleton positions. */
export interface FuzzyOptions {
  /** Default centroid. */
  method?: Defuzzification;
  /** Number of midpoint samples, default 256, maximum 1,000,000. */
  samples?: number;
  /** Output when no rule fires (default 0). */
  fallback?: number;
}
/** One clipped output membership function. */
export interface ActivatedSet {
  set: FuzzySet;
  strength: number;
}
const finite = (x: number): void => {
  if (!Number.isFinite(x)) throw new RangeError('Fuzzy value must be finite; supply a finite number');
};
const grade = (x: number): number => {
  finite(x);
  if (x < 0 || x > 1) throw new RangeError('Fuzzy strength must be within 0..1; clamp the rule weight');
  return x;
};
function checked(set: FuzzySet): FuzzySet {
  const counts = { triangle: 3, trapezoid: 4, left: 3, right: 3, sLeft: 2, sRight: 2, gaussian: 4, singleton: 1 };
  if (!Object.hasOwn(counts, set.kind) || set.points.length !== counts[set.kind])
    throw new TypeError('Invalid fuzzy shape; use a membership shape builder');
  set.points.forEach(finite);
  if (set.kind === 'gaussian') {
    if (!(set.points[1] > 0 && set.points[2] < set.points[3] && Number.isFinite(set.points[3] - set.points[2])))
      throw new RangeError('Gaussian needs positive sigma and finite min < max; correct its parameters');
  } else if (
    set.points.some((x, i) => i > 0 && x < set.points[i - 1]) ||
    (set.points.length > 1 &&
      !(set.points[0] < set.points.at(-1)! && Number.isFinite(set.points.at(-1)! - set.points[0])))
  )
    throw new RangeError('Fuzzy shape points must be ordered and span a finite positive width; correct the points');
  return set;
}
const shape = (kind: FuzzySet['kind'], points: number[]): FuzzySet => checked({ kind, points });
/** Triangular membership; equal adjacent points form a vertical shoulder. */
export const triangle = (left: number, peak: number, right: number): FuzzySet => shape('triangle', [left, peak, right]);
/** Trapezoidal membership, including rectangular sets with vertical edges. */
export const trapezoid = (left: number, start: number, end: number, right: number): FuzzySet =>
  shape('trapezoid', [left, start, end, right]);
/** Membership 1 from left through peak, then falling to 0 at right. Outside the domain is 0. */
export const leftShoulder = (left: number, peak: number, right: number): FuzzySet => shape('left', [left, peak, right]);
/** Membership rises from left to peak, then stays 1 through right. Outside the domain is 0. */
export const rightShoulder = (left: number, peak: number, right: number): FuzzySet =>
  shape('right', [left, peak, right]);
/** Smooth quadratic S curve over the finite interval. Left reverses its direction. */
export const sCurve = (left: number, right: number, direction: 'left' | 'right' = 'right'): FuzzySet =>
  shape(direction === 'left' ? 'sLeft' : 'sRight', [left, right]);
/** Gaussian membership over a finite domain (defaults mean +/- 4 sigma). */
export const gaussian = (mean: number, sigma: number, min = mean - 4 * sigma, max = mean + 4 * sigma): FuzzySet =>
  shape('gaussian', [mean, sigma, min, max]);
/** Membership 1 exactly at value and 0 elsewhere. */
export const singleton = (value: number): FuzzySet => shape('singleton', [value]);
function range(set: FuzzySet): readonly [number, number] {
  return set.kind === 'gaussian' ? [set.points[2], set.points[3]] : [set.points[0], set.points.at(-1)!];
}
function sample(set: FuzzySet, value: number): number {
  const p = set.points,
    [min, max] = range(set);
  if (value < min || value > max) return 0;
  if (set.kind === 'singleton') return value === p[0] ? 1 : 0;
  if (set.kind === 'gaussian') return Math.exp(-0.5 * ((value - p[0]) / p[1]) ** 2);
  if (set.kind === 'sLeft' || set.kind === 'sRight') {
    const t = (value - min) / (max - min),
      s = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2;
    return set.kind === 'sLeft' ? 1 - s : s;
  }
  const start = set.kind === 'left' ? min : p[1],
    end = set.kind === 'trapezoid' ? p[2] : set.kind === 'right' ? max : p[1];
  return value >= start && value <= end
    ? 1
    : value < start
      ? (value - min) / (start - min)
      : (max - value) / (max - end);
}
/** Evaluate a membership shape at a crisp value.
 * @throws RangeError or TypeError for invalid shape/value; supply finite ordered builder parameters.
 */
export function membership(set: FuzzySet, value: number): number {
  checked(set);
  finite(value);
  return sample(set, value);
}
/** Build a named proposition. */
export const is = (variable: string, set: string): FuzzyTerm => ({ variable, set });
/** Min conjunction. */
export const and = (...terms: FuzzyTerm[]): FuzzyTerm => ({ op: 'and', terms });
/** Max disjunction. */
export const or = (...terms: FuzzyTerm[]): FuzzyTerm => ({ op: 'or', terms });
/** Complement hedge. */
export const not = (term: FuzzyTerm): FuzzyTerm => ({ op: 'not', term });
/** Squared membership hedge. */
export const very = (term: FuzzyTerm): FuzzyTerm => ({ op: 'very', term });
/** Square-root membership hedge. */
export const fairly = (term: FuzzyTerm): FuzzyTerm => ({ op: 'fairly', term });
const representative = (set: FuzzySet): number => {
  const p = set.points;
  switch (set.kind) {
    case 'triangle':
      return p[1];
    case 'trapezoid':
      return p[1] + (p[2] - p[1]) / 2;
    case 'left':
      return p[0] + (p[1] - p[0]) / 2;
    case 'right':
      return p[1] + (p[2] - p[1]) / 2;
    case 'sLeft':
      return p[0];
    case 'sRight':
      return p[1];
    default:
      return p[0];
  }
};
// Compensate the rounding lost at every addition, including long maxima plateaus.
class Sum {
  value = 0;
  private correction = 0;
  add(value: number): void {
    const adjusted = value - this.correction,
      next = this.value + adjusted;
    this.correction = next - this.value - adjusted;
    this.value = next;
  }
  reset(value = 0): void {
    this.value = value;
    this.correction = 0;
  }
}
/** Defuzzify max-aggregated clipped sets over a finite domain. No activation returns fallback.
 * @throws RangeError or TypeError for invalid sets/options; use finite bounds and supported method/sample count.
 */
export function defuzzify(
  sets: readonly ActivatedSet[],
  options: FuzzyOptions = {},
  domain?: readonly [number, number],
): number {
  const { method = 'centroid', samples = 256, fallback = 0 } = options;
  finite(fallback);
  if (!['centroid', 'mean-of-max', 'max-average'].includes(method))
    throw new TypeError('Unknown defuzzification; use centroid, mean-of-max or max-average');
  if (!Number.isInteger(samples) || samples < 1 || samples > 1_000_000)
    throw new RangeError('Fuzzy samples must be an integer from 1 to 1000000; correct samples');
  for (const item of sets) {
    checked(item.set);
    grade(item.strength);
  }
  const bounds = domain ?? [
    Math.min(...sets.map((item) => range(item.set)[0])),
    Math.max(...sets.map((item) => range(item.set)[1])),
  ];
  if (!sets.length && !domain) return fallback;
  finite(bounds[0]);
  finite(bounds[1]);
  if (bounds[0] > bounds[1] || !Number.isFinite(bounds[1] - bounds[0]))
    throw new RangeError('Fuzzy range must have finite min <= max and finite width; correct the domain');
  const active = sets.filter((item) => item.strength > 0);
  if (!active.length) return fallback;
  if (method === 'max-average') {
    const weight = new Sum(),
      moment = new Sum();
    const scale = Math.max(1, ...active.map((item) => Math.abs(representative(item.set))));
    for (const item of active) {
      weight.add(item.strength);
      moment.add((representative(item.set) / scale) * item.strength);
    }
    return (moment.value / weight.value) * scale;
  }
  const [min, max] = bounds,
    width = max - min;
  const total = new Sum(),
    weighted = new Sum(),
    maxima = new Sum();
  let best = 0,
    count = 0;
  const add = (x: number): void => {
    let y = 0;
    for (const item of active) y = Math.max(y, Math.min(item.strength, sample(item.set, x)));
    total.add(y);
    weighted.add(y * ((x - min) / (width || 1)));
    if (y > best) {
      best = y;
      maxima.reset((x - min) / (width || 1));
      count = 1;
    } else if (y === best && y > 0) {
      maxima.add((x - min) / (width || 1));
      count++;
    }
  };
  if (min === max) add(min);
  else {
    for (let i = 0; i < samples; i++) add(min + width * ((i + 0.5) / samples));
    // Singleton outputs are a discrete domain; integrate those alone rather than giving them arbitrary cell width.
    const singletons = active.filter((item) => item.set.kind === 'singleton');
    if (singletons.length) {
      if (singletons.length !== active.length)
        throw new TypeError('Do not mix discrete singleton and continuous outputs; use separate output variables');
      total.reset();
      weighted.reset();
      maxima.reset();
      best = count = 0;
      for (const x of new Set(singletons.map((item) => item.set.points[0]))) if (x >= min && x <= max) add(x);
    }
  }
  return best === 0
    ? fallback
    : min + width * (method === 'mean-of-max' ? maxima.value / count : weighted.value / total.value);
}

/** Reusable Mamdani system with pure evaluation and JSON designer data. */
export class FuzzySystem {
  private readonly data: FuzzyDocument;
  /** Validate and detach designer data; later edits to the input cannot affect evaluation.
   * @throws TypeError or RangeError for missing variables, sets, cycles or invalid values; correct the named rule.
   */
  constructor(document: FuzzyDocument) {
    const validateVariables = (variables: FuzzyDocument['inputs']): void => {
      for (const variable of Object.values(variables)) {
        if (!Object.keys(variable.sets).length)
          throw new TypeError('Fuzzy variable needs at least one set; add a named membership set');
        Object.values(variable.sets).forEach(checked);
        if (variable.range) {
          variable.range.forEach(finite);
          if (variable.range[0] > variable.range[1] || !Number.isFinite(variable.range[1] - variable.range[0]))
            throw new RangeError('Fuzzy variable range needs finite min <= max; correct its bounds');
        }
      }
    };
    validateVariables(document.inputs);
    validateVariables(document.outputs);
    const lookup = (variables: FuzzyDocument['inputs'], term: { variable: string; set: string }): void => {
      if (!Object.hasOwn(variables, term.variable) || !Object.hasOwn(variables[term.variable].sets, term.set))
        throw new TypeError(`Unknown fuzzy term ${term.variable}.${term.set}; register the variable and set`);
    };
    const path = new Set<FuzzyTerm>();
    const visit = (term: FuzzyTerm, depth: number): void => {
      if (depth > 256 || path.has(term))
        throw new TypeError('Fuzzy expression is cyclic or too deep; flatten the rule');
      path.add(term);
      if ('variable' in term) lookup(document.inputs, term);
      else if (term.op === 'and' || term.op === 'or') {
        if (!term.terms.length) throw new TypeError('Fuzzy AND/OR needs a term; add a proposition');
        for (const child of term.terms) visit(child, depth + 1);
      } else if ('term' in term && ['not', 'very', 'fairly'].includes(term.op)) visit(term.term, depth + 1);
      else throw new TypeError('Unknown fuzzy operator; use and, or, not, very or fairly');
      path.delete(term);
    };
    for (const rule of document.rules) {
      visit(rule.if, 0);
      grade(rule.weight ?? 1);
      const targets = Array.isArray(rule.then) ? rule.then : [rule.then];
      if (!targets.length) throw new TypeError('Fuzzy rule needs a consequence; add an output term');
      for (const target of targets) lookup(document.outputs, target);
    }
    this.data = structuredClone(document);
  }
  /** Return a detached JSON document for designer editing or persistence. */
  toJSON(): FuzzyDocument {
    return structuredClone(this.data);
  }
  /** Evaluate every output independently. All named inputs must be supplied; no state leaks between agents.
   * @throws RangeError or TypeError for absent/non-finite inputs or invalid options; supply all named crisp inputs.
   */
  evaluate(inputs: Readonly<Record<string, number>>, options: FuzzyOptions = {}): Record<string, number> {
    const values = new Map<string, Map<string, number>>();
    for (const [name, variable] of Object.entries(this.data.inputs)) {
      if (!Object.hasOwn(inputs, name)) throw new TypeError(`Missing fuzzy input '${name}'; supply every named input`);
      finite(inputs[name]);
      values.set(name, new Map(Object.entries(variable.sets).map(([key, set]) => [key, sample(set, inputs[name])])));
    }
    const termValue = (term: FuzzyTerm): number => {
      if ('variable' in term) return values.get(term.variable)!.get(term.set)!;
      if ('terms' in term)
        return term.terms.reduce(
          (n, child) => (term.op === 'and' ? Math.min(n, termValue(child)) : Math.max(n, termValue(child))),
          term.op === 'and' ? 1 : 0,
        );
      const value = termValue(term.term);
      return term.op === 'not' ? 1 - value : term.op === 'very' ? value * value : Math.sqrt(value);
    };
    const strengths = new Map<string, Map<string, number>>();
    for (const rule of this.data.rules) {
      const activation = termValue(rule.if) * (rule.weight ?? 1);
      for (const target of Array.isArray(rule.then) ? rule.then : [rule.then]) {
        const output = strengths.get(target.variable) ?? new Map<string, number>();
        strengths.set(target.variable, output);
        output.set(target.set, Math.max(output.get(target.set) ?? 0, activation));
      }
    }
    return Object.fromEntries(
      Object.entries(this.data.outputs).map(([name, variable]) => [
        name,
        defuzzify(
          Object.entries(variable.sets).map(([key, set]) => ({ set, strength: strengths.get(name)?.get(key) ?? 0 })),
          options,
          variable.range,
        ),
      ]),
    );
  }
}
