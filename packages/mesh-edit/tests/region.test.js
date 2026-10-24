import assert from 'node:assert/strict';
import test from 'node:test';
import * as engine from '../dist/index.js';
const ids = () => {
  let n = 0;
  return { createId: () => `wall-${++n}` };
};
function grid(width = 2, height = 1) {
  const vertices = [],
    faces = [];
  for (let z = 0; z <= height; z++) for (let x = 0; x <= width; x++) vertices.push([x, 0, z]);
  for (let z = 0; z < height; z++)
    for (let x = 0; x < width; x++) {
      const a = z * (width + 1) + x;
      faces.push({
        id: `f-${x}-${z}`,
        vertices: [a, a + width + 1, a + width + 2, a + 1],
        uv: [
          [0.1 + x * 0.1, 0.1 + z * 0.1],
          [0.1 + x * 0.1, 0.2 + z * 0.1],
          [0.2 + x * 0.1, 0.2 + z * 0.1],
          [0.2 + x * 0.1, 0.1 + z * 0.1],
        ],
      });
    }
  return { vertices, faces };
}
function edges(mesh) {
  const result = new Map();
  for (const face of mesh.faces)
    face.vertices.forEach((a, i) => {
      const b = face.vertices[(i + 1) % face.vertices.length],
        id = [Math.min(a, b), Math.max(a, b)].join(':');
      if (!result.has(id)) result.set(id, []);
      result.get(id).push([a, b]);
    });
  return result;
}
function closedTopGrid() {
  const mesh = grid(2, 2),
    loop = [0, 3, 6, 7, 8, 5, 2, 1],
    bottom = loop.map((i) => {
      mesh.vertices.push([mesh.vertices[i][0], -1, mesh.vertices[i][2]]);
      return mesh.vertices.length - 1;
    });
  for (let i = 0; i < loop.length; i++) {
    const j = (i + 1) % loop.length;
    mesh.faces.push({
      id: `side-${i}`,
      vertices: [loop[j], loop[i], bottom[i], bottom[j]],
      uv: [
        [0.7, 0.7],
        [0.8, 0.7],
        [0.8, 0.8],
        [0.7, 0.8],
      ],
    });
  }
  mesh.faces.push({ id: 'bottom', vertices: [...bottom].reverse(), uv: bottom.map((_, i) => [0.3 + i * 0.01, 0.6]) });
  return mesh;
}
const run = (mesh, faces, distance = 0.25, options = ids()) => engine.extrudeMeshRegion(mesh, faces, distance, options);

test('region extrusion shares cap vertices and creates only the six boundary walls of two joined quads', () => {
  const mesh = grid(),
    before = structuredClone(mesh),
    out = run(mesh, ['f-1-0', 'f-0-0', 'f-1-0']);
  assert.equal(out.changed, true);
  assert.equal(out.mesh.vertices.length, 12);
  assert.equal(out.mesh.faces.length, 8);
  assert.equal(out.sideFaces.length, 6);
  assert.equal(out.createdVertices.length, 6);
  assert.deepEqual(out.capFaces, ['f-0-0', 'f-1-0']);
  assert.equal(out.regions.length, 1);
  assert.deepEqual(out.regions[0].offset, [0, 0.25, 0]);
  assert.equal(
    out.sideFaces.some((f) => f.sourceEdgeId === '1:4'),
    false,
  );
  const [a, b] = out.mesh.faces;
  assert.equal(a.vertices[2], b.vertices[1]);
  assert.equal(a.vertices[3], b.vertices[0]);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(out.mesh.faces[i].uv, mesh.faces[i].uv);
    assert.deepEqual(
      out.mesh.faces[i].vertices.map((v) => out.mesh.vertices[v]),
      mesh.faces[i].vertices.map((v) => [mesh.vertices[v][0], 0.25, mesh.vertices[v][2]]),
    );
  }
  assert.deepEqual(mesh, before);
  assert.equal([...edges(out.mesh).values()].filter((e) => e.length === 1).length, 6);
});

test('closed multi-face cap remains closed and removes only the now-unused interior vertex', () => {
  const mesh = closedTopGrid(),
    out = run(
      mesh,
      mesh.faces.slice(0, 4).map((f) => f.id),
    );
  for (const incidence of edges(mesh).values()) {
    assert.equal(incidence.length, 2);
    assert.deepEqual(incidence[0], [...incidence[1]].reverse());
  }
  assert.equal(out.mesh.vertices.length, 25);
  assert.equal(out.createdVertices.length, 9);
  assert.deepEqual(out.removedVertices, [4]);
  assert.equal(out.sideFaces.length, 8);
  for (const incidence of edges(out.mesh).values()) {
    assert.equal(incidence.length, 2);
    assert.deepEqual(incidence[0], [...incidence[1]].reverse());
  }
  const used = new Set(out.mesh.faces.flatMap((f) => f.vertices));
  assert.equal(used.size, out.mesh.vertices.length);
  for (const face of mesh.faces.slice(4)) {
    const next = out.mesh.faces.find((f) => f.id === face.id);
    assert.deepEqual(next.uv, face.uv);
    assert.deepEqual(
      next.vertices.map((i) => out.mesh.vertices[i]),
      face.vertices.map((i) => mesh.vertices[i]),
    );
  }
});

