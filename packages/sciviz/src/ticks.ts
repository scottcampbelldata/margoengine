// Axis ticks at "nice" numbers (1, 2 or 5 times a power of ten), after P. S. Heckbert, "Nice numbers for graph
// labels", Graphics Gems, Academic Press 1990, and labels printed with just enough digits to tell them apart.
// Values are read back from decimal text (ECMA-262, Number from a numeric string: round to nearest) and the step
// is kept at or above the spacing of binary64 doubles at the range's ends (IEEE 754-2019, section 3.4).
import { rangeError } from '../../shared/errors.js';

/** A nice number as `m` times ten to the `e`, m 1, 2 or 5: near `x`, rounded (`round`) or the next one up. */
function niceParts(x: number, round: boolean): { m: number; e: number } {
  let e = Math.floor(Math.log10(x));
  // Below 1e-300 the power of ten is subnormal or zero: scale x up first so the fraction keeps its digits.
  const fraction = (at: number) => (at < -300 ? (x * 1e300) / 10 ** (at + 300) : x / 10 ** at);
  let f = fraction(e);
  if (f >= 10) f = fraction(++e);
  else if (f < 1) f = fraction(--e);
  const m = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return m === 10 ? { m: 1, e: e + 1 } : { m, e };
}

/** k m 10^e (k and m whole numbers) read as decimal text: the nearest double, subnormal or past the range included. */
const decimal = (k: number, m: number, e: number) => Number(`${BigInt(k) * BigInt(m)}e${e}`);

/** A nice number near `x`: 1, 2, 5 or 10 times a power of ten, rounded (`round`) or the next one up. */
export function niceNumber(x: number, round: boolean): number {
  if (!(x > 0) || !Number.isFinite(x)) return 0;
  const { m, e } = niceParts(x, round);
  return decimal(1, m, e);
}

/** Ticks for an axis: values, their step, and labels. */
export interface Ticks {
  readonly values: readonly number[];
  readonly step: number;
  readonly labels: readonly string[];
}

/**
 * About `count` ticks inside [min, max] at nice values (Heckbert's spacing, kept within the range), with labels.
 * A zero-width range gets one tick; a range no nice step lands inside gets its two ends.
 * @example ticks(0, 97) // values 0, 20, 40, 60, 80; labels '0', '20', ...
 */
export function ticks(min: number, max: number, count = 6): Ticks {
  if (!Number.isFinite(min) || !Number.isFinite(max))
    throw rangeError(`Tick range must be finite, got [${min}, ${max}]`, 'sciviz');
  if (!Number.isInteger(count) || count < 2)
    throw rangeError(`Tick count must be a whole number of at least 2, got ${count}`, 'sciviz');
  if (min > max) [min, max] = [max, min];
  if (min === max) return { values: [min], step: 0, labels: [formatTick(min, 0)] };
  // A span past 1e300 (or past the largest double) is measured in units of 1e10, so its nice step stays finite.
  const big = !(max - min <= 1e300),
    span = big ? max / 1e10 - min / 1e10 : max - min,
    spaced = niceParts(span, false),
    target = decimal(1, spaced.m, spaced.e) / (count - 1),
    // The step never falls below one unit in the last place of the range's largest end: ticks stay distinct and
    // the multiple of the step stays a whole number a double counts exactly (below 2^53).
    largest = Math.max(Math.abs(min), Math.abs(max)),
    ulp = largest < 2 ** -1022 ? Number.MIN_VALUE : 2 ** (Math.floor(Math.log2(largest)) - 52),
    least = niceParts(ulp, false),
    nice = target > 0 ? niceParts(target, true) : least,
    candidate = big ? { m: nice.m, e: nice.e + 10 } : nice,
    { m, e } = candidate.e > least.e || (candidate.e === least.e && candidate.m >= least.m) ? candidate : least,
    step = decimal(1, m, e),
    // Each value is the decimal k m 10^e read as a double, so 0.1 x 3 is 0.3; the ends allow a billionth of a step.
    slack = step * 1e-9,
    first = Math.ceil(min / step) - 1,
    last = Math.floor(max / step) + 1,
    values: number[] = [];
  for (let i = 0; i <= last - first; i++) {
    const v = decimal(first + i, m, e);
    if (v >= min - slack && v <= max + slack && Number.isFinite(v)) values.push(v + 0);
  }
  if (!values.length) {
    const width = max - min;
    return { values: [min, max], step: width, labels: [formatTick(min, width), formatTick(max, width)] };
  }
  return { values, step, labels: values.map((v) => formatTick(v, step)) };
}

/**
 * A tick label: fixed notation with the step's decimals, exponent notation for very large or small magnitudes, and
 * a true minus sign never shown on zero. A step of 0 (a lone tick) labels the value with its shortest exact text.
 * @example formatTick(5, 0) // '5'
 */
export function formatTick(value: number, step: number): string {
  if (value === 0 || Object.is(value, -0)) return '0';
  const magnitude = Math.abs(value),
    // No positive finite step (a lone tick) gives the shortest text that reads back as the value: 5 is '5', not '5.000'.
    stepped = step > 0 && step < Infinity;
  let text: string;
  if (magnitude >= 1e6 || magnitude < 1e-4) {
    text = stepped
      ? value.toExponential(Math.min(Math.max(0, Math.floor(Math.log10(magnitude)) - Math.floor(Math.log10(step))), 16))
      : value.toExponential();
    text = text.replace('e+', 'e');
  } else {
    text = stepped ? value.toFixed(Math.min(Math.max(0, -Math.floor(Math.log10(step) + 1e-9)), 20)) : String(value);
  }
  return text.replace(/^-/, '−');
}

/**
 * A value for a tooltip or readout: four significant digits, exponent notation beyond 1e6 or below 1e-4, and a true
 * minus sign.
 * @example formatValue(-0.0012346) // '−0.001235'
 */
export function formatValue(value: number, digits = 4): string {
  if (value === 0 || Object.is(value, -0)) return '0';
  if (!Number.isFinite(value)) return value !== value ? 'NaN' : value > 0 ? '∞' : '−∞';
  const magnitude = Math.abs(value);
  const text =
    magnitude >= 1e6 || magnitude < 1e-4
      ? value
          .toExponential(digits - 1)
          .replace(/\.?0+e/, 'e')
          .replace('e+', 'e')
      : String(Number(value.toPrecision(digits)));
  return text.replace(/^-/, '−');
}
