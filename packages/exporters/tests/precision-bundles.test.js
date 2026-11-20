// Precision and Roblox source bundles: assembled from a captured quad, verified independently, and every tamper caught.
import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePNG } from '../dist/capture.js';
import {
  createGodotPrecisionBundle,
  godotPrecisionPreflight,
  verifyGodotPrecisionBundle,
} from '../dist/godot-precision.js';
import { robloxChunkTriangleCounts, splitRobloxPrimitives, validateRobloxPrimitiveInput } from '../dist/roblox.js';
import { robloxChunkPreflight, robloxHierarchyDiagnostics } from '../dist/roblox-chunks.js';
import {
  createRobloxRuntimeBundle,
  robloxRuntimePreflight,
  verifyRobloxRuntimeBundle,
} from '../dist/roblox-runtime.js';
import { joinGLB } from '../dist/glb.js';
import {
  createUnityPrecisionBundle,
  unityPrecisionPreflight,
  verifyUnityPrecisionBundle,
} from '../dist/unity-precision.js';
import {
  createUnrealPrecisionBundle,
  unrealPrecisionPreflight,
  verifyUnrealPrecisionBundle,
} from '../dist/unreal-precision.js';

const options = { layout: 'objects', transformMode: 'bake', animation: 'static', skin: false, objectAnimation: false };
const corners = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
];
const white = [1, 1, 1, 1];
function quadScene() {
  const triangles = [
    [0, 1, 2],
    [0, 2, 3],
  ];
  return {
    document: {
      materials: { m: { id: 'm', name: 'Stone', assetId: 'img', alphaMode: 'opaque', doubleSided: true } },
      assets: {
        img: {
          id: 'img',
          name: 'atlas',
          width: 2,
          height: 2,
          pixels: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255],
        },
      },
    },
    objects: [
      {
        id: 'o',
        name: 'Panel',
        parentId: null,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
    ],
    faces: [
      {
        source: {
          id: 'f',
          objectId: 'o',
          materialId: 'm',
          vertices: ['a', 'b', 'c', 'd'],
          colors: [white, white, white, white],
        },
        effectiveUVs: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        localCorners: corners,
        worldCorners: corners,
        outputWorldCorners: corners,
        localTriangles: triangles,
        worldBakedTriangles: triangles,
        localNormal: [0, 0, 1],
        worldNormal: [0, 0, 1],
      },
    ],
    outputFrame: { originMode: 'world', pivot: [0, 0, 0] },
  };
}
const checks = {
  document: () => ({ fields: true, extensions: false, extensionShape: true }),
  readMetadata: () => {},
  faceExtension: () => false,
  faceFieldsExtension: () => false,
  vertexExtension: () => false,
  materialOutsideProfile: () => false,
  imageExtension: () => false,
};
/** The quad as one unwelded world-space surface with its triangle identities. */
function surface(scene) {
  const order = scene.faces[0].worldBakedTriangles.flat();
  return {
    primitive: {
      objectId: 'o',
      materialId: 'm',
      animationBinding: null,
      positions: order.flatMap((c) => corners[c]),
      normals: order.flatMap(() => [0, 0, 1]),
      uvs: order.flatMap((c) => scene.faces[0].effectiveUVs[c]),
      colors: order.flatMap(() => white),
      indices: order.map((_, i) => i),
      sourceCorners: order.map((corner) => [{ faceId: 'f', corner }]),
    },
    triangles: [
      ['o', 'f', 0],
      ['o', 'f', 1],
    ],
  };
}
const master = { bytes: new TextEncoder().encode('{"format":"Acme"}'), extension: 'acme', role: 'export-snapshot' };
const snapshot = { sha256: 'b'.repeat(64), optionsJSON: '{}' };
const app = { appName: 'Acme', extension: 'acmeprecision' };
const png = (image) => encodePNG({ width: image.width, height: image.height, data: Uint8Array.from(image.pixels) });

