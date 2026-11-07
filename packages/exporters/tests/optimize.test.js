// optimizeGLB: nothing a viewer shows changes unless `simplify` or `lods` asks for it, every level keeps a subset of the
// source's vertices, and the Khronos validator reads every result. The real models are by hand (claims.md, reproduce.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportGLB, joinGLB, readAccessor, splitGLB } from '@margoengine/exporters';
import { encodePNG } from '@margoengine/exporters/capture';
import { compressDraco } from '@margoengine/exporters/draco';
import { compressMeshopt } from '@margoengine/exporters/meshopt';
import { optimizeGLB, weldVertices } from '@margoengine/exporters/optimize';
import { validate } from './helpers.js';

const file = (path) => new Uint8Array(readFileSync(new URL(path, import.meta.url)));

/** A flat grid of `n` x `n` cells, every cell with its own four vertices, so welding has work to do. */
function grid(n) {
  const positions = [],
    normals = [],
    uvs = [],
    indices = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const at = positions.length / 3;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]) {
        const px = x + dx,
          py = y + dy;
        positions.push(px, py, Math.sin(px * 0.7) * Math.cos(py * 0.5));
        normals.push(0, 0, 1);
        uvs.push(px / n, py / n);
      }
      indices.push(at, at + 1, at + 2, at, at + 2, at + 3);
    }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

/** One row of text for each triangle corner: every attribute of the vertex, sorted, so numbering does not matter. */
function corners(parts, primitive) {
  const read = (name) => readAccessor(parts, primitive.attributes[name]),
    names = Object.keys(primitive.attributes).sort(),
    columns = names.map(read),
    indices = readAccessor(parts, primitive.indices).values,
    rows = [];
  for (let t = 0; t < indices.length; t += 3)
    rows.push(
      [0, 1, 2]
        .map((k) =>
          columns
            .map(({ values, width }) =>
              [...values.subarray(indices[t + k] * width, (indices[t + k] + 1) * width)].join(),
            )
            .join(' '),
        )
        .sort()
        .join(' | '),
    );
  return rows.sort();
}

const clean = async (glb) => {
  const report = await validate(glb);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
  assert.equal(report.warnings, 0, JSON.stringify(report.messages));
};

test('welding merges equal vertices and every triangle stays what it was', async () => {
  const source = exportGLB({ nodes: [{ geometry: grid(6) }] }),
    { glb, stats } = await optimizeGLB(source),
    before = splitGLB(source),
    after = splitGLB(glb),
    primitive = after.json.meshes[0].primitives[0];
  assert.equal(stats.verticesBefore, 6 * 6 * 4);
  assert.equal(stats.verticesAfter, 7 * 7);
  assert.equal(stats.trianglesAfter, stats.trianglesBefore);
  assert.equal(readAccessor(after, primitive.attributes.POSITION).count, 7 * 7);
  assert.deepEqual(corners(after, primitive), corners(before, before.json.meshes[0].primitives[0]));
  assert.ok(glb.length < source.length);
  await clean(glb);
});

test('vertices that differ in anything stay apart', async () => {
  const hard = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 3, 5, 4]),
    },
    { stats } = await optimizeGLB(exportGLB({ nodes: [{ geometry: hard }] }));
  assert.equal(stats.verticesAfter, 6);
});

test('weldVertices treats zero and minus zero as equal and drops what welds to a line', () => {
  const values = new Float32Array([0, 0, 0, -0, 0, 0, 1, 0, 0, 0, 1, 0]),
    { keep, indices } = weldVertices([{ values, width: 3 }], [0, 2, 3, 1, 0, 2, 1, 3, 2], 4);
  assert.deepEqual(keep, [0, 2, 3]);
  assert.deepEqual([...indices], [0, 1, 2, 0, 2, 1]);
});

test('with welding off, vertices stay apart', async () => {
  const { stats } = await optimizeGLB(exportGLB({ nodes: [{ geometry: grid(3) }] }), { weld: false });
  assert.equal(stats.verticesAfter, 3 * 3 * 4);
});

