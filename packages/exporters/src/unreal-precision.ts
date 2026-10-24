// Unreal precision bundle: the exact GLB, the application's complete source master, the original atlas as raw
// RGBA8, a hash-bound manifest and the Editor Python that imports them through the official Interchange importer.
import { decodePNG } from '@margoengine/decoders/png';
import { type AccessorValues, type GLBParts, readAccessor, splitGLB } from './glb.js';
import { nativeAppNames, nativeExtension } from './native-names.js';
import {
  canonicalEqual,
  canonicalJSON,
  copyBundleTree,
  float32Within,
  onlyFields,
  opaqueRGBA8,
  type ParsedJSON,
  type PrecisionDiagnostic,
  type PrecisionFace,
  type PrecisionFile,
  type PrecisionMaster,
  type PrecisionOptions,
  type PrecisionScene,
  type PrecisionSnapshot,
  type PrecisionSourceChecks,
  safeBasename,
  sha256Hex,
  utf8Bytes,
} from './precision-shared.js';
import type { UnrealPrecisionImporterOptions } from './unreal-precision-importer.js';

export type {
  PrecisionDiagnostic,
  PrecisionFace,
  PrecisionFaceSource,
  PrecisionFile,
  PrecisionImage,
  PrecisionMaster,
  PrecisionMaterial,
  PrecisionObject,
  PrecisionOptions,
  PrecisionScene,
  PrecisionSnapshot,
  PrecisionSourceChecks,
  PrecisionTransform,
} from './precision-shared.js';
export type { UnrealPrecisionImporterOptions } from './unreal-precision-importer.js';

/** Manifest of an Unreal precision bundle, written as canonical JSON to `<basename>.<extension>`. */
export interface UnrealPrecisionManifest {
  readonly version: 1;
  readonly profileId: 'unreal-interchange-static-unlit-rgba8-v1';
  readonly options: PrecisionOptions;
  readonly sourceSnapshotSha256: string;
  readonly sourceSnapshotOptionsJSON: string;
  readonly glb: { readonly filename: string; readonly sha256: string };
  readonly sourceMaster: {
    readonly filename: string;
    readonly sha256: string;
    readonly role: 'original-full-source-project';
  };
  readonly image: {
    readonly filename: string;
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
    readonly origin: 'top-left';
  };
  readonly importerSha256: string;
  readonly triangles: number;
  readonly objects: readonly {
    readonly id: string;
    readonly parentId: string | null;
    readonly name: string;
    readonly authoredTransformJSON: string;
    readonly glbNodeIndex: number;
  }[];
  readonly materials: readonly {
    readonly id: string;
    readonly name: string;
    readonly glbMaterialIndex: number;
    readonly sourceAssetId: string;
  }[];
  readonly materialIdentityPolicy: 'exact-authored-id-name-native-metadata-bijection';
}

/** An Unreal precision bundle: its files (sorted by path) and its manifest. */
export interface UnrealPrecisionArtifact {
  readonly files: readonly PrecisionFile[];
  readonly manifest: UnrealPrecisionManifest;
}

/** The Editor helper's application parts: everything but the names this bundle derives itself. */
export type UnrealPrecisionHelper = Omit<UnrealPrecisionImporterOptions, 'appName' | 'masterFile'>;

/** Input of {@link createUnrealPrecisionBundle}. */
export interface UnrealPrecisionBundleInput {
  /** The owning application; names the Editor helper, output folders, metadata keys and log lines. */
  readonly appName: string;
  /** Manifest extension without the dot. */
  readonly extension: string;
  /** Manifest and README stem: ASCII letters, digits, `_` and `-`. */
  readonly basename: string;
  readonly options: PrecisionOptions;
  /** The scene that passed {@link unrealPrecisionPreflight}. */
  readonly scene: PrecisionScene;
  /** The exact static GLB of `scene`: objects layout, preserved transforms, no welding, one unlit material. */
  readonly glb: Uint8Array;
  /** The GLB node indices written for an object; exactly one is required. */
  readonly nodeIndices: (objectId: string) => readonly number[];
  /** The original project (role `original-full-source-project`); stored as `source.<extension>`. */
  readonly master: PrecisionMaster;
  readonly snapshot: PrecisionSnapshot;
  readonly helper: UnrealPrecisionHelper;
}

/** What {@link verifyUnrealPrecisionBundle} checks a bundle against, besides its scene. */
export interface UnrealPrecisionExpectation<S extends PrecisionScene = PrecisionScene> {
  readonly appName: string;
  readonly extension: string;
  readonly master: PrecisionMaster;
  readonly snapshot: PrecisionSnapshot;
  readonly helper: UnrealPrecisionHelper;
  /** The application's view of its own source records, checked again here. */
  readonly checks: PrecisionSourceChecks<S>;
  /** Throws when the original master and capture options do not reproduce the captured scene. */
  readonly assertReproduces: () => void;
  /** Parses the manifest text; pass a strict parser that rejects duplicate keys. Default `JSON.parse`. */
  readonly parseJSON?: (text: string) => unknown;
}

