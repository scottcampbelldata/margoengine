// The Gothenburg 2000 KRISO/NMRI original KVLCC2 surface grid, z=0 row of kvlcc_bow1.dat and kvlcc2_stn1.dat.
// Merge the shared midship point and take every fourth row point plus the stern. Units are fractions of Lpp.
const HALF_WATERLINE = [
  [-0.5, 0],
  [-0.49804, 0.0038101],
  [-0.49562, 0.0082001],
  [-0.49258, 0.01322],
  [-0.48879, 0.018939],
  [-0.484, 0.025375],
  [-0.47796, 0.032561],
  [-0.47033, 0.040465],
  [-0.46069, 0.048959],
  [-0.44845, 0.057672],
  [-0.43301, 0.066094],
  [-0.41416, 0.074316],
  [-0.39126, 0.081709],
  [-0.36358, 0.086773],
  [-0.33074, 0.089294],
  [-0.29221, 0.090163],
  [-0.24713, 0.090625],
  [-0.19439, 0.090625],
  [-0.13268, 0.090625],
  [-0.060497, 0.090625],
  [0.023702, 0.090625],
  [0.104, 0.090625],
  [0.17264, 0.090625],
  [0.23132, 0.090625],
  [0.28146, 0.089907],
  [0.32416, 0.08623],
  [0.36025, 0.079881],
  [0.39063, 0.072273],
  [0.41619, 0.06429],
  [0.43777, 0.056674],
  [0.45593, 0.049384],
  [0.47118, 0.042528],
  [0.48416, 0.03652],
  [0.49514, 0.031156],
  [0.50433, 0.026197],
  [0.51202, 0.021652],
  [0.51836, 0.017426],
  [0.52199, 0.012065],
  [0.52369, 0.0067587],
  [0.52463, 0.0020862],
  [0.525, 0],
];

/** Close the physical waterline with vertical walls for the isolated reflection model. */
export function kvlcc2Waterline(length, draft, freeboard, stride) {
  const half = HALF_WATERLINE.filter((_point, i) => i % stride === 0);
  const outline = [
    ...half,
    ...half
      .slice(1, -1)
      .reverse()
      .map(([x, z]) => [x, -z]),
  ];
  const n = outline.length;
  const vertices = [-draft, freeboard].flatMap((y) => outline.flatMap(([x, z]) => [-length * x, y, length * z]));
  const triangles = [];
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    triangles.push(i, n + i, next, n + i, n + next, next);
  }
  for (let i = 1; i < n - 1; i++) triangles.push(0, i, i + 1, n, n + i + 1, n + i);
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(triangles) };
}