test('a primitive with no indices gains them', async () => {
  const { positions, normals, uvs, indices } = grid(3),
    flat = (values, size) =>
      Float32Array.from([...indices].flatMap((i) => [...values.subarray(i * size, (i + 1) * size)])),
    { glb, stats } = await optimizeGLB(
      exportGLB({
        nodes: [{ geometry: { positions: flat(positions, 3), normals: flat(normals, 3), uvs: flat(uvs, 2) } }],
      }),
    );
  assert.equal(stats.verticesAfter, 16);
  await clean(glb);
});

test('identical images, textures, materials and meshes merge, and different ones stay', async () => {
  const png = () => encodePNG({ width: 2, height: 2, data: new Uint8Array(16).fill(90) }),
    [one, two] = [await png(), await png()],
    other = await encodePNG({ width: 2, height: 2, data: new Uint8Array(16).fill(160) }),
    material = (image, color = [1, 1, 1, 1]) => ({ color, baseColorTexture: { image, mimeType: 'image/png' } }),
    source = exportGLB({
      nodes: [
        { geometry: grid(2), material: material(one) },
        { translation: [3, 0, 0], geometry: grid(2), material: material(two) },
        { translation: [6, 0, 0], geometry: grid(2), material: material(other) },
        { translation: [9, 0, 0], geometry: grid(2), material: material(one, [1, 0, 0, 1]) },
      ],
    }),
    { glb, stats } = await optimizeGLB(source),
    { json } = splitGLB(glb);
  assert.equal(json.images.length, 2);
  assert.equal(json.textures.length, 2);
  assert.equal(json.materials.length, 3);
  assert.equal(json.meshes.length, 3, 'one for each material');
  assert.equal(json.nodes[0].mesh, json.nodes[1].mesh);
  assert.notEqual(json.nodes[0].mesh, json.nodes[2].mesh);
  assert.equal(stats.images, 1, 'three images in, two out');
  const positions = new Set(json.meshes.map((mesh) => mesh.primitives[0].attributes.POSITION));
  assert.equal(positions.size, 1, 'the merged accessors of the same grid');
  assert.ok(glb.length < source.length);
  await clean(glb);
});

test('with dedupe off, nothing merges', async () => {
  const source = exportGLB({ nodes: [{ geometry: grid(2) }, { translation: [3, 0, 0], geometry: grid(2) }] }),
    { json } = splitGLB((await optimizeGLB(source, { dedupe: false })).glb);
  assert.equal(json.meshes.length, 2);
});

test('duplicate animation data merges and the clip reads the same', async () => {
  const node = { name: 'a', geometry: grid(2) },
    times = [0, 1, 2],
    source = exportGLB({
      nodes: [node, { name: 'b', translation: [4, 0, 0] }],
      animations: [
        {
          channels: [
            { node, path: 'translation', times, values: [0, 0, 0, 1, 0, 0, 2, 0, 0] },
            { node, path: 'scale', times, values: [1, 1, 1, 2, 2, 2, 3, 3, 3] },
          ],
        },
      ],
    }),
    { glb, stats } = await optimizeGLB(source),
    parts = splitGLB(glb),
    [a, b] = parts.json.animations[0].samplers;
  assert.equal(stats.accessors, 1, 'the shared key times');
  assert.equal(a.input, b.input);
  assert.deepEqual([...readAccessor(parts, a.input).values], times);
  await clean(glb);
});

test('materials and meshes keep their indices when an extension names them by pointer', async () => {
  for (const name of ['KHR_animation_pointer', 'KHR_interactivity', 'MSFT_lod']) {
    const parts = splitGLB(
      exportGLB({
        nodes: [
          { geometry: grid(2), material: { color: [1, 0, 0, 1] } },
          { translation: [3, 0, 0], geometry: grid(2) },
        ],
      }),
    );
    parts.json.materials.push({ ...parts.json.materials[0] });
    parts.json.meshes.push(structuredClone(parts.json.meshes[0]));
    const meshes = parts.json.meshes.length;
    (parts.json.extensionsUsed ??= []).push(name);
    const { json } = splitGLB((await optimizeGLB(joinGLB(parts))).glb);
    assert.equal(json.materials.length, 2, name);
    assert.equal(json.meshes.length, meshes, name);
  }
});

