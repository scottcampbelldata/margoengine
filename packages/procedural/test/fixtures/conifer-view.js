// The orthographic canopy view the conifer tests share (KB-CABIN-FGTREE3, KB-CABIN-LEADER1).
export const NEEDLE = [0.0245, 0.051, 0.0215],
  SNOW = 0.9,
  CELL = 0.02;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const unit = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
// An orthographic view of `canopy` from azimuth `az` and elevation `el` (radians) on a CELL grid, nearest surface per
// cell: its luminance, needle colour mixed with snow by @margoengine/weather/snow's rule at full cover (snow where the
// normal's y passes 0.2, all of it from 0.35), lit by a sky from straight above (a quarter ambient), so the reading does
// not depend on where a moon stands. Per cell also its snow cover (0 to 1) and the surface's height.
export function view(canopy, az, el) {
  const d = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)],
    u = unit([Math.cos(az), 0, -Math.sin(az)]),
    v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]],
    { positions: p, normals: n, indices: I } = canopy,
    count = p.length / 3,
    q = new Float64Array(count * 3);
  for (let i = 0; i < count; i++)
    for (let k = 0; k < 3; k++) {
      const axis = [u, v, d][k];
      q[i * 3 + k] = (p[i * 3] * axis[0] + p[i * 3 + 1] * axis[1] + p[i * 3 + 2] * axis[2]) / (k < 2 ? CELL : 1);
    }
  const x0 = -3 / CELL,
    y0 = -4 / CELL,
    W = 6 / CELL,
    H = 13 / CELL,
    depth = new Float32Array(W * H).fill(-Infinity),
    shade = new Float32Array(W * H),
    snowCover = new Float32Array(W * H),
    height = new Float32Array(W * H);
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t], I[t + 1], I[t + 2]],
      P = [a, b, c].map((i) => [q[i * 3] - x0, q[i * 3 + 1] - y0, q[i * 3 + 2]]),
      area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[1][1] - P[0][1]) * (P[2][0] - P[0][0]);
    if (!area) continue;
    const e1 = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]),
      e2 = [0, 1, 2].map((k) => p[c * 3 + k] - p[a * 3 + k]),
      face = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]],
      normal = unit([0, 1, 2].map((k) => n[a * 3 + k] + n[b * 3 + k] + n[c * 3 + k])),
      facing = face[0] * d[0] + face[1] * d[1] + face[2] * d[2] >= 0 ? 1 : -1,
      snow = smooth(0.2, 0.35, normal[1]),
      albedo = 0.2126 * NEEDLE[0] + 0.7152 * NEEDLE[1] + 0.0722 * NEEDLE[2],
      value = (albedo + (SNOW - albedo) * snow) * (0.25 + Math.max(0, facing * normal[1]));
    const xa = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0]))),
      xb = Math.min(W - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0]))),
      ya = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1]))),
      yb = Math.min(H - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
    for (let y = ya; y <= yb; y++)
      for (let x = xa; x <= xb; x++) {
        const px = x + 0.5,
          py = y + 0.5,
          l0 = ((P[1][0] - px) * (P[2][1] - py) - (P[1][1] - py) * (P[2][0] - px)) / area,
          l1 = ((P[2][0] - px) * (P[0][1] - py) - (P[2][1] - py) * (P[0][0] - px)) / area;
        if (l0 < 0 || l1 < 0 || l0 + l1 > 1) continue;
        const z = l0 * P[0][2] + l1 * P[1][2] + (1 - l0 - l1) * P[2][2],
          i = y * W + x;
        if (z > depth[i]) {
          depth[i] = z;
          shade[i] = value;
          snowCover[i] = snow;
          height[i] = l0 * p[a * 3 + 1] + l1 * p[b * 3 + 1] + (1 - l0 - l1) * p[c * 3 + 1];
        }
      }
  }
  return { W, H, depth, shade, snow: snowCover, height };
}
