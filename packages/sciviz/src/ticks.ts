// Axis ticks at "nice" numbers (1, 2 or 5 times a power of ten), after P. S. Heckbert, "Nice numbers for graph
// labels", Graphics Gems, Academic Press 1990, and labels printed with just enough digits to tell them apart.
import { rangeError } from '../../shared/errors.js';

/** A nice number near `x`: 1, 2, 5 or 10 times a power of ten, rounded (`round`) or the next one up. */
export function niceNumber(x: number, round: boolean): number {
  if (!(x > 0) || !Number.isFinite(x)) return 0;
  const exponent = Math.floor(Math.log10(x)),
    fraction = x / 10 ** exponent;
  const nice = round
    ? fraction < 1.5
      ? 1
      : fraction < 3
        ? 2
        : fraction < 7
          ? 5
          : 10
    : fraction <= 1
      ? 1
      : fraction <= 2
        ? 2
        : fraction <= 5
          ? 5
          : 10;
  return nice * 10 ** exponent;
}

/** Ticks for an axis: values, their step, and labels. */
export interface Ticks {
  readonly values: readonly number[];
  readonly step: number;
  readonly labels: readonly string[];
}

/**
 * About `count` ticks inside [min, max] at nice values (Heckbert's spacing, kept within the range), with labels.
 * A zero-width range gets one tick.
 * @example ticks(0, 97) // values 0, 20, 40, 60, 80; labels '0', '20', ...
 */
export function ticks(min: number, max: number, count = 6): Ticks {
  if (!Number.isFinite(min) || !Number.isFinite(max))
    throw rangeError(`Tick range must be finite, got [${min}, ${max}]`, 'sciviz');
  if (!Number.isInteger(count) || count < 2)
    throw rangeError(`Tick count must be a whole number of at least 2, got ${count}`, 'sciviz');
  if (min > max) [min, max] = [max, min];
  if (min === max) return { values: [min], step: 0, labels: [formatTick(min, 0)] };
  const step = niceNumber(niceNumber(max - min, false) / (count - 1), true),
    first = Math.ceil(min / step - 1e-9),
    last = Math.floor(max / step + 1e-9),
    values: number[] = [];
  // Multiply rather than accumulate, so 0.1 * 3 stays 0.3 after rounding to the step's digits.
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  for (let k = first; k <= last; k++) values.push(Number((k * step).toFixed(Math.min(20, digits + 2))));
  return { values, step, labels: values.map((v) => formatTick(v, step)) };
}

/**
 * A tick label: fixed notation with the step's decimals, exponent notation for very large or small magnitudes, and
 * a true minus sign never shown on zero.
 */
export function formatTick(value: number, step: number): string {
  if (value === 0 || Object.is(value, -0)) return '0';
  const magnitude = Math.abs(value);
  let text: string;
  if (magnitude >= 1e6 || magnitude < 1e-4) {
    const digits = step > 0 ? Math.max(0, Math.floor(Math.log10(magnitude)) - Math.floor(Math.log10(step))) : 3;
    text = value.toExponential(Math.min(digits, 6)).replace('e+', 'e');
  } else {
    const decimals = step > 0 ? Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) : 3;
    text = value.toFixed(Math.min(decimals, 12));
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
