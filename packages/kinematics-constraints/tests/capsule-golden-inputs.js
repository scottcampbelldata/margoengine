// Deterministic inputs for the capsule golden test (tests/capsule-golden.test.js). The expected numbers in
// fixtures/capsule-golden.json were recorded from the code before the allocation fix, so the fix cannot move a result.
export function capsuleCases() {
  let seed = 12345;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const range = (scale) => (next() * 2 - 1) * scale;
  const vec = (scale) => [range(scale), range(scale), range(scale)];
  const cases = [];
  const scales = [1, 1e-3, 1e3, 1e-160, 1e90, 5e-320];
  for (const scale of scales) {
    for (let i = 0; i < 30; i++) {
      cases.push({
        a: vec(scale),
        b: vec(scale),
        c: vec(scale),
        d: vec(scale),
        p: vec(scale),
        radius: Math.abs(range(scale)),
      });
    }
  }
  // Degenerate and aligned shapes: zero-length segments, parallel, collinear, crossing, point on the axis.
  const fixed = [
    [
      [0, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [0, 0, 0],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [0.5, 0, 0],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
      [0.5, 0, 0],
    ],
    [
      [0, 0, 0],
      [1, 1, 1],
      [1, 0, 0],
      [0, 1, 1],
      [0.5, 0.5, 0.5],
    ],
    [
      [0, 0, 0],
      [1, 1, 1],
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.2, 0.2, 0.2],
    ],
    [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    [
      [0, 0, 0],
      [1e-300, 0, 0],
      [0, 1e-300, 0],
      [0, 0, 1e-300],
      [1e-300, 1e-300, 0],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 0, 1e-12],
      [1, 0, 1e-12],
      [3, 4, 5],
    ],
  ];
  for (const [a, b, c, d, p] of fixed) cases.push({ a, b, c, d, p, radius: 0.25 });
  return cases;
}
