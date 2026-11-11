// autoLOD, hierarchicalLOD, LOD.fromModel and gltf-pro's MSFT_lod reading. Draw counts on a real GPU: auto-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { box } from '../../core/dist/extension.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { GLB_BIN, GLB_JSON, glbChunks } from '../../shared/glb.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { ImposterFrames, LOD, LODSystem, normalMatrix } from '@margoengine/lod';
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

const headless = async () =>
  new Engine({ width: 64, height: 64, clientWidth: 64, clientHeight: 64 }, await TransformStore.create(256), {
    backend: 'webgpu',
    gpu: optionalGPU().engine.gpu,
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
/** A file of two nodes sharing one sphere, a lone triangle on a second material, and a points primitive. */
const loadedModel = (engine, extra = {}) => {
  const { positions, normals, indices } = sphere(12),
    buffers = [],
    bufferViews = [],
    accessors = [],
    add = (data, type, componentType = 5126) => {
      bufferViews.push({ buffer: buffers.length, byteLength: data.byteLength });
      accessors.push({
        bufferView: buffers.length,
        componentType,
        count: data.length / { SCALAR: 1, VEC3: 3 }[type],
        type,
        ...(type === 'VEC3' ? { min: [-1, -1, -1], max: [1, 1, 1] } : {}),
      });
      buffers.push(data);
      return buffers.length - 1;
    },
    attributes = { POSITION: add(new Float32Array(positions), 'VEC3'), NORMAL: add(new Float32Array(normals), 'VEC3') },
    corner = add(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 'VEC3'),
    doc = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0, translation: [3, 0, 0] }, { mesh: 0 }],
      materials: [{ name: 'a' }, { name: 'b' }],
      meshes: [
        {
          primitives: [
            { attributes, indices: add(new Uint32Array(indices), 'SCALAR', 5125), material: 0 },
            { attributes: { POSITION: corner }, material: 1 },
            { attributes: { POSITION: corner }, material: 1, mode: 0 },
          ],
        },
      ],
      accessors,
      bufferViews,
      buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
      ...extra,
    };
  const model = new PBRModel(engine, new GLTFAsset(doc, buffers));
  engine.use(model);
  return model;
};

test('hierarchicalLOD refuses a model that deforms, and both refuse a disposed one', async () => {
  const model = {
      root: {},
      disposed: false,
      asset: { doc: { nodes: [{ skin: 0 }] } },
      primitives: [{ nodeIndex: 0, definition: { attributes: {} } }],
    },
    options = { cell: 1 };
  await assert.rejects(hierarchicalLOD({}, [model], options), /without skins or morph targets/);
  model.asset.doc.nodes = [{}];
  model.primitives[0].definition.targets = [{}];
  await assert.rejects(hierarchicalLOD({}, [model], options), /without skins or morph targets/);
  model.disposed = true;
  await assert.rejects(hierarchicalLOD({}, [model], options), /live model/);
  await assert.rejects(autoLOD({}, model), /live model/);
});

test('simplifyAttributes keeps vertices apart that deform apart, as a closed mouth has them', async () => {
  // Two sheets meeting along y = 0, each with its own row of vertices there at the same position and UV.
  const n = 12,
    vertices = [],
    indices = [],
    sheet = (from) => {
      const base = vertices.length / 20;
      for (let y = 0; y <= n; y++)
        for (let x = 0; x <= n; x++) {
          const v = new Array(20).fill(0);
          v[0] = x / n;
          v[1] = (from + y) / n;
          v[3] = v[6] = 1;
          v[12] = x / n;
          v[13] = (from + y + n) / (2 * n);
          v[16] = v[17] = v[18] = v[19] = 1;
          vertices.push(...v);
        }
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const a = base + y * (n + 1) + x,
            b = a + n + 1;
          indices.push(a, a + 1, b, a + 1, b + 1, b);
        }
      return vertices.length / 20;
    },
    lower = sheet(-n);
  sheet(0);
  const geometry = { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) },
    crossing = ({ indices: list, sources }) => {
      let count = 0;
      for (let t = 0; t < list.length; t += 3) {
        const sides = [0, 1, 2].map((k) => sources[list[t + k]] < lower);
        if (sides[0] !== sides[1] || sides[1] !== sides[2]) count++;
      }
      return count;
    },
    [welded] = await simplifyAttributes(geometry, [0.25]),
    [apart] = await simplifyAttributes(geometry, [0.25], { apart: (i) => (i < lower ? 'lower' : 'upper') });
  assert.ok(crossing(welded) > 0, 'without it the two rows weld, and a triangle spans both sheets');
  assert.equal(crossing(apart), 0, 'with it no triangle has corners of both');
  assert.ok(apart.indices.length < indices.length * 0.4, `it still simplifies: ${apart.indices.length / 3}`);
});

