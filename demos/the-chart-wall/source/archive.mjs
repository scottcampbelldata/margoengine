export const fromYear = 1992;
export const untilYear = 2024;
export const minControlYear = 2005;
export const methods = [
  { name: 'Transit', color: '#305c4b', width: 2.8, size: 4, shape: 'round' },
  { name: 'Radial velocity', color: '#a35624', width: 2.35, size: 4.5, shape: 'round' },
  { name: 'Other methods', color: '#66528a', width: 1.9, size: 4.5, shape: 'square' },
];
export const orbitBounds = [.1, 10000, 0, 24];
export const date = year => Date.UTC(year, 0, 1);
export const yearOf = timestamp => new Date(timestamp).getUTCFullYear();

export function selection(rows, cutoff) {
  const dates = Array.from({ length: cutoff - fromYear + 1 }, (_, i) => date(fromYear + i));
  const counts = methods.map(() => new Uint16Array(dates.length));
  const points = methods.map(() => []);
  const [low, high, , top] = orbitBounds;
  let total = 0;
  for (const row of rows) {
    const [year, method, period, radius] = row;
    if (year > cutoff) break;
    total++;
    counts[method][year - fromYear]++;
    if (period >= low && period <= high && radius > 0 && radius <= top) points[method].push(row);
  }
  return { cutoff, total, dates, counts, points };
}

export function chartFrame(snapshot) {
  let peak = 0, peakYear = fromYear;
  for (let index = 0; index < snapshot.dates.length; index++) {
    const n = snapshot.counts.reduce((sum, v) => sum + v[index], 0);
    if (n <= peak) continue;
    peak = n;
    peakYear = fromYear + index;
  }
  return { peak, peakYear, plotted: snapshot.points.reduce((sum, group) => sum + group.length, 0) };
}
