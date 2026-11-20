// CPU reference of the flood solver (docs: disaster water plan, push 2): the finite-volume shallow-water scheme that
// `@margoengine/water/flood` runs on the GPU, written plainly in JavaScript so the GPU kernels can be compared with it
// cell for cell. State is stored as float32 (Float32Array, as the GPU's rgba32float textures hold it); each update is
// worked out in doubles and rounded once when stored.
//
// The scheme, from papers only (no companion code read):
// - Conserved variables h, hu, hv on a cell-centred grid over a bed b (Saint-Venant equations).
// - Hydrostatic reconstruction at each face, in the form of Chen and Noelle: the face bed is the higher of the two
//   reconstructed beds, cut down to the lower water surface, each side's depth is its water above that bed and never more
//   than it holds, and the pressure correction g/2 (h^2 - h*^2) is added on each side (Chen, Noelle 2017, SIAM J. Numer.
//   Anal. 55(2) 758-784, https://doi.org/10.1137/15M1053074, eqs. 2.15-2.18). It refines the hydrostatic reconstruction
//   of Audusse, Bouchut, Bristeau, Klein, Perthame 2004 (SIAM J. Sci. Comput. 25(6) 2050-2065,
//   https://doi.org/10.1137/S1064827503431090), whose second-order extension and centred bed source (section 3) are kept:
//   it keeps a lake at rest, keeps h >= 0 under the CFL bound, blocks a wall one cell wide exactly up to its top, and
//   lets a thin sheet run down a slope steeper than depth / cell, where max(b_L, b_R) alone starved it (Delestre et al.
//   2012, https://arxiv.org/abs/1206.4986).
// - The HLL flux (Harten, Lax, van Leer 1983, SIAM Review 25(1) 35-61, https://doi.org/10.1137/1025002) with the
//   one-sided local speeds a+ = max(u+c, 0), a- = min(u-c, 0) of the central-upwind scheme and its desingularised
//   velocity u = sqrt(2) h (hu) / sqrt(h^4 + max(h^4, eps)) (Kurganov, Petrova 2007, Commun. Math. Sci. 5(1) 133-160,
//   https://doi.org/10.4310/CMS.2007.v5.n1.a6, sections 2.1 and 2.2), with eps = DRY^4 so it is hu / h in every wet cell.
// - Reconstruction of h, w = h + b, u and v at the faces: fifth-order WENO-Z (Borges, Carmona, Costa, Don 2008, J. Comput.
//   Phys. 227(6) 3191-3211, https://doi.org/10.1016/j.jcp.2007.11.038; the smoothness indicators of Jiang, Shu 1996,
//   J. Comput. Phys. 126(1) 202-228, https://doi.org/10.1006/jcph.1996.0130; the power 2 of Castro, Costa, Don 2011,
//   https://doi.org/10.1016/j.jcp.2010.11.028) where all five cells of the stencil hold more than WENO_WET and both its
//   depth faces stay at or above 0; elsewhere (shorelines, fronts) piecewise-linear with the minmod limiter, which keeps
//   the face depths positive (Kurganov, Petrova 2007). The hydrostatic reconstruction keeps a lake at rest for
//   any reconstruction of w and h (Audusse et al. 2004, section 2; Noelle, Xing, Shu 2007, J. Comput. Phys. 226(1)
//   29-58, https://doi.org/10.1016/j.jcp.2007.03.031, for WENO). Minmod everywhere clipped every crest to first order: a
//   long wave of 40 cells a wavelength lost about 3% of its height per 50 m, a 0.1 m hump of 9 cells 27% in 500 m;
//   WENO-Z keeps that hump's crest within 1% over 500 m (flood-bounds.test.js, the simple wave). Then two-stage SSP
//   Runge-Kutta
//   (Shu, Osher 1988, J. Comput. Phys. 77(2) 439-471, https://doi.org/10.1016/0021-9991(88)90177-5, the second-order
//   TVD Runge-Kutta: U1 = U + dt L(U), U' = (U + U1 + dt L(U1)) / 2).
// - Manning bed friction, semi-implicit per stage: hu' = hu / (1 + dt g n^2 |u| / h^(4/3)) (Chertock, Cui, Kurganov,
//   Wu 2015, Int. J. Numer. Methods Fluids 78(6) 355-383, https://doi.org/10.1002/fld.4023, section 2.2).
// - Sources per cell and second: inflow volume, rain depth rate, and wind stress tau / rho on the momentum.
//
// Not a GPU stand-in for speed: one face loop per direction, written for clarity.

