// Independent float64 model of water/rivers for tests: hydrostatically reconstructed virtual-pipe flow (Audusse et
// al. 2004 interface depths; O'Brien & Hodgins 1995 pipes) with Froude and CFL caps, square-footprint sources, and
// Water's edge rule (edge cells hold max(0, level - ground)). Grids are rows of increasing z.
export function riverModel({ ground, width, height, cell, level = -1e9, origin = [0, 0], froude = 4 }) {
  const n = width * height;
  return {
    ground,
    width,
    height,
    cell,
    level,
    origin,
    froude,
    depth: new Float64Array(n),
    flux: new Float64Array(n * 4),
  };
}
const offsets = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
/** One substep of length dt seconds; returns the highest pipe velocity q / depth, m/s. `pipe: 'reconstructed'` is water/rivers; `'surface'` is Water's own coast pipe. */
export function riverStep(m, dt, sources = [], pipe = 'reconstructed') {
  const { width: w, height: h, ground: b, depth: d, cell: l } = m;
  const next = new Float64Array(m.flux.length);
  let peak = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x,
        surface = d[i] + b[i];
      const q = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const nx = x + offsets[k][0],
          ny = y + offsets[k][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx,
          old = m.flux[i * 4 + k] * Math.exp(-dt * 0.12);
        if (pipe === 'surface') {
          q[k] =
            surface > b[j]
              ? Math.min(
                  Math.max(0, old + (dt * 9.81 * d[i] * (surface - d[j] - b[j])) / l),
                  d[i] * Math.min(4 * Math.sqrt(9.81 * d[i]), (0.5 * l) / dt),
                )
              : 0;
        } else {
          const brink = Math.max(b[i], b[j]),
            a = Math.max(0, surface - brink),
            c = Math.max(0, d[j] + b[j] - brink);
          q[k] = Math.min(
            Math.max(old + (dt * 9.81 * a * (a - c)) / l, 0),
            a * Math.min(m.froude * Math.sqrt(9.81 * a), (0.5 * l) / dt),
          );
        }
      }
      const outgoing = (q[0] + q[1] + q[2] + q[3]) / l;
      const scale = Math.min(1, d[i] / Math.max(1e-6, dt * outgoing));
      for (let k = 0; k < 4; k++) {
        next[i * 4 + k] = q[k] * scale;
        if (next[i * 4 + k] > 0) peak = Math.max(peak, next[i * 4 + k] / d[i]);
      }
    }
  m.flux = next;
  const depth = new Float64Array(d.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let flow = -(next[i * 4] + next[i * 4 + 1] + next[i * 4 + 2] + next[i * 4 + 3]);
      if (x > 0) flow += next[(i - 1) * 4 + 1];
      if (x < w - 1) flow += next[(i + 1) * 4];
      if (y > 0) flow += next[(i - w) * 4 + 3];
      if (y < h - 1) flow += next[(i + w) * 4 + 2];
      let v = d[i] + (dt * flow) / l;
      for (const s of sources) {
        const r = s.radius ?? 0;
        // Cells whose centres lie within r, and always the cell under the position.
        const c = [0, 1].map((a) => Math.floor((s.position[a] - m.origin[a]) / l));
        const lo = [0, 1].map((a) =>
          Math.max(Math.min(Math.ceil((s.position[a] - r - m.origin[a]) / l - 0.5), c[a]), 0),
        );
        const hi = [0, 1].map((a, k) =>
          Math.min(Math.max(Math.floor((s.position[a] + r - m.origin[a]) / l - 0.5), c[a]), [w, h][k] - 1),
        );
        if (x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1])
          v += (dt * s.discharge) / ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * l * l);
      }
      v = Math.max(0, v);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) v = Math.max(0, m.level - m.ground[i]);
      depth[i] = v;
    }
  m.depth = depth;
  return peak;
}
