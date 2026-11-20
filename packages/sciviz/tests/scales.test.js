import test from 'node:test';
import assert from 'node:assert/strict';
import { axisScale, dateTicks, formatDate, logTicks } from '@margoengine/sciviz/maths';

test('log ticks: decades over long ranges, 1-2-5 within short ones; values at or below 0 map to NaN', () => {
  assert.deepEqual(logTicks(1, 1e6).values, [1, 10, 100, 1000, 1e4, 1e5, 1e6]);
  assert.deepEqual(logTicks(1, 1e6).labels, ['1', '10', '100', '1000', '1e4', '1e5', '1e6']);
  assert.deepEqual(logTicks(1, 50).values, [1, 2, 5, 10, 20, 50]);
  assert.deepEqual(logTicks(0.01, 1).labels, ['0.01', '0.02', '0.05', '0.1', '0.2', '0.5', '1']);
  assert.equal(logTicks(1, 1e12, 6).values.length, 7, 'every second decade over 12');
  const log = axisScale('log');
  assert.equal(log.forward(1000), 3);
  assert.ok(Number.isNaN(log.forward(0)) && Number.isNaN(log.forward(-1)));
  assert.equal(log.inverse(2), 100);
  assert.throws(() => logTicks(0, 10), RangeError);
});

test('date ticks fall on whole UTC units and read naturally', () => {
  const day = Date.UTC(2026, 9, 25);
  // Six hours: hourly ticks labelled HH:MM.
  const hours = dateTicks(day + 30 * 60_000, day + 6 * 3_600_000);
  assert.deepEqual(hours.labels, ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00']);
  // Ten days: two-day ticks at UTC midnights (an even number of days since 1970), labelled by day.
  const days = dateTicks(day, day + 10 * 86_400_000);
  assert.equal(days.values[0], day + 86_400_000);
  assert.ok(days.values.every((t) => t % (2 * 86_400_000) === 0));
  assert.deepEqual(days.labels.slice(0, 2), ['Oct 26', 'Oct 28']);
  // A year: every second month, on the first of the month.
  const months = dateTicks(Date.UTC(2025, 0, 15), Date.UTC(2026, 0, 15));
  assert.ok(months.values.every((v) => new Date(v).getUTCDate() === 1));
  assert.deepEqual(months.labels.slice(0, 3), ['Mar 2025', 'May 2025', 'Jul 2025']);
  // Forty years: years at nice steps.
  const years = dateTicks(Date.UTC(1990, 0, 1), Date.UTC(2030, 0, 1));
  assert.deepEqual(years.labels, ['1990', '2000', '2010', '2020', '2030']);
  assert.equal(formatDate(day + 61_000, 1000), '00:01:01');
  // A date scale shifts by its origin, so 32-bit positions keep their precision.
  const s = axisScale('date', day);
  assert.equal(s.forward(day + 5), 5);
  assert.equal(s.inverse(5), day + 5);
  assert.throws(() => axisScale('cubic'), RangeError);
});

test('date ticks cover every year a Date holds and refuse ranges past it', () => {
  const at = (year, month = 0) => {
    const d = new Date(0);
    d.setUTCFullYear(year, month, 1);
    return d.getTime();
  };
  // Years 1 to 100: Date.UTC reads 0 to 99 as 1900 to 1999, so these had no ticks.
  assert.deepEqual(dateTicks(at(1), at(100)).labels, ['20', '40', '60', '80', '100']);
  // Months of a year before 0: a negative month index must not roll back a year.
  const before = dateTicks(at(-1, 0), at(-1, 11));
  assert.deepEqual(
    before.values,
    [0, 2, 4, 6, 8, 10].map((m) => at(-1, m)),
  );
  // Up to the last Date: the year after it is NaN and must end the ticks (it looped forever).
  assert.deepEqual(dateTicks(0, 8.64e15).labels, ['100000', '200000']);
  assert.throws(() => dateTicks(0, 1e17), RangeError);
  assert.throws(() => dateTicks(1e20, 1e20), RangeError, 'a step of a second no longer moves a time this large');
});

test('date ticks below a second, and a zero-width range off a whole second', () => {
  // A range holding no whole second returned no ticks at all: [1.5 s, 1.7 s], and min == max at 1.5 s.
  const t = Date.UTC(2026, 10, 15, 12, 30, 1);
  const short = dateTicks(t + 500, t + 700);
  assert.ok(short.values.length >= 3 && short.step < 1000);
  assert.ok(short.values.every((v) => v >= t + 500 && v <= t + 700));
  assert.deepEqual(short.labels.slice(0, 2), ['12:30:01.50', '12:30:01.55']);
  assert.deepEqual(dateTicks(t + 500, t + 500), { values: [t + 500], step: 0, labels: ['12:30:01.500'] });
  assert.equal(formatDate(t + 999.9, 0.1), '12:30:01.9999');
  assert.equal(formatDate(-1, 1), '23:59:59.999');
  assert.equal(formatDate(t + 999.9996, 0), '12:30:02.000', 'a fraction rounding to a whole second carries');
  // Whole-second ranges keep whole-second ticks and labels.
  assert.deepEqual(dateTicks(t, t + 5000).labels, [
    '12:30:01',
    '12:30:02',
    '12:30:03',
    '12:30:04',
    '12:30:05',
    '12:30:06',
  ]);
});
