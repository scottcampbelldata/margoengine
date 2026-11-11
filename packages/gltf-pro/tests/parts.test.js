// Primitives of any size load as parts (src/parts.ts): every part within maxPartVertices, the same triangles, few copied
// vertices, compact Morton parts, file order for BLEND, the worker path, prepared geometry and the refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTFAsync, parsePreparedPBR } from '../dist/index.js';
import { modelFromPrepared } from '../dist/worker.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

async function engineFor() {
  const h = optionalGPU();
  return new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, await TransformStore.create(64), {
    backend: 'webgpu',
    gpu: h.engine.gpu,
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
}
/** A w x h vertex grid in the xy plane as a glTF: two triangles a cell, `mode` 4, or the vertices as points (0) or a line strip (3). */
function grid(w, h, { blend = false, mode = 4, indexType = 5125, indexed = true, skinned = false, relief = 0 } = {}) {
  const count = w * h,
    positions = new Float32Array(count * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      positions.set([x, y, relief * Math.sin(x * 0.05) * Math.cos(y * 0.04)], (y * w + x) * 3);
  let indices;
  if (mode === 4) {
    indices = new (indexType === 5123 ? Uint16Array : Uint32Array)((w - 1) * (h - 1) * 6);
    for (let y = 0, o = 0; y < h - 1; y++)
      for (let x = 0; x < w - 1; x++, o += 6) {
        const i = y * w + x;
        indices.set([i, i + 1, i + w, i + 1, i + w + 1, i + w], o);
      }
  } else indices = new Uint32Array(count).map((_, i) => i);
  const parts = [positions];
  if (indexed) parts.push(indices);
  let joints;
  if (skinned) parts.push((joints = new Uint8Array(count * 4)), new Float32Array(count * 4).fill(0.25));
  const views = [],
    chunks = [];
  let offset = 0;
  for (const data of parts) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      padded = Math.ceil(bytes.byteLength / 4) * 4;
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
    chunks.push(bytes, new Uint8Array(padded - bytes.byteLength));
    offset += padded;
  }
  const buffer = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    buffer.set(c, at);
    at += c.byteLength;
  }
  const accessors = [
      { bufferView: 0, componentType: 5126, type: 'VEC3', count, min: [0, 0, -relief], max: [w - 1, h - 1, relief] },
    ],
    attributes = { POSITION: 0 },
    primitive = { attributes, mode, material: 0 };
  if (indexed) {
    accessors.push({
      bufferView: 1,
      componentType: mode === 4 ? indexType : 5125,
      type: 'SCALAR',
      count: indices.length,
    });
    primitive.indices = 1;
  }
  if (skinned) {
    accessors.push({ bufferView: 2, componentType: 5121, type: 'VEC4', count });
    accessors.push({ bufferView: 3, componentType: 5126, type: 'VEC4', count });
    attributes.JOINTS_0 = 2;
    attributes.WEIGHTS_0 = 3;
  }
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [primitive] }],
    materials: [blend ? { alphaMode: 'BLEND' } : {}],
    buffers: [{ byteLength: buffer.byteLength }],
    bufferViews: views,
    accessors,
  };
  return { doc, buffer, positions, indices, count, joints };
}
/** Order-free fingerprint of a triangle list: count and two sums of a mixing hash of each rotated (smallest first) triangle. */
function fingerprint(triangles) {
  let n = 0,
    a = 0,
    b = 0;
  for (const [x, y, z] of triangles) {
    const t = x <= y && x <= z ? [x, y, z] : y <= z ? [y, z, x] : [z, x, y];
    let h = 2166136261;
    for (const v of t) h = Math.imul(h ^ v, 16777619) ^ (h >>> 13);
    a = (a + (h >>> 0)) % 4294967296;
    b = ((b + Math.imul(h, 2654435761)) >>> 0) % 4294967296;
    n++;
  }
  return { n, a, b };
}
function* sourceTriangles(p) {
  const map = p.part?.vertexMap;
  for (let i = 0; i < p.indices.length; i += 3) {
    const t = [p.indices[i], p.indices[i + 1], p.indices[i + 2]];
    yield map ? t.map((v) => map[v]) : t;
  }
}
function* allTriangles(primitives) {
  for (const p of primitives) yield* sourceTriangles(p);
}
function* fileTriangles(indices) {
  for (let i = 0; i < indices.length; i += 3) yield [indices[i], indices[i + 1], indices[i + 2]];
}

