import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exportGLB, exportOBJ, paletteTexture, splitGLB, joinGLB } from '../dist/index.js';
import { createGodotImportBundle } from '../dist/godot.js';
import { createUnityImportBundle, createUnityImportSupportPackage } from '../dist/unity.js';
import { encodeZIP } from '../dist/capture.js';

const geometry = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 0, 1, 1, 1],
  indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
};
const options = (extra = {}) => ({ folder: 'Assets/Margo/Ranger', ...extra });
const sha = (data) => createHash('sha256').update(data).digest('hex');
const file = (bundle, suffix) => bundle.entries.find((e) => e.name.endsWith(suffix));
const json = (bundle, suffix) => JSON.parse(new TextDecoder().decode(file(bundle, suffix).data));
function modify(bytes, change) {
  const p = splitGLB(bytes);
  change(p.json, p.bin);
  return joinGLB(p);
}
async function fixture({ animated = false, helper = false } = {}) {
  const texture = (await paletteTexture([12, 34, 56, 255, 91, 71, 33, 0])).texture;
  const art = { name: 'Art', geometry, material: { baseColorTexture: texture }, extras: { id: 'art' } };
  const scene = { nodes: [art] };
  if (helper)
    scene.nodes.push({
      name: 'Helper-convcol',
      geometry,
      material: art.material,
      retainedVisibility: false,
      extras: { id: 'helper' },
    });
  if (animated)
    scene.animations = [
      {
        name: 'Walk-loop',
        extras: { fps: 12, loop: true },
        channels: [
          {
            node: art,
            path: 'translation',
            interpolation: 'STEP',
            times: [0, 1 / 12, 2 / 12],
            values: [0, 0, 0, 1, 0, 0, 0, 0, 0],
          },
        ],
      },
    ];
  return { scene, glb: exportGLB(scene, { generator: 'Margo Mesh Studio' }) };
}

test('Unity asset-only delivery owns async inputs and preserves source/general/Godot bytes', async () => {
  const { scene, glb } = await fixture({ animated: true });
  const before = structuredClone(scene),
    obj = exportOBJ(scene).obj;
  const godotBefore = await createGodotImportBundle(glb, {
    folder: 'margo/ranger',
    convexHelperIds: [],
  });
  const input = Buffer.from(glb),
    config = options();
  const pending = createUnityImportBundle(input, config);
  input.fill(0);
  config.folder = 'Assets/Changed';
  config.colliders = false;
  const a = await pending,
    b = await createUnityImportBundle(glb, options());
  assert.deepEqual(a, b);
  assert.equal(a.entries.length, 5);
  assert.ok(a.entries.every((e) => e.name.startsWith('Assets/Margo/Ranger/')));
  assert.deepEqual(file(a, '/model.glb').data, glb);
  const p = splitGLB(glb),
    view = p.json.bufferViews[p.json.images[0].bufferView];
  assert.deepEqual(
    file(a, '/atlas.png').data,
    p.bin.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength),
  );
  const profile = json(a, '/margo-profile.json');
  assert.equal(profile.source.glbSHA256, sha(glb));
  assert.equal(profile.source.pngSHA256, sha(file(a, '/atlas.png').data));
  assert.equal(profile.source.width, 2);
  assert.equal(profile.source.height, 2);
  assert.deepEqual(profile.clips, [{ animationIndex: 0, name: 'Walk-loop', fps: 12, loop: true }]);
  assert.equal(profile.generateColliders, true);
  assert.equal(profile.sampler.mipmaps, false);
  assert.equal(profile.sampler.dataColorSpace, 'srgb');
  for (const f of a.manifest.files) {
    const e = a.entries.find((e) => e.name === f.name);
    assert.equal(f.bytes, e.data.length);
    assert.equal(f.sha256, sha(e.data));
  }
  assert.deepEqual(await encodeZIP(a.entries), await encodeZIP(b.entries));
  assert.deepEqual(scene, before);
  assert.deepEqual(exportGLB(scene, { generator: 'Margo Mesh Studio' }), glb);
  assert.equal(exportOBJ(scene).obj, obj);
  assert.deepEqual(await createGodotImportBundle(glb, { folder: 'margo/ranger', convexHelperIds: [] }), godotBefore);
  file(b, '/model.glb').data.fill(0);
  assert.deepEqual(file(a, '/model.glb').data, glb);
});

