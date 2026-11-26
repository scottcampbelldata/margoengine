// The liquid's particles and their transfers to and from the grid (FLUID-03): the affine particle-in-cell method on a
// MAC grid. Sources (read as text; no code; docs/clean-room.md "Grid-particle liquids"):
// - C. Jiang, C. Schroeder, A. Selle, J. Teran and A. Stomakhin, "The affine particle-in-cell method", ACM Trans. Graph.
//   34(4), 51, 2015, and its J. Comput. Phys. version, arXiv 1603.06188: on a MAC grid each particle carries its velocity
//   and one vector c_a per face axis; to the faces, m_ai v_ai = sum_p m_p w_aip (v_p . e_a + c_pa . (x_ai - x_p)); back,
//   v_p . e_a = sum_i w_aip v_ai and c_pa = sum_i grad(w_aip) v_ai, with trilinear weights. Linear and angular momentum
//   are kept by both transfers; the grid's filtering keeps it free of FLIP's ringing.
// - Y. Zhu and R. Bridson, "Animating sand as a fluid", ACM Trans. Graph. 24(3), 965-972, 2005: eight particles a cell,
//   jittered in its octants. Margo seeds them at the octants' centres instead, without the jitter: still water then
//   holds the density projection's rest state exactly, so it stays still, and water at rest in a deck puts no sideways
//   load on its hull; jittered seeds set it moving at millimetres a second from the start (measured, cells of 5 cm).
//   The liquid's surface from the particles, phi(x) = |x - xbar| - rbar with xbar and rbar the averages weighted by k(s) = max(0, (1 - s^2)^3), s = |x - x_p| / R, R twice the particle spacing; velocities carried
//   into the air a few cells for the particles near the surface.
import { AIR, cell, faceU, faceV, faceW, type GridShape, LIQUID, SOLID } from './grid.js';

/** f64 words a particle holds: position (3), velocity (3), and the affine vectors c_x, c_y, c_z (3 each). */
export const PARTICLE_WORDS = 15;

/** The trilinear weights and their gradients of a point on a face grid, and the base node. */
interface Stencil {
  i: number;
  j: number;
  k: number;
  fx: number;
  fy: number;
  fz: number;
}

/**
 * The base node and fractions of point (x, y, z) on the face grid of axis `a` (0 x, 1 y, 2 z) of grid `g`, whose
 * origin (the grid's lowest corner) is at 0: x faces sit at (i h, (j + 1/2) h, (k + 1/2) h), and so on.
 */
function stencil(g: GridShape, a: number, x: number, y: number, z: number, out: Stencil, walls?: Uint8Array): Stencil {
  const h = g.h,
    gx = x / h - (a === 0 ? 0 : 0.5),
    gy = y / h - (a === 1 ? 0 : 0.5),
    gz = z / h - (a === 2 ? 0 : 0.5),
    // The face grid's node counts along each axis.
    mx = a === 0 ? g.nx + 1 : g.nx,
    my = a === 1 ? g.ny + 1 : g.ny,
    mz = a === 2 ? g.nz + 1 : g.nz,
    i = Math.min(Math.max(Math.floor(gx), 0), mx - 2),
    j = Math.min(Math.max(Math.floor(gy), 0), Math.max(my - 2, 0)),
    k = Math.min(Math.max(Math.floor(gz), 0), Math.max(mz - 2, 0));
  out.i = i;
  out.j = j;
  out.k = k;
  out.fx = Math.min(Math.max(gx - i, 0), 1);
  out.fy = my > 1 ? Math.min(Math.max(gy - j, 0), 1) : 0;
  out.fz = mz > 1 ? Math.min(Math.max(gz - k, 0), 1) : 0;
  if (walls) {
    // Across a solid's side (a face row inside the wall next to one that is not), clamp as at the box's own sides: the
    // value of the row beside the wall, the gradient from that row inward.
    const m = [mx, my, mz];
    for (let b = 0; b < 3; b++) {
      if (b === a || m[b]! < 2) continue;
      const n = [out.i, out.j, out.k],
        f = [out.fx, out.fy, out.fz];
      // The stencil's nearest nodes along the other axes.
      for (let c = 0; c < 3; c++) if (c !== b) n[c] = Math.min(n[c]! + (f[c]! >= 0.5 ? 1 : 0), m[c]! - 1);
      const lo = n.slice(),
        hi = n.slice();
      hi[b]!++;
      const w0 = walls[faceIndex(g, a, lo[0]!, lo[1]!, lo[2]!)],
        w1 = walls[faceIndex(g, a, hi[0]!, hi[1]!, hi[2]!)];
      if (w0 === w1) continue;
      const base = b === 0 ? out.i : b === 1 ? out.j : out.k;
      let nb: number, nf: number;
      if (w0) [nb, nf] = base + 1 <= m[b]! - 2 ? [base + 1, 0] : [base, 1];
      else [nb, nf] = base - 1 >= 0 ? [base - 1, 1] : [base, 0];
      if (b === 0) [out.i, out.fx] = [nb, nf];
      else if (b === 1) [out.j, out.fy] = [nb, nf];
      else [out.k, out.fz] = [nb, nf];
    }
  }
  return out;
}