export const G = 9.81;
/** Water density (kg/m^3) and air density at sea level (kg/m^3, ISA 15 C). */
export const RHO_WATER = 1000;
export const RHO_AIR = 1.225;
/** Depth below which a cell counts as dry for velocities (m). */
export const DRY = 1e-6;
const DRY_4 = DRY * DRY * DRY * DRY;

const minmod = (a, b) => (a > 0 && b > 0 ? Math.min(a, b) : a < 0 && b < 0 ? Math.max(a, b) : 0);
/** Depth (m) every cell of a five-cell stencil must pass for the fifth-order reconstruction; shallower, minmod. */
export const WENO_WET = 0.01;
const WENO_EPS = 1e-12;
// The value at the face between c and d from the left, WENO-Z of Borges, Carmona, Costa, Don 2008 (J. Comput. Phys.
// 227(6) 3191-3211, https://doi.org/10.1016/j.jcp.2007.11.038) with the smoothness indicators of Jiang, Shu 1996 and
// the power 2 of Castro, Costa, Don 2011 (https://doi.org/10.1016/j.jcp.2010.11.028).
function weno5z(a, b, c, d, e) {
  const q0 = (2 * a - 7 * b + 11 * c) / 6,
    q1 = (-b + 5 * c + 2 * d) / 6,
    q2 = (2 * c + 5 * d - e) / 6,
    b0 = (13 / 12) * (a - 2 * b + c) ** 2 + 0.25 * (a - 4 * b + 3 * c) ** 2,
    b1 = (13 / 12) * (b - 2 * c + d) ** 2 + 0.25 * (b - d) ** 2,
    b2 = (13 / 12) * (c - 2 * d + e) ** 2 + 0.25 * (3 * c - 4 * d + e) ** 2,
    tau = Math.abs(b0 - b2),
    a0 = 0.1 * (1 + (tau / (b0 + WENO_EPS)) ** 2),
    a1 = 0.6 * (1 + (tau / (b1 + WENO_EPS)) ** 2),
    a2 = 0.3 * (1 + (tau / (b2 + WENO_EPS)) ** 2);
  return (a0 * q0 + a1 * q1 + a2 * q2) / (a0 + a1 + a2);
}
/** The east and west face values of the middle cell of five. */
const weno5 = (a, b, c, d, e) => [weno5z(a, b, c, d, e), weno5z(e, d, c, b, a)];

/**
 * A flood grid: `nx` x `ny` cells of `dx` x `dy` m over a bed `b(x, z)` (cell centres), water depth `h(x, z)` (default 0)
 * and velocity `u(x, z)`, `v(x, z)` (default 0).
 * Options: `roughness` Manning n (s m^-1/3, default 0 = no friction), `boundary` per side 'wall' (default), 'open'
 * (zero-gradient) or a function `(t) => ({ h, hu, hv })` fixing the ghost cell, `order` 1 or 2 (default 2),
 * `sources(t)` `{ inflow: [{ x, z, discharge }], rain (m/s), wind: [tx, tz] (Pa) }`.
 */
