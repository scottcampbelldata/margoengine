// Green water (SEA-08): the sea coming over a hull's deck edge, running across the deck and off it, and its weight on the
// hull. Zhang and Reed, "Green water effect on ship motions and loads via dam breaking model", IWWWFB 39, 2024: shallow
// water on the deck, in the deck's moving frame, with gravity replaced by the frame's effective acceleration (their eqs. 1-2:
// G = Z0'' cos(theta) - X0'' sin(theta) + g cos(theta) cos(phi)), the deck's pressure hydrostatic, p = rho G (zeta - b), and
// the water coming aboard where the sea stands above the deck edge as a dam that breaks (Stoker, *Water Waves*, 1957).
// They solve one-dimensional strips along the waves and leave the inflow and outflow at the edges and oblique seas open;
// here the deck is a two-dimensional grid and every edge takes water in or lets it go:
// - the shallow-water equations by a first-order finite-volume scheme, Rusanov's flux with the hydrostatic reconstruction
//   of Audusse, Bouchut, Bristeau, Klein and Perthame ("A fast and stable well-balanced scheme with hydrostatic
//   reconstruction for shallow water flows", SIAM J. Sci. Comput. 25(6), 2004), which keeps a lake at rest on a sloped
//   deck still, keeps depths positive and lets cells dry;
// - gravity the frame's: the body's acceleration taken off, its component down the deck (G) and along it (pushing the
//   water as a slope would);
// - an edge where the sea stands above the deck is a reservoir at that height with the water's own motion relative to the
//   deck (the dam), one where it does not is dry beyond (the water runs off), and a wall (a bulwark) turns the water back;
// - substeps under the waves' speed sqrt(G h) plus the flow's (CFL 0.4).
// The deck is the hull mesh's upward-facing top, found by casting down from a grid over the body's plan.

import { hypot } from '@margoengine/math/pinned';

/** A deck: its grid over the body's plan (x along the hull, z across), each cell's deck height (NaN off the deck). */
export interface Deck {
  /** Cells along x and along z. */
  readonly nx: number;
  readonly nz: number;
  /** The grid's corner (body frame, x and z) and its cells' sizes. */
  readonly x0: number;
  readonly z0: number;
  readonly dx: number;
  readonly dz: number;
  /** The deck's height in the body frame at each cell's centre (x fastest), NaN where there is no deck. */
  readonly height: Float64Array;
}

/**
 * The deck of a closed hull mesh (body frame, y up): the highest upward-facing surface over each cell of an `nx` by `nz`
 * grid over the mesh's plan, where that surface is above the still waterline `waterline` (a cell whose top is under it is
 * no deck: the hull's bottom seen from above).
 */
export function deckOf(
  mesh: { readonly vertices: ArrayLike<number>; readonly indices: ArrayLike<number> },
  waterline: number,
  nx = 32,
  nz = 12,
): Deck {
  const { vertices: v, indices } = mesh;
  let xmin = Infinity,
    xmax = -Infinity,
    zmin = Infinity,
    zmax = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    xmin = Math.min(xmin, v[i]!);
    xmax = Math.max(xmax, v[i]!);
    zmin = Math.min(zmin, v[i + 2]!);
    zmax = Math.max(zmax, v[i + 2]!);
  }
  const dx = (xmax - xmin) / nx,
    dz = (zmax - zmin) / nz,
    height = new Float64Array(nx * nz).fill(Number.NaN);
  for (let k = 0; k + 2 < indices.length; k += 3) {
    const a = 3 * indices[k]!,
      b = 3 * indices[k + 1]!,
      c = 3 * indices[k + 2]!,
      ux = v[b]! - v[a]!,
      uy = v[b + 1]! - v[a + 1]!,
      uz = v[b + 2]! - v[a + 2]!,
      wx = v[c]! - v[a]!,
      wy = v[c + 1]! - v[a + 1]!,
      wz = v[c + 2]! - v[a + 2]!,
      // The normal's y (the cross product's) and its length: an upward face has ny > 0.
      ny = uz * wx - ux * wz,
      nx3 = uy * wz - uz * wy,
      nz3 = ux * wy - uy * wx,
      length = hypot(hypot(nx3, ny), nz3);
    if (!(length > 0) || ny <= 0.5 * length) continue;
    // Cast down from each cell centre inside the face's plan (barycentric in x, z).
    const det = ux * wz - uz * wx;
    if (det === 0) continue;
    const lo = Math.max(0, Math.floor((Math.min(v[a]!, v[b]!, v[c]!) - xmin) / dx)),
      hi = Math.min(nx - 1, Math.floor((Math.max(v[a]!, v[b]!, v[c]!) - xmin) / dx)),
      left = Math.max(0, Math.floor((Math.min(v[a + 2]!, v[b + 2]!, v[c + 2]!) - zmin) / dz)),
      right = Math.min(nz - 1, Math.floor((Math.max(v[a + 2]!, v[b + 2]!, v[c + 2]!) - zmin) / dz));
    for (let i = lo; i <= hi; i++)
      for (let j = left; j <= right; j++) {
        const px = xmin + (i + 0.5) * dx - v[a]!,
          pz = zmin + (j + 0.5) * dz - v[a + 2]!,
          s = (px * wz - pz * wx) / det,
          t = (ux * pz - uz * px) / det;
        if (s < -1e-12 || t < -1e-12 || s + t > 1 + 1e-12) continue;
        const y = v[a + 1]! + s * uy + t * wy,
          at = j * nx + i;
        if (y > waterline && !(height[at]! >= y)) height[at] = y;
      }
  }
  return { nx, nz, x0: xmin, z0: zmin, dx, dz, height };
}