test('images stay where EXT_lights_image_based names them', async () => {
  const [one, two] = [
      await encodePNG({ width: 2, height: 2, data: new Uint8Array(16).fill(90) }),
      await encodePNG({ width: 2, height: 2, data: new Uint8Array(16).fill(90) }),
    ],
    material = (image) => ({ baseColorTexture: { image, mimeType: 'image/png' } }),
    parts = splitGLB(
      exportGLB({
        nodes: [
          { geometry: grid(2), material: material(one) },
          { geometry: grid(2), material: material(two) },
        ],
      }),
    );
  assert.equal(parts.json.images.length, 2);
  (parts.json.extensionsUsed ??= []).push('EXT_lights_image_based');
  assert.equal(splitGLB((await optimizeGLB(joinGLB(parts))).glb).json.images.length, 2);
});

test('images with the same bytes merge whatever their names', async () => {
  const [one, two] = [
      await encodePNG({ width: 2, height: 2, data: new Uint8Array(16).fill(90) }),
      await encodePNG({ width: 2, height: 2, data: new Uint8Array(16).fill(90) }),
    ],
    material = (image) => ({ baseColorTexture: { image, mimeType: 'image/png' } }),
    parts = splitGLB(
      exportGLB({
        nodes: [
          { geometry: grid(2), material: material(one) },
          { geometry: grid(2), material: material(two) },
        ],
      }),
    );
  parts.json.images[0].name = 'first';
  parts.json.images[1].name = 'second';
  assert.equal(splitGLB((await optimizeGLB(joinGLB(parts))).glb).json.images.length, 1);
});

test('simplify keeps the fraction asked, a subset of the source vertices, and the skin of each', async () => {
  const geometry = grid(16),
    count = geometry.positions.length / 3,
    joint = { name: 'joint' },
    skinned = {
      ...geometry,
      joints: new Uint8Array(count * 4),
      weights: new Float32Array(count * 4).map((_, i) => (i % 4 ? 0 : 1)),
    },
    source = exportGLB({
      nodes: [
        joint,
        {
          geometry: skinned,
          skin: { joints: [joint], inverseBindMatrices: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        },
      ],
    }),
    { glb, stats } = await optimizeGLB(source, { simplify: 0.25 }),
    parts = splitGLB(glb),
    primitive = parts.json.meshes[0].primitives[0],
    positions = readAccessor(parts, primitive.attributes.POSITION),
    uvs = readAccessor(parts, primitive.attributes.TEXCOORD_0),
    known = new Set();
  for (let v = 0; v < count; v++)
    known.add([...geometry.positions.subarray(v * 3, v * 3 + 3), ...geometry.uvs.subarray(v * 2, v * 2 + 2)].join());
  for (let v = 0; v < positions.count; v++)
    assert.ok(
      known.has([...positions.values.subarray(v * 3, v * 3 + 3), ...uvs.values.subarray(v * 2, v * 2 + 2)].join()),
      'a kept vertex is a source vertex, with its own UV',
    );
  // A collapse removes at most two triangles, so the count lands on the target or the one above it.
  assert.ok(stats.trianglesAfter <= Math.ceil(16 * 16 * 2 * 0.25) + 1, `${stats.trianglesAfter} triangles`);
  assert.ok(stats.trianglesAfter >= 16 * 16 * 2 * 0.25 - 2);
  assert.equal(readAccessor(parts, primitive.indices).count / 3, stats.trianglesAfter, 'the file holds what the stats say');
  assert.equal(readAccessor(parts, primitive.attributes.WEIGHTS_0).count, positions.count);
  await clean(glb);
});

test('every kept vertex keeps its own skin', async () => {
  const geometry = grid(16),
    count = geometry.positions.length / 3,
    joint = { name: 'joint' },
    // Each vertex's weight is its height, so a weight read on the wrong vertex shows.
    weights = new Float32Array(count * 4),
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let v = 0; v < count; v++) {
    weights[v * 4] = 0.25 + geometry.positions[v * 3 + 2] / 8;
    weights[v * 4 + 1] = 1 - weights[v * 4];
  }
  const parts = splitGLB(
      (
        await optimizeGLB(
          exportGLB({
            nodes: [
              joint,
              {
                geometry: { ...geometry, joints: new Uint8Array(count * 4), weights },
                skin: { joints: [joint], inverseBindMatrices: identity },
              },
            ],
          }),
          { simplify: 0.25 },
        )
      ).glb,
    ),
    primitive = parts.json.meshes[0].primitives[0],
    positions = readAccessor(parts, primitive.attributes.POSITION),
    kept = readAccessor(parts, primitive.attributes.WEIGHTS_0).values;
  for (let v = 0; v < positions.count; v++)
    assert.equal(kept[v * 4], Math.fround(0.25 + positions.values[v * 3 + 2] / 8));
});

