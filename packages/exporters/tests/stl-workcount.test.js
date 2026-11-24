import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { exportSTL, exportOBJ, exportPLY } from '../dist/index.js';

const geometry = {
  positions: [0.125, -2, 3, 2, 0, -1, -3, 4, 0, 1, 1, 1],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
const source = { nodes: [{ name: 'part', geometry, matrix: [-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0.25, 0, 1, 2, 3, 1] }] };
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('STL transforms positions without transforming vertex normals that its facet writer discards', () => {
  const hypot = Math.hypot;
  const Native = globalThis.Float64Array;
  let lengths = 0;
  let vertexArrays = 0;
  Math.hypot = (...values) => {
    if (values.length === 3) lengths++;
    return hypot(...values);
  };
  globalThis.Float64Array = new Proxy(Native, {
    construct(target, args) {
      if (args[0] === 12) vertexArrays++;
      return Reflect.construct(target, args);
    },
  });
  let result;
  try {
    result = exportSTL(source, { upAxis: 'z' });
  } finally {
    Math.hypot = hypot;
    globalThis.Float64Array = Native;
  }
  assert.equal(lengths, 9, '4 input normal validations, 3 matrix basis lengths and 2 facet normals');
  assert.equal(vertexArrays, 1, 'only positions need a double-precision world vertex array');
  assert.equal(hash(result), 'f777914288cb7dcb6f5ad312e296cf919b38328cdcf59c8fb2360f3d58d938f5');
});

test('STL binary/ASCII axis conversions and OBJ/PLY keep their original bytes', () => {
  for (const [upAxis, binary, expected] of [
    ['y', true, '6ad5ca6be471c51b6341b80f4204c12b1840feaa0a3546589c7db3316b4d1fb4'],
    ['y', false, '9c1a32d0f0403332428da840247e44660c138431a9f466693ae6ba2a22120eb2'],
    ['z', true, 'f777914288cb7dcb6f5ad312e296cf919b38328cdcf59c8fb2360f3d58d938f5'],
    ['z', false, 'ee1ea329be06a6e417532ac02957971d483d64d12d2f4f716af281fe6275874d'],
  ]) assert.equal(hash(exportSTL(source, { upAxis, binary })), expected);
  assert.equal(hash(exportOBJ(source).obj), 'a0408a794abc5bd027b496801ae12e247093de45437ce008a160ac9f211200ba');
  assert.equal(hash(exportPLY(source, { binary: true })), 'b2380b152fd2f5adf0a11cdcf4b6afaa84df412ba327e74135db43d1faf091b5');
  assert.throws(() => exportSTL({ nodes: [{ geometry: { ...geometry, normals: [Infinity, ...geometry.normals.slice(1)] } }] }), RangeError);
});
