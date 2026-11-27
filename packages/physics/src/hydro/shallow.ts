// The finite-volume kernel of conservative shallow water (K14 of docs/physics-solvers.md): the rates dU/dt of depth and
// momentum on a cell-centred grid over a bed, the scheme of `@margoengine/water/flood` (its CPU reference,
// packages/water/test/flood-reference.js, whose header and bounds tests carry the derivation) on the framework's f64 state.
//
// - Conserved variables h, hu, hv per cell over the bed b (the Saint-Venant equations).
// - Hydrostatic reconstruction at each face in the form of Chen and Noelle (2017, SIAM J. Numer. Anal. 55(2) 758-784, eqs.
//   2.15 to 2.18): the face bed is the higher of the two reconstructed beds cut down to the lower water surface, each side's
//   depth is its water above it and never more than it holds, and the pressure g/2 (h^2 - h*^2) is added on each side. It
//   refines Audusse, Bouchut, Bristeau, Klein and Perthame (2004, SIAM J. Sci. Comput. 25(6) 2050-2065), whose centred bed
//   source of the second-order scheme (section 3) is kept: a lake at rest stays at rest to rounding, and h >= 0 under the
//   Courant bound.
// - The HLL flux (Harten, Lax and van Leer 1983) with the one-sided local speeds of the central-upwind scheme and its
//   desingularised velocity (Kurganov and Petrova 2007, Commun. Math. Sci. 5(1) 133-160, sections 2.1 and 2.2).
// - Face values of h, w = h + b, u and v by fifth-order WENO-Z (Borges, Carmona, Costa and Don 2008; the smoothness
//   indicators of Jiang and Shu 1996; the power 2 of Castro, Costa and Don 2011) where all five cells hold more than
//   `WENO_WET`, piecewise linear with the minmod limiter elsewhere (shorelines and fronts), which keeps face depths >= 0.
//
// Every face's flux is worked out once and added to one side and taken from the other, so the water's volume changes only by
// what crosses the grid's open edges and what the sources add: to rounding.
import { pow } from '@margoengine/math/pinned';

/** Depth below which a cell counts as dry for its velocity, m. */
export const DRY = 1e-6;
const DRY_4 = DRY * DRY * DRY * DRY;
/** Depth every cell of a five-cell stencil must pass for the fifth-order reconstruction, m; shallower, minmod. */
export const WENO_WET = 0.01;
const WENO_EPS = 1e-12;
const SQRT2 = 1.4142135623730951;

/**
 * A side of the grid: a wall; open water (the flow goes on past it as it is, over the bed's slope carried on); a set water
 * level (it holds the surface there, so long waves reflect from it); or the open sea at a level (`sea`), which lets waves
 * from inside leave: the characteristic coming in is still water at that level's, the one going out the water's own. A
 * `'periodic'` pair of opposite sides wraps the water round, for a coast or a channel that goes on the same way.
 */
export type ShallowSide =
  | 'wall'
  | 'open'
  | 'periodic'
  | { readonly level: number | ((time: number) => number) }
  | {
      readonly sea: number | ((time: number) => number);
      /** A long wave coming in from the open sea at (x, z), [elevation m, velocity x, z m/s] (a surf's bound wave). */
      readonly incoming?: (time: number, x: number, z: number) => readonly [number, number, number];
    };

/** The grid the kernel works on: `nx` by `nz` cells of `dx` by `dz` m, cell (i, j) at index i + nx j. */
export interface ShallowGrid {
  readonly nx: number;
  readonly nz: number;
  readonly dx: number;
  readonly dz: number;
  /** The bed at each cell, m. */
  readonly bed: Float64Array;
  /** The four sides: -x, +x, -z, +z. */
  readonly sides: readonly [ShallowSide, ShallowSide, ShallowSide, ShallowSide];
  /** Gravity's magnitude, m/s^2. */
  readonly g: number;
  /** The grid's corner, m (default [0, 0]): where an open sea's incoming long wave is asked for. */
  readonly x0?: number;
  readonly z0?: number;
}