export class FloodReference {
  constructor({ nx, ny = 1, dx, dy = dx, bed, h, u, v, roughness = 0, boundary = {}, order = 2, sources }) {
    Object.assign(this, { nx, ny, dx, dy, roughness, order, sources });
    this.boundary = { west: 'wall', east: 'wall', south: 'wall', north: 'wall', ...boundary };
    const n = nx * ny;
    this.b = new Float32Array(n);
    this.h = new Float32Array(n);
    this.hu = new Float32Array(n);
    this.hv = new Float32Array(n);
    this.time = 0;
    this.steps = 0;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const x = (i + 0.5) * dx,
          z = (j + 0.5) * dy,
          k = j * nx + i,
          depth = Math.max(0, h ? h(x, z) : 0);
        this.b[k] = bed(x, z);
        this.h[k] = depth;
        this.hu[k] = depth * (u ? u(x, z) : 0);
        this.hv[k] = depth * (v ? v(x, z) : 0);
      }
  }
  /** Cell centre (m). */
  x(i) {
    return (i + 0.5) * this.dx;
  }
  z(j) {
    return (j + 0.5) * this.dy;
  }
  /** Volume of water (m^3), summed in doubles. */
  volume() {
    let s = 0;
    for (let k = 0; k < this.h.length; k++) s += this.h[k];
    return s * this.dx * this.dy;
  }
  /** The largest |velocity| (m/s) over wet cells. */
  maxSpeed() {
    let m = 0;
    for (let k = 0; k < this.h.length; k++) {
      const h = this.h[k];
      if (h > 1e-3) m = Math.max(m, Math.hypot(this.hu[k], this.hv[k]) / h);
    }
    return m;
  }
  /** The time step for Courant number `cfl` (default 0.25) at depth `depth` and speed `speed`. */
  static step(dx, depth, speed = 0, cfl = 0.25) {
    return (cfl * dx) / (speed + Math.sqrt(G * depth));
  }
  /** Advances `count` steps of `dt` seconds. */
  run(dt, count = 1) {
    for (let s = 0; s < count; s++) this.#advance(dt);
    return this;
  }
  /** Advances to time `t` with steps of at most `dt`. */
  runTo(t, dt) {
    while (this.time < t - 1e-12) this.#advance(Math.min(dt, t - this.time));
    return this;
  }
  #advance(dt) {
    const { h, hu, hv } = this,
      n = h.length;
    if (this.order === 1) {
      const r = this.#rates(h, hu, hv, this.time);
      this.#store(h, hu, hv, h, hu, hv, r, dt, 1, dt);
    } else {
      const h1 = new Float32Array(n),
        hu1 = new Float32Array(n),
        hv1 = new Float32Array(n);
      const r0 = this.#rates(h, hu, hv, this.time);
      this.#store(h, hu, hv, h1, hu1, hv1, r0, dt, 1, dt);
      const r1 = this.#rates(h1, hu1, hv1, this.time + dt);
      // U' = (U + U1 + dt L(U1)) / 2
      const H = new Float64Array(n),
        HU = new Float64Array(n),
        HV = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        H[k] = 0.5 * (h[k] + h1[k] + dt * r1.h[k]);
        HU[k] = 0.5 * (hu[k] + hu1[k] + dt * r1.hu[k]);
        HV[k] = 0.5 * (hv[k] + hv1[k] + dt * r1.hv[k]);
      }
      this.#settle(H, HU, HV, h, hu, hv, dt / 2);
    }
    this.time += dt;
    this.steps++;
  }
  /** U_out = U + dt L(U), then friction and the dry clamp. */
  #store(h, hu, hv, oh, ohu, ohv, r, dt, _w, frictionDt) {
    const n = h.length,
      H = new Float64Array(n),
      HU = new Float64Array(n),
      HV = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      H[k] = h[k] + dt * r.h[k];
      HU[k] = hu[k] + dt * r.hu[k];
      HV[k] = hv[k] + dt * r.hv[k];
    }
    this.#settle(H, HU, HV, oh, ohu, ohv, frictionDt);
  }
  #settle(H, HU, HV, oh, ohu, ohv, dt) {
    const n2 = this.roughness * this.roughness;
    for (let k = 0; k < H.length; k++) {
      let depth = H[k],
        mu = HU[k],
        mv = HV[k];
      if (depth <= DRY) {
        // Roundoff below zero is clamped; the mass it carries is below 1e-6 m.
        depth = Math.max(0, depth);
        mu = 0;
        mv = 0;
      } else if (n2 > 0) {
        const speed = Math.hypot(mu, mv) / depth,
          damp = 1 + (dt * G * n2 * speed) / Math.pow(depth, 4 / 3);
        mu /= damp;
        mv /= damp;
      }
      oh[k] = depth;
      ohu[k] = mu;
      ohv[k] = mv;
    }
  }
  /** The ghost state beyond a side, world frame [h, hu, hv, b]: a wall mirrors the normal momentum, open copies it,
   * a function `(t, k)` returns `{ h, hu, hv, b }` (b defaults to the edge cell's bed). It mirrors or copies the state
   * the rates are taken of (`h`, `hu`, `hv`: U1 at the second Runge-Kutta stage), never the state at the step's start. */
  #ghost(side, k, t, h, hu, hv) {
    const kind = this.boundary[side];
    if (typeof kind === 'function') {
      const s = kind(t, k);
      return [s.h, s.hu ?? 0, s.hv ?? 0, s.b ?? this.b[k]];
    }
    if (kind === 'open') return [h[k], hu[k], hv[k], this.b[k]];
    return side === 'west' || side === 'east' ? [h[k], -hu[k], hv[k], this.b[k]] : [h[k], hu[k], -hv[k], this.b[k]];
  }
  /** dU/dt over the grid: flux differences, the hydrostatic source, and the sources. */
  #rates(h, hu, hv, t) {
    const { nx, ny, dx, dy, b } = this,
      n = nx * ny,
      rh = new Float64Array(n),
      rhu = new Float64Array(n),
      rhv = new Float64Array(n);
    this.#sweep(h, hu, hv, t, true, rh, rhu, rhv);
    if (ny > 1) this.#sweep(h, hu, hv, t, false, rh, rhv, rhu);
    const src = this.sources?.(t);
    if (src) {
      for (const s of src.inflow ?? []) {
        const i = Math.min(nx - 1, Math.max(0, Math.floor(s.x / dx))),
          j = Math.min(ny - 1, Math.max(0, Math.floor(s.z / dy)));
        rh[j * nx + i] += s.discharge / (dx * dy);
      }
      if (src.rain) for (let k = 0; k < n; k++) rh[k] += src.rain;
      if (src.wind)
        for (let k = 0; k < n; k++)
          if (h[k] > DRY) {
            rhu[k] += src.wind[0] / RHO_WATER;
            rhv[k] += src.wind[1] / RHO_WATER;
          }
    }
    void b;
    return { h: rh, hu: rhu, hv: rhv };
  }
  /**
   * One direction's faces: along x when `alongX` (normal momentum hu, tangential hv), else along z with the roles of
   * the momenta swapped by the caller.
   */
  #sweep(h, hu, hv, t, alongX, rh, rn, rt) {
    const { nx, ny, b } = this,
      cells = alongX ? nx : ny,
      lines = alongX ? ny : nx,
      d = alongX ? this.dx : this.dy,
      mn = alongX ? hu : hv,
      mt = alongX ? hv : hu,
      second = this.order === 2;
    // Per line: cell values with two ghosts on each side (slots 0, 1 and cells + 2, cells + 3), then face states.
    const W = new Float64Array(cells + 4),
      Hh = new Float64Array(cells + 4),
      U = new Float64Array(cells + 4),
      V = new Float64Array(cells + 4),
      B = new Float64Array(cells + 4);
    const at = (line, c) => (alongX ? line * nx + c : c * nx + line);
    for (let line = 0; line < lines; line++) {
      for (let c = 0; c < cells; c++) {
        const k = at(line, c),
          depth = h[k];
        Hh[c + 2] = depth;
        B[c + 2] = b[k];
        W[c + 2] = depth + b[k];
        U[c + 2] = velocity(depth, mn[k]);
        V[c + 2] = velocity(depth, mt[k]);
      }
      // The ghost next to the edge holds the edge cell's ghost state, the one beyond it that of the cell behind the edge
      // (a wall mirrors cells 0 and 1, open copies cell 0 twice, a function gives one state for both).
      for (const [slot, c, side] of [
        [1, 0, alongX ? 'west' : 'south'],
        [0, 1, alongX ? 'west' : 'south'],
        [cells + 2, cells - 1, alongX ? 'east' : 'north'],
        [cells + 3, cells - 2, alongX ? 'east' : 'north'],
      ]) {
        const edge = slot === 1 || slot === cells + 2 ? c : slot === 0 ? 0 : cells - 1,
          mirror = this.boundary[side] === 'wall' ? Math.min(cells - 1, Math.max(0, c)) : edge,
          k = at(line, mirror),
          g = this.#ghost(side, k, t, h, hu, hv);
        Hh[slot] = Math.max(0, g[0]);
        B[slot] = g[3];
        W[slot] = Hh[slot] + B[slot];
        U[slot] = velocity(Hh[slot], alongX ? g[1] : g[2]);
        V[slot] = velocity(Hh[slot], alongX ? g[2] : g[1]);
      }
      // Reconstructed (h, b, u, v) at the east and west faces of slot s; ghosts are constant.
      const faces = (s) => {
        if (!second || s < 2 || s > cells + 1) return [[Hh[s], B[s], U[s], V[s]], [Hh[s], B[s], U[s], V[s]]];
        let wet = true;
        for (let q = s - 2; q <= s + 2; q++) if (!(Hh[q] > WENO_WET)) wet = false;
        if (wet) {
          const r = [Hh, W, U, V].map((A) => weno5(A[s - 2], A[s - 1], A[s], A[s + 1], A[s + 2]));
          if (r[0][0] >= 0 && r[0][1] >= 0)
            return [
              [r[0][0], r[1][0] - r[0][0], r[2][0], r[3][0]],
              [r[0][1], r[1][1] - r[0][1], r[2][1], r[3][1]],
            ];
        }
        const sh = minmod(Hh[s] - Hh[s - 1], Hh[s + 1] - Hh[s]) / 2,
          sw = minmod(W[s] - W[s - 1], W[s + 1] - W[s]) / 2,
          su = minmod(U[s] - U[s - 1], U[s + 1] - U[s]) / 2,
          sv = minmod(V[s] - V[s - 1], V[s + 1] - V[s]) / 2,
          he = Math.max(0, Hh[s] + sh),
          hw = Math.max(0, Hh[s] - sh);
        return [
          [he, W[s] + sw - he, U[s] + su, V[s] + sv],
          [hw, W[s] - sw - hw, U[s] - su, V[s] - sv],
        ];
      };
      const both = [];
      for (let q = 0; q < cells + 4; q++) both.push(faces(q));
      const east = (s) => both[s][0],
        west = (s) => both[s][1];
      // Faces f = 0..cells, between slot f + 1 (cell f - 1) and slot f + 2 (cell f).
      const westWall = this.boundary[alongX ? 'west' : 'south'] === 'wall',
        eastWall = this.boundary[alongX ? 'east' : 'north'] === 'wall';
      for (let f = 0; f <= cells; f++) {
        let [hL, bL, uL, vL] = east(f + 1),
          [hR, bR, uR, vR] = west(f + 2);
        // A wall is the mirror of the face state inside it, so no water crosses it at any order (a ghost at the cell
        // centre against a reconstructed face let mass through).
        if (f === 0 && westWall) [hL, bL, uL, vL] = [hR, bR, -uR, vR];
        if (f === cells && eastWall) [hR, bR, uR, vR] = [hL, bL, -uL, vL];
        // The face bed and depths of Chen and Noelle (2017, eqs. 2.15-2.18): the bed at the face is the higher bed, cut
        // down to the lower water surface, and each side's depth is its water above it, never more than it holds.
        const top = Math.min(Math.max(bL, bR), Math.min(hL + bL, hR + bR)),
          hLs = Math.max(0, Math.min(hL + bL - top, hL)),
          hRs = Math.max(0, Math.min(hR + bR - top, hR)),
          flux = hll(hLs, uL, vL, hRs, uR, vR);
        // The flux the cell on the left loses through its east face and the one on the right gains through its west
        // face, each with its own interface source, -g (h + h*) / 2 (z* - z) on the left and -g (h* + h) / 2 (z - z*) on
        // the right, written here as a pressure added to the flux.
        const outLeft = [flux[0], flux[1] + 0.5 * G * (hL + hLs) * (top - bL), flux[2]],
          inRight = [flux[0], flux[1] - 0.5 * G * (hRs + hR) * (bR - top), flux[2]];
        if (f > 0) {
          const k = at(line, f - 1);
          rh[k] -= outLeft[0] / d;
          rn[k] -= outLeft[1] / d;
          rt[k] -= outLeft[2] / d;
        }
        if (f < cells) {
          const k = at(line, f);
          rh[k] += inRight[0] / d;
          rn[k] += inRight[1] / d;
          rt[k] += inRight[2] / d;
        }
      }
      // The centred bed source of the second-order scheme: g (h_w + h_e) / 2 (b_w - b_e) / d (Audusse et al. 2004,
      // section 3); zero at first order, where the face values equal the centre.
      if (second)
        for (let c = 0; c < cells; c++) {
          const s = c + 2,
            [he, be] = east(s),
            [hw, bw] = west(s);
          rn[at(line, c)] += (G * 0.5 * (hw + he) * (bw - be)) / d;
        }
    }
  }
}

