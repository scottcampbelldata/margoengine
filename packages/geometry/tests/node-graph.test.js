// The geometry graph: sources, setters, instancing, conditionals, noise, merge, material ids, JSON in and out, limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GeometryGraph, buildGeometryGraph, parseGeometryGraph, GRAPH_NODE_TYPES } from '../dist/node-graph.js';
import { boxGeometry } from '../dist/primitives.js';

const near = (a, b, t = 1e-5) => assert.ok(Math.abs(a - b) <= t, `${a} against ${b}`);
const bounds = (g, from = 0, to = g.positions.length / 3) => {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = from; i < to; i++)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], g.positions[i * 3 + k]);
      hi[k] = Math.max(hi[k], g.positions[i * 3 + k]);
    }
  return { lo, hi };
};
const mean = (g, from, to) => {
  const m = [0, 0, 0];
  for (let i = from; i < to; i++) for (let k = 0; k < 3; k++) m[k] += g.positions[i * 3 + k] / (to - from);
  return m;
};

test('a source builds, and the graph round-trips through JSON', () => {
  const g = new GeometryGraph();
  const box = g.add('box', { params: { width: 2, height: 1, depth: 1 } });
  g.setOutput(box);
  const mesh = g.build();
  assert.equal(mesh.positions.length / 3, 24);
  assert.equal(mesh.indices.length, 36);
  assert.deepEqual(bounds(mesh).hi, [1, 0.5, 0.5]);
  const text = g.stringify();
  const again = GeometryGraph.fromJSON(text).build();
  assert.deepEqual([...again.positions], [...mesh.positions]);
  assert.deepEqual(JSON.parse(text), g.toJSON());
  assert.ok(GRAPH_NODE_TYPES.includes('instantiateOnFaces'));
});

test('noise is zero on lattice points, bounded, seeded and shaped by octaves', () => {
  const make = (position, params = {}) => {
    const g = new GeometryGraph();
    const plane = g.add('plane');
    const noise = g.add('noise', { inputs: { position }, params });
    g.setOutput(g.add('setColors', { inputs: { geometry: plane, colors: noise } }));
    return g.build();
  };
  near(make([1, 2, 3]).colors[0], 0, 0); // Perlin's noise is zero at integer lattice points
  const a = make([0.3, 0.6, 0.9]).colors[0];
  assert.ok(a !== 0 && Math.abs(a) <= 1);
  assert.equal(make([0.3, 0.6, 0.9]).colors[0], a); // deterministic
  assert.notEqual(make([0.3, 0.6, 0.9], { seed: 7 }).colors[0], a); // seeded
  assert.notEqual(make([0.3, 0.6, 0.9], { octaves: 4 }).colors[0], a);
  // The vector form gives three decorrelated samples.
  const g = new GeometryGraph();
  const plane = g.add('plane');
  const n = g.add('noise', { inputs: { position: [0.3, 0.6, 0.9] }, params: { output: 'vector' } });
  g.setOutput(g.add('setColors', { inputs: { geometry: plane, colors: n } }));
  const c = g.build().colors;
  assert.ok(c[0] !== c[1] && c[1] !== c[2]);
});

test('setPositions displaces per vertex with the context, and recomputes normals', () => {
  const g = new GeometryGraph();
  const sphere = g.add('sphere', { params: { radius: 1, widthSegments: 16, heightSegments: 8 } });
  const pos = g.add('context', { params: { field: 'position' } });
  const nrm = g.add('context', { params: { field: 'normal' } });
  const bump = g.add('multiply', { inputs: { a: nrm, b: 0.5 } });
  const moved = g.add('add', { inputs: { a: pos, b: bump } });
  g.setOutput(g.add('setPositions', { inputs: { geometry: sphere, positions: moved } }));
  const mesh = g.build();
  const radii = Array.from({ length: mesh.positions.length / 3 }, (_, i) => Math.hypot(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]));
  assert.ok(radii.every((r) => Math.abs(r - 1.5) < 1e-4)); // every vertex moved 0.5 along its normal
  for (let i = 0; i < mesh.normals.length; i += 3) near(Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]), 1, 1e-4);
});

test('random: seeded, in range, and changed by the build seed', () => {
  const g = new GeometryGraph();
  const plane = g.add('plane', { params: { widthSegments: 4, heightSegments: 4 } });
  const r = g.add('random', { inputs: { min: 2, max: 3 } });
  g.setOutput(g.add('setColors', { inputs: { geometry: plane, colors: r } }));
  const a = g.build(),
    b = g.build({ seed: 5 });
  assert.ok([...a.colors].every((v, i) => (i % 4 === 3 ? v === 1 : v >= 2 && v < 3)));
  assert.deepEqual([...a.colors], [...g.build().colors]);
  assert.notDeepEqual([...a.colors], [...b.colors]);
  assert.ok(new Set(a.colors.filter((_, i) => i % 4 === 0)).size > 5); // not constant: it follows the vertex index
});

