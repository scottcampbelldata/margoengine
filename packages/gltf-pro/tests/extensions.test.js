import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { extname, resolve } from 'node:path';
import { extendedMaterials } from '../dist/extended.js';
import { GLTFAsset, PBRModel, parseGLTF, parseGLTFAsync } from '../dist/index.js';
import {
  pbrShader,
  extendedPBRShader,
  physicalShader as physical,
  transmissiveShader,
  transparentPBR,
  capturePBR,
} from '../src/shader.ts';
import { lightPBR } from '../../shared/pbr-hooks.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { MeshoptDecoder } from '../../decoders/dist/index.js';
import { decodeDraco, initBasis, initDraco, transcodeKTX2 } from '../../decoders/dist/codec.js';
import { Clustered } from '../../clustered/dist/index.js';
import { Shadows } from '../../shadows/dist/index.js';
import { materialShader } from '../../materials/dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// The real Draco and Basis Wasm run in-process (Emscripten needs CommonJS globals and HTTP URLs), as in the decoders tests.
globalThis.require ??= createRequire(import.meta.url);
globalThis.__dirname ??= fileURLToPath(new URL('../../decoders/tests/', import.meta.url));
const decoders = fileURLToPath(new URL('../../decoders/', import.meta.url)),
  fixture = (name) => readFile(resolve(decoders, 'tests/fixtures', name));
