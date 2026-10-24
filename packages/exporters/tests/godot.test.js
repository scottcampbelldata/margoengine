import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exportGLB, exportOBJ, paletteTexture, splitGLB, joinGLB } from '../dist/index.js';
import { createGodotImportBundle } from '../dist/godot.js';
import { createGodotImportAddon } from '../dist/godot-addon.js';
import { encodeZIP } from '../dist/capture.js';

const geometry = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 0, 1, 1, 1],
  indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
};
const scene = () => ({
  nodes: [
    { name: 'Stone', geometry, extras: { id: 'art' } },
    { name: 'Physics Stone-convcol', geometry, retainedVisibility: false, extras: { id: 'helper' } },
  ],
});
const options = (extra = {}) => ({
  folder: 'margo_exports/stone',
  convexHelperIds: ['helper'],
  ...extra,
});
const text = (bundle, suffix) =>
  new TextDecoder().decode(bundle.entries.find((entry) => entry.name.endsWith(suffix)).data);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const modify = (bytes, change) => {
  const parts = splitGLB(bytes);
  change(parts.json, parts.bin);
  return joinGLB(parts);
};
function animated(fps = [12]) {
  const source = scene();
  source.animations = fps.map((clock, i) => ({
    name: i ? 'Walk-loop' : 'Idle-loop',
    extras: { fps: clock, loop: true },
    channels: [
      {
        node: source.nodes[0],
        path: 'translation',
        interpolation: 'STEP',
        times: [0, 1 / clock, 2 / clock],
        values: [0, 0, 0, 1, 0, 0, 0, 0, 0],
      },
    ],
  }));
  return source;
}

test('Godot bundle is deterministic, hashes exact artifacts and preserves generic GLB/OBJ/source', async () => {
  const source = scene(),
    sourceBefore = structuredClone(source);
  const palette = await paletteTexture([12, 34, 56, 255, 91, 71, 33, 0]);
  source.nodes.forEach((node) => {
    node.material = { baseColorTexture: palette.texture };
  });
  const before = structuredClone(source),
    glb = exportGLB(source),
    obj = exportOBJ(source).obj;
  const bytes = Buffer.from(glb),
    baseline = Uint8Array.from(bytes);
  const pending = createGodotImportBundle(bytes, options());
  bytes.fill(0); // Buffer.slice is not an ownership boundary: the API must clone before its first await.
  const first = await pending,
    second = await createGodotImportBundle(glb, options());
  assert.deepEqual(first, second);
  assert.deepEqual(first.entries[0].data, Uint8Array.from(baseline));
  assert.equal(first.manifest.glbSHA256, sha(glb));
  assert.equal(first.entries.length, 5);
  for (const file of first.manifest.files) {
    const entry = first.entries.find((entry) => entry.name === file.name);
    assert.equal(file.bytes, entry.data.length);
    assert.equal(file.sha256, sha(entry.data));
  }
  assert.deepEqual(await encodeZIP(first.entries), await encodeZIP(second.entries));
  assert.deepEqual(source, before);
  assert.deepEqual(exportGLB(source), glb);
  assert.equal(exportOBJ(source).obj, obj);
  assert.deepEqual(
    sourceBefore.nodes.map((node) => node.geometry),
    source.nodes.map((node) => node.geometry),
  );
  const native = splitGLB(first.entries[0].data);
  assert.deepEqual(native.json, splitGLB(glb).json);
  assert.deepEqual(native.bin, splitGLB(glb).bin);
  second.entries[0].data.fill(0);
  assert.deepEqual(first.entries[0].data, glb);
});

test('Godot seed is project-local, portable at its declared folder and has no generated cache identity', async () => {
  const bundle = await createGodotImportBundle(exportGLB(scene()), options());
  const seed = text(bundle, '.glb.import'),
    script = text(bundle, '.gd');
  assert.match(seed, /source_file="res:\/\/margo_exports\/stone\/model.glb"/);
  assert.match(seed, /import_script\/path="res:\/\/margo_exports\/stone\/margo-import.gd"/);
  assert.match(seed, /gltf\/embedded_image_handling=3/);
  assert.match(seed, /meshes\/force_disable_compression=true/);
  assert.match(seed, /meshes\/generate_lods=false/);
  assert.match(seed, /animation\/remove_immutable_tracks=false/);
  assert.doesNotMatch(seed, /uid=|\.godot\/|dest_files|animation\/fps=/);
  assert.ok(!bundle.entries.some((entry) => entry.name.endsWith('project.godot')));
  assert.match(script, /create_convex_shape\(false, false\)/);
  assert.match(script, /relative != Transform3D.IDENTITY/);
  assert.match(script, /exact.margin = shapes\[0\].shape.margin/);
  assert.ok(script.indexOf('applied.size() != HELPER_IDS.size()') < script.indexOf('replacement.node.shape ='));
  assert.doesNotMatch(script, /set_surface|surface_update|material_override|\.mesh\s*=(?!=)|collision_layer =/);
  assert.match(script, /func fail\(scene: Node, replacements: Array, message: String\)/);
  assert.ok(script.indexOf('replacements.clear()') < script.indexOf('scene.free()'));
  assert.equal((script.match(/return null/g) ?? []).length, 1);
});

