import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Camera, Geometry, box} from '@margoengine/core';
import {MeshBVH, Raycaster, buildAsync, buildBVH, frustumPlanes, multiplyMatrices, invertMatrix, getGeometryBVH, setGeometryBVH, setMeshLayers, CONTAINED, INTERSECTED, NOT_INTERSECTED} from '../dist/index.js';
import {closestPointTriangle, transformPoint} from '../dist/math.js';
import {bruteBox, bruteClosest, bruteFrustum, bruteMeshMesh, bruteRay, bruteSphere, bumpySphere, parseObj, randomMatrix, randomRay, rng, soup} from './reference.js';

const fixture = name => parseObj(readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), 'utf8'));
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const sorted = values => [...values].sort((a, b) => a - b);
const random = rng(1234);
const meshes = {
  soup: soup(random, 3000),
  sphere: bumpySphere(random, 48, 32),
  suzanne: fixture('suzanne.obj'),
  cow: fixture('cow.obj'),
};
// Scale real-world fixtures into the random-ray volume.
for (const name of ['suzanne', 'cow']) {
  const p = meshes[name].positions, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {min[i % 3] = Math.min(min[i % 3], p[i]); max[i % 3] = Math.max(max[i % 3], p[i]);}
  const scale = 2 / Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  for (let i = 0; i < p.length; i++) p[i] = (p[i] - (min[i % 3] + max[i % 3]) / 2) * scale;
}

function checkStructure(bvh, {maxLeafTriangles = 8, maxDepth = 40} = {}) {
  const f = bvh.nodeBounds, u = bvh.nodeData, seen = new Uint8Array(bvh.triangleCount), P = bvh.positions, s = bvh.stride;
  let maxSeen = 0;
  const walk = (node, depth) => {
    maxSeen = Math.max(maxSeen, depth);
    const w = node * 8;
    if (bvh.isLeaf(node)) {
      const start = u[w + 6], count = u[w + 7];
      assert.ok(count >= 1 && (count <= maxLeafTriangles || depth >= maxDepth || count === bvh.triangleCount), `leaf ${node} has ${count} triangles at depth ${depth}`);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let k = start; k < start + count; k++) {
        assert.equal(seen[k], 0); seen[k] = 1;
        for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) {const x = P[bvh.index[k * 3 + v] * s + a]; min[a] = Math.min(min[a], x); max[a] = Math.max(max[a], x);}
      }
      assert.deepEqual([...f.subarray(w, w + 6)].map(v => v + 0), [...min, ...max].map(v => Math.fround(v) + 0), `leaf ${node} bounds are tight`);
      return [min, max];
    }
    const left = walk(node + 1, depth + 1), right = walk(u[w + 6], depth + 1);
    assert.deepEqual([...f.subarray(w, w + 6)].map(v => v + 0), [0, 1, 2].map(a => Math.min(left[0][a], right[0][a])).concat([0, 1, 2].map(a => Math.max(left[1][a], right[1][a]))).map(v => Math.fround(v) + 0), 'internal bounds are the union of the children');
    return [[0, 1, 2].map(a => f[w + a]), [3, 4, 5].map(a => f[w + a])];
  };
  walk(0, 0);
  assert.ok(seen.every(Boolean), 'every triangle is in exactly one leaf');
  assert.ok(maxSeen <= maxDepth);
  return maxSeen;
}

function compareFirst(bvh, mesh, ray, options, label) {
  const hit = bvh.raycastFirst(ray, options), reference = bruteRay(mesh, ray, options)[0] ?? null;
  if (!reference) return assert.equal(hit, null, `${label}: BVH found a hit brute force did not`);
  assert.ok(hit, `${label}: BVH missed face ${reference.faceIndex} at ${reference.distance}`);
  assert.ok(close(hit.distance, reference.distance), `${label}: distance ${hit.distance} vs ${reference.distance}`);
  if (hit.faceIndex !== reference.faceIndex) assert.equal(hit.distance, reference.distance, `${label}: different face at a different distance`);
  // The returned point, barycentric weights and face agree with each other.
  const P = bvh.positions, s = bvh.stride, [a, b, c] = hit.face, w = hit.barycoord;
  for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(P[a * s + axis] * w[0] + P[b * s + axis] * w[1] + P[c * s + axis] * w[2] - hit.point[axis]) < 1e-5);
  return hit;
}