/**
 * Desingularised velocity of momentum m at depth h (Kurganov, Petrova 2007, eq. 2.17) with eps = DRY^4, so it equals
 * m / h wherever a cell holds more than the dry depth. A fixed eps of 1e-12 slowed every sheet thinner than 1 mm, a drag
 * at every moving shoreline that does not shrink with the cell: Thacker's bowl lost 7.6% of its amplitude in 3 periods
 * at 200 x 200 cells (1.3% with eps = DRY^4; the bound is 5%).
 */
export function velocity(h, m) {
  if (h <= DRY) return 0;
  const h4 = h * h * h * h;
  return (Math.SQRT2 * h * m) / Math.sqrt(h4 + Math.max(h4, DRY_4));
}

/** HLL flux of (h, hu, hv) normal to a face, with one-sided speeds bounded by 0 (Kurganov, Petrova 2007). */
export function hll(hL, uL, vL, hR, uR, vR) {
  if (hL <= DRY && hR <= DRY) return [0, 0, 0];
  const cL = Math.sqrt(G * hL),
    cR = Math.sqrt(G * hR),
    ap = Math.max(uL + cL, uR + cR, 0),
    am = Math.min(uL - cL, uR - cR, 0);
  if (ap - am < 1e-12) return [0, 0, 0];
  const qL = hL * uL,
    qR = hR * uR,
    fL = [qL, qL * uL + 0.5 * G * hL * hL, qL * vL],
    fR = [qR, qR * uR + 0.5 * G * hR * hR, qR * vR],
    UL = [hL, qL, hL * vL],
    UR = [hR, qR, hR * vR];
  return fL.map((_, i) => (ap * fL[i] - am * fR[i] + ap * am * (UR[i] - UL[i])) / (ap - am));
}
