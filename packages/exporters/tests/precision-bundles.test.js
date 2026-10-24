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
import { unityPrecisionPreflight, verifyUnityPrecisionBundle } from '../dist/unity-precision.js';
import { unrealPrecisionPreflight } from '../dist/unreal-precision.js';

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
});