/**
 * The desingularised velocity of momentum `m` at depth `h` (Kurganov and Petrova 2007, eq. 2.17) with eps = DRY^4, so it is
 * m / h wherever a cell holds more than the dry depth.
 */
export function velocityOf(h: number, m: number): number {
  if (h <= DRY) return 0;
  const h4 = h * h * h * h;
  return (SQRT2 * h * m) / Math.sqrt(h4 + Math.max(h4, DRY_4));
}

const minmod = (a: number, b: number): number =>
  a > 0 && b > 0 ? Math.min(a, b) : a < 0 && b < 0 ? Math.max(a, b) : 0;

/** The value at the face between c and d seen from the left: WENO-Z. */
function weno5z(a: number, b: number, c: number, d: number, e: number): number {
  // Form the polynomials as increments to the central value so that a
  // constant field survives the weighted blend exactly.
  const q0 = (2 * (a - c) - 7 * (b - c)) / 6,
    q1 = (-(b - c) + 2 * (d - c)) / 6,
    q2 = (5 * (d - c) - (e - c)) / 6,
    s0 = a - 2 * b + c,
    s1 = b - 2 * c + d,
    s2 = c - 2 * d + e,
    t0 = a - 4 * b + 3 * c,
    t1 = b - d,
    t2 = 3 * c - 4 * d + e,
    b0 = (13 / 12) * s0 * s0 + 0.25 * t0 * t0,
    b1 = (13 / 12) * s1 * s1 + 0.25 * t1 * t1,
    b2 = (13 / 12) * s2 * s2 + 0.25 * t2 * t2,
    tau = Math.abs(b0 - b2),
    r0 = tau / (b0 + WENO_EPS),
    r1 = tau / (b1 + WENO_EPS),
    r2 = tau / (b2 + WENO_EPS),
    a0 = 0.1 * (1 + r0 * r0),
    a1 = 0.6 * (1 + r1 * r1),
    a2 = 0.3 * (1 + r2 * r2);
  return c + (a0 * q0 + a1 * q1 + a2 * q2) / (a0 + a1 + a2);
}

/** The HLL flux of (h, hu, hv) normal to a face into `out`, with one-sided speeds bounded by 0. */
function hll(
  g: number,
  hL: number,
  uL: number,
  vL: number,
  hR: number,
  uR: number,
  vR: number,
  out: Float64Array,
  reference?: number,
): void {
  out[0] = out[2] = 0;
  out[1] = reference === undefined ? 0 : -0.5 * g * reference * reference;
  if (hL <= DRY && hR <= DRY) return;
  const cL = Math.sqrt(g * hL),
    cR = Math.sqrt(g * hR),
    ap = Math.max(uL + cL, uR + cR, 0),
    am = Math.min(uL - cL, uR - cR, 0),
    span = ap - am;
  if (!(span >= 1e-12)) return;
  const qL = hL * uL,
    qR = hR * uR,
    product = ap * am;
  out[0] = (ap * qL - am * qR + product * (hR - hL)) / span;
  const pL = reference === undefined ? 0.5 * g * hL * hL : 0.5 * g * (hL - reference) * (hL + reference);
  const pR = reference === undefined ? 0.5 * g * hR * hR : 0.5 * g * (hR - reference) * (hR + reference);
  out[1] = (ap * (qL * uL + pL) - am * (qR * uR + pR) + product * (qR - qL)) / span;
  out[2] = (ap * qL * vL - am * qR * vR + product * (hR * vR - hL * vL)) / span;
}

/** Scratch of one line of cells with two ghosts each side, and the face states. */
interface Line {
  h: Float64Array;
  w: Float64Array;
  u: Float64Array;
  v: Float64Array;
  b: Float64Array;
  /** Per slot: east face (h, b, u, v) then west face (h, b, u, v). */
  faces: Float64Array;
}

