// The liquid's grid (FLUID-03): a marker-and-cell grid of nx by ny by nz cubes of side h, velocity on the faces and
// pressure at the centres, and the pressure projection with a free surface. Sources (read as text; no code;
// docs/clean-room.md "Grid-particle liquids"):
// - R. Bridson and M. Muller-Fischer, "Fluid simulation", SIGGRAPH 2007 course notes, and R. Bridson, Fluid Simulation for
//   Computer Graphics, 2nd ed., 2015: the MAC grid, the pressure Poisson system, the modified incomplete Cholesky
//   preconditioner MIC(0) with tau = 0.97 and its guard, conjugate gradients.
// - F. Gibou, R. Fedkiw, L.-T. Cheng and M. Kang, "A second-order-accurate symmetric discretization of the Poisson
//   equation on irregular domains", J. Comput. Phys. 176, 205-227, 2002 (as the course notes give it): at a face between a
//   liquid cell and an air cell, the surface sits theta = phi_i / (phi_i - phi_j) of the way across, the air's pressure is
//   taken as the ghost value -(1 - theta) / theta p_i, which adds (1 - theta) / theta to the diagonal; theta is held at or
//   above a floor so the system stays well conditioned.
// Solid cells are walls (the face between a liquid and a solid cell takes the solid's velocity, 0 in the grid's frame).

/** Cell kinds. */
export const AIR = 0;
/** Cell kind of a grid cell that holds liquid. */
export const LIQUID = 1;
/** Cell kind of a grid cell that is a solid boundary. */
export const SOLID = 2;

/** The smallest share of a cell the surface may sit from a liquid cell's centre in the ghost-fluid rule. */
export const THETA_FLOOR = 1e-2;

/** A MAC grid's sizes and the index helpers. */
export interface GridShape {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly h: number;
}

/** The index of cell (i, j, k). */
export const cell = (g: GridShape, i: number, j: number, k: number): number => i + g.nx * (j + g.ny * k);
/** The index of the x face (i, j, k), i from 0 to nx. */
export const faceU = (g: GridShape, i: number, j: number, k: number): number => i + (g.nx + 1) * (j + g.ny * k);
/** The index of the y face (i, j, k), j from 0 to ny. */
export const faceV = (g: GridShape, i: number, j: number, k: number): number => i + g.nx * (j + (g.ny + 1) * k);
/** The index of the z face (i, j, k), k from 0 to nz. */
export const faceW = (g: GridShape, i: number, j: number, k: number): number => i + g.nx * (j + g.ny * k);

/**
 * Makes the velocity divergence-free in the liquid (or of divergence `source`, per cell, where given): solves for the pressure (Pa) with a free surface at phi = 0 (phi at
 * the cell centres, negative in the liquid) and solid walls, and subtracts dt / rho grad p from the face velocities.
 * Returns the conjugate-gradient iterations it took. `pressure` holds the result, and starts the solve.
 */