test('Unity support is a separate immutable artifact with exact payload/dependency hashes', async () => {
  const a = await createUnityImportSupportPackage(),
    b = await createUnityImportSupportPackage();
  assert.deepEqual(a, b);
  assert.equal(a.manifest.version, '0.3.0');
  assert.deepEqual(a.manifest.requires, { unity: '6000.6.7f1', gltfast: '6.20.0' });
  const manifest = file(a, '/support-manifest.json');
  for (const f of a.manifest.files) {
    const e = a.entries.find((e) => e.name === 'Packages/com.margo.mesh/' + f.path);
    assert.ok(e);
    assert.equal(f.bytes, e.data.length);
    assert.equal(f.sha256, sha(e.data));
  }
  assert.ok(a.manifest.files.every((f) => f.path !== 'support-manifest.json'));
  const { glb } = await fixture(),
    asset = await createUnityImportBundle(glb, options());
  assert.equal(asset.manifest.support.manifestSHA256, sha(manifest.data));
  assert.deepEqual(json(asset, '/margo-profile.json').support, asset.manifest.support);
  assert.ok(asset.entries.every((e) => !e.name.startsWith('Packages/') && !e.name.endsWith('.meta')));
  const other = await createUnityImportBundle(glb, options({ folder: 'Assets/Margo/Other' }));
  assert.deepEqual(other.manifest.support, asset.manifest.support);
  const packageInfo = json(a, '/package.json');
  assert.equal(packageInfo.name, 'com.margo.mesh');
  assert.equal(packageInfo.version, '0.3.0');
  manifest.data.fill(0);
  assert.notEqual(sha(file(b, '/support-manifest.json').data), sha(manifest.data));
});

test('Unity folder validation rejects escape, case-ambiguous roots and native special folders', async () => {
  const { glb } = await fixture();
  for (const folder of [
    'Assets',
    'assets/Margo',
    '/Assets/Margo',
    'C:/Assets/Margo',
    'Assets/../Margo',
    'Assets/./Margo',
    'Assets\\Margo',
    'Assets//Margo',
    'Assets/Margo/',
    'Packages/Margo',
    'ProjectSettings/Margo',
    'Library/Margo',
    'Assets/Editor/Margo',
    'Assets/eDiToR/Margo',
    'Assets/Resources/Margo',
    'Assets/Plugins/Margo',
    'Assets/StreamingAssets/Margo',
    // Unity's asset database silently skips folders named cvs: the bundle would never import.
    'Assets/CVS',
    'Assets/Margo/cvs',
    'Assets/CON',
    'Assets/a.Margo',
    'Assets/a:b',
    'Assets/a\nB',
  ])
    await assert.rejects(createUnityImportBundle(glb, options({ folder })), TypeError);
  for (const colliders of [null, 0, 1, 'true', {}])
    await assert.rejects(createUnityImportBundle(glb, options({ colliders })), TypeError);
  await assert.rejects(createUnityImportBundle(glb, null), TypeError);
});

test('Unity atlas profile rejects material/sampler changes instead of silently rewriting them', async () => {
  const { glb } = await fixture();
  const changes = [
    (j) => j.materials.push(structuredClone(j.materials[0])),
    (j) => j.textures.push({ ...j.textures[0] }),
    (j) => j.images.push({ ...j.images[0] }),
    (j) => j.samplers.push({ ...j.samplers[0] }),
    (j) => (j.samplers[0].magFilter = 9729),
    (j) => (j.samplers[0].minFilter = 9984),
    (j) => (j.samplers[0].wrapS = 10497),
    (j) => delete j.samplers[0].wrapT,
    (j) => (j.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord = 1),
    (j) =>
      (j.materials[0].pbrMetallicRoughness.baseColorTexture.extensions = {
        KHR_texture_transform: { offset: [0.1, 0] },
      }),
    (j) => (j.materials[0].normalTexture = { index: 0 }),
    (j) => (j.materials[0].extensions = { KHR_materials_unlit: {} }),
    (j) => (j.textures[0].extensions = { KHR_texture_basisu: { source: 0 } }),
    (j) => (j.meshes[0].primitives[0].material = 1),
  ];
  for (const change of changes) {
    const bad = modify(glb, change),
      copy = Uint8Array.from(bad);
    await assert.rejects(createUnityImportBundle(bad, options()));
    assert.deepEqual(bad, copy);
  }
});