/** Result of {@link verifyUnrealPrecisionBundle}. */
export interface UnrealPrecisionVerification {
  readonly triangles: number;
  readonly objects: number;
  readonly meshes: number;
  readonly gate: 'independent-unreal-source-package-byte-verification';
  readonly nativeAcceptanceClaimed: false;
}

const exactActorLabelSupported = (name: string) =>
  name.length > 0 && name.trim() === name && !/[\u0000-\u001f\u007f]/.test(name);

/**
 * Unreal's capability policy for a precision bundle: objects layout with preserved transforms, a static pose, world
 * origin, unique exact actor labels (no surrounding space or control characters), local transforms and UVs that
 * Float32 stores within 1e-5 and 1e-6, white corner colours, one material in the bounded unlit profile and complete
 * opaque RGBA8 pixels. No triangle or image size cap. Findings are prefixed `UNREAL_PRECISION_`.
 */
export function unrealPrecisionPreflight<S extends PrecisionScene>(
  scene: S,
  options: PrecisionOptions,
  checks: PrecisionSourceChecks<S>,
): PrecisionDiagnostic[] {
  const diagnostics: PrecisionDiagnostic[] = [];
  const reject = (code: string, message: string) => diagnostics.push({ code: 'UNREAL_PRECISION_' + code, message });
  if (options.layout !== 'objects' || options.transformMode !== 'preserve')
    reject('TRANSFORMS', 'Choose Objects layout and Preserve local transforms for the Unreal precision bundle.');
  if (options.animation !== 'static' || options.skin || options.objectAnimation || scene.rigMode === 'skin')
    reject(
      'STATIC_REQUIRED',
      'Choose an evaluated static pose/frame and disable preserved clips/skins. The original editable source remains complete.',
    );
  if (scene.outputFrame.originMode !== 'world')
    reject('ORIGIN', 'Choose World origin for the current Unreal precision profile.');
  if (!scene.faces.length) reject('EMPTY', 'Choose a captured scope containing geometry.');
  const source = checks.document(scene);
  if (!source.fields || source.extensions || !source.extensionShape)
    reject(
      'EXTENSION',
      'Unknown document extensions do not have a qualified Unreal mapping; preserve the original and choose another target.',
    );
  try {
    checks.readMetadata(scene);
  } catch {
    reject('METADATA', 'The captured static pose/frame contains unsupported rig, clip or UV metadata.');
  }
  if (
    scene.objects.some((o) => !exactActorLabelSupported(o.name)) ||
    new Set(scene.objects.map((o) => o.name)).size !== scene.objects.length
  )
    reject(
      'OBJECT_NAMES',
      'The initial Unreal profile requires unique, nonempty actor labels with no trimmed whitespace or control characters. Labels are never sanitized silently.',
    );
  for (const object of scene.objects)
    if (
      !onlyFields(object, ['id', 'name', 'parentId', 'transform']) ||
      !onlyFields(object.transform, ['position', 'rotation', 'scale'])
    ) {
      reject('OBJECT_EXTENSION', 'Unknown object/transform fields have no supported Unreal precision mapping.');
      break;
    }
  if (
    scene.objects.some((object) =>
      [...object.transform.position, ...object.transform.rotation, ...object.transform.scale].some(
        (value) => !float32Within(value, 1e-5),
      ),
    )
  )
    reject(
      'TRANSFORM_PRECISION',
      'An authored local transform cannot be represented by Unreal Float32 storage within the unchanged 1e-5 budget. Preserve the original and choose another target; export never rounds it silently.',
    );
  const ids = new Set<string>();
  let extension = false,
    colors = false,
    uvPrecision = false;
  for (const face of scene.faces) {
    ids.add(face.source.materialId);
    extension ||= checks.faceExtension(face, scene);
    colors ||= face.source.colors.some((rgba) => rgba.some((v) => v !== 1));
    uvPrecision ||= face.effectiveUVs.some((uv) => uv.some((value) => !float32Within(value, 1e-6)));
  }
  if (extension) reject('GEOMETRY_EXTENSION', 'Unknown face/vertex fields have no qualified native mapping.');
  if (colors)
    reject(
      'VERTEX_COLOR',
      'The initial native appearance profile needs white opaque vertex RGBA. Original colors stay intact; choose another target.',
    );
  if (uvPrecision)
    reject(
      'UV_PRECISION',
      'An effective source UV cannot be represented by Float32 within the unchanged 1e-6 UV budget. Export never rounds source coordinates silently.',
    );
  if (ids.size !== 1)
    reject(
      'MATERIAL_COUNT',
      'The initial Unreal precision profile requires one used material/atlas. Multiple-material native appearance awaits its own qualification.',
    );
  for (const id of ids) {
    const material = scene.document.materials[id]! as S['document']['materials'][string];
    try {
      if (checks.materialOutsideProfile(material) || material.alphaMode !== 'opaque' || !material.doubleSided)
        reject(
          'APPEARANCE',
          `Material ${id} requires the bounded opaque double-sided basic/unlit, white tint and nearest/clamp profile.`,
        );
    } catch {
      reject('APPEARANCE', `Material ${id} has unsupported appearance metadata.`);
    }
    const image =
      material.assetId === null
        ? undefined
        : (scene.document.assets[material.assetId] as S['document']['assets'][string] | undefined);
    if (!image || checks.imageExtension(image) || !opaqueRGBA8(image))
      reject(
        'IMAGE',
        `Material ${id} needs complete original opaque RGBA8 pixels. Export never resizes, repacks or quantizes images.`,
      );
  }
  return diagnostics;
}