test('two sheets that meet at one edge with different joints stay two sheets', async () => {
  // Sheet A at x <= 0 on joint 0, sheet B at x >= 0 on joint 1: their edge's vertices share a position and a UV and differ
  // only in skin. Merged, a triangle would straddle both joints and tear when they move.
  const n = 12,
    positions = [],
    normals = [],
    uvs = [],
    joints = [],
    indices = [];
  for (const sheet of [0, 1]) {
    const at = positions.length / 3;
    for (let y = 0; y <= n; y++)
      for (let x = 0; x <= n; x++) {
        const px = sheet ? x : x - n;
        positions.push(px, y, Math.sin(px * 0.9) * Math.cos(y * 0.7));
        normals.push(0, 0, 1);
        uvs.push(0, 0);
        joints.push(sheet, 0, 0, 0);
      }
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const a = at + y * (n + 1) + x,
          b = a + 1,
          c = a + n + 1,
          d = c + 1;
        indices.push(a, b, d, a, d, c);
      }
  }
  const count = positions.length / 3,
    second = { name: 'second' },
    first = { name: 'first', children: [second] },
    weights = new Float32Array(count * 4).map((_, i) => (i % 4 ? 0 : 1)),
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    source = exportGLB({
      nodes: [
        first,
        {
          geometry: {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint32Array(indices),
            joints: new Uint8Array(joints),
            weights,
          },
          skin: { joints: [first, second], inverseBindMatrices: [...identity, ...identity] },
        },
      ],
    }),
    parts = splitGLB((await optimizeGLB(source, { simplify: 0.5 })).glb),
    primitive = parts.json.meshes[0].primitives[0],
    ids = readAccessor(parts, primitive.attributes.JOINTS_0).values,
    list = readAccessor(parts, primitive.indices).values;
  assert.ok(list.length < indices.length);
  for (let t = 0; t < list.length; t += 3) {
    assert.equal(ids[list[t] * 4], ids[list[t + 1] * 4], `triangle ${t / 3} straddles two joints`);
    assert.equal(ids[list[t] * 4], ids[list[t + 2] * 4], `triangle ${t / 3} straddles two joints`);
  }
});

/** A bumpy grid with three vertices of its own for each triangle, every one on the triangle's normal: flat shading. */
function faceted(n) {
  const { positions, indices } = grid(n),
    out = { positions: [], normals: [] };
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => [...positions.subarray(indices[t + k] * 3, indices[t + k] * 3 + 3)]),
      u = a.map((v, i) => b[i] - v),
      w = a.map((v, i) => c[i] - v),
      cross = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]],
      size = Math.hypot(...cross);
    for (const corner of [a, b, c]) {
      out.positions.push(...corner);
      out.normals.push(...cross.map((v) => v / size));
    }
  }
  return { positions: new Float32Array(out.positions), normals: new Float32Array(out.normals) };
}

