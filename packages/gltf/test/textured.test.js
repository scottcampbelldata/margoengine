import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGLTF, parseGLTF, parseGLTFAsync } from '../dist/index.js';
import { quantized } from '../dist/quantized.js';
import { textured, texturedAlphaMasks } from '../dist/textured.js';
import { documentOf, gpuEngine, headlessEngine, withBitmaps } from './helpers.js';

const png = new Uint8Array([137, 80, 78, 71]);
const close = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-5, `${i}: ${value} vs ${expected[i]}`));
};
const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
function file({ material = {}, uv = uvs, attributes, ...rest } = {}) {
  const views = [
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv,
    png,
    new Float32Array([0.5, 0.5, 0.25, 0.25, 0, 0]),
  ];
  const { doc, bytes } = documentOf(views, {
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 4, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    images: [{ bufferView: 3, mimeType: 'image/png' }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, ...material }],
    meshes: [
      { primitives: [{ attributes: attributes ?? { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TEXCOORD_1: 3 }, material: 0 }] },
    ],
    nodes: [{ mesh: 0 }],
    ...rest,
  });
  return { doc, bytes };
}
const load = (engine, { doc, bytes }, options = {}) =>
  parseGLTFAsync(engine, doc, [bytes], { extensions: [textured], ...options });
/** The floats of the one UV buffer the device was given. */
const uploadedUV = (device) => [...device.vertexUploads.at(-1)];

test('textured refuses the synchronous parse, and the root refuses the file without it', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = file();
    assert.throws(() => parseGLTF(engine, doc, [bytes], { extensions: [textured] }), /parseGLTFAsync/);
    assert.throws(() => parseGLTF(engine, doc, [bytes]), /gltf-pro/);
  } finally {
    engine.dispose();
  }
});

test('textured uploads the UVs of the set the material names, moved by KHR_texture_transform', async (t) => {
  const bitmaps = withBitmaps(t),
    { engine, device } = await gpuEngine(t);
  try {
    const plain = await load(engine, file());
    assert.deepEqual(uploadedUV(device), [...uvs]);
    plain.dispose();
    const second = await load(
      engine,
      file({ material: { pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 } } } }),
    );
    assert.deepEqual(uploadedUV(device), [0.5, 0.5, 0.25, 0.25, 0, 0]);
    second.dispose();
    const info = {
      index: 0,
      extensions: { KHR_texture_transform: { offset: [0.5, 0.25], scale: [2, 4], rotation: Math.PI / 2 } },
    };
    const turned = await load(
      engine,
      file({ material: { pbrMetallicRoughness: { baseColorTexture: info } }, extensionsRequired: ['KHR_texture_transform'] }),
    );
    // The extension's matrix: x' = cos sx u + sin sy v + ox, y' = -sin sx u + cos sy v + oy.
    close(uploadedUV(device), [0.5, 0.25, 0.5, -1.75, 4.5, 0.25]);
    turned.dispose();
    const moved = {
      index: 0,
      texCoord: 0,
      extensions: { KHR_texture_transform: { texCoord: 1 } },
    };
    const overridden = await load(engine, file({ material: { pbrMetallicRoughness: { baseColorTexture: moved } } }));
    assert.deepEqual(uploadedUV(device), [0.5, 0.5, 0.25, 0.25, 0, 0]);
    overridden.dispose();
    assert.equal(bitmaps.opened, 4);
    assert.equal(bitmaps.closed, 4);
  } finally {
    engine.dispose();
  }
});

test('textured reads normalized and quantized UVs', async (t) => {
  withBitmaps(t);
  const { engine, device } = await gpuEngine(t);
  try {
    const shorts = file({ uv: new Uint16Array([0, 0, 65535, 0, 0, 65535, 0]) });
    shorts.doc.accessors[2].componentType = 5123;
    shorts.doc.accessors[2].normalized = true;
    const normalized = await load(engine, shorts);
    close(uploadedUV(device), [...uvs]);
    normalized.dispose();
    const bytes = file({ uv: new Uint8Array([0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 0]) });
    bytes.doc.bufferViews[2].byteStride = 4;
    bytes.doc.accessors[2].componentType = 5121;
    bytes.doc.extensionsRequired = ['KHR_mesh_quantization'];
    const whole = await load(engine, bytes, { extensions: [quantized, textured] });
    assert.deepEqual(uploadedUV(device), [0, 0, 2, 0, 0, 3]);
    whole.dispose();
  } finally {
    engine.dispose();
  }
});