const readme = (app: string, extension: string, basename: string, masterFile: string) =>
  `${app} Unreal precision bundle (preview)\n\nKeep every bundle member together. In an Unreal 5.8 Editor project with the official Interchange glTF importer, Python Editor Scripting, Geometry Scripting and Editor Scripting Utilities enabled, run Editor/${app}PrecisionImporter.py and call import_bundle with the absolute ${basename}.${extension} path. The app-owned integration creates a new uniquely owned output folder and saved map. Existing assets and vendor packages stay unchanged.\n\ngeometry.glb is the exact ordinary full-detail production GLB. ${masterFile} is the complete captured editable project and workspace. atlas.rgba is every original top-left RGBA8 texel at the original dimensions. No source topology, triangle or image cap is imposed by this target. Unsupported consumer/device limits reject rather than reduce or resize.\n\nThe initial profile is static opaque double-sided basic/unlit, white corner RGBA, one original atlas, nearest filtering and clamp. Actor display labels must remain exact. Unreal object identifiers cannot express every authored name; exact original object/material IDs and names are instead preserved as durable native metadata with an explicit bijection to each actual bound native object. This new native bundle contract does not turn ordinary GLB name loss into a passing direct-import gate.\n\nThe helper verifies original Interchange source-node identity before adaptation, native bulk mesh state, exact unchanged saved mesh-package bytes, local transforms, labels, bound material metadata, original texture source-art bytes and native settings after save/reopen. Native render-data correspondence, actual RHI texture bytes, shader/GPU sampler behavior, fresh-process persistence, million-triangle capacity and cross-device rendering remain independent gates. A source-package verification or adapter-storage status alone claims none of those.\n`;

const helperText = async (app: string, masterFile: string, helper: UnrealPrecisionHelper) => {
  const { createUnrealPrecisionImporter } = await import('./unreal-precision-importer.js');
  return createUnrealPrecisionImporter({ ...helper, appName: app, masterFile });
};

/**
 * Assembles an Unreal precision bundle from a scene that passed {@link unrealPrecisionPreflight}: `geometry.glb`,
 * `source.<master extension>`, `atlas.rgba` (the material's original top-left RGBA8), the manifest with every
 * object's exact authored transform and GLB node, the Editor helper and a README. It does not verify the result;
 * call {@link verifyUnrealPrecisionBundle} for that.
 * @throws TypeError for an unsafe basename or invalid names; RangeError `UNREAL_PRECISION_MAPPING` when an object
 * does not map to exactly one GLB node.
 */
export async function createUnrealPrecisionBundle(input: UnrealPrecisionBundleInput): Promise<UnrealPrecisionArtifact> {
  const { basename, scene, glb, master, snapshot } = input;
  if (!safeBasename(basename)) throw new TypeError('Choose a safe Unreal precision basename.');
  const app = nativeAppNames(input.appName).name,
    extension = nativeExtension(input.extension, 'extension'),
    masterFile = 'source.' + nativeExtension(master.extension, 'master.extension');
  const material = scene.document.materials[scene.faces[0]?.source.materialId ?? '']!,
    image = material?.assetId == null ? undefined : scene.document.assets[material.assetId];
  if (!image)
    throw new RangeError(
      'UNREAL_PRECISION_IMAGE: Run unrealPrecisionPreflight first; the scene needs one textured material.',
    );
  const rgba = Uint8Array.from(image.pixels);
  const importer = await helperText(app, masterFile, input.helper);
  const manifest: UnrealPrecisionManifest = {
    version: 1,
    profileId: 'unreal-interchange-static-unlit-rgba8-v1',
    options: { ...input.options },
    sourceSnapshotSha256: snapshot.sha256,
    sourceSnapshotOptionsJSON: snapshot.optionsJSON,
    glb: { filename: 'geometry.glb', sha256: sha256Hex(glb) },
    sourceMaster: { filename: masterFile, sha256: sha256Hex(master.bytes), role: 'original-full-source-project' },
    image: {
      filename: 'atlas.rgba',
      sha256: sha256Hex(rgba),
      width: image.width,
      height: image.height,
      origin: 'top-left',
    },
    importerSha256: sha256Hex(utf8Bytes(importer)),
    triangles: scene.faces.reduce((sum, face) => sum + face.localTriangles.length, 0),
    objects: scene.objects.map((object) => {
      const indices = input.nodeIndices(object.id);
      if (indices.length !== 1)
        throw new RangeError('UNREAL_PRECISION_MAPPING: Expected one exact emitted node per authored object.');
      return {
        id: object.id,
        parentId: object.parentId,
        name: object.name,
        authoredTransformJSON: canonicalJSON(object.transform),
        glbNodeIndex: indices[0]!,
      };
    }),
    materials: [{ id: material.id, name: material.name, glbMaterialIndex: 0, sourceAssetId: image.id }],
    materialIdentityPolicy: 'exact-authored-id-name-native-metadata-bijection',
  };
  const text = (filename: string, contents: string, mimeType = 'text/plain'): PrecisionFile => ({
    filename,
    bytes: utf8Bytes(contents),
    mimeType,
  });
  const files = copyBundleTree([
    { filename: manifest.glb.filename, bytes: glb, mimeType: 'model/gltf-binary' },
    { filename: manifest.sourceMaster.filename, bytes: master.bytes, mimeType: 'application/json' },
    { filename: manifest.image.filename, bytes: rgba, mimeType: 'application/octet-stream' },
    text(`${basename}.${extension}`, canonicalJSON(manifest), 'application/json'),
    text(`Editor/${app}PrecisionImporter.py`, importer),
    text(basename + '-unreal-README.txt', readme(app, extension, basename, masterFile)),
  ]);
  return { files, manifest };
}