test('a flat-shaded mesh reaches its ratio, and each kept triangle takes its own normal', async () => {
  const faces = 16 * 16 * 2,
    { glb, stats } = await optimizeGLB(exportGLB({ nodes: [{ geometry: faceted(16) }] }), { simplify: 0.25 }),
    parts = splitGLB(glb),
    primitive = parts.json.meshes[0].primitives[0],
    positions = readAccessor(parts, primitive.attributes.POSITION).values,
    normals = readAccessor(parts, primitive.attributes.NORMAL).values,
    list = readAccessor(parts, primitive.indices).values;
  // A collapse removes at most two triangles, and the simplifier may stop one short.
  assert.ok(stats.trianglesAfter <= faces * 0.25 + 2, `${stats.trianglesAfter} triangles`);
  assert.equal(list.length / 3, stats.trianglesAfter, 'the file holds what the stats say');
  for (let t = 0; t < list.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => [...positions.subarray(list[t + k] * 3, list[t + k] * 3 + 3)]),
      u = a.map((v, i) => b[i] - v),
      w = a.map((v, i) => c[i] - v),
      cross = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]],
      size = Math.hypot(...cross);
    for (let k = 0; k < 3; k++)
      for (let axis = 0; axis < 3; axis++)
        // Float32 positions of about 16 give a cross product good to about 1e-6 of its size; normals are Float32 too.
        assert.ok(Math.abs(normals[list[t + k] * 3 + axis] - cross[axis] / size) < 1e-4, `triangle ${t / 3}`);
  }
  await clean(glb);
});

test('quantized normals keep their exact stored values through a level', async () => {
  const geometry = grid(12),
    parts = splitGLB(exportGLB({ nodes: [{ geometry }] })),
    primitive = parts.json.meshes[0].primitives[0],
    count = geometry.positions.length / 3,
    stored = new Int8Array(count * 4);
  // A different stored normal for each height, so a value scaled wrongly or read from the wrong vertex shows.
  for (let v = 0; v < count; v++) {
    stored[v * 4 + 1] = Math.round(geometry.positions[v * 3 + 2] * 60);
    stored[v * 4 + 2] = 100;
  }
  const bin = new Uint8Array(parts.bin.length + stored.length);
  bin.set(parts.bin);
  bin.set(new Uint8Array(stored.buffer), parts.bin.length);
  parts.json.buffers[0].byteLength = bin.length;
  parts.json.bufferViews.push({ buffer: 0, byteOffset: parts.bin.length, byteLength: stored.length, byteStride: 4 });
  parts.json.accessors.push({
    bufferView: parts.json.bufferViews.length - 1,
    componentType: 5120,
    normalized: true,
    count,
    type: 'VEC3',
  });
  primitive.attributes.NORMAL = parts.json.accessors.length - 1;
  const out = splitGLB((await optimizeGLB(joinGLB({ ...parts, bin }), { simplify: 0.5 })).glb),
    kept = out.json.meshes[0].primitives[0],
    { values, componentType, normalized } = readAccessor(out, kept.attributes.NORMAL),
    positions = readAccessor(out, kept.attributes.POSITION).values;
  assert.equal(componentType, 5120);
  assert.equal(normalized, true);
  for (let v = 0; v < positions.length / 3; v++) {
    assert.equal(values[v * 3 + 1], Math.round(positions[v * 3 + 2] * 60) + 0);
    assert.equal(values[v * 3 + 2], 100);
  }
});

test('a primitive of nothing but zero-area triangles stays as it was', async () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    source = exportGLB({ nodes: [{ geometry: { positions, normals, indices: new Uint32Array([0, 0, 1, 1, 2, 2]) } }] }),
    { glb, stats } = await optimizeGLB(source, { simplify: 0.5 }),
    parts = splitGLB(glb);
  assert.equal(stats.verticesAfter, 3);
  assert.equal(readAccessor(parts, parts.json.meshes[0].primitives[0].indices).count, 6);
  const report = await validate(glb);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
});

test('a position array equal to a normal array still gets its bounds', async () => {
  // Unit vectors written as both: one accessor may hold both, and POSITION must have min and max whichever comes first.
  const positions = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    parts = splitGLB(
      exportGLB({ nodes: [{ geometry: { positions, normals: positions, indices: new Uint32Array([0, 1, 2]) } }] }),
    );
  const primitive = parts.json.meshes[0].primitives[0],
    { POSITION, NORMAL } = primitive.attributes;
  primitive.attributes = { NORMAL, POSITION };
  const { glb } = await optimizeGLB(joinGLB(parts)),
    out = splitGLB(glb),
    accessor = out.json.accessors[out.json.meshes[0].primitives[0].attributes.POSITION];
  assert.deepEqual(accessor.min, [0, 0, 0]);
  assert.deepEqual(accessor.max, [1, 1, 1]);
  await clean(glb);
});

