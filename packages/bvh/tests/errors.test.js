// Every refusal names its fix: the message carries a "; use/pass/..." clause the caller can act on.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBVH } from '../dist/index.js';

const positions = () => Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const fix = /; (pass|use|keep|check|build|supply|rebuild|re-read|split|add|read)\b/;
const make = () => MeshBVH.build({ positions: positions(), indices: [0, 1, 2] });

test('buffer and serialization errors say what to do', () => {
  const buffer = make().toArrayBuffer();
  const source = { positions: positions() };
  const bad = buffer.slice(0);
  new Uint32Array(bad)[0] = 0;
  assert.throws(() => MeshBVH.fromArrayBuffer(bad, source), { name: 'TypeError', message: fix });
  assert.throws(() => MeshBVH.fromArrayBuffer(buffer.slice(0, buffer.byteLength - 4), source), {
    name: 'RangeError',
    message: fix,
  });
  assert.throws(() => MeshBVH.deserialize({ version: 2 }, source), { name: 'TypeError', message: fix });
});

test('input errors say what to do', () => {
  assert.throws(() => MeshBVH.build({ positions: positions(), indices: [0, 1, 7] }), {
    name: 'RangeError',
    message: fix,
  });
  const bvh = make();
  assert.throws(() => bvh.raycastFirst({ origin: [0, 0, 1], direction: [0, 0, -1] }, { side: 'sideways' }), {
    name: 'TypeError',
    message: fix,
  });
  assert.throws(() => bvh.intersectsBox({ min: [0, 0, 0], max: [1, 1, 1] }, new Float64Array(16)), {
    name: 'RangeError',
    message: fix,
  });
});