/** Fox.glb, a real skinned file, as a model of `engine`. */
const realFox = (engine, edit = () => {}) => {
  const chunks = glbChunks(new Uint8Array(readFileSync(new URL('../../../examples/assets/khronos/Fox/Fox.glb', import.meta.url)))),
    doc = JSON.parse(new TextDecoder().decode(chunks.find((c) => c.type === GLB_JSON).data)),
    bin = chunks.find((c) => c.type === GLB_BIN).data;
  doc.images = undefined;
  doc.textures = undefined;
  for (const material of doc.materials ?? []) material.pbrMetallicRoughness = {};
  const images = edit(doc) ?? [],
    model = new PBRModel(engine, new GLTFAsset(doc, [bin]), images);
  engine.use(model);
  return model;
};
/** Puts Fox's base colour on a third UV set, a copy of its first. */
const onThirdSet = (doc) => {
  doc.textures = [{ source: 0 }];
  doc.images = [{}];
  doc.materials[0].pbrMetallicRoughness = { baseColorTexture: { index: 0, texCoord: 2 } };
  const { attributes } = doc.meshes[0].primitives[0];
  attributes.TEXCOORD_1 = attributes.TEXCOORD_2 = attributes.TEXCOORD_0;
  return [{ width: 1, height: 1, close() {} }];
};
/** The same without its skin and clips: a still model. */
const stillOnThirdSet = (doc) => {
  const images = onThirdSet(doc),
    { attributes } = doc.meshes[0].primitives[0];
  delete attributes.JOINTS_0;
  delete attributes.WEIGHTS_0;
  delete doc.skins;
  delete doc.animations;
  for (const node of doc.nodes) delete node.skin;
  return images;
};

test('a flat-shaded mesh simplifies, a box stays a box, and each kept triangle takes its own normal', async () => {
  // A bumpy sheet as loose triangles, one normal each.
  const n = 16,
    height = (x, y) => Math.sin(x * 1.3) * Math.cos(y * 0.9) * 0.4,
    vertices = [],
    corner = (x, y, normal) => {
      vertices.push(x, y, height(x, y), 1, ...normal, 0, 1, 0, 0, 1, x / n, y / n, x / n, y / n, 1, 1, 1, 1);
    },
    triangle = (a, b, c) => {
      const p = [a, b, c].map(([x, y]) => [x, y, height(x, y)]),
        u = p[1].map((v, k) => v - p[0][k]),
        w = p[2].map((v, k) => v - p[0][k]),
        m = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]],
        size = Math.hypot(...m);
      for (const [x, y] of [a, b, c]) corner(x, y, m.map((v) => v / size));
    };
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      triangle([x, y], [x + 1, y], [x, y + 1]);
      triangle([x + 1, y], [x + 1, y + 1], [x, y + 1]);
    }
  const count = vertices.length / 20,
    [level] = await simplifyAttributes(
      { vertices: new Float32Array(vertices), indices: Uint32Array.from({ length: count }, (_, i) => i) },
      [0.25],
    );
  assert.ok(level.indices.length / 3 < (count / 3) * 0.3, `flat shading simplifies: ${level.indices.length / 3}`);
  for (let t = 0; t < level.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => level.vertices.subarray(level.indices[t + k] * 20, level.indices[t + k] * 20 + 3)),
      u = b.map((v, k) => v - a[k]),
      w = c.map((v, k) => v - a[k]),
      m = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]],
      size = Math.hypot(...m),
      normal = level.vertices.subarray(level.indices[t] * 20 + 4, level.indices[t] * 20 + 7);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(normal[k] - m[k] / size) < 1e-5, 'the normal of the triangle kept');
  }
  // Twelve loose triangles of a box: too few to lose any.
  const faces = [[0, 1, 2], [0, 2, 3]],
    boxVertices = [],
    sides = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const side of sides) {
    const axis = side.findIndex((v) => v),
      other = [(axis + 1) % 3, (axis + 2) % 3],
      quad = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
        const p = [...side];
        p[other[0]] = a * side[axis];
        p[other[1]] = b;
        return p;
      });
    for (const face of faces)
      for (const i of face) boxVertices.push(...quad[i], 1, ...side, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1);
  }
  const [box2] = await simplifyAttributes(
    { vertices: new Float32Array(boxVertices), indices: Uint32Array.from({ length: 36 }, (_, i) => i) },
    [0.5],
  );
  assert.equal(box2.indices.length, 36);
});