test('primitives sharing a position accessor count its vertices once and keep only what each uses', async () => {
  const geometry = grid(4),
    half = geometry.indices.length / 2,
    parts = splitGLB(exportGLB({ nodes: [{ geometry }] })),
    mesh = parts.json.meshes[0],
    [primitive] = mesh.primitives,
    { componentType } = parts.json.accessors[primitive.indices],
    size = componentType === 5125 ? 4 : 2,
    view = parts.json.accessors[primitive.indices].bufferView;
  parts.json.accessors[primitive.indices].count = half;
  parts.json.accessors.push({
    bufferView: view,
    byteOffset: half * size,
    componentType,
    count: half,
    type: 'SCALAR',
  });
  mesh.primitives.push({ ...primitive, indices: parts.json.accessors.length - 1 });
  const { stats, glb } = await optimizeGLB(joinGLB(parts));
  assert.equal(stats.verticesBefore, geometry.positions.length / 3);
  assert.equal(stats.trianglesAfter, geometry.indices.length / 3);
  await clean(glb);
});

test('morph targets follow the vertices a level keeps', async () => {
  const geometry = grid(8),
    deltas = geometry.positions.map((v) => v * 2),
    { glb } = await optimizeGLB(
      exportGLB({ nodes: [{ geometry: { ...geometry, morphs: [{ positions: deltas }] }, morphWeights: [0] }] }),
      { simplify: 0.5 },
    ),
    parts = splitGLB(glb),
    primitive = parts.json.meshes[0].primitives[0],
    base = readAccessor(parts, primitive.attributes.POSITION).values,
    delta = readAccessor(parts, primitive.targets[0].POSITION).values;
  assert.equal(base.length, delta.length);
  base.forEach((v, i) => assert.equal(delta[i], v * 2));
  await clean(glb);
});

test('lods write MSFT_lod level nodes, and the file draws its finest level without the extension', async () => {
  const source = exportGLB({ nodes: [{ name: 'hill', translation: [2, 0, 0], geometry: grid(16) }] }),
    { glb, stats } = await optimizeGLB(source, { lods: [0.5, 0.25], screenCoverage: [0.5, 0.2, 0.05] }),
    parts = splitGLB(glb),
    { json } = parts,
    node = json.nodes[0],
    { ids } = node.extensions.MSFT_lod,
    triangles = (mesh) => readAccessor(parts, json.meshes[mesh].primitives[0].indices).count / 3;
  assert.equal(stats.levels, 2);
  assert.equal(stats.trianglesAfter, 16 * 16 * 2);
  assert.ok(json.extensionsUsed.includes('MSFT_lod'));
  assert.ok(!(json.extensionsRequired ?? []).includes('MSFT_lod'), 'a reader without it draws level 0');
  assert.deepEqual(node.extras.MSFT_screencoverage, [0.5, 0.2, 0.05]);
  assert.deepEqual(json.nodes[ids[0]].translation, [2, 0, 0]);
  assert.equal(json.nodes[ids[1]].name, 'hill_LOD2');
  assert.deepEqual(json.scenes[0].nodes, [0], 'levels stay out of the scene');
  assert.ok(triangles(node.mesh) > triangles(json.nodes[ids[0]].mesh));
  assert.ok(triangles(json.nodes[ids[0]].mesh) > triangles(json.nodes[ids[1]].mesh));
  const report = await validate(glb);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
});

test('an animated node drives its levels too', async () => {
  const node = { name: 'moving', geometry: grid(8) },
    { json } = splitGLB(
      (
        await optimizeGLB(
          exportGLB({
            nodes: [node],
            animations: [{ channels: [{ node, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0] }] }],
          }),
          { lods: [0.5] },
        )
      ).glb,
    ),
    [first, second] = json.animations[0].channels;
  assert.equal(json.animations[0].channels.length, 2);
  assert.equal(first.sampler, second.sampler);
  assert.equal(second.target.node, json.nodes[first.target.node].extensions.MSFT_lod.ids[0]);
});

