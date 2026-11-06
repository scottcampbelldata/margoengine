// autoLOD, hierarchicalLOD, LOD.fromModel and gltf-pro's MSFT_lod reading. Draw counts on a real GPU: auto-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '../../core/dist/extension.js';
import { LOD, normalMatrix } from '@margoengine/lod';
import { autoLOD, creased, hierarchicalLOD, simplifyAttributes } from '@margoengine/lod/auto';

const sphere = (segments) => {
  const positions = [],
    normals = [],
    indices = [];
  for (let y = 0; y <= segments; y++)
    for (let x = 0; x <= segments; x++) {
      const a = (x / segments) * Math.PI * 2,
        b = (y / segments) * Math.PI,
        p = [Math.cos(a) * Math.sin(b), Math.cos(b), Math.sin(a) * Math.sin(b)];
      positions.push(...p);
      normals.push(...p);
    }
  for (let y = 0; y < segments; y++)
    for (let x = 0; x < segments; x++) {
      const i = y * (segments + 1) + x,
        j = i + segments + 1;
      indices.push(i, i + 1, j, i + 1, j + 1, j);
    }
  return { positions, normals, indices };
};

test('creased keeps a hard edge and smooths a soft one', () => {
  // Two triangles meeting at a right angle along the edge 0-1.
  const vertices = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    hard = creased(vertices, [0, 1, 2, 1, 0, 3], 60),
    soft = creased(vertices, [0, 1, 2, 1, 0, 3], 120),
    normal = (g, i) => [g.vertices[i * 6 + 3], g.vertices[i * 6 + 4], g.vertices[i * 6 + 5]];
  assert.deepEqual(normal(hard, 0), [0, 0, 1]);
  assert.deepEqual(normal(hard, 3), [0, 1, 0]);
  const s = normal(soft, 0);
  assert.ok(Math.abs(s[1] - s[2]) < 1e-6 && s[1] > 0.7, `the shared corner bends: ${s}`);
});

test('LOD.fromModel maps screen coverage to levels and adds a hiding level', () => {
  const added = [],
    system = {
      add(anchor, levels, options) {
        added.push({ anchor, levels, options });
        return added.at(-1);
      },
    };
  const [a, b, c] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  LOD.fromModel(system, {
    lods: [
      { node: a, levels: [a, b, c], screenCoverage: [0.5, 0.2, 0.01] },
      { node: b, levels: [b, c] },
    ],
  });
  assert.deepEqual(
    added[0].levels.map((l) => [l.object?.id ?? null, l.screen]),
    [
      ['a', undefined],
      ['b', 0.5],
      ['c', 0.2],
      [null, 0.01],
    ],
  );
  assert.deepEqual(added[1].levels[1].screen, 0.25, 'the default without coverage');
  assert.equal(added[1].levels.length, 2);
});

test('autoLOD refuses a mesh with no geometry and honours an aborted signal', async () => {
  const mesh = { check() {}, geometry: undefined, id: 0 };
  await assert.rejects(autoLOD({}, mesh), TypeError);
  const signal = AbortSignal.abort(new Error('stop'));
  const withGeometry = { ...mesh, geometry: box(1, 1, 1) };
  await assert.rejects(autoLOD({}, withGeometry, { signal }), /stop/);
  await assert.rejects(autoLOD({}, withGeometry, { ratios: [0.5], screens: [0.1, 0.2] }), RangeError);
});

test('hierarchicalLOD validates its options and needs meshes', async () => {
  await assert.rejects(hierarchicalLOD({}, [], { cell: 0 }), RangeError);
  await assert.rejects(hierarchicalLOD({}, [], { cell: 1, ratio: 2 }), RangeError);
  await assert.rejects(hierarchicalLOD({}, [], { cell: 1 }), /at least one/);
});

test('a real sphere: autoLOD levels hold fewer triangles each', async () => {
  const { meshLODChain, polygonMeshFromTriangles } = await import('@margoengine/mesh-edit/modeling'),
    s = sphere(16),
    chain = meshLODChain(polygonMeshFromTriangles({ positions: s.positions, indices: s.indices }).mesh, {
      ratios: [0.5, 0.25],
    });
  assert.ok(chain[0].triangles.after < s.indices.length / 3);
  assert.ok(chain[1].triangles.after < chain[0].triangles.after);
});