/**
 * Which faces of each axis lie inside a wall, solid (or beyond the box) on both sides: 1 for such a face. The transfers
 * take them as `walls`, so the liquid reads a solid's side as it reads the box's own sides.
 */
export function wallFaces(g: GridShape, solid: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [],
    n = [g.nx, g.ny, g.nz];
  for (let a = 0; a < 3; a++) {
    const [mx, my, mz] = faceCount(g, a),
      m = new Uint8Array(mx * my * mz);
    for (let k = 0; k < mz; k++)
      for (let j = 0; j < my; j++)
        for (let i = 0; i < mx; i++) {
          const b = [i, j, k],
            c = [i, j, k];
          b[a]!--;
          const sa = b[a]! < 0 || solid[cell(g, b[0]!, b[1]!, b[2]!)] === 1,
            sb = c[a]! >= n[a]! || solid[cell(g, c[0]!, c[1]!, c[2]!)] === 1;
          if (sa && sb) m[faceIndex(g, a, i, j, k)] = 1;
        }
    out.push(m);
  }
  return out;
}

const faceIndex = (g: GridShape, a: number, i: number, j: number, k: number): number =>
  a === 0 ? faceU(g, i, j, k) : a === 1 ? faceV(g, i, j, k) : faceW(g, i, j, k);
const faceCount = (g: GridShape, a: number): [number, number, number] =>
  a === 0 ? [g.nx + 1, g.ny, g.nz] : a === 1 ? [g.nx, g.ny + 1, g.nz] : [g.nx, g.ny, g.nz + 1];

/**
 * Particles to faces (APIC): fills `vel[a]` with each face's mass-weighted velocity and `mass[a]` with its weight,
 * from `count` particles of `p` (PARTICLE_WORDS each). Faces no particle reaches keep 0 weight. `walls` (from
 * wallFaces) makes a solid's side read as the box's own sides.
 */
export function toGrid(
  g: GridShape,
  p: Float64Array,
  count: number,
  vel: Float64Array[],
  mass: Float64Array[],
  walls?: Uint8Array[],
): void {
  const s: Stencil = { i: 0, j: 0, k: 0, fx: 0, fy: 0, fz: 0 },
    h = g.h;
  for (let a = 0; a < 3; a++) {
    vel[a]!.fill(0);
    mass[a]!.fill(0);
    const [mx, my, mz] = faceCount(g, a);
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS,
        x = p[o]!,
        y = p[o + 1]!,
        z = p[o + 2]!,
        va = p[o + 3 + a]!,
        cx = p[o + 6 + 3 * a]!,
        cy = p[o + 7 + 3 * a]!,
        cz = p[o + 8 + 3 * a]!;
      stencil(g, a, x, y, z, s, walls?.[a]);
      for (let dk = 0; dk < 2; dk++) {
        const kk = s.k + dk;
        if (kk >= mz) continue;
        const wz = dk ? s.fz : 1 - s.fz;
        for (let dj = 0; dj < 2; dj++) {
          const jj = s.j + dj;
          if (jj >= my) continue;
          const wy = dj ? s.fy : 1 - s.fy;
          for (let di = 0; di < 2; di++) {
            const ii = s.i + di;
            if (ii >= mx) continue;
            const wgt = (di ? s.fx : 1 - s.fx) * wy * wz;
            if (wgt === 0) continue;
            // The face's position less the particle's.
            const dx = (ii + (a === 0 ? 0 : 0.5)) * h - x,
              dy = (jj + (a === 1 ? 0 : 0.5)) * h - y,
              dz = (kk + (a === 2 ? 0 : 0.5)) * h - z,
              f = faceIndex(g, a, ii, jj, kk);
            vel[a]![f]! += wgt * (va + cx * dx + cy * dy + cz * dz);
            mass[a]![f]! += wgt;
          }
        }
      }
    }
    const va = vel[a]!,
      ma = mass[a]!;
    for (let f = 0; f < va.length; f++) if (ma[f]! > 0) va[f]! /= ma[f]!;
  }
}

