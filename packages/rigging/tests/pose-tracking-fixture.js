// Authored analytic landmarks in Margo coordinates, matching MediaPipe's published topology.
export function bodyPoints() {
  const points = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  const set = (i, p) => {
    points[i] = { x: p[0], y: p[1], z: p[2], visibility: 1 };
  };
  set(0, [0, 1.85, 0.15]);
  set(7, [0.1, 1.85, 0]);
  set(8, [-0.1, 1.85, 0]);
  for (const [, s, a] of [
    ['left', 1, 0],
    ['right', -1, 1],
  ]) {
    set(11 + a, [s * 0.2, 1.6, 0]);
    set(13 + a, [s * 0.55, 1.6, 0]);
    set(15 + a, [s * 0.85, 1.6, 0]);
    set(17 + a, [s * 0.95, 1.6, -0.03]);
    set(19 + a, [s * 0.95, 1.6, 0.03]);
    set(23 + a, [s * 0.12, 1, 0]);
    set(25 + a, [s * 0.12, 0.55, 0]);
    set(27 + a, [s * 0.12, 0.1, 0]);
    set(29 + a, [s * 0.12, 0.05, -0.05]);
    set(31 + a, [s * 0.12, 0.05, 0.15]);
  }
  return points;
}
export function handPoints(side = 'left') {
  const sign = side === 'left' ? 1 : -1,
    points = [{ x: 0, y: 0, z: 0 }];
  for (const [start, z] of [
    [1, 0.05],
    [5, 0.03],
    [9, 0],
    [13, -0.025],
    [17, -0.05],
  ])
    for (let j = 0; j < 4; j++) points[start + j] = { x: sign * (0.07 + j * 0.025), y: 0, z };
  return points;
}