test('build produces a valid, tight, depth-limited tree for every option set', () => {
  for (const [name, mesh] of Object.entries(meshes)) {
    for (const options of [{}, {maxLeafTriangles: 1}, {maxLeafTriangles: 32, bins: 8}, {strategy: 'center'}, {maxDepth: 4, maxLeafTriangles: 2}]) {
      const bvh = MeshBVH.build(mesh, options);
      checkStructure(bvh, {maxLeafTriangles: options.maxLeafTriangles ?? 8, maxDepth: options.maxDepth ?? 40});
      assert.equal(bvh.triangleCount, mesh.indices.length / 3, name);
    }
  }
  // Non-indexed input, interleaved stride and plain arrays.
  const flat = MeshBVH.build({positions: Array.from(meshes.soup.positions)});
  assert.equal(flat.triangleCount, 3000);
  const interleaved = new Float32Array(meshes.sphere.positions.length * 2);
  for (let i = 0; i < interleaved.length / 6; i++) for (let a = 0; a < 3; a++) {interleaved[i * 6 + a] = meshes.sphere.positions[i * 3 + a]; interleaved[i * 6 + 3 + a] = meshes.sphere.normals[i * 3 + a];}
  const strided = MeshBVH.build({positions: interleaved, normals: interleaved.subarray(3), indices: meshes.sphere.indices, stride: 6});
  checkStructure(strided);
  // Degenerate input: every triangle identical must still terminate with bounded leaves.
  const same = MeshBVH.build({positions: new Float32Array(300 * 9).map((_, i) => [0, 0, 0, 1, 0, 0, 0, 1, 0][i % 9])});
  checkStructure(same);
  for (const bad of [{maxLeafTriangles: 0}, {maxDepth: 65}, {bins: 2}, {strategy: 'median'}]) assert.throws(() => MeshBVH.build(meshes.soup, bad));
  assert.throws(() => MeshBVH.build({positions: [0, 0, 0, 1, 0, 0], indices: [0, 1, 2]}), /Index exceeds/);
  assert.throws(() => MeshBVH.build({positions: [0, 0, 0, 1, 0, 0, 0, NaN, 0]}), /finite/);
});

test('raycastFirst matches brute force on random meshes and rays (all sides, near/far)', () => {
  let cases = 0, hits = 0;
  for (const [name, mesh] of Object.entries(meshes)) {
    const bvh = MeshBVH.build(mesh), r = rng(name.length * 77);
    for (let i = 0; i < 700; i++) {
      const ray = randomRay(r), side = ['double', 'front', 'back'][i % 3], options = {side};
      if (i % 7 === 0) {options.near = r() * 1.5; options.far = options.near + r() * 2;}
      if (compareFirst(bvh, mesh, ray, options, `${name} #${i}`)) hits++;
      cases++;
    }
  }
  assert.ok(hits > cases * 0.4, `only ${hits}/${cases} rays hit`);
  console.log(`raycastFirst: ${cases} rays, ${hits} hits`);
});

test('raycast (all hits) returns exactly the brute-force hit set', () => {
  let cases = 0, total = 0;
  for (const [name, mesh] of Object.entries(meshes)) {
    const bvh = MeshBVH.build(mesh, {maxLeafTriangles: 4}), r = rng(name.length * 91);
    for (let i = 0; i < 500; i++) {
      const ray = randomRay(r), side = ['double', 'front', 'back'][i % 3], hits = bvh.raycast(ray, {side}), reference = bruteRay(mesh, ray, {side});
      assert.deepEqual(hits.map(h => h.faceIndex).sort(), reference.map(h => h.faceIndex).sort(), `${name} #${i}`);
      for (let k = 0; k < hits.length; k++) assert.ok(close(hits[k].distance, reference[k].distance));
      for (const hit of hits) assert.equal(hit.frontFace, reference.find(h => h.faceIndex === hit.faceIndex).frontFace);
      cases++; total += hits.length;
    }
  }
  console.log(`raycast all: ${cases} rays, ${total} hits`);
});