/**
 * Faces to particles (APIC): each particle's velocity and affine vectors from the faces' velocities. `walls` (from
 * wallFaces) makes a solid's side read as the box's own sides.
 */
export function toParticles(
  g: GridShape,
  p: Float64Array,
  count: number,
  vel: Float64Array[],
  walls?: Uint8Array[],
): void {
  const s: Stencil = { i: 0, j: 0, k: 0, fx: 0, fy: 0, fz: 0 },
    h = g.h;
  for (let a = 0; a < 3; a++) {
    const [mx, my, mz] = faceCount(g, a),
      va = vel[a]!;
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS;
      stencil(g, a, p[o]!, p[o + 1]!, p[o + 2]!, s, walls?.[a]);
      let v = 0,
        gx = 0,
        gy = 0,
        gz = 0;
      for (let dk = 0; dk < 2; dk++) {
        const kk = Math.min(s.k + dk, mz - 1),
          wz = mz > 1 ? (dk ? s.fz : 1 - s.fz) : dk ? 0 : 1,
          dwz = mz > 1 ? (dk ? 1 : -1) / h : 0;
        for (let dj = 0; dj < 2; dj++) {
          const jj = Math.min(s.j + dj, my - 1),
            wy = my > 1 ? (dj ? s.fy : 1 - s.fy) : dj ? 0 : 1,
            dwy = my > 1 ? (dj ? 1 : -1) / h : 0;
          for (let di = 0; di < 2; di++) {
            const ii = Math.min(s.i + di, mx - 1),
              wx = di ? s.fx : 1 - s.fx,
              dwx = (di ? 1 : -1) / h,
              f = va[faceIndex(g, a, ii, jj, kk)]!;
            v += wx * wy * wz * f;
            gx += dwx * wy * wz * f;
            gy += wx * dwy * wz * f;
            gz += wx * wy * dwz * f;
          }
        }
      }
      p[o + 3 + a] = v;
      p[o + 6 + 3 * a] = gx;
      p[o + 7 + 3 * a] = gy;
      p[o + 8 + 3 * a] = gz;
    }
  }
}

/**
 * The face velocity field's value at a point (trilinear on each face grid), into `out`. `walls` (from wallFaces) makes
 * a solid's side read as the box's own sides.
 */
export function sampleVelocity(
  g: GridShape,
  vel: Float64Array[],
  x: number,
  y: number,
  z: number,
  out: [number, number, number],
  walls?: Uint8Array[],
): [number, number, number] {
  const s: Stencil = { i: 0, j: 0, k: 0, fx: 0, fy: 0, fz: 0 };
  for (let a = 0; a < 3; a++) {
    const [mx, my, mz] = faceCount(g, a),
      va = vel[a]!;
    stencil(g, a, x, y, z, s, walls?.[a]);
    let v = 0;
    for (let dk = 0; dk < 2; dk++) {
      const kk = Math.min(s.k + dk, mz - 1),
        wz = mz > 1 ? (dk ? s.fz : 1 - s.fz) : dk ? 0 : 1;
      for (let dj = 0; dj < 2; dj++) {
        const jj = Math.min(s.j + dj, my - 1),
          wy = my > 1 ? (dj ? s.fy : 1 - s.fy) : dj ? 0 : 1;
        for (let di = 0; di < 2; di++) {
          const ii = Math.min(s.i + di, mx - 1);
          v += (di ? s.fx : 1 - s.fx) * wy * wz * va[faceIndex(g, a, ii, jj, kk)]!;
        }
      }
    }
    out[a] = v;
  }
  return out;
}

/**
 * The liquid's surface (Zhu and Bridson 2005): phi at the cell centres, negative in the liquid, from the particles
 * within R = `radius` of each centre; far from every particle, `far`. Solid cells keep their kind; liquid cells are
 * the non-solid cells with phi below 0.
 */