const lines = new WeakMap<ShallowGrid, Line>();

function lineOf(grid: ShallowGrid): Line {
  let line = lines.get(grid);
  const n = Math.max(grid.nx, grid.nz) + 4;
  if (!line || line.h.length < n) {
    line = {
      h: new Float64Array(n),
      w: new Float64Array(n),
      u: new Float64Array(n),
      v: new Float64Array(n),
      b: new Float64Array(n),
      faces: new Float64Array(8 * n),
    };
    lines.set(grid, line);
  }
  return line;
}

/**
 * Adds dU/dt of the flux differences and the bed's hydrostatic source to `rh`, `rhu`, `rhv`, and returns the volume per
 * second that left the grid over its open sides and set levels (negative for water that came in).
 */
export function shallowRates(
  grid: ShallowGrid,
  h: Float64Array,
  hu: Float64Array,
  hv: Float64Array,
  time: number,
  rh: Float64Array,
  rhu: Float64Array,
  rhv: Float64Array,
): number {
  return shallowOpenRates(grid, h, hu, hv, time, rh, rhu, rhv);
}

/** Uses the same conservative face flux on an optional periodic cut-cell opening. */
export function shallowOpenRates(
  grid: ShallowGrid,
  h: Float64Array,
  hu: Float64Array,
  hv: Float64Array,
  time: number,
  rh: Float64Array,
  rhu: Float64Array,
  rhv: Float64Array,
  openX?: Float64Array,
  openZ?: Float64Array,
): number {
  let out = sweep(grid, h, hu, hv, time, true, rh, rhu, rhv, openX);
  if (grid.nz > 1) out += sweep(grid, h, hu, hv, time, false, rh, rhv, rhu, openZ);
  return out;
}

const flux = new Float64Array(3);