test('closestPointToPoint matches brute force, with and without maxDistance', () => {
  let cases = 0;
  for (const [name, mesh] of Object.entries(meshes)) {
    const bvh = MeshBVH.build(mesh), r = rng(name.length * 13);
    for (let i = 0; i < 400; i++) {
      const point = [(r() * 2 - 1) * 1.6, (r() * 2 - 1) * 1.6, (r() * 2 - 1) * 1.6], maxDistance = i % 4 === 0 ? r() * 0.3 : Infinity;
      const result = bvh.closestPointToPoint(point, {maxDistance}), reference = bruteClosest(mesh, point, maxDistance);
      if (!reference) {assert.equal(result, null); continue;}
      assert.ok(result && close(result.distance, reference.distance), `${name} #${i}: ${result?.distance} vs ${reference.distance}`);
      assert.ok(Math.abs(Math.hypot(result.point[0] - point[0], result.point[1] - point[1], result.point[2] - point[2]) - result.distance) < 1e-9);
      if (result.faceIndex !== reference.faceIndex) assert.ok(close(result.distance, reference.distance, 1e-12));
      cases++;
    }
  }
  // minDistance stops early but still returns a point within it.
  const bvh = MeshBVH.build(meshes.sphere), early = bvh.closestPointToPoint([0, 0, 0], {minDistance: 5});
  assert.ok(early && early.distance <= 5);
  console.log(`closestPointToPoint: ${cases} points`);
});

test('intersectsSphere and intersectsBox (oriented) match brute force', () => {
  let spheres = 0, boxes = 0, positives = 0;
  for (const [name, mesh] of Object.entries(meshes)) {
    const bvh = MeshBVH.build(mesh), r = rng(name.length * 5);
    for (let i = 0; i < 400; i++) {
      const center = [(r() * 2 - 1) * 1.4, (r() * 2 - 1) * 1.4, (r() * 2 - 1) * 1.4], radius = r() * 0.3;
      const expected = bruteSphere(mesh, center, radius);
      assert.equal(bvh.intersectsSphere(center, radius), expected, `${name} sphere #${i}`); spheres++; positives += expected;
    }
    for (let i = 0; i < 300; i++) {
      const half = [r() * 0.2, r() * 0.2, r() * 0.2], box = {min: half.map(v => -v), max: half};
      const matrix = i % 5 === 0 ? undefined : randomMatrix(r, {translate: 1.2, mirror: i % 3 === 0, shear: i % 4 === 0});
      const faces = bruteBox(mesh, box, matrix), boxForAabb = matrix ? box : {min: box.min.map((v, a) => v + (r() - 0.5)), max: []};
      if (!matrix) boxForAabb.max = boxForAabb.min.map((v, a) => v + 2 * half[a]);
      const expected = matrix ? faces : bruteBox(mesh, boxForAabb);
      assert.equal(bvh.intersectsBox(boxForAabb, matrix), expected.length > 0, `${name} box #${i}`); boxes++;
    }
  }
  console.log(`intersectsSphere: ${spheres} (${positives} touching), intersectsBox: ${boxes}`);
});

test('intersectsBVH matches brute-force triangle pairs under relative matrices', () => {
  const r = rng(99), a = soup(r, 250, {size: 0.3}), b = bumpySphere(r, 14, 10, 0.3);
  const bvhA = MeshBVH.build(a, {maxLeafTriangles: 4}), bvhB = MeshBVH.build(b, {maxLeafTriangles: 4});
  let positives = 0, pairsChecked = 0;
  for (let i = 0; i < 120; i++) {
    const matrix = randomMatrix(r, {translate: 1.6, mirror: i % 4 === 0, shear: i % 5 === 0});
    const expected = bruteMeshMesh(a, b, matrix), pairs = [];
    assert.equal(bvhA.intersectsBVH(bvhB, matrix), expected.length > 0, `case ${i}`);
    bvhA.intersectsBVH(bvhB, matrix, (fa, fb) => {pairs.push(fa * 1e6 + fb);});
    assert.deepEqual(sorted(pairs), sorted(expected), `pairs ${i}`);
    positives += expected.length > 0; pairsChecked += expected.length;
  }
  assert.ok(positives > 20 && positives < 120, `unbalanced cases: ${positives}`);
  // Early stop from the callback.
  let calls = 0;
  bvhA.intersectsBVH(bvhA, undefined, () => {calls++; return true;});
  assert.equal(calls, 1);
  console.log(`intersectsBVH: 120 cases, ${positives} intersecting, ${pairsChecked} pairs`);
});