test('Godot path validation rejects escape, ambiguous native paths and reserved folders', async () => {
  const glb = exportGLB(scene());
  for (const folder of [
    '',
    '../stone',
    '/stone',
    'a//b',
    'a/./b',
    'a/../b',
    'a\\b',
    'C:/stone',
    'a\nb',
    'a/b.',
    'a/b ',
    'CON',
    'assets/Lpt1',
  ])
    await assert.rejects(createGodotImportBundle(glb, options({ folder })), TypeError);
  await assert.rejects(createGodotImportBundle(glb, null), TypeError);
  await assert.rejects(createGodotImportBundle('bad', options()), TypeError);
});

test('Godot semantic helper inventory rejects missing, duplicate, visible, wrong-suffix and meshless identities', async () => {
  const glb = exportGLB(scene());
  for (const ids of [[], ['missing'], ['helper', 'helper'], ['art'], [0], null])
    await assert.rejects(createGodotImportBundle(glb, options({ convexHelperIds: ids })), TypeError);
  const bad = [
    (d) => {
      d.nodes[0].extras.id = 'helper';
    },
    (d) => {
      delete d.nodes[1].extras;
    },
    (d) => {
      d.nodes[1].extras.id = '';
    },
    (d) => {
      delete d.nodes[1].extensions;
    },
    (d) => {
      d.nodes[1].name += '-extra';
    },
    (d) => {
      delete d.nodes[1].mesh;
    },
    (d) => {
      d.meshes[d.nodes[1].mesh].primitives = [];
    },
    (d) => {
      d.nodes[1].mesh = 999;
    },
    (d) => {
      d.nodes[0].children = [1, 1];
    },
    (d) => {
      d.nodes[1].children = [1];
    },
  ];
  for (const change of bad) await assert.rejects(createGodotImportBundle(modify(glb, change), options()));
  const art = exportGLB({ nodes: [scene().nodes[0]] });
  assert.equal((await createGodotImportBundle(art, options({ convexHelperIds: [] }))).manifest.helpers.length, 0);
});

test('Godot helper validation rejects skin, morph, instancing and animated ancestry without changing bytes', async () => {
  const glb = exportGLB(scene());
  for (const change of [
    (d) => {
      d.nodes[1].skin = 0;
    },
    (d) => {
      d.nodes[1].weights = [0];
    },
    (d) => {
      d.nodes[1].extensions.EXT_mesh_gpu_instancing = {};
    },
    (d) => {
      d.meshes[d.nodes[1].mesh].primitives[0].targets = [];
    },
    (d) => {
      d.meshes[d.nodes[1].mesh].primitives[0].attributes.JOINTS_0 = 0;
    },
  ]) {
    const bytes = modify(glb, change),
      before = bytes.slice();
    await assert.rejects(createGodotImportBundle(bytes, options()), { name: 'MargoError', code: 'unsupported' });
    assert.deepEqual(bytes, before);
  }
  const source = animated();
  source.nodes[0].children = [source.nodes.pop()];
  await assert.rejects(createGodotImportBundle(exportGLB(source), options()), /animated ancestry/);
});

test('Godot helper string data is escaped and sorted deterministically rather than inserted as code', async () => {
  const source = scene(),
    odd = 'quoted"\\\n雪\u2028helper';
  source.nodes[1].extras.id = odd;
  const bundle = await createGodotImportBundle(exportGLB(source), options({ convexHelperIds: [odd] }));
  const declaration = text(bundle, '.gd')
    .split('\n')
    .find((line) => line.startsWith('const HELPER_IDS := '));
  assert.deepEqual(JSON.parse(declaration.slice('const HELPER_IDS := '.length)), { [odd]: true });
});