test('a KHR_animation_pointer on a node drives its levels too', async () => {
  const parts = splitGLB(
      exportGLB({
        nodes: [{ name: 'moving', geometry: grid(8) }],
      }),
    ),
    times = new Float32Array([0, 1]),
    values = new Float32Array([0, 0, 0, 1, 0, 0]),
    bin = new Uint8Array(parts.bin.length + times.byteLength + values.byteLength);
  bin.set(parts.bin);
  bin.set(new Uint8Array(times.buffer), parts.bin.length);
  bin.set(new Uint8Array(values.buffer), parts.bin.length + times.byteLength);
  parts.json.buffers[0].byteLength = bin.length;
  parts.json.bufferViews.push(
    { buffer: 0, byteOffset: parts.bin.length, byteLength: times.byteLength },
    { buffer: 0, byteOffset: parts.bin.length + times.byteLength, byteLength: values.byteLength },
  );
  const views = parts.json.bufferViews.length,
    accessors = parts.json.accessors.length;
  parts.json.accessors.push(
    { bufferView: views - 2, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
    { bufferView: views - 1, componentType: 5126, count: 2, type: 'VEC3' },
  );
  parts.json.animations = [
    {
      samplers: [{ input: accessors, output: accessors + 1 }],
      channels: [
        {
          sampler: 0,
          target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: '/nodes/0/translation' } } },
        },
      ],
    },
  ];
  (parts.json.extensionsUsed ??= []).push('KHR_animation_pointer');
  const { json } = splitGLB((await optimizeGLB(joinGLB({ ...parts, bin }), { lods: [0.5] })).glb),
    { channels } = json.animations[0],
    [id] = json.nodes[0].extensions.MSFT_lod.ids;
  assert.equal(channels.length, 2);
  assert.equal(channels[1].target.extensions.KHR_animation_pointer.pointer, `/nodes/${id}/translation`);
});

test('a primitive with no levels beside one with levels, in two meshes, still reads its own accessors', async () => {
  // Accessors are renumbered per holder, so a level sharing a primitive object with another mesh would be renumbered twice.
  const parts = splitGLB(
      exportGLB({
        nodes: [
          { geometry: grid(8) },
          { translation: [20, 0, 0], geometry: grid(10) },
          { translation: [40, 0, 0], geometry: grid(3) },
        ],
      }),
    ),
    { meshes } = parts.json,
    line = { ...meshes[2].primitives[0], mode: 1 };
  delete line.indices;
  meshes[0].primitives.push({ ...line });
  meshes[1].primitives.push({ ...line });
  const { glb, skipped } = await optimizeGLB(joinGLB(parts), { lods: [0.5] }),
    { json } = splitGLB(glb);
  assert.deepEqual(
    skipped.map(({ reason }) => reason),
    ['not-triangles', 'not-triangles'],
  );
  const lines = json.meshes.flatMap((mesh) => mesh.primitives).filter((primitive) => primitive.mode === 1);
  assert.equal(new Set(lines.map((primitive) => primitive.attributes.POSITION)).size, 1);
  const report = await validate(glb);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
});

test('meshes of one geometry with different materials share level data and each reads it right', async () => {
  const geometry = grid(8),
    { glb } = await optimizeGLB(
      exportGLB({
        nodes: [
          { geometry, material: { color: [1, 0, 0, 1] } },
          { translation: [9, 0, 0], geometry, material: { color: [0, 0, 1, 1] } },
        ],
      }),
      { lods: [0.5] },
    ),
    parts = splitGLB(glb),
    levels = parts.json.nodes.flatMap((node) => node.extensions?.MSFT_lod.ids ?? []),
    [one, two] = levels.map((id) => parts.json.meshes[parts.json.nodes[id].mesh].primitives[0]);
  assert.equal(levels.length, 2);
  assert.deepEqual(one.attributes, two.attributes);
  assert.equal(one.indices, two.indices);
  const base = parts.json.accessors[parts.json.meshes[0].primitives[0].attributes.POSITION].count;
  assert.ok(parts.json.accessors[one.attributes.POSITION].count < base, 'the level reads its own vertices');
  const report = await validate(glb);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
});

