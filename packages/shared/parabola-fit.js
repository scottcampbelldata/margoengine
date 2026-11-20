// Least squares for y = a + b x + c x^2 over points (x, y): the normal equations, solved by Cramer's rule.
const det3 = (m) =>
  m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
  m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
  m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
/** [a, b, c] of the parabola through the points by least squares, or undefined under three points or when singular. */
export function parabolaFit(xs, ys) {
  if (xs.length < 3) return undefined;
  const m = [0, 0, 0, 0, 0],
    r = [0, 0, 0];
  xs.forEach((x, i) => {
    for (let k = 0; k < 5; k++) m[k] += x ** k;
    for (let k = 0; k < 3; k++) r[k] += ys[i] * x ** k;
  });
  const A = [
      [m[0], m[1], m[2]],
      [m[1], m[2], m[3]],
      [m[2], m[3], m[4]],
    ],
    d = det3(A);
  if (!(Math.abs(d) > 1e-12)) return undefined;
  return [0, 1, 2].map((k) => det3(A.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)))) / d);
}