test('the Unity, Unreal and Godot preflights pass a qualified quad and name each failure', () => {
  const scene = quadScene();
  assert.deepEqual(godotPrecisionPreflight(scene, options, checks), []);
  assert.deepEqual(unityPrecisionPreflight(scene, { ...options, transformMode: 'preserve' }, checks), []);
  assert.deepEqual(unrealPrecisionPreflight(scene, { ...options, transformMode: 'preserve' }, checks), []);
  const bad = quadScene();
  bad.faces[0].source.colors = [[1, 0, 0, 1], white, white, white];
  bad.document.assets.img.pixels[3] = 128;
  const codes = godotPrecisionPreflight(
    bad,
    { ...options, animation: 'flipbook' },
    {
      ...checks,
      readMetadata: () => {
        throw new Error('unreadable');
      },
    },
  ).map((d) => d.code);
  assert.deepEqual(codes, [
    'GODOT_PRECISION_STATIC_REQUIRED',
    'GODOT_PRECISION_METADATA',
    'GODOT_PRECISION_VERTEX_COLOR',
    'GODOT_PRECISION_IMAGE',
  ]);
  const unity = unityPrecisionPreflight(bad, options, checks).map((d) => d.code);
  assert.deepEqual(unity, ['UNITY_PRECISION_TRANSFORMS', 'UNITY_PRECISION_VERTEX_COLOR', 'UNITY_PRECISION_IMAGE']);
});

test('a Godot precision bundle round-trips through its independent verifier and rejects tampering', async () => {
  const scene = quadScene(),
    images = new Map([['img', await png(scene.document.assets.img)]]);
  const bundle = await createGodotPrecisionBundle({
    ...app,
    basename: 'Quad',
    options,
    scene,
    primitives: [surface(scene).primitive],
    images,
    master,
    snapshot,
  });
  assert.deepEqual(
    bundle.files.map((f) => f.filename),
    [
      'Quad-atlas-0.png',
      'Quad-precision.bin',
      'Quad-source.acme',
      'Quad.acmeprecision',
      'addons/acme_precision/precision.gdshader',
      'addons/acme_precision/importer.gd',
      'addons/acme_precision/plugin.gd',
      'addons/acme_precision/plugin.cfg',
      'Quad-godot-precision-README.txt',
    ],
  );
  const expected = { ...app, master, snapshot };
  const result = await verifyGodotPrecisionBundle(scene, bundle, expected);
  assert.deepEqual([result.triangles, result.vertices, result.surfaces], [2, 6, 1]);
  const tampered = (filename, change) => ({
    ...bundle,
    files: bundle.files.map((f) => (f.filename === filename ? { ...f, bytes: change(f.bytes.slice()) } : f)),
  });
  await assert.rejects(
    verifyGodotPrecisionBundle(
      scene,
      tampered('Quad-precision.bin', (b) => ((b[0] ^= 1), b)),
      expected,
    ),
    /GODOT_PRECISION_PACKAGE_INVALID: complete geometry binary/,
  );
  await assert.rejects(
    verifyGodotPrecisionBundle(scene, bundle, { ...expected, snapshot: { ...snapshot, sha256: 'c'.repeat(64) } }),
    /captured evaluated scene identity/,
  );
  await assert.rejects(
    verifyGodotPrecisionBundle(scene, bundle, { ...expected, reproduces: () => false }),
    /reconstruct evaluated source/,
  );
  await assert.rejects(
    verifyGodotPrecisionBundle(
      scene,
      tampered('addons/acme_precision/importer.gd', (b) => ((b[0] ^= 1), b)),
      expected,
    ),
    /exact native importer/,
  );
});

test('Unity verification rejects a bundle without its manifest before reading anything else', async () => {
  await assert.rejects(
    verifyUnityPrecisionBundle(
      quadScene(),
      { files: [], manifest: {} },
      { appName: 'Acme', extension: 'acmeunity', master, snapshot },
    ),
    /UNITY_PRECISION_PACKAGE_INVALID: Manifest inventory/,
  );
});

test('Roblox partitions keep every triangle in order, fixed or balanced', () => {
  assert.deepEqual(robloxChunkTriangleCounts(45_000), [20_000, 20_000, 5_000]);
  assert.deepEqual(robloxChunkTriangleCounts(45_000, 19_998, 'balanced'), [15_000, 15_000, 15_000]);
  assert.deepEqual(robloxChunkTriangleCounts(0), []);
  assert.throws(() => robloxChunkTriangleCounts(5, 20_001), /at most 20,000/);
  const input = surface(quadScene());
  validateRobloxPrimitiveInput(input);
  const chunks = splitRobloxPrimitives([input], 1);
  assert.deepEqual(
    chunks.map((c) => [c.chunkIndex, c.sourcePrimitiveIndex, c.triangles, c.primitive.indices]),
    [
      [0, 0, [['o', 'f', 0]], [0, 1, 2]],
      [1, 0, [['o', 'f', 1]], [0, 1, 2]],
    ],
  );
  assert.deepEqual(chunks[1].primitive.positions, [0, 0, 0, 1, 1, 0, 0, 1, 0]);
  assert.throws(() => validateRobloxPrimitiveInput({ ...input, triangles: [] }), /exactly one source identity/);
});

