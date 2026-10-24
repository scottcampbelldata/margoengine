// Two-level voxel traversal on the CPU: Amanatides and Woo's grid walk ("A Fast Voxel Traversal Algorithm for Ray
// Tracing", 1987) over 8^3 bricks, and inside a mixed brick over its voxels. The WGSL march in shaders.ts is the same
// walk step for step; VoxelPathTracer.raycast uses this one, and the browser check compares the two per pixel.
import { BRICK_WORDS, type PackedModel, type SceneSnapshot, SHAPED, UNIFORM } from './scene.js';

/** Result of {@link march}: the boundary crossed and the cell entered. */
interface MarchHit {
  /** Ray parameter of the boundary (world distance when the world direction is unit length). */
  t: number;
  /** Palette index of the cell entered (0 for empty space or leaving the model). */
  value: number;
  /** Axis of the face crossed, 0 to 2. */
  axis: number;
  /** Sign of the face normal along `axis`, pointing back toward the ray's origin. */
  sign: number;
  /** Cell entered (model-local). */
  cell: [number, number, number];
}

const TINY = 1e-12;
const inverse = (d: number) => 1 / (Math.abs(d) < TINY ? (d < 0 ? -TINY : TINY) : d);

/**
 * Where o + t d first reaches a half block of cell c that is filled (`fill`) or empty, walking the cell's 2 x 2 x 2
 * half blocks of `mask` (bit x + 2y + 4z) from t0, entered across axis a0 (3: the ray starts inside), to t1: [t, axis],
 * or undefined. The same walk as the shader's octWalk.
 */
function octWalk(
  mask: number,
  o: readonly number[],
  d: readonly number[],
  c: readonly number[],
  t0: number,
  t1: number,
  a0: number,
  fill: boolean,
): [number, number] | undefined {
  // The half the ray is in just after t0, and when it crosses into the other half on each axis.
  const ts = t0 + Math.min((t1 - t0) * 0.5, 1e-4),
    h = [0, 0, 0],
    next = [Infinity, Infinity, Infinity];
  for (let a = 0; a < 3; a++) {
    h[a] = o[a] + d[a] * ts - c[a] >= 0.5 ? 1 : 0;
    if ((d[a] > 0 && !h[a]) || (d[a] < 0 && h[a])) next[a] = (c[a] + 0.5 - o[a]) * inverse(d[a]);
  }
  let t = t0,
    axis = a0;
  for (let i = 0; i < 4; i++) {
    if ((((mask >> (h[0] | (h[1] << 1) | (h[2] << 2))) & 1) === 1) === fill) return [t, axis];
    t = Math.min(next[0], next[1], next[2]);
    if (!(t < t1)) return undefined;
    axis = next[0] === t ? 0 : next[1] === t ? 1 : 2;
    h[axis] ^= 1;
    next[axis] = Infinity;
  }
  return undefined;
}

/**
 * Walks the model-local ray `o + t d` (d need not be unit length) through `m` for t in [tMin, tMax) and returns the
 * first boundary into a cell whose palette index differs from `target` (0 outside a volume). A shaped cell holds its
 * index in its filled half blocks and 0 elsewhere, so its boundaries are those of its half-block boxes. When `target` is not 0
 * and the ray leaves the model first, the exit through the model's box is returned with value 0.
 */
