// gltf audit KB-GLTFA regressions: each test fails on the source before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGLTF, parseGLTF, parseGLTFAsync } from '../dist/index.js';
import { parseGLTF as parsePBR } from '../dist/pbr.js';
import { textured } from '../dist/textured.js';
import { documentOf, gpuEngine, headlessEngine, withBitmaps } from './helpers.js';

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const triangle = (rest = {}, accessors = []) =>
  documentOf([positions], {
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      ...accessors,
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    ...rest,
  });
function glb(doc, bin) {
  const text = new TextEncoder().encode(JSON.stringify(doc)),
    size = (text.length + 3) & ~3,
    binSize = (bin.length + 3) & ~3,
    out = new Uint8Array(28 + size + binSize),
    view = new DataView(out.buffer);
  out.fill(0x20, 20, 20 + size);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, size, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  view.setUint32(20 + size, binSize, true);
  view.setUint32(24 + size, 0x004e4942, true);
  out.set(bin, 28 + size);
  return out;
}

test('a primitive without POSITION is skipped and the rest of the mesh loads, in both loaders (3.7.2.1)', async (t) => {
  const make = () => triangle({ meshes: [{ primitives: [{ attributes: { POSITION: 0 } }, { attributes: {} }] }] });
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = make();
    assert.equal(parseGLTF(engine, doc, [bytes]).meshes.length, 1);
  } finally {
    engine.dispose();
  }
  const pbr = await gpuEngine(t);
  try {
    const { doc, bytes } = make();
    assert.equal(parsePBR(pbr.engine, doc, [bytes]).primitives.length, 1);
  } finally {
    pbr.engine.dispose();
  }
});

test('asset.version 2.x loads unless minVersion asks for more than 2.0, in both loaders (3.2)', async (t) => {
  const cases = [
    [{ version: '2.1', minVersion: '2.0' }, true],
    [{ version: '2.1' }, true],
    [{ version: '2.0' }, true],
    [{ version: '2.1', minVersion: '2.1' }, false],
    [{ version: '3.0' }, false],
    [{ version: '2' }, false],
    [{}, false],
  ];
  const { engine } = await headlessEngine(),
    pbr = await gpuEngine(t);
  try {
    for (const [asset, loads] of cases)
      for (const [name, parse, target] of [
        ['light', parseGLTF, engine],
        ['pbr', parsePBR, pbr.engine],
      ]) {
        const { doc, bytes } = triangle();
        doc.asset = asset;
        if (loads) parse(target, doc, [bytes]).dispose();
        else assert.throws(() => parse(target, doc, [bytes]), /Expected glTF 2\.0/, `${name} ${JSON.stringify(asset)}`);
      }
  } finally {
    engine.dispose();
    pbr.engine.dispose();
  }
});

