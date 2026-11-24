// Own convex decomposition (`@margoengine/physics/decomposition`) against Rapier 0.21's V-HACD as a black box, through
// Rapier's npm API only: parts, build time, the paper's score (Wei et al. 2022, Eq. 10, by `decompositionConcavity`
// for both) and how much volume the hulls add. Build first: `npm run build --workspace @margoengine/physics`, then
// `node packages/physics/scripts/decomposition-vs-rapier.mjs`. Defaults on both sides; times are one run each. With
// `--greedy` the own side runs the paper's one-step greedy baseline (Table 2): depth 1 and one iteration per candidate,
// every plane tried once, the search V-HACD makes.
import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { convexDecomposition, decompositionConcavity } from '../dist/decomposition.js';
import { convexHull } from '../dist/next.js';

await RAPIER.init();
const options = process.argv.includes('--greedy') ? { depth: 1, iterations: 60, timeLimit: 600000 } : {};

function boxes(list) {
  const vertices = [],
    indices = [];
  for (const [x0, y0, z0, x1, y1, z1] of list) {
    const base = vertices.length / 3;
    for (let i = 0; i < 8; i++) vertices.push(i & 4 ? x1 : x0, i & 2 ? y1 : y0, i & 1 ? z1 : z0);
    for (const [a, b, c, d] of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]])
      indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
  }
  return { vertices, indices };
}

/** A closed surface with shared corners around filled unit cells, scaled by `scale`. */
function cells(filled, scale = 1) {
  const key = (c) => c.join(','),
    set = new Set(filled.map(key)),
    ids = new Map(),
    vertices = [],
    indices = [];
  const vertex = (p) => {
    if (!ids.has(key(p))) ids.set(key(p), vertices.push(...p.map((v) => v * scale)) / 3 - 1);
    return ids.get(key(p));
  };
  for (const cell of filled)
    for (let a = 0; a < 3; a++)
      for (const s of [1, -1]) {
        const n = [...cell];
        n[a] += s;
        if (set.has(key(n))) continue;
        const u = (a + 1) % 3,
          w = (a + 2) % 3,
          base = [...cell];
        if (s > 0) base[a] += 1;
        const q = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([du, dw]) => {
          const p = [...base];
          p[u] += du;
          p[w] += dw;
          return vertex(p);
        });
        if (s > 0) indices.push(q[0], q[1], q[2], q[0], q[2], q[3]);
        else indices.push(q[0], q[2], q[1], q[0], q[3], q[2]);
      }
  return { vertices, indices };
}

function torus(nu = 48, nv = 24) {
  const vertices = [],
    indices = [];
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const u = (2 * Math.PI * i) / nu,
        w = (2 * Math.PI * j) / nv;
      vertices.push((1 + 0.35 * Math.cos(w)) * Math.cos(u), 0.35 * Math.sin(w), (1 + 0.35 * Math.cos(w)) * Math.sin(u));
    }
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const a = i * nv + j,
        b = ((i + 1) % nu) * nv + j,
        c = ((i + 1) % nu) * nv + ((j + 1) % nv),
        d = i * nv + ((j + 1) % nv);
      indices.push(a, d, c, a, c, b);
    }
  return { vertices, indices };
}

function knight() {
  const words = readFileSync(new URL('../../loaders/tests/fixtures/decimated-knight.off', import.meta.url), 'utf8').split(/\s+/).filter(Boolean);
  const count = +words[1],
    vertices = words.slice(4, 4 + count * 3).map(Number),
    indices = [];
  for (let f = 0, i = 4 + count * 3; f < +words[2]; f++, i += 4) indices.push(+words[i + 1], +words[i + 2], +words[i + 3]);
  return { vertices, indices };
}

const ring = (n, h, scale) => {
  const filled = [];
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++)
      for (let j = 0; j < h; j++) if (i === 0 || i === n - 1 || k === 0 || k === n - 1 || (scale && j === 0)) filled.push([i, j, k]);
  return cells(filled, scale || 1);
};
const meshes = {
  'tube (paper Fig. 9)': ring(4, 4, 0),
  'cup, five slabs': boxes([[-1, 0, -1, 1, 0.1, 1], [-1, 0, -1, -0.9, 1, 1], [0.9, 0, -1, 1, 1, 1], [-1, 0, -1, 1, 1, -0.9], [-1, 0, 0.9, 1, 1, 1]]),
  'cup, one closed surface': ring(10, 10, 0.2),
  torus: torus(),
  'libigl knight': knight(),
};

function volume(v, t) {
  let six = 0;
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
    six += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) + v[a + 1] * (v[b + 2] * v[c] - v[b] * v[c + 2]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return Math.abs(six / 6);
}

function hullVolume(points) {
  const { vertices, faces } = convexHull(points),
    o = vertices[0];
  let six = 0;
  for (const f of faces)
    for (let i = 1; i + 1 < f.length; i++) {
      const [a, b, c] = [vertices[f[0]], vertices[f[i]], vertices[f[i + 1]]].map((p) => p.map((x, k) => x - o[k]));
      six += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
  return six / 6;
}

console.log('| Mesh | Rapier parts | Own parts | Rapier ms | Own ms | Rapier Eq. 10 | Own Eq. 10 | Rapier hulls / mesh | Own hulls / mesh |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const [name, mesh] of Object.entries(meshes)) {
  const v = new Float32Array(mesh.vertices),
    t = new Uint32Array(mesh.indices),
    world = new RAPIER.World({ x: 0, y: 0, z: 0 }),
    body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  let start = performance.now();
  const desc = RAPIER.ColliderDesc.convexDecomposition(v, t),
    rapierMs = performance.now() - start,
    compound = world.createCollider(desc, body).shape,
    rapier = compound.shapes.map((shape) => ({ points: shape.vertices }));
  start = performance.now();
  const own = convexDecomposition(mesh, options).parts,
    ownMs = performance.now() - start,
    whole = volume(v, t),
    share = (parts) => (parts.reduce((sum, part) => sum + hullVolume(part.points), 0) / whole).toFixed(3);
  console.log(
    `| ${name} | ${rapier.length} | ${own.length} | ${rapierMs.toFixed(0)} | ${ownMs.toFixed(0)} | ${decompositionConcavity(mesh, rapier).toFixed(4)} | ${decompositionConcavity(mesh, own).toFixed(4)} | ${share(rapier)} | ${share(own)} |`,
  );
  world.free();
}