test('frustum collection matches brute force for triangles and leaves', () => {
  const r = rng(7);
  let cases = 0;
  for (const [name, mesh] of Object.entries(meshes)) {
    const bvh = MeshBVH.build(mesh);
    for (let i = 0; i < 60; i++) {
      const webgpu = i % 2 === 0, camera = new Camera({fov: 20 + r() * 60, position: [(r() * 2 - 1) * 4, (r() * 2 - 1) * 3, 2 + r() * 3], target: [(r() - 0.5), (r() - 0.5), (r() - 0.5)], near: 0.1 + r(), far: 3 + r() * 4});
      camera.update(0.5 + r() * 1.5, webgpu);
      const world = i % 3 === 0 ? randomMatrix(r, {translate: 0.5}) : new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const planes = frustumPlanes(multiplyMatrices(camera.matrix, world), webgpu);
      assert.deepEqual(sorted(bvh.collectFrustum(planes)), bruteFrustum(mesh, planes), `${name} #${i}`);
      const leaves = sorted(bvh.collectFrustum(planes, {mode: 'leaves'})), expectedLeaves = [];
      for (let node = 0; node < bvh.nodeCount; node++) {
        if (!bvh.isLeaf(node)) continue;
        const f = bvh.nodeBounds, w = node * 8;
        let outside = false;
        for (let p = 0; p < 24; p += 4) {
          const [nx, ny, nz, d] = planes.subarray(p, p + 4);
          if (nx * (nx >= 0 ? f[w + 3] : f[w]) + ny * (ny >= 0 ? f[w + 4] : f[w + 1]) + nz * (nz >= 0 ? f[w + 5] : f[w + 2]) + d < 0) outside = true;
        }
        if (!outside) expectedLeaves.push(node);
      }
      assert.deepEqual(leaves, expectedLeaves);
      cases++;
    }
  }
  // The engine camera's own planes agree with frustumPlanes for an identity world matrix.
  const camera = new Camera({position: [1, 2, 3]}); camera.update(1.5, true);
  const planes = frustumPlanes(camera.matrix, true);
  for (let i = 0; i < 24; i++) assert.ok(Math.abs(planes[i] - camera.planes[i]) < 1e-5 * Math.max(1, Math.abs(planes[i])), `plane value ${i}: ${planes[i]} vs ${camera.planes[i]}`);
  console.log(`collectFrustum: ${cases} frusta`);
});

test('shapecast drives custom queries, honors CONTAINED, traversal order and early exit', () => {
  const bvh = MeshBVH.build(meshes.cow), r = rng(3);
  for (let i = 0; i < 100; i++) {
    const p = [(r() * 2 - 1), (r() * 2 - 1), (r() * 2 - 1)];
    let best = Infinity;
    const dist = box => Math.hypot(...[0, 1, 2].map(a => Math.max(box.min[a] - p[a], 0, p[a] - box.max[a])));
    const out = new Float64Array(6);
    bvh.shapecast({
      boundsTraverseOrder: dist,
      intersectsBounds: (box, isLeaf, score) => (score ?? dist(box)) < best ? INTERSECTED : NOT_INTERSECTED,
      intersectsTriangle: tri => {
        const d = Math.sqrt(closestPointTriangle(p[0], p[1], p[2], ...tri.a, ...tri.b, ...tri.c, out)); if (d < best) best = d;
      },
    });
    assert.ok(close(best, bvh.closestPointToPoint(p).distance), `shapecast closest point #${i}`);
  }
  // Collect faces inside an axis-aligned box: CONTAINED nodes skip further bounds tests.
  const box = {min: [-0.3, -0.2, -0.4], max: [0.4, 0.3, 0.2]};
  const inside = (b) => b.min.every((v, a) => v >= box.min[a]) && b.max.every((v, a) => v <= box.max[a]);
  const overlap = (b) => b.min.every((v, a) => v <= box.max[a]) && b.max.every((v, a) => v >= box.min[a]);
  const faces = [];
  let containedCalls = 0;
  bvh.shapecast({
    intersectsBounds: b => inside(b) ? CONTAINED : overlap(b) ? INTERSECTED : NOT_INTERSECTED,
    intersectsTriangle: (tri, face, contained) => {
      if (contained) containedCalls++;
      const P = [...tri.a, ...tri.b, ...tri.c];
      if (bruteBox({positions: P}, box).length) faces.push(face);
    },
  });
  assert.deepEqual(sorted(faces), bruteBox(meshes.cow, box));
  assert.ok(containedCalls > 0);
  let ranges = 0;
  assert.equal(bvh.shapecast({intersectsBounds: () => true, intersectsRange: () => ++ranges === 3}), true);
  assert.equal(ranges, 3);
  assert.equal(bvh.shapecast({intersectsBounds: () => false}), false);
});