test('Roblox chunk preflight names open geometry an unqualified profile has not shown', () => {
  const [chunk] = splitRobloxPrimitives([surface(quadScene())]);
  const profile = {
    id: 'p',
    evidenceId: 'e',
    appearances: [],
    geometryConditions: ['closed-volume'],
    maxTextureWidth: 1024,
    maxTextureHeight: 1024,
  };
  const [finding] = robloxChunkPreflight([chunk], profile);
  assert.equal(finding.code, 'ROBLOX_GEOMETRY_UNQUALIFIED');
  assert.match(finding.message, /has open-boundary geometry unqualified for profile p/);
  assert.deepEqual(robloxChunkPreflight([chunk], { ...profile, geometryConditions: ['open-boundary'] }), []);
  assert.deepEqual(robloxHierarchyDiagnostics(quadScene(), 'bake'), []);
});

test('a Roblox runtime bundle round-trips through its independent verifier and rejects tampering', async () => {
  const scene = quadScene(),
    runtimeOptions = { ...options, nativeLighting: true };
  const qualification = { representation: 'x', qualified: true, evidenceId: 'e' };
  // The source passes; a flat quad has no native Z thickness, which the size check names.
  assert.deepEqual(
    robloxRuntimePreflight(scene, runtimeOptions, checks, 'Acme', qualification).map((d) => d.code),
    ['ROBLOX_RUNTIME_ZERO_EXTENT_UNQUALIFIED'],
  );
  assert.equal(
    robloxRuntimePreflight(scene, runtimeOptions, checks, 'Acme', { ...qualification, qualified: false }).at(-1).code,
    'ROBLOX_RUNTIME_UNQUALIFIED',
  );
  const runtimeMaster = { ...master, documentId: 'doc' };
  const bundle = await createRobloxRuntimeBundle({
    appName: 'Acme',
    basename: 'Quad',
    options: runtimeOptions,
    scene,
    inputs: [surface(scene)],
    images: async () => new Map([['img', await png(scene.document.assets.img)]]),
    master: runtimeMaster,
    snapshotSha256: snapshot.sha256,
  });
  assert.equal(bundle.manifest.sourceFolderName, 'Quad_AcmeSource');
  assert.deepEqual(bundle.manifest.chunks[0].centerStuds, [Math.fround(-25 / 14), Math.fround(25 / 14), -0]);
  const expected = {
    appName: 'Acme',
    master: runtimeMaster,
    snapshotSha256: snapshot.sha256,
    checks,
    masterRoundTrips: () => true,
  };
  await verifyRobloxRuntimeBundle(scene, bundle, expected);
  const tampered = (filename) => ({
    ...bundle,
    files: bundle.files.map((f) =>
      f.filename === filename ? { ...f, bytes: f.bytes.map((b, i) => (i === 0 ? b ^ 1 : b)) } : f,
    ),
  });
  await assert.rejects(
    verifyRobloxRuntimeBundle(scene, tampered('geometry-000000.bin'), expected),
    /ROBLOX_RUNTIME_VERIFY: external and embedded payload bytes differ/,
  );
  await assert.rejects(
    verifyRobloxRuntimeBundle(scene, bundle, { ...expected, appName: 'Other' }),
    /source Folder identity/,
  );
  await assert.rejects(
    verifyRobloxRuntimeBundle(scene, bundle, { ...expected, masterRoundTrips: () => false }),
    /parsed source project including workspace/,
  );
  // The verifier applies the writer's basename rules before anything else: a basename ending in a dot is refused.
  const renamed = (to) => ({
    ...bundle,
    files: bundle.files.map((f) => (f.filename.startsWith('Quad-') ? { ...f, filename: to + f.filename.slice(4) } : f)),
  });
  await assert.rejects(verifyRobloxRuntimeBundle(scene, renamed('Quad.'), expected), /basename breaks the Roblox/);
  await assert.rejects(verifyRobloxRuntimeBundle(scene, renamed('Q'.repeat(181)), expected), /basename breaks/);
  // A lone surrogate has no UTF-8 form and no Luau escape, so the writer refuses it too.
  await assert.rejects(
    createRobloxRuntimeBundle({
      appName: 'Acme',
      basename: 'Quad\ud800',
      options: runtimeOptions,
      scene,
      inputs: [surface(scene)],
      images: async () => new Map(),
      master: runtimeMaster,
      snapshotSha256: snapshot.sha256,
    }),
    TypeError,
  );
});

