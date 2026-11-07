// Independent measure of what each clip really does: plain glTF maths on the GLB, no exporter code. Metres, as glTF says.
import { readFileSync, writeFileSync } from 'node:fs';
const assets = process.argv[2] ?? 'examples/assets/';
const only = process.argv[3];
const models = [
  ['RobotExpressive', 'robot-expressive.glb'],
  ['Fox', 'khronos/Fox/Fox.glb'],
  ['RiggedFigure', 'khronos/RiggedFigure/RiggedFigure.glb'],
  ['InterpolationTest', 'khronos/InterpolationTest/InterpolationTest.glb'],
  ['CommercialRefrigerator', 'khronos/CommercialRefrigerator/CommercialRefrigerator.glb'],
  ['MorphStressTest', 'khronos/MorphStressTest/MorphStressTest.glb'],
  ['KayKitCharacter', 'kaykit/character-animations.glb'],
  ['KayKitRigMedium', 'kaykit/adventurers/animations/Rig_Medium/Rig_Medium_General.glb'],
].filter(([m]) => !only || m === only);
const plain = (n) => n.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const CT = { 5120: [1, 127, 'getInt8'], 5121: [1, 255, 'getUint8'], 5122: [2, 32767, 'getInt16'], 5123: [2, 65535, 'getUint16'], 5125: [4, 0, 'getUint32'], 5126: [4, 0, 'getFloat32'] };
function open(path) {
  const b = readFileSync(path), jl = b.readUInt32LE(12);
  return { json: JSON.parse(b.subarray(20, 20 + jl).toString()), bin: b.subarray(20 + jl + 8) };
}
function acc({ json, bin }, i, normal = false) {
  const a = json.accessors[i], n = SIZE[a.type], [w, max, get] = CT[a.componentType], out = new Float64Array(a.count * n);
  if (a.sparse) throw new Error('sparse accessor');
  if (a.bufferView === undefined) return out;
  const v = json.bufferViews[a.bufferView], stride = v.byteStride || n * w, base = (v.byteOffset || 0) + (a.byteOffset || 0);
  const dv = new DataView(bin.buffer, bin.byteOffset);
  for (let e = 0; e < a.count; e++)
    for (let k = 0; k < n; k++) {
      let x = dv[get](base + e * stride + k * w, true);
      if (normal && max) x = Math.max(x / max, -1);
      out[e * n + k] = x;
    }
  return out;
}
const mul = (a, b) => {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
};
const trs = (t, [x, y, z, w], s) =>
  Float64Array.from([
    s[0] * (1 - 2 * (y * y + z * z)), s[0] * 2 * (x * y + z * w), s[0] * 2 * (x * z - y * w), 0,
    s[1] * 2 * (x * y - z * w), s[1] * (1 - 2 * (x * x + z * z)), s[1] * 2 * (y * z + x * w), 0,
    s[2] * 2 * (x * z + y * w), s[2] * 2 * (y * z - x * w), s[2] * (1 - 2 * (x * x + y * y)), 0,
    t[0], t[1], t[2], 1,
  ]);
