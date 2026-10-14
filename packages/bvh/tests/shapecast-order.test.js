import test from 'node:test';
import assert from 'node:assert/strict';
import {MeshBVH, CONTAINED, INTERSECTED, NOT_INTERSECTED} from '../dist/index.js';

function fourLeafTree() {
  const positions = new Float32Array(36);
  for (let face = 0; face < 4; face++) positions.set([face * 2 - 3, 0, 0, face * 2 - 2.5, 0, 0, face * 2 - 3, 1, 0], face * 9);
  const nodes = new ArrayBuffer(7 * 32), bounds = new Float32Array(nodes), data = new Uint32Array(nodes);
  for (const [node, face] of [[2, 0], [3, 1], [5, 2], [6, 3]]) {
    const x = positions[face * 9]; bounds.set([x, 0, 0, x + 0.5, 1, 0], node * 8); data[node * 8 + 6] = face; data[node * 8 + 7] = 1;
  }
  for (const [node, left, right] of [[4, 5, 6], [1, 2, 3], [0, 1, 4]]) {
    bounds.set([bounds[left * 8], 0, 0, bounds[right * 8 + 3], 1, 0], node * 8); data[node * 8 + 6] = right; data[node * 8 + 7] = 0x80000000;
  }
  return new MeshBVH({nodes, index: Uint32Array.from({length: 12}, (_, i) => i), triangles: new Uint32Array([0, 1, 2, 3])}, {positions});
}

test('shapecast preserves scored callback order, containment and callback-local data through nested queries', () => {
  const bvh = fourLeafTree(), events = [], nestedKinds = new Set();
  function nested(kind, value) {
    if (nestedKinds.has(kind)) return;
    nestedKinds.add(kind);
    const before = Array.from(value), ranges = [];
    assert.equal(bvh.shapecast({intersectsBounds: () => CONTAINED, intersectsRange: (offset, count, contained, depth, node) => {
      ranges.push([offset, count, contained, depth, node]); return ranges.length === 2;
    }}), true);
    assert.deepEqual(ranges, [[0, 1, true, 2, 2], [1, 1, true, 2, 3]]);
    assert.deepEqual(Array.from(value), before, 'Nested shapecast changed an outer callback view');
    const retained = bvh.raycastFirst({origin: [-2.9, 0.1, 2], direction: [0, 0, -1]});
    assert.ok(retained, 'Retained-hit fixture missed its first triangle');
    const snapshot = structuredClone(retained), later = bvh.raycastFirst({origin: [3.1, 0.1, 2], direction: [0, 0, -1]});
    assert.ok(later, 'Retained-hit fixture missed its second triangle'); assert.notEqual(retained.point, later.point);
    assert.deepEqual(retained, snapshot, 'A later query changed a retained hit');
  }
  const stopped = bvh.shapecast({
    boundsTraverseOrder: box => {nested('order', box.min); events.push(['order', box.min[0]]); return -box.min[0];},
    intersectsBounds: (box, leaf, score, depth, node) => {
      nested('bounds', box.min); events.push(['bounds', node, leaf, score, depth]);
      return node === 4 ? CONTAINED : node === 3 ? NOT_INTERSECTED : INTERSECTED;
    },
    intersectsRange: (offset, count, contained, depth, node) => {nested('range', bvh.nodeBounds); events.push(['range', offset, count, contained, depth, node]);},
    intersectsTriangle: (triangle, face, contained, depth) => {nested('triangle', triangle.a); events.push(['triangle', face, contained, depth]);}
  });
  assert.equal(stopped, false); assert.deepEqual([...nestedKinds].sort(), ['bounds', 'order', 'range', 'triangle']);
  assert.deepEqual(events, [
    ['bounds', 0, false, undefined, 0], ['order', -3], ['order', 1], ['bounds', 4, false, -1, 1],
    ['range', 2, 1, true, 2, 5], ['triangle', 2, true, 2], ['range', 3, 1, true, 2, 6], ['triangle', 3, true, 2],
    ['bounds', 1, false, 3, 1], ['order', -3], ['order', -1], ['bounds', 3, true, 1, 2], ['bounds', 2, true, 3, 2],
    ['range', 0, 1, false, 2, 2], ['triangle', 0, false, 2]
  ]);
});

test('shapecast range and triangle stops preserve their first visited node and skip later callbacks', () => {
  const bvh = fourLeafTree(), bounds = [], ranges = [], triangles = [];
  assert.equal(bvh.shapecast({
    intersectsBounds: (box, leaf, score, depth, node) => {bounds.push(node); return true;},
    intersectsRange: offset => {ranges.push(offset); return true;},
    intersectsTriangle: (triangle, face) => {triangles.push(face);}
  }), true);
  assert.deepEqual(bounds, [0, 1, 2]); assert.deepEqual(ranges, [0]); assert.deepEqual(triangles, []);
  ranges.length = 0;
  assert.equal(bvh.shapecast({
    intersectsBounds: () => CONTAINED,
    boundsTraverseOrder: () => {throw new Error('Contained nodes must not be scored');},
    intersectsRange: offset => {ranges.push(offset);},
    intersectsTriangle: (triangle, face, contained) => {assert.equal(contained, true); triangles.push(face); return face === 2;}
  }), true);
  assert.deepEqual(ranges, [0, 1, 2]); assert.deepEqual(triangles, [0, 1, 2]);
});
