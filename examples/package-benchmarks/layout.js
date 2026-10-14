export function grid(count) {
  if (!Number.isInteger(count) || count < 1 || count > 20000) throw new RangeError('Workload count must be 1..20000');
  const points = new Float32Array(count * 4), columns = Math.ceil(Math.sqrt(count)), rows = Math.ceil(count / columns);
  for (let i = 0; i < count; i++) {
    points[i * 4] = (i % columns - (columns - 1) / 2) * 0.4;
    points[i * 4 + 1] = 0.15;
    points[i * 4 + 2] = (Math.floor(i / columns) - (rows - 1) / 2) * 0.4;
  }
  return points;
}
