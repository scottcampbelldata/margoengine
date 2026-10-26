// Unity precision bundle: the exact GLB, the application's complete source master, the original atlas as raw
// RGBA8, a hash-bound manifest and the Editor helper that imports them through the unmodified glTFast importer.
import { decodePNG } from '@margoengine/decoders/png';
import { type AccessorValues, type GLBParts, readAccessor, splitGLB } from './glb.js';
import { nativeAppNames, nativeExtension } from './native-names.js';
import {
  canonicalJSON,
  copyBundleTree,
  float32Within,
  nativeStemSupported,
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

/** Manifest of a Unity precision bundle, written as canonical JSON to `<basename>.<extension>`. */
export interface UnityPrecisionManifest {
  readonly version: 1;
  readonly profileId: 'unity-gltfast-static-point-clamp-v1';
  readonly options: PrecisionOptions;
  readonly sourceSnapshotSha256: string;
  readonly sourceSnapshotOptionsJSON: string;
  readonly glb: { readonly filename: string; readonly sha256: string };
  readonly sourceMaster: {
    readonly filename: string;
    readonly sha256: string;
    readonly role: 'original-full-source-project' | 'export-snapshot';
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
  readonly objects: number;
}

/** A Unity precision bundle: its files (sorted by path) and its manifest. */
export interface UnityPrecisionArtifact {
  readonly files: readonly PrecisionFile[];
  readonly manifest: UnityPrecisionManifest;
}

/** Input of {@link createUnityPrecisionBundle}. */
export interface UnityPrecisionBundleInput {
  /** The owning application; names the Editor helper, its menu and log lines. */
  readonly appName: string;
  /** Manifest extension without the dot. */
  readonly extension: string;
  /** Bundle file stem: ASCII letters, digits, `_` and `-`. */
  readonly basename: string;
  readonly options: PrecisionOptions;
  /** The scene that passed {@link unityPrecisionPreflight}. */
  readonly scene: PrecisionScene;
  /** The exact static GLB of `scene`: objects layout, preserved transforms, no welding, one unlit material. */
  readonly glb: Uint8Array;
  readonly master: PrecisionMaster;
  readonly snapshot: PrecisionSnapshot;
}

/** What {@link verifyUnityPrecisionBundle} checks a bundle against, besides its scene. */
export interface UnityPrecisionExpectation {
  readonly appName: string;
  readonly extension: string;
  /** The exact master bytes and role the bundle must hold, and the master's file extension. */
  readonly master: PrecisionMaster;
  readonly snapshot: PrecisionSnapshot;
  /**
   * Called once the manifest's snapshot hash matches: false when the original master and capture options do not
   * reproduce the captured scene. Omit when the master is an export snapshot.
   */
  readonly reproduces?: (() => boolean) | undefined;
}

/** Result of {@link verifyUnityPrecisionBundle}. */
export interface UnityPrecisionVerification {
  readonly triangles: number;
  readonly objects: number;
  readonly meshes: number;
  readonly gate: 'independent-unity-source-package-byte-verification';
  readonly nativeAcceptanceClaimed: false;
}

/**
 * Unity's capability policy for a precision bundle: objects layout with preserved transforms, a static pose, world
 * origin, unique object names (a single root needs a native file name), local transforms and UVs that Float32
 * stores within 1e-5 and 1e-6, white corner colours, one material with a native file name in the bounded unlit
 * profile, and complete opaque RGBA8 pixels. No triangle or image size cap. Findings are prefixed `UNITY_PRECISION_`.
 */
export function unityPrecisionPreflight<S extends PrecisionScene>(
  scene: S,
  options: PrecisionOptions,
  checks: PrecisionSourceChecks<S>,
): PrecisionDiagnostic[] {
  const diagnostics: PrecisionDiagnostic[] = [];
  const reject = (code: string, message: string) => diagnostics.push({ code: 'UNITY_PRECISION_' + code, message });
  if (options.layout !== 'objects' || options.transformMode !== 'preserve')
    reject('TRANSFORMS', 'Choose Objects layout and Preserve local transforms for the Unity precision bundle.');
  if (options.animation !== 'static' || options.skin || options.objectAnimation || scene.rigMode === 'skin')
    reject(
      'STATIC_REQUIRED',
      'Choose an evaluated static pose/frame and disable preserved clips/skins. The original editable source remains complete.',
    );
  if (scene.outputFrame.originMode !== 'world')
    reject('ORIGIN', 'Choose World origin for the current Unity precision profile.');
  if (!scene.faces.length) reject('EMPTY', 'Choose a captured scope containing geometry.');
  const source = checks.document(scene);
  if (!source.fields || source.extensions || !source.extensionShape)
    reject(
      'EXTENSION',
      'Unknown document extensions do not have a qualified Unity mapping; preserve the original and choose another target.',
    );
  try {
    checks.readMetadata(scene);
  } catch {
    reject('METADATA', 'The captured static pose/frame contains unsupported rig, clip or UV metadata.');
  }
  if (
    scene.objects.some((o) => !o.name.trim()) ||
    new Set(scene.objects.map((o) => o.name)).size !== scene.objects.length
  )
    reject(
      'OBJECT_NAMES',
      'The initial Unity profile needs unique captured object names for independent native identity checks. The source is never renamed silently.',
    );
  const roots = scene.objects.filter((object) => object.parentId === null);
  if (roots.length === 1 && !nativeStemSupported(roots[0]!.name))
    reject(
      'ROOT_NAME',
      'The authored root name needs a supported native filename so the imported GLB and saved prefab retain that exact identity. Rename it explicitly in the source or choose another target.',
    );
  for (const object of scene.objects)
    if (
      !onlyFields(object, ['id', 'name', 'parentId', 'transform']) ||
      !onlyFields(object.transform, ['position', 'rotation', 'scale'])
    ) {
      reject('OBJECT_EXTENSION', 'Unknown object/transform fields have no supported Unity precision mapping.');
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
      'An authored local transform cannot be represented by Unity Float32 storage within the unchanged 1e-5 budget. Preserve the original and choose another target; export never rounds it silently.',
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
      'The initial Unity precision profile requires one used material/atlas. Multiple-material native appearance awaits its own qualification.',
    );
  for (const id of ids) {
    const material = scene.document.materials[id]! as S['document']['materials'][string];
    if (!nativeStemSupported(material.name))
      reject(
        'MATERIAL_NAME',
        'The original material name needs a supported native filename. Names are never sanitized silently.',
      );
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

const readme = (app: string, extension: string, basename: string, manifest: UnityPrecisionManifest) =>
  `${app} Unity precision bundle (static preview)\n\nInstall official Unity glTFast 6.20.0 in a Unity 6 project. Copy Editor/${app}PrecisionImporter.cs beneath Assets/Editor and wait for compilation. Keep the complete exported bundle together. Choose ${app} > Import precision bundle... and select ${basename}.${extension}.\n\nThe integration imports the exact full-detail GLB using the unmodified official glTFast importer. It creates a new uniquely owned Assets folder and names its unchanged imported GLB copy and saved prefab after the authored source root so Unity does not substitute the export basename. Multiple authored roots retain their identities beneath an explicitly synthetic ${app}Scene identity container. Unsupported native filenames fail instead of sanitizing names. The helper independently reads the original GLB and verifies every authored node/parent/local TRS, complete indexed oriented position/normal/UV/RGBA association and world positions before adaptation and again after native prefab Save/reopen. It also compares the complete original embedded PNG to the original canonical RGBA payload.\n\nIt creates a separate persistent uncompressed RGBA32 readable texture with the complete original pixels and explicit Point/Clamp sampling, clones the original glTF/Unlit material, and verifies exact native geometry/hierarchy/name fingerprints, texture pixels and sampler after reopen. The original exported GLB, complete master, other exports, existing project assets and vendor package stay unchanged. Use the reported source-named .prefab and keep its complete owned output folder.\n\nThis compensates for a measured glTFast 6.20.0 single-sampler import failure. Ordinary GLB import remains a separate failed sampler gate; this native integration does not relabel it. The initial profile is static opaque double-sided basic/unlit white-corner RGBA with one material/atlas. Other materials, alpha, animation/rig preservation, GPU numeric precision, fresh-process persistence, target capacity and cross-device rendering need separate evidence. Original image dimensions have no Roblox cap; a device-limit failure rejects instead of resizing.\n\nSource role: ${manifest.sourceMaster.role}. ${manifest.sourceMaster.filename} retains the complete captured project/workspace when the role is original-full-source-project. Export-snapshot fallback is labeled and uses a default workspace. Import failure retains only its new owned output and diagnostic; it never overwrites existing assets.\n`;

/**
 * Assembles a Unity precision bundle from a scene that passed {@link unityPrecisionPreflight}: the GLB, the source
 * master, `<basename>-atlas.rgba` (the material's original top-left RGBA8), the manifest, the Editor helper and a
 * README. It does not verify the result; call {@link verifyUnityPrecisionBundle} for that.
 * @throws TypeError for an unsafe basename or invalid names; RangeError when the scene has no textured face.
 */
export async function createUnityPrecisionBundle(input: UnityPrecisionBundleInput): Promise<UnityPrecisionArtifact> {
  const { basename, scene, glb, master, snapshot } = input;
  if (!safeBasename(basename)) throw new TypeError('Choose a safe Unity precision basename.');
  const app = nativeAppNames(input.appName).name,
    extension = nativeExtension(input.extension, 'extension'),
    masterExtension = nativeExtension(master.extension, 'master.extension');
  const material = scene.document.materials[scene.faces[0]?.source.materialId ?? '']!,
    image = material?.assetId == null ? undefined : scene.document.assets[material.assetId];
  if (!image)
    throw new RangeError(
      'UNITY_PRECISION_IMAGE: Run unityPrecisionPreflight first; the scene needs one textured material.',
    );
  const rgba = Uint8Array.from(image.pixels);
  const { createUnityPrecisionImporter } = await import('./unity-precision-importer.js');
  const importer = createUnityPrecisionImporter({ appName: app, extension });
  const manifest: UnityPrecisionManifest = {
    version: 1,
    profileId: 'unity-gltfast-static-point-clamp-v1',
    options: { ...input.options },
    sourceSnapshotSha256: snapshot.sha256,
    sourceSnapshotOptionsJSON: snapshot.optionsJSON,
    glb: { filename: basename + '.glb', sha256: sha256Hex(glb) },
    sourceMaster: {
      filename: `${basename}-source.${masterExtension}`,
      sha256: sha256Hex(master.bytes),
      role: master.role,
    },
    image: {
      filename: basename + '-atlas.rgba',
      sha256: sha256Hex(rgba),
      width: image.width,
      height: image.height,
      origin: 'top-left',
    },
    importerSha256: sha256Hex(utf8Bytes(importer)),
    triangles: scene.faces.reduce((sum, face) => sum + face.localTriangles.length, 0),
    objects: scene.objects.length,
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
    text(`Editor/${app}PrecisionImporter.cs`, importer),
    text(basename + '-unity-README.txt', readme(app, extension, basename, manifest)),
  ]);
  return { files, manifest };
}

function fail(label: string): never {
  throw new RangeError('UNITY_PRECISION_PACKAGE_INVALID: ' + label + '; export the package again');
}
const same = (a: unknown, b: unknown, label: string) => {
  if (canonicalJSON(a) !== canonicalJSON(b)) fail(label);
};

/** Bounded scalar GLB reader over splitGLB and readAccessor; this verifier's schema policy decides what passes. */
function read(bytes: Uint8Array) {
  let parts: GLBParts;
  try {
    parts = splitGLB(bytes, { copy: false });
  } catch {
    return fail('GLB container');
  }
  if (!parts.bin || parts.chunks.length) fail('GLB complete chunks');
  const json: ParsedJSON = parts.json,
    bin = parts.bin!;
  const accessor = (id: number, width: number) => {
    const a = json.accessors[id],
      b = json.bufferViews[a?.bufferView],
      components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 },
      sizes: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
    if (
      !a ||
      !b ||
      a.normalized ||
      a.sparse ||
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
      stride < width * size ||
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
    return { get, count: a.count as number, component: a.componentType as number };
  };
  return { json, bin, accessor };
}

/**
 * Independently checks a Unity precision bundle against the scene it was made from: the exact member inventory and
 * manifest, every digest, the Editor helper's bytes, and, from the GLB itself, every node's name, parent and local
 * TRS (1e-5), every triangle corner's position (exact Float32), normal (1e-5), UV (exact Float32, within 1e-6) and
 * RGBA, the single unlit white opaque double-sided material, its nearest/clamp sampler and every embedded PNG pixel.
 * @throws RangeError `UNITY_PRECISION_PACKAGE_INVALID: <what differs>` at the first difference.
 */
export async function verifyUnityPrecisionBundle(
  scene: PrecisionScene,
  artifact: UnityPrecisionArtifact,
  expected: UnityPrecisionExpectation,
): Promise<UnityPrecisionVerification> {
  const app = nativeAppNames(expected.appName).name,
    extension = nativeExtension(expected.extension, 'extension'),
    masterExtension = nativeExtension(expected.master.extension, 'master.extension');
  const files = new Map(artifact.files.map((file) => [file.filename, file.bytes]));
  if (files.size !== artifact.files.length) fail('Duplicate bundle member');
  const manifests = [...files.keys()].filter((name) => name.endsWith('.' + extension));
  if (manifests.length !== 1) fail('Manifest inventory');
  const basename = manifests[0]!.slice(0, -('.' + extension).length);
  if (!/^[A-Za-z0-9_-]+$/.test(basename)) fail('Unsafe basename');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.get(manifests[0]!)!));
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
    ].sort(),
    'Manifest schema',
  );
  same([manifest.version, manifest.profileId], [1, 'unity-gltfast-static-point-clamp-v1'], 'Profile version');
  same(
    manifest.options,
    { layout: 'objects', transformMode: 'preserve', animation: 'static', skin: false, objectAnimation: false },
    'Explicit native options',
  );
  same(manifest.sourceSnapshotOptionsJSON, expected.snapshot.optionsJSON, 'Captured snapshot options');
  same(manifest.sourceSnapshotSha256, expected.snapshot.sha256, 'Captured scene identity');
  if (expected.reproduces && !expected.reproduces())
    fail('Complete original master reproduces captured frame and scope');
  same(manifest.sourceMaster.role, expected.master.role, 'Original master role');
  same(manifest.sourceMaster.filename, `${basename}-source.${masterExtension}`, 'Master filename');
  same(manifest.glb.filename, basename + '.glb', 'GLB filename');
  same(manifest.image.filename, basename + '-atlas.rgba', 'Image filename');
  same(
    [...files.keys()].sort(),
    [
      `${basename}.${extension}`,
      basename + '.glb',
      `${basename}-source.${masterExtension}`,
      basename + '-atlas.rgba',
      `Editor/${app}PrecisionImporter.cs`,
      basename + '-unity-README.txt',
    ].sort(),
    'Complete exact bundle inventory',
  );
  const master = files.get(manifest.sourceMaster.filename)!,
    glb = files.get(manifest.glb.filename)!,
    raw = files.get(manifest.image.filename)!,
    native = files.get(`Editor/${app}PrecisionImporter.cs`)!;
  same(sha256Hex(master), sha256Hex(expected.master.bytes), 'Every original project/workspace byte');
  same(sha256Hex(master), manifest.sourceMaster.sha256, 'Master digest');
  same(sha256Hex(glb), manifest.glb.sha256, 'GLB digest');
  const { createUnityPrecisionImporter } = await import('./unity-precision-importer.js');
  same(
    sha256Hex(native),
    sha256Hex(utf8Bytes(createUnityPrecisionImporter({ appName: app, extension }))),
    'Exact app-owned native integration',
  );
  same(manifest.importerSha256, sha256Hex(native), 'Native integration digest');
  const decoded = read(glb),
    j = decoded.json;
  if (
    j.skins?.length ||
    j.animations?.length ||
    j.nodes.some((n: ParsedJSON) => n.matrix !== undefined || n.skin !== undefined)
  )
    fail('Unexpected static source representation');
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
    for (const [field, wanted] of Object.entries({
      translation: object.transform.position,
      rotation: object.transform.rotation,
      scale: object.transform.scale,
    })) {
      const actual = node[field] ?? (field === 'rotation' ? [0, 0, 0, 1] : field === 'scale' ? [1, 1, 1] : [0, 0, 0]);
      if (
        !Array.isArray(actual) ||
        actual.length !== wanted.length ||
        actual.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value)) ||
        wanted.some((v, i) => Math.abs(actual[i] - v) > 1e-5)
      )
        fail('Authored local TRS');
    }
    if (!faces.length) {
      if (node.mesh !== undefined) fail('Empty logical node gained geometry');
      continue;
    }
    const mesh = j.meshes[node.mesh];
    if (!mesh || seenMeshes.has(node.mesh) || mesh.primitives.length !== 1)
      fail('Exact object/material mesh ownership');
    seenMeshes.add(node.mesh);
    meshCount++;
    const primitive = mesh.primitives[0];
    if ((primitive.mode ?? 4) !== 4 || primitive.targets || primitive.material !== 0)
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
  same([triangles, scene.objects.length], [manifest.triangles, manifest.objects], 'Actual source geometry/node totals');
  const used = new Set(scene.faces.map((f) => f.source.materialId));
  if (used.size !== 1 || j.materials.length !== 1 || j.images.length !== 1) fail('One bound material/image profile');
  const material = scene.document.materials[[...used][0]!]!,
    image = scene.document.assets[material.assetId!]!,
    m = j.materials[0];
  same(m.name, material.name, 'Original material identity');
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
  const texture = j.textures[m.pbrMetallicRoughness?.baseColorTexture?.index],
    sampler = j.samplers[texture?.sampler],
    pngInfo = j.images[texture?.source],
    view = j.bufferViews[pngInfo?.bufferView];
  if (!view || pngInfo.mimeType !== 'image/png' || pngInfo.uri || view.buffer !== 0) fail('Associated embedded PNG');
  same(
    [sampler.magFilter, sampler.minFilter, sampler.wrapS, sampler.wrapT],
    [9728, 9728, 33071, 33071],
    'Original exact sampler',
  );
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
    gate: 'independent-unity-source-package-byte-verification',
    nativeAcceptanceClaimed: false,
  };
}