/** A UV sphere as packed 20-float vertices: U repeats (past 1) so tiled textures are covered, with a seam at u = 0 and 1. */
const packedSphere = (segments, tile = 3) => {
  const vertices = [],
    indices = [];
  for (let y = 0; y <= segments; y++)
    for (let x = 0; x <= segments; x++) {
      const a = (x / segments) * Math.PI * 2,
        b = (y / segments) * Math.PI,
        p = [Math.cos(a) * Math.sin(b), Math.cos(b), Math.sin(a) * Math.sin(b)];
      vertices.push(...p, 1, ...p, 0, -Math.sin(a), 0, Math.cos(a), 1);
      vertices.push((x / segments) * tile, y / segments, y / segments, x / segments);
      vertices.push(x / segments, y / segments, 0.5, 1);
    }
  for (let y = 0; y < segments; y++)
    for (let x = 0; x < segments; x++) {
      const i = y * (segments + 1) + x,
        j = i + segments + 1;
      indices.push(i, i + 1, j, i + 1, j + 1, j);
    }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
};
const records = (g) => {
  const out = new Set();
  for (let o = 0; o < g.vertices.length; o += 20) out.add(g.vertices.subarray(o, o + 20).join());
  return out;
};
/** Edges by position that do not hold exactly two faces: on a closed surface, the count of cracks. */
const openEdges = (g) => {
  const at = (i) => [...g.vertices.subarray(i * 20, i * 20 + 3)].join(),
    edges = new Map();
  for (let t = 0; t < g.indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = at(g.indices[t + k]),
        b = at(g.indices[t + ((k + 1) % 3)]),
        key = a < b ? a + '|' + b : b + '|' + a;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  return [...edges.values()].filter((n) => n !== 2).length;
};

test('simplifyAttributes keeps each vertex as the source has it, tiled UVs included', async () => {
  const source = packedSphere(24),
    all = records(source),
    levels = await simplifyAttributes(source, [0.5, 0.25]);
  assert.equal(levels.length, 2);
  assert.ok(levels[0].indices.length < source.indices.length * 0.6, 'the first level holds about half');
  assert.ok(levels[1].indices.length < levels[0].indices.length * 0.6, 'the second about half of that');
  for (const level of levels) {
    for (const record of records(level)) assert.ok(all.has(record), 'a level adds no vertex of its own');
    assert.ok(Math.max(...level.indices) < level.vertices.length / 20);
  }
});

test('simplifyAttributes keeps UV seams closed', async () => {
  // Welded by position the sphere is closed: the seam at u = 0 and 1 must not open and the poles must not tear.
  const source = packedSphere(24),
    before = openEdges(source);
  for (const level of await simplifyAttributes(source, [0.5, 0.25]))
    assert.ok(openEdges(level) <= before, `no new open edges: ${openEdges(level)} of ${before}`);
});

test('simplifyAttributes keeps a hard edge whose corners share a position and a UV', async () => {
  // A folded sheet: two flat halves with one UV at each shared corner and different normals. Collapsing across the
  // fold would put one half's normal on the other.
  const n = 8,
    vertices = [],
    indices = [];
  const half = (up) => {
    const first = vertices.length / 20;
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const s = i / n,
          t = j / n;
        vertices.push(s, up ? t : 0, up ? 0 : t, 1, ...(up ? [0, 0, 1] : [0, 1, 0]), 0);
        vertices.push(1, 0, 0, 1, s, t, s, t, 1, 1, 1, 1);
      }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = first + j * (n + 1) + i,
          b = a + n + 1;
        if (up) indices.push(a, a + 1, b, a + 1, b + 1, b);
        else indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
  };
  half(false);
  half(true);
  const [level] = await simplifyAttributes(
    { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) },
    [0.25],
  );
  for (let t = 0; t < level.indices.length; t += 3) {
    const normals = new Set();
    for (let k = 0; k < 3; k++) {
      const o = level.indices[t + k] * 20;
      normals.add(level.vertices.subarray(o + 4, o + 7).join());
    }
    assert.equal(normals.size, 1, 'a triangle stays on its own side of the fold');
  }
});

test('simplifyAttributes takes a shell that is not manifold', async () => {
  // A third face on an edge, a coincident flipped copy and a face with no area: real files have all three.
  const source = packedSphere(12),
    extra = [...source.indices, source.indices[0], source.indices[1], source.indices[5]];
  for (let t = 0; t < source.indices.length; t += 3)
    extra.push(source.indices[t], source.indices[t + 2], source.indices[t + 1]);
  extra.push(0, 0, 1);
  const [level] = await simplifyAttributes({ vertices: source.vertices, indices: new Uint32Array(extra) }, [0.5]);
  assert.ok(level.indices.length && level.indices.length < extra.length);
});

test('simplifyAttributes honours an aborted signal and refuses bad ratios', async () => {
  const source = packedSphere(6),
    signal = AbortSignal.abort(new Error('stop'));
  await assert.rejects(simplifyAttributes(source, [0.5], { signal }), /stop/);
  await assert.rejects(simplifyAttributes(source, [0.5, 0.6]), RangeError);
});

test('autoLOD refuses skinned and morphed models', async () => {
  const model = {
    root: {},
    disposed: false,
    asset: { doc: { nodes: [{ skin: 0 }] } },
    primitives: [{ nodeIndex: 0, definition: { attributes: {} } }],
  };
  await assert.rejects(autoLOD({}, model), /without skins or morph targets/);
  model.asset.doc.nodes = [{}];
  model.primitives[0].definition.targets = [{}];
  await assert.rejects(autoLOD({}, model), /without skins or morph targets/);
  model.disposed = true;
  await assert.rejects(autoLOD({}, model), /live model/);
});

test('normalMatrix turns normals with the object, mirrored ones outward', () => {
  // Regression: an imposter's subassembly parts took the transpose, hierarchicalLOD's far meshes the plain matrix.
  const apply = ({ c }, [a, b, e]) => [0, 1, 2].map((r) => c[r] * a + c[3 + r] * b + c[6 + r] * e);
  const turned = normalMatrix(new Float32Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  assert.deepEqual(apply(turned, [1, 0, 0]), [0, 1, 0], 'a quarter turn about z carries +x to +y');
  assert.equal(turned.mirrored, false);
  const squashed = normalMatrix(new Float32Array([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])),
    slope = apply(squashed, [1, 1, 0]);
  assert.ok(slope[0] < slope[1], `a stretched slope flattens towards y, not x: ${slope}`);
  const mirror = normalMatrix(new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  assert.equal(mirror.mirrored, true);
  assert.deepEqual(apply(mirror, [1, 0, 0]).map(Math.round), [-1, 0, 0], 'the outward side stays outward');
});