/**
 * A strip of `n` triangle faces (not quads) over n + 2 shared vertices, all facing +z, and the exact static GLB a
 * precision writer emits for it, its indices of glTF type `component`.
 */
async function stripBundleSource(n = 1, component = 5123, tweak = () => {}) {
  const scene = quadScene(),
    count = n + 2,
    point = (k) => [k, k % 2, 0],
    uv = (k) => [k / 131072, k % 2];
  scene.faces = Array.from({ length: n }, (_, i) => {
    const ids = i % 2 ? [i, i + 1, i + 2] : [i, i + 2, i + 1],
      at = ids.map(point),
      tri = [[0, 1, 2]];
    return {
      source: {
        id: 'f' + i,
        objectId: 'o',
        materialId: 'm',
        vertices: ids.map((k) => 'v' + k),
        colors: [white, white, white],
      },
      effectiveUVs: ids.map(uv),
      localCorners: at,
      worldCorners: at,
      outputWorldCorners: at,
      localTriangles: tri,
      worldBakedTriangles: tri,
      localNormal: [0, 0, 1],
      worldNormal: [0, 0, 1],
    };
  });
  const Index = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array }[component],
    indices = Index.from(scene.faces.flatMap((f) => f.source.vertices.map((v) => Number(v.slice(1))))),
    image = await png(scene.document.assets.img),
    parts = [
      new Float32Array(Array.from({ length: count }, (_, k) => point(k)).flat()),
      new Float32Array(count * 3).map((_, i) => (i % 3 === 2 ? 1 : 0)),
      new Float32Array(Array.from({ length: count }, (_, k) => uv(k)).flat()),
      new Float32Array(count * 4).fill(1),
      indices,
      image,
    ].map((p) => new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
  const views = [];
  let length = 0;
  for (const p of parts) {
    views.push({ buffer: 0, byteOffset: length, byteLength: p.length });
    length += Math.ceil(p.length / 4) * 4;
  }
  const bin = new Uint8Array(length);
  parts.forEach((p, i) => bin.set(p, views[i].byteOffset));
  const accessor = (bufferView, componentType, type, extra = {}) => ({
    bufferView,
    componentType,
    count: bufferView === 4 ? indices.length : count,
    type,
    ...extra,
  });
  const json = {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Panel', mesh: 0 }],
    meshes: [
      {
        name: 'Panel',
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, COLOR_0: 3 }, indices: 4, mode: 4, material: 0 },
        ],
      },
    ],
    materials: [
      {
        name: 'Stone',
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
          baseColorTexture: { index: 0 },
        },
        doubleSided: true,
        extensions: { KHR_materials_unlit: {} },
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    images: [{ bufferView: 5, mimeType: 'image/png', name: 'atlas' }],
    samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
    accessors: [
      accessor(0, 5126, 'VEC3', { min: [0, 0, 0], max: [count - 1, 1, 0] }),
      accessor(1, 5126, 'VEC3'),
      accessor(2, 5126, 'VEC2'),
      accessor(3, 5126, 'VEC4'),
      accessor(4, component, 'SCALAR'),
    ],
    bufferViews: views,
    buffers: [{ byteLength: length }],
  };
  tweak(json, scene);
  return { scene, glb: joinGLB({ json, bin }) };
}

/** Creates and verifies the Unity and Unreal bundles of a strip; resolves with both verifications. */
async function verifyStrip(n, component, tweak) {
  const { scene, glb } = await stripBundleSource(n, component, tweak),
    preserve = { ...options, transformMode: 'preserve' },
    unity = { appName: 'Acme', extension: 'acmeunity', master, snapshot },
    unityBundle = await createUnityPrecisionBundle({ ...unity, basename: 'Tri', options: preserve, scene, glb });
  const helper = {
      materialName: 'AcmeUnlit',
      validateMaster: 'def validate_master(project, manifest):\n    return project\n',
      atlasPayload: 'def atlas_payload(manifest, master, source_sha):\n    return source_sha\n',
      checkMasterAtlas: '    pass\n',
    },
    unreal = {
      appName: 'Acme',
      extension: 'acmeunreal',
      master: { ...master, role: 'original-full-source-project' },
      snapshot,
      helper,
    },
    unrealBundle = await createUnrealPrecisionBundle({
      ...unreal,
      basename: 'Tri',
      options: preserve,
      scene,
      glb,
      nodeIndices: () => [0],
    });
  return Promise.allSettled([
    verifyUnityPrecisionBundle(scene, unityBundle, unity),
    verifyUnrealPrecisionBundle(scene, unrealBundle, { ...unreal, checks, assertReproduces: () => {} }),
  ]);
}