test('Godot STEP clocks derive uniform FPS and require explicit compatible clocks for mixed sources', async () => {
  const uniform = await createGodotImportBundle(exportGLB(animated([12])), options());
  assert.equal(uniform.manifest.animationFPS, 12);
  assert.equal(uniform.manifest.animationFPSOrigin, 'metadata');
  assert.match(text(uniform, '.glb.import'), /animation\/fps=12/);
  const optimizer = { nodes: { 'PATH:AnimationPlayer': { 'optimizer/enabled': false, 'compression/enabled': false } } };
  assert.deepEqual(uniform.manifest.settings._subresources, optimizer);
  assert.ok(
    text(uniform, '.glb.import')
      .split('\n')
      .includes(`_subresources=${JSON.stringify(optimizer)}`),
  );
  assert.doesNotMatch(text(uniform, '.glb.import'), /^animation\/(?:optimizer|compression)\/enabled=/m);
  const nameCollision = animated();
  nameCollision.nodes[0].name = 'AnimationPlayer';
  await assert.rejects(createGodotImportBundle(exportGLB(nameCollision), options()), /generated AnimationPlayer path/);
  const glb = exportGLB(animated([12, 24]));
  await assert.rejects(createGodotImportBundle(glb, options()), /mixed or missing/);
  await assert.rejects(createGodotImportBundle(glb, options({ fps: 12 })), /cannot represent/);
  const mixed = await createGodotImportBundle(glb, options({ fps: 24 }));
  assert.equal(mixed.manifest.animationFPSOrigin, 'explicit');
  assert.deepEqual(
    mixed.manifest.animations.map((clip) => clip.declaredFPS),
    [12, 24],
  );
  assert.deepEqual(mixed.entries[0].data, glb);
  assert.equal(
    (await createGodotImportBundle(exportGLB(animated([12, 30])), options({ fps: 60 }))).manifest.animationFPS,
    60,
  );
  const noMetadata = modify(exportGLB(animated()), (d) => {
    delete d.animations[0].extras;
  });
  await assert.rejects(createGodotImportBundle(noMetadata, options()), /provide fps/);
  await createGodotImportBundle(noMetadata, options({ fps: 12 }));
});

test('Godot self-contained delivery rejects additional buffers and out-of-range geometry or image ownership', async () => {
  const glb = exportGLB(scene());
  for (const buffer of [
    { byteLength: 48, uri: '../../unowned.bin' },
    { byteLength: 48, uri: 'data:application/octet-stream;base64,AAAA' },
    { byteLength: 48 },
  ]) {
    const bytes = modify(glb, (d) => {
      d.buffers.push(buffer);
      const accessor = d.accessors[d.meshes[0].primitives[0].attributes.POSITION];
      d.bufferViews[accessor.bufferView].buffer = 1;
      d.bufferViews[accessor.bufferView].byteOffset = 0;
    });
    const before = Uint8Array.from(bytes);
    await assert.rejects(createGodotImportBundle(bytes, options()), /embedded buffer 0/);
    assert.deepEqual(bytes, before);
  }
  const invalid = [
    (d) => {
      d.bufferViews[0].buffer = 1;
    },
    (d) => {
      d.bufferViews[0].byteOffset = d.buffers[0].byteLength;
    },
    (d) => {
      d.bufferViews[0].byteLength = Number.MAX_SAFE_INTEGER;
    },
    (d) => {
      d.bufferViews[0].byteOffset = -1;
    },
    (d) => {
      d.meshes[0].primitives[0].attributes.POSITION = 999;
    },
    (d) => {
      d.meshes[0].primitives[0].indices = 999;
    },
    (d) => {
      d.accessors[0].bufferView = 999;
    },
    (d) => {
      d.accessors[0].count = 999999;
    },
    (d) => {
      d.accessors[0].byteOffset = 1;
    },
    (d) => {
      d.bufferViews[d.accessors[0].bufferView].byteStride = 999;
    },
    (d) => {
      d.accessors[0].sparse = {};
    },
    (d) => {
      d.bufferViews[0].extensions = { EXT_meshopt_compression: {} };
    },
    (d) => {
      d.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: {} };
    },
    (d) => {
      d.images = [{ mimeType: 'image/png', bufferView: 999 }];
    },
  ];
  for (const change of invalid) await assert.rejects(createGodotImportBundle(modify(glb, change), options()));
  const withImage = scene();
  const palette = await paletteTexture([23, 45, 67, 255]);
  withImage.nodes[0].material = { baseColorTexture: palette.texture };
  const imageGLB = exportGLB(withImage);
  await assert.rejects(
    createGodotImportBundle(
      modify(imageGLB, (d) => {
        d.bufferViews[d.images[0].bufferView].byteLength = d.buffers[0].byteLength + 1;
      }),
      options(),
    ),
    /bufferView exceeds/,
  );
  const ordinary = await createGodotImportBundle(glb, options());
  assert.deepEqual(ordinary.entries[0].data, glb);
  assert.equal(
    ordinary.manifest.settings._subresources,
    undefined,
    'Static delivery does not invent an AnimationPlayer setting',
  );
});