test('a region with an inner boundary adds inner and outer walls without closing the hole', () => {
  const mesh = grid(3, 3),
    selected = mesh.faces.filter((f) => f.id !== 'f-1-1').map((f) => f.id),
    out = run(mesh, selected);
  assert.equal(out.regions.length, 1);
  assert.equal(out.sideFaces.length, 16);
  assert.equal(out.mesh.faces.length, 25);
  assert.deepEqual(
    out.mesh.faces.find((f) => f.id === 'f-1-1'),
    mesh.faces.find((f) => f.id === 'f-1-1'),
  );
  assert.equal([...edges(out.mesh).values()].filter((e) => e.length === 1).length, 12);
});

test('disconnected components and point contacts retain separate caps and local directions', () => {
  const mesh = grid(2, 2),
    out = run(mesh, ['f-0-0', 'f-1-1']);
  assert.equal(out.regions.length, 2);
  assert.equal(out.sideFaces.length, 8);
  assert.equal(out.vertexMap[4].length, 3);
  const caps = out.mesh.faces.filter((f) => out.capFaces.includes(f.id));
  assert.equal(
    caps[0].vertices.some((i) => caps[1].vertices.includes(i)),
    false,
  );
});

test('explicit local direction and inward distances preserve all cap corner UVs', () => {
  const mesh = grid(),
    out = run(mesh, ['f-0-0', 'f-1-0'], -0.5, { ...ids(), direction: [1, 2, 0] });
  assert(Math.abs(out.regions[0].offset[0] + 0.5 / Math.sqrt(5)) < 1e-15);
  assert(Math.abs(out.regions[0].offset[1] + 1 / Math.sqrt(5)) < 1e-15);
  for (let i = 0; i < 2; i++) assert.deepEqual(out.mesh.faces[i].uv, mesh.faces[i].uv);
});

test('zero and empty commands own their results without generating any IDs or new topology', () => {
  const mesh = grid();
  const options = {
    createId: () => {
      throw Error('must not allocate');
    },
  };
  for (const out of [run(mesh, [], 0.5, options), run(mesh, ['f-0-0'], 0, options)]) {
    assert.equal(out.changed, false);
    assert.deepEqual(out.mesh, mesh);
    assert.deepEqual(out.createdFaces, []);
    out.mesh.vertices[0][0] = 99;
    assert.equal(mesh.vertices[0][0], 0);
  }
});

test('retained/source-to-cap vertex and edge mappings follow compaction without guessing numeric identities', () => {
  const mesh = closedTopGrid(),
    out = run(
      mesh,
      mesh.faces.slice(0, 4).map((f) => f.id),
    );
  for (let i = 0; i < mesh.vertices.length; i++) {
    assert(out.vertexMap[i].length);
    for (const index of out.vertexMap[i]) assert(index >= 0 && index < out.mesh.vertices.length);
  }
  const outputEdges = edges(out.mesh);
  for (const list of Object.values(out.edgeMap)) for (const id of list) assert(outputEdges.has(id));
  const centerCap = out.vertexMap[4][0];
  assert.deepEqual(out.mesh.vertices[centerCap], [1, 0.25, 1]);
  assert.equal(out.edgeMap['1:4'].length, 1);
  assert.equal(out.edgeMap['0:1'].length, 2);
  assert.equal(out.createdEdges.length, 20);
  assert.equal(out.removedEdges.length, 4);
  assert.deepEqual(out.faceMap['f-0-0'], [
    'f-0-0',
    ...out.sideFaces.filter((f) => f.sourceFaceId === 'f-0-0').map((f) => f.faceId),
  ]);
});

test('nonmanifold and inconsistently wound incident edges reject atomically', () => {
  for (const mode of ['duplicate', 'winding']) {
    const mesh = grid();
    if (mode === 'duplicate') mesh.faces.push({ ...structuredClone(mesh.faces[0]), id: 'duplicate' });
    else {
      mesh.faces[1].vertices.reverse();
      mesh.faces[1].uv.reverse();
    }
    const before = structuredClone(mesh);
    assert.throws(() => run(mesh, ['f-0-0']));
    assert.deepEqual(mesh, before);
  }
});