function march(
  m: PackedModel,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  tMin: number,
  tMax: number,
  target: number,
  out: MarchHit,
): boolean {
  const [sx, sy, sz] = m.size,
    [bx, by, bz] = m.bricks,
    ix = inverse(dx),
    iy = inverse(dy),
    iz = inverse(dz);
  const ax = -ox * ix,
    bxT = (sx - ox) * ix,
    ay = -oy * iy,
    byT = (sy - oy) * iy,
    az = -oz * iz,
    bzT = (sz - oz) * iz;
  const nx = Math.min(ax, bxT),
    ny = Math.min(ay, byT),
    nz = Math.min(az, bzT),
    fx = Math.max(ax, bxT),
    fy = Math.max(ay, byT),
    fz = Math.max(az, bzT);
  const tEnter = Math.max(nx, ny, nz, tMin),
    tExit = Math.min(fx, fy, fz, tMax);
  if (!(tEnter < tExit)) return false;
  let axis = 3;
  if (tEnter > tMin) axis = tEnter === nx ? 0 : tEnter === ny ? 1 : 2;
  const stepX = dx >= 0 ? 1 : -1,
    stepY = dy >= 0 ? 1 : -1,
    stepZ = dz >= 0 ? 1 : -1,
    upX = dx >= 0 ? 1 : 0,
    upY = dy >= 0 ? 1 : 0,
    upZ = dz >= 0 ? 1 : 0,
    adx = Math.abs(ix),
    ady = Math.abs(iy),
    adz = Math.abs(iz);
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  let cx = clamp(Math.floor((ox + dx * tEnter) / 8), 0, bx - 1),
    cy = clamp(Math.floor((oy + dy * tEnter) / 8), 0, by - 1),
    cz = clamp(Math.floor((oz + dz * tEnter) / 8), 0, bz - 1);
  let tnx = ((cx + upX) * 8 - ox) * ix,
    tny = ((cy + upY) * 8 - oy) * iy,
    tnz = ((cz + upZ) * 8 - oz) * iz,
    t = tEnter;
  const record = (tt: number, value: number, a: number, x: number, y: number, z: number) => {
    let ra = a,
      sign: number;
    if (ra === 3) {
      // Started inside a cell that differs from target: no face crossed; report the dominant axis.
      const ad = [Math.abs(dx), Math.abs(dy), Math.abs(dz)];
      ra = ad[0] >= ad[1] && ad[0] >= ad[2] ? 0 : ad[1] >= ad[2] ? 1 : 2;
    }
    sign = -[stepX, stepY, stepZ][ra];
    out.t = tt;
    out.value = value;
    out.axis = ra;
    out.sign = sign;
    out.cell = [x, y, z];
    return true;
  };
  for (;;) {
    const entry = m.grid[cx + bx * (cz + bz * cy)],
      tOut = Math.min(tnx, tny, tnz, tExit);
    const lx = cx * 8,
      ly = cy * 8,
      lz = cz * 8,
      hx = Math.min(lx + 8, sx) - 1,
      hy = Math.min(ly + 8, sy) - 1,
      hz = Math.min(lz + 8, sz) - 1;
    if (entry === 0 || entry >= UNIFORM) {
      const u = entry === 0 ? 0 : entry & 255;
      if (u !== target)
        return record(
          t,
          u,
          axis,
          clamp(Math.floor(ox + dx * t), lx, hx),
          clamp(Math.floor(oy + dy * t), ly, hy),
          clamp(Math.floor(oz + dz * t), lz, hz),
        );
    } else {
      const base = ((entry & ~SHAPED) - 1) * BRICK_WORDS,
        shaped = (entry & SHAPED) !== 0;
      let vx = clamp(Math.floor(ox + dx * t), lx, hx),
        vy = clamp(Math.floor(oy + dy * t), ly, hy),
        vz = clamp(Math.floor(oz + dz * t), lz, hz),
        vnx = (vx + upX - ox) * ix,
        vny = (vy + upY - oy) * iy,
        vnz = (vz + upZ - oz) * iz,
        vt = t,
        va = axis;
      for (;;) {
        const b = vx - lx + 8 * (vz - lz + 8 * (vy - ly)),
          v = (m.payload[base + (b >> 2)] >>> ((b & 3) * 8)) & 255,
          mask = shaped && v ? (m.payload[base + BRICK_WORDS + (b >> 2)] >>> ((b & 3) * 8)) & 255 : 0;
        if (mask) {
          const o = [ox, oy, oz],
            d = [dx, dy, dz],
            c = [vx, vy, vz],
            tc = Math.min(vnx, vny, vnz);
          if (v === target) {
            const r = octWalk(mask, o, d, c, vt, tc, va, false);
            if (r) return record(r[0], 0, r[1], vx, vy, vz);
          } else {
            const r = octWalk(mask, o, d, c, vt, tc, va, true);
            // In a volume, entering the empty part of a shaped cell leaves the volume there.
            if (target !== 0 && (!r || r[0] > vt)) return record(vt, 0, va, vx, vy, vz);
            if (r) return record(r[0], v, r[1], vx, vy, vz);
          }
        } else if (v !== target) return record(vt, v, va, vx, vy, vz);
        if (vnx < vny && vnx < vnz) {
          va = 0;
          vt = vnx;
          vx += stepX;
          vnx += adx;
        } else if (vny < vnz) {
          va = 1;
          vt = vny;
          vy += stepY;
          vny += ady;
        } else {
          va = 2;
          vt = vnz;
          vz += stepZ;
          vnz += adz;
        }
        if (vt >= tOut || vx < lx || vy < ly || vz < lz || vx > hx || vy > hy || vz > hz) break;
      }
    }
    if (tOut >= tExit) break;
    if (tnx < tny && tnx < tnz) {
      axis = 0;
      t = tnx;
      cx += stepX;
      tnx += adx * 8;
    } else if (tny < tnz) {
      axis = 1;
      t = tny;
      cy += stepY;
      tny += ady * 8;
    } else {
      axis = 2;
      t = tnz;
      cz += stepZ;
      tnz += adz * 8;
    }
    if (cx < 0 || cy < 0 || cz < 0 || cx >= bx || cy >= by || cz >= bz) break;
  }
  if (target === 0) return false;
  // Leaving a volume through the model's box: the face is the box's, the cell beyond it is outside the model.
  const exit = fx <= fy && fx <= fz ? 0 : fy <= fz ? 1 : 2;
  return record(tExit, 0, exit, Math.floor(ox + dx * tExit), Math.floor(oy + dy * tExit), Math.floor(oz + dz * tExit));
}

