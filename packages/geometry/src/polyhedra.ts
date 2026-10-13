import {geometryData, sequentialIndices, type GeometryData} from './data.js';
import {finiteNumber} from './math.js';

type V3 = [number, number, number];

/**
 * Three.js `PolyhedronGeometry`: projects the faces onto a sphere of `radius`, splitting each triangle into
 * `(detail + 1)^2` triangles. Non-indexed like Three.js (indices are sequential). Flat normals at detail 0, smooth
 * (radial) normals above. Pass `smooth` explicitly to keep the same shading across LODs.
 * Faces are oriented outward even if the input winding is not.
 */
export function polyhedronGeometry(vertices: readonly number[], indices: readonly number[], radius = 1, detail = 0, smooth = detail >= 1): GeometryData {
  if (typeof smooth !== 'boolean') throw new TypeError('Expected boolean polyhedron smoothing');
  const cols = Math.max(0, Math.floor(finiteNumber(detail))) + 1, out: number[] = [];
  const at = (i: number): V3 => [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]];
  const mix = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  for (let f = 0; f < indices.length; f += 3) {
    let a = at(indices[f]), b = at(indices[f + 1]), c = at(indices[f + 2]);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (n[0] * (a[0] + b[0] + c[0]) + n[1] * (a[1] + b[1] + c[1]) + n[2] * (a[2] + b[2] + c[2]) < 0) [b, c] = [c, b];
    const v: V3[][] = [];
    for (let i = 0; i <= cols; i++) {
      v[i] = [];
      const aj = mix(a, c, i / cols), bj = mix(b, c, i / cols), rows = cols - i;
      for (let j = 0; j <= rows; j++) v[i][j] = j === 0 && i === cols ? aj : mix(aj, bj, j / rows);
    }
    for (let i = 0; i < cols; i++) for (let j = 0; j < 2 * (cols - i) - 1; j++) {
      const k = Math.floor(j / 2);
      if (j % 2 === 0) out.push(...v[i][k + 1], ...v[i + 1][k], ...v[i][k]);
      else out.push(...v[i][k + 1], ...v[i + 1][k + 1], ...v[i + 1][k]);
    }
  }
  const count = out.length / 3, normals = new Float32Array(out.length), uvs = new Float32Array(count * 2);
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] = out[i] / l * radius; out[i + 1] = out[i + 1] / l * radius; out[i + 2] = out[i + 2] / l * radius;
  }
  const azimuth = (x: number, z: number) => Math.atan2(z, -x);
  for (let i = 0; i < count; i++) {
    const x = out[i * 3], y = out[i * 3 + 1], z = out[i * 3 + 2];
    uvs[i * 2] = azimuth(x, z) / 2 / Math.PI + 0.5;
    uvs[i * 2 + 1] = 1 - (Math.atan2(-y, Math.hypot(x, z)) / Math.PI + 0.5);
  }
  for (let t = 0; t < count; t += 3) {
    // Three.js correctUVs: fix the seam and pole vertices using the triangle centroid's azimuth.
    const cx = (out[t * 3] + out[t * 3 + 3] + out[t * 3 + 6]) / 3, cz = (out[t * 3 + 2] + out[t * 3 + 5] + out[t * 3 + 8]) / 3, azi = azimuth(cx, cz);
    for (let k = 0; k < 3; k++) {
      const vi = t + k;
      if (azi < 0 && uvs[vi * 2] === 1) uvs[vi * 2] -= 1;
      if (out[vi * 3] === 0 && out[vi * 3 + 2] === 0) uvs[vi * 2] = azi / 2 / Math.PI + 0.5;
    }
    // Three.js correctSeam: wrap triangles that straddle u = 0/1.
    const u = [uvs[t * 2], uvs[t * 2 + 2], uvs[t * 2 + 4]];
    if (Math.max(...u) > 0.9 && Math.min(...u) < 0.1) for (let k = 0; k < 3; k++) if (u[k] < 0.2) uvs[(t + k) * 2] += 1;
  }
  for (let t = 0; t < count; t += 3) {
    let nx: number, ny: number, nz: number;
    if (!smooth) {
      const o = t * 3, e1 = [out[o + 3] - out[o], out[o + 4] - out[o + 1], out[o + 5] - out[o + 2]], e2 = [out[o + 6] - out[o], out[o + 7] - out[o + 1], out[o + 8] - out[o + 2]];
      nx = e1[1] * e2[2] - e1[2] * e2[1]; ny = e1[2] * e2[0] - e1[0] * e2[2]; nz = e1[0] * e2[1] - e1[1] * e2[0];
      const l = Math.hypot(nx, ny, nz) || 1;
      for (let k = 0; k < 3; k++) normals.set([nx / l, ny / l, nz / l], (t + k) * 3);
    } else {
      for (let k = 0; k < 3; k++) {
        const o = (t + k) * 3, l = Math.hypot(out[o], out[o + 1], out[o + 2]) || 1;
        normals.set([out[o] / l, out[o + 1] / l, out[o + 2] / l], o);
      }
    }
  }
  return geometryData(out, normals, uvs, sequentialIndices(count));
}

const PHI = (1 + Math.sqrt(5)) / 2, R = 1 / PHI;

/** Three.js `TetrahedronGeometry`. */
export function tetrahedronGeometry(radius = 1, detail = 0, smooth = detail >= 1): GeometryData {
  return polyhedronGeometry([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], [2, 1, 0, 0, 3, 2, 1, 3, 0, 2, 3, 1], radius, detail, smooth);
}

/** Three.js `OctahedronGeometry`. */
export function octahedronGeometry(radius = 1, detail = 0, smooth = detail >= 1): GeometryData {
  return polyhedronGeometry([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1], [0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 3, 1, 3, 4, 1, 4, 2], radius, detail, smooth);
}

/** Three.js `IcosahedronGeometry`. Detail above 1 approximates a sphere well. */
export function icosahedronGeometry(radius = 1, detail = 0, smooth = detail >= 1): GeometryData {
  const t = PHI;
  return polyhedronGeometry(
    [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1],
    [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1],
    radius, detail, smooth);
}

/** Three.js `DodecahedronGeometry` (12 pentagons as 36 triangles). */
export function dodecahedronGeometry(radius = 1, detail = 0, smooth = detail >= 1): GeometryData {
  const t = PHI, r = R;
  return polyhedronGeometry(
    [-1, -1, -1, -1, -1, 1, -1, 1, -1, -1, 1, 1, 1, -1, -1, 1, -1, 1, 1, 1, -1, 1, 1, 1,
      0, -r, -t, 0, -r, t, 0, r, -t, 0, r, t, -r, -t, 0, -r, t, 0, r, -t, 0, r, t, 0, -t, 0, -r, t, 0, -r, -t, 0, r, t, 0, r],
    [3, 11, 7, 3, 7, 15, 3, 15, 13, 7, 19, 17, 7, 17, 6, 7, 6, 15, 17, 4, 8, 17, 8, 10, 17, 10, 6, 8, 0, 16, 8, 16, 2, 8, 2, 10,
      0, 12, 1, 0, 1, 18, 0, 18, 16, 6, 10, 2, 6, 2, 13, 6, 13, 15, 2, 16, 18, 2, 18, 3, 2, 3, 13, 18, 1, 9, 18, 9, 11, 18, 11, 3,
      4, 14, 12, 4, 12, 0, 4, 0, 8, 11, 9, 5, 11, 5, 19, 11, 19, 7, 19, 5, 14, 19, 14, 4, 19, 4, 17, 1, 12, 14, 1, 14, 5, 1, 5, 9],
    radius, detail, smooth);
}
