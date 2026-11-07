// Plain glTF maths with no engine code: world bounds at the file's node transforms, skins applied by the spec's formula.
import { readFileSync } from 'node:fs';
const mul = (a, b) => { const o = new Float64Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
const trs = (n) => { if (n.matrix) return Float64Array.from(n.matrix); const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0], [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return Float64Array.from([(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0, 2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1]); };
for (const p of process.argv.slice(2)) {
  const b = readFileSync(p), jl = b.readUInt32LE(12), g = JSON.parse(b.subarray(20, 20 + jl)), bin = b.subarray(28 + jl);
  const acc = (i) => { const a = g.accessors[i], v = g.bufferViews[a.bufferView], n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type], T = { 5126: [4, 'readFloatLE'], 5125: [4, 'readUInt32LE'], 5123: [2, 'readUInt16LE'], 5121: [1, 'readUInt8'] }[a.componentType], st = v.byteStride ?? T[0] * n, off = (v.byteOffset ?? 0) + (a.byteOffset ?? 0), out = new Float64Array(a.count * n);
    for (let i2 = 0; i2 < a.count; i2++) for (let c = 0; c < n; c++) { let x = bin[T[1]](off + i2 * st + c * T[0]); if (a.normalized) x /= a.componentType === 5121 ? 255 : 65535; out[i2 * n + c] = x; } return out; };
  const world = new Map(); const walk = (i, parent) => { const m = mul(parent, trs(g.nodes[i])); world.set(i, m); for (const c of g.nodes[i].children ?? []) walk(c, m); };
  const I = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const r of g.scenes[g.scene ?? 0].nodes) walk(r, I);
  const lo = [1e30, 1e30, 1e30], hi = [-1e30, -1e30, -1e30]; let tris = 0;
  const grow = (x, y, z) => { [x, y, z].forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); }); };
  for (const [i, m] of world) { const n = g.nodes[i]; if (n.mesh === undefined) continue;
    for (const pr of g.meshes[n.mesh].primitives) { const P = acc(pr.attributes.POSITION); tris += (pr.indices !== undefined ? g.accessors[pr.indices].count : P.length / 3) / 3;
      if (n.skin !== undefined) { const s = g.skins[n.skin], ibm = acc(s.inverseBindMatrices), J = acc(pr.attributes.JOINTS_0), W = acc(pr.attributes.WEIGHTS_0), mats = s.joints.map((j, k) => mul(world.get(j), ibm.subarray(k * 16, k * 16 + 16)));
        for (let v = 0; v < P.length / 3; v++) { let sum = 0, x = 0, y = 0, z = 0; for (let k = 0; k < 4; k++) { const w = W[v * 4 + k]; if (!w) continue; sum += w; const M = mats[J[v * 4 + k]], a = P[v * 3], c = P[v * 3 + 1], e = P[v * 3 + 2]; x += w * (M[0] * a + M[4] * c + M[8] * e + M[12]); y += w * (M[1] * a + M[5] * c + M[9] * e + M[13]); z += w * (M[2] * a + M[6] * c + M[10] * e + M[14]); } grow(x / sum, y / sum, z / sum); } }
      else for (let v = 0; v < P.length / 3; v++) { const a = P[v * 3], c = P[v * 3 + 1], e = P[v * 3 + 2]; grow(m[0] * a + m[4] * c + m[8] * e + m[12], m[1] * a + m[5] * c + m[9] * e + m[13], m[2] * a + m[6] * c + m[10] * e + m[14]); } } }
  console.log(p.split('/').pop(), 'tris', tris, 'min', lo.map((v) => +v.toFixed(4)).join(' '), 'max', hi.map((v) => +v.toFixed(4)).join(' '), 'size', hi.map((v, i) => +(v - lo[i]).toFixed(3)).join(' x '));
}