test('instantiateOnVertices puts one instance on each distinct vertex', () => {
  const g = new GeometryGraph();
  const target = g.add('box');
  const instance = g.add('box', { params: { width: 0.1, height: 0.1, depth: 0.1 } });
  g.setOutput(g.add('instantiateOnVertices', { inputs: { target, instance } }));
  const mesh = g.build();
  // A box has 24 vertices on 8 corners; unique corners get one instance each.
  assert.equal(mesh.positions.length / 3, 8 * 24);
  assert.equal(mesh.indices.length / 3, 8 * 12);
  near(bounds(mesh).hi[0], 0.55);
  const every = new GeometryGraph();
  const t2 = every.add('box'),
    i2 = every.add('box', { params: { width: 0.1, height: 0.1, depth: 0.1 } });
  every.setOutput(every.add('instantiateOnVertices', { inputs: { target: t2, instance: i2 }, params: { uniqueVertices: false, keepTarget: true } }));
  assert.equal(every.build().positions.length / 3, 24 + 24 * 24);
  // Scale and rotation are fields: scale each instance by its vertex index.
  const s = new GeometryGraph();
  const t3 = s.add('plane'),
    i3 = s.add('box', { params: { width: 1, height: 1, depth: 1 } });
  const idx = s.add('context', { params: { field: 'index' } });
  const scale = s.add('add', { inputs: { a: s.add('multiply', { inputs: { a: idx, b: 0.5 } }), b: 1 } });
  s.setOutput(s.add('instantiateOnVertices', { inputs: { target: t3, instance: i3, scale } }));
  const m = s.build();
  assert.equal(m.positions.length / 3, 4 * 24);
  near(bounds(m, 0, 24).hi[0] - bounds(m, 0, 24).lo[0], 1); // index 0 scales by 1
  near(bounds(m, 24, 48).hi[0] - bounds(m, 24, 48).lo[0], 1.5); // index 1 by 1.5
});

test('instantiateOnFaces sits on face centres, random points and aligns to the normal', () => {
  const plain = new GeometryGraph();
  const plane = plain.add('plane');
  plain.setOutput(plane);
  const target = plain.build();
  const g = new GeometryGraph();
  const t = g.add('plane'),
    inst = g.add('box', { params: { width: 0.1, height: 0.1, depth: 0.1 } });
  g.setOutput(g.add('instantiateOnFaces', { inputs: { target: t, instance: inst } }));
  const mesh = g.build();
  assert.equal(mesh.positions.length / 3, 2 * 24); // a plane has two triangles
  for (let f = 0; f < 2; f++) {
    const c = [0, 0, 0];
    for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) c[d] += target.positions[target.indices[f * 3 + k] * 3 + d] / 3;
    const m = mean(mesh, f * 24, f * 24 + 24);
    for (let d = 0; d < 3; d++) near(m[d], c[d], 1e-5);
  }
  const many = new GeometryGraph();
  many.setOutput(many.add('instantiateOnFaces', { inputs: { target: many.add('plane'), instance: many.add('box', { params: { width: 0.1, height: 0.1, depth: 0.1 } }) }, params: { perFace: 5, seed: 3 } }));
  const dense = many.build();
  assert.equal(dense.positions.length / 3, 10 * 24);
  assert.deepEqual([...dense.positions], [...many.build().positions]); // seeded
  assert.notDeepEqual([...dense.positions], [...many.build({ seed: 1 }).positions]);
  // alignToNormal turns a tall instance's +Y onto the face normal.
  const normalAxis = [...target.normals.slice(0, 3)].map(Math.abs).indexOf(1);
  const tall = (align) => {
    const a = new GeometryGraph();
    a.setOutput(a.add('instantiateOnFaces', { inputs: { target: a.add('plane'), instance: a.add('box', { params: { width: 0.1, height: 2, depth: 0.1 } }) }, params: { alignToNormal: align } }));
    const b = bounds(a.build(), 0, 24);
    return b.hi[normalAxis] - b.lo[normalAxis];
  };
  near(tall(true), 2, 1e-4);
  assert.ok(tall(false) < 2 || normalAxis === 1);
});