/** One direction's faces: along x (normal momentum hu, tangential hv), or along z with the momenta's roles swapped. */
function sweep(
  grid: ShallowGrid,
  h: Float64Array,
  hu: Float64Array,
  hv: Float64Array,
  time: number,
  alongX: boolean,
  rh: Float64Array,
  rn: Float64Array,
  rt: Float64Array,
  openings?: Float64Array,
): number {
  const { nx, nz, bed, g } = grid,
    cells = alongX ? nx : nz,
    count = alongX ? nz : nx,
    d = alongX ? grid.dx : grid.dz,
    width = alongX ? grid.dz : grid.dx,
    mn = alongX ? hu : hv,
    mt = alongX ? hv : hu,
    low = grid.sides[alongX ? 0 : 2],
    high = grid.sides[alongX ? 1 : 3],
    L = lineOf(grid),
    { faces } = L;
  let leaving = 0;
  for (let line = 0; line < count; line++) {
    const at = (c: number): number => (alongX ? c + nx * line : line + nx * c);
    for (let c = 0; c < cells; c++) {
      const k = at(c),
        depth = h[k]!;
      L.h[c + 2] = depth;
      L.b[c + 2] = bed[k]!;
      L.w[c + 2] = depth + bed[k]!;
      L.u[c + 2] = velocityOf(depth, mn[k]!);
      L.v[c + 2] = velocityOf(depth, mt[k]!);
    }
    // The ghosts: a wall mirrors the two cells inside it, open water copies the edge cell twice, a set level holds water to
    // that level over the edge cell's bed with the edge cell's velocity.
    const periodic = low === 'periodic';
    if (periodic) {
      // Wrapped round: the ghosts are the far end's cells.
      for (const [to, from] of [
        [1, cells + 1],
        [0, cells],
        [cells + 2, 2],
        [cells + 3, 3],
      ] as const)
        copy(L, to, from, false);
    } else {
      // The edge cells' centres, where an open sea's incoming long wave is asked for.
      const x0 = grid.x0 ?? 0,
        z0 = grid.z0 ?? 0,
        across = (line + 0.5) * (alongX ? grid.dz : grid.dx),
        first = 0.5 * d,
        last = (cells - 0.5) * d;
      ghost(L, low, 1, 2, 3, time, g, alongX, alongX ? x0 + first : x0 + across, alongX ? z0 + across : z0 + first);
      ghost(
        L,
        high,
        cells + 2,
        cells + 1,
        cells,
        time,
        g,
        alongX,
        alongX ? x0 + last : x0 + across,
        alongX ? z0 + across : z0 + last,
      );
    }
    // Face states of every slot (ghosts constant).
    for (let s = 0; s < cells + 4; s++) reconstruct(L, s, cells);
    for (let f = periodic ? 1 : 0; f <= cells; f++) {
      const e = 8 * (f + 1),
        o = 8 * (f + 2) + 4;
      let hL = faces[e]!,
        bL = faces[e + 1]!,
        uL = faces[e + 2]!,
        vL = faces[e + 3]!,
        hR = faces[o]!,
        bR = faces[o + 1]!,
        uR = faces[o + 2]!,
        vR = faces[o + 3]!;
      // A wall is the mirror of the face state inside it, so no water crosses it at any order.
      if (f === 0 && low === 'wall') {
        hL = hR;
        bL = bR;
        uL = -uR;
        vL = vR;
      }
      if (f === cells && high === 'wall') {
        hR = hL;
        bR = bL;
        uR = -uL;
        vR = vL;
      }
      // The face bed and depths of Chen and Noelle (eqs. 2.15 to 2.18).
      const top = Math.min(Math.max(bL, bR), Math.min(hL + bL, hR + bR)),
        hLs = Math.max(0, Math.min(hL + bL - top, hL)),
        hRs = Math.max(0, Math.min(hR + bR - top, hR));
      const right = at(f === cells ? 0 : f);
      const reference = openings ? h[at(f - 1)]! : undefined;
      const referenceRight = h[right]!;
      hll(g, hLs, uL, vL, hRs, uR, vR, flux, reference);
      // In cut cells, use pressure relative to this cell's hydrostatic
      // pressure. Its contribution on the closed water contour sums to zero.
      const offset =
        reference === undefined ? 0 : 0.5 * g * (reference - referenceRight) * (reference + referenceRight);
      // Each side's interface source, written as a pressure added to the flux it sees.
      const opening = openings ? openings[right]! : 1;
      const mass = opening * flux[0]!;
      const tangent = opening * flux[2]!;
      const leftN = opening * (flux[1]! + 0.5 * g * (hL + hLs) * (top - bL)),
        rightN = opening * (flux[1]! + offset - 0.5 * g * (hRs + hR) * (bR - top));
      if (f > 0) {
        const k = at(f - 1);
        rh[k]! -= mass / d;
        rn[k]! -= leftN / d;
        rt[k]! -= tangent / d;
      } else leaving -= mass * width;
      if (f === cells && periodic) {
        // The face past the far end is the near end's first: what leaves one cell there enters the other, exactly.
        const k = at(0);
        rh[k]! += mass / d;
        rn[k]! += rightN / d;
        rt[k]! += tangent / d;
      } else if (f < cells) {
        const k = at(f);
        rh[k]! += mass / d;
        rn[k]! += rightN / d;
        rt[k]! += tangent / d;
      } else leaving += mass * width;
    }
    // The centred bed source of the second-order scheme: g (h_w + h_e) / 2 (b_w - b_e) / d (Audusse et al. 2004, section 3).
    for (let c = 0; c < cells; c++) {
      const e = 8 * (c + 2),
        o = e + 4;
      rn[at(c)]! += (g * 0.5 * (faces[o]! + faces[e]!) * (faces[o + 1]! - faces[e + 1]!)) / d;
    }
  }
  return leaving;
}