export function project(
  g: GridShape,
  kind: Uint8Array,
  phi: Float64Array,
  u: Float64Array,
  v: Float64Array,
  w: Float64Array,
  dt: number,
  rho: number,
  pressure: Float64Array,
  open: readonly boolean[] = [false, false, false, false, false, false],
  prescribed: readonly boolean[] = [false, false, false, false, false, false],
  tolerance = 1e-6,
  maxIterations = 400,
  source?: Float64Array,
): number {
  const { nx, ny, nz, h } = g,
    n = nx * ny * nz,
    scale = dt / (rho * h * h),
    diag = new Float64Array(n),
    ax = new Float64Array(n),
    ay = new Float64Array(n),
    az = new Float64Array(n),
    rhs = new Float64Array(n);
  // The matrix (diagonal, and the coupling to the +x, +y, +z neighbour), and minus the divergence.
  const ghost = (i: number, j: number): number => {
    const theta = Math.max(THETA_FLOOR, phi[i]! / (phi[i]! - phi[j]!));
    return scale / theta;
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = cell(g, i, j, k);
        if (kind[c] !== LIQUID) continue;
        // -x, +x, -y, +y, -z, +z neighbours.
        const nbrs: [number, number][] = [
          [i > 0 ? cell(g, i - 1, j, k) : -1, 0],
          [i < nx - 1 ? cell(g, i + 1, j, k) : -1, 1],
          [j > 0 ? cell(g, i, j - 1, k) : -1, 2],
          [j < ny - 1 ? cell(g, i, j + 1, k) : -1, 3],
          [k > 0 ? cell(g, i, j, k - 1) : -1, 4],
          [k < nz - 1 ? cell(g, i, j, k + 1) : -1, 5],
        ];
        for (const [o, side] of nbrs) {
          // Outside the grid is a wall, or the air on an open side (the surface half a cell out).
          if (o < 0) {
            if (open[side]) diag[c]! += scale / Math.max(THETA_FLOOR, -phi[c]! / (-phi[c]! + 0.5 * h));
            continue;
          }
          if (kind[o] === SOLID) continue;
          if (kind[o] === LIQUID) {
            diag[c]! += scale;
            if (side === 1) ax[c] = -scale;
            if (side === 3) ay[c] = -scale;
            if (side === 5) az[c] = -scale;
          } else diag[c]! += ghost(c, o);
        }
        // Minus the divergence, the walls' faces at rest.
        const solidOrOut = (o: number) => o === -1 || (o >= 0 && kind[o] === SOLID);
        // An open side's outside is air: its face keeps its velocity.
        // An open side's outside is air, and a prescribed side's boundary face holds the velocity it was given (the sea's
        // inflow or outflow): either way the face keeps its velocity.
        for (let side = 0; side < 6; side++)
          if ((open[side] || prescribed[side]) && nbrs[side]![0] < 0) nbrs[side]![0] = -2;
        const uL = solidOrOut(nbrs[0]![0]) ? 0 : u[faceU(g, i, j, k)]!,
          uR = solidOrOut(nbrs[1]![0]) ? 0 : u[faceU(g, i + 1, j, k)]!,
          vD = solidOrOut(nbrs[2]![0]) ? 0 : v[faceV(g, i, j, k)]!,
          vU = solidOrOut(nbrs[3]![0]) ? 0 : v[faceV(g, i, j + 1, k)]!,
          wB = solidOrOut(nbrs[4]![0]) ? 0 : w[faceW(g, i, j, k)]!,
          wF = solidOrOut(nbrs[5]![0]) ? 0 : w[faceW(g, i, j, k + 1)]!;
        // The divergence the velocity is to have, `source` (0 but in the density projection), less what it has.
        rhs[c] = (source ? source[c]! : 0) - (uR - uL + vU - vD + wF - wB) / h;
      }
  // MIC(0) (Bridson 2015, ch. 5): tau = 0.97, and sigma = 0.25 guards a small pivot.
  const precon = new Float64Array(n),
    tau = 0.97,
    sigma = 0.25;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = cell(g, i, j, k);
        if (kind[c] !== LIQUID) continue;
        const cx = i > 0 ? cell(g, i - 1, j, k) : -1,
          cy = j > 0 ? cell(g, i, j - 1, k) : -1,
          cz = k > 0 ? cell(g, i, j, k - 1) : -1,
          px = cx >= 0 && kind[cx] === LIQUID ? ax[cx]! * precon[cx]! : 0,
          py = cy >= 0 && kind[cy] === LIQUID ? ay[cy]! * precon[cy]! : 0,
          pz = cz >= 0 && kind[cz] === LIQUID ? az[cz]! * precon[cz]! : 0;
        let e =
          diag[c]! -
          px * px -
          py * py -
          pz * pz -
          tau *
            ((cx >= 0 && kind[cx] === LIQUID ? ax[cx]! * (ay[cx]! + az[cx]!) * precon[cx]! * precon[cx]! : 0) +
              (cy >= 0 && kind[cy] === LIQUID ? ay[cy]! * (ax[cy]! + az[cy]!) * precon[cy]! * precon[cy]! : 0) +
              (cz >= 0 && kind[cz] === LIQUID ? az[cz]! * (ax[cz]! + ay[cz]!) * precon[cz]! * precon[cz]! : 0));
        if (e < sigma * diag[c]!) e = diag[c]!;
        precon[c] = e > 0 ? 1 / Math.sqrt(e) : 0;
      }
  const apply = (x: Float64Array, out: Float64Array) => {
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = cell(g, i, j, k);
          if (kind[c] !== LIQUID) {
            out[c] = 0;
            continue;
          }
          let s = diag[c]! * x[c]!;
          if (i < nx - 1) s += ax[c]! * x[c + 1]!;
          if (i > 0) s += ax[c - 1]! * x[c - 1]!;
          if (j < ny - 1) s += ay[c]! * x[c + nx]!;
          if (j > 0) s += ay[c - nx]! * x[c - nx]!;
          if (k < nz - 1) s += az[c]! * x[c + nx * ny]!;
          if (k > 0) s += az[c - nx * ny]! * x[c - nx * ny]!;
          out[c] = s;
        }
  };
  const precondition = (r: Float64Array, z: Float64Array, q: Float64Array) => {
    // Solve L q = r, then L^T z = q.
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = cell(g, i, j, k);
          if (kind[c] !== LIQUID) {
            q[c] = 0;
            continue;
          }
          let t = r[c]!;
          if (i > 0) t -= ax[c - 1]! * precon[c - 1]! * q[c - 1]!;
          if (j > 0) t -= ay[c - nx]! * precon[c - nx]! * q[c - nx]!;
          if (k > 0) t -= az[c - nx * ny]! * precon[c - nx * ny]! * q[c - nx * ny]!;
          q[c] = t * precon[c]!;
        }
    for (let k = nz - 1; k >= 0; k--)
      for (let j = ny - 1; j >= 0; j--)
        for (let i = nx - 1; i >= 0; i--) {
          const c = cell(g, i, j, k);
          if (kind[c] !== LIQUID) {
            z[c] = 0;
            continue;
          }
          let t = q[c]!;
          if (i < nx - 1) t -= ax[c]! * precon[c]! * z[c + 1]!;
          if (j < ny - 1) t -= ay[c]! * precon[c]! * z[c + nx]!;
          if (k < nz - 1) t -= az[c]! * precon[c]! * z[c + nx * ny]!;
          z[c] = t * precon[c]!;
        }
  };
  // Conjugate gradients from the last pressure.
  const r = new Float64Array(n),
    z = new Float64Array(n),
    q = new Float64Array(n),
    s = new Float64Array(n),
    As = new Float64Array(n);
  for (let c = 0; c < n; c++) if (kind[c] !== LIQUID) pressure[c] = 0;
  apply(pressure, As);
  let norm0 = 0;
  for (let c = 0; c < n; c++) {
    r[c] = rhs[c]! - As[c]!;
    norm0 = Math.max(norm0, Math.abs(rhs[c]!));
  }
  let iterations = 0;
  const done = (): boolean => {
    let m = 0;
    for (let c = 0; c < n; c++) m = Math.max(m, Math.abs(r[c]!));
    return m <= tolerance * Math.max(norm0, 1e-30);
  };
  if (!done()) {
    precondition(r, z, q);
    s.set(z);
    let rz = 0;
    for (let c = 0; c < n; c++) rz += r[c]! * z[c]!;
    for (iterations = 1; iterations <= maxIterations; iterations++) {
      apply(s, As);
      let sAs = 0;
      for (let c = 0; c < n; c++) sAs += s[c]! * As[c]!;
      if (!(sAs > 0)) break;
      const alpha = rz / sAs;
      for (let c = 0; c < n; c++) {
        pressure[c]! += alpha * s[c]!;
        r[c]! -= alpha * As[c]!;
      }
      if (done()) break;
      precondition(r, z, q);
      let rzNew = 0;
      for (let c = 0; c < n; c++) rzNew += r[c]! * z[c]!;
      const beta = rzNew / rz;
      rz = rzNew;
      for (let c = 0; c < n; c++) s[c] = z[c]! + beta * s[c]!;
    }
  }
  // Subtract the pressure gradient on every face next to liquid; walls at rest.
  const pAt = (c: number, other: number): number => {
    // The pressure at `c` seen from liquid cell `other`: its own if liquid, the ghost value in the air.
    if (kind[c] === LIQUID) return pressure[c]!;
    const theta = Math.max(THETA_FLOOR, phi[other]! / (phi[other]! - phi[c]!));
    return (-(1 - theta) / theta) * pressure[other]!;
  };
  const k2 = dt / (rho * h);
  // The air's ghost pressure half a cell beyond an open side, seen from liquid cell `c`.
  const openGhost = (c: number): number => {
    const theta = Math.max(THETA_FLOOR, -phi[c]! / (-phi[c]! + 0.5 * h));
    return (-(1 - theta) / theta) * pressure[c]!;
  };
  // A face inside a wall (solid or outside the box on both sides) is no boundary: its velocity runs along the wall, and
  // is left to the extrapolation that follows, so the liquid slips along a solid as it does along the box's sides. Only
  // a face between a wall and the liquid's side takes the wall's velocity.
  const walled = (a: number, b: number): boolean => (a < 0 || kind[a] === SOLID) && (b < 0 || kind[b] === SOLID);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i <= nx; i++) {
        const f = faceU(g, i, j, k),
          a = i > 0 ? cell(g, i - 1, j, k) : -1,
          b = i < nx ? cell(g, i, j, k) : -1;
        if ((a < 0 && prescribed[0]) || (b < 0 && prescribed[1])) continue;
        if ((a < 0 && open[0] && kind[b] === LIQUID) || (b < 0 && open[1] && kind[a] === LIQUID)) {
          u[f]! -= k2 * (a < 0 ? pressure[b]! - openGhost(b) : openGhost(a) - pressure[a]!);
          continue;
        }
        if (walled(a, b)) continue;
        if (a < 0 || b < 0 || kind[a] === SOLID || kind[b] === SOLID) {
          u[f] = 0;
          continue;
        }
        if (kind[a] !== LIQUID && kind[b] !== LIQUID) continue;
        const pa = kind[a] === LIQUID ? pressure[a]! : pAt(a, b),
          pb = kind[b] === LIQUID ? pressure[b]! : pAt(b, a);
        u[f]! -= k2 * (pb - pa);
      }
  for (let k = 0; k < nz; k++)
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i < nx; i++) {
        const f = faceV(g, i, j, k),
          a = j > 0 ? cell(g, i, j - 1, k) : -1,
          b = j < ny ? cell(g, i, j, k) : -1;
        if ((a < 0 && prescribed[2]) || (b < 0 && prescribed[3])) continue;
        if ((a < 0 && open[2] && kind[b] === LIQUID) || (b < 0 && open[3] && kind[a] === LIQUID)) {
          v[f]! -= k2 * (a < 0 ? pressure[b]! - openGhost(b) : openGhost(a) - pressure[a]!);
          continue;
        }
        if (walled(a, b)) continue;
        if (a < 0 || b < 0 || kind[a] === SOLID || kind[b] === SOLID) {
          v[f] = 0;
          continue;
        }
        if (kind[a] !== LIQUID && kind[b] !== LIQUID) continue;
        const pa = kind[a] === LIQUID ? pressure[a]! : pAt(a, b),
          pb = kind[b] === LIQUID ? pressure[b]! : pAt(b, a);
        v[f]! -= k2 * (pb - pa);
      }
  for (let k = 0; k <= nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const f = faceW(g, i, j, k),
          a = k > 0 ? cell(g, i, j, k - 1) : -1,
          b = k < nz ? cell(g, i, j, k) : -1;
        if ((a < 0 && prescribed[4]) || (b < 0 && prescribed[5])) continue;
        if ((a < 0 && open[4] && kind[b] === LIQUID) || (b < 0 && open[5] && kind[a] === LIQUID)) {
          w[f]! -= k2 * (a < 0 ? pressure[b]! - openGhost(b) : openGhost(a) - pressure[a]!);
          continue;
        }
        if (walled(a, b)) continue;
        if (a < 0 || b < 0 || kind[a] === SOLID || kind[b] === SOLID) {
          w[f] = 0;
          continue;
        }
        if (kind[a] !== LIQUID && kind[b] !== LIQUID) continue;
        const pa = kind[a] === LIQUID ? pressure[a]! : pAt(a, b),
          pb = kind[b] === LIQUID ? pressure[b]! : pAt(b, a);
        w[f]! -= k2 * (pb - pa);
      }
  return iterations;
}
