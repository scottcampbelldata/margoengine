import { rangeError } from '../../shared/errors.js';

/** Fixed SI duration and optional proleptic Gregorian origin. Calendar-specific CF decoding belongs to /cf. */
export interface TemporalTimeUnits {
  readonly unit: 'microseconds' | 'milliseconds' | 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks';
  readonly seconds: number;
  /** Unix milliseconds; undefined for relative durations. */
  readonly epoch?: number;
}
const bad = (text: string) => rangeError(`Temporal units: ${text}`, 'sciviz');
const definitions: readonly [TemporalTimeUnits['unit'], number, readonly string[]][] = [
  ['microseconds', 1e-6, ['us', 'microsecond', 'microseconds']],
  ['milliseconds', 1e-3, ['ms', 'millisecond', 'milliseconds']],
  ['seconds', 1, ['s', 'sec', 'secs', 'second', 'seconds']],
  ['minutes', 60, ['min', 'mins', 'minute', 'minutes']],
  ['hours', 3600, ['h', 'hr', 'hrs', 'hour', 'hours']],
  ['days', 86400, ['d', 'day', 'days']],
  ['weeks', 604800, ['w', 'week', 'weeks']],
];
function epochOf(text: string): number {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(\.\d{1,3})?)?)?\s*(Z|[+-]\d{1,2}(?::?\d{2})?)?$/i.exec(text.trim());
  if (!match) throw bad('origin must be YYYY-MM-DD with optional time, milliseconds and UTC offset');
  const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = '0', zone = 'Z'] = match,
    y = Number(year), m = Number(month), d = Number(day), h = Number(hour), min = Number(minute), sec = Number(second),
    date = new Date(0);
  date.setUTCFullYear(y, m - 1, d); date.setUTCHours(h, min, sec, Number(fraction) * 1000);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || h > 23 || min > 59 || sec > 59)
    throw bad('invalid Gregorian origin (leap seconds are unsupported)');
  let offset = 0;
  if (zone.toUpperCase() !== 'Z') {
    const z = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zone)!;
    if (Number(z[2]) > 23 || Number(z[3] ?? 0) > 59) throw bad('invalid UTC offset');
    offset = (Number(z[2]) * 60 + Number(z[3] ?? 0)) * (z[1] === '-' ? -1 : 1) * 60000;
  }
  return date.getTime() - offset;
}
/** Parse fixed durations or CF-style units since an origin. Months/years reject because they have no fixed calendar duration. */
export function parseTimeUnits(text: string): TemporalTimeUnits {
  if (typeof text !== 'string') throw bad('supply a unit string');
  const match = /^\s*([a-z]+)(?:\s+since\s+(.+))?\s*$/i.exec(text);
  const definition = match && definitions.find((d) => d[2].includes(match[1].toLowerCase()));
  if (!definition || !match) throw bad('unsupported unit; use microseconds, milliseconds, seconds, minutes, hours, days or weeks');
  return { unit: definition[0], seconds: definition[1], ...(match[2] ? { epoch: epochOf(match[2]) } : {}) };
}
/** Convert owned float64 values, preserving NaN. Relative and absolute axes cannot be mixed implicitly. */
export function convertTimeUnits(values: ArrayLike<number>, from: string, to: string): Float64Array {
  const a = parseTimeUnits(from), b = parseTimeUnits(to);
  if ((a.epoch === undefined) !== (b.epoch === undefined)) throw bad('both axes must be relative or both must have origins');
  const scale = a.seconds / b.seconds, shift = ((a.epoch ?? 0) - (b.epoch ?? 0)) / 1000 / b.seconds,
    out = new Float64Array(values.length);
  for (let i = 0; i < out.length; i++) {
    const value = values[i];
    if (typeof value !== 'number' || (!Number.isFinite(value) && !Number.isNaN(value))) throw bad('times must be finite numbers or NaN');
    out[i] = value * scale + shift;
    if (Number.isFinite(value) && !Number.isFinite(out[i])) throw bad('converted time overflows');
  }
  return out;
}
/** A relative value with its canonical unit, or an ISO UTC timestamp for an axis with an origin. */
export function formatTemporalTime(value: number, units: string): string {
  const parsed = parseTimeUnits(units);
  if (!Number.isFinite(value)) throw bad('format value must be finite');
  if (parsed.epoch === undefined) return `${value} ${parsed.unit}`;
  const date = new Date(parsed.epoch + value * parsed.seconds * 1000);
  if (!Number.isFinite(date.getTime())) throw bad('formatted timestamp exceeds the Date range');
  return date.toISOString();
}