/** Fills ghost slots `near` and `far` beside edge cell slot `edge` (`inner` the slot behind it) for `side`. */
function ghost(
  L: Line,
  side: ShallowSide,
  near: number,
  edge: number,
  inner: number,
  time: number,
  g: number,
  alongX: boolean,
  x: number,
  z: number,
): void {
  const far = near === 1 ? 0 : near + 1;
  if (side === 'wall') {
    copy(L, near, edge, true);
    copy(L, far, inner, true);
  } else if (side === 'open') {
    // The flow goes on as it is: the edge cell's depth and velocity over the bed's slope carried on past the edge, so a river
    // leaves at its normal depth (a flat ghost bed took the slope's pull off the last half cell, and a river backed up).
    const slope = L.b[edge]! - L.b[inner]!;
    copy(L, near, edge, false);
    copy(L, far, edge, false);
    L.b[near] = L.b[edge]! + slope;
    L.b[far] = L.b[edge]! + 2 * slope;
    L.w[near] = L.h[near]! + L.b[near]!;
    L.w[far] = L.h[far]! + L.b[far]!;
  } else if (side === 'periodic') {
    // Filled by the line's sweep from the far end.
    return;
  } else if ('sea' in side) {
    // Riemann invariants u +- 2 sqrt(g h) along the normal: in from still water at the sea's level, out from the edge cell.
    // Outside: still water at the sea's level, or with the long wave coming in from it (its elevation and normal velocity).
    const level = typeof side.sea === 'function' ? side.sea(time) : side.sea,
      wave = side.incoming ? side.incoming(time, x, z) : undefined,
      b = L.b[edge]!,
      outside = Math.sqrt(g * Math.max(0, level - b + (wave ? wave[0] : 0))),
      flow = wave ? (alongX ? wave[1] : wave[2]) : 0,
      inside = Math.sqrt(g * L.h[edge]!),
      u = L.u[edge]!,
      // The low side's outside lies at -x: its incoming invariant is u + 2c from outside, the outgoing u - 2c from inside.
      low = near === 1,
      plus = low ? flow + 2 * outside : u + 2 * inside,
      minus = low ? u - 2 * inside : flow - 2 * outside,
      c = (plus - minus) / 4,
      depth = c > 0 ? (c * c) / g : 0,
      velocity = depth > DRY ? (plus + minus) / 2 : 0,
      leaving = low ? velocity < 0 : velocity > 0;
    for (const s of [near, far]) {
      L.h[s] = depth;
      L.b[s] = b;
      L.w[s] = depth + b;
      L.u[s] = velocity;
      L.v[s] = leaving && depth > DRY ? L.v[edge]! : 0;
    }
  } else {
    const level = typeof side.level === 'function' ? side.level(time) : side.level,
      b = L.b[edge]!,
      depth = Math.max(0, level - b);
    for (const s of [near, far]) {
      L.h[s] = depth;
      L.b[s] = b;
      L.w[s] = depth + b;
      L.u[s] = depth > DRY ? L.u[edge]! : 0;
      L.v[s] = depth > DRY ? L.v[edge]! : 0;
    }
  }
}

function copy(L: Line, to: number, from: number, mirror: boolean): void {
  L.h[to] = L.h[from]!;
  L.b[to] = L.b[from]!;
  L.w[to] = L.w[from]!;
  L.u[to] = mirror ? -L.u[from]! : L.u[from]!;
  L.v[to] = L.v[from]!;
}