function fail(label: string): never {
  throw new RangeError('UNREAL_PRECISION_PACKAGE_INVALID: ' + label);
}
const same = (a: unknown, b: unknown, label: string) => {
  if (!canonicalEqual(a, b)) fail(label);
};
const ownFields = (value: ParsedJSON, fields: readonly string[]) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && onlyFields(value, fields);

/** Bounded scalar GLB reader over splitGLB and readAccessor that also records every accessor and view it reads. */
function read(bytes: Uint8Array, parse: (text: string) => unknown) {
  let parts: GLBParts;
  try {
    parts = splitGLB(bytes, { copy: false, parse });
  } catch {
    return fail('GLB container');
  }
  if (!parts.bin || parts.chunks.length) fail('GLB complete chunks');
  const json: ParsedJSON = parts.json,
    bin = parts.bin!;
  if (
    !ownFields(json, [
      'asset',
      'extensionsUsed',
      'scene',
      'scenes',
      'nodes',
      'meshes',
      'materials',
      'textures',
      'images',
      'samplers',
      'accessors',
      'bufferViews',
      'buffers',
    ]) ||
    json.asset?.version !== '2.0' ||
    !Array.isArray(json.buffers) ||
    json.buffers.length !== 1 ||
    !ownFields(json.buffers[0], ['byteLength']) ||
    !Number.isSafeInteger(json.buffers[0].byteLength) ||
    json.buffers[0].byteLength < 1 ||
    bin.length < json.buffers[0].byteLength ||
    bin.length - json.buffers[0].byteLength > 3
  )
    fail('Bounded static GLB schema/buffer');
  same(json.extensionsUsed, ['KHR_materials_unlit'], 'Explicit supported GLB extension');
  if (
    !Array.isArray(json.scenes) ||
    json.scenes.length !== 1 ||
    (json.scene !== undefined && json.scene !== 0) ||
    !ownFields(json.scenes[0], ['nodes']) ||
    !Array.isArray(json.nodes) ||
    !Array.isArray(json.meshes) ||
    !Array.isArray(json.accessors) ||
    !Array.isArray(json.bufferViews)
  )
    fail('Complete single static scene inventory');
  const usedAccessors = new Set<number>(),
    usedViews = new Set<number>();
  const accessor = (id: number, width: number) => {
    const a = json.accessors[id],
      b = json.bufferViews[a?.bufferView],
      components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 },
      sizes: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
    if (
      !Number.isSafeInteger(id) ||
      id < 0 ||
      !a ||
      !b ||
      !ownFields(a, ['bufferView', 'byteOffset', 'count', 'componentType', 'type', 'normalized', 'min', 'max']) ||
      !ownFields(b, ['buffer', 'byteOffset', 'byteLength', 'byteStride', 'target']) ||
      (a.normalized !== undefined && a.normalized !== false) ||
      !Number.isSafeInteger(a.bufferView) ||
      a.bufferView < 0 ||
      b.buffer !== 0 ||
      components[a.type] !== width ||
      !sizes[a.componentType] ||
      !Number.isSafeInteger(a.count) ||
      a.count < 1
    )
      fail('GLB accessor representation');
    const size = sizes[a.componentType]!,
      stride = b.byteStride ?? width * size,
      start = (b.byteOffset ?? 0) + (a.byteOffset ?? 0);
    if (
      !Number.isSafeInteger(stride) ||
      stride % size !== 0 ||
      stride < width * size ||
      !Number.isSafeInteger(b.byteOffset ?? 0) ||
      !Number.isSafeInteger(a.byteOffset ?? 0) ||
      (a.byteOffset ?? 0) < 0 ||
      !Number.isSafeInteger(b.byteLength) ||
      b.byteLength < 1 ||
      (b.byteOffset ?? 0) < 0 ||
      start % size !== 0 ||
      start < (b.byteOffset ?? 0) ||
      start + (a.count - 1) * stride + width * size > (b.byteOffset ?? 0) + b.byteLength ||
      (b.byteOffset ?? 0) + b.byteLength > bin.length
    )
      fail('GLB accessor view bounds');
    let values: AccessorValues['values'];
    try {
      values = readAccessor(parts, id).values;
    } catch {
      return fail('Nonfinite GLB attribute');
    }
    const get = (index: number, axis = 0) => {
      if (!Number.isSafeInteger(index) || index < 0 || index >= a.count || axis < 0 || axis >= width)
        fail('GLB physical index');
      return values[index * width + axis]!;
    };
    usedAccessors.add(id);
    usedViews.add(a.bufferView);
    return { get, count: a.count as number, component: a.componentType as number, metadata: a };
  };
  return { json, bin, accessor, usedAccessors, usedViews };
}