test('Godot timing rejects malformed clock/accessor/curve paths and ambiguous Float32 grid points', async () => {
  const glb = exportGLB(animated());
  for (const fps of [0, -1, NaN, Infinity])
    await assert.rejects(createGodotImportBundle(glb, options({ fps })), RangeError);
  await assert.rejects(createGodotImportBundle(glb, options({ fps: '12' })), TypeError);
  for (const change of [
    (d) => {
      d.animations[0].samplers[0].interpolation = 'LINEAR';
    },
    (d) => {
      d.animations[0].channels[0].target.node = 999;
    },
    (d) => {
      d.accessors[d.animations[0].samplers[0].input].count = 999999;
    },
    (d) => {
      d.accessors[d.animations[0].samplers[0].input].sparse = {};
    },
  ])
    await assert.rejects(createGodotImportBundle(modify(glb, change), options()));
  const offGrid = scene();
  offGrid.animations = [
    {
      name: 'Hold',
      extras: { fps: 12 },
      channels: [
        {
          node: offGrid.nodes[0],
          path: 'translation',
          interpolation: 'STEP',
          times: [0, 0.125],
          values: [0, 0, 0, 1, 0, 0],
        },
      ],
    },
  ];
  await assert.rejects(createGodotImportBundle(exportGLB(offGrid), options()), /cannot represent/);
  const huge = scene();
  huge.animations = [
    {
      name: 'Late',
      extras: { fps: 12 },
      channels: [
        {
          node: huge.nodes[0],
          path: 'translation',
          interpolation: 'STEP',
          times: [0, 2 ** 24],
          values: [0, 0, 0, 1, 0, 0],
        },
      ],
    },
  ];
  await assert.rejects(createGodotImportBundle(exportGLB(huge), options()), /cannot represent/);
});

test('Godot refuses external image payloads and unavailable SHA-256 instead of producing partial files', async () => {
  const glb = exportGLB(scene());
  await assert.rejects(
    createGodotImportBundle(
      modify(glb, (d) => {
        d.images = [{ uri: 'unowned.png', mimeType: 'image/png' }];
      }),
      options(),
    ),
    /embedded PNG/,
  );
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try {
    await assert.rejects(createGodotImportBundle(glb, options()), { name: 'MargoError', code: 'unsupported' });
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});

test('the import add-on binds linear vertex colors and applies extras.loop', async () => {
  const entries = createGodotImportAddon(),
    files = Object.fromEntries(entries.map(({ name, data }) => [name, new TextDecoder().decode(data)])),
    extension = files['addons/gltf_import/extension.gd'];
  assert.deepEqual(Object.keys(files), [
    'addons/gltf_import/plugin.cfg',
    'addons/gltf_import/plugin.gd',
    'addons/gltf_import/extension.gd',
  ]);
  assert.match(files['addons/gltf_import/plugin.cfg'], /name="glTF vertex colors and loops"\n[^]*script="plugin.gd"/);
  assert.match(files['addons/gltf_import/plugin.gd'], /register_gltf_document_extension\(extension\)/);
  assert.match(extension, /^@tool\nextends GLTFDocumentExtension\n/);
  assert.match(extension, /func _import_post_parse\(state: GLTFState\) -> Error:/);
  assert.match(extension, /attributes\.has\("COLOR_0"\)/);
  assert.match(extension, /vertex_color_is_srgb = false/);
  assert.match(extension, /extras\.get\("loop"\) is bool/);
  assert.match(extension, /animations\[i\]\.loop = extras\.loop/);
  assert.ok(
    extension.split('\n').every((line) => !line.startsWith(' ')),
    'GDScript indents with tabs only',
  );
  assert.ok((await encodeZIP(entries)) instanceof Uint8Array);
});