test('a 1,001,000-vertex primitive (over the old 1M refusal) loads as compact parts within 262,144 vertices', async () => {
  const { doc, buffer, positions, indices, count } = grid(1001, 1000),
    engine = await engineFor(),
    started = performance.now(),
    model = await parseGLTFAsync(engine, doc, [buffer], []),
    ms = performance.now() - started;
  try {
    const parts = model.primitives;
    assert.ok(parts.length > 1);
    let copied = 0,
      area = 0;
    parts.forEach((p, i) => {
      const n = p.vertices.length / 20;
      assert.ok(n <= 262_144, `part ${i} has ${n} vertices`);
      assert.deepEqual([p.part.index, p.part.count], [i, parts.length]);
      assert.equal(p.part.vertexMap.length, n);
      assert.equal(p.definition, doc.meshes[0].primitives[0]);
      assert.equal(p.node, model.nodes[0]);
      copied += n;
      // Each local vertex is the source vertex vertexMap names.
      for (let k = 0; k < n; k += 997)
        for (let c = 0; c < 3; c++) assert.equal(p.vertices[k * 20 + c], positions[p.part.vertexMap[k] * 3 + c]);
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let k = 0; k < n; k++) {
        x0 = Math.min(x0, p.vertices[k * 20]);
        x1 = Math.max(x1, p.vertices[k * 20]);
        y0 = Math.min(y0, p.vertices[k * 20 + 1]);
        y1 = Math.max(y1, p.vertices[k * 20 + 1]);
      }
      area += (x1 - x0) * (y1 - y0);
    });
    assert.deepEqual(fingerprint(allTriangles(parts)), fingerprint(fileTriangles(indices)));
    const duplicates = copied / count - 1;
    assert.ok(duplicates < 0.05, `copied vertices ${(duplicates * 100).toFixed(2)}%`);
    // Morton parts tile the grid: their boxes overlap little (file-order strips would too, but long thin ones).
    assert.ok(area < 1.6 * 1000 * 999, `part boxes cover ${area}`);
    console.log(
      `# 1,001,000 vertices: ${parts.length} parts, ${(duplicates * 100).toFixed(2)}% copied, ${ms.toFixed(0)} ms (recorded, not asserted)`,
    );
  } finally {
    model.dispose();
    engine.dispose();
  }
});

// A terrain's parts were spread over the whole field: the Morton key scaled each axis to its own extent, so the nearly
// flat axis took all 10 bits and its top bit split the surface into height bands (CulledModels then culled almost none
// of a 10M-triangle field close up). One scale for all axes keeps every part a compact piece.
test('parts of a field with low relief are as compact as those of a flat one, not height bands', async () => {
  const engine = await engineFor(),
    boxes = async (relief) => {
      const { doc, buffer } = grid(400, 400, { relief }),
        model = await parseGLTFAsync(engine, doc, [buffer], [], { maxPartVertices: 4096 });
      try {
        assert.ok(model.primitives.length > 30, `${model.primitives.length} parts`);
        return boxArea(model.primitives);
      } finally {
        model.dispose();
      }
    };
  try {
    const flat = await boxes(0),
      relief = await boxes(2);
    assert.ok(relief <= 1.05 * flat, `part boxes cover ${(relief / flat).toFixed(2)} times those of the flat field`);
  } finally {
    engine.dispose();
  }
});
/** Summed xy box areas of the parts. */
function boxArea(primitives) {
  let area = 0;
  for (const p of primitives) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let k = 0; k < p.vertices.length; k += 20) {
      x0 = Math.min(x0, p.vertices[k]);
      x1 = Math.max(x1, p.vertices[k]);
      y0 = Math.min(y0, p.vertices[k + 1]);
      y1 = Math.max(y1, p.vertices[k + 1]);
    }
    area += (x1 - x0) * (y1 - y0);
  }
  return area;
}