/**
 * The flow on a deck over one step: `water` is the state (depth h, then h u, then h w per cell, each `nx * nz`, body frame),
 * `gravity` the effective gravity in the body frame (the world's less the deck's acceleration), and `outside(x, z)` the sea
 * beyond an edge point (body frame x, z and the deck's height there): the height of its surface over the deck there (0 or less where it stands below; NaN for a wall)
 * and the water's velocity relative to the deck (body frame, x and z). Returns the water that came aboard over the step (m^3), and fills
 * `inflow` (if given) per edge face with what came in: [x, z of the face's middle, nx, nz inward, h, u, w, q m^3/s].
 */
export function stepDeck(
  deck: Deck,
  water: Float64Array,
  gravity: readonly [number, number, number],
  outside: (x: number, z: number, deckHeight: number) => readonly [number, number, number],
  dt: number,
  inflow?: number[],
): number {
  const { nx, nz, dx, dz, height, x0, z0 } = deck,
    n = nx * nz,
    G = -gravity[1],
    ax = gravity[0],
    az = gravity[2];
  if (inflow) inflow.length = 0;
  if (!(G > 0)) return 0;
  const on = (i: number, j: number) => i >= 0 && i < nx && j >= 0 && j < nz && !Number.isNaN(height[j * nx + i]!),
    // The edge faces: each deck cell's faces onto no deck, with the sea's state found once a step at their middles.
    edges: { cell: number; axis: 0 | 1; side: 1 | -1; x: number; z: number; sea: readonly [number, number, number] }[] =
      [];
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      if (!on(i, j)) continue;
      const cx = x0 + (i + 0.5) * dx,
        cz = z0 + (j + 0.5) * dz;
      for (const [di, dj, axis, side] of [
        [1, 0, 0, 1],
        [-1, 0, 0, -1],
        [0, 1, 1, 1],
        [0, -1, 1, -1],
      ] as const)
        if (!on(i + di, j + dj)) {
          const x = cx + (axis === 0 ? (side * dx) / 2 : 0),
            z = cz + (axis === 1 ? (side * dz) / 2 : 0);
          edges.push({ cell: j * nx + i, axis, side, x, z, sea: outside(x, z, height[j * nx + i]!) });
        }
    }
  let aboard = 0,
    elapsed = 0;
  const flux = new Float64Array(3 * n),
    record = new Float64Array(edges.length * 4);
  while (elapsed < dt) {
    // The step the waves allow (CFL 0.4), over the cells and the edges' reservoirs.
    let speed = 0;
    for (let c = 0; c < n; c++) {
      const h = water[c]!;
      if (h > 1e-9) {
        const s = Math.sqrt(G * h);
        speed = Math.max(speed, Math.abs(water[n + c]! / h) + s, Math.abs(water[2 * n + c]! / h) + s);
      }
    }
    for (const e of edges)
      if (e.sea[0]! > 0) {
        const s = Math.sqrt(G * e.sea[0]);
        speed = Math.max(speed, Math.abs(e.sea[1]) + s, Math.abs(e.sea[2]) + s);
      }
    const h = speed > 0 ? Math.min(dt - elapsed, (0.4 * Math.min(dx, dz)) / speed) : dt - elapsed;
    flux.fill(0);
    // Interior faces: the hydrostatic reconstruction (the water surface eta = b + h continuous at rest) and Rusanov's flux.
    const face = (left: number, right: number, axis: 0 | 1, length: number) => {
      const bl = height[left]!,
        br = height[right]!,
        bf = Math.max(bl, br),
        hl = Math.max(0, water[left]! + bl - bf),
        hr = Math.max(0, water[right]! + br - bf),
        ul = water[left]! > 1e-9 ? water[n + left]! / water[left]! : 0,
        wl = water[left]! > 1e-9 ? water[2 * n + left]! / water[left]! : 0,
        ur = water[right]! > 1e-9 ? water[n + right]! / water[right]! : 0,
        wr = water[right]! > 1e-9 ? water[2 * n + right]! / water[right]! : 0,
        [f] = rusanov(hl, ul, wl, hr, ur, wr, axis, G);
      for (let k = 0; k < 3; k++) {
        flux[k * n + left]! -= f[k]! * length;
        flux[k * n + right]! += f[k]! * length;
      }
      // The reconstruction's correction: the hydrostatic thrust of the step in the deck on each side.
      const m = axis === 0 ? n : 2 * n;
      flux[m + left]! -= (G / 2) * (water[left]! * water[left]! - hl * hl) * length;
      flux[m + right]! += (G / 2) * (water[right]! * water[right]! - hr * hr) * length;
    };
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        if (!on(i, j)) continue;
        if (on(i + 1, j)) face(j * nx + i, j * nx + i + 1, 0, dz);
        if (on(i, j + 1)) face(j * nx + i, (j + 1) * nx + i, 1, dx);
      }
    // Edge faces: a wall mirrors the cell; otherwise the characteristic state between the deck's water and the sea beyond
    // (or the air), with the critical-flow limit (edgeFlux).
    edges.forEach((e, index) => {
      const c = e.cell,
        hc = water[c]!,
        uc = hc > 1e-9 ? water[n + c]! / hc : 0,
        wc = hc > 1e-9 ? water[2 * n + c]! / hc : 0,
        length = e.axis === 0 ? dz : dx;
      let out: readonly number[];
      if (Number.isNaN(e.sea[0])) {
        const ue = e.axis === 0 ? -uc : uc,
          we = e.axis === 1 ? -wc : wc,
          [f] = e.side === 1 ? rusanov(hc, uc, wc, hc, ue, we, e.axis, G) : rusanov(hc, ue, we, hc, uc, wc, e.axis, G);
        out = e.side === 1 ? f : [-f[0]!, -f[1]!, -f[2]!];
      } else {
        // In the face's own axes: n outward from the deck, t along the face.
        const s = e.side,
          normal = (u: number, w: number) => s * (e.axis === 0 ? u : w),
          along = (u: number, w: number) => (e.axis === 0 ? w : u),
          [fh, fn, ft] = edgeFlux(
            hc,
            normal(uc, wc),
            along(uc, wc),
            Math.max(0, e.sea[0]),
            normal(e.sea[1], e.sea[2]),
            along(e.sea[1], e.sea[2]),
            G,
          );
        // Back to the deck's axes: the flux out through the face.
        out = e.axis === 0 ? [fh, s * fn, ft] : [fh, ft, s * fn];
      }
      for (let k = 0; k < 3; k++) flux[k * n + c]! -= out[k]! * length;
      const q = -out[0]! * length;
      if (q > 0 && !Number.isNaN(e.sea[0])) {
        aboard += q * h;
        record[4 * index]! += q * h;
        record[4 * index + 1]! += Math.max(0, e.sea[0]) * h;
        record[4 * index + 2]! += e.sea[1] * h;
        record[4 * index + 3]! += e.sea[2] * h;
      }
    });
    // The update, with the frame's pull along the deck and the deck's slope taken by the reconstruction.
    const area = dx * dz;
    for (let c = 0; c < n; c++) {
      if (Number.isNaN(height[c]!)) continue;
      const depth = Math.max(0, water[c]! + (h * flux[c]!) / area);
      water[n + c] = water[n + c]! + (h * flux[n + c]!) / area + h * ax * water[c]!;
      water[2 * n + c] = water[2 * n + c]! + (h * flux[2 * n + c]!) / area + h * az * water[c]!;
      water[c] = depth;
      if (depth <= 1e-9) {
        water[c] = 0;
        water[n + c] = 0;
        water[2 * n + c] = 0;
      }
    }
    elapsed += h;
  }
  if (inflow)
    edges.forEach((e, index) => {
      const volume = record[4 * index]!;
      if (!(volume > 0)) return;
      inflow.push(
        e.x,
        e.z,
        e.axis === 0 ? -e.side : 0,
        e.axis === 1 ? -e.side : 0,
        record[4 * index + 1]! / dt,
        record[4 * index + 2]! / dt,
        record[4 * index + 3]! / dt,
        volume / dt,
      );
    });
  return aboard;
}

