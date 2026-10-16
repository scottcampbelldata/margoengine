// Proof for @margoengine/gltf-pro CPU setup: accessor decoding, vertex packing and prepared-geometry validation.
// Run: node examples/package-benchmarks/proofs/gltf-pro.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/gltf-pro.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { refs, versions, time, record } from './compare.js';

const { ref, pin } = refs('f05414a', 'f47ff3f'),
  { baseline, candidate } = await versions('gltf-pro', ref, undefined, pin);
// A real engine and transform store with a no-op renderer: model construction is CPU only, no GPU is touched.
const engine = new Engine(
  { width: 256, height: 256, clientWidth: 256, clientHeight: 256 },
  await TransformStore.create(64),
  { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
);
const bytesOf = (view) => Buffer.from(view.buffer, view.byteOffset, view.byteLength);
const outcome = (operation) => {
  try {
    return { value: operation() };
  } catch (error) {
    return { type: error.constructor.name, message: error.message };
  }
};
function agree(name, run) {
  const expected = outcome(() => run(baseline)),
    actual = outcome(() => run(candidate));
  if ('value' in expected) {
    assert.ok('value' in actual, `${name}: ${actual.message}`);
    assert.equal(actual.value.length, expected.value.length, name);
    expected.value.forEach((view, i) => {
      assert.equal(actual.value[i].constructor, view.constructor, name);
      assert.ok(bytesOf(actual.value[i]).equals(bytesOf(view)), `${name}: array ${i} differs`);
    });
  } else {
    // Since 5l.p errors also name mesh, primitive, attribute and accessor: same class, and the baseline's text still in it.
    assert.equal(actual.type, expected.type, name);
    assert.ok(actual.message?.includes(expected.message), `${name}: ${actual.message} lacks ${expected.message}`);
  }
  if (process.env.PROOF_VERBOSE) console.error(name, '->', expected.message ?? 'ok'); // lists what each edge case exercised
  return expected;
}
/** Builds a model, returns every primitive's packed arrays, and disposes it again. */
const build = (api, { doc, buffers }) => {
  const model = new api.PBRModel(engine, new api.GLTFAsset(doc, buffers));
  try {
    return model.primitives.flatMap((p) => [p.vertices, p.indices, p.weights]);
  } finally {
    model.dispose();
  }
};

// 224 x 224 vertices and 99,458 triangles: one detailed prop, the common size of a hero asset mesh.
const side = 224,
  count = side * side,
  P = new Float32Array(count * 3),
  N = new Float32Array(count * 3),
  T = new Float32Array(count * 4),
  UV = new Float32Array(count * 2),
  faces = [];
for (let y = 0, i = 0; y < side; y++)
  for (let x = 0; x < side; x++, i++) {
    const a = (x / (side - 1)) * Math.PI * 2,
      b = (y / (side - 1) - 0.5) * Math.PI,
      r = 1 + 0.15 * Math.sin(a * 7) * Math.cos(b * 5);
    P.set([r * Math.cos(b) * Math.cos(a) * 3.7, r * Math.sin(b) * 2.1, r * Math.cos(b) * Math.sin(a) * 3.7], i * 3);
    N.set([Math.cos(b) * Math.cos(a) * 1.5, Math.sin(b) * 1.5 + 0.01, Math.cos(b) * Math.sin(a) * 1.5], i * 3);
    T.set([-Math.sin(a), 0, Math.cos(a), i % 2 ? 1 : -1], i * 4);
    UV.set([x / (side - 1), y / (side - 1)], i * 2);
  }
for (let y = 0; y < side - 1; y++)
  for (let x = 0; x < side - 1; x++) {
    const a = y * side + x;
    faces.push(a, a + 1, a + side, a + 1, a + side + 1, a + side);
  }
const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function scene(attributes, indices, extra = {}) {
  const buffers = [],
    bufferViews = [],
    accessors = [];
  const add = ({ data, type, componentType = 5126, normalized, stride, offset, elements, sparse }) => {
    if (data) {
      buffers.push(data);
      bufferViews.push({
        buffer: buffers.length - 1,
        byteLength: data.byteLength,
        ...(stride ? { byteStride: stride } : {}),
      });
    }
    accessors.push({
      ...(data ? { bufferView: bufferViews.length - 1 } : {}),
      componentType,
      type,
      count: elements ?? data.length / sizes[type],
      ...(normalized ? { normalized } : {}),
      ...(offset ? { byteOffset: offset } : {}),
      ...(sparse ? { sparse } : {}),
    });
    return accessors.length - 1;
  };
  const primitive = {
    attributes: Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [
        key,
        typeof value === 'function' ? value(add, buffers, bufferViews) : add(value),
      ]),
    ),
  };
  if (indices) primitive.indices = add(indices);
  return {
    buffers,
    doc: {
      asset: { version: '2.0' },
      buffers: buffers.map((data) => ({ byteLength: data.byteLength })),
      bufferViews,
      accessors,
      meshes: [{ primitives: [{ ...primitive, ...extra }] }],
      nodes: [
        { mesh: 0, children: [1] },
        { name: 'Child', mesh: 0 },
      ],
    },
  };
}
// Interleaved position/normal with a 28-byte stride, the layout most exporters write.
const interleaved = new Float32Array(count * 7);
for (let i = 0; i < count; i++) {
  interleaved.set(P.subarray(i * 3, i * 3 + 3), i * 7);
  interleaved.set(N.subarray(i * 3, i * 3 + 3), i * 7 + 3);
}
const full = scene(
  {
    POSITION: (add) => add({ data: interleaved, type: 'VEC3', stride: 28, elements: count }),
    NORMAL: (add, buffers, views) => {
      const id = add({ data: interleaved, type: 'VEC3', stride: 28, offset: 12, elements: count });
      buffers.pop();
      views.pop();
      return (add.last = id), id;
    },
    TANGENT: { data: T, type: 'VEC4' },
    TEXCOORD_0: { data: UV, type: 'VEC2' },
    TEXCOORD_1: { data: Uint16Array.from(UV, (v) => v * 65535), type: 'VEC2', componentType: 5123, normalized: true },
    COLOR_0: {
      data: Uint8Array.from({ length: count * 4 }, (_, i) => i * 37),
      type: 'VEC4',
      componentType: 5121,
      normalized: true,
    },
  },
  { data: Uint32Array.from(faces), type: 'SCALAR', componentType: 5125 },
);
// The shared interleaved view: point NORMAL at POSITION's bufferView.
full.doc.accessors[1].bufferView = full.doc.accessors[0].bufferView;
// Position only: flat-accumulated normals, default colors, 16-bit indices and a float RGB color set.
const minimal = scene(
  {
    POSITION: { data: P, type: 'VEC3' },
    COLOR_0: { data: Float32Array.from({ length: count * 3 }, (_, i) => (i % 255) / 255), type: 'VEC3' },
  },
  { data: Uint16Array.from(faces), type: 'SCALAR', componentType: 5123 },
);
const unindexed = scene({
  POSITION: { data: P.subarray(0, 9000), type: 'VEC3' },
  NORMAL: { data: N.subarray(0, 9000), type: 'VEC3' },
  TEXCOORD_0: {
    data: Uint8Array.from({ length: 6000 }, (_, i) => i),
    type: 'VEC2',
    componentType: 5121,
    normalized: true,
  },
});
const sparse = scene(
  {
    POSITION: { data: P.subarray(0, 300), type: 'VEC3' },
    NORMAL: (add, buffers, views) => {
      buffers.push(Uint16Array.of(1, 7, 99), new Float32Array([0, 0, 2, 0, 3, 0, 4, 0, 0]));
      views.push({ buffer: buffers.length - 2, byteLength: 6 }, { buffer: buffers.length - 1, byteLength: 36 });
      return add({
        type: 'VEC3',
        elements: 100,
        sparse: {
          count: 3,
          indices: { bufferView: views.length - 2, componentType: 5123 },
          values: { bufferView: views.length - 1 },
        },
        data: N.subarray(0, 300),
      });
    },
  },
  { data: Uint8Array.from({ length: 99 }, (_, i) => i), type: 'SCALAR', componentType: 5121 },
);
const broken = (source, change) => {
  const copy = { doc: structuredClone(source.doc), buffers: source.buffers.map((data) => data.slice()) };
  change(copy);
  return copy;
};
for (const [name, source] of [
  ['interleaved with every attribute', full],
  ['position only', minimal],
  ['non-indexed', unindexed],
  ['sparse normals', sparse],
  [
    'non-finite position',
    broken(minimal, (s) => {
      s.buffers[0][5] = Infinity;
    }),
  ],
  [
    'index past the vertices',
    broken(minimal, (s) => {
      s.buffers[2][10] = 60000;
    }),
  ],
  [
    'zero normal',
    broken(unindexed, (s) => {
      s.buffers[1].fill(0, 30, 33);
    }),
  ],
  [
    'incomplete triangle',
    broken(minimal, (s) => {
      s.doc.accessors[2].count -= 1;
    }),
  ],
  [
    'mismatched uv count',
    broken(unindexed, (s) => {
      s.doc.accessors[2].count -= 3;
    }),
  ],
  [
    'float indices',
    broken(minimal, (s) => {
      s.buffers[2] = Float32Array.from(s.buffers[2]);
      s.doc.accessors[2].componentType = 5126;
      s.doc.bufferViews[2].byteLength = s.buffers[2].byteLength;
      s.doc.buffers[2].byteLength = s.buffers[2].byteLength;
    }),
  ],
  [
    'fractional index',
    broken(minimal, (s) => {
      s.buffers[2] = Float32Array.from(s.buffers[2], (v, i) => (i === 4 ? 1.5 : v));
      s.doc.accessors[2].componentType = 5126;
      s.doc.bufferViews[2].byteLength = s.buffers[2].byteLength;
      s.doc.buffers[2].byteLength = s.buffers[2].byteLength;
    }),
  ],
  [
    'accessor past its view',
    broken(minimal, (s) => {
      s.doc.accessors[0].count += 1;
    }),
  ],
  [
    'unaligned offset',
    broken(minimal, (s) => {
      s.doc.accessors[0].byteOffset = 2;
    }),
  ],
  [
    'sparse index order',
    broken(sparse, (s) => {
      s.buffers[2][1] = 1;
    }),
  ],
  [
    'color with five components',
    broken(minimal, (s) => {
      s.doc.accessors[1].type = 'MAT4';
    }),
  ],
])
  agree(`model ${name}`, (api) => build(api, source));