test('BLEND parts keep the file triangle order; uint16, unindexed, points and line strips split too', async () => {
  const engine = await engineFor();
  try {
    {
      const { doc, buffer, indices } = grid(80, 80, { blend: true }),
        model = await parseGLTFAsync(engine, doc, [buffer], [], { maxPartVertices: 1024 });
      assert.ok(model.primitives.length > 6);
      const ordered = [...allTriangles(model.primitives)].flat();
      assert.deepEqual(ordered, [...indices]);
      model.dispose();
    }
    for (const options of [{ indexType: 5123 }, { indexed: false, mode: 0 }, { mode: 3 }, { mode: 0 }]) {
      const { doc, buffer, count } = grid(64, 64, options),
        model = await parseGLTFAsync(engine, doc, [buffer], [], { maxPartVertices: 1024 }),
        list = options.mode === undefined ? model.primitives : model.pointsAndLines;
      assert.ok(list.length >= 4, JSON.stringify(options));
      for (const p of list) assert.ok(p.vertices.length / 20 <= 1024);
      const per = options.mode === 0 ? 1 : options.mode === 3 ? 2 : 3,
        elements = list.reduce((n, p) => n + p.indices.length / per, 0);
      assert.equal(elements, options.mode === 0 ? count : options.mode === 3 ? count - 1 : 63 * 63 * 2);
      model.dispose();
    }
  } finally {
    engine.dispose();
  }
});

test('the worker path carries parts in PreparedGLTF; prepared geometry over the part size splits on load', async () => {
  const engine = await engineFor(),
    { doc, buffer, indices } = grid(64, 64);
  try {
    const loaded = await parseGLTFAsync(engine, structuredClone(doc), [buffer], [], { maxPartVertices: 1024 }),
      geometry = [[loaded.primitives.map((p) => ({ vertices: p.vertices, indices: p.indices, part: p.part }))]],
      prepared = {
        doc: structuredClone(doc),
        buffers: [buffer],
        images: [],
        geometry,
        accessors: [],
        maxPartVertices: 1024,
      };
    const model = modelFromPrepared(engine, prepared);
    assert.equal(model.primitives.length, loaded.primitives.length);
    assert.deepEqual(fingerprint(allTriangles(model.primitives)), fingerprint(fileTriangles(indices)));
    model.dispose();
    loaded.dispose();
    // A static .margo-style primitive of 4,096 vertices with later UVs, split at 1,024.
    const vertices = new Float32Array(4096 * 20),
      uvs = new Float32Array(4096 * 4);
    for (let i = 0; i < 4096; i++) {
      vertices.set([i % 64, Math.floor(i / 64), 0, 1, 0, 0, 1], i * 20);
      vertices.fill(1, i * 20 + 16, i * 20 + 20);
      uvs.set([i, -i, i / 2, 7], i * 4);
    }
    const staticDoc = {
        asset: { version: '2.0' },
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: {} }] }],
      },
      split = parsePreparedPBR(engine, staticDoc, [[{ vertices, indices: new Uint32Array(indices), uvs }]], [], {
        maxPartVertices: 1024,
      });
    assert.ok(split.primitives.length >= 4);
    for (const p of split.primitives) {
      assert.ok(p.vertices.length / 20 <= 1024);
      for (let k = 0; k < p.part.vertexMap.length; k++) assert.equal(p.uvs[k * 4], p.part.vertexMap[k]);
    }
    split.dispose();
  } finally {
    engine.dispose();
  }
});

test('refusals: over 2^24 vertices, skinned over the part size, an invalid maxPartVertices', async () => {
  const engine = await engineFor();
  try {
    const huge = grid(4, 4);
    huge.doc.accessors[0].count = 16_777_217;
    await assert.rejects(
      parseGLTFAsync(engine, huge.doc, [huge.buffer], []),
      (e) => e.code === 'unsupported' && /16777216/.test(e.message),
    );
    const skinned = grid(40, 40, { skinned: true });
    await assert.rejects(
      parseGLTFAsync(engine, skinned.doc, [skinned.buffer], [], { maxPartVertices: 1024 }),
      (e) => e.code === 'unsupported' && /maxPartVertices \(1024\)/.test(e.message),
    );
    for (const bad of [1023, 1_048_577, 2.5])
      await assert.rejects(
        parseGLTFAsync(engine, huge.doc, [huge.buffer], [], { maxPartVertices: bad }),
        /maxPartVertices/,
      );
  } finally {
    engine.dispose();
  }
});