test('serialization round trips, transfers zero-copy and rejects corrupt data', () => {
  const bvh = MeshBVH.build(meshes.sphere), r = rng(17), rays = Array.from({length: 300}, () => randomRay(r));
  const answer = b => rays.map(ray => {const h = b.raycastFirst(ray); return h && [h.faceIndex, h.distance];});
  const expected = answer(bvh);
  const copy = MeshBVH.deserialize(bvh.serialize(), meshes.sphere);
  assert.deepEqual(answer(copy), expected);
  const packed = MeshBVH.fromArrayBuffer(bvh.toArrayBuffer(), meshes.sphere);
  assert.deepEqual(answer(packed), expected);
  assert.deepEqual(new Uint8Array(packed.nodes), new Uint8Array(bvh.nodes));
  // Worker-style transfer: the clone owns the same bytes and the source buffers detach (no copy was made).
  const data = copy.serialize({copy: false});
  const moved = structuredClone(data, {transfer: [data.nodes, data.index.buffer, data.triangles.buffer]});
  assert.equal(data.nodes.byteLength, 0); assert.equal(data.index.length, 0);
  assert.deepEqual(answer(MeshBVH.deserialize(moved, meshes.sphere)), expected);
  // Corruption is caught.
  const broken = bvh.serialize(); new Uint32Array(broken.nodes)[6] = 99999;
  assert.throws(() => MeshBVH.deserialize(broken, meshes.sphere), RangeError);
  const truncated = bvh.toArrayBuffer().slice(0, 100);
  assert.throws(() => MeshBVH.fromArrayBuffer(truncated, meshes.sphere), RangeError);
  assert.throws(() => MeshBVH.deserialize({...bvh.serialize(), version: 2}, meshes.sphere), TypeError);
  assert.throws(() => MeshBVH.deserialize(bvh.serialize(), {positions: new Float32Array(9)}), RangeError);
});

test('refit tracks moved vertices exactly', () => {
  const r = rng(5), mesh = {positions: meshes.sphere.positions.slice(), indices: meshes.sphere.indices};
  const bvh = MeshBVH.build(mesh);
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < mesh.positions.length; i++) mesh.positions[i] += (r() - 0.5) * 0.3 + (i % 3 === 0 ? 0.2 : 0);
    bvh.refit();
    checkStructure(bvh);
    for (let i = 0; i < 300; i++) {
      const ray = randomRay(r), offset = [ray.origin[0] + 0.2 * (round + 1), ray.origin[1], ray.origin[2]];
      compareFirst(bvh, mesh, {origin: offset, direction: ray.direction}, {}, `refit ${round}/${i}`);
    }
  }
});

test('core Geometry input: stride-6 vertices, interpolated normals, cached BVH', () => {
  const s = meshes.sphere, geometry = new Geometry(s.positions, s.normals, s.indices), bvh = MeshBVH.fromGeometry(geometry);
  assert.equal(bvh.stride, 6); assert.equal(bvh.positions, geometry.vertices);
  const r = rng(11);
  for (let i = 0; i < 300; i++) {
    const ray = randomRay(r), hit = compareFirst(bvh, {positions: geometry.vertices, stride: 6, indices: geometry.indices}, ray, {}, `geometry #${i}`);
    if (!hit) continue;
    const [a, b, c] = hit.face, n = [0, 1, 2].map(k => s.normals[a * 3 + k] * hit.barycoord[0] + s.normals[b * 3 + k] * hit.barycoord[1] + s.normals[c * 3 + k] * hit.barycoord[2]), l = Math.hypot(...n);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(hit.normal[k] - n[k] / l) < 1e-6);
    const e = Math.hypot(...hit.faceNormal); assert.ok(Math.abs(e - 1) < 1e-9);
    assert.equal(hit.frontFace, ray.direction[0] * hit.faceNormal[0] + ray.direction[1] * hit.faceNormal[1] + ray.direction[2] * hit.faceNormal[2] < 0);
  }
  assert.equal(getGeometryBVH(geometry), getGeometryBVH(geometry));
  setGeometryBVH(geometry, bvh); assert.equal(getGeometryBVH(geometry), bvh);
  assert.throws(() => setGeometryBVH(geometry, MeshBVH.build(meshes.soup)), TypeError);
  assert.throws(() => MeshBVH.fromGeometry({positions: s.positions}), TypeError);
});

test('buildAsync falls back to a synchronous build without Worker and validates options', async () => {
  assert.equal(typeof Worker, 'undefined');
  const bvh = await buildAsync(meshes.cow, {maxLeafTriangles: 4});
  checkStructure(bvh, {maxLeafTriangles: 4});
  await assert.rejects(buildAsync(meshes.cow, {maxDepth: 0}), RangeError);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(buildAsync(meshes.cow, {signal: controller.signal}));
  // The raw builder output is plain transferable data.
  const data = buildBVH(meshes.cow.positions, 3, meshes.cow.indices);
  assert.ok(data.nodes instanceof ArrayBuffer && data.index instanceof Uint32Array && data.triangles instanceof Uint32Array);
});

