// Brute-force references and random scene helpers. They call the same exact predicates as the BVH, so any
// disagreement comes from traversal or pruning, not from floating point differences in the triangle tests.
import {closestPointTriangle, invert, rayTriangle, sideCode, transformPoint, triangleBox, triangleOutsidePlanes, triangleTriangle} from '../dist/math.js';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {a = a + 0x6d2b79f5 >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296;};
}

/** Random triangle soup: small triangles scattered in a cube. */
export function soup(random, count, {size = 0.15, extent = 1} = {}) {
  const positions = new Float32Array(count * 9), indices = new Uint32Array(count * 3);
  for (let t = 0; t < count; t++) {
    const cx = (random() * 2 - 1) * extent, cy = (random() * 2 - 1) * extent, cz = (random() * 2 - 1) * extent;
    for (let v = 0; v < 3; v++) {
      positions[t * 9 + v * 3] = cx + (random() - 0.5) * size;
      positions[t * 9 + v * 3 + 1] = cy + (random() - 0.5) * size;
      positions[t * 9 + v * 3 + 2] = cz + (random() - 0.5) * size;
      indices[t * 3 + v] = t * 3 + v;
    }
  }
  return {positions, indices};
}

/** Closed, indexed, bumpy sphere with vertex normals (shared edges exercise tie handling). */
export function bumpySphere(random, segments = 24, rings = 16, bump = 0.15) {
  const positions = [], normals = [], indices = [];
  for (let r = 0; r <= rings; r++) {
    const phi = Math.PI * r / rings;
    for (let s = 0; s <= segments; s++) {
      const theta = 2 * Math.PI * s / segments, radius = 1 + (r === 0 || r === rings ? 0 : (random() - 0.5) * bump);
      const n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      positions.push(n[0] * radius, n[1] * radius, n[2] * radius); normals.push(...n);
    }
  }
  for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) {
    const a = r * (segments + 1) + s, b = a + segments + 1;
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  return {positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices)};
}

export function parseObj(text) {
  const positions = [], indices = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v') positions.push(+parts[1], +parts[2], +parts[3]);
    else if (parts[0] === 'f') {
      const face = parts.slice(1).map(p => parseInt(p, 10) - 1);
      for (let i = 1; i + 1 < face.length; i++) indices.push(face[0], face[i], face[i + 1]);
    }
  }
  return {positions: new Float32Array(positions), indices: new Uint32Array(indices)};
}

export function randomRay(random, extent = 1.5) {
  const origin = [(random() * 2 - 1) * extent, (random() * 2 - 1) * extent, (random() * 2 - 1) * extent];
  // Aim near the mesh so most rays hit something, and sometimes use axis-aligned directions.
  const target = [(random() * 2 - 1) * 0.8, (random() * 2 - 1) * 0.8, (random() * 2 - 1) * 0.8];
  let direction = [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]];
  const pick = random();
  if (pick < 0.08) direction = [0, 0, origin[2] > 0 ? -1 : 1];
  else if (pick < 0.12) direction = [origin[0] > 0 ? -1 : 1, 0, 0];
  else if (pick < 0.2) direction = direction.map(v => v * (0.1 + random() * 5)); // unnormalized
  return {origin, direction};
}

function triangleOf(mesh, face) {
  const P = mesh.positions, s = mesh.stride ?? 3, a = (mesh.indices ? mesh.indices[face * 3] : face * 3) * s, b = (mesh.indices ? mesh.indices[face * 3 + 1] : face * 3 + 1) * s, c = (mesh.indices ? mesh.indices[face * 3 + 2] : face * 3 + 2) * s;
  return [P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]];
}
const faceCount = mesh => (mesh.indices ? mesh.indices.length : mesh.positions.length / (mesh.stride ?? 3)) / 3;