test('a level node leaves a camera with the node it came from', async () => {
  const parts = splitGLB(exportGLB({ nodes: [{ geometry: grid(8) }] }));
  parts.json.cameras = [{ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }];
  parts.json.nodes[0].camera = 0;
  const { json } = splitGLB((await optimizeGLB(joinGLB(parts), { lods: [0.5] })).glb);
  assert.equal(json.nodes[0].camera, 0);
  assert.equal(json.nodes[json.nodes[0].extensions.MSFT_lod.ids[0]].camera, undefined);
});

test('a file with levels of its own takes no more', async () => {
  const parts = splitGLB(exportGLB({ nodes: [{ geometry: grid(3) }] }));
  (parts.json.extensionsUsed ??= []).push('MSFT_lod');
  await assert.rejects(optimizeGLB(joinGLB(parts), { lods: [0.5] }), /has MSFT_lod levels/);
});

test('past the simplifier limit a mesh is welded, named, and left at full detail', async () => {
  const n = 450,
    positions = new Float32Array((n + 1) * (n + 1) * 3),
    indices = new Uint32Array(n * n * 6);
  for (let y = 0, at = 0; y <= n; y++) for (let x = 0; x <= n; x++, at += 3) positions.set([x, y, (x * y) % 7], at);
  for (let y = 0, at = 0; y < n; y++)
    for (let x = 0; x < n; x++, at += 6) {
      const a = y * (n + 1) + x;
      indices.set([a, a + 1, a + n + 2, a, a + n + 2, a + n + 1], at);
    }
  const normals = new Float32Array(positions.length).map((_, i) => (i % 3 === 2 ? 1 : 0)),
    { stats, skipped } = await optimizeGLB(exportGLB({ nodes: [{ geometry: { positions, normals, indices } }] }), {
      simplify: 0.5,
    });
  assert.deepEqual(skipped, [{ mesh: 0, primitive: 0, reason: 'too-large' }]);
  assert.equal(stats.trianglesAfter, n * n * 2);
});

test('nodes sharing a mesh share its levels', async () => {
  const geometry = grid(8),
    { json } = splitGLB(
      (await optimizeGLB(exportGLB({ nodes: [{ geometry }, { translation: [9, 0, 0], geometry }] }), { lods: [0.5] }))
        .glb,
    );
  assert.equal(json.meshes.length, 2, 'the mesh and one level');
  assert.equal(json.nodes.length, 4);
});

test('a Draco primitive is named and left as it was', async () => {
  const { glb: draco } = await compressDraco(exportGLB({ nodes: [{ geometry: grid(3) }] })),
    { glb, skipped } = await optimizeGLB(draco, { simplify: 0.5 });
  assert.deepEqual(skipped, [{ mesh: 0, primitive: 0, reason: 'draco' }]);
  assert.ok(splitGLB(glb).json.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression);
});

test('what it cannot take is refused, and a signal stops it', async () => {
  const source = exportGLB({ nodes: [{ geometry: grid(3) }] }),
    { glb: packed } = await compressMeshopt(source);
  await assert.rejects(optimizeGLB(packed), /optimize first/);
  await assert.rejects(optimizeGLB(source, { simplify: 1 }), RangeError);
  await assert.rejects(optimizeGLB(source, { simplify: 0 }), RangeError);
  await assert.rejects(optimizeGLB(source, { lods: [0.25, 0.5] }), RangeError);
  await assert.rejects(optimizeGLB(source, { lods: [0.5], screenCoverage: [0.5, 0.2, 0.1] }), RangeError);
  await assert.rejects(optimizeGLB(new Uint8Array(4)), TypeError);
  const stop = new AbortController();
  stop.abort(new Error('stopped'));
  await assert.rejects(optimizeGLB(source, { signal: stop.signal }), /stopped/);
});

test('Box.glb comes through with every triangle', async () => {
  const source = file('./fixtures/Box.glb'),
    { glb, stats } = await optimizeGLB(source);
  assert.equal(stats.trianglesAfter, 12);
  await clean(glb);
});