test('a real Fox: each level holds the skin of the vertices it kept, and follows the source', async () => {
  const engine = await headless();
  try {
    const system = LODSystem.attach(engine),
      model = realFox(engine),
      lod = await autoLOD(system, model, { ratios: [0.5, 0.25], screens: [0.5, 0.25] }),
      source = model.primitives[0],
      attributes = source.definition.attributes,
      records = new Map();
    // Flat shaded: a level's triangles take their own normals, so a vertex is known by the rest of it.
    const key = (v, o) => [...v.subarray(o, o + 4), ...v.subarray(o + 12, o + 20)].join();
    for (let o = 0; o < source.vertices.length; o += 20) records.set(key(source.vertices, o), o / 20);
    const joints = model.asset.accessor(attributes.JOINTS_0, 'VEC4'),
      weights = model.asset.accessor(attributes.WEIGHTS_0, 'VEC4');
    for (const { object: level } of lod.levels.slice(1)) {
      const [primitive] = level.primitives,
        kept = primitive.definition.attributes,
        ids = level.asset.accessor(kept.JOINTS_0, 'VEC4'),
        amounts = level.asset.accessor(kept.WEIGHTS_0, 'VEC4');
      assert.ok(primitive.indices.length < source.indices.length * 0.6);
      assert.equal(ids.length, (primitive.vertices.length / 20) * 4);
      for (let i = 0; i < ids.length / 4; i++) {
        const from = records.get(key(primitive.vertices, i * 20));
        assert.notEqual(from, undefined, 'a vertex of the source');
        assert.deepEqual([...ids.subarray(i * 4, i * 4 + 4)], [...joints.subarray(from * 4, from * 4 + 4)]);
        assert.deepEqual([...amounts.subarray(i * 4, i * 4 + 4)], [...weights.subarray(from * 4, from * 4 + 4)]);
      }
      assert.equal(primitive.weights, source.weights, 'morph weights are the source\'s own array');
      assert.ok(engine.plugins.has('animation:' + level.name), 'the level plays');
    }
    model.dispose();
    assert.equal(lod.levels[1].object.disposed, true, 'levels go with the model');
  } finally {
    engine.dispose();
  }
});

test('a level follows the animated nodes of the source, on show only', async () => {
  const engine = await headless(),
    system = LODSystem.attach(engine),
    model = loadedModel(engine, { animations: [{ channels: [], samplers: [] }] });
  engine.store.tick(false);
  const lod = await autoLOD(system, model, { ratios: [0.5], screens: [0.2] }),
    [, { object: level }] = lod.levels,
    plugin = engine.plugins.get([...engine.plugins.keys()].find((name) => name.startsWith('lod-nodes'))),
    x = () => engine.store.transforms.x[level.nodes[1].id];
  assert.ok(plugin, 'a file with animations follows');
  model.nodes[1].setPosition([5, 0, 0]);
  engine.camera.position = [0, 0, 4];
  system.update();
  assert.equal(lod.level, 0);
  plugin.onPreUpdate();
  assert.equal(x(), 0, 'not on show: nothing to copy');
  engine.camera.position = [0, 0, 500];
  system.update();
  assert.equal(lod.level, 1);
  plugin.onPreUpdate();
  assert.equal(x(), 5, 'on show, it stands where the source stands');
  model.dispose();
  assert.equal(engine.plugins.has(plugin.name), false, 'the follower goes with the model');
  engine.dispose();
});

