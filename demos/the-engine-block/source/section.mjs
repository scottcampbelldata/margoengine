// Slice the exact body's display triangles and cap horizontal bands by even–odd filling.
const quantum = 1e-7;
const snap = value => Math.round(value / quantum) * quantum;

export function makeSection({ positions, indices }, plane) {
  const segments = [];
  const outline = [];
  const levels = new Set();
  const surfaceZ = plane + .000018;
  // A sub-micron bias keeps a plane through a tessellation vertex on one side of that vertex.
  const sample = plane + .00000013;
  const point = (a, b) => {
    const t = (sample - positions[a + 2]) / (positions[b + 2] - positions[a + 2]);
    return [
      snap(positions[a] + t * (positions[b] - positions[a])),
      snap(positions[a + 1] + t * (positions[b + 1] - positions[a + 1])),
    ];
  };
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const crossings = [];
    for (let edge = 0; edge < 3; edge++) {
      const a = indices[triangle + edge] * 3;
      const b = indices[triangle + (edge + 1) % 3] * 3;
      if ((positions[a + 2] < sample) !== (positions[b + 2] < sample)) crossings.push(point(a, b));
    }
    if (crossings.length !== 2) continue;
    const [a, b] = crossings.sort((one, two) => one[1] - two[1]);
    if (a[0] !== b[0] || a[1] !== b[1]) outline.push(...a, surfaceZ, ...b, surfaceZ);
    if (a[1] === b[1]) continue;
    segments.push({ a, b, slope: (b[0] - a[0]) / (b[1] - a[1]) });
    levels.add(a[1]);
    levels.add(b[1]);
  }

  const rows = [...levels].sort((a, b) => a - b);
  const xAt = ({ a, slope }, y) => a[0] + (y - a[1]) * slope;
  const vertices = [], normals = [], faces = [];
  let area = 0;
  for (let i = 1; i < rows.length; i++) {
    const low = rows[i - 1], high = rows[i], middle = (low + high) / 2;
    const crossings = segments.filter(({ a, b }) => a[1] < middle && b[1] > middle)
      .sort((a, b) => xAt(a, middle) - xAt(b, middle));
    if (crossings.length % 2) throw new Error('The section has an unmatched boundary.');
    for (let j = 0; j < crossings.length; j += 2) {
      const left = crossings[j], right = crossings[j + 1];
      const x0 = xAt(left, low), x1 = xAt(right, low);
      const x2 = xAt(right, high), x3 = xAt(left, high);
      const base = vertices.length / 3;
      const bottom = x1 - x0, top = x2 - x3;
      if (bottom + top <= quantum) continue;
      area += (bottom + top) * (high - low) / 2;
      vertices.push(x0, low, surfaceZ, x1, low, surfaceZ, x2, high, surfaceZ, x3, high, surfaceZ);
      normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
      if (bottom > quantum) faces.push(base, base + 1, base + 2);
      if (top > quantum) faces.push(base, base + 2, base + 3);
    }
  }
  return { geometry: { positions: vertices, normals, indices: faces }, outline, area };
}