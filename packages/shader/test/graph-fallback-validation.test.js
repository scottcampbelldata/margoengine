import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateSurfaceGraph,
  serializeSurfaceGraph,
  parseSurfaceGraph,
  compileSurfaceGraph,
} from '@margoengine/shader/graph';
const graph = () => ({
  version: 1,
  nodes: [],
  outputs: {},
  fallback: { color: [1, 1, 1], emissive: [0, 0, 0], roughness: 0.5, metalness: 0, opacity: 1 },
});
const hole = (axis) => {
  const a = [0, 0, 0];
  delete a[axis];
  return a;
};
for (const slot of ['color', 'emissive']) {
  for (const [label, value] of [
    ['all holes', Array(3)],
    ['x hole', hole(0)],
    ['y hole', hole(1)],
    ['z hole', hole(2)],
    ['undefined', [0, undefined, 0]],
    ['NaN', [0, NaN, 0]],
    ['Infinity', [0, Infinity, 0]],
    ['over budget', [0, 1000001, 0]],
    ['negative', [0, -1, 0]],
    ['typed shape', new Float32Array(3)],
  ]) {
    test(slot + ' ' + label + ' is refused by validation and save', () => {
      const g = graph();
      g.fallback[slot] = value;
      for (const consume of [validateSurfaceGraph, serializeSurfaceGraph, compileSurfaceGraph])
        assert.throws(() => consume(g), TypeError);
    });
  }
}
test('dense fallback boundary values retain canonical round trips and input ownership', () => {
  const g = graph();
  g.fallback.color = [0, 1000000, 0.5];
  g.fallback.emissive = [1000000, 0, 0];
  const before = structuredClone(g);
  validateSurfaceGraph(g);
  const json = serializeSurfaceGraph(g);
  assert.equal(
    json,
    '{"version":1,"nodes":[],"outputs":{},"fallback":{"color":[0,1000000,0.5],"emissive":[1000000,0,0],"roughness":0.5,"metalness":0,"opacity":1}}',
  );
  assert.deepEqual(parseSurfaceGraph(json), before);
  assert.equal(serializeSurfaceGraph(parseSurfaceGraph(json)), json);
  assert.deepEqual(g, before);
  assert.deepEqual(compileSurfaceGraph(g), {});
});
test('previously saved null-hole fallback vectors remain invalid', () => {
  for (const json of [
    '{"version":1,"nodes":[],"outputs":{},"fallback":{"color":[0,null,0],"emissive":[0,0,0],"roughness":0.5,"metalness":0,"opacity":1}}',
    '{"version":1,"nodes":[],"outputs":{},"fallback":{"color":[1,1,1],"emissive":[0,null,0],"roughness":0.5,"metalness":0,"opacity":1}}',
  ])
    assert.throws(() => parseSurfaceGraph(json), TypeError);
});
test('existing node work bound remains enforced', () => {
  const g = graph();
  g.nodes = Array.from({ length: 129 }, (_, i) => ({ id: 'n' + i, op: 'float', inputs: [], value: 1 }));
  assert.throws(() => validateSurfaceGraph(g), /128/);
});
