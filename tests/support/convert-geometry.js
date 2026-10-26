// World-space triangles of a GLB, for comparing a model before and after margo-convert: meshopt views are decoded,
// quantised attributes are converted back to floats, and node transforms are applied. Independent of the
// optimiser's passes (it only reuses the reader).
import { readModel } from '../../tools/margo-convert/pipeline/gltf-io.js';

const SCALE = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/** Floats from an accessor's values, undoing `normalized`. */
export function floats(attr) {
  if (attr.componentType === 5126 || !attr.normalized) return Float64Array.from(attr.values);
  const max = SCALE[attr.componentType],
    signed = attr.componentType === 5120 || attr.componentType === 5122;
  return Float64Array.from(attr.values, (v) => (signed ? Math.max(v / max, -1) : v / max));
}

function local(node) {
  if (node.matrix) return Float64Array.from(node.matrix);
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1],
    [sx, sy, sz] = node.scale ?? [1, 1, 1],
    [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return Float64Array.from([
    (1 - 2 * (qy * qy + qz * qz)) * sx,
    2 * (qx * qy + qz * qw) * sx,
    2 * (qx * qz - qy * qw) * sx,
    0,
    2 * (qx * qy - qz * qw) * sy,
    (1 - 2 * (qx * qx + qz * qz)) * sy,
    2 * (qy * qz + qx * qw) * sy,
    0,
    2 * (qx * qz + qy * qw) * sz,
    2 * (qy * qz - qx * qw) * sz,
    (1 - 2 * (qx * qx + qy * qy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ]);
}

function mul(a, b) {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

/** Rows of the inverse transpose of the upper 3x3 (the adjugate, up to a positive scale for normals). */
function adjugate(m) {
  const a = m[0],
    b = m[4],
    c = m[8],
    d = m[1],
    e = m[5],
    f = m[9],
    g = m[2],
    h = m[6],
    i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const sign = det < 0 ? -1 : 1;
  return [
    e * i - f * h,
    -(d * i - f * g),
    d * h - e * g,
    -(b * i - c * h),
    a * i - c * g,
    -(a * h - b * g),
    b * f - c * e,
    -(a * f - c * d),
    a * e - b * d,
  ].map((v) => v * sign);
}

/**
 * Triangles in world space: an array of Float64Array(18): three positions, then three unit normals (zeros without NORMAL). Winding follows the file.
 * @param {Uint8Array} glb
 * @param {(uri: string) => Uint8Array} [resolve]
 */
export function worldTriangles(glb, resolve) {
  const model = readModel(glb, resolve),
    json = model.json,
    out = [];
  const draw = (node, world) => {
    const m = mul(world, local(node));
    if (node.mesh !== undefined)
      for (const prim of json.meshes[node.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4) continue;
        const geo = prim.$geo,
          p = floats(geo.attributes.POSITION),
          n = p.length / 3,
          idx = geo.indices ? geo.indices.values : Uint32Array.from({ length: n }, (_, i) => i);
        const nrm = geo.attributes.NORMAL ? floats(geo.attributes.NORMAL) : null;
        const adj = adjugate(m);
        const normalAt = (i) => {
          if (!nrm) return [0, 0, 0];
          const x = nrm[i * 3],
            y = nrm[i * 3 + 1],
            z = nrm[i * 3 + 2];
          const v = [
            adj[0] * x + adj[1] * y + adj[2] * z,
            adj[3] * x + adj[4] * y + adj[5] * z,
            adj[6] * x + adj[7] * y + adj[8] * z,
          ];
          const len = Math.hypot(...v) || 1;
          return v.map((c) => c / len);
        };
        const at = (i) => [
          m[0] * p[i * 3] + m[4] * p[i * 3 + 1] + m[8] * p[i * 3 + 2] + m[12],
          m[1] * p[i * 3] + m[5] * p[i * 3 + 1] + m[9] * p[i * 3 + 2] + m[13],
          m[2] * p[i * 3] + m[6] * p[i * 3 + 1] + m[10] * p[i * 3 + 2] + m[14],
        ];
        // A transform that mirrors (negative determinant) reverses the winding glTF draws.
        const mirrored =
          m[0] * (m[5] * m[10] - m[9] * m[6]) -
            m[4] * (m[1] * m[10] - m[9] * m[2]) +
            m[8] * (m[1] * m[6] - m[5] * m[2]) <
          0;
        for (let t = 0; t < idx.length; t += 3) {
          // Triangles that repeat a vertex have no area; the optimiser removes them.
          if (idx[t] === idx[t + 1] || idx[t + 1] === idx[t + 2] || idx[t] === idx[t + 2]) continue;
          out.push(
            Float64Array.from(
              mirrored
                ? [
                    ...at(idx[t]),
                    ...at(idx[t + 2]),
                    ...at(idx[t + 1]),
                    ...normalAt(idx[t]),
                    ...normalAt(idx[t + 2]),
                    ...normalAt(idx[t + 1]),
                  ]
                : [
                    ...at(idx[t]),
                    ...at(idx[t + 1]),
                    ...at(idx[t + 2]),
                    ...normalAt(idx[t]),
                    ...normalAt(idx[t + 1]),
                    ...normalAt(idx[t + 2]),
                  ],
            ),
          );
        }
      }
    for (const c of node.children ?? []) draw(json.nodes[c], m);
  };
  const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const scene = json.scenes?.[json.scene ?? 0];
  for (const root of scene?.nodes ?? []) draw(json.nodes[root], identity);
  return out;
}

/** Bounds [minx, miny, minz, maxx, maxy, maxz] of triangle lists. */
export function boundsOf(triangles) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const t of triangles)
    for (let i = 0; i < 9; i++) {
      b[i % 3] = Math.min(b[i % 3], t[i]);
      b[3 + (i % 3)] = Math.max(b[3 + (i % 3)], t[i]);
    }
  return b;
}

/**
 * Matches every triangle of `a` to a distinct triangle of `b` (same winding, vertices within `tolerance`).
 * Returns the largest position and normal deviations found, or throws a description of the first triangle with no match.
 */
export function matchTriangles(a, b, tolerance) {
  if (a.length !== b.length) throw new Error(`triangle counts differ: ${a.length} vs ${b.length}`);
  const cell = Math.max(tolerance * 16, 1e-9);
  const key = (t) => [0, 1, 2].map((k) => Math.floor((t[k] + t[3 + k] + t[6 + k]) / 3 / cell));
  const grid = new Map();
  b.forEach((t, i) => {
    const k = key(t).join();
    (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
  });
  const used = new Uint8Array(b.length);
  let worst = 0;
  let worstNormal = 0;
  for (const t of a) {
    const [cx, cy, cz] = key(t);
    let best = null,
      bestDev = Infinity,
      bestRotation = 0;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (used[i]) continue;
            for (let r = 0; r < 3; r++) {
              let dev = 0;
              for (let v = 0; v < 3; v++)
                for (let k = 0; k < 3; k++) dev = Math.max(dev, Math.abs(t[v * 3 + k] - b[i][((v + r) % 3) * 3 + k]));
              if (dev < bestDev) {
                bestDev = dev;
                best = i;
                bestRotation = r;
              }
            }
          }
    if (best === null || bestDev > tolerance)
      throw new Error(
        `no output triangle within ${tolerance} of [${[...t].map((v) => v.toFixed(5)).join(', ')}] (closest ${bestDev})`,
      );
    used[best] = 1;
    worst = Math.max(worst, bestDev);
    for (let v = 0; v < 3; v++)
      for (let k = 0; k < 3; k++)
        worstNormal = Math.max(worstNormal, Math.abs(t[9 + v * 3 + k] - b[best][9 + ((v + bestRotation) % 3) * 3 + k]));
  }
  return { worst, worstNormal };
}