test('autoLOD levels a loaded model: its nodes, materials and transforms, points left on level 0', async () => {
  const engine = await headless();
  try {
    const system = LODSystem.attach(engine),
      model = loadedModel(engine),
      triangles = (m) => m.primitives.reduce((n, p) => n + (p.topology ? 0 : p.indices.length / 3), 0),
      lod = await autoLOD(system, model, { ratios: [0.5, 0.25], screens: [0.5, 0.25] }),
      [, near, far] = lod.levels.map((l) => l.object);
    assert.equal(lod.anchor, model.root);
    assert.ok(triangles(near) < triangles(model) * 0.6 && triangles(far) < triangles(near));
    assert.equal(near.primitives.length, 4, 'two nodes of a sphere and a triangle, no points');
    assert.ok(near.primitives.every((p) => !p.topology));
    assert.equal(near.primitives[0].vertices, near.primitives[2].vertices, 'a shared primitive simplifies once');
    assert.deepEqual(
      near.primitives.map((p) => p.material),
      model.primitives.filter((p) => !p.topology).map((p) => p.material),
    );
    assert.equal(near.nodes[0].matrix[12], 3);
    assert.equal(near.root.visible, false);
    model.dispose();
    assert.equal(near.disposed, true, 'levels go with the model');
  } finally {
    engine.dispose();
  }
});

test('autoLOD simplifies a primitive split into parts as one surface, and its levels split and keep the material', async () => {
  const engine = await headless();
  try {
    const { positions, normals, indices } = sphere(64),
      data = [new Float32Array(positions), new Float32Array(normals), new Uint32Array(indices)],
      doc = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        materials: [{ name: 'scan' }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
        accessors: [
          { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] },
          { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
          { bufferView: 2, componentType: 5125, count: indices.length, type: 'SCALAR' },
        ],
        bufferViews: data.map((d, i) => ({ buffer: i, byteLength: d.byteLength })),
        buffers: data.map((d) => ({ byteLength: d.byteLength })),
      },
      asset = new GLTFAsset(doc, data);
    asset.partVertices = 1024;
    const model = new PBRModel(engine, asset);
    engine.use(model);
    assert.ok(model.primitives.length >= 5, `${model.primitives.length} parts`);
    const system = LODSystem.attach(engine),
      triangles = (m) => m.primitives.reduce((n, p) => n + p.indices.length / 3, 0),
      lod = await autoLOD(system, model, { ratios: [0.5], screens: [0.5] }),
      near = lod.levels[1].object;
    // One surface: about half the triangles of the whole, not half of each part with its cut edges kept.
    assert.ok(triangles(near) <= triangles(model) * 0.55 && triangles(near) >= triangles(model) * 0.4, `${triangles(near)}`);
    assert.ok(near.primitives.length >= 2, 'the level, still over 1,024 vertices, splits too');
    for (const p of near.primitives) {
      assert.ok(p.vertices.length / 20 <= 1024);
      assert.equal(p.material, model.primitives[0].material);
    }
    model.dispose();
  } finally {
    engine.dispose();
  }
});

