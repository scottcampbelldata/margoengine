// Node benchmark: build time and rays per second on ~1M triangle meshes, BVH versus a brute-force scan.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { MeshBVH } from '../dist/index.js';
import { rayTriangle } from '../dist/math.js';
import { bumpySphere, rng } from '../tests/reference.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const random = rng(42);

function terrain(size) {
  const positions = new Float32Array(size * size * 3),
    indices = new Uint32Array((size - 1) * (size - 1) * 6);
  for (let z = 0, i = 0; z < size; z++)
    for (let x = 0; x < size; x++, i += 3) {
      const u = (x / (size - 1)) * 2 - 1,
        v = (z / (size - 1)) * 2 - 1;
      positions[i] = u;
      positions[i + 1] = 0.1 * Math.sin(u * 13) * Math.cos(v * 11) + 0.03 * Math.sin(u * 57 + v * 41);
      positions[i + 2] = v;
    }
  for (let z = 0, k = 0; z < size - 1; z++)
    for (let x = 0; x < size - 1; x++) {
      const a = z * size + x;
      indices.set([a, a + size, a + 1, a + 1, a + size, a + size + 1], k);
      k += 6;
    }
  return { positions, indices };
}

function brute(mesh, ray) {
  const P = mesh.positions,
    I = mesh.indices,
    o = ray.origin,
    d = ray.direction,
    out = new Float64Array(4);
  let best = Infinity,
    face = -1;
  for (let f = 0, n = I.length / 3; f < n; f++) {
    const a = I[f * 3] * 3,
      b = I[f * 3 + 1] * 3,
      c = I[f * 3 + 2] * 3;
    if (
      rayTriangle(
        o[0],
        o[1],
        o[2],
        d[0],
        d[1],
        d[2],
        P[a],
        P[a + 1],
        P[a + 2],
        P[b],
        P[b + 1],
        P[b + 2],
        P[c],
        P[c + 1],
        P[c + 2],
        0,
        0,
        best,
        out,
      ) &&
      out[0] < best
    ) {
      best = out[0];
      face = f;
    }
  }
  return face < 0 ? null : { faceIndex: face, distance: best };
}

const rays = (count) =>
  Array.from({ length: count }, () => {
    const origin = [(random() * 2 - 1) * 2, 1 + random(), (random() * 2 - 1) * 2],
      target = [(random() * 2 - 1) * 0.9, 0, (random() * 2 - 1) * 0.9];
    const direction = target.map((v, a) => v - origin[a]),
      l = Math.hypot(...direction);
    return { origin, direction: direction.map((v) => v / l) };
  });

const time = (run) => {
  const start = performance.now();
  const value = run();
  return [performance.now() - start, value];
};
const report = { node: process.version, meshes: [] };
for (const [name, mesh] of [
  ['terrain 708x708', terrain(708)],
  ['bumpy sphere', bumpySphere(random, 1000, 500, 0.05)],
]) {
  const triangles = mesh.indices.length / 3;
  MeshBVH.build({
    positions: mesh.positions.subarray(0, 3000),
    indices: mesh.indices.subarray(0, 300).map((i) => i % 1000),
  }); // warm up
  const builds = [];
  let bvh;
  for (let i = 0; i < 3; i++) {
    const [ms, value] = time(() => MeshBVH.build(mesh));
    builds.push(ms);
    bvh = value;
  }
  const [centerMs] = time(() => MeshBVH.build(mesh, { strategy: 'center' }));
  const [refitMs] = time(() => bvh.refit());
  const queries = name.startsWith('terrain')
    ? rays(200000)
    : Array.from({ length: 200000 }, () => {
        const origin = [(random() * 2 - 1) * 3, (random() * 2 - 1) * 3, (random() * 2 - 1) * 3],
          target = [random() - 0.5, random() - 0.5, random() - 0.5];
        return { origin, direction: target.map((v, a) => v - origin[a]) };
      });
  for (let i = 0; i < 2000; i++) bvh.raycastFirst(queries[i]); // JIT warm up
  let hits = 0;
  const [firstMs] = time(() => {
    for (const ray of queries) if (bvh.raycastFirst(ray)) hits++;
  });
  let _allHits = 0;
  const [allMs] = time(() => {
    for (let i = 0; i < 50000; i++) _allHits += bvh.raycast(queries[i]).length;
  });
  const [closestMs] = time(() => {
    for (let i = 0; i < 50000; i++) bvh.closestPointToPoint(queries[i].origin);
  });
  const bruteRays = 40;
  brute(mesh, queries[0]);
  let agree = 0;
  const [bruteMs] = time(() => {
    for (let i = 0; i < bruteRays; i++) {
      const a = brute(mesh, queries[i]),
        b = bvh.raycastFirst(queries[i]);
      const length = Math.hypot(...queries[i].direction);
      if ((!a && !b) || (a && b && Math.abs(a.distance * length - b.distance) <= 1e-9 * Math.max(1, b.distance)))
        agree++;
    }
  });
  const entry = {
    mesh: name,
    triangles,
    nodes: bvh.nodeCount,
    bvhBytes: bvh.nodes.byteLength + bvh.index.byteLength + bvh.triangles.byteLength,
    buildMs: Math.min(...builds),
    buildCenterMs: centerMs,
    refitMs,
    raycastFirstPerSecond: Math.round((queries.length / firstMs) * 1000),
    hitRate: hits / queries.length,
    raycastAllPerSecond: Math.round((50000 / allMs) * 1000),
    closestPointPerSecond: Math.round((50000 / closestMs) * 1000),
    bruteForceRaysPerSecond: +((bruteRays / bruteMs) * 1000).toFixed(2),
    speedup: Math.round(queries.length / firstMs / (bruteRays / bruteMs)),
    bruteAgreement: `${agree}/${bruteRays}`,
  };
  report.meshes.push(entry);
  console.log(entry);
}
await mkdir(resolve(root, 'test-results'), { recursive: true });
await writeFile(resolve(root, 'test-results/bench.json'), JSON.stringify(report, null, 2));