test('conditional takes one branch and never evaluates the other', () => {
  const make = (a) => {
    const g = new GeometryGraph();
    const cond = g.add('compare', { params: { op: '<' }, inputs: { a, b: 2 } });
    // The sphere has 16.7 million vertices: building it would pass the vertex limit.
    const huge = g.add('sphere', { params: { widthSegments: 4096, heightSegments: 4096 } });
    const box = g.add('box');
    g.setOutput(g.add('conditional', { inputs: { condition: cond, then: box, otherwise: huge } }));
    return g;
  };
  assert.equal(make(1).build().positions.length / 3, 24);
  assert.throws(() => make(3).build(), RangeError);
  // A conditional of values: pick a colour.
  const g = new GeometryGraph();
  const plane = g.add('plane');
  const c = g.add('conditional', { inputs: { condition: g.add('logic', { params: { op: 'not' }, inputs: { a: false } }), then: [1, 0, 0], otherwise: [0, 0, 1] } });
  g.setOutput(g.add('setColors', { inputs: { geometry: plane, colors: c } }));
  assert.deepEqual([...g.build().colors.slice(0, 4)], [1, 0, 0, 1]);
});

test('compare and logic follow the context: colour by height', () => {
  const g = new GeometryGraph();
  const box = g.add('box', { params: { widthSegments: 1, heightSegments: 2, depthSegments: 1 } });
  const y = g.add('swizzle', { params: { component: 'y' }, inputs: { value: g.add('context', { params: { field: 'position' } }) } });
  const high = g.add('compare', { params: { op: '>' }, inputs: { a: y, b: 0.1 } });
  const colour = g.add('conditional', { inputs: { condition: high, then: [1, 0, 0], otherwise: [0, 1, 0] } });
  g.setOutput(g.add('setColors', { inputs: { geometry: box, colors: colour } }));
  const mesh = g.build();
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const up = mesh.positions[i * 3 + 1] > 0.1;
    assert.deepEqual([...mesh.colors.slice(i * 4, i * 4 + 3)], up ? [1, 0, 0] : [0, 1, 0]);
  }
});

test('merge, setMaterialId and transform build grouped meshes', () => {
  const make = (first, second) => {
    const g = new GeometryGraph();
    const a = g.add('setMaterialId', { inputs: { geometry: g.add('box'), id: first } });
    const b = g.add('transform', { inputs: { geometry: g.add('setMaterialId', { inputs: { geometry: g.add('plane'), id: second } }), translation: [0, 5, 0], scale: 2 } });
    g.setOutput(g.add('merge', { inputs: { geometries: [a, b] } }));
    return g.build();
  };
  const m = make(3, 1);
  // 12 box triangles (id 3) and 2 plane triangles (id 1): sorted by id, plane first.
  assert.deepEqual(m.groups, [
    { start: 0, count: 6, materialIndex: 1 },
    { start: 6, count: 36, materialIndex: 3 },
  ]);
  assert.equal(m.positions.length / 3, 24 + 4);
  near(mean(m, 24, 28)[1], 5, 1e-6); // the plane moved up by 5
  near(bounds(m, 24, 28).hi[0] - bounds(m, 24, 28).lo[0], 2);
  // Everything material 0: no groups.
  const plain = new GeometryGraph();
  plain.setOutput(plain.add('merge', { inputs: { geometries: [plain.add('plane'), plain.add('plane')] } }));
  assert.equal(plain.build().groups, undefined);
  // Mirroring flips winding so faces keep facing out.
  const mirror = new GeometryGraph();
  mirror.setOutput(mirror.add('transform', { inputs: { geometry: mirror.add('plane'), scale: [-1, 1, 1] } }));
  const flipped = mirror.build(),
    original = (() => {
      const g = new GeometryGraph();
      g.setOutput(g.add('plane'));
      return g.build();
    })();
  assert.equal(flipped.indices[1], original.indices[2]);
});

test('input nodes read geometry passed in options', () => {
  const g = new GeometryGraph();
  g.setOutput(g.add('input', { params: { name: 'hull' } }));
  const hull = boxGeometry(2, 2, 2);
  assert.equal(g.build({ inputs: { hull } }).positions.length, hull.positions.length);
  assert.throws(() => g.build(), RangeError);
});