test('Unity rejects external, sparse, compressed or out-of-range payload ownership', async () => {
  const { glb } = await fixture();
  for (const change of [
    (j) => j.buffers.push({ uri: 'other.bin', byteLength: 4 }),
    (j) => (j.images[0].uri = 'https://invalid.test/a.png'),
    (j) => (j.images[0].mimeType = 'image/jpeg'),
    (j) => (j.bufferViews[j.images[0].bufferView].byteLength = 1e8),
    (j) => (j.accessors[0].count = 1e8),
    (j) => (j.accessors[0].sparse = {}),
    (j) => (j.bufferViews[0].extensions = { EXT_meshopt_compression: {} }),
    (j) => (j.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: {} }),
  ])
    await assert.rejects(createUnityImportBundle(modify(glb, change), options()));
});

test('Unity rejects unsupported PNG headers and dimensions without reencoding pixels', async () => {
  const { glb } = await fixture();
  for (const change of [
    (b) => (b[0] = 0),
    (b) => (b[24] = 16),
    (b) => (b[25] = 2),
    (b) => (b[28] = 1),
    (b) => new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(16, 3),
    (b) => new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(16, 32768),
  ]) {
    const bad = modify(glb, (j, bin) => {
      const v = j.bufferViews[j.images[0].bufferView];
      change(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
    });
    await assert.rejects(createUnityImportBundle(bad, options()));
  }
});

test('Unity mesh identity and hierarchy policy cannot silently lose or merge source nodes', async () => {
  const { glb } = await fixture({ helper: true });
  for (const change of [
    (j) => delete j.nodes[0].extras,
    (j) => (j.nodes[1].extras.id = j.nodes[0].extras.id),
    (j) => (j.nodes[0].extras.id = ''),
    (j) => (j.nodes[0].children = [0]),
    (j) => {
      j.nodes[0].children = [1, 1];
    },
    (j) => (j.nodes[0].mesh = 999),
    (j) => (j.nodes[0].translation = [0, 1]),
    (j) => (j.nodes[0].matrix = [1]),
    (j) => (j.meshes[0].primitives[0].mode = 1),
    (j) => (j.meshes[0].primitives[0].targets = []),
    (j) => (j.nodes[0].extensions = { KHR_node_visibility: { visible: 'false' } }),
  ])
    await assert.rejects(createUnityImportBundle(modify(glb, change), options()));
  const valid = await createUnityImportBundle(glb, options()),
    nodes = json(valid, '/margo-profile.json').nodes;
  assert.deepEqual(
    nodes.map((n) => [n.id, n.sourceVisible, n.rendererVisible, n.collider]),
    [
      ['art', true, true, 'none'],
      ['helper', false, false, 'convex'],
    ],
  );
});

test('Unity required physics rejects unsupported helpers while explicit no-physics preserves rendering policy', async () => {
  const { glb } = await fixture({ helper: true });
  const bad = modify(glb, (j) => (j.nodes[1].skin = 0));
  await assert.rejects(createUnityImportBundle(bad, options()), /node skin/);
  await assert.rejects(createUnityImportBundle(bad, options({ colliders: false })), /node skin/);
  const { scene } = await fixture({ helper: true });
  scene.nodes[1].geometry = { ...geometry, indices: Array.from({ length: 100 }, () => geometry.indices).flat() };
  const big = exportGLB(scene, { generator: 'Margo Mesh Studio' });
  await assert.rejects(createUnityImportBundle(big, options()), /255/);
  const noPhysics = await createUnityImportBundle(big, options({ colliders: false }));
  assert.equal(json(noPhysics, '/margo-profile.json').generateColliders, false);
  assert.equal(json(noPhysics, '/margo-profile.json').nodes[1].rendererVisible, false);
  const moving = await fixture({ animated: true });
  const concave = modify(moving.glb, (j) => (j.nodes[0].name = 'moving-colonly'));
  await assert.rejects(createUnityImportBundle(concave, options()), /animated concave/);
  const disabled = await createUnityImportBundle(concave, options({ colliders: false }));
  assert.equal(json(disabled, '/margo-profile.json').nodes[0].rendererVisible, false);
});

test('Unity requires explicit supported clip metadata and never guesses or resamples it', async () => {
  const { glb } = await fixture({ animated: true });
  for (const change of [
    (j) => delete j.animations[0].extras,
    (j) => delete j.animations[0].extras.fps,
    (j) => (j.animations[0].extras.fps = 0),
    (j) => (j.animations[0].extras.fps = 1e200),
    (j) => (j.animations[0].extras.fps = Number.MIN_VALUE),
    (j) => (j.animations[0].extras.loop = 'true'),
    (j) => (j.animations[0].name = ''),
    (j) => (j.animations[0].samplers[0].interpolation = 'LINEAR'),
    (j) => (j.animations[0].channels[0].target.path = 'weights'),
    (j) => (j.animations[0].channels[0].target.node = 999),
  ])
    await assert.rejects(createUnityImportBundle(modify(glb, change), options()));
  const other = modify(glb, (j) => (j.asset.generator = 'Another exporter'));
  await assert.rejects(createUnityImportBundle(other, options()), /source profile/);
});

test('Unity rejects lossy matrix/instance/default-scene and ambiguous playback policies', async () => {
  const { glb } = await fixture({ animated: true });
  for (const change of [
    (j) => {
      delete j.nodes[0].translation;
      delete j.nodes[0].rotation;
      delete j.nodes[0].scale;
      j.nodes[0].matrix = [1, 0, 0, 0, 0.25, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    },
    (j) => {
      delete j.scene;
    },
    (j) => {
      j.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 0 } } };
    },
    (j) => {
      j.nodes[0].rotation = [0, 0, 0, 0];
    },
    (j) => {
      j.nodes[0].rotation = [0, 0, 0, 2];
    },
    (j) => {
      j.animations.push(structuredClone(j.animations[0]));
    },
  ])
    await assert.rejects(createUnityImportBundle(modify(glb, change), options()));
});

