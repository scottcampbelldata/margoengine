// TEXCOORD_2 and 3: a second vertex buffer and a shader variant, only for draws whose material reads a later UV set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, parseGLTF, textureCoordinates } from '../dist/index.js';
import { prepareAsset } from '../dist/prepare.js';
import { extendedMaterials } from '../dist/extended.js';

const quad = () => {
  const arrays = [
    new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    new Float32Array([0, 0, 0, 0, 0, 0, 0, 0]),
    new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
    new Float32Array([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]),
    new Uint16Array([0, 1, 2, 0, 2, 3]),
  ];
  const accessor = (bufferView, count, type, componentType = 5126) => ({ bufferView, componentType, count, type });
  return {
    buffers: arrays,
    doc: {
      asset: { version: '2.0' },
      buffers: arrays.map((a) => ({ byteLength: a.byteLength })),
      bufferViews: arrays.map((a, buffer) => ({ buffer, byteLength: a.byteLength })),
      accessors: [
        accessor(0, 4, 'VEC3'),
        accessor(1, 4, 'VEC3'),
        accessor(2, 4, 'VEC2'),
        accessor(3, 4, 'VEC2'),
        accessor(4, 4, 'VEC2'),
        accessor(5, 4, 'VEC2'),
        accessor(6, 6, 'SCALAR', 5123),
      ],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TEXCOORD_1: 3, TEXCOORD_2: 4, TEXCOORD_3: 5 },
              indices: 6,
              material: 0,
            },
          ],
        },
      ],
      nodes: [{ mesh: 0 }],
      textures: [{ source: 0 }],
      images: [{}],
    },
  };
};

async function load(material, edit = () => {}, decoders = {}) {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      renderer,
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    { doc, buffers } = quad();
  doc.materials = [material];
  edit(doc);
  const model = parseGLTF(engine, doc, buffers, [{ width: 1, height: 1, close() {} }], decoders);
  store.tick(false);
  const view = context(gpu, { samples: 4, format: 'rgba16float', depthFormat: 'depth32float' }),
    log = gpu.record(() => {
      view.begin(0);
      model.draw(view.c, 'beauty', view.c.color, view.c.depth);
    });
  return { engine, model, log };
}
const of = (log, name) => log.filter((e) => e[0] === name);
const pipeline = (log) => of(log, 'renderPipeline')[0][2];

test('a texture on TEXCOORD_2 draws through the second vertex buffer and the four-way UV choice', async () => {
  const { engine, model, log } = await load({
    pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 2 } },
    emissiveTexture: { index: 0, texCoord: 3 },
    emissiveFactor: [1, 1, 1],
  });
  const p = model.primitives[0],
    described = pipeline(log),
    code = of(log, 'module').at(-1)[2].code;
  assert.deepEqual(
    Array.from(p.uvs).map((v) => +v.toFixed(5)),
    [0.1, 0.2, 0.9, 0.8, 0.3, 0.4, 0.7, 0.6, 0.5, 0.6, 0.5, 0.4, 0.7, 0.8, 0.3, 0.2],
    'TEXCOORD_2 then TEXCOORD_3, vertex by vertex',
  );
  assert.equal(described.vertex.buffers[1], null, 'the instance slot stays empty');
  assert.equal(described.vertex.buffers[2].arrayStride, 16);
  assert.equal(described.vertex.buffers[2].attributes[0].shaderLocation, 11);
  assert.ok(code.includes('@location(11) uvs:vec4f') && code.includes('o.uvs=i.uvs;'));
  assert.ok(code.includes('fn margoUVSet(') && !/select\(i\.uv\.xy,i\.uv\.zw,coord/.test(code));
  assert.ok(of(log, 'pass.setVertexBuffer').some((e) => e[1] === 2));
  const uniform = model['resources'][0].uniform.contents;
  assert.equal(uniform[92], 2, 'base map reads set 2');
  assert.equal(uniform[96], 3, 'emissive map reads set 3');
  model.dispose();
  engine.dispose();
});

test('a file that only carries later UV sets pays nothing', async () => {
  const { engine, model, log } = await load({ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 } } });
  assert.equal(model.primitives[0].uvs, undefined);
  assert.equal(pipeline(log).vertex.buffers.length, 1);
  assert.equal(of(log, 'module').at(-1)[2].code.includes('margoUVSet'), false);
  model.dispose();
  engine.dispose();
});

test('a material variant on a later set is enough, and the physical shader picks it up', async () => {
  const { engine, model } = await load({}, (doc) => {
    doc.materials.push({ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 2 } } });
    doc.extensions = { KHR_materials_variants: { variants: [{ name: 'a' }] } };
    doc.meshes[0].primitives[0].extensions = {
      KHR_materials_variants: { mappings: [{ material: 1, variants: [0] }] },
    };
  });
  assert.equal(model.primitives[0].uvs.length, 16);
  model.dispose();
  engine.dispose();
  const physical = await load(
    {
      pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 3 } },
      extensions: {
        KHR_materials_sheen: { sheenColorFactor: [1, 1, 1], sheenColorTexture: { index: 0, texCoord: 2 } },
      },
    },
    undefined,
    { materials: extendedMaterials },
  );
  const code = of(physical.log, 'module').at(-1)[2].code;
  assert.ok(code.includes('margoUVSet(i,m.w)') && !code.includes('select(i.uv.xy,i.uv.zw,m.w>0.5)'));
  assert.equal(physical.model.primitives[0].material.uvt[3], 3, 'the UV row names the set');
  physical.model.dispose();
  physical.engine.dispose();
});

