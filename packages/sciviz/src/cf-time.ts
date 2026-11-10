// CF 1.12 section 4.4. Calendar arithmetic never passes model dates through JavaScript Date.
import { rangeError } from '../../shared/errors.js';
/** CF civil and model calendars without leap-second instants. */
export type CFCalendar =
  | 'standard'
  | 'gregorian'
  | 'proleptic_gregorian'
  | 'julian'
  | 'noleap'
  | '365_day'
  | 'all_leap'
  | '366_day'
  | '360_day';
/** A datetime in its own calendar, with seconds including the fractional part. */
export interface CFDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly calendar: CFCalendar;
}
/** Default calendar standard. Fixed UDUNITS years and months are durations, not calendar increments. */
export interface CFTimeOptions {
  readonly calendar?: CFCalendar;
}
/** Bidirectional reference-time conversion in one calendar. */
export interface CFTimeCodec {
  readonly units: string;
  readonly calendar: CFCalendar;
  readonly secondsPerUnit: number;
  decode(value: number): CFDateTime;
  encode(value: Omit<CFDateTime, 'calendar'>): number;
}
const bad = (s: string) => rangeError(`CF time: ${s}`, 'sciviz');
const leap = (y: number, c: CFCalendar) =>
  c === 'all_leap' ||
  c === '366_day' ||
  (c !== 'noleap' &&
    c !== '365_day' &&
    c !== '360_day' &&
    y % 4 === 0 &&
    (c === 'julian' || y % 100 !== 0 || y % 400 === 0));