test('a closed complete selection and a tangent collapsed wall reject with repair guidance', () => {
  const cube = engine.createPrimitiveMesh('cube', 'cube');
  assert.throws(
    () =>
      run(
        cube,
        cube.faces.map((f) => f.id),
      ),
    /boundary/i,
  );
  assert.throws(() => run(grid(), ['f-0-0'], 0.5, { ...ids(), direction: [1, 0, 0] }));
});

test('area-weighted normal supports folded regions, reversed winding and far-offset coordinates', () => {
  const mesh = {
    vertices: [
      [0, 0, 0],
      [0, 0, 1],
      [2, 0, 1],
      [2, 0, 0],
      [2, -1, 1],
      [2, -1, 0],
    ],
    faces: [
      {
        id: 'top',
        vertices: [0, 1, 2, 3],
        uv: [
          [0.1, 0.1],
          [0.1, 0.2],
          [0.3, 0.2],
          [0.3, 0.1],
        ],
      },
      {
        id: 'side',
        vertices: [3, 2, 4, 5],
        uv: [
          [0.4, 0.1],
          [0.4, 0.2],
          [0.5, 0.2],
          [0.5, 0.1],
        ],
      },
    ],
  };
  const first = run(mesh, ['side', 'top'], 0.5);
  assert.equal(first.sideFaces.length, 6);
  assert(Math.abs(first.regions[0].offset[0] - 0.5 / Math.sqrt(5)) < 1e-15);
  assert(Math.abs(first.regions[0].offset[1] - 1 / Math.sqrt(5)) < 1e-15);
  const far = structuredClone(mesh);
  far.vertices = far.vertices.map((p) => p.map((v, a) => v + [1e8, -2e8, 3e8][a]));
  assert.deepEqual(run(far, ['top', 'side'], 0.5).regions[0].offset, first.regions[0].offset);
  const reversed = grid();
  for (const face of reversed.faces) {
    face.vertices.reverse();
    face.uv.reverse();
  }
  assert.deepEqual(
    run(
      reversed,
      reversed.faces.map((f) => f.id),
    ).regions[0].offset,
    [0, -0.25, 0],
  );
});

test('preexisting loose vertices and arbitrary source identities are retained while edit interiors compact', () => {
  const mesh = closedTopGrid();
  mesh.vertices.push([99, 88, 77]);
  mesh.faces[0].id = '__proto__';
  const out = run(
    mesh,
    mesh.faces.slice(0, 4).map((f) => f.id),
  );
  assert.deepEqual(out.mesh.vertices[out.vertexMap[17][0]], [99, 88, 77]);
  assert.deepEqual(out.removedVertices, [4]);
  assert(Object.hasOwn(out.faceMap, '__proto__'));
  assert(out.faceMap.__proto__.includes('__proto__'));
});

test('mirrored nonuniform geometry keeps coherent closed incidence and finite huge directions normalize safely', () => {
  const mesh = closedTopGrid();
  mesh.vertices = mesh.vertices.map(([x, y, z]) => [-2 * x, 3 * y, 0.5 * z]);
  const out = run(
    mesh,
    mesh.faces.slice(0, 4).map((f) => f.id),
  );
  assert.deepEqual(out.regions[0].offset, [0, -0.25, 0]);
  for (const list of edges(out.mesh).values()) assert.equal(list.length, 2);
  const huge = run(grid(), ['f-0-0'], 0.1, { ...ids(), direction: [1e308, 1e308, 1e308] });
  assert(huge.regions[0].offset.every(Number.isFinite));
  assert(Math.abs(huge.regions[0].offset[0] - 0.1 / Math.sqrt(3)) < 1e-15);
});

test('invalid command values and face generators reject without changing the input', () => {
  const mesh = grid(),
    before = structuredClone(mesh);
  for (const [faces, distance, options] of [
    [null, 0.2, {}],
    [['missing'], 0.2, {}],
    [['f-0-0'], NaN, {}],
    [['f-0-0'], Infinity, {}],
    [['f-0-0'], 0.2, null],
    [['f-0-0'], 0.2, { direction: [0, 0, 0] }],
    [['f-0-0'], 0.2, { direction: [1, NaN, 0] }],
    [['f-0-0'], 0.2, { direction: [1, 0] }],
    [['f-0-0'], 0.2, { createId: () => 'f-0-0' }],
    [['f-0-0'], 0.2, { createId: () => 'same' }],
  ]) {
    assert.throws(() => run(mesh, faces, distance, options));
    assert.deepEqual(mesh, before);
  }
});