test('invalid graphs and runaway builds are refused', () => {
  const doc = (nodes, output = 'a') => ({ format: 'margo-geometry-graph', version: 1, nodes, output });
  assert.throws(() => parseGeometryGraph('not json'), TypeError);
  assert.throws(() => parseGeometryGraph({ format: 'x' }), TypeError);
  assert.throws(() => parseGeometryGraph({ format: 'margo-geometry-graph', version: 2, nodes: [], output: 'a' }), RangeError);
  assert.throws(() => parseGeometryGraph(doc([{ id: 'a', type: 'teapot' }])), RangeError);
  assert.throws(() => parseGeometryGraph(doc([{ id: 'a', type: 'box' }, { id: 'a', type: 'box' }])), RangeError);
  assert.throws(() => parseGeometryGraph(doc([{ id: 'a', type: 'box', params: { girth: 1 } }])), RangeError);
  assert.throws(() => parseGeometryGraph(doc([{ id: 'a', type: 'box', params: { width: -1 } }])), RangeError);
  assert.throws(() => parseGeometryGraph(doc([{ id: 'a', type: 'box', params: { widthSegments: 1.5 } }])), TypeError);
  assert.throws(() => parseGeometryGraph(doc([{ id: 'a', type: 'box', params: { widthSegments: 99999 } }])), RangeError);
  assert.throws(() => parseGeometryGraph(doc([{ id: 'a', type: 'box', inputs: { bogus: 1 } }])), RangeError);
  assert.throws(() => parseGeometryGraph(doc([{ id: 'a', type: 'transform', inputs: { geometry: { node: 'zzz' } } }])), RangeError);
  assert.throws(() => parseGeometryGraph(doc([{ id: 'a', type: 'transform', inputs: { geometry: 5 } }])), RangeError.prototype.constructor);
  assert.throws(
    () => parseGeometryGraph(doc([{ id: 'a', type: 'setColors', inputs: { geometry: { node: 'b' }, colors: 1 } }, { id: 'b', type: 'setColors', inputs: { geometry: { node: 'a' }, colors: 1 } }])),
    /cycle/,
  );
  assert.throws(() => parseGeometryGraph(doc([{ id: 'a', type: 'negate' }])), /not a geometry/);
  assert.throws(() => parseGeometryGraph(doc([{ id: 'b', type: 'box' }], 'a')), RangeError);
  assert.throws(() => parseGeometryGraph(doc([{ id: 'a', type: 'box' }]), { maxNodes: 0 }), RangeError);
  // A chain longer than maxDepth.
  const chain = [{ id: 'n0', type: 'negate' }];
  for (let i = 1; i < 300; i++) chain.push({ id: `n${i}`, type: 'negate', inputs: { value: { node: `n${i - 1}` } } });
  chain.push({ id: 'a', type: 'setColors', inputs: { geometry: { node: 'b' }, colors: { node: 'n299' } } }, { id: 'b', type: 'box' });
  assert.throws(() => parseGeometryGraph(doc(chain)), /deep/);
  // Limits while building.
  const big = new GeometryGraph();
  big.setOutput(big.add('sphere', { params: { widthSegments: 200, heightSegments: 200 } }));
  assert.throws(() => big.build({ maxVertices: 1000 }), RangeError);
  assert.throws(() => big.build({ maxTriangles: 10 }), RangeError);
  const boom = new GeometryGraph();
  boom.setOutput(boom.add('instantiateOnFaces', { inputs: { target: boom.add('plane', { params: { widthSegments: 100, heightSegments: 100 } }), instance: boom.add('sphere') }, params: { perFace: 4096 } }));
  assert.throws(() => boom.build({ maxVertices: 100000 }), RangeError); // refused before anything is copied
  const slow = new GeometryGraph();
  slow.setOutput(slow.add('setPositions', { inputs: { geometry: slow.add('sphere'), positions: slow.add('context') } }));
  assert.throws(() => slow.build({ maxEvaluations: 10 }), /evaluations/);
  assert.throws(() => slow.build({ signal: AbortSignal.abort() }), (e) => e.name === 'AbortError');
  assert.throws(() => slow.build({ maxVertices: -1 }), RangeError);
  // A geometry may not depend on the per-element context.
  const bad = new GeometryGraph();
  bad.setOutput(bad.add('setPositions', { inputs: { geometry: bad.add('setMaterialId', { inputs: { geometry: bad.add('box'), id: bad.add('context', { params: { field: 'index' } }) } }), positions: [0, 0, 0] } }));
  assert.throws(() => bad.build(), RangeError);
  // JSON that carries prototype-shaped keys is just unknown input.
  assert.throws(() => parseGeometryGraph(doc([{ id: 'a', type: 'box', params: JSON.parse('{"__proto__":1}') }])), RangeError);
});

test('a setter reads the context in its fields without making its geometry per-element', () => {
  // Regression: merging a displaced mesh (its field reads the context) with other geometry used to be refused.
  const g = new GeometryGraph();
  const moved = g.add('setPositions', {
    inputs: { geometry: g.add('plane'), positions: g.add('add', { inputs: { a: g.add('context'), b: [0, 1, 0] } }) },
  });
  g.setOutput(g.add('merge', { inputs: { geometries: [moved, g.add('box')] } }));
  assert.equal(g.build().positions.length / 3, 4 + 24);
});