const server = createServer(async (request, response) => {
  try {
    const file = resolve(decoders, 'dist', '.' + new URL(request.url, 'http://x').pathname);
    response.writeHead(200, { 'content-type': extname(file) === '.wasm' ? 'application/wasm' : 'text/javascript' });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
// Client closes idle sockets: a server keep-alive close can race a reused socket under load (ECONNRESET).
server.keepAliveTimeout = 0;
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}/`,
  load = async (url) => {
    (0, eval)(await (await fetch(url)).text());
  };
test.after(() => server.close());

const types = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 },
  physicalShader = physical();
function triangle(material = {}) {
  const buffers = [],
    bufferViews = [],
    accessors = [];
  const add = (data, type, componentType = 5126, extra = {}) => {
    const id = buffers.length;
    buffers.push(data);
    bufferViews.push({ buffer: id, byteLength: data.byteLength, ...extra.view });
    accessors.push({
      bufferView: id,
      componentType,
      count: extra.count ?? data.length / types[type],
      type,
      ...extra.accessor,
    });
    return id;
  };
  const attributes = {
    POSITION: add(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), 'VEC3'),
    NORMAL: add(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 'VEC3'),
    TEXCOORD_0: add(new Float32Array([0, 0, 1, 0, 0.5, 1]), 'VEC2'),
    TEXCOORD_1: add(new Float32Array([0, 0, 1, 0, 0.5, 1]), 'VEC2'),
  };
  const doc = {
    asset: { version: '2.0' },
    buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
    bufferViews,
    accessors,
    meshes: [{ primitives: [{ attributes, material: 0 }] }],
    materials: [material],
    nodes: [{ mesh: 0 }],
  };
  return { doc, buffers, add };
}
async function headless() {
  return new Engine({ width: 64, height: 64, clientWidth: 64, clientHeight: 64 }, await TransformStore.create(64), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
}
async function gpu() {
  const h = optionalGPU(),
    device = h.engine.gpu,
    store = await TransformStore.create(64),
    uploads = [],
    calls = [];
  device.queue.writeTexture = (...args) => uploads.push(args);
  device.queue.copyExternalImageToTexture = (...args) => uploads.push(['bitmap', ...args]);
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(128 / 96, true);
  const encoder = {
    beginRenderPass: () => ({
      setPipeline: (p) => calls.push(['pipeline', p]),
      setBindGroup: (i, g) => calls.push(['group', i, g]),
      setBlendConstant: (c) => calls.push(['constant', c]),
      setVertexBuffer() {},
      setIndexBuffer() {},
      drawIndexed() {},
      end() {},
    }),
  };
  const draw = (model) => {
    calls.length = 0;
    store.tick(false);
    const context = { ...h.context, camera: engine.camera, encoder };
    model.draw(context, 'beauty', context.color, context.depth);
    return calls;
  };
  return { h, engine, device, uploads, draw };
}
const bitmap = () => ({
  width: 1,
  height: 1,
  close() {
    this.closed = true;
  },
});
const close = (actual, expected) =>
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-6, `${[...actual]} vs ${expected}`));

test('only required extensions that are still unsupported are rejected, each listed with the missing decoder', () => {
  const { doc, buffers } = triangle();
  doc.extensionsRequired = [
    'KHR_mesh_quantization',
    'KHR_texture_transform',
    'KHR_materials_unlit',
    'KHR_materials_emissive_strength',
    'KHR_lights_punctual',
    'KHR_materials_clearcoat',
    'KHR_materials_transmission',
    'KHR_materials_ior',
    'KHR_materials_volume',
    'KHR_materials_sheen',
    'KHR_materials_specular',
    'EXT_texture_webp',
    'EXT_texture_avif',
    'EXT_mesh_gpu_instancing',
  ];
  assert.doesNotThrow(() => new GLTFAsset(doc, buffers));
  doc.extensionsRequired.push(
    'KHR_draco_mesh_compression',
    'EXT_meshopt_compression',
    'KHR_texture_basisu',
    'KHR_animation_pointer',
  );
  assert.throws(() => new GLTFAsset(doc, buffers), {
    message: 'Required glTF extensions are unsupported: KHR_animation_pointer',
  });
  assert.throws(() => new GLTFAsset(doc, buffers, undefined, { draco: {}, meshopt: {}, ktx2: {} }), {
    message: 'Required glTF extensions are unsupported: KHR_animation_pointer',
  });
});

test('KHR_mesh_quantization admits integer positions, normals and texture coordinates', async () => {
  const engine = await headless(),
    { doc, buffers, add } = triangle();
  try {
    const p = doc.meshes[0].primitives[0].attributes;
    p.POSITION = add(new Int16Array([-100, -100, 0, 0, 100, -100, 0, 0, 0, 100, 0, 0]), 'VEC3', 5122, {
      count: 3,
      view: { byteStride: 8 },
    });
    p.NORMAL = add(new Int8Array([0, 0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0]), 'VEC3', 5120, {
      count: 3,
      view: { byteStride: 4 },
      accessor: { normalized: true },
    });
    p.TEXCOORD_0 = add(new Int16Array([0, 0, 2, 0, 1, 2]), 'VEC2', 5122);
    doc.buffers = buffers.map((b) => ({ byteLength: b.byteLength }));
    assert.throws(() => new PBRModel(engine, new GLTFAsset(doc, buffers)), /Expected Float32 POSITION/);
    doc.extensionsUsed = doc.extensionsRequired = ['KHR_mesh_quantization'];
    const v = new PBRModel(engine, new GLTFAsset(doc, buffers)).primitives[0].vertices;
    assert.deepEqual([...v.subarray(20, 27)], [100, -100, 0, 1, 0, 0, 1]);
    assert.deepEqual([...v.subarray(20 + 12, 20 + 14)], [2, 0]);
  } finally {
    engine.dispose();
  }
});

test('EXT_meshopt_compression decodes through the meshopt hook with the real decoder, once per view, over a fallback buffer', async () => {
  const vectors = JSON.parse(await fixture('meshopt-vectors.json')),
    find = (name) => vectors.cases.find((c) => c.name === name),
    bytes = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));
  const streams = ['exponential', 'octahedral8', 'triangles16'].map(find),
    encoded = streams.map((s) => bytes(s.encoded)),
    offsets = [];
  const packed = new Uint8Array(
    encoded.reduce((n, e) => {
      offsets.push(n);
      return n + Math.ceil(e.length / 4) * 4;
    }, 0),
  );
  encoded.forEach((e, i) => packed.set(e, offsets[i]));
  let at = 0;
  const bufferViews = streams.map((s, i) => {
    const view = {
      buffer: 1,
      byteOffset: at,
      byteLength: s.count * s.stride,
      ...(s.mode === 'ATTRIBUTES' ? { byteStride: s.stride } : {}),
      extensions: {
        EXT_meshopt_compression: {
          buffer: 0,
          byteOffset: offsets[i],
          byteLength: encoded[i].length,
          byteStride: s.stride,
          count: s.count,
          mode: s.mode,
          filter: s.filter,
        },
      },
    };
    at += view.byteLength;
    return view;
  });
  const doc = {
    asset: { version: '2.0' },
    extensionsUsed: ['EXT_meshopt_compression', 'KHR_mesh_quantization'],
    extensionsRequired: ['EXT_meshopt_compression', 'KHR_mesh_quantization'],
    buffers: [
      { byteLength: packed.length },
      { byteLength: at, extensions: { EXT_meshopt_compression: { fallback: true } } },
    ],
    bufferViews,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 169, type: 'VEC3' },
      { bufferView: 1, componentType: 5122, normalized: true, count: 169, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 864, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    nodes: [{ mesh: 0 }],
  };
  assert.deepEqual(
    new GLTFAsset(doc, [packed]).view(0),
    bytes(streams[0].expected),
    'built-in meshopt is available without a hook',
  );
  let decodes = 0;
  const meshopt = {
    decodeGltfBuffer(...args) {
      decodes++;
      return MeshoptDecoder.decodeGltfBuffer(...args);
    },
  };
  const asset = new GLTFAsset(doc, [packed], undefined, { meshopt });
  assert.deepEqual(asset.view(0), bytes(streams[0].expected));
  asset.view(0);
  assert.equal(decodes, 1, 'decoded views are cached');
  const expected = bytes(streams[0].expected);
  assert.deepEqual(
    asset.accessor(0),
    new Float32Array(expected.buffer.slice(expected.byteOffset, expected.byteOffset + 169 * 12)),
  );
  const engine = await headless();
  try {
    const model = new PBRModel(engine, asset);
    assert.equal(model.primitives[0].vertices.length, 169 * 20);
    assert.equal(model.primitives[0].indices.length, 864);
    assert.equal(decodes, 3);
  } finally {
    engine.dispose();
  }
  const failure = new Error('bad stream');
  assert.throws(
    () =>
      new GLTFAsset(doc, [packed], undefined, {
        meshopt: {
          decodeGltfBuffer() {
            throw failure;
          },
        },
      }).view(1),
    (error) => error === failure,
  );
});

test('KHR_draco_mesh_compression decodes the Khronos Box and Avocado through the draco hook with the real Wasm decoder', async () => {
  const { module: draco } = await initDraco(
      base + 'draco/draco_wasm_wrapper.js',
      base + 'draco/draco_decoder.wasm',
      load,
    ),
    requests = [];
  const hook = {
      decode: async (data, options) => {
        requests.push(options);
        return decodeDraco(draco, data, options);
      },
    },
    engine = await headless();
  try {
    for (const name of ['Box', 'Avocado']) {
      const doc = JSON.parse(await fixture(`${name}.gltf`)),
        bin = await fixture(`${name}.bin`),
        p = doc.meshes[0].primitives[0];
      assert.throws(() => new PBRModel(engine, new GLTFAsset(doc, [bin])), /requires parseGLTFAsync or loadGLTF/);
      const asset = new GLTFAsset(doc, [bin], undefined, { draco: hook });
      await asset.decode();
      assert.deepEqual(requests.at(-1).attributeIds, p.extensions.KHR_draco_mesh_compression.attributes);
      const model = new PBRModel(engine, asset),
        primitive = model.primitives[0],
        position = doc.accessors[p.attributes.POSITION];
      assert.equal(primitive.vertices.length, position.count * 20);
      assert.equal(primitive.indices.length, doc.accessors[p.indices].count);
      for (let i = 0; i < primitive.vertices.length; i += 20)
        for (let c = 0; c < 3; c++)
          assert.ok(
            primitive.vertices[i + c] >= position.min[c] - 1e-4 && primitive.vertices[i + c] <= position.max[c] + 1e-4,
          );
      if (name === 'Avocado') {
        assert.equal(requests.at(-1).componentTypes.TANGENT, 5126);
        assert.ok(
          primitive.vertices.some((v, i) => i % 20 === 12 && v > 0),
          'Draco UVs reach the vertex layout',
        );
      }
      model.dispose();
    }
  } finally {
    engine.dispose();
  }
  const { doc, buffers } = triangle(),
    p = doc.meshes[0].primitives[0];
  p.extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0, TEXCOORD_1: 1 } } };
  doc.accessors[3] = { componentType: 5121, normalized: true, count: 3, type: 'VEC2' };
  const fake = (result) => new GLTFAsset(doc, buffers, undefined, { draco: { decode: async () => result } });
  const asset = fake({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    attributes: { TEXCOORD_1: { array: new Uint8Array([255, 0, 0, 255, 51, 102]) } },
  });
  await asset.decode();
  assert.deepEqual([...asset.accessor(0)], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  close(asset.accessor(3), [1, 0, 0, 1, 0.2, 0.4]);
  await assert.rejects(
    fake({ positions: new Float32Array(6) }).decode(),
    /(?:Mismatched glTF Draco|Invalid glTF Draco|Invalid glTF Draco vertex)/,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    fake({ positions: new Float32Array(9), attributes: { TEXCOORD_1: { array: new Float32Array(6) } } }).decode(
      aborted.signal,
    ),
    /abort/i,
  );
});

test('parseGLTFAsync decodes Draco with the real Wasm; a KTX2 texture beats its PNG fallback with the selected KTX2 decoder', async () => {
  const { module: basis } = await initBasis(
      base + 'basis/basis_transcoder.js',
      base + 'basis/basis_transcoder.wasm',
      load,
    ),
    { module: draco } = await initDraco(base + 'draco/draco_wasm_wrapper.js', base + 'draco/draco_decoder.wasm', load);
  const box = JSON.parse(await fixture('Box.gltf')),
    bin = await fixture('Box.bin');
  {
    const { engine } = await gpu();
    await assert.rejects(
      parseGLTFAsync(engine, structuredClone(box), { buffers: [bin] }),
      /needs a browser with Web Workers/,
    );
    const model = await parseGLTFAsync(engine, structuredClone(box), {
      buffers: [bin],
      decoders: { draco: { decode: async (data, options) => decodeDraco(draco, data, options) } },
    });
    assert.equal(model.primitives[0].indices.length, 36);
    model.dispose();
    engine.dispose();
  }
  const ktx = await fixture('AnisotropyBarnLamp_normalbump.ktx2'),
    { doc, buffers } = triangle({ normalTexture: { index: 0 } });
  doc.buffers.push({ byteLength: ktx.length });
  doc.bufferViews.push({ buffer: buffers.length, byteLength: ktx.length });
  buffers.push(ktx);
  doc.images = [
    { bufferView: doc.bufferViews.length - 1, mimeType: 'image/ktx2' },
    { uri: 'data:image/png;base64,AAAA' },
  ];
  doc.textures = [{ source: 1, extensions: { KHR_texture_basisu: { source: 0 } } }];
  const bitmaps = [];
  globalThis.createImageBitmap = async () => {
    const b = bitmap();
    bitmaps.push(b);
    return b;
  };
  try {
    for (const ktx2 of [{ transcode: async (data) => transcodeKTX2(basis, data, 'bc7') }]) {
      const { engine, device, uploads } = await gpu(),
        textures = [],
        create = device.createTexture;
      device.createTexture = (d) => {
        textures.push(d);
        return create(d);
      };
      const model = await parseGLTFAsync(engine, structuredClone(doc), { buffers, decoders: { ktx2 } });
      const normal = textures.find((t) => t.size[0] > 1);
      assert.deepEqual([normal.format, normal.mipLevelCount, ...normal.size], ['bc7-rgba-unorm', 1, 2048, 2048, 1]);
      const [destination, data, layout, size] = uploads.find((u) => u[0].texture?.format === 'bc7-rgba-unorm');
      assert.deepEqual(
        [destination.mipLevel, data.byteLength, layout.bytesPerRow, layout.rowsPerImage, ...size],
        [0, 512 * 512 * 16, 512 * 16, 2048, 2048, 2048, 1],
      );
      model.dispose();
      engine.dispose();
    }
    assert.ok(
      bitmaps.every((b) => b.closed),
      'decoded images close with the model',
    );
  } finally {
    delete globalThis.createImageBitmap;
  }
});

test('KHR_texture_transform, emissive strength and unlit reach the material uniforms; identity transforms pass UVs through', async () => {
  const { engine, draw } = await gpu();
  const transform = { offset: [0.5, 0.25], rotation: Math.PI / 2, scale: [2, 3], texCoord: 1 };
  const { doc, buffers } = triangle({
    pbrMetallicRoughness: { baseColorTexture: { index: 0, extensions: { KHR_texture_transform: transform } } },
    emissiveFactor: [0.5, 0.25, 0],
    extensions: { KHR_materials_emissive_strength: { emissiveStrength: 4 }, KHR_materials_unlit: {} },
  });
  doc.textures = [{ source: 0 }];
  const model = parseGLTF(engine, doc, buffers, [bitmap()]),
    m = model.primitives[0].material;
  try {
    assert.equal(m.maps[0].texCoord, 1, 'the transform overrides texCoord');
    assert.deepEqual(m.emission, [2, 1, 0]);
    const calls = draw(model),
      uniform = new Float32Array(calls.find((c) => c[0] === 'group' && c[1] === 0)[2].entries[0].resource.buffer.data);
    assert.equal(uniform[100], 1, 'unlit flag');
    assert.equal(uniform[101], 1.5, 'default IOR');
    // offset * rotation * scale: (u,v)=(1,0) -> (0.5, -1.75); (0,1) -> (3.5, 0.25).
    const row = (k) => [...uniform.subarray(104 + k * 4, 107 + k * 4)],
      apply = (u, v) => [row(0), row(1)].map((r) => r[0] * u + r[1] * v + r[2]);
    close(apply(1, 0), [0.5, -1.75]);
    close(apply(0, 1), [3.5, 0.25]);
    assert.equal(uniform[107], 1, 'UV set in the first row');
    assert.deepEqual([...uniform.subarray(112, 120)], [1, 0, 0, 0, -0, 1, 0, 0], 'untransformed maps get the identity');
    assert.ok(extendedPBRShader.includes('if(f.ext.x>0.5){color=s.base.rgb;}'));
    assert.ok(
      calls.find((c) => c[0] === 'pipeline')[1].vertex.module.code.includes('if(f.ext.x>0.5){color=s.base.rgb;}'),
    );
  } finally {
    model.dispose();
    engine.dispose();
  }
});

test('KHR_lights_punctual and cameras are exposed as data, and point/spot lights map onto clustered lights', async () => {
  const engine = await headless(),
    { doc, buffers } = triangle(),
    s = Math.SQRT1_2;
  doc.extensions = {
    KHR_lights_punctual: {
      lights: [
        { type: 'point', color: [1, 0.5, 0], intensity: 20, range: 5, name: 'bulb' },
        { type: 'spot', intensity: 100, spot: { innerConeAngle: 0.2, outerConeAngle: 0.6 } },
        { type: 'directional', intensity: 3 },
      ],
    },
  };
  doc.cameras = [{ type: 'perspective', perspective: { yfov: 0.8, znear: 0.1, aspectRatio: 1.5 } }];
  doc.nodes.push(
    { translation: [1, 2, 3], extensions: { KHR_lights_punctual: { light: 0 } } },
    { translation: [0, 4, 0], rotation: [-s, 0, 0, s], extensions: { KHR_lights_punctual: { light: 1 } }, camera: 0 },
    { extensions: { KHR_lights_punctual: { light: 2 } } },
  );
  try {
    const model = new PBRModel(engine, new GLTFAsset(doc, buffers));
    assert.deepEqual(
      model.lights.map((l) => [l.type, l.nodeIndex, l.intensity]),
      [
        ['point', 1, 20],
        ['spot', 2, 100],
        ['directional', 3, 3],
      ],
    );
    assert.deepEqual(
      [model.lights[1].innerConeAngle, model.lights[1].outerConeAngle, model.lights[2].color],
      [0.2, 0.6, [1, 1, 1]],
    );
    assert.deepEqual(
      [model.cameras[0].type, model.cameras[0].perspective.yfov, model.cameras[0].node],
      ['perspective', 0.8, model.nodes[2]],
    );
    const lights = model.clusteredLights();
    assert.equal(lights.length, 2, 'directional lights stay with engine lighting');
    assert.deepEqual([lights[0].position, lights[0].range, lights[0].color], [[1, 2, 3], 5, [1, 0.5, 0]]);
    close(lights[1].position, [0, 4, 0]);
    close(lights[1].direction, [0, -1, 0]);
    assert.equal(lights[1].range, 160);
    new Clustered().setLights(lights);
    model.dispose();
    doc.extensions.KHR_lights_punctual.lights[1].spot.innerConeAngle = 0.6;
    assert.throws(() => new PBRModel(engine, new GLTFAsset(doc, buffers)), /Invalid glTF light/);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('physical extensions select the physical shader variant, its maps and the transmission blend; plain materials keep the base shader', async () => {
  const { engine, draw, h } = await gpu();
  const physical = {
    pbrMetallicRoughness: { baseColorFactor: [0.5, 1, 1, 1] },
    extensions: {
      KHR_materials_clearcoat: {
        clearcoatFactor: 0.8,
        clearcoatRoughnessFactor: 0.2,
        clearcoatTexture: { index: 0 },
        clearcoatNormalTexture: { index: 0, scale: 0.5 },
      },
      KHR_materials_sheen: {
        sheenColorFactor: [0.3, 0.2, 0.1],
        sheenRoughnessFactor: 0.4,
        sheenColorTexture: { index: 0 },
      },
      KHR_materials_specular: { specularFactor: 0.7, specularColorFactor: [1, 0.9, 0.8] },
      KHR_materials_ior: { ior: 1.33 },
      KHR_materials_transmission: { transmissionFactor: 0.9 },
      KHR_materials_volume: { thicknessFactor: 2, attenuationDistance: 1, attenuationColor: [1, 0.5, 0.25] },
    },
  };
  const { doc, buffers } = triangle(physical);
  doc.materials.push({});
  doc.meshes.push({ primitives: [{ ...doc.meshes[0].primitives[0], material: 1 }] });
  doc.nodes.push({ mesh: 1 });
  doc.textures = [{ source: 0 }];
  const model = parseGLTF(engine, doc, buffers, [bitmap()], { materials: extendedMaterials }),
    [glass, plain] = model.primitives.map((p) => p.material);
  try {
    assert.equal(glass.maps.length, 13);
    assert.equal(plain.maps.length, 5);
    assert.equal(plain.physical, undefined);
    assert.equal(plain.tint, undefined);
    close(glass.physical, [0.8, 0.2, 0.5, 0.9, 1, 0.9, 0.8, 0.7, 0.3, 0.2, 0.1, 0.4]);
    close(glass.tint, [0.5 * 0.9, 0.9 * 0.25, 0.9 * 0.0625]);
    const calls = draw(model),
      pipelines = calls.filter((c) => c[0] === 'pipeline').map((c) => c[1]),
      groups = calls.filter((c) => c[0] === 'group' && c[1] === 1).map((c) => c[2].entries.length);
    assert.equal(
      pipelines[0].vertex.module.code,
      pbrShader,
      'opaque plain material draws first with the unchanged base shader',
    );
    // Transmission (5w.f): the transmissive physical variant, drawn twice: the background times the tint, then the lit surface added.
    assert.equal(pipelines[1].vertex.module.code, transmissiveShader());
    assert.equal(pipelines[2].vertex.module, pipelines[1].vertex.module);
    assert.deepEqual(
      pipelines.slice(1).map((p) => [p.fragment.entryPoint, p.fragment.targets[0].blend.color]),
      [
        ['margoTint', { srcFactor: 'zero', dstFactor: 'src' }],
        ['fragment', { srcFactor: 'one', dstFactor: 'one' }],
      ],
    );
    assert.deepEqual(groups, [10, 26]);
    assert.equal(pipelines[2].depthStencil.depthWriteEnabled, false);
    assert.ok(!calls.some((c) => c[0] === 'constant'), 'no blend constant');
    const formats = h.resources.filter((r) => r.format).map((r) => r.format);
    assert.equal(
      formats.filter((f) => f === 'rgba8unorm-srgb').length,
      4,
      'base, emissive and specular-color defaults plus the sheen color image',
    );
    const uniform = new Float32Array(
      calls.filter((c) => c[0] === 'group' && c[1] === 0)[1][2].entries[0].resource.buffer.data,
    );
    close(uniform.subarray(208, 220), glass.physical);
    close([uniform[101]], [1.33]);
  } finally {
    model.dispose();
    engine.dispose();
  }
});

test('lighting hooks (contract v1): every hook point occurs once in both variants and shadows, clustered, IBL and fog compose in any order', () => {
  // gltf-pro's side of the contract; shadows, clustered and environment test their side (their `pbr(group)` contributions).
  const points = [
    'direct+ambient(s)',
    'var color=',
    'if(f.settings.w<0.5) {color=aces(max(color,vec3f(0))/0.6);',
    'return vec4f(color,',
  ];
  for (const source of [pbrShader, physicalShader]) {
    for (const point of points) assert.equal(source.split(point).length, 2, point);
    assert.equal(source.match(/fn ambient\(s:Surface\)->vec3f \{[^}]*\}/g).length, 1);
    assert.equal(source.match(/var color=([^;]+)\+s\.emissive;/g).length, 1);
  }
  assert.ok(!pbrShader.includes('@binding(10)') && !pbrShader.includes('fn layers'));
  for (let binding = 10; binding < 26; binding++) assert.ok(physicalShader.includes(`@group(1) @binding(${binding})`));
  const ibl = { declarations: '// ibl\n', ambient: 'vec3f(0.5)*s.occlusion' },
    fog = { declarations: '// fog\n', output: (c) => `mix(${c},vec3f(1),0.5)` };
  // Declarations stack in front in insertion order; the shader body is the same in every order.
  const effects = [new Shadows().pbr(2), new Clustered().pbr(2), ibl, fog],
    head = physicalShader.slice(0, 200);
  const compose = (order) => {
    const code = order.map((k) => effects[k]).reduce(lightPBR, physicalShader);
    return code.slice(code.indexOf(head));
  };
  const body = compose([0, 1, 2, 3]);
  for (const order of [
    [3, 2, 1, 0],
    [1, 3, 0, 2],
    [2, 0, 3, 1],
  ])
    assert.equal(compose(order), body, order.join());
  assert.match(
    body,
    /let margoAmbient=vec3f\(0\.5\)\*s\.occlusion;var color=clusterLighting\([^;]+\)\+shadowLit\(direct,i\.position,s\.n\)\+ambient\(s\)\+s\.emissive\+margoAmbient;\n  color=layers\(s,v,l,color\);/,
  );
  assert.match(body, /fn ambient\(s:Surface\)->vec3f \{return vec3f\(0\);\}/);
  assert.match(
    body,
    /color=mix\(select\(color,aces\(max\(color,vec3f\(0\)\)\/0\.6\),f\.settings\.w<0\.5\),vec3f\(1\),0\.5\);if\(f\.settings\.w<0\.5\) \{/,
  );
  assert.throws(
    () => lightPBR(lightPBR(pbrShader, ibl), { declarations: '', ambient: 'vec3f(1)' }),
    /hook point missing or used twice/,
    'one ambient effect',
  );
  assert.equal(lightPBR(pbrShader, fog), lightPBR(pbrShader, fog), 'cached per hooks object');
  // @margoengine/materials rewrites the five base-map samples and the fragment head of either variant.
  for (const source of [pbrShader, physicalShader])
    for (const shading of ['standard', 'basic']) assert.match(materialShader(source, 2, shading), /mat_baseMap/);
});

test('transparency hook (contract v1): the fragment head occurs once in both variants, lit and material-patched, and becomes margoShade + a transparent entry', () => {
  const declarations = '// oit\n',
    lit = lightPBR(lightPBR(physicalShader, new Shadows().pbr(2)), {
      declarations: '// fog\n',
      output: (c) => `mix(${c},vec3f(1),0.5)`,
    });
  for (const source of [
    pbrShader,
    physicalShader,
    lit,
    materialShader(pbrShader, 2, 'basic'),
    materialShader(physicalShader, 2, 'standard'),
  ]) {
    const code = transparentPBR(source, declarations);
    assert.ok(code.startsWith(declarations));
    assert.equal(code.split('fn margoShade(i:Out,front:bool)->vec4f {').length, 2);
    assert.ok(!code.includes('@fragment fn fragment('));
    assert.match(
      code,
      /@fragment fn transparent\(i:Out,@builtin\(front_facing\) front:bool\)->MargoTransparent \{return margoTransparent\(margoShade\(i,front\),i\);\}\n$/,
    );
    assert.equal(
      code
        .replace(declarations, '')
        .replace(
          'fn margoShade(i:Out,front:bool)->vec4f {',
          '@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {',
        )
        .split('\n@fragment fn transparent(')[0],
      source,
      'nothing else changes',
    );
    assert.equal(transparentPBR(source, declarations), code, 'cached');
  }
  assert.throws(() => transparentPBR(transparentPBR(pbrShader, ''), ''), /transparency hook point missing/);
});

test('capture hook (contract v1): lit and material-patched variants get a capture entry with the lighting in a dead margoShade call', () => {
  const declarations = '// ssr\n',
    lit = lightPBR(lightPBR(physicalShader, new Shadows().pbr(2)), {
      declarations: '// ibl\n',
      ambient: 'vec3f(0.5)*s.occlusion',
    });
  for (const source of [
    pbrShader,
    physicalShader,
    lit,
    materialShader(pbrShader, 2, 'standard'),
    materialShader(physicalShader, 2, 'basic'),
  ]) {
    const code = capturePBR(source, declarations),
      k = source.includes('fn layers(')
        ? 'layers(s,v,normalize(f.light.xyz),vec3f(1))-layers(s,v,normalize(f.light.xyz),vec3f(0))'
        : 'vec3f(1)';
    assert.ok(code.startsWith(declarations));
    assert.ok(!code.includes('@fragment fn fragment('));
    assert.ok(
      code.endsWith(
        `\n@fragment fn capture(i:Out,@builtin(front_facing) front:bool)->MargoCapture {if(false){_=margoShade(i,front);}let s=surface(i,front);let v=normalize(f.eye.xyz-i.position);return margoCapture(s,v,${k});}\n`,
      ),
    );
    assert.equal(
      code
        .replace(declarations, '')
        .replace(
          'fn margoShade(i:Out,front:bool)->vec4f {',
          '@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {',
        )
        .split('\n@fragment fn capture(')[0],
      source,
      'nothing else changes',
    );
    assert.equal(capturePBR(source, declarations), code, 'cached');
  }
  assert.throws(() => capturePBR(capturePBR(pbrShader, ''), ''), /capture hook point missing/);
});