// Every component type through the accessor reader, plain and normalized, including the -1 clamp of signed types.
const typed = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
for (const [componentType, Type] of Object.entries(typed))
  for (const normalized of [false, true])
    for (const type of ['SCALAR', 'VEC3', 'MAT4']) {
      const data = Type.from({ length: 96 }, (_, i) =>
        Type === Float32Array
          ? Math.sin(i) * 1e3
          : i % 2
            ? -128 * 256 ** (Type.BYTES_PER_ELEMENT - 1) + i
            : i * 2654435761,
      );
      const source = scene({
        POSITION: { data: P.subarray(0, 9), type: 'VEC3' },
        EXTRA: { data, type, componentType: +componentType, normalized },
      });
      agree(`accessor ${componentType} ${type} ${normalized}`, (api) => [
        new api.GLTFAsset(source.doc, source.buffers).accessor(1),
      ]);
    }

// Prepared geometry: the packed arrays of the full model, then one fault at a time.
const [vertices, indices] = build(baseline, full),
  prepared = (change) => {
    const data = { vertices: vertices.slice(), indices: indices.slice() };
    change?.(data);
    return data;
  };
for (const [name, data] of [
  ['valid', prepared()],
  [
    'index out of range',
    prepared((d) => {
      d.indices[299] = count;
    }),
  ],
  [
    'NaN',
    prepared((d) => {
      d.vertices[45] = NaN;
    }),
  ],
  [
    'w is not one',
    prepared((d) => {
      d.vertices[23] = 2;
    }),
  ],
  [
    'normal w',
    prepared((d) => {
      d.vertices[27] = 1;
    }),
  ],
  [
    'long normal',
    prepared((d) => {
      d.vertices[24] = 3;
    }),
  ],
  [
    'tangent sign',
    prepared((d) => {
      d.vertices[31] = 0.5;
    }),
  ],
  [
    'negative zero tangent sign',
    prepared((d) => {
      d.vertices[31] = -0;
      d.vertices[28] = 9;
    }),
  ],
  [
    'long tangent',
    prepared((d) => {
      d.vertices[28] = 9;
    }),
  ],
  [
    'color above one',
    prepared((d) => {
      d.vertices[39] = 1.5;
    }),
  ],
  ['two vertices', { vertices: vertices.slice(0, 40), indices: indices.slice(0, 3) }],
  ['ragged', { vertices: vertices.slice(0, 61), indices }],
  ['no indices', { vertices, indices: new Uint32Array(0) }],
  ['wrong types', { vertices: Array.from(vertices.subarray(0, 60)), indices: indices.slice(0, 3) }],
  [
    'Infinity and bad index',
    prepared((d) => {
      d.vertices[0] = Infinity;
      d.indices[0] = 1e9;
    }),
  ],
])
  assert.deepEqual(
    outcome(() => candidate.validatePreparedGeometry(data)),
    outcome(() => baseline.validatePreparedGeometry(data)),
    `prepared ${name}`,
  );

const cases = [],
  mesh = { vertices: count, triangles: faces.length / 3 };
const add = (name, run) => {
  cases.push({
    case: name,
    ...mesh,
    ...time(
      () => run(baseline),
      () => run(candidate),
      15,
    ),
  });
  console.error(JSON.stringify(cases.at(-1)));
};
add('build model: interleaved, tangents, two UV sets, byte colors', (api) => build(api, full));
add('build model: position only, computed normals', (api) => build(api, minimal));
add('decode accessors only', (api) => {
  const asset = new api.GLTFAsset(full.doc, full.buffers);
  for (let id = 0; id < full.doc.accessors.length; id++) asset.accessor(id);
});
const valid = prepared();
add('validatePreparedGeometry', (api) => api.validatePreparedGeometry(valid));
engine.dispose();
await record(
  'gltf-pro',
  ref,
  cases,
  'Accessors decode through one typed reader straight into the output; vertices are packed and validated with indexed loops instead of subarray, spread and callback calls.',
  pin,
);
