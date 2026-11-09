// Diagnostic paired CPU experiment, independent of GPU timing. The scalar
// reference sorts medians; the Rust kernel selects medians and uses SIMD input
// validation. Both must emit every byte of the same full geometry and BVH.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
const f = new Float32Array(1),
  u = new Uint32Array(f.buffer);
function outward(value, up) {
  f[0] = value;
  if (value === 0) return up ? 1 : 0x80000001;
  u[0] += value > 0 === up ? 1 : -1;
  return u[0];
}
function scalar(input) {
  const vertexCount = input[1],
    count = input[2] / 3,
    positions = new Float32Array(input.buffer, 16, vertexCount * 3),
    ids = input.subarray(4 + vertexCount * 3);
  assert.ok(positions.every((v) => Math.abs(v) <= 1e8));
  const triangles = [],
    records = new Uint32Array(count * 16),
    rf = new Float32Array(records.buffer);
  for (let i = 0; i < count; i++) {
    const p = Array.from({ length: 3 }, (_, k) =>
      Array.from(positions.subarray(ids[i * 3 + k] * 3, ids[i * 3 + k] * 3 + 3)),
    );
    const a = p[1].map((v, k) => v - p[0][k]),
      b = p[2].map((v, k) => v - p[0][k]);
    const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
      length = Math.sqrt(n.reduce((s, v) => s + v * v, 0));
    assert.ok(length > 0);
    for (let k = 0; k < 3; k++) rf.set(p[k], i * 16 + k * 4);
    records[i * 16 + 3] = input[3];
    records[i * 16 + 7] = i;
    rf.set(
      n.map((v) => v / length),
      i * 16 + 12,
    );
    triangles.push({
      lo: [0, 1, 2].map((k) => Math.min(...p.map((v) => v[k]))),
      hi: [0, 1, 2].map((k) => Math.max(...p.map((v) => v[k]))),
      c: [0, 1, 2].map((k) => (p[0][k] + p[1][k] + p[2][k]) / 3),
    });
  }
  const nodes = [];
  const branch = (order) => {
    const at = nodes.length;
    nodes.push(0, 0, 0, 0, 0, 0, 0, 0);
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (const i of order)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], triangles[i].lo[a]);
        hi[a] = Math.max(hi[a], triangles[i].hi[a]);
      }
    for (let a = 0; a < 3; a++) {
      nodes[at + a] = outward(lo[a], false);
      nodes[at + 4 + a] = outward(hi[a], true);
    }
    if (order.length === 1) nodes[at + 7] = order[0] + 1;
    else {
      let a = 0;
      for (let k = 1; k < 3; k++) if (Math.fround(hi[k] - lo[k]) >= Math.fround(hi[a] - lo[a])) a = k;
      order.sort((i, j) => triangles[i].c[a] - triangles[j].c[a] || i - j);
      const mid = order.length >> 1;
      branch(order.slice(0, mid));
      branch(order.slice(mid));
    }
    nodes[at + 3] = nodes.length / 8;
  };
  if (count) branch(Array.from({ length: count }, (_, i) => i));
  const result = new Uint32Array(4 + nodes.length + records.length);
  result.set([nodes.length / 8, 4 + nodes.length, count, 0]);
  result.set(nodes, 4);
  result.set(records, 4 + nodes.length);
  return result;
}
const count = 16384,
  input = new Uint32Array(4 + count * 12);
input.set([1, count * 3, count * 3, 1]);
const pos = new Float32Array(input.buffer, 16, count * 9),
  indices = input.subarray(4 + count * 9);
let seed = 13;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
for (let i = 0; i < count; i++) {
  const x = random() * 100,
    y = random() * 100,
    z = random() * 100;
  pos.set([x, y, z, x + 0.1, y + 0.7, z + 0.2, x + 0.8, y + 0.3, z + 0.5], i * 9);
  indices.set([i * 3, i * 3 + 1, i * 3 + 2], i * 3);
}
const {
  instance: { exports: k },
} = await WebAssembly.instantiate(await readFile(new URL('../src/mesh.wasm', import.meta.url)));
const pointer = k.allocate(input.length);
new Uint32Array(k.memory.buffer, pointer, input.length).set(input);
const wasm = () => {
  assert.equal(k.build_mesh(pointer, input.length), 0);
  return new Uint32Array(k.memory.buffer, k.output_ptr(), k.output_len()).slice();
};
try {
  const expected = scalar(input);
  assert.deepEqual(wasm(), expected, 'entire geometry and tree must be byte identical');
  const rounds = [];
  for (let round = 0; round < 5; round++) {
    const times = { scalar: [], wasm: [] };
    for (let repeat = 0; repeat < 3; repeat++)
      for (const name of round % 2 ? ['wasm', 'scalar'] : ['scalar', 'wasm']) {
        const start = performance.now(),
          value = name === 'wasm' ? wasm() : scalar(input);
        times[name].push(performance.now() - start);
        assert.deepEqual(value, expected);
      }
    rounds.push({ scalar: Math.min(...times.scalar), wasm: Math.min(...times.wasm) });
  }
  const result = {
    diagnostic: true,
    triangles: count,
    identicalWords: expected.length,
    rounds,
    simdValidation: {
      scalarCoordinatePredicates: pos.length,
      vectorGroups: Math.floor(pos.length / 4),
      scalarTail: pos.length % 4,
    },
  };
  await writeFile('test-results/voxel-pathtracer-mesh-build-ab.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  k.release(pointer, input.length);
}