export function bruteRay(mesh, ray, {near = 0, far = Infinity, side} = {}) {
  const d = ray.direction, o = ray.origin, length = Math.hypot(d[0], d[1], d[2]), code = sideCode(side), out = new Float64Array(4), hits = [];
  for (let f = 0, n = faceCount(mesh); f < n; f++) {
    const t = triangleOf(mesh, f);
    if (rayTriangle(o[0], o[1], o[2], d[0], d[1], d[2], ...t, code, near / length, far / length, out)) hits.push({faceIndex: f, distance: out[0] * length, frontFace: out[3] > 0});
  }
  return hits.sort((a, b) => a.distance - b.distance || a.faceIndex - b.faceIndex);
}

export function bruteClosest(mesh, point, maxDistance = Infinity) {
  const out = new Float64Array(6);
  let best = maxDistance * maxDistance, face = -1;
  for (let f = 0, n = faceCount(mesh); f < n; f++) {
    const d = closestPointTriangle(point[0], point[1], point[2], ...triangleOf(mesh, f), out);
    if (d < best || (face < 0 && d <= best)) {best = d; face = f;}
  }
  return face < 0 ? null : {faceIndex: face, distance: Math.sqrt(best)};
}

export function bruteSphere(mesh, center, radius) {
  const out = new Float64Array(6);
  for (let f = 0, n = faceCount(mesh); f < n; f++) if (closestPointTriangle(center[0], center[1], center[2], ...triangleOf(mesh, f), out) <= radius * radius) return true;
  return false;
}

/** Faces touching the oriented box (box space to mesh space by matrix). */
export function bruteBox(mesh, box, matrix) {
  const inverse = matrix ? invert(matrix) : null, tri = new Float64Array(9), faces = [];
  for (let f = 0, n = faceCount(mesh); f < n; f++) {
    const t = triangleOf(mesh, f);
    for (let v = 0; v < 3; v++) if (inverse) transformPoint(inverse, t[v * 3], t[v * 3 + 1], t[v * 3 + 2], tri, v * 3); else tri.set(t.slice(v * 3, v * 3 + 3), v * 3);
    if (triangleBox(tri, box.min[0], box.min[1], box.min[2], box.max[0], box.max[1], box.max[2])) faces.push(f);
  }
  return faces;
}

/** Every intersecting (faceA, faceB) pair with B placed into A's space by matrix. */
export function bruteMeshMesh(a, b, matrix) {
  const nb = faceCount(b), transformed = new Float64Array(nb * 9), pairs = [];
  for (let f = 0; f < nb; f++) {
    const t = triangleOf(b, f);
    for (let v = 0; v < 3; v++) transformPoint(matrix, t[v * 3], t[v * 3 + 1], t[v * 3 + 2], transformed, f * 9 + v * 3);
  }
  for (let f = 0, na = faceCount(a); f < na; f++) {
    const ta = Float64Array.from(triangleOf(a, f));
    for (let g = 0; g < nb; g++) if (triangleTriangle(ta, 0, transformed, g * 9)) pairs.push(f * 1e6 + g);
  }
  return pairs;
}

export function bruteFrustum(mesh, planes) {
  const faces = [];
  for (let f = 0, n = faceCount(mesh); f < n; f++) if (!triangleOutsidePlanes(planes, planes.length / 4, ...triangleOf(mesh, f))) faces.push(f);
  return faces;
}

/** Random rigid-plus-scale matrix (column-major), optionally mirrored or sheared. */
export function randomMatrix(random, {translate = 1, mirror = false, shear = false} = {}) {
  const q = [random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5], l = Math.hypot(...q), [x, y, z, w] = q.map(v => v / l);
  const s = [0.5 + random(), 0.5 + random(), 0.5 + random()];
  if (mirror) s[0] = -s[0];
  const r = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
  const m = new Float64Array(16);
  for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) m[c * 4 + row] = r[c * 3 + row] * s[c];
  if (shear) {m[4] += 0.3; m[9] -= 0.2;}
  m[12] = (random() * 2 - 1) * translate; m[13] = (random() * 2 - 1) * translate; m[14] = (random() * 2 - 1) * translate; m[15] = 1;
  return m;
}