function months(y: number, c: CFCalendar): number[] {
  return c === '360_day' ? Array(12).fill(30) : [31, leap(y, c) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
}
// Integer Julian day, at civil midnight (the noon offset cancels). Gregorian/Julian alignment is exact.
function ordinal(y: number, m: number, d: number, c: CFCalendar): number {
  if (c === 'standard' || c === 'gregorian')
    c = y < 1582 || (y === 1582 && (m < 10 || (m === 10 && d < 15))) ? 'julian' : 'proleptic_gregorian';
  if (c === 'julian' || c === 'proleptic_gregorian') {
    const a = Math.floor((14 - m) / 12),
      yy = y + 4800 - a,
      mm = m + 12 * a - 3;
    return (
      d +
      Math.floor((153 * mm + 2) / 5) +
      365 * yy +
      Math.floor(yy / 4) +
      (c === 'julian' ? -32083 : -Math.floor(yy / 100) + Math.floor(yy / 400) - 32045)
    );
  }
  return (
    y * (c === '360_day' ? 360 : c === 'all_leap' || c === '366_day' ? 366 : 365) +
    months(y, c)
      .slice(0, m - 1)
      .reduce((a, b) => a + b, 0) +
    d -
    1
  );
}
function validate(date: Omit<CFDateTime, 'calendar'>, calendar: CFCalendar): void {
  const { year: y, month: m, day: d, hour: h, minute: mn, second: s } = date;
  const effective = (calendar === 'standard' || calendar === 'gregorian') && y < 1582 ? 'julian' : calendar;
  if (
    !Number.isInteger(y) ||
    Math.abs(y) > 1000000 ||
    ((calendar === 'standard' || calendar === 'gregorian' || calendar === 'julian') && y <= 0) ||
    !Number.isInteger(m) ||
    m < 1 ||
    m > 12 ||
    !Number.isInteger(d) ||
    d < 1 ||
    d > months(y, effective)[m - 1] ||
    !Number.isInteger(h) ||
    h < 0 ||
    h > 23 ||
    !Number.isInteger(mn) ||
    mn < 0 ||
    mn > 59 ||
    !Number.isFinite(s) ||
    s < 0 ||
    s >= 60
  )
    throw bad('invalid datetime or outside supported years +/-1000000; leap seconds require an explicit UTC converter');
  if ((calendar === 'standard' || calendar === 'gregorian') && y === 1582 && m === 10 && d >= 5 && d <= 14)
    throw bad('1582-10-05 through 1582-10-14 do not exist in the standard calendar');
}
function dateAt(day: number, c: CFCalendar): [number, number, number] {
  const effective = c === 'standard' || c === 'gregorian' ? (day < 2299161 ? 'julian' : 'proleptic_gregorian') : c;
  let lo = -1000001,
    hi = 1000001;
  for (let i = 0; i < 22; i++) {
    const mid = Math.floor((lo + hi) / 2);
    if (ordinal(mid, 1, 1, effective) <= day) lo = mid;
    else hi = mid;
  }
  let m = 1;
  while (m < 12 && ordinal(lo, m + 1, 1, effective) <= day) m++;
  return [lo, m, day - ordinal(lo, m, 1, effective) + 1];
}
/** Builds an invertible calendar codec for CF reference-time units, including numeric timezone offsets. */
export function cfTimeCodec(units: string, options: CFTimeOptions = {}): CFTimeCodec {
  const calendar = options.calendar ?? 'standard';
  if (
    ![
      'standard',
      'gregorian',
      'proleptic_gregorian',
      'julian',
      'noleap',
      '365_day',
      'all_leap',
      '366_day',
      '360_day',
    ].includes(calendar)
  )
    throw bad(`unsupported calendar ${calendar}; supply a calendar-aware conversion`);
  const match =
    /^\s*([a-zA-Z]+)\s+since\s+([+-]?\d+)-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d+(?:\.\d*)?))?)?(?:\s*(Z|[+-]?\d{1,2}:\d{1,2}|[+-]?\d{1,4}))?\s*$/.exec(
      units,
    );
  if (!match) throw bad('units must be duration since YYYY-MM-DD [HH:MM:SS [timezone]]');
  const scales: Record<string, number> = {
    s: 1,
    sec: 1,
    second: 1,
    seconds: 1,
    ms: 0.001,
    millisecond: 0.001,
    milliseconds: 0.001,
    us: 0.000001,
    microsecond: 0.000001,
    microseconds: 0.000001,
    min: 60,
    minute: 60,
    minutes: 60,
    h: 3600,
    hr: 3600,
    hour: 3600,
    hours: 3600,
    d: 86400,
    day: 86400,
    days: 86400,
    year: 365.242198781 * 86400,
    years: 365.242198781 * 86400,
    month: 365.242198781 * 7200,
    months: 365.242198781 * 7200,
  };
  const scale = scales[match[1]];
  if (!scale) throw bad(`unsupported duration unit ${match[1]}`);
  const base = {
    year: Number(match[2]),
    month: Number(match[3]),
    day: Number(match[4]),
    hour: Number(match[5] ?? 0),
    minute: Number(match[6] ?? 0),
    second: Number(match[7] ?? 0),
  };
  validate(base, calendar);
  const zone = match[8] ?? 'Z',
    z = zone.replace(/^[+-]/, ''),
    parts = z.split(':'),
    zh = zone === 'Z' ? 0 : parts.length === 2 ? Number(parts[0]) : z.length <= 2 ? Number(z) : Number(z.slice(0, -2)),
    zm = zone === 'Z' ? 0 : parts.length === 2 ? Number(parts[1]) : z.length <= 2 ? 0 : Number(z.slice(-2));
  if (zh > 23 || zm > 59) throw bad('timezone offset outside 23:59');
  const baseDay = ordinal(base.year, base.month, base.day, calendar),
    baseSeconds =
      base.hour * 3600 + base.minute * 60 + base.second - (zone.startsWith('-') ? -1 : 1) * (zh * 3600 + zm * 60);
  return Object.freeze({
    units,
    calendar,
    secondsPerUnit: scale,
    decode(value: number): CFDateTime {
      if (!Number.isFinite(value)) throw bad('time value must be finite');
      // Keep epoch and subday separate, avoiding loss of subsecond precision in a large absolute epoch.
      const offset = value * scale + baseSeconds,
        days = Math.floor(offset / 86400),
        rem = offset - days * 86400;
      if (!Number.isSafeInteger(days)) throw bad('time offset exceeds precision');
      const [year, month, day] = dateAt(baseDay + days, calendar),
        hour = Math.floor(rem / 3600),
        minute = Math.floor((rem - hour * 3600) / 60),
        second = rem - hour * 3600 - minute * 60;
      const result = { year, month, day, hour, minute, second, calendar };
      validate(result, calendar);
      return Object.freeze(result);
    },
    encode(value: Omit<CFDateTime, 'calendar'>): number {
      validate(value, calendar);
      return (
        ((ordinal(value.year, value.month, value.day, calendar) - baseDay) * 86400 +
          value.hour * 3600 +
          value.minute * 60 +
          value.second -
          baseSeconds) /
        scale
      );
    },
  });
}