test('buildAsync cancellation before the SSR microtask avoids reading or building geometry', async () => {
  assert.equal(typeof Worker, 'undefined');
  const controller = new AbortController(), reason = new Error('cancelled before building');
  let reads = 0;
  const source = {get positions() {reads++; return meshes.cow.positions;}, indices: meshes.cow.indices};
  const pending = buildAsync(source, {signal: controller.signal});
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(reads, 0, 'a cancelled fallback must not normalize or build large geometry');
});

test('importing the package touches no browser globals (SSR safe)', () => {
  const script = `for (const name of ['window','document','navigator','Worker','GPUBufferUsage','requestAnimationFrame']) Object.defineProperty(globalThis, name, {get() {throw new Error('touched ' + name);}, configurable: true});
    const m = await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}); new m.Raycaster(); console.log('ok');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'ok');
});

const determinant = m => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

// A structural stand-in for the engine runtime (store, meshes, camera, canvas) so the Raycaster logic runs in Node.
function mockEngine(capacity = 32) {
  const store = {matrices: new Float32Array(capacity * 16), parents: new Float32Array(capacity).fill(-1), hidden: new Uint8Array(capacity), ticks: 0, tick() {this.ticks++;}};
  const engine = {store, meshes: new Map(), camera: new Camera({position: [0, 0, 6], target: [0, 0, 0]}), canvas: {width: 400, height: 200, clientWidth: 400, clientHeight: 200}, backend: 'webgpu', disposed: false};
  engine.add = (geometry, matrix, {doubleSided = true} = {}) => {
    const id = engine.meshes.size, mesh = {id, geometry, material: {data: new Float32Array([1, 1, 1, 1, 0.5, 0, doubleSided ? 1 : 0, 0])}};
    engine.meshes.set(id, mesh); store.matrices.set(matrix, id * 16); return mesh;
  };
  return engine;
}

test('Raycaster: world-space hits match brute force over transformed meshes, with hidden, layers and filters', () => {
  const r = rng(21), engine = mockEngine(), s = meshes.sphere, geometry = new Geometry(s.positions, s.normals, s.indices);
  const cow = fixture('cow.obj'), cowGeometry = new Geometry(cow.positions.map(v => v * 0.2), new Float32Array(cow.positions.length).fill(0).map((_, i) => i % 3 === 1 ? 1 : 0), cow.indices);
  const transforms = [];
  for (let i = 0; i < 8; i++) {
    const matrix = Float32Array.from(randomMatrix(r, {translate: 2.5, mirror: i % 3 === 1}));
    const mesh = engine.add(i % 2 ? cowGeometry : geometry, matrix, {doubleSided: i % 4 !== 3});
    transforms.push({mesh, matrix, geometry: i % 2 ? cowGeometry : geometry});
  }
  // World-space reference: transform every vertex and brute-force the ray in world space.
  const worldMeshes = transforms.map(({mesh, matrix, geometry: g}) => {
    const positions = new Float64Array(g.vertices.length / 2);
    for (let v = 0; v < positions.length / 3; v++) transformPoint(Float64Array.from(matrix), g.vertices[v * 6], g.vertices[v * 6 + 1], g.vertices[v * 6 + 2], positions, v * 3);
    // A mirrored matrix reverses the world winding; the engine keeps the local front side, which is the world back side.
    const mirrored = determinant(matrix) < 0;
    return {mesh, positions, indices: g.indices, mirrored, side: mesh.material.data[6] ? 'double' : mirrored ? 'back' : 'front'};
  });
  const reference = (origin, direction, skip = () => false) => worldMeshes.filter(w => !skip(w.mesh)).flatMap(w => bruteRay(w, {origin, direction}, {side: w.side}).map(h => ({...h, frontFace: h.frontFace !== w.mirrored, mesh: w.mesh}))).sort((a, b) => a.distance - b.distance);
  const raycaster = new Raycaster();
  let checked = 0, hitCount = 0;
  for (let i = 0; i < 400; i++) {
    const origin = [(r() * 2 - 1) * 5, (r() * 2 - 1) * 5, (r() * 2 - 1) * 5], target = [(r() * 2 - 1) * 2, (r() * 2 - 1) * 2, (r() * 2 - 1) * 2];
    raycaster.set(origin, target.map((v, a) => v - origin[a]));
    const direction = [...raycaster.direction], expected = reference(origin, direction);
    raycaster.firstHitOnly = false;
    const all = raycaster.intersectEngine(engine);
    assert.equal(all.length, expected.length, `ray ${i}: ${all.length} hits vs ${expected.length}`);
    for (let k = 0; k < all.length; k++) {
      assert.ok(Math.abs(all[k].distance - expected[k].distance) < 1e-5, `ray ${i} hit ${k}: ${all[k].distance} vs ${expected[k].distance}`);
      const p = all[k].point;
      assert.ok(Math.abs(Math.hypot(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]) - all[k].distance) < 1e-5);
    }
    if (expected.length) {
      // Unless two meshes tie, the nearest mesh, its winding side and face agree.
      if (expected.length < 2 || expected[1].distance - expected[0].distance > 1e-4) {
        assert.equal(all[0].mesh, expected[0].mesh); assert.equal(all[0].faceIndex, expected[0].faceIndex); assert.equal(all[0].frontFace, expected[0].frontFace);
      }
      // World face normal is perpendicular to the world triangle and consistent with frontFace.
      const facing = direction[0] * all[0].faceNormal[0] + direction[1] * all[0].faceNormal[1] + direction[2] * all[0].faceNormal[2];
      assert.equal(facing < 0, all[0].frontFace);
      raycaster.firstHitOnly = true;
      const first = raycaster.intersectEngine(engine);
      assert.equal(first.length, 1); assert.ok(Math.abs(first[0].distance - all[0].distance) < 1e-9);
      hitCount++;
    }
    checked++;
  }
  assert.ok(hitCount > 100, `only ${hitCount} rays hit`);
  assert.ok(engine.store.ticks > 0, 'refresh runs the transform kernel');

  // Hidden meshes, hidden ancestors, layers and filters.
  const target = transforms[0], c = [target.matrix[12], target.matrix[13], target.matrix[14]];
  raycaster.firstHitOnly = false; raycaster.set([c[0], c[1], c[2] + 50], [0, 0, -1]);
  const before = raycaster.intersectEngine(engine).filter(h => h.mesh === target.mesh).length;
  assert.ok(before >= 2);
  engine.store.hidden[target.mesh.id] = 1;
  assert.equal(raycaster.intersectEngine(engine).filter(h => h.mesh === target.mesh).length, 0, 'hidden mesh');
  engine.store.hidden[target.mesh.id] = 0;
  engine.store.parents[target.mesh.id] = transforms[5].mesh.id; engine.store.hidden[transforms[5].mesh.id] = 1;
  assert.equal(raycaster.intersectEngine(engine).filter(h => h.mesh === target.mesh).length, 0, 'hidden ancestor');
  engine.store.hidden[transforms[5].mesh.id] = 0; engine.store.parents[target.mesh.id] = -1;
  setMeshLayers(target.mesh, 0b10); raycaster.layers = 0b01;
  assert.equal(raycaster.intersectEngine(engine).filter(h => h.mesh === target.mesh).length, 0, 'layers');
  raycaster.layers = 0b11;
  assert.equal(raycaster.intersectEngine(engine).filter(h => h.mesh === target.mesh).length, before);
  raycaster.filter = mesh => mesh !== target.mesh;
  assert.equal(raycaster.intersectEngine(engine).filter(h => h.mesh === target.mesh).length, 0, 'filter');
  raycaster.filter = null;
  raycaster.near = 49; raycaster.far = 50.5;
  assert.ok(raycaster.intersectEngine(engine).every(h => h.distance >= 49 && h.distance <= 50.5));
  console.log(`Raycaster: ${checked} rays over 8 transformed meshes, ${hitCount} with hits`);
});

test('Raycaster.setFromCamera inverts the reversed-Z WebGPU and the WebGL view-projection', () => {
  const r = rng(8);
  for (const webgpu of [true, false]) for (let i = 0; i < 200; i++) {
    const camera = new Camera({fov: 30 + r() * 80, position: [(r() * 2 - 1) * 10, (r() * 2 - 1) * 10, 5 + r() * 10], target: [r() - 0.5, r() - 0.5, r() - 0.5], near: 0.05 + r(), far: 50 + r() * 500});
    camera.update(0.5 + r() * 2, webgpu);
    const point = [(r() * 2 - 1) * 2, (r() * 2 - 1) * 2, (r() * 2 - 1) * 2], m = camera.matrix;
    const clip = [0, 1, 2, 3].map(row => m[row] * point[0] + m[4 + row] * point[1] + m[8 + row] * point[2] + m[12 + row]);
    if (clip[3] <= 0) continue;
    const ray = new Raycaster().setFromCamera([clip[0] / clip[3], clip[1] / clip[3]], camera, webgpu);
    assert.deepEqual([...ray.origin], camera.position);
    const toPoint = point.map((v, a) => v - camera.position[a]), along = toPoint.reduce((sum, v, a) => sum + v * ray.direction[a], 0);
    const miss = Math.hypot(...toPoint.map((v, a) => v - along * ray.direction[a]));
    assert.ok(along > 0 && miss < 1e-4 * Math.max(1, along), `${webgpu ? 'webgpu' : 'webgl'} #${i}: ray misses projected point by ${miss}`);
  }
  // Canvas pixels: the canvas center looks at the camera target.
  const engine = mockEngine(), raycaster = new Raycaster().setFromEngine(engine, 200, 100);
  assert.ok(Math.abs(raycaster.direction[2] + 1) < 1e-6);
  const inverse = invertMatrix([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 1, 2, 3, 1]);
  assert.ok(Math.abs(inverse[0] - 0.5) < 1e-12 && Math.abs(inverse[12] + 0.5) < 1e-12);
});