/**
 * The flux out of the deck through an edge face, the deck's water (h, its velocity outward n and along the face t) on one
 * side and the sea (or, at height 0, the air) on the other: [the flux of h, of the outward momentum, of the momentum along
 * the face], outward. The face's state is the characteristic one (Toro, *Shock-Capturing Methods for Free-Surface Shallow
 * Flows*, Wiley 2001, the boundary conditions by Riemann invariants): the deck's outgoing invariant n + 2c and the sea's
 * incoming one n - 2c meet there. Where that state would cross the edge faster than its waves, it is the critical flow fed
 * from upstream: water coming over a dry deck edge from still sea stands at 4/9 of the sea's height with speed 2/3
 * sqrt(G h) (Ritter's dam break at the dam, Stoker 1957), and water running off into the air leaves at critical depth (a
 * free overfall's control section).
 */
function edgeFlux(
  hc: number,
  nc: number,
  tc: number,
  he: number,
  ne: number,
  te: number,
  G: number,
): [number, number, number] {
  const cc = Math.sqrt(G * hc),
    ce = Math.sqrt(G * he);
  let h = 0,
    n = 0,
    t = 0;
  if (hc > 1e-9 && he > 1e-9) {
    // Both wet: the invariants' state, unless it is supercritical, then the upstream side's critical flow (or the upstream
    // state itself where that is supercritical already).
    const out = nc + 2 * cc,
      into = ne - 2 * ce;
    n = (out + into) / 2;
    const c = (out - into) / 4;
    if (c > 0) {
      h = (c * c) / G;
      if (n > c) {
        // Leaving the deck faster than its waves.
        if (nc > cc) [h, n] = [hc, nc];
        else [h, n] = [(out * out) / (9 * G), out / 3];
      } else if (n < -c) {
        if (ne < -ce) [h, n] = [he, ne];
        else [h, n] = [(into * into) / (9 * G), into / 3];
      }
    }
    t = n > 0 ? tc : te;
  } else if (hc > 1e-9) {
    // Into the air: critical depth at the brink, fed by the deck's outgoing invariant.
    const out = nc + 2 * cc;
    if (out > 0) {
      if (nc > cc) [h, n] = [hc, nc];
      else [h, n] = [(out * out) / (9 * G), out / 3];
    }
    t = tc;
  } else if (he > 1e-9) {
    // Over a dry deck: the sea's own supercritical inflow, or Ritter's critical flow from the sea's incoming invariant.
    const into = ne - 2 * ce;
    if (into < 0) {
      if (ne < -ce) [h, n] = [he, ne];
      else [h, n] = [(into * into) / (9 * G), into / 3];
    }
    t = te;
  }
  return [h * n, h * n * n + 0.5 * G * h * h, h * n * t];
}

