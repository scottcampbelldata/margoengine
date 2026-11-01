import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { EdgesHelper, featureEdges, gradientColors } from '@margoengine/lines/edges';

// Two triangles sharing the edge (0,0,0)-(1,0,0), folded by `degrees` from flat; `split` gives each its own vertices.
function fold(degrees, split = false) {
  const a = (degrees * Math.PI) / 180,
    wing = [Math.cos(Math.PI) * 0 + 0.5, -Math.cos(a), Math.sin(a)];
  const left = [0, 0, 0, 1, 0, 0, 0.5, 1, 0];
  if (!split) return { vertices: [...left, ...wing], indices: [0, 1, 2, 1, 0, 3], stride: 3 };
  return { vertices: [...left, 1, 0, 0, 0, 0, 0, ...wing], indices: [0, 1, 2, 3, 4, 5], stride: 3 };
}
const edges = (out) => out.length / 6;

test('a box has its 12 edges, with split normals at every corner, and no diagonal', () => {
  const geometry = box(2, 2, 2),
    out = featureEdges(geometry);
  assert.equal(edges(out), 12);
  for (let i = 0; i < out.length; i += 6) {
    const changed = [0, 1, 2].filter((k) => Math.abs(out[i + k] - out[i + 3 + k]) > 1e-6);
    assert.equal(changed.length, 1, 'parallel to one axis');
  }
});

test('the crease angle decides, on both sides of it, for welded and split vertices', () => {
  for (const split of [false, true]) {
    const { vertices, indices, stride } = fold(40, split),
      source = { vertices, indices },
      creases = (angle) => edges(featureEdges(source, { angle, stride, boundary: false }));
    assert.equal(creases(30), 1, '40 degrees beats 30');
    assert.equal(creases(50), 0, '40 degrees stays under 50');
  }
});

test('a boundary is kept by default and can be left out; a flat seam is no edge', () => {
  const { vertices, indices, stride } = fold(0, true);
  assert.equal(edges(featureEdges({ vertices, indices }, { stride })), 4);
  assert.equal(edges(featureEdges({ vertices, indices }, { stride, boundary: false })), 0);
});

test('an edge with three faces is kept whatever the angle; degenerate triangles add nothing', () => {
  const vertices = [0, 0, 0, 1, 0, 0, 0.5, 1, 0, 0.5, -1, 0, 0.5, 2, 0];
  assert.equal(
    edges(featureEdges({ vertices, indices: [0, 1, 2, 1, 0, 3, 0, 1, 4] }, { stride: 3, boundary: false, angle: 180 })),
    1,
  );
  assert.equal(edges(featureEdges({ vertices, indices: [0, 0, 1, 2, 2, 2] }, { stride: 3 })), 0);
});

test('bad options and indices name the fix', () => {
  const source = { vertices: [0, 0, 0], indices: [0, 0, 5] };
  assert.throws(() => featureEdges(source, { stride: 3 }), /below the vertex count/);
  assert.throws(() => featureEdges(source, { angle: 200 }), /0 to 180/);
  assert.throws(() => featureEdges(source, { stride: 2 }), /stride/);
  assert.throws(() => featureEdges(source, { tolerance: 0 }), /tolerance/);
});

test('EdgesHelper is a segments line of those edges', () => {
  const helper = new EdgesHelper(box(1, 1, 1), { color: '#ff0000' });
  assert.equal(helper.mode, 'segments');
  assert.equal(helper.segmentCount, 12);
});

test('gradientColors runs by distance along a strip, not by point count', () => {
  const red = [1, 0, 0],
    blue = [0, 0, 1],
    colors = gradientColors([0, 0, 0, 1, 0, 0, 4, 0, 0], [red, blue]);
  assert.deepEqual([...colors.subarray(0, 3)], red);
  assert.ok(Math.abs(colors[3] - 0.75) < 1e-6, 'a quarter of the way');
  assert.ok(Math.abs(colors[5] - 0.25) < 1e-6);
  assert.deepEqual([...colors.subarray(6)], blue);
});

test('gradientColors in segments mode runs over each pair, and stops place the colours', () => {
  const colors = gradientColors(
    [0, 0, 0, 9, 0, 0, 0, 1, 0, 0, 2, 0],
    [
      [1, 1, 1],
      [0, 0, 0],
    ],
    { mode: 'segments' },
  );
  assert.deepEqual([...colors], [1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0]);
  const stepped = gradientColors(
    [0, 0, 0, 1, 0, 0, 2, 0, 0],
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
    ],
    { stops: [0, 0.5, 1] },
  );
  assert.deepEqual([...stepped.subarray(3, 6)], [1, 0, 0]);
  assert.throws(() => gradientColors([], ['#fff']), /two or more/);
  assert.throws(() => gradientColors([], ['#fff', '#000'], { stops: [1, 0] }), /rising/);
});