const slerp = (a, b, u) => {
  let d = 0;
  for (let i = 0; i < 4; i++) d += a[i] * b[i];
  const sg = d < 0 ? -1 : 1;
  d = Math.abs(d);
  let k0 = 1 - u, k1 = u;
  if (d < 0.9995) {
    const th = Math.acos(d);
    k0 = Math.sin((1 - u) * th) / Math.sin(th);
    k1 = Math.sin(u * th) / Math.sin(th);
  }
  const o = [0, 1, 2, 3].map((i) => k0 * a[i] + sg * k1 * b[i]), l = Math.hypot(...o) || 1;
  return o.map((v) => v / l);
};
function sample({ times, values, w, mode, rot }, t) {
  const n = times.length, cubic = mode === 'CUBICSPLINE';
  const at = (i, off = 0) => {
    const e = cubic ? i * 3 + 1 + off : i;
    return Array.from(values.subarray(e * w, (e + 1) * w));
  };
  if (t <= times[0]) return at(0);
  if (t >= times[n - 1]) return at(n - 1);
  let i = 0;
  while (times[i + 1] < t) i++;
  const dt = times[i + 1] - times[i], u = (t - times[i]) / dt;
  if (mode === 'STEP') return at(i);
  if (cubic) {
    const p0 = at(i), p1 = at(i + 1), m0 = at(i, 1).map((v) => v * dt), m1 = at(i + 1, -1).map((v) => v * dt), u2 = u * u, u3 = u2 * u;
    const o = p0.map((_, k) => (2 * u3 - 3 * u2 + 1) * p0[k] + (u3 - 2 * u2 + u) * m0[k] + (-2 * u3 + 3 * u2) * p1[k] + (u3 - u2) * m1[k]);
    if (!rot) return o;
    const l = Math.hypot(...o) || 1;
    return o.map((v) => v / l);
  }
  if (rot) return slerp(at(i), at(i + 1), u);
  const a = at(i), b = at(i + 1);
  return a.map((v, k) => v + (b[k] - v) * u);
}
const box = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
const grow = (b, x, y, z) => {
  if (x < b.min[0]) b.min[0] = x;
  if (x > b.max[0]) b.max[0] = x;
  if (y < b.min[1]) b.min[1] = y;
  if (y > b.max[1]) b.max[1] = y;
  if (z < b.min[2]) b.min[2] = z;
  if (z > b.max[2]) b.max[2] = z;
};
const merge = (b, o) => {
  grow(b, ...o.min);
  grow(b, ...o.max);
};
const r4 = (v) => v.map((x) => +x.toFixed(4));
const rows = [];
for (const [model, path] of models) {
  const g = open(assets + path), { json } = g, nodes = json.nodes, scene = json.scenes[json.scene ?? 0];
  const parent = new Map();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
  const base = nodes.map((n) => (n.matrix ? { m: Float64Array.from(n.matrix) } : { t: n.translation ?? [0, 0, 0], r: n.rotation ?? [0, 0, 0, 1], s: n.scale ?? [1, 1, 1] }));
  const inScene = new Set();
  const walk = (i) => {
    inScene.add(i);
    (nodes[i].children ?? []).forEach(walk);
  };
  scene.nodes.forEach(walk);
  const prims = [];
  for (const i of inScene) {
    const n = nodes[i];
    if (n.mesh === undefined) continue;
    for (const p of json.meshes[n.mesh].primitives) {
      if ((p.mode ?? 4) !== 4) continue;
      const q = { node: i, pos: acc(g, p.attributes.POSITION), skin: n.skin };
      if (n.skin !== undefined && p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined) {
        q.j = acc(g, p.attributes.JOINTS_0);
        q.w = acc(g, p.attributes.WEIGHTS_0, true);
        // robot-expressive's hand weights sum to as much as 1.7; glTF requires 1 and UsdSkel normalizes, as the exporter does.
        for (let v = 0; v < q.w.length; v += 4) { const t = q.w[v] + q.w[v + 1] + q.w[v + 2] + q.w[v + 3] || 1; for (let k = 0; k < 4; k++) q.w[v + k] /= t; }
      }
      prims.push(q);
    }
  }
  const skins = (json.skins ?? []).map((s) => ({ joints: s.joints, ibm: s.inverseBindMatrices === undefined ? null : acc(g, s.inverseBindMatrices) }));
  const posed = (chans, t) => {
    const locals = base.map((b, i) => {
      if (b.m) return b.m;
      const c = chans.get(i);
      if (!c) return trs(b.t, b.r, b.s);
      const tt = c.translation ? sample(c.translation, t) : b.t, rr = c.rotation ? sample(c.rotation, t) : b.r, ss = c.scale ? sample(c.scale, t) : b.s, l = Math.hypot(...rr) || 1;
      return trs(tt, rr.map((v) => v / l), ss);
    });
    const worlds = new Array(nodes.length);
    const w = (i) => {
      if (worlds[i]) return worlds[i];
      const p = parent.get(i);
      return (worlds[i] = p === undefined ? locals[i] : mul(w(p), locals[i]));
    };
    nodes.forEach((_, i) => w(i));
    const out = box(), skinM = skins.map((s) => s.joints.map((j, k) => (s.ibm ? mul(worlds[j], s.ibm.subarray(k * 16, k * 16 + 16)) : worlds[j])));
    for (const p of prims) {
      const P = p.pos;
      if (p.j) {
        const M = skinM[p.skin], m = new Float64Array(12);
        for (let v = 0; v < P.length / 3; v++) {
          m.fill(0);
          for (let k = 0; k < 4; k++) {
            const wt = p.w[v * 4 + k];
            if (!wt) continue;
            const J = M[p.j[v * 4 + k]];
            for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) m[c * 3 + r] += wt * J[c * 4 + r];
          }
          const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
          grow(out, m[0] * x + m[3] * y + m[6] * z + m[9], m[1] * x + m[4] * y + m[7] * z + m[10], m[2] * x + m[5] * y + m[8] * z + m[11]);
        }
      } else {
        const W = worlds[p.node];
        for (let v = 0; v < P.length; v += 3) {
          const x = P[v], y = P[v + 1], z = P[v + 2];
          grow(out, W[0] * x + W[4] * y + W[8] * z + W[12], W[1] * x + W[5] * y + W[9] * z + W[13], W[2] * x + W[6] * y + W[10] * z + W[14]);
        }
      }
    }
    return out;
  };
  const rest = posed(new Map(), 0), raw = box();
  for (const p of prims) if (p.j) for (let v = 0; v < p.pos.length; v += 3) grow(raw, p.pos[v], p.pos[v + 1], p.pos[v + 2]);
  const rootInfo = scene.nodes.map((i) => ({ name: nodes[i].name, scale: nodes[i].scale, rotation: nodes[i].rotation, matrix: nodes[i].matrix ? 1 : 0 }));
  console.error(model, 'roots', JSON.stringify(rootInfo).slice(0, 300), 'rest', JSON.stringify(rest), 'plain prims', prims.filter((p) => !p.j).length, 'skinned', prims.filter((p) => p.j).length);
  for (const [index, a] of (json.animations ?? []).entries()) {
    const chans = new Map();
    let dur = 0;
    for (const c of a.channels) {
      const tn = c.target.node, s = a.samplers[c.sampler], times = acc(g, s.input);
      if (tn === undefined || c.target.path === 'weights') continue;
      if (!chans.has(tn)) chans.set(tn, {});
      chans.get(tn)[c.target.path] = { times, values: acc(g, s.output, true), w: c.target.path === 'rotation' ? 4 : 3, mode: s.interpolation ?? 'LINEAR', rot: c.target.path === 'rotation' };
      dur = Math.max(dur, times[times.length - 1]);
    }
    const frames = Math.ceil(dur * 30 - 1e-9) + 1, all = box(), f0 = posed(chans, 0), c0 = f0.min.map((v, k) => (v + f0.max[k]) / 2);
    let travel = 0, floorLo = Infinity, floorHi = -Infinity;
    for (let f = 0; f < frames; f++) {
      const b = posed(chans, f / 30);
      merge(all, b);
      floorLo = Math.min(floorLo, b.min[1]);
      floorHi = Math.max(floorHi, b.min[1]);
      const c = b.min.map((v, k) => (v + b.max[k]) / 2);
      travel = Math.max(travel, Math.hypot(c[0] - c0[0], c[2] - c0[2]));
    }
    const file = `${model}-${plain(a.name || 'Animation') || `Clip${index}`}`, size = all.max.map((v, k) => v - all.min[k]), s0 = f0.max.map((v, k) => v - f0.min[k]);
    rows.push({ file, model, index, frames, rest: { min: r4(rest.min), max: r4(rest.max) }, rawSkin: raw.min[0] === Infinity ? null : { min: r4(raw.min), max: r4(raw.max) }, frame0: { min: r4(f0.min), max: r4(f0.max), size: r4(s0) }, clip: { min: r4(all.min), max: r4(all.max), size: r4(size) }, floor: r4([floorLo, floorHi]), travel: +travel.toFixed(4) });
  }
}
if (process.argv[4]) writeFileSync(process.argv[4], JSON.stringify(rows));
for (const r of rows)
  console.log([r.file.padEnd(46), String(r.frames).padStart(4), 'size', r.clip.size.map((v) => v.toFixed(2)).join(' x '), '| y', r.clip.min[1].toFixed(2), r.clip.max[1].toFixed(2), '| f0', r.frame0.size.map((v) => v.toFixed(2)).join('x'), '| floor', r.floor.join('..'), '| trav', r.travel].join(' '));
