// Independent float64 model of Water's coast flow step (src/coastal.ts, KB-WATER-SWASH1) for tests: the shallow-water
// momentum equation on the staggered grid in the momentum-conservative q-form of Stelling and Duinmeijer 2003
// (https://doi.org/10.1002/fld.537), the local inertial flow depth of Bates, Horritt and Fewtrell 2010
// (https://doi.org/10.1016/j.jhydrol.2010.03.027) for its velocity, the mean depth over the face bed for its pressure,
// Koren-limited u* along a face and first-order upwind across it,
// semi-implicit Manning friction, and the Courant cap of half a cell per step. The faces are kept as the GPU keeps them:
// each cell's (west, east, south, north) outflows, so the depth update and the outflow limit are the shader's. Water's
// edge rule is `level`: edge cells hold max(0, level - ground). It works on riverModel's grid (rivers-reference.js).

const G = 9.81;
/** Depth (m) under which a face carries nothing, as COAST_DRY. */
export const COAST_DRY = 1e-4;
/** Manning's n of the coast flow (sand), as COAST_MANNING. */
export const COAST_MANNING = 0.02;

const koren = (d1, d2) => {
  if (Math.abs(d1) < 1e-12) return 0;
  const r = d2 / d1;
  return 0.5 * d1 * Math.max(0, Math.min(2 * r, (1 + 2 * r) / 3, 2));
};

/**
 * One step of dt seconds of the coast flow on `m` ({ ground, depth, flux, width, height, cell, level }); `manning`
 * defaults to the shader's. Returns the highest face speed |q| / flow depth, m/s.
 */
export function coastStep(m, dt, manning = COAST_MANNING) {
  const { width: w, height: hgt, ground: b, depth: d, flux, cell: l } = m;
  const inside = (x, y, axis) => x >= 0 && y >= 0 && x + (axis === 0 ? 1 : 0) < w && y + (axis === 1 ? 1 : 0) < hgt;
  const at = (x, y) => y * w + x;
  // The discharge across the +axis face of cell (x, y): east (north) outflow less the next cell's west (south).
  const faceQ = (x, y, axis) => {
    if (!inside(x, y, axis)) return 0;
    const i = at(x, y),
      j = axis === 0 ? at(x + 1, y) : at(x, y + 1);
    return axis === 0 ? flux[i * 4 + 1] - flux[j * 4] : flux[i * 4 + 3] - flux[j * 4 + 2];
  };
  const faceDepth = (x, y, axis) => {
    if (!inside(x, y, axis)) return 0;
    const i = at(x, y),
      j = axis === 0 ? at(x + 1, y) : at(x, y + 1);
    return Math.max(d[i] + b[i], d[j] + b[j]) - Math.max(b[i], b[j]);
  };
  const faceU = (x, y, axis) => {
    const h = faceDepth(x, y, axis);
    return h > COAST_DRY ? faceQ(x, y, axis) / h : 0;
  };
  const upwindU = (x, y, axis, qc) => {
    const [ex, ey] = axis === 0 ? [1, 0] : [0, 1];
    if (qc > 0) {
      const u = faceU(x - ex, y - ey, axis);
      return u + koren(u - faceU(x - 2 * ex, y - 2 * ey, axis), faceU(x, y, axis) - u);
    }
    const u = faceU(x, y, axis);
    return u + koren(u - faceU(x + ex, y + ey, axis), faceU(x - ex, y - ey, axis) - u);
  };
  let peak = 0;
  const faceStep = (x, y, axis) => {
    if (!inside(x, y, axis)) return 0;
    const [ex, ey] = axis === 0 ? [1, 0] : [0, 1],
      [tx, ty] = axis === 0 ? [0, 1] : [1, 0],
      i = at(x, y),
      j = at(x + ex, y + ey),
      za = d[i] + b[i],
      zb = d[j] + b[j],
      h = Math.max(za, zb) - Math.max(b[i], b[j]);
    if (h <= COAST_DRY) return 0;
    const q = faceQ(x, y, axis),
      qa = 0.5 * (faceQ(x - ex, y - ey, axis) + q),
      qb = 0.5 * (q + faceQ(x + ex, y + ey, axis));
    let f = (qb * upwindU(x + ex, y + ey, axis, qb) - qa * upwindU(x, y, axis, qa)) / l;
    const qn = 0.5 * (faceQ(x, y, 1 - axis) + faceQ(x + ex, y + ey, 1 - axis)),
      qs = 0.5 * (faceQ(x - tx, y - ty, 1 - axis) + faceQ(x + ex - tx, y + ey - ty, 1 - axis)),
      u = faceU(x, y, axis);
    f += (qn * (qn > 0 ? u : faceU(x + tx, y + ty, axis)) - qs * (qs > 0 ? faceU(x - tx, y - ty, axis) : u)) / l;
    const bf = Math.max(b[i], b[j]), hp = 0.5 * (Math.max(0, za - bf) + Math.max(0, zb - bf));
    let moved = q - dt * f - (dt * G * hp * (zb - za)) / l;
    moved /= 1 + (dt * G * manning * manning * Math.abs(moved)) / Math.pow(h, 7 / 3);
    const cap = (h * 0.5 * l) / dt;
    return Math.max(-cap, Math.min(cap, moved));
  };
  const next = new Float64Array(flux.length);
  for (let y = 0; y < hgt; y++)
    for (let x = 0; x < w; x++) {
      const i = at(x, y),
        q = [
          Math.max(0, -faceStep(x - 1, y, 0)),
          Math.max(0, faceStep(x, y, 0)),
          Math.max(0, -faceStep(x, y - 1, 1)),
          Math.max(0, faceStep(x, y, 1)),
        ],
        scale = Math.min(1, d[i] / Math.max(1e-6, (dt * (q[0] + q[1] + q[2] + q[3])) / l));
      for (let k = 0; k < 4; k++) next[i * 4 + k] = q[k] * scale;
    }
  m.flux = next;
  const depth = new Float64Array(d.length);
  for (let y = 0; y < hgt; y++)
    for (let x = 0; x < w; x++) {
      const i = at(x, y);
      let flow = -(next[i * 4] + next[i * 4 + 1] + next[i * 4 + 2] + next[i * 4 + 3]);
      if (x > 0) flow += next[(i - 1) * 4 + 1];
      if (x < w - 1) flow += next[(i + 1) * 4];
      if (y > 0) flow += next[(i - w) * 4 + 3];
      if (y < hgt - 1) flow += next[(i + w) * 4 + 2];
      let v = Math.max(0, d[i] + (dt * flow) / l);
      if (x === 0 || y === 0 || x === w - 1 || y === hgt - 1) v = Math.max(0, m.level - b[i]);
      depth[i] = v;
    }
  m.depth = depth;
  // The fastest face of the new state: its discharge over its flow depth.
  for (let y = 0; y < hgt; y++)
    for (let x = 0; x < w; x++)
      for (let axis = 0; axis < 2; axis++) {
        if (!inside(x, y, axis)) continue;
        const i = at(x, y),
          j = axis === 0 ? at(x + 1, y) : at(x, y + 1),
          h = Math.max(depth[i] + b[i], depth[j] + b[j]) - Math.max(b[i], b[j]),
          q = axis === 0 ? next[i * 4 + 1] - next[j * 4] : next[i * 4 + 3] - next[j * 4 + 2];
        if (h > COAST_DRY) peak = Math.max(peak, Math.abs(q) / h);
      }
  return peak;
}
