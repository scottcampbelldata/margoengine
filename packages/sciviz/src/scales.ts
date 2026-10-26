// Axis scales, CPU only. A scale maps data values to the plot's linear coordinates and back, and picks ticks in data
// units: linear (Heckbert's nice numbers), log (decades, with 2 and 5 between them when the range is short; values at
// or below 0 have no place and map to NaN), and date (milliseconds since 1970 UTC, shifted by an origin so 32-bit
// positions keep their precision, with ticks at whole seconds, minutes, hours, days, months or years in UTC).
import { rangeError } from '../../shared/errors.js';
import { formatTick, ticks, type Ticks } from './ticks.js';

/** How an axis maps data: `'linear'` (default), `'log'` (base 10) or `'date'` (milliseconds since 1970, UTC). */
export type ScaleType = 'linear' | 'log' | 'date';

/** A data-to-plot mapping with ticks in data units. */
export interface Scale {
  readonly type: ScaleType;
  /** Plot coordinate of a data value (NaN where the scale has no place for it). */
  forward(value: number): number;
  /** Data value of a plot coordinate. */
  inverse(value: number): number;
  /** About `count` ticks between data values `min` and `max`, with labels. */
  ticks(min: number, max: number, count?: number): Ticks;
}

const SECOND = 1000,
  MINUTE = 60 * SECOND,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Fixed steps up to two weeks, then calendar months and years.
const FIXED = [
  SECOND,
  2 * SECOND,
  5 * SECOND,
  10 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
];
const CALENDAR_MONTHS = [1, 2, 3, 6];

const pad = (n: number): string => String(n).padStart(2, '0');

/** A tick label for a date (milliseconds since 1970, UTC) at a step of `step` milliseconds (or `months`). */
export function formatDate(ms: number, step: number, months = 0): string {
  const d = new Date(ms);
  if (months >= 12) return String(d.getUTCFullYear());
  if (months) return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (step >= DAY) return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return step >= MINUTE ? time : `${time}:${pad(d.getUTCSeconds())}`;
}

/**
 * About `count` date ticks in [min, max] (milliseconds since 1970, UTC) at whole seconds, minutes, hours, days,
 * weeks (from Monday), months or years.
 */
export function dateTicks(min: number, max: number, count = 6): Ticks {
  if (!Number.isFinite(min) || !Number.isFinite(max))
    throw rangeError(`Date tick range must be finite, got [${min}, ${max}]`, 'sciviz');
  if (min > max) [min, max] = [max, min];
  const span = max - min,
    values: number[] = [];
  const fixed = FIXED.find((s) => span / s <= count);
  if (fixed !== undefined) {
    // Days and longer start at UTC midnight; weeks on a Monday (1970-01-05 was one).
    const offset = fixed === 7 * DAY || fixed === 14 * DAY ? 4 * DAY : 0;
    for (let t = Math.ceil((min - offset) / fixed) * fixed + offset; t <= max; t += fixed) values.push(t);
    return { values, step: fixed, labels: values.map((v) => formatDate(v, fixed)) };
  }
  const months = span / (30.44 * DAY);
  let step = CALENDAR_MONTHS.find((m) => months / m <= count);
  if (step === undefined) {
    // Years at nice multiples.
    const years = Math.max(1, ticks(0, months / 12, count).step);
    step = Math.round(years) * 12 || 12;
  }
  const start = new Date(min),
    month0 = start.getUTCFullYear() * 12 + start.getUTCMonth();
  for (let m = Math.ceil(month0 / step) * step; ; m += step) {
    const t = Date.UTC(Math.floor(m / 12), m % 12, 1);
    if (t > max) break;
    if (t >= min) values.push(t);
  }
  return { values, step: step * 30.44 * DAY, labels: values.map((v) => formatDate(v, 0, step)) };
}

/** A log tick label: 1, 10, 100, 1000, then 1e4 and up (and 0.1, 0.01, 1e-3 and below). */
const formatLog = (v: number): string => {
  const e = Math.round(Math.log10(v));
  if (Math.abs(v - 10 ** e) < 1e-9 * v)
    return e >= -2 && e <= 3 ? formatTick(10 ** e, 10 ** Math.min(e, 0)) : `1e${e}`.replace('-', '−');
  return formatTick(v, 10 ** Math.floor(Math.log10(v)));
};

/** About `count` ticks for a log axis over [min, max] (both above 0): decades, plus 2 and 5 within short ranges. */
export function logTicks(min: number, max: number, count = 6): Ticks {
  if (!(min > 0) || !(max > 0) || !Number.isFinite(min) || !Number.isFinite(max))
    throw rangeError(`Log tick range must be above 0 and finite, got [${min}, ${max}]`, 'sciviz');
  if (min > max) [min, max] = [max, min];
  const lo = Math.floor(Math.log10(min) + 1e-9),
    hi = Math.ceil(Math.log10(max) - 1e-9),
    decades = hi - lo,
    every = Math.max(1, Math.ceil(decades / count)),
    multiples = decades <= 2 ? [1, 2, 5] : decades < count / 2 ? [1, 3] : [1],
    values: number[] = [];
  for (let e = lo; e <= hi; e += every)
    for (const m of multiples) {
      const v = Number((m * 10 ** e).toPrecision(12));
      if (v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9)) values.push(v);
    }
  return { values, step: 0, labels: values.map(formatLog) };
}

/** A scale of `type`. A date scale subtracts `origin` (milliseconds) so positions keep their precision. */
export function axisScale(type: ScaleType = 'linear', origin = 0): Scale {
  if (type === 'log')
    return {
      type,
      forward: (v) => (v > 0 ? Math.log10(v) : Number.NaN),
      inverse: (u) => 10 ** u,
      ticks: (a, b, n) => logTicks(a, b, n),
    };
  if (type === 'date')
    return { type, forward: (v) => v - origin, inverse: (u) => u + origin, ticks: (a, b, n) => dateTicks(a, b, n) };
  if (type !== 'linear')
    throw rangeError(`Axis scale must be 'linear', 'log' or 'date', got ${String(type)}`, 'sciviz');
  return { type, forward: (v) => v, inverse: (u) => u, ticks: (a, b, n) => ticks(a, b, n) };
}