test('a normal map on a later set takes its frame from that set, as authored tangents follow TEXCOORD_0', async () => {
  const { engine, model, log } = await load({ normalTexture: { index: 0, texCoord: 2 } });
  assert.ok(of(log, 'module').at(-1)[2].code.includes('if(true) {'));
  model.dispose();
  engine.dispose();
});

test('sets are checked: a missing one and a fifth are refused by name', async () => {
  await assert.rejects(
    load({ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 2 } } }, (doc) => {
      delete doc.meshes[0].primitives[0].attributes.TEXCOORD_2;
    }),
    /Material requires available TEXCOORD_2/,
  );
  await assert.rejects(
    load({ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 4 } } }),
    /at most TEXCOORD_3/,
  );
  assert.equal(textureCoordinates({ texCoord: 3 }).texCoord, 3);
  assert.equal(textureCoordinates({ extensions: { KHR_texture_transform: { texCoord: 2 } } }).texCoord, 2);
  assert.throws(() => textureCoordinates({ texCoord: 4 }), /TEXCOORD_0 to TEXCOORD_3/);
});

test('a MASK base map on a later set casts and picks uncut, on a UV set the depth passes have', async () => {
  const { engine, model } = await load({
    alphaMode: 'MASK',
    pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 2 } },
  });
  const [caster] = model.shadowPrimitives,
    [pick] = model.pickingPrimitives;
  assert.equal(caster.cutoff, 0);
  assert.equal(caster.texCoord, 0);
  assert.equal(pick.cutoff, 0);
  assert.equal(pick.texCoord, 0);
  model.dispose();
  engine.dispose();
});

test('writeGeometry keeps a later set valid: a new vertex count brings its own uvs', async () => {
  const { engine, model } = await load({ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 2 } } });
  const p = model.primitives[0],
    grown = new Float32Array(p.vertices.length + 20);
  grown.set(p.vertices);
  grown.set(p.vertices.subarray(0, 20), p.vertices.length);
  assert.throws(() => model.writeGeometry([{ vertices: grown, indices: p.indices }]), /keeps its vertex count/);
  model.writeGeometry([{ vertices: p.vertices.slice(), indices: p.indices.slice() }]);
  assert.throws(
    () => model.writeGeometry([{ vertices: grown, indices: p.indices, uvs: new Float32Array(16) }]),
    /four floats a vertex/,
  );
  const uvs = new Float32Array(20).fill(0.5);
  model.writeGeometry([{ vertices: grown, indices: p.indices.slice(), uvs }]);
  assert.equal(p.uvs, uvs);
  model.dispose();
  engine.dispose();
});

test('a Draco stream carries later sets through the decoder extras, as it does TEXCOORD_1', async () => {
  const { doc, buffers } = quad(),
    third = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
    fourth = third.slice().reverse(),
    primitive = doc.meshes[0].primitives[0],
    extra = (array) => ({ array, itemSize: 2, componentType: 5126 });
  primitive.extensions = {
    KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0, TEXCOORD_2: 1, TEXCOORD_3: 2 } },
  };
  doc.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 2 } } }];
  const asset = new GLTFAsset(doc, buffers, undefined, {
    draco: {
      decode: async () => ({
        positions: new Float32Array(12),
        vertexCount: 4,
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
        attributes: { TEXCOORD_2: extra(third), TEXCOORD_3: extra(fourth) },
      }),
    },
  });
  await asset.decode();
  assert.deepEqual(asset.accessor(primitive.attributes.TEXCOORD_2, 'VEC2'), third);
  assert.deepEqual(asset.accessor(primitive.attributes.TEXCOORD_3, 'VEC2'), fourth);
});

test('the worker budget counts later sets: their bytes are geometry too', () => {
  const { doc, buffers } = quad(),
    [primitive] = doc.meshes[0].primitives;
  doc.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 2 } } }];
  doc.meshes[0].primitives = [primitive, primitive, primitive];
  // Each primitive packs to 320 B of vertices, 24 B of indices and 64 B of later sets: 1,224 B over a limit of 4 x 300 B,
  // where the two arrays alone come to 1,032 B and fit.
  assert.throws(
    () => prepareAsset(new GLTFAsset(doc, buffers, undefined, {}, 300), []),
    /geometry exceeds byte budget/,
  );
});

test('writeGeometry allocates a later UV buffer for an optional material extension on an existing model', async () => {
  const { model } = await load({ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } });
  const p = model.primitives[0];
  assert.equal(p.uvs, undefined);
  const uvs = new Float32Array(p.vertices.length / 5).fill(0.25);
  model.writeGeometry([{ vertices: p.vertices, indices: p.indices, uvs }]);
  assert.equal(p.uvs, uvs);
  model.dispose();
});