test('generated normals expand the UVs with the vertices', async (t) => {
  withBitmaps(t);
  const { engine, device } = await gpuEngine(t);
  try {
    const input = file({ attributes: { POSITION: 0, TEXCOORD_0: 2 } });
    const model = await load(engine, input);
    assert.deepEqual(uploadedUV(device), [...uvs]);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('a MASK with no texture needs no UVs and no image', async (t) => {
  const bitmaps = withBitmaps(t),
    { engine, device } = await gpuEngine(t);
  try {
    const input = file({
      material: { alphaMode: 'MASK', alphaCutoff: 0.25, pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.5] } },
      attributes: { POSITION: 0, NORMAL: 1 },
    });
    const model = await load(engine, input);
    assert.equal(bitmaps.opened, 0);
    assert.deepEqual([...device.uniformUploads.at(-1)], [0.5, 0.25, 0, 0]);
    assert.equal(model.meshes[0].material.data[3], 1);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('a cut-out keeps a depth pass that reads its alpha, and only a cut-out', async (t) => {
  withBitmaps(t);
  const { engine } = await gpuEngine(t);
  try {
    const cut = await load(engine, file({ material: { alphaMode: 'MASK', alphaCutoff: 0.25 } })),
      plain = await load(engine, file()),
      { geometrySurface } = await import('../../shared/mesh-source.js'),
      caster = geometrySurface(cut.meshes[0].geometry).caster;
    assert.equal(caster.stride, 80);
    assert.equal(caster.cutoff, 0.25);
    assert.equal(caster.vertexAlpha, false);
    assert.ok(caster.alphaTexture && caster.alphaSampler);
    assert.equal(geometrySurface(plain.meshes[0].geometry).caster, undefined);
    assert.deepEqual([...geometrySurface(plain.meshes[0].geometry).uv], [...uvs]);
    const geometry = cut.meshes[0].geometry;
    cut.dispose();
    assert.equal(geometrySurface(geometry), undefined);
    plain.dispose();
  } finally {
    engine.dispose();
  }
});

test('texturedAlphaMasks gives a cut-out its pixels, cutoff, factor and wrap, and other meshes none', async (t) => {
  withBitmaps(t);
  const { engine } = await gpuEngine(t);
  try {
    const input = file({
      material: {
        alphaMode: 'MASK',
        alphaCutoff: 0.25,
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 1, 1, 0.5] },
      },
      samplers: [{ wrapS: 33071, wrapT: 33648 }],
      textures: [{ source: 0, sampler: 0 }],
    });
    const cut = await load(engine, input),
      plain = await load(engine, file()),
      image = { width: 1, height: 1, data: [0, 0, 0, 255] },
      source = await texturedAlphaMasks(cut, { pixels: () => image });
    assert.deepEqual(source({ mesh: cut.meshes[0] }), { ...image, cutoff: 0.25, factor: 0.5, wrap: ['clamp', 'mirror'] });
    assert.equal(source({ mesh: plain.meshes[0] }), null);
    await assert.rejects(texturedAlphaMasks(cut, { signal: AbortSignal.abort(), pixels: () => image }));
    cut.dispose();
    plain.dispose();
  } finally {
    engine.dispose();
  }
});

test('materials with no map stay constant colour beside textured ones, and the document stays as it was', async (t) => {
  const bitmaps = withBitmaps(t),
    { engine } = await gpuEngine(t);
  try {
    const input = file();
    input.doc.materials.push({ pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 1] } });
    input.doc.meshes[0].primitives.push({ attributes: { POSITION: 0, NORMAL: 1 }, material: 1 });
    const before = JSON.stringify(input.doc),
      model = await load(engine, input);
    assert.equal(model.meshes.length, 2);
    assert.equal(JSON.stringify(input.doc), before);
    assert.equal(bitmaps.opened, 1);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('what the light path does not draw stays refused and rolls back', async (t) => {
  withBitmaps(t);
  const { engine } = await gpuEngine(t);
  try {
    const map = { baseColorTexture: { index: 0 } };
    await assert.rejects(load(engine, file({ material: { alphaMode: 'BLEND' } })), /gltf-pro/);
    await assert.rejects(load(engine, file({ material: { normalTexture: { index: 0 } } })), /gltf-pro/);
    await assert.rejects(
      load(engine, file({ material: { pbrMetallicRoughness: { ...map, metallicRoughnessTexture: { index: 0 } } } })),
      /gltf-pro/,
    );
    await assert.rejects(
      load(engine, file({ textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }] })),
      /gltf-pro/,
    );
    await assert.rejects(
      load(
        engine,
        file({
          material: { pbrMetallicRoughness: { baseColorTexture: { index: 0, extensions: { VENDOR_thing: {} } } } },
        }),
      ),
      /VENDOR_thing/,
    );
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('a malformed texture reference is a named error and rolls back', async (t) => {
  withBitmaps(t);
  const { engine } = await gpuEngine(t);
  try {
    const noSet = file({ attributes: { POSITION: 0, NORMAL: 1 } });
    await assert.rejects(load(engine, noSet), /TEXCOORD_0/);
    assert.equal(engine.meshes.size, 0);
    await assert.rejects(load(engine, file({ textures: [] })), /Missing glTF texture/);
    await assert.rejects(load(engine, file({ images: [] })), /Missing glTF image/);
    await assert.rejects(load(engine, file({ material: { alphaMode: 'MASK', alphaCutoff: 'x' } })), /alpha/);
    const short = file({ uv: new Float32Array([0, 0, 1, 0]) });
    short.doc.accessors[2].count = 2;
    await assert.rejects(load(engine, short), /fewer vertices/);
    assert.equal(engine.meshes.size, 0);
    const outside = file();
    outside.doc.bufferViews[3].byteLength = 1 << 20;
    await assert.rejects(load(engine, outside), /outside its buffer/);
    const stray = file();
    stray.doc.accessors[2].componentType = 5125;
    await assert.rejects(load(engine, stray), /Unsupported glTF accessor/);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('an image over the GPU limit is a RangeError and a WebGL engine is refused, both with nothing left behind', async (t) => {
  withBitmaps(t, { width: 1 << 15, height: 4 });
  const { engine } = await gpuEngine(t);
  try {
    await assert.rejects(load(engine, file()), /over this GPU/);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
  const { engine: webgl } = await headlessEngine();
  try {
    await assert.rejects(load(webgl, file()), /requires WebGPU/);
    assert.equal(webgl.meshes.size, 0);
  } finally {
    webgl.dispose();
  }
});

test('images come from data URIs, and from loadGLTF for a URL, inside its allowed places', async (t) => {
  const bitmaps = withBitmaps(t),
    { engine } = await gpuEngine(t);
  try {
    const inline = file();
    inline.doc.images = [{ uri: `data:image/png;base64,${Buffer.from(png).toString('base64')}` }];
    const model = await load(engine, inline);
    assert.deepEqual([...bitmaps.bytes.at(-1)], [...png]);
    model.dispose();

    const external = file();
    external.doc.images = [{ uri: 'map.png' }];
    await assert.rejects(load(engine, external), /use loadGLTF/);
    external.doc.buffers[0].uri = 'model.bin';
    const asked = [],
      get = async (url) => {
        asked.push(String(url));
        const path = String(url);
        return new Response(path.endsWith('.gltf') ? JSON.stringify(external.doc) : path.endsWith('.bin') ? external.bytes : png);
      };
    const url = 'https://example.test/a/model.gltf',
      loaded = await loadGLTF(engine, url, { fetch: get, extensions: [textured] });
    assert.deepEqual(asked.at(-1), 'https://example.test/a/map.png');
    loaded.dispose();
    external.doc.images = [{ uri: 'https://elsewhere.test/map.png' }];
    await assert.rejects(loadGLTF(engine, url, { fetch: get, extensions: [textured] }), TypeError);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('an aborted load builds nothing', async (t) => {
  withBitmaps(t);
  const { engine } = await gpuEngine(t);
  try {
    const signal = AbortSignal.abort();
    await assert.rejects(load(engine, file(), { signal }), { name: 'AbortError' });
    const late = new AbortController(),
      running = load(engine, file(), { signal: late.signal });
    late.abort();
    await assert.rejects(running, { name: 'AbortError' });
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('the plugin stays while a model holds it and leaves nothing on the device', async (t) => {
  withBitmaps(t);
  const { engine, device } = await gpuEngine(t);
  try {
    const a = await load(engine, file()),
      b = await load(engine, file());
    assert.equal(engine.plugins.size, 1);
    a.dispose();
    assert.equal(engine.plugins.size, 1);
    b.dispose();
    assert.equal(engine.plugins.size, 0);
    assert.equal(device.liveBuffers(), 0);
    assert.equal(device.liveTextures(), 0);
  } finally {
    engine.dispose();
  }
});
