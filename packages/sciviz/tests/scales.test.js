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