/** The east and west face states of slot `s` into `faces`: WENO-Z where the stencil is wet, minmod elsewhere. */
function reconstruct(L: Line, s: number, cells: number): void {
  const { h, w, u, v, b, faces } = L,
    at = 8 * s;
  // The outer ghosts are constant; the ghosts beside the edge take the minmod slope, so an open side's carried-on bed meets
  // the edge cell's face without a step (a wall's face is the mirror of the inside one, a set level's ghosts are flat).
  if (s < 1 || s > cells + 2) {
    faces[at] = faces[at + 4] = h[s]!;
    faces[at + 1] = faces[at + 5] = b[s]!;
    faces[at + 2] = faces[at + 6] = u[s]!;
    faces[at + 3] = faces[at + 7] = v[s]!;
    return;
  }
  let wet = s >= 2 && s <= cells + 1;
  for (let q = s - 2; q <= s + 2 && wet; q++) if (!(h[q]! > WENO_WET)) wet = false;
  if (wet) {
    const he = weno5z(h[s - 2]!, h[s - 1]!, h[s]!, h[s + 1]!, h[s + 2]!),
      hw = weno5z(h[s + 2]!, h[s + 1]!, h[s]!, h[s - 1]!, h[s - 2]!);
    if (he >= 0 && hw >= 0) {
      faces[at] = he;
      faces[at + 1] = weno5z(w[s - 2]!, w[s - 1]!, w[s]!, w[s + 1]!, w[s + 2]!) - he;
      faces[at + 2] = weno5z(u[s - 2]!, u[s - 1]!, u[s]!, u[s + 1]!, u[s + 2]!);
      faces[at + 3] = weno5z(v[s - 2]!, v[s - 1]!, v[s]!, v[s + 1]!, v[s + 2]!);
      faces[at + 4] = hw;
      faces[at + 5] = weno5z(w[s + 2]!, w[s + 1]!, w[s]!, w[s - 1]!, w[s - 2]!) - hw;
      faces[at + 6] = weno5z(u[s + 2]!, u[s + 1]!, u[s]!, u[s - 1]!, u[s - 2]!);
      faces[at + 7] = weno5z(v[s + 2]!, v[s + 1]!, v[s]!, v[s - 1]!, v[s - 2]!);
      return;
    }
  }
  const sh = minmod(h[s]! - h[s - 1]!, h[s + 1]! - h[s]!) / 2,
    sw = minmod(w[s]! - w[s - 1]!, w[s + 1]! - w[s]!) / 2,
    su = minmod(u[s]! - u[s - 1]!, u[s + 1]! - u[s]!) / 2,
    sv = minmod(v[s]! - v[s - 1]!, v[s + 1]! - v[s]!) / 2,
    he = Math.max(0, h[s]! + sh),
    hw = Math.max(0, h[s]! - sh);
  faces[at] = he;
  faces[at + 1] = w[s]! + sw - he;
  faces[at + 2] = u[s]! + su;
  faces[at + 3] = v[s]! + sv;
  faces[at + 4] = hw;
  faces[at + 5] = w[s]! - sw - hw;
  faces[at + 6] = u[s]! - su;
  faces[at + 7] = v[s]! - sv;
}

/**
 * Manning's bed friction over `dt`, semi-implicit: (hu, hv) / (1 + dt g n^2 |u| / h^(4/3)) (Chertock, Cui, Kurganov and Wu
 * 2015, Int. J. Numer. Methods Fluids 78(6) 355-383, section 2.2), which slows the flow and never turns it back; with waves,
 * `orbital` is their rms orbital velocity at the bed, m/s.
 */
export function manning(
  g: number,
  n: number,
  h: number,
  mu: number,
  mv: number,
  dt: number,
  out: Float64Array,
  orbital = 0,
): void {
  if (!(n > 0) || h <= DRY) {
    out[0] = h <= DRY ? 0 : mu;
    out[1] = h <= DRY ? 0 : mv;
    return;
  }
  // Waves stir the bed: the speed the friction sees is sqrt(|u|^2 + (1.16 u_rms)^2) (Ruessink et al. 2001, as the XBeach
  // manual states it), u_rms the waves' rms orbital velocity at the bed.
  const stir = 1.16 * orbital,
    speed = Math.sqrt((mu * mu + mv * mv) / (h * h) + stir * stir),
    damp = 1 + (dt * g * n * n * speed) / pow(h, 4 / 3);
  out[0] = mu / damp;
  out[1] = mv / damp;
}
