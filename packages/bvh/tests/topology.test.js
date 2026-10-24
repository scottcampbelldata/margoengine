import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBVH } from '../dist/index.js';

const triangle = [0, 0, 0, 1, 0, 0, 0, 1, 0];
function fixture(internal, rights) {
  const nodes = new ArrayBuffer(internal.length * 32),
    f = new Float32Array(nodes),
    u = new Uint32Array(nodes);
  let leaves = 0;
  for (let i = 0; i < internal.length; i++) {
    f.set([-1, -1, -1, 1, 1, 1], i * 8);
    u[i * 8 + 6] = internal[i] ? rights[i] : leaves++;
    u[i * 8 + 7] = internal[i] ? 0x80000002 : 1;
  }
  return {
    data: {
      nodes,
      index: Uint32Array.from({ length: leaves * 3 }, (_, i) => i),
      triangles: Uint32Array.from({ length: leaves }, (_, i) => i),
    },
    source: { positions: Float32Array.from(Array.from({ length: leaves }, () => triangle).flat()) },
  };
}
const dag = () =>
  fixture(
    Array.from({ length: 16 }, (_, i) => i < 14),
    Array.from({ length: 16 }, (_, i) => i + 2),
  );
const balanced = () => fixture([1, 1, 0, 0, 1, 0, 0], [4, 3, 0, 0, 6]);
const overlap = () => {
  const f = balanced();
  new Uint32Array(f.data.nodes)[6] = 3;
  return f;
};
const forest = () => fixture([0, 0, 0], []);
const deep = (depth) =>
  fixture(
    Array.from({ length: 2 * depth + 1 }, (_, i) => i < depth),
    Array.from({ length: 2 * depth + 1 }, (_, i) => 2 * depth - i),
  );
const packed = (data) => {
  const buffer = new ArrayBuffer(16 + data.nodes.byteLength + data.index.byteLength + data.triangles.byteLength);
  new Uint32Array(buffer, 0, 4).set([0x48564256, 1, data.nodes.byteLength / 32, data.triangles.length]);
  new Uint8Array(buffer, 16, data.nodes.byteLength).set(new Uint8Array(data.nodes));
  new Uint32Array(buffer, 16 + data.nodes.byteLength, data.index.length).set(data.index);
  new Uint32Array(buffer, 16 + data.nodes.byteLength + data.index.byteLength, data.triangles.length).set(
    data.triangles,
  );
  return buffer;
};

for (const [label, make] of [
  ['shared-node DAG', dag],
  ['overlapping subtree', overlap],
  ['forest of unreachable leaves', forest],
])
  test('constructor refuses a ' + label, () => {
    const { data, source } = make();
    assert.throws(() => new MeshBVH(data, source), RangeError);
  });
test('deserialize validates the tree', () => {
  const { data, source } = overlap();
  assert.throws(() => MeshBVH.deserialize({ version: 1, ...data }, source), RangeError);
});
test('fromArrayBuffer validates the tree', () => {
  const { data, source } = dag();
  assert.throws(() => MeshBVH.fromArrayBuffer(packed(data), source), RangeError);
});
test('valid deep prebuilt trees are accepted without recursion', () => {
  for (const depth of [65, 4096]) {
    const { data, source } = deep(depth);
    assert.equal(new MeshBVH(data, source).triangleCount, depth + 1);
  }
});

// Forward depth-first reference, independent of the constructor's backward check.
function reference(data) {
  const words = new Uint32Array(data.nodes),
    count = words.length / 8,
    seen = new Set(),
    pending = [0];
  let next = 0;
  while (pending.length) {
    const node = pending.pop();
    if (node < 0 || node >= count || seen.has(node) || node !== next++) return false;
    seen.add(node);
    if (words[node * 8 + 7] & 0x80000000) pending.push(words[node * 8 + 6], node + 1);
  }
  return seen.size === count;
}
test('every small linked layout is accepted exactly when it is one packed tree', () => {
  let tested = 0,
    valid = 0;
  for (const count of [1, 3, 5, 7, 9])
    for (let mask = 0; mask < 2 ** count; mask++) {
      const internal = Array.from({ length: count }, (_, i) => (mask >> i) & 1),
        leaves = internal.filter((x) => !x).length;
      if (leaves * 2 !== count + 1) continue;
      const rights = new Array(count).fill(0);
      const enumerate = (node) => {
        if (node === count) {
          const { data, source } = fixture(internal, rights),
            expected = reference(data);
          if (expected) {
            new MeshBVH(data, source);
            valid++;
          } else
            assert.throws(() => new MeshBVH(data, source), RangeError, `nodes=${count} mask=${mask} links=${rights}`);
          tested++;
          return;
        }
        if (!internal[node]) enumerate(node + 1);
        else
          for (let right = node + 2; right < count; right++) {
            rights[node] = right;
            enumerate(node + 1);
          }
      };
      enumerate(0);
    }
  assert.equal(tested, 7007);
  assert.equal(valid, 23);
});
