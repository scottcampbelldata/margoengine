// Exact triangle predicates shared by the BVH queries and the brute-force references in the tests.
// Every function works in float64 on float32 inputs, so the BVH and a linear scan agree bit for bit.

/** Ray side filter. Front faces wind counter-clockwise when seen from the ray origin, matching the engine. */
export type Side = 'double' | 'front' | 'back';
export const SIDE_DOUBLE = 0, SIDE_FRONT = 1, SIDE_BACK = 2;
export const sideCode = (side: Side | undefined): number => {
  if (side === undefined || side === 'double') return SIDE_DOUBLE;
  if (side === 'front') return SIDE_FRONT;
  if (side === 'back') return SIDE_BACK;
  throw new TypeError(`Unknown side ${String(side)}`);
};

/**
 * Moller-Trumbore ray/triangle test. `out` receives t, u, v and det (det > 0 means a front face).
 * The hit point is origin + t * direction and its barycentric weights are (1 - u - v, u, v).
 */
export function rayTriangle(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number,
  side: number, tmin: number, tmax: number, out: Float64Array,
): boolean {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (side === SIDE_DOUBLE ? det === 0 : side === SIDE_FRONT ? !(det > 0) : !(det < 0)) return false;
  const inv = 1 / det, sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (!(u >= 0 && u <= 1)) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (!(v >= 0 && u + v <= 1)) return false;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (!(t >= tmin && t <= tmax)) return false;
  out[0] = t; out[1] = u; out[2] = v; out[3] = det;
  return true;
}

/**
 * Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5).
 * `out` receives x, y, z, then the barycentric weights of a, b and c. Returns the squared distance.
 */
export function closestPointTriangle(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number,
  out: Float64Array,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let wa: number, wb: number, wc: number;
  if (d1 <= 0 && d2 <= 0) { wa = 1; wb = 0; wc = 0; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { wa = 0; wb = 1; wc = 0; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const den = d1 - d3, v = den > 0 ? d1 / den : 0; wa = 1 - v; wb = v; wc = 0; }
      else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { wa = 0; wb = 0; wc = 1; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const den = d2 - d6, w = den > 0 ? d2 / den : 0; wa = 1 - w; wb = 0; wc = w; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const den = d4 - d3 + (d5 - d6), w = den > 0 ? (d4 - d3) / den : 0; wa = 0; wb = 1 - w; wc = w; }
            else {
              const sum = va + vb + vc;
              if (sum > 0) { const v = vb / sum, w = vc / sum; wa = 1 - v - w; wb = v; wc = w; }
              else { wa = 1; wb = 0; wc = 0; } // Degenerate (zero-area) triangle: fall back to a vertex.
            }
          }
        }
      }
    }
  }
  const x = wa * ax + wb * bx + wc * cx, y = wa * ay + wb * by + wc * cy, z = wa * az + wb * bz + wc * cz;
  out[0] = x; out[1] = y; out[2] = z; out[3] = wa; out[4] = wb; out[5] = wc;
  const ex = x - px, ey = y - py, ez = z - pz;
  return ex * ex + ey * ey + ez * ez;
}