/** A lumpy sphere with UVs in the unit square, as glTF: a detail a level loses, for `bake` to keep. */
const lumpy = (segments) => {
  const positions = [],
    normals = [],
    uvs = [],
    indices = [];
  for (let y = 0; y <= segments; y++)
    for (let x = 0; x <= segments; x++) {
      const a = (x / segments) * Math.PI * 2,
        b = 0.05 + (y / segments) * (Math.PI - 0.1),
        r = 1 + 0.04 * Math.sin(a * 9) * Math.sin(b * 9),
        p = [Math.cos(a) * Math.sin(b) * r, Math.cos(b) * r, Math.sin(a) * Math.sin(b) * r];
      positions.push(...p);
      uvs.push(x / segments, y / segments);
    }
  for (let y = 0; y < segments; y++)
    for (let x = 0; x < segments; x++) {
      const i = y * (segments + 1) + x,
        j = i + segments + 1;
      indices.push(i, j, i + 1, i + 1, j, j + 1);
    }
  // True normals of the lumps, so the detail is in the shading: a sum of the faces around each vertex.
  normals.length = positions.length;
  normals.fill(0);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => positions.slice(indices[t + k] * 3, indices[t + k] * 3 + 3)),
      u = b.map((v, k) => v - a[k]),
      w = c.map((v, k) => v - a[k]),
      n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (let k = 0; k < 3; k++) for (let e = 0; e < 3; e++) normals[indices[t + k] * 3 + e] += n[e];
  }
  for (let i = 0; i < normals.length; i += 3) {
    const size = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    for (let e = 0; e < 3; e++) normals[i + e] /= size;
  }
  return { positions, normals, uvs, indices };
};
/** One primitive of `lumpy`, its UVs scaled by `scale`, with `material` on it. */
const bakeModel = (engine, material = {}, scale = 1, extra = {}, images = []) => {
  const { positions, normals, uvs, indices } = lumpy(32),
    buffers = [],
    add = (data) => buffers.push(data) - 1,
    views = [],
    accessor = (data, type, componentType = 5126) => {
      views.push({ bufferView: add(data), componentType, count: data.length / { SCALAR: 1, VEC2: 2, VEC3: 3 }[type], type });
      return views.length - 1;
    },
    position = accessor(new Float32Array(positions), 'VEC3');
  views[position].min = [-2, -2, -2];
  views[position].max = [2, 2, 2];
  const doc = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      materials: [{ name: 'skin', ...material }],
      meshes: [
        {
          primitives: [
            {
              attributes: {
                POSITION: position,
                NORMAL: accessor(new Float32Array(normals), 'VEC3'),
                TEXCOORD_0: accessor(new Float32Array(uvs.map((v) => v * scale)), 'VEC2'),
              },
              indices: accessor(new Uint32Array(indices), 'SCALAR', 5125),
              material: 0,
            },
          ],
        },
      ],
      accessors: views,
      bufferViews: buffers.map((b, i) => ({ buffer: i, byteLength: b.byteLength })),
      buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
      ...extra,
    },
    model = new PBRModel(engine, new GLTFAsset(doc, buffers), images);
  engine.use(model);
  return model;
};

test('bake gives a loaded model\'s levels their own normal map, halved a level, and leaves the source as it was', async () => {
  const engine = await headless();
  try {
    const system = LODSystem.attach(engine),
      model = bakeModel(engine),
      lod = await autoLOD(system, model, { ratios: [0.5, 0.25], screens: [0.5, 0.25], bake: { size: 64 } }),
      [, near, far] = lod.levels.map((l) => l.object),
      map = (level) => level.primitives[0].material.maps[2];
    assert.equal(model.primitives[0].material.maps[2], undefined, 'the source draws as it did');
    assert.equal(model.asset.doc.textures, undefined, 'the source document is unchanged');
    for (const [level, size] of [[near, 64], [far, 32]]) {
      const { index } = map(level),
        image = level.image(level.asset.doc.textures[index].source);
      assert.equal(image.width, size);
      assert.equal(image.format, 'rgba8unorm');
      assert.equal(image.mipmaps.length, Math.log2(size) + 1, 'every mip, for a far level');
      assert.equal(image.mipmaps.at(-1).data.length, 4);
    }
    // The detail the level lost is in the map: it leans all over, and leans more where more was lost.
    const lean = (level) => {
      const { data } = level.image(level.asset.doc.textures[map(level).index].source).mipmaps[0];
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += Math.hypot(data[i] - 128, data[i + 1] - 128);
      return sum / (data.length / 4);
    };
    assert.ok(lean(near) > 4 && lean(far) > lean(near), `${lean(near)} then ${lean(far)}`);
    model.dispose();
    assert.equal(near.disposed, true);
  } finally {
    engine.dispose();
  }
});