test('Unity and Unreal precision bundles verify a face that is one triangle, not two', async () => {
  for (const result of await verifyStrip(1, 5123)) {
    assert.equal(result.status, 'fulfilled', String(result.reason));
    assert.deepEqual([result.value.triangles, result.value.meshes], [1, 1]);
  }
});

test('Unity and Unreal precision verifiers refuse a restart index and take 65,536 vertices on 32-bit indices', async () => {
  // glTF 2.0 3.7.2.1: an index may not be its type's maximum (255, 65535); a 32-bit list may address 65,536 vertices.
  for (const [n, component] of [
    [254, 5121],
    [65534, 5123],
  ])
    for (const result of await verifyStrip(n, component)) {
      assert.equal(result.status, 'rejected', `${n} triangles, type ${component}`);
      assert.match(String(result.reason), /physical references\/wide indices/);
    }
  for (const result of await verifyStrip(65534, 5125)) {
    assert.equal(result.status, 'fulfilled', String(result.reason));
    assert.equal(result.value.triangles, 65534);
  }
});

test('the emitted triangle normal check is relative to edge length and refuses only collinear corners', async () => {
  const { emittedTriangleNormal } = await import('../dist/precision-shared.js');
  // 1e-5 m edges: twice the area is 1e-10 m^2, which the old absolute bound (< 1e-10) refused.
  const tiny = [
    [0, 0, 0],
    [1e-5, 0, 0],
    [0, 1e-5, 0],
  ];
  assert.deepEqual(emittedTriangleNormal(tiny, 'tiny'), [0, 0, 1]);
  assert.deepEqual(emittedTriangleNormal([tiny[0], tiny[2], tiny[1]], 'flipped'), [0, 0, -1]);
  assert.throws(
    () =>
      emittedTriangleNormal(
        [
          [0, 0, 0],
          [1, 1, 1],
          [2, 2, 2],
        ],
        'line',
      ),
    /line has a degenerate triangle/,
  );
  assert.throws(() => emittedTriangleNormal([tiny[0], tiny[0], tiny[1]], 'repeat'), /degenerate/);
  assert.throws(() => emittedTriangleNormal([tiny[0], tiny[1], [0, NaN, 0]], 'nan'), /nonfinite world corners/);
});

test('Unity and Unreal precision verifiers refuse a byteStride on an index view (glTF 2.0 3.6.1.1)', async () => {
  const results = await verifyStrip(1, 5123, (json) => {
    json.bufferViews[4].byteStride = 4;
  });
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.ok(result.reason instanceof RangeError, String(result.reason));
    assert.match(String(result.reason), /accessor representation/);
  }
});

test('the Unreal verifier refuses a GLB without samplers with its RangeError, not a TypeError', async () => {
  const [, unreal] = await verifyStrip(1, 5123, (json) => {
    delete json.samplers;
    delete json.textures[0].sampler;
  });
  assert.equal(unreal.status, 'rejected');
  assert.ok(unreal.reason instanceof RangeError, String(unreal.reason));
});

test('the Unreal preflight refuses a rotation off unit length, and a face naming a missing material', () => {
  const preserve = { ...options, transformMode: 'preserve' },
    turned = quadScene();
  turned.objects[0].transform.rotation = [0, 0, 0, 1.5];
  assert.ok(
    unrealPrecisionPreflight(turned, preserve, checks).some((d) => d.code === 'UNREAL_PRECISION_TRANSFORM_PRECISION'),
  );
  const missing = quadScene();
  missing.faces[0].source.materialId = 'gone';
  assert.ok(
    unrealPrecisionPreflight(missing, preserve, checks).some((d) => d.code === 'UNREAL_PRECISION_MATERIAL_MISSING'),
  );
});