/** Separating-axis triangle/AABB overlap (Akenine-Moller). Touching counts as overlapping. */
export function triangleBox(t: ArrayLike<number>, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
  const hx = (maxX - minX) * 0.5, hy = (maxY - minY) * 0.5, hz = (maxZ - minZ) * 0.5;
  const v0x = t[0] - cx, v0y = t[1] - cy, v0z = t[2] - cz, v1x = t[3] - cx, v1y = t[4] - cy, v1z = t[5] - cz, v2x = t[6] - cx, v2y = t[7] - cy, v2z = t[8] - cz;
  // Box face normals.
  if (Math.min(v0x, v1x, v2x) > hx || Math.max(v0x, v1x, v2x) < -hx) return false;
  if (Math.min(v0y, v1y, v2y) > hy || Math.max(v0y, v1y, v2y) < -hy) return false;
  if (Math.min(v0z, v1z, v2z) > hz || Math.max(v0z, v1z, v2z) < -hz) return false;
  const f0x = v1x - v0x, f0y = v1y - v0y, f0z = v1z - v0z, f1x = v2x - v1x, f1y = v2y - v1y, f1z = v2z - v1z, f2x = v0x - v2x, f2y = v0y - v2y, f2z = v0z - v2z;
  // Triangle normal.
  const nx = f0y * f1z - f0z * f1y, ny = f0z * f1x - f0x * f1z, nz = f0x * f1y - f0y * f1x;
  const d = nx * v0x + ny * v0y + nz * v0z, r = hx * Math.abs(nx) + hy * Math.abs(ny) + hz * Math.abs(nz);
  if (d > r || d < -r) return false;
  // Nine edge cross products.
  return axis(0, -f0z, f0y) && axis(0, -f1z, f1y) && axis(0, -f2z, f2y)
    && axis(f0z, 0, -f0x) && axis(f1z, 0, -f1x) && axis(f2z, 0, -f2x)
    && axis(-f0y, f0x, 0) && axis(-f1y, f1x, 0) && axis(-f2y, f2x, 0);
  function axis(ax: number, ay: number, az: number): boolean {
    const p0 = ax * v0x + ay * v0y + az * v0z, p1 = ax * v1x + ay * v1y + az * v1z, p2 = ax * v2x + ay * v2y + az * v2z;
    const rr = hx * Math.abs(ax) + hy * Math.abs(ay) + hz * Math.abs(az);
    return !(Math.min(p0, p1, p2) > rr || Math.max(p0, p1, p2) < -rr);
  }
}

/** Separating-axis triangle/triangle overlap, including the coplanar axes. Touching counts as overlapping. */
export function triangleTriangle(a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number): boolean {
  const a0x = a[ao], a0y = a[ao + 1], a0z = a[ao + 2], a1x = a[ao + 3], a1y = a[ao + 4], a1z = a[ao + 5], a2x = a[ao + 6], a2y = a[ao + 7], a2z = a[ao + 8];
  const b0x = b[bo], b0y = b[bo + 1], b0z = b[bo + 2], b1x = b[bo + 3], b1y = b[bo + 4], b1z = b[bo + 5], b2x = b[bo + 6], b2y = b[bo + 7], b2z = b[bo + 8];
  // Quick box reject.
  if (Math.max(a0x, a1x, a2x) < Math.min(b0x, b1x, b2x) || Math.max(b0x, b1x, b2x) < Math.min(a0x, a1x, a2x)) return false;
  if (Math.max(a0y, a1y, a2y) < Math.min(b0y, b1y, b2y) || Math.max(b0y, b1y, b2y) < Math.min(a0y, a1y, a2y)) return false;
  if (Math.max(a0z, a1z, a2z) < Math.min(b0z, b1z, b2z) || Math.max(b0z, b1z, b2z) < Math.min(a0z, a1z, a2z)) return false;
  const ea = [a1x - a0x, a1y - a0y, a1z - a0z, a2x - a1x, a2y - a1y, a2z - a1z, a0x - a2x, a0y - a2y, a0z - a2z];
  const eb = [b1x - b0x, b1y - b0y, b1z - b0z, b2x - b1x, b2y - b1y, b2z - b1z, b0x - b2x, b0y - b2y, b0z - b2z];
  const nax = ea[1] * ea[5] - ea[2] * ea[4], nay = ea[2] * ea[3] - ea[0] * ea[5], naz = ea[0] * ea[4] - ea[1] * ea[3];
  const nbx = eb[1] * eb[5] - eb[2] * eb[4], nby = eb[2] * eb[3] - eb[0] * eb[5], nbz = eb[0] * eb[4] - eb[1] * eb[3];
  if (separated(nax, nay, naz) || separated(nbx, nby, nbz)) return false;
  for (let i = 0; i < 9; i += 3) {
    const ux = ea[i], uy = ea[i + 1], uz = ea[i + 2];
    for (let j = 0; j < 9; j += 3) {
      const vx = eb[j], vy = eb[j + 1], vz = eb[j + 2];
      if (separated(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)) return false;
    }
  }
  // In-plane edge normals settle the coplanar case and are harmless otherwise.
  for (let i = 0; i < 9; i += 3) {
    if (separated(nay * ea[i + 2] - naz * ea[i + 1], naz * ea[i] - nax * ea[i + 2], nax * ea[i + 1] - nay * ea[i])) return false;
    if (separated(nby * eb[i + 2] - nbz * eb[i + 1], nbz * eb[i] - nbx * eb[i + 2], nbx * eb[i + 1] - nby * eb[i])) return false;
  }
  return true;
  function separated(x: number, y: number, z: number): boolean {
    const p0 = x * a0x + y * a0y + z * a0z, p1 = x * a1x + y * a1y + z * a1z, p2 = x * a2x + y * a2y + z * a2z;
    const q0 = x * b0x + y * b0y + z * b0z, q1 = x * b1x + y * b1y + z * b1z, q2 = x * b2x + y * b2y + z * b2z;
    return Math.max(p0, p1, p2) < Math.min(q0, q1, q2) || Math.max(q0, q1, q2) < Math.min(p0, p1, p2);
  }
}