export function surface(
  g: GridShape,
  p: Float64Array,
  count: number,
  radius: number,
  particleRadius: number,
  kind: Uint8Array,
  phi: Float64Array,
): void {
  const { nx, ny, nz, h } = g,
    n = nx * ny * nz,
    sw = new Float64Array(n),
    sx = new Float64Array(n),
    sy = new Float64Array(n),
    sz = new Float64Array(n),
    reach = Math.ceil(radius / h);
  for (let q = 0; q < count; q++) {
    const o = q * PARTICLE_WORDS,
      x = p[o]!,
      y = p[o + 1]!,
      z = p[o + 2]!,
      ci = Math.floor(x / h),
      cj = Math.floor(y / h),
      ck = Math.floor(z / h);
    for (let k = Math.max(0, ck - reach); k <= Math.min(nz - 1, ck + reach); k++)
      for (let j = Math.max(0, cj - reach); j <= Math.min(ny - 1, cj + reach); j++)
        for (let i = Math.max(0, ci - reach); i <= Math.min(nx - 1, ci + reach); i++) {
          const dx = (i + 0.5) * h - x,
            dy = (j + 0.5) * h - y,
            dz = (k + 0.5) * h - z,
            s2 = (dx * dx + dy * dy + dz * dz) / (radius * radius);
          if (s2 >= 1) continue;
          const t = 1 - s2,
            wgt = t * t * t,
            c = cell(g, i, j, k);
          sw[c]! += wgt;
          sx[c]! += wgt * x;
          sy[c]! += wgt * y;
          sz[c]! += wgt * z;
        }
  }
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = cell(g, i, j, k);
        if (kind[c] === SOLID) {
          phi[c] = 3 * h;
          continue;
        }
        if (!(sw[c]! > 0)) {
          phi[c] = 3 * h;
          kind[c] = AIR;
          continue;
        }
        const ax = sx[c]! / sw[c]! - (i + 0.5) * h,
          ay = sy[c]! / sw[c]! - (j + 0.5) * h,
          az = sz[c]! / sw[c]! - (k + 0.5) * h;
        phi[c] = Math.sqrt(ax * ax + ay * ay + az * az) - particleRadius;
        kind[c] = phi[c]! < 0 ? LIQUID : AIR;
      }
}

/**
 * Carries the velocity from the faces next to liquid, and the faces particles reach (spray and thin sheets, which make
 * no liquid cell, keep the velocity their particles gave them), out into the air and into the walls, `layers` faces
 * deep, as the average of the known neighbours on the same face grid (the particles near the surface and the walls read
 * it there). `wallsOnly` fills only the faces inside walls, every other face known as it stands.
 */
export function extrapolate(
  g: GridShape,
  kind: Uint8Array,
  vel: Float64Array[],
  layers: number,
  mass?: Float64Array[],
  wallsOnly = false,
): void {
  for (let a = 0; a < 3; a++) {
    const [mx, my, mz] = faceCount(g, a),
      va = vel[a]!,
      known = new Uint8Array(va.length);
    // A face is known when a liquid cell is on either side of it.
    for (let k = 0; k < mz; k++)
      for (let j = 0; j < my; j++)
        for (let i = 0; i < mx; i++) {
          const f = faceIndex(g, a, i, j, k),
            b = [i, j, k],
            c = [i, j, k];
          b[a]!--;
          const hasA = b[a]! >= 0,
            hasB = c[a]! < [g.nx, g.ny, g.nz][a]!,
            kA = hasA ? kind[cell(g, b[0]!, b[1]!, b[2]!)] : SOLID,
            kB = hasB ? kind[cell(g, c[0]!, c[1]!, c[2]!)] : SOLID;
          // A face inside a wall (solid or beyond the box on both sides) is never known: it takes its neighbours'
          // velocity, so the liquid slips along a solid as along the box's sides (the particles' own transfer to it,
          // their affine part reaching into the wall, would drag or push the water beside it).
          const walled = kA === SOLID && kB === SOLID;
          known[f] =
            !walled && (wallsOnly || kA === LIQUID || kB === LIQUID || (mass !== undefined && mass[a]![f]! > 0))
              ? 1
              : 0;
          if (!known[f]) va[f] = 0;
        }
    for (let layer = 0; layer < layers; layer++) {
      const next = known.slice(),
        update = new Float64Array(va.length);
      for (let k = 0; k < mz; k++)
        for (let j = 0; j < my; j++)
          for (let i = 0; i < mx; i++) {
            const f = faceIndex(g, a, i, j, k);
            if (known[f]) continue;
            let sum = 0,
              m = 0;
            for (const [di, dj, dk] of [
              [-1, 0, 0],
              [1, 0, 0],
              [0, -1, 0],
              [0, 1, 0],
              [0, 0, -1],
              [0, 0, 1],
            ] as const) {
              const ii = i + di,
                jj = j + dj,
                kk = k + dk;
              if (ii < 0 || jj < 0 || kk < 0 || ii >= mx || jj >= my || kk >= mz) continue;
              const o = faceIndex(g, a, ii, jj, kk);
              if (known[o]) {
                sum += va[o]!;
                m++;
              }
            }
            if (m > 0) {
              update[f] = sum / m;
              next[f] = 1;
            }
          }
      for (let f = 0; f < va.length; f++) if (next[f] && !known[f]) va[f] = update[f]!;
      known.set(next);
    }
  }
}

export { AIR, LIQUID, SOLID };