test('the light loader draws an OPAQUE colour whatever its alpha, and never checks an unused material (3.9.4)', async () => {
  const { engine } = await headlessEngine();
  try {
    const opaque = triangle({
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.5] } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    });
    const model = parseGLTF(engine, opaque.doc, [opaque.bytes]);
    assert.deepEqual([...model.meshes[0].material.data.slice(0, 3)], [1, 0, 0]);
    model.dispose();
    const unused = triangle({ materials: [{ alphaMode: 'BLEND' }] });
    parseGLTF(engine, unused.doc, [unused.bytes]).dispose();
    const used = triangle({
      materials: [{ alphaMode: 'BLEND' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    });
    assert.throws(() => parseGLTF(engine, used.doc, [used.bytes]), /gltf\/pbr/);
    const missing = triangle({ meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 3 }] }] });
    assert.throws(() => parseGLTF(engine, missing.doc, [missing.bytes]), /Missing material/);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('loadGLTF gives the GLB BIN chunk to buffer 0 only, as parseGLTF does (3.6.1.2)', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = triangle();
    // Buffer 0 is an external file; buffer 1 has no URI, so it has no data.
    doc.buffers = [{ uri: 'a.bin', byteLength: 4 }, { byteLength: bytes.length }];
    doc.bufferViews[0].buffer = 1;
    const file = glb(doc, bytes),
      fetch = async (url) => new Response(String(url).endsWith('.glb') ? file : new Uint8Array(4));
    await assert.rejects(loadGLTF(engine, 'https://example.test/m.glb', { fetch }), /Truncated glTF buffer/);
    assert.throws(() => parseGLTF(engine, file, [new Uint8Array(4)]), /Truncated glTF buffer/);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test("the light loader's 64 MiB download limit is an unsupported refusal that names gltf/pbr", async () => {
  const { engine } = await headlessEngine();
  try {
    const fetch = async () =>
      new Response(new Uint8Array(4), { headers: { 'content-length': String(65 * 1024 * 1024) } });
    await assert.rejects(loadGLTF(engine, 'https://example.test/m.glb', { fetch }), (error) => {
      assert.equal(error.code, 'unsupported');
      assert.match(error.message, /gltf\/pbr/);
      assert.doesNotMatch(error.message, /maxBytes/);
      return true;
    });
  } finally {
    engine.dispose();
  }
});

const png = new Uint8Array([137, 80, 78, 71]);
function texturedFile({ images = [{ bufferView: 1, mimeType: 'image/png' }], materials, attributes } = {}) {
  return documentOf([positions, png, new Float32Array([0, 0, 1, 0, 0, 1])], {
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    images,
    textures: images.map((_, source) => ({ source })),
    materials: materials ?? [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ primitives: [{ attributes: attributes ?? { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
  });
}
const loadTextured = (engine, { doc, bytes }, options = {}) =>
  parseGLTFAsync(engine, doc, [bytes], { extensions: [textured], ...options });

test('a failed or aborted textured load closes every bitmap it decoded and leaves no plugin or buffer', async (t) => {
  const bitmaps = withBitmaps(t),
    { engine, device } = await gpuEngine(t),
    decode = globalThis.createImageBitmap;
  const settled = (label) => {
    assert.equal(bitmaps.closed, bitmaps.opened, `${label}: every bitmap closed`);
    assert.equal(engine.meshes.size, 0, `${label}: no mesh`);
    assert.equal(engine.scene.plugins.has('gltf-textured'), false, `${label}: no plugin`);
    assert.equal(device.liveBuffers(), 0, `${label}: no GPU buffer`);
  };
  try {
    // A good load keeps its bitmap until dispose.
    const model = await loadTextured(engine, texturedFile());
    assert.equal(bitmaps.opened - bitmaps.closed, 1);
    model.dispose();
    settled('dispose');
    // Aborted after the decode.
    const controller = new AbortController();
    globalThis.createImageBitmap = async (blob) => {
      const bitmap = await decode(blob);
      controller.abort();
      return bitmap;
    };
    await assert.rejects(loadTextured(engine, texturedFile(), { signal: controller.signal }), /abort/i);
    globalThis.createImageBitmap = decode;
    settled('abort');
    // Refused by the root after the images decoded (a used BLEND material beside the textured one).
    const refused = texturedFile({
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, { alphaMode: 'BLEND' }],
    });
    refused.doc.meshes[0].primitives.push({ attributes: { POSITION: 0 }, material: 1 });
    await assert.rejects(loadTextured(engine, refused), /gltf\/pbr/);
    settled('refused');
    // `finish` throws: the material needs TEXCOORD_0 and the primitive has none.
    await assert.rejects(loadTextured(engine, texturedFile({ attributes: { POSITION: 0 } })), /TEXCOORD_0/);
    settled('finish');
    // One image fails to decode while a slower one is still in flight.
    const two = texturedFile({
      images: [
        { bufferView: 1, mimeType: 'image/png' },
        { bufferView: 1, mimeType: 'image/png' },
      ],
      materials: [
        { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
        { pbrMetallicRoughness: { baseColorTexture: { index: 1 } } },
      ],
    });
    two.doc.meshes[0].primitives.push({ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 1 });
    let calls = 0;
    globalThis.createImageBitmap = async (blob) => {
      if (calls++ === 0) throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      await new Promise((resolve) => setTimeout(resolve, 20));
      return decode(blob);
    };
    await assert.rejects(loadTextured(engine, two), /glTF image 0 could not be decoded/);
    globalThis.createImageBitmap = decode;
    settled('decode');
    // The upload throws: the image is over this GPU's texture size.
    device.limits.maxTextureDimension2D = 2;
    await assert.rejects(loadTextured(engine, texturedFile()), /over this GPU/);
    device.limits.maxTextureDimension2D = 8192;
    settled('upload');
  } finally {
    globalThis.createImageBitmap = decode;
    engine.dispose();
  }
});

test('a bad image or bad base64 is a TypeError that names the image', async (t) => {
  withBitmaps(t);
  const { engine } = await gpuEngine(t);
  try {
    globalThis.createImageBitmap = async () => {
      throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
    };
    await assert.rejects(loadTextured(engine, texturedFile()), (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /glTF image 0 could not be decoded/);
      return true;
    });
    await assert.rejects(
      loadTextured(engine, texturedFile({ images: [{ uri: 'data:image/png;base64,QUJD=' }] })),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /glTF image 0 has a data: URI with invalid base64/);
        return true;
      },
    );
  } finally {
    engine.dispose();
  }
});

test('images downloading together cannot pass the 64 MiB download limit between them (KB-GLTFA B15)', async (t) => {
  withBitmaps(t);
  const { engine } = await gpuEngine(t);
  try {
    const { doc, bytes } = texturedFile({
      images: [{ uri: 'a.png' }, { uri: 'b.png' }, { uri: 'c.png' }],
      materials: [0, 1, 2].map((index) => ({ pbrMetallicRoughness: { baseColorTexture: { index } } })),
    });
    doc.meshes[0].primitives = [0, 1, 2].map((material) => ({ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material }));
    const image = new Uint8Array(30 * 1024 * 1024),
      fetch = async (url) => new Response(String(url).endsWith('.glb') ? glb(doc, bytes) : image);
    await assert.rejects(
      loadGLTF(engine, 'https://example.test/m.glb', { fetch, extensions: [textured] }),
      (error) => error.code === 'unsupported' && /64 MiB/.test(error.message),
    );
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('KB-GLTFA B1: a node with a zero scale loads in both loaders, as TRS and as a matrix (3.5.3)', async (t) => {
  const cases = [
    [{ scale: [1, 0, 1] }, [1, 0, 1]],
    [{ scale: [0, 0, 0] }, [0, 0, 0]],
    [{ matrix: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1] }, [1, 0, 1]],
    [{ matrix: [0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] }, [0, 2, 0]],
    [{ matrix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] }, [0, 0, 0]],
    // Rotated a quarter turn about +Z, flattened on its local x.
    [{ matrix: [0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, [0, 1, 1]],
  ];
  const check = (engine, node, expected, label) => {
    engine.store.tick(false);
    const m = Array.from(node.matrix);
    assert.ok(m.every(Number.isFinite), `${label}: ${m}`);
    assert.deepEqual(
      [node.scale.x, node.scale.y, node.scale.z].map((v) => Math.abs(v)),
      expected,
      label,
    );
  };
  const { engine } = await headlessEngine();
  try {
    for (const [transform, expected] of cases) {
      const { doc, bytes } = triangle({ nodes: [{ mesh: 0, ...transform }] });
      const scene = parseGLTF(engine, doc, [bytes]);
      check(engine, scene.nodes[0], expected, `light ${JSON.stringify(transform)}`);
      scene.dispose();
    }
    // Dependent nonzero columns with a zero one stay refused: no rotation fits them.
    const { doc, bytes } = triangle({ nodes: [{ mesh: 0, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] }] });
    assert.throws(() => parseGLTF(engine, doc, [bytes]), /Sheared|Singular/);
  } finally {
    engine.dispose();
  }
  const pbr = await gpuEngine(t);
  try {
    for (const [transform, expected] of cases) {
      const { doc, bytes } = triangle({ nodes: [{ mesh: 0, ...transform }] });
      const model = parsePBR(pbr.engine, doc, [bytes]);
      check(pbr.engine, model.nodes[0], expected, `pbr ${JSON.stringify(transform)}`);
      model.dispose();
    }
  } finally {
    pbr.engine.dispose();
  }
});

// Runs `body(parse, engine)` with the light loader and with gltf/pbr.
async function bothLoaders(t, body) {
  const { engine } = await headlessEngine();
  try {
    await body(parseGLTF, engine, 'light');
  } finally {
    engine.dispose();
  }
  const pbr = await gpuEngine(t, 128);
  try {
    await body(parsePBR, pbr.engine, 'pbr');
  } finally {
    pbr.engine.dispose();
  }
}

test('KB-GLTFA A5: a bad translation, rotation or scale names its node, in both loaders', async (t) => {
  await bothLoaders(t, (parse, engine, label) => {
    for (const [key, value] of [
      ['translation', [1, 2]],
      ['rotation', [0, 0, 0]],
      ['scale', [1, Number.NaN, 1]],
    ]) {
      const nodes = [{}, {}, {}, { mesh: 0, [key]: value }];
      const { doc, bytes } = triangle({ nodes, scenes: [{ nodes: [0, 1, 2, 3] }] });
      assert.throws(
        () => parse(engine, doc, [bytes]),
        (e) => e instanceof TypeError && e.message.includes(`${key} on node 3`),
        `${label} ${key}`,
      );
    }
  });
});

test('KB-GLTFA A6: a sheared node matrix is a TypeError that names the node and the fix, in both loaders', async (t) => {
  await bothLoaders(t, (parse, engine, label) => {
    const matrix = [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const { doc, bytes } = triangle({ nodes: [{}, { mesh: 0, matrix }], scenes: [{ nodes: [0, 1] }] });
    assert.throws(
      () => parse(engine, doc, [bytes]),
      (e) =>
        e instanceof TypeError && /Sheared glTF matrix on node 1/.test(e.message) && /bake the shear/.test(e.message),
      label,
    );
  });
});

test('KB-GLTFA A4: a cycle and the 62-level limit have their own messages, in both loaders', async (t) => {
  await bothLoaders(t, (parse, engine, label) => {
    // 63 nodes in one chain: the last is 63 levels deep.
    const deep = Array.from({ length: 63 }, (_, i) => (i < 62 ? { children: [i + 1] } : { mesh: 0 }));
    const chain = triangle({ nodes: deep, scenes: [{ nodes: [0] }] });
    assert.throws(
      () => parse(engine, chain.doc, [chain.bytes]),
      (e) =>
        e instanceof RangeError && /node 62 is 63 levels deep/.test(e.message) && /62 levels at most/.test(e.message),
      `${label} depth`,
    );
    // A 62-node chain, 62 levels deep, still loads.
    const fits = triangle({
      nodes: deep.slice(0, 62).map((n, i) => (i < 61 ? n : { mesh: 0 })),
      scenes: [{ nodes: [0] }],
    });
    parse(engine, fits.doc, [fits.bytes]).dispose();
    const loop = triangle({ nodes: [{ mesh: 0, children: [1] }, { children: [0] }], scenes: [{ nodes: [] }] });
    assert.throws(
      () => parse(engine, loop.doc, [loop.bytes]),
      (e) => e instanceof TypeError && /cycle through node/.test(e.message),
      `${label} cycle`,
    );
  });
});

test('KB-GLTFA A1: a blob: URL is refused with the way to load its bytes, in both loaders and loadAuto', async (t) => {
  const { loadAuto } = await import('../dist/auto.js');
  const { loadGLTF: loadPBR } = await import('../dist/pbr.js');
  const { engine } = await headlessEngine();
  try {
    for (const [label, load] of [
      ['light', () => loadGLTF(engine, 'blob:https://example.com/0f1e')],
      ['pbr', () => loadPBR(engine, 'blob:https://example.com/0f1e')],
      ['auto', () => loadAuto(engine, 'blob:https://example.com/0f1e')],
    ])
      await assert.rejects(load, (e) => e instanceof TypeError && /parseGLTFAsync/.test(e.message), label);
  } finally {
    engine.dispose();
  }
});

test('KB-GLTFA A8: `using` disposes a light model, as it does a PBRModel', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = triangle();
    let released = 0;
    {
      using model = parseGLTF(engine, doc, [bytes]);
      // The model's release disposes every mesh it made, the root last.
      const dispose = model.root.dispose.bind(model.root);
      model.root.dispose = () => (released++, dispose());
    }
    assert.equal(released, 1);
  } finally {
    engine.dispose();
  }
});

test('KB-GLTFA A7: the light loader lists model.nodes and model.meshes depth first in file order', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = triangle({
      // One mesh per node, told apart by its material's roughness (0.1 for a0 ... 0.4 for b).
      meshes: [0.1, 0.2, 0.3, 0.4].map((_, material) => ({ primitives: [{ attributes: { POSITION: 0 }, material }] })),
      materials: [0.1, 0.2, 0.3, 0.4].map((roughnessFactor) => ({ pbrMetallicRoughness: { roughnessFactor } })),
      nodes: [
        { name: 'a', children: [2, 3] },
        { name: 'b', mesh: 3 },
        { name: 'a0', mesh: 0 },
        { name: 'a1', mesh: 1, children: [4] },
        { name: 'a1x', mesh: 2 },
      ],
      scenes: [{ nodes: [0, 1] }],
    });
    using model = parseGLTF(engine, doc, [bytes]);
    assert.deepEqual(
      model.nodes.map((n) => n.name),
      ['a', 'a0', 'a1', 'a1x', 'b'],
    );
    const tags = [0.1, 0.2, 0.3, 0.4].map(Math.fround);
    assert.deepEqual(
      model.meshes.map((m) => tags.findIndex((v) => m.material.data.includes(v))),
      [0, 1, 2, 3],
    );
  } finally {
    engine.dispose();
  }
});

test('KB-GLTFA A9: a gltf/pbr parse that throws closes the images it was given, wherever it failed', async (t) => {
  const pbrModule = await import('../dist/pbr.js');
  const pbr = await gpuEngine(t);
  const bitmaps = () => {
    const record = { closed: 0 };
    return { record, images: [{ width: 4, height: 4, close: () => record.closed++ }] };
  };
  const { doc, bytes } = triangle();
  const cases = [
    // container: not glTF at all
    ['parseGLTF, bad JSON', (images) => pbrModule.parseGLTF(pbr.engine, '{not json', [], images)],
    // GLTFAsset: a major version the loader does not read
    ['parseGLTF, glTF 3.0', (images) => pbrModule.parseGLTF(pbr.engine, { ...doc, asset: { version: '3.0' } }, [bytes], images)],
    // the model constructor: an image that is neither a bitmap nor valid RGBA pixels
    [
      'parseGLTF, bad pixels',
      (images) =>
        pbrModule.parseGLTF(pbr.engine, doc, [bytes], [...images, { width: 2, height: 2, data: new Uint8Array(3) }]),
    ],
    ['parsePreparedPBR, not static', (images) => pbrModule.parsePreparedPBR(pbr.engine, doc, [], images)],
    ['parseGLTFAsync, bad JSON', (images) => pbrModule.parseGLTFAsync(pbr.engine, '{not json', [], images)],
  ];
  for (const [label, run] of cases) {
    const { record, images } = bitmaps();
    await assert.rejects(async () => run(images), label);
    assert.equal(record.closed, 1, `${label}: the caller's bitmap is closed once`);
  }
  // A parse that succeeds holds the bitmap until dispose.
  const { record, images } = bitmaps();
  const model = pbrModule.parseGLTF(pbr.engine, doc, [bytes], images);
  assert.equal(record.closed, 0);
  model.dispose();
  assert.equal(record.closed, 1);
});