/**
 * Independently checks an Unreal precision bundle against the scene it was made from. It first re-applies the
 * source policy (with the application's checks), then checks the exact member inventory and manifest (every object's
 * authored transform and GLB node, the material/atlas identity), every digest and the Editor helper's bytes; and,
 * from the GLB itself, its bounded static schema, every node's name, parent and exact local TRS, every triangle
 * corner's position, normal, UV and RGBA, position bounds, that no accessor or view goes unused, the single unlit
 * material and nearest/clamp sampler, and every embedded PNG pixel.
 * @throws RangeError `UNREAL_PRECISION_PACKAGE_INVALID: <what differs>` at the first difference; the application's
 * metadata and appearance readers' own errors when those cannot be read.
 */
export async function verifyUnrealPrecisionBundle<S extends PrecisionScene>(
  scene: S,
  artifact: UnrealPrecisionArtifact,
  expected: UnrealPrecisionExpectation<S>,
): Promise<UnrealPrecisionVerification> {
  const app = nativeAppNames(expected.appName).name,
    extension = nativeExtension(expected.extension, 'extension'),
    masterFile = 'source.' + nativeExtension(expected.master.extension, 'master.extension'),
    { checks } = expected,
    parse = expected.parseJSON ?? JSON.parse;
  // Independent source policy: do not rely on the producer's capability result.
  const d = scene.document,
    source = checks.document(scene);
  if (
    scene.rigMode === 'skin' ||
    scene.outputFrame.originMode !== 'world' ||
    !scene.faces.length ||
    !source.fields ||
    source.extensions ||
    !source.extensionShape
  )
    fail('Unsupported source profile/extension');
  checks.readMetadata(scene);
  const sourceNames = new Set<string>();
  for (const o of scene.objects) {
    if (
      !exactActorLabelSupported(o.name) ||
      sourceNames.has(o.name) ||
      !onlyFields(o, ['id', 'name', 'parentId', 'transform']) ||
      !onlyFields(o.transform, ['position', 'rotation', 'scale']) ||
      [...o.transform.position, ...o.transform.rotation, ...o.transform.scale].some((v) => !float32Within(v, 1e-5))
    )
      fail('Unsupported source object/transform precision');
    sourceNames.add(o.name);
  }
  for (const f of scene.faces) {
    if (
      checks.faceExtension(f, scene) ||
      f.source.colors.some((c) => c.some((v) => v !== 1)) ||
      f.effectiveUVs.some((uv) => uv.some((v) => !float32Within(v, 1e-6)))
    )
      fail('Unsupported source geometry/color/UV precision');
  }
  const usedMaterials = new Set(scene.faces.map((f) => f.source.materialId));
  if (usedMaterials.size !== 1) fail('Unsupported source material count');
  const sourceMaterial = d.materials[[...usedMaterials][0]!]! as S['document']['materials'][string],
    outside = checks.materialOutsideProfile(sourceMaterial),
    sourceImage =
      sourceMaterial.assetId === null
        ? undefined
        : (d.assets[sourceMaterial.assetId] as S['document']['assets'][string] | undefined);
  if (
    outside ||
    sourceMaterial.alphaMode !== 'opaque' ||
    !sourceMaterial.doubleSided ||
    !sourceImage ||
    checks.imageExtension(sourceImage) ||
    sourceImage.pixels.length !== sourceImage.width * sourceImage.height * 4 ||
    !opaqueRGBA8(sourceImage)
  )
    fail('Unsupported source appearance/image');
  const files = new Map(artifact.files.map((file) => [file.filename, file.bytes]));
  if (files.size !== artifact.files.length) fail('Duplicate bundle member');
  const manifests = [...files.keys()].filter((name) => name.endsWith('.' + extension));
  if (manifests.length !== 1) fail('Manifest inventory');
  const basename = manifests[0]!.slice(0, -('.' + extension).length);
  if (!/^[A-Za-z0-9_-]+$/.test(basename)) fail('Unsafe basename');
  const manifest: ParsedJSON = parse(new TextDecoder('utf-8', { fatal: true }).decode(files.get(manifests[0]!)!));
  same(manifest, artifact.manifest, 'Persisted manifest differs');
  same(
    Object.keys(manifest).sort(),
    [
      'version',
      'profileId',
      'options',
      'sourceSnapshotSha256',
      'sourceSnapshotOptionsJSON',
      'glb',
      'sourceMaster',
      'image',
      'importerSha256',
      'triangles',
      'objects',
      'materials',
      'materialIdentityPolicy',
    ].sort(),
    'Manifest schema',
  );
  same([manifest.version, manifest.profileId], [1, 'unreal-interchange-static-unlit-rgba8-v1'], 'Profile version');
  same(
    manifest.options,
    { layout: 'objects', transformMode: 'preserve', animation: 'static', skin: false, objectAnimation: false },
    'Explicit native options',
  );
  same(manifest.sourceSnapshotOptionsJSON, expected.snapshot.optionsJSON, 'Captured snapshot options');
  same(manifest.sourceSnapshotSha256, expected.snapshot.sha256, 'Captured scene identity');
  expected.assertReproduces();
  same(manifest.sourceMaster.role, 'original-full-source-project', 'Original master role');
  same(Object.keys(manifest.glb).sort(), ['filename', 'sha256'].sort(), 'GLB manifest schema');
  same(Object.keys(manifest.sourceMaster).sort(), ['filename', 'sha256', 'role'].sort(), 'Master manifest schema');
  same(
    Object.keys(manifest.image).sort(),
    ['filename', 'sha256', 'width', 'height', 'origin'].sort(),
    'Image manifest schema',
  );
  same(manifest.sourceMaster.filename, masterFile, 'Master filename');
  same(manifest.glb.filename, 'geometry.glb', 'GLB filename');
  same(manifest.image.filename, 'atlas.rgba', 'Image filename');
  same(
    [...files.keys()].sort(),
    [
      `${basename}.${extension}`,
      'geometry.glb',
      masterFile,
      'atlas.rgba',
      `Editor/${app}PrecisionImporter.py`,
      basename + '-unreal-README.txt',
    ].sort(),
    'Complete exact bundle inventory',
  );
  const master = files.get(manifest.sourceMaster.filename)!,
    glb = files.get(manifest.glb.filename)!,
    raw = files.get(manifest.image.filename)!,
    native = files.get(`Editor/${app}PrecisionImporter.py`)!;
  same(sha256Hex(master), sha256Hex(expected.master.bytes), 'Every original project/workspace byte');
  same(sha256Hex(master), manifest.sourceMaster.sha256, 'Master digest');
  same(sha256Hex(glb), manifest.glb.sha256, 'GLB digest');
  same(
    sha256Hex(native),
    sha256Hex(utf8Bytes(await helperText(app, masterFile, expected.helper))),
    'Exact app-owned native integration',
  );
  same(manifest.importerSha256, sha256Hex(native), 'Native integration digest');
  const decoded = read(glb, parse),
    j = decoded.json;
  if (
    j.skins?.length ||
    j.animations?.length ||
    j.nodes.some((n: ParsedJSON) => n.matrix !== undefined || n.skin !== undefined)
  )
    fail('Unexpected static source representation');
  if (
    j.nodes.some(
      (node: ParsedJSON) =>
        !ownFields(node, ['name', 'translation', 'rotation', 'scale', 'children', 'mesh']) ||
        (node.children !== undefined && !Array.isArray(node.children)),
    )
  )
    fail('Unsupported source GLB node representation');
  same(j.nodes.length, scene.objects.length, 'Every source logical node');
  const byName = new Map(scene.objects.map((o) => [o.name, o]));
  if (byName.size !== scene.objects.length) fail('Ambiguous source node names');
  const parents = new Map<number, number>();
  for (const [index, node] of j.nodes.entries())
    for (const child of node.children ?? []) {
      if (!Number.isSafeInteger(child) || child < 0 || child >= j.nodes.length || parents.has(child))
        fail('Invalid native hierarchy');
      parents.set(child, index);
    }
  const nodes = new Map<string, number>();
  for (const [index, node] of j.nodes.entries()) {
    const object = byName.get(node.name);
    if (!object || nodes.has(object.id)) fail('Unexpected or repeated node identity');
    nodes.set(object.id, index);
  }
  same(
    manifest.objects,
    scene.objects.map((object) => ({
      id: object.id,
      parentId: object.parentId,
      name: object.name,
      authoredTransformJSON: canonicalJSON(object.transform),
      glbNodeIndex: nodes.get(object.id),
    })),
    'Complete authored object identity/native node bijection',
  );
  same(
    manifest.materialIdentityPolicy,
    'exact-authored-id-name-native-metadata-bijection',
    'Explicit native material identity contract',
  );
  const roots = j.scenes[j.scene ?? 0]?.nodes;
  if (!Array.isArray(roots)) fail('Active scene roots');
  same(
    [...roots].sort((a: number, b: number) => a - b),
    scene.objects
      .filter((o) => o.parentId === null)
      .map((o) => nodes.get(o.id))
      .sort((a, b) => a! - b!),
    'Complete active scene roots',
  );
  const groups = new Map<string, PrecisionFace[]>();
  for (const object of scene.objects)
    groups.set(
      object.id,
      scene.faces.filter((f) => f.source.objectId === object.id),
    );
  let triangles = 0,
    meshCount = 0;
  const seenMeshes = new Set<number>();
  for (const object of scene.objects) {
    const index = nodes.get(object.id)!,
      node = j.nodes[index],
      faces = groups.get(object.id)!;
    same(
      parents.get(index) ?? null,
      object.parentId === null ? null : nodes.get(object.parentId),
      'Logical source ancestry',
    );
    // The GLB writer keeps given TRS numbers exactly in JSON; a rotation more than 1e-5 off unit length is scaled to
    // unit (sign kept). Keep both that exact transport and the authored-to-native precision budget checked.
    const q = object.transform.rotation,
      length = Math.hypot(...q),
      rotation = Math.abs(length - 1) <= 1e-5 ? q : q.map((v) => v / length);
    for (const [field, wanted] of Object.entries({
      translation: object.transform.position,
      rotation: object.transform.rotation,
      scale: object.transform.scale,
    })) {
      const defaults = field === 'rotation' ? [0, 0, 0, 1] : field === 'scale' ? [1, 1, 1] : [0, 0, 0],
        canonical = field === 'rotation' ? rotation : wanted,
        // A tuple left out of the node reads as the identity defaults.
        encoded = node[field] === undefined && canonical.every((v, i) => v === defaults[i]) ? defaults : canonical,
        actual = node[field] ?? defaults;
      if (
        !Array.isArray(actual) ||
        actual.length !== wanted.length ||
        actual.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value)) ||
        wanted.some(
          (v, i) =>
            actual[i] !== encoded[i] ||
            Math.fround(actual[i]) !== Math.fround(v) ||
            Math.abs(actual[i] - v) > 1e-5 ||
            Math.abs(Math.fround(actual[i]) - v) > 1e-5,
        )
      )
        fail('Authored local TRS');
    }
    if (!faces.length) {
      if (node.mesh !== undefined) fail('Empty logical node gained geometry');
      continue;
    }
    const mesh = j.meshes[node.mesh];
    if (
      !Number.isSafeInteger(node.mesh) ||
      node.mesh < 0 ||
      !mesh ||
      !ownFields(mesh, ['name', 'primitives']) ||
      !Array.isArray(mesh.primitives) ||
      seenMeshes.has(node.mesh) ||
      mesh.primitives.length !== 1
    )
      fail('Exact object/material mesh ownership');
    seenMeshes.add(node.mesh);
    meshCount++;
    const primitive = mesh.primitives[0];
    if (
      !ownFields(primitive, ['attributes', 'indices', 'mode', 'material']) ||
      !ownFields(primitive.attributes, ['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0']) ||
      (primitive.mode ?? 4) !== 4 ||
      primitive.material !== 0
    )
      fail('Static triangle/material association');
    const p = decoded.accessor(primitive.attributes.POSITION, 3),
      n = decoded.accessor(primitive.attributes.NORMAL, 3),
      uv = decoded.accessor(primitive.attributes.TEXCOORD_0, 2),
      c = decoded.accessor(primitive.attributes.COLOR_0, 4),
      ix = decoded.accessor(primitive.indices, 1);
    if (
      [p, n, uv, c].some((a) => a.component !== 5126 || a.count !== p.count) ||
      ![5121, 5123, 5125].includes(ix.component) ||
      ix.count !== faces.length * 6
    )
      fail('Complete indexed attribute inventory');
    const minimum = [Infinity, Infinity, Infinity],
      maximum = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.count; i++)
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis]!, p.get(i, axis));
        maximum[axis] = Math.max(maximum[axis]!, p.get(i, axis));
      }
    same(p.metadata.min, minimum, 'Exact physical position minimum');
    same(p.metadata.max, maximum, 'Exact physical position maximum');
    const referenced = new Uint8Array(p.count);
    let cursor = 0,
      maxIndex = 0;
    for (const face of faces)
      for (const corners of face.localTriangles) {
        const points = corners.map((corner) => face.localCorners[corner]!),
          a = points[1]!.map((v, i) => v - points[0]![i]!),
          b = points[2]!.map((v, i) => v - points[0]![i]!),
          cross = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!],
          length = Math.hypot(...cross);
        if (!(length > 0)) fail('Nondegenerate source triangle');
        const normal = cross.map((v) => v / length);
        for (const corner of corners) {
          const vertex = ix.get(cursor++);
          if (!Number.isSafeInteger(vertex) || vertex >= p.count) fail('Physical vertex range');
          referenced[vertex] = 1;
          maxIndex = Math.max(maxIndex, vertex);
          for (let axis = 0; axis < 3; axis++) {
            if (
              p.get(vertex, axis) !== Math.fround(face.localCorners[corner]![axis]!) ||
              Math.abs(p.get(vertex, axis) - face.localCorners[corner]![axis]!) > 1e-5
            )
              fail('Every source position/corner');
            if (Math.abs(n.get(vertex, axis) - normal[axis]!) > 1e-5) fail('Every source normal/corner');
          }
          for (let axis = 0; axis < 2; axis++) {
            const original = face.effectiveUVs[corner]![axis]!,
              actual = uv.get(vertex, axis);
            if (actual !== Math.fround(original)) fail('Every source UV/corner');
            if (Math.abs(actual - original) > 1e-6) fail('Original canonical UV precision exceeds 1e-6');
          }
          for (let axis = 0; axis < 4; axis++)
            if (c.get(vertex, axis) !== Math.fround(face.source.colors[corner]![axis]!))
              fail('Every source RGBA/corner');
        }
        triangles++;
      }
    if (!referenced.every((v) => v === 1) || (p.count > 65535 && maxIndex <= 65535))
      fail('Complete physical references/wide indices');
  }
  same(meshCount, j.meshes.length, 'No unused or substituted native meshes');
  same([triangles], [manifest.triangles], 'Actual source geometry/node totals');
  const used = new Set(scene.faces.map((f) => f.source.materialId));
  if (used.size !== 1 || j.materials.length !== 1 || j.images.length !== 1) fail('One bound material/image profile');
  const material = scene.document.materials[[...used][0]!]!,
    image = scene.document.assets[material.assetId!]!,
    m = j.materials[0];
  same(m.name, material.name, 'Original material identity');
  same(
    manifest.materials,
    [{ id: material.id, name: material.name, glbMaterialIndex: 0, sourceAssetId: image.id }],
    'Complete authored material/atlas identity',
  );
  if (
    !Object.hasOwn(m.extensions ?? {}, 'KHR_materials_unlit') ||
    m.extensions.KHR_materials_unlit === null ||
    typeof m.extensions.KHR_materials_unlit !== 'object' ||
    Array.isArray(m.extensions.KHR_materials_unlit) ||
    Object.keys(m.extensions.KHR_materials_unlit).length !== 0 ||
    (m.alphaMode ?? 'OPAQUE') !== 'OPAQUE' ||
    m.doubleSided !== true
  )
    fail('Explicit native unlit/alpha/sidedness');
  same(m.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1], [1, 1, 1, 1], 'Source white tint');
  same(Object.keys(m.extensions ?? {}), ['KHR_materials_unlit'], 'No unknown shader extension');
  same(m.emissiveFactor ?? [0, 0, 0], [0, 0, 0], 'Source black emission');
  if (
    m.normalTexture ||
    m.occlusionTexture ||
    m.emissiveTexture ||
    m.pbrMetallicRoughness?.metallicRoughnessTexture ||
    m.pbrMetallicRoughness?.baseColorTexture?.extensions ||
    (m.pbrMetallicRoughness?.baseColorTexture?.texCoord ?? 0) !== 0
  )
    fail('Unexpected material/texture transformation');
  if (
    !ownFields(m, [
      'name',
      'pbrMetallicRoughness',
      'emissiveFactor',
      'alphaMode',
      'alphaCutoff',
      'doubleSided',
      'extensions',
    ]) ||
    !ownFields(m.pbrMetallicRoughness, ['baseColorFactor', 'metallicFactor', 'roughnessFactor', 'baseColorTexture']) ||
    !ownFields(m.pbrMetallicRoughness.baseColorTexture, ['index']) ||
    j.textures.length !== 1 ||
    j.samplers.length !== 1
  )
    fail('Bounded material/texture inventory');
  same(
    [m.pbrMetallicRoughness.metallicFactor, m.pbrMetallicRoughness.roughnessFactor],
    [0, 1],
    'Explicit static unlit PBR fallback',
  );
  const texture = j.textures[m.pbrMetallicRoughness?.baseColorTexture?.index],
    sampler = j.samplers[texture?.sampler],
    pngInfo = j.images[texture?.source],
    view = j.bufferViews[pngInfo?.bufferView];
  if (
    !ownFields(texture, ['source', 'sampler']) ||
    texture.source !== 0 ||
    texture.sampler !== 0 ||
    !ownFields(sampler, ['magFilter', 'minFilter', 'wrapS', 'wrapT']) ||
    !ownFields(pngInfo, ['bufferView', 'mimeType', 'name']) ||
    !view ||
    !ownFields(view, ['buffer', 'byteOffset', 'byteLength']) ||
    !Number.isSafeInteger(view.byteOffset ?? 0) ||
    !Number.isSafeInteger(view.byteLength) ||
    (view.byteOffset ?? 0) < 0 ||
    view.byteLength < 1 ||
    (view.byteOffset ?? 0) + view.byteLength > decoded.bin.length ||
    pngInfo.mimeType !== 'image/png' ||
    view.buffer !== 0
  )
    fail('Associated embedded PNG');
  same(
    [sampler.magFilter, sampler.minFilter, sampler.wrapS, sampler.wrapT],
    [9728, 9728, 33071, 33071],
    'Original exact sampler',
  );
  decoded.usedViews.add(pngInfo.bufferView);
  if (decoded.usedAccessors.size !== j.accessors.length || decoded.usedViews.size !== j.bufferViews.length)
    fail('No unused or substituted physical source data');
  const png = decodePNG(decoded.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
  same(
    [png.width, png.height, manifest.image.width, manifest.image.height, manifest.image.origin],
    [image.width, image.height, image.width, image.height, 'top-left'],
    'Full original dimensions/orientation',
  );
  same(sha256Hex(png.data), sha256Hex(Uint8Array.from(image.pixels)), 'Every source embedded texture pixel');
  same(sha256Hex(raw), sha256Hex(Uint8Array.from(image.pixels)), 'Every original raw RGBA pixel');
  same(manifest.image.sha256, sha256Hex(raw), 'Native image payload digest');
  return {
    triangles,
    objects: scene.objects.length,
    meshes: meshCount,
    gate: 'independent-unreal-source-package-byte-verification',
    nativeAcceptanceClaimed: false,
  };
}