test('a real Fox bakes as a rigged model: its levels keep the skin and take the map', async () => {
  const engine = await headless();
  try {
    const model = realFox(engine),
      lod = await autoLOD(LODSystem.attach(engine), model, { ratios: [0.5], screens: [0.5], bake: { size: 64 } }),
      [level] = lod.levels.slice(1).map((l) => l.object),
      { material } = level.primitives[0],
      { index } = material.maps[2];
    assert.ok(level.asset.doc.meshes[0].primitives[0].attributes.JOINTS_0 !== undefined, 'the skin stays');
    assert.equal(level.image(level.asset.doc.textures[index].source).width, 64);
    assert.equal(material.base, model.primitives[0].material.base, 'the base colour is the same array, so an edit reaches it');
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('bake keeps a map the source has of its own, and adds occlusion when asked', async () => {
  const engine = await headless();
  try {
    const system = LODSystem.attach(engine),
      pixel = { width: 1, height: 1, format: 'rgba8unorm', mipmaps: [{ data: new Uint8Array(4), width: 1, height: 1 }] },
      model = bakeModel(
        engine,
        { normalTexture: { index: 0 } },
        1,
        { textures: [{ source: 0 }], images: [{ mimeType: 'image/png' }] },
        [pixel],
      );
    const lod = await autoLOD(system, model, {
        ratios: [0.5],
        screens: [0.5],
        bake: { size: 32, maps: ['normal', 'ao'] },
      }),
      { maps } = lod.levels[1].object.primitives[0].material;
    assert.equal(maps[2].index, 0, 'the source\'s own normal map stays');
    assert.ok(maps[3].index >= 1, 'occlusion is baked');
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('bake leaves a tiled primitive alone: the map would have no texel for most of it', async () => {
  const engine = await headless();
  try {
    const model = bakeModel(engine, {}, 4),
      lod = await autoLOD(LODSystem.attach(engine), model, { ratios: [0.5], screens: [0.5], bake: true });
    assert.equal(lod.levels[1].object.primitives[0].material, model.primitives[0].material);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('bake refuses what it cannot do: a core mesh has no UVs, and maps are named', async () => {
  const engine = await headless();
  try {
    const system = LODSystem.attach(engine),
      mesh = engine.createMesh().setGeometry(box(1, 1, 1));
    await assert.rejects(autoLOD(system, mesh, { bake: true }), TypeError);
    await assert.rejects(autoLOD(system, mesh, { bake: { maps: ['color'] } }), TypeError);
    const model = bakeModel(engine),
      stop = new AbortController();
    stop.abort(new Error('stopped'));
    await assert.rejects(autoLOD(system, model, { bake: true, signal: stop.signal }), /stopped/);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

// Later UV sets ride in a buffer of their own, so whatever keeps some vertices has to keep the same rows of it.
test('a level keeps TEXCOORD_2 on the vertices it kept, skinned or still, and a far mesh on those it merged', async () => {
  const engine = await headless();
  try {
    engine.renderer.gpu.queue.copyExternalImageToTexture = () => {}; // the stand-in image holds no pixels
    const system = LODSystem.attach(engine),
      rows = (p) => p.uvs.length / 4,
      check = (source, level) => {
        assert.equal(rows(level), level.vertices.length / 20, 'a row for each vertex');
        for (let i = 0; i < rows(level); i++) {
          // The third set is a copy of the first, so each row of a level has to equal its own vertex's first set.
          assert.equal(level.uvs[i * 4], level.vertices[i * 20 + 12], `u of row ${i}`);
          assert.equal(level.uvs[i * 4 + 1], level.vertices[i * 20 + 13], `v of row ${i}`);
        }
      },
      fox = realFox(engine, onThirdSet),
      rigged = await autoLOD(system, fox, { ratios: [0.5], screens: [0.5] }),
      level = rigged.levels[1].object.primitives[0];
    assert.notEqual(level.definition.attributes.TEXCOORD_2, undefined);
    assert.ok(level.vertices.length < fox.primitives[0].vertices.length);
    check(fox.primitives[0], level);
    const still = realFox(engine, stillOnThirdSet),
      plain = await autoLOD(system, still, { ratios: [0.5], screens: [0.5] }),
      kept = plain.levels[1].object.primitives[0];
    assert.ok(kept.vertices.length < still.primitives[0].vertices.length);
    check(still.primitives[0], kept);
    engine.store.tick(false);
    const used = [],
      use = engine.use.bind(engine);
    engine.use = (plugin) => (used.push(plugin), use(plugin));
    await hierarchicalLOD(system, [realFox(engine, stillOnThirdSet)], { cell: 1000 });
    check(still.primitives[0], used.at(-1).primitives[0]);
  } finally {
    engine.dispose();
  }
});

test('ImposterFrames refuses too few frames and a bad fps or pose', () => {
  assert.throws(() => new ImposterFrames([]), RangeError);
  assert.throws(() => ImposterFrames.bake({}, {}, { count: 1, pose() {} }), RangeError);
  assert.throws(() => ImposterFrames.bake({}, {}, { count: 2 }), TypeError);
});

test('setTransition takes switches after the first frame, one at a time, and hands them back', async () => {
  const engine = await headless();
  try {
    const system = LODSystem.attach(engine),
      a = engine.createMesh(),
      b = engine.createMesh(),
      lod = system.add(engine.createMesh(), [{ object: a }, { object: b, distance: 10 }], { radius: 1 }),
      seen = [];
    let take = true;
    const remove = system.setTransition((handle, from, to) => (seen.push([handle, from, to]), take));
    assert.throws(() => system.setTransition(() => false), { code: 'state' });
    engine.camera.position = [0, 0, 1];
    system.update();
    assert.deepEqual(seen, [], 'the first pick shows the level at once');
    assert.equal(a.visible, true);
    engine.camera.position = [0, 0, 50];
    system.update();
    assert.deepEqual(seen, [[lod, 0, 1]]);
    assert.equal(lod.level, 1);
    assert.equal(a.visible, true, 'a transition that takes a switch shows the levels itself');
    take = false;
    engine.camera.position = [0, 0, 1];
    system.update();
    assert.equal(b.visible, false, 'a refused switch is instant');
    remove();
    system.setTransition(() => false)();
  } finally {
    engine.dispose();
  }
});

test('hierarchicalLOD merges loaded models into one model per cell and file, a primitive per material', async () => {
  const engine = await headless();
  try {
    const system = LODSystem.attach(engine),
      model = loadedModel(engine);
    engine.store.tick(false);
    const built = await hierarchicalLOD(system, [model], { cell: 1000 }),
      far = built.lods[0].levels[1].object;
    assert.equal(built.meshes.length, 1);
    assert.equal(built.lods[0].anchor, built.meshes[0]);
    assert.ok(far.visible === false);
    built.remove();
    assert.equal(model.root.visible, true);
  } finally {
    engine.dispose();
  }
});

test('update rebuilds a far mesh whose sources moved, and only those', async () => {
  const engine = await headless(),
    system = LODSystem.attach(engine),
    a = engine.createMesh().setGeometry(box(1, 1, 1)),
    b = engine.createMesh().setGeometry(box(1, 1, 1)).setPosition([100, 0, 0]);
  engine.store.tick(false);
  const built = await hierarchicalLOD(system, [a, b], { cell: 50 }),
    far = built.meshes[0],
    x = () => Math.max(...far.geometry.vertices.filter((_, i) => i % 6 === 0));
  assert.equal(built.update(), 0, 'nothing moved');
  const before = x();
  a.setPosition([3, 0, 0]);
  engine.store.tick(false);
  assert.equal(built.update(), 1);
  assert.ok(Math.abs(x() - before - 3) < 1e-5, 'the far mesh went with it');
  assert.equal(built.update(), 0);
  built.remove();
  assert.equal(built.update(), 0);
  engine.dispose();
});

test('update reaches the far model of a loaded model, and follow rebuilds a far mesh on show', async () => {
  const engine = await headless(),
    system = LODSystem.attach(engine),
    model = loadedModel(engine);
  engine.store.tick(false);
  const built = await hierarchicalLOD(system, [model], { cell: 1000, distance: 10, follow: true }),
    [lod] = built.lods,
    far = lod.levels[1].object,
    primitive = () => built.meshes[0],
    plugin = [...engine.plugins.keys()].find((name) => name.startsWith('lod-follow')),
    farModel = [...engine.plugins.values()].find((p) => p.root === primitive()),
    x = () => Math.max(...farModel.primitives[0].vertices.filter((_, i) => i % 20 === 0));
  assert.ok(far && plugin);
  const before = x();
  model.nodes[0].setPosition([9, 0, 0]);
  engine.store.tick(false);
  engine.plugins.get(plugin).onPreUpdate();
  assert.equal(x(), before, 'near by, the sources show: nothing to rebuild yet');
  engine.camera.position = [0, 0, 100];
  system.update();
  engine.plugins.get(plugin).onPreUpdate();
  assert.ok(Math.abs(x() - before - 6) < 1e-4, 'the far model follows');
  built.remove();
  assert.equal(engine.plugins.has(plugin), false);
  engine.dispose();
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