/**
 * Rusanov's flux across a face along `axis` (0: x, 1: z) between a left state (h, u, w) and a right one, for shallow water
 * under gravity G: [the flux of h, h u, h w], and the two sides' wave speeds.
 */
function rusanov(
  hl: number,
  ul: number,
  wl: number,
  hr: number,
  ur: number,
  wr: number,
  axis: 0 | 1,
  G: number,
): [[number, number, number], number, number] {
  const nl = axis === 0 ? ul : wl,
    nr = axis === 0 ? ur : wr,
    sl = Math.abs(nl) + Math.sqrt(G * hl),
    sr = Math.abs(nr) + Math.sqrt(G * hr),
    s = Math.max(sl, sr),
    fl = [
      hl * nl,
      hl * ul * nl + (axis === 0 ? 0.5 * G * hl * hl : 0),
      hl * wl * nl + (axis === 1 ? 0.5 * G * hl * hl : 0),
    ],
    fr = [
      hr * nr,
      hr * ur * nr + (axis === 0 ? 0.5 * G * hr * hr : 0),
      hr * wr * nr + (axis === 1 ? 0.5 * G * hr * hr : 0),
    ],
    ql = [hl, hl * ul, hl * wl],
    qr = [hr, hr * ur, hr * wr];
  return [
    [
      0.5 * (fl[0]! + fr[0]!) - 0.5 * s * (qr[0]! - ql[0]!),
      0.5 * (fl[1]! + fr[1]!) - 0.5 * s * (qr[1]! - ql[1]!),
      0.5 * (fl[2]! + fr[2]!) - 0.5 * s * (qr[2]! - ql[2]!),
    ],
    sl,
    sr,
  ];
}
