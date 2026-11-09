import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSTL, exportOBJ, exportPLY } from '../dist/index.js';

test('test-page 42: every reported exporter rejects incomplete indexed triangles without mutating inputs', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  for (const write of [exportSTL, exportOBJ, exportPLY]) {
    for (const ArrayType of [Array, Uint16Array, Uint32Array]) {
      for (const count of [1, 2, 4, 5]) {
        const indices = ArrayType.from({ length: count }, (_, i) => i % 3);
        const geometry = { positions, normals, indices };
        const before = structuredClone(geometry);
        for (const scale of [[1, 1, 1], [-1, 1, 1]]) {
          assert.throws(() => write({ nodes: [{ geometry, scale }] }),
            error => error instanceof RangeError && /complete triangles/.test(error.message));
          assert.deepEqual(geometry, before);
        }
      }
    }
    assert.doesNotThrow(() => write({ nodes: [{ geometry: {
      positions, normals, indices: new Uint32Array([0, 1, 2]),
    } }] }));
  }
});