/** The closest visible voxel along a world ray, or undefined. `direction` is normalised here. */
export function raycastSnapshot(
  snapshot: SceneSnapshot,
  origin: readonly number[],
  direction: readonly number[],
  maxDistance: number,
):
  | {
      instance: number;
      hit: MarchHit;
      distance: number;
    }
  | undefined {
  const length = Math.hypot(direction[0], direction[1], direction[2]),
    d = [direction[0] / length, direction[1] / length, direction[2] / length],
    hit: MarchHit = { t: 0, value: 0, axis: 0, sign: 0, cell: [0, 0, 0] };
  let best: { instance: number; hit: MarchHit; distance: number } | undefined,
    tMax = maxDistance;
  for (const [i, instance] of snapshot.instances.entries()) {
    const b = instance.box;
    // Slab test against the instance's world box first.
    let lo = 0,
      hi = tMax;
    for (let a = 0; a < 3 && lo <= hi; a++) {
      const inv = inverse(d[a]),
        t0 = (b[a] - origin[a]) * inv,
        t1 = (b[a + 3] - origin[a]) * inv;
      lo = Math.max(lo, Math.min(t0, t1));
      hi = Math.min(hi, Math.max(t0, t1));
    }
    if (lo > hi) continue;
    const r = instance.toLocal,
      lo3 = [0, 1, 2].map(
        (k) => r[k * 4] * origin[0] + r[k * 4 + 1] * origin[1] + r[k * 4 + 2] * origin[2] + r[k * 4 + 3],
      ),
      ld = [0, 1, 2].map((k) => r[k * 4] * d[0] + r[k * 4 + 1] * d[1] + r[k * 4 + 2] * d[2]);
    if (
      march(snapshot.models[instance.model], lo3[0], lo3[1], lo3[2], ld[0], ld[1], ld[2], 0, tMax, 0, hit) &&
      hit.t < tMax
    ) {
      tMax = hit.t;
      best = { instance: i, hit: { ...hit, cell: [...hit.cell] }, distance: hit.t };
    }
  }
  return best;
}