test('Unity validates actual encoded skin indices/weights and complete bone identity without rewriting them', async () => {
  const { scene } = await fixture();
  const bone = { name: 'Source bone', extras: { id: 'bone' } };
  scene.nodes.push(bone);
  scene.nodes[0].skin = {
    joints: [bone],
    skeleton: bone,
    inverseBindMatrices: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  };
  scene.nodes[0].geometry = {
    ...geometry,
    joints: Array(16).fill(0),
    weights: Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat(),
  };
  const glb = exportGLB(scene, { generator: 'Margo Mesh Studio' });
  const good = await createUnityImportBundle(glb, options());
  assert.deepEqual(file(good, '/model.glb').data, glb);
  for (const change of [
    (j, b) => {
      const a = j.accessors[j.meshes[0].primitives[0].attributes.JOINTS_0],
        v = j.bufferViews[a.bufferView];
      const d = new DataView(b.buffer, b.byteOffset, b.byteLength),
        at = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
      a.componentType === 5121 ? d.setUint8(at, 1) : d.setUint16(at, 1, true);
    },
    ...[-0.1, 1.1, 0, 0.5, NaN, Infinity].map((weight) => (j, b) => {
      const a = j.accessors[j.meshes[0].primitives[0].attributes.WEIGHTS_0],
        v = j.bufferViews[a.bufferView];
      new DataView(b.buffer, b.byteOffset, b.byteLength).setFloat32(
        (v.byteOffset ?? 0) + (a.byteOffset ?? 0),
        weight,
        true,
      );
    }),
    (j) => {
      delete j.nodes[j.skins[0].joints[0]].extras.id;
    },
  ]) {
    const bad = modify(glb, change),
      before = Uint8Array.from(bad);
    await assert.rejects(createUnityImportBundle(bad, options()));
    assert.deepEqual(bad, before);
  }
});