test('Raycaster.setFromCamera casts parallel rays from the near plane for an orthographic matrix', () => {
  // Reversed-Z ortho looking down -z from z=10: x,y in [-4,4] x [-2,2], eye-space near -5, far 20.
  const n = -5, f = 20, matrix = new Float32Array([0.25, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1 / (f - n), 0, 0, 0, -10 / (f - n) + f / (f - n), 1]);
  const ray = new Raycaster().setFromCamera([0.5, -0.5], {matrix, position: [0, 0, 10]});
  assert.ok([2, -1, 15].every((v, a) => Math.abs(ray.origin[a] - v) < 1e-5), `origin ${[...ray.origin]}`);
  assert.ok([0, 0, -1].every((v, a) => Math.abs(ray.direction[a] - v) < 1e-6));
});

test('Raycaster sphere pruning remains conservative under shear and mirrored shear', () => {
  const geometry = box(), raycaster = new Raycaster();
  for (const sign of [1, -1]) {
    const engine = mockEngine(), matrix = new Float32Array([sign, 0, 0, 0, sign, .2, 0, 0, sign, 0, .2, 0, 0, 0, 0, 1]);
    const mesh = engine.add(geometry, matrix), positions = new Float64Array(geometry.vertices.length / 2);
    for (let v = 0; v < positions.length / 3; v++) transformPoint(matrix, ...geometry.vertices.subarray(v * 6, v * 6 + 3), positions, v * 3);
    const origin = [sign * 1.3, .09, 2], direction = [0, 0, -1], reference = bruteRay({positions, indices: geometry.indices}, {origin, direction});
    assert.ok(reference.length, 'The ray intersects the sheared box outside the longest-column sphere');
    raycaster.set(origin, direction);
    for (const firstHitOnly of [false, true]) {
      raycaster.firstHitOnly = firstHitOnly;
      const hits = raycaster.intersectEngine(engine);
      assert.equal(hits.length, firstHitOnly ? 1 : reference.length);
      assert.ok(close(hits[0].distance, reference[0].distance, 1e-6));
      assert.equal(hits[0].mesh, mesh);
    }
  }
});

test('MeshBVH.build converts each plain attribute stream once without changing storage or queries', () => {
  const source = {positions: Array.from(meshes.sphere.positions), normals: Array.from(meshes.sphere.normals), indices: Array.from(meshes.sphere.indices)};
  const from = Float32Array.from, conversions = new Map();
  let bvh;
  Float32Array.from = function(input, ...args) {conversions.set(input, (conversions.get(input) ?? 0) + 1); return from.call(this, input, ...args);};
  try {bvh = MeshBVH.build(source);} finally {Float32Array.from = from;}
  assert.equal(conversions.get(source.positions), 1, 'Do not copy positions while extracting indices or wrapping the built BVH');
  assert.equal(conversions.get(source.normals), 1, 'Do not repeat normal stream conversion');
  const typed = MeshBVH.build(meshes.sphere);
  assert.deepEqual(bvh.serialize(), typed.serialize());
  assert.deepEqual(bvh.raycast({origin: [0, 0, 3], direction: [0, 0, -1]}), typed.raycast({origin: [0, 0, 3], direction: [0, 0, -1]}));
});