/** True when the triangle is entirely on the negative side of one plane (the plane test used for frustum collection). */
export function triangleOutsidePlanes(planes: ArrayLike<number>, planeCount: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): boolean {
  for (let p = 0; p < planeCount * 4; p += 4) {
    const nx = planes[p], ny = planes[p + 1], nz = planes[p + 2], d = planes[p + 3];
    if (nx * ax + ny * ay + nz * az + d < 0 && nx * bx + ny * by + nz * bz + d < 0 && nx * cx + ny * cy + nz * cz + d < 0) return true;
  }
  return false;
}

/** Writes m * (x, y, z, 1) into out at offset. m is column-major. */
export function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number, out: Float64Array | number[], offset = 0): void {
  out[offset] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[offset + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[offset + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

/** Column-major 4x4 inverse in float64. Returns null for a singular matrix. */
export function invert(m: ArrayLike<number>, out: Float64Array = new Float64Array(16)): Float64Array | null {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return null;
  const inv = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * inv; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * inv;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * inv; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * inv;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * inv; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * inv;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * inv; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * inv;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * inv; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * inv;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * inv; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * inv;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * inv; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * inv;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * inv; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * inv;
  return out;
}

/** Column-major a * b. */
export function multiply(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array = new Float64Array(16)): Float64Array {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}

/**
 * Six normalized frustum planes (nx, ny, nz, d; inside when n.p + d >= 0) from a column-major view-projection
 * matrix. `webgpu` selects WebGPU clip depth (0..1, the engine's reversed-Z) instead of WebGL's -1..1.
 * Multiply the camera matrix by a world matrix first to get planes in that object's local space.
 */
export function frustumPlanes(matrix: ArrayLike<number>, webgpu = true, out: Float64Array = new Float64Array(24)): Float64Array {
  for (let plane = 0; plane < 6; plane++) {
    const row = plane >> 1, sign = plane % 2 === 0 ? 1 : -1;
    let length = 0;
    for (let c = 0; c < 4; c++) {
      const value = plane === 4 && webgpu ? matrix[c * 4 + 2] : matrix[c * 4 + 3] + sign * matrix[c * 4 + row];
      out[plane * 4 + c] = value; if (c < 3) length += value * value;
    }
    length = Math.sqrt(length);
    if (!length) throw new RangeError('Degenerate frustum');
    for (let c = 0; c < 4; c++) out[plane * 4 + c] /= length;
  }
  return out;
}
