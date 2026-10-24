// Godot precision bundle: raw Float32 geometry streams per surface, the original atlases as PNG, the application's
// complete source master, a hash-bound manifest and the editor addon that imports them as a persistent scene.
import { decodePNG } from '@margoengine/decoders/png';
import { nativeAppNames, nativeExtension } from './native-names.js';
import {
  canonicalEqual,
  canonicalJSON,
  float32Within,
  onlyFields,
  opaqueRGBA8,
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

/** One raw little-endian stream in the geometry binary. */
export interface GodotPrecisionStream {
  readonly offset: number;
  readonly byteLength: number;
  readonly components: number;
  readonly count: number;
  readonly sha256: string;
}

/** Manifest of a Godot precision bundle, written as canonical JSON to `<basename>.<extension>`. */
export interface GodotPrecisionManifest {
  readonly version: 1;
  readonly profileId: 'godot-static-custom0-float32-v1';
  readonly options: PrecisionOptions;
  readonly sourceSnapshotSha256: string;
  readonly sourceSnapshotOptionsJSON: string;
  readonly sourceMaster: {
    readonly filename: string;
    readonly sha256: string;
    readonly role: 'original-full-source-project' | 'export-snapshot';
  };
  readonly geometry: { readonly filename: string; readonly byteLength: number; readonly sha256: string };
  readonly shaderSha256: string;
  readonly importerSha256: string;
  readonly objects: readonly {
    readonly id: string;
    readonly parentId: string | null;
    readonly name: string;
    readonly authoredTransformJSON: string;
  }[];
  readonly surfaces: readonly {
    readonly objectId: string;
    readonly materialId: string;
    readonly imageId: string;
    readonly vertexCount: number;
    readonly triangleCount: number;
    readonly attributes: Readonly<Record<'position' | 'normal' | 'uv' | 'color' | 'indices', GodotPrecisionStream>>;
  }[];
  readonly images: readonly {
    readonly id: string;
    readonly filename: string;
    readonly width: number;
    readonly height: number;
    readonly pngSha256: string;
    readonly rgbaSha256: string;
  }[];
  readonly triangles: number;
  readonly vertices: number;
}

/** A Godot precision bundle: its files (in bundle order) and its manifest. */
export interface GodotPrecisionArtifact {
  readonly files: readonly PrecisionFile[];
  readonly manifest: GodotPrecisionManifest;
}

/**
 * One surface of the captured scene in world space, unwelded: every triangle's three corners in order, with
 * counter-clockwise indices. The bundle writes indices clockwise, as Godot expects.
 */
export interface GodotPrecisionPrimitive {
  readonly objectId: string;
  readonly materialId: string | null;
  readonly positions: ArrayLike<number>;
  readonly normals: ArrayLike<number>;
  readonly uvs: ArrayLike<number>;
  readonly colors: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
}

/** Input of {@link createGodotPrecisionBundle}. */
export interface GodotPrecisionBundleInput {
  /** The owning application; names the addon (`addons/<appname>_precision/`), importer and metadata keys. */
  readonly appName: string;
  /** Manifest extension without the dot. */
  readonly extension: string;
  /** Bundle file stem: ASCII letters, digits, `_` and `-`. */
  readonly basename: string;
  readonly options: PrecisionOptions;
  /** The scene that passed {@link godotPrecisionPreflight}. */
  readonly scene: PrecisionScene;
  /** The scene's surfaces, baked to world space and unwelded, in the order they are written. */
  readonly primitives: readonly GodotPrecisionPrimitive[];
  /** Lossless PNG of every bound image, by image ID, in the order they are written. */
  readonly images: ReadonlyMap<string, Uint8Array>;
  readonly master: PrecisionMaster;
  readonly snapshot: PrecisionSnapshot;
}

/** What {@link verifyGodotPrecisionBundle} checks a bundle against, besides its scene. */
export interface GodotPrecisionExpectation {
  readonly appName: string;
  readonly extension: string;
  readonly master: PrecisionMaster;
  readonly snapshot: PrecisionSnapshot;
  /**
   * Called once the snapshot identity matches: false when the original master and capture options do not
   * reproduce the captured scene. Omit when the master is an export snapshot.
   */
  readonly reproduces?: (() => boolean) | undefined;
}

/** Result of {@link verifyGodotPrecisionBundle}. */
export interface GodotPrecisionVerification {
  readonly triangles: number;
  readonly vertices: number;
  readonly surfaces: number;
  readonly gate: 'independent-source-package-byte-verification';
  readonly nativeAcceptanceClaimed: false;
}

/**
 * Godot's capability policy for a precision bundle: objects layout with baked transforms, a static pose, no
 * unmapped object fields, output world positions and UVs that Float32 stores within 1e-5 and 1e-6, white corner
 * colours, materials in the bounded unlit profile, and one bound image of complete opaque RGBA8 pixels. No triangle
 * or image size cap. Findings are prefixed `GODOT_PRECISION_`; one per category, however many faces it affects.
 */
export function godotPrecisionPreflight<S extends PrecisionScene>(
  scene: S,
  options: PrecisionOptions,
  checks: PrecisionSourceChecks<S>,
): readonly PrecisionDiagnostic[] {
  const diagnostics: PrecisionDiagnostic[] = [];
  const reject = (code: string, message: string) => diagnostics.push({ code: 'GODOT_PRECISION_' + code, message });
  if (options.layout !== 'objects' || options.transformMode !== 'bake')
    reject(
      'TRANSFORMS',
      'Choose Objects layout and explicit Bake transforms for the native precision bundle. Logical ancestry and complete authored transforms remain in the source project.',
    );
  if (options.animation !== 'static' || options.skin || options.objectAnimation)
    reject(
      'STATIC_REQUIRED',
      'The native precision bundle supports a captured static pose/frame. Disable preserved skins and animation clips; retain the full editable source project.',
    );
  if (!scene.faces.length) reject('EMPTY', 'Choose a captured scope containing geometry.');
  const source = checks.document(scene);
  if (!source.fields || source.extensions)
    reject(
      'EXTENSION',
      'Unknown document extensions have no qualified precision appearance mapping. Keep the original source and use another target.',
    );
  try {
    checks.readMetadata(scene);
  } catch {
    reject('METADATA', 'The captured pose/frame contains unsupported rig, clip or UV metadata.');
  }
  const materials = new Set<string>();
  for (const object of scene.objects)
    if (
      !onlyFields(object, ['id', 'name', 'parentId', 'transform']) ||
      !onlyFields(object.transform, ['position', 'rotation', 'scale'])
    )
      reject('OBJECT_EXTENSION', `Object ${object.id} has unsupported extension fields.`);
  // One named diagnostic per category avoids materializing a million identical failures.
  let faceExtension = false,
    colors = false,
    position = false,
    uv = false;
  for (const face of scene.faces) {
    const source = face.source;
    materials.add(source.materialId);
    faceExtension ||= checks.faceExtension(face, scene);
    colors ||= source.colors.some((rgba) => rgba.some((n) => n !== 1));
    position ||= face.outputWorldCorners.some((point) => point.some((n) => !float32Within(n, 1e-5)));
    uv ||= face.effectiveUVs.some((point) => point.some((n) => !float32Within(n, 1e-6)));
  }
  if (faceExtension)
    reject('GEOMETRY_EXTENSION', 'Unknown face or vertex extensions have no qualified native mapping.');
  if (colors)
    reject(
      'VERTEX_COLOR',
      'The initial native precision appearance profile requires white opaque corner RGBA. Original nonwhite colors remain unchanged; use another export target.',
    );
  if (position)
    reject(
      'POSITION_PRECISION',
      'Source output positions exceed finite Float32 precision by more than 0.00001 metres. The source cannot be rounded or resized silently.',
    );
  if (uv)
    reject(
      'UV_PRECISION',
      'Source UVs exceed finite Float32 precision by more than 0.000001. Original UVs remain unchanged.',
    );
  const images = new Set<string>();
  for (const id of materials) {
    const m = scene.document.materials[id]! as S['document']['materials'][string];
    try {
      if (checks.materialOutsideProfile(m) || m.alphaMode !== 'opaque' || !m.doubleSided)
        reject(
          'APPEARANCE',
          `Material ${id} requires the qualified opaque double-sided basic/unlit, white tint, nearest/clamp profile.`,
        );
    } catch {
      reject('MATERIAL', `Material ${id} has unsupported appearance metadata.`);
    }
    if (m.assetId === null) reject('IMAGE_REQUIRED', `Material ${id} needs an original RGBA8 texture.`);
    else images.add(m.assetId);
  }
  for (const id of images) {
    const a = scene.document.assets[id]! as S['document']['assets'][string];
    if (checks.imageExtension(a) || !opaqueRGBA8(a))
      reject(
        'IMAGE',
        `Image ${id} must contain complete understood opaque RGBA8 pixels. The precision bundle never resizes, recompresses lossily or drops source images.`,
      );
  }
  // Prior native appearance evidence covers one atlas; no dimension or triangle cap is imposed.
  if (images.size !== 1)
    reject(
      'IMAGE_COUNT',
      'The initial native precision profile requires one bound original atlas. Multiple-image appearance awaits separate native qualification.',
    );
  return diagnostics;
}

const readme = (app: string, upper: string, extension: string, basename: string, masterExtension: string) =>
  `${app} Godot native precision bundle (static preview)\n\nExtract the COMPLETE bundle into a Godot 4 project root, retaining addons/. In Project Settings > Plugins enable ${app} Precision. Godot then imports ` +
  basename +
  `.${extension} as a native PackedScene. Drag that imported scene into your scene. The importer verifies full source hashes, raw geometry/UV/RGBA, effective Float32 CUSTOM0 normals, original texture pixels and material binding; it saves and independently reopens the native scene with CACHE_MODE_IGNORE and repeats the full readback. Any mismatch fails import.\n\nExplicit Bake transforms: native logical nodes use identity transforms with captured world geometry. Logical ancestry, original names and authored transform JSON are retained as metadata. The complete original .${masterExtension} project preserves editable source and workspace. No geometry simplification, vertex welding, lossy image compression or resizing is performed.\n\nThe effective rendering normal is original Float32 RGB in CUSTOM0; the included unlit shader explicitly assigns NORMAL = CUSTOM0.xyz. Godot's ordinary ARRAY_NORMAL is packed by the engine and is not claimed to retain full normal precision. Keep this ShaderMaterial for the qualified mapping. Static opaque double-sided unlit nearest/clamp one-atlas white-RGBA profile only. Other materials, animation, collisions, shader-output numeric precision, cross-device behavior and engine capacity need their own evidence. Godot GLB and all other exports retain their separate routes.\n\nNative readback emits ${upper}_GODOT_PRECISION PASS only after complete saved-resource readback. Consult the actual editor output; a browser download alone is not engine acceptance.\n`;

const addon = async (app: string, extension: string) => {
  const { createGodotPrecisionAddon } = await import('./godot-precision-addon.js');
  return createGodotPrecisionAddon({ appName: app, extension });
};

/**
 * Assembles a Godot precision bundle from a scene that passed {@link godotPrecisionPreflight}: one PNG per bound
 * image, `<basename>-precision.bin` (each surface's Float32 positions, normals, UVs and colours and Int32 clockwise
 * indices, back to back), the source master, the manifest, the addon under `addons/<appname>_precision/` and a
 * README. It does not verify the result; call {@link verifyGodotPrecisionBundle} for that.
 * @throws TypeError for an unsafe basename or invalid names; RangeError `GODOT_PRECISION_INDEX_RANGE` for an index
 * beyond signed 32-bit.
 */
export async function createGodotPrecisionBundle(input: GodotPrecisionBundleInput): Promise<GodotPrecisionArtifact> {
  const { basename, scene, master, snapshot } = input;
  if (!safeBasename(basename)) throw new TypeError('Choose a safe Godot precision basename.');
  const names = nativeAppNames(input.appName),
    extension = nativeExtension(input.extension, 'extension'),
    masterExtension = nativeExtension(master.extension, 'master.extension'),
    folder = `addons/${names.lower}_precision/`;
  const parts: Uint8Array[] = [],
    surfaces: GodotPrecisionManifest['surfaces'][number][] = [];
  let offset = 0,
    triangles = 0,
    vertices = 0;
  for (const primitive of input.primitives) {
    const attributes: Record<string, GodotPrecisionStream> = {};
    const streams = [
      ['position', primitive.positions, 3],
      ['normal', primitive.normals, 3],
      ['uv', primitive.uvs, 2],
      ['color', primitive.colors, 4],
      ['indices', primitive.indices, 1],
    ] as const;
    for (const [name, values, components] of streams) {
      const bytes = new Uint8Array(values.length * 4),
        view = new DataView(bytes.buffer);
      for (let i = 0; i < values.length; i++) {
        if (name === 'indices') {
          const at = i % 3 === 1 ? i + 1 : i % 3 === 2 ? i - 1 : i;
          const value = values[at]!;
          if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff)
            throw new RangeError(
              'GODOT_PRECISION_INDEX_RANGE: Source indices exceed exact native signed 32-bit range.',
            );
          view.setInt32(i * 4, value, true);
        } else view.setFloat32(i * 4, values[i]!, true);
      }
      attributes[name] = {
        offset,
        byteLength: bytes.length,
        components,
        count: values.length / components,
        sha256: sha256Hex(bytes),
      };
      parts.push(bytes);
      offset += bytes.length;
    }
    const m = scene.document.materials[primitive.materialId!]!;
    surfaces.push({
      objectId: primitive.objectId,
      materialId: primitive.materialId!,
      imageId: m.assetId!,
      vertexCount: primitive.positions.length / 3,
      triangleCount: primitive.indices.length / 3,
      attributes: attributes as unknown as GodotPrecisionManifest['surfaces'][number]['attributes'],
    });
    triangles += primitive.indices.length / 3;
    vertices += primitive.positions.length / 3;
  }
  const geometry = new Uint8Array(offset);
  let cursor = 0;
  for (const part of parts) {
    geometry.set(part, cursor);
    cursor += part.length;
  }
  const files: PrecisionFile[] = [],
    images: GodotPrecisionManifest['images'][number][] = [];
  for (const [index, [id, bytes]] of [...input.images].entries()) {
    const image = scene.document.assets[id]!,
      filename = `${basename}-atlas-${index}.png`;
    images.push({
      id,
      filename,
      width: image.width,
      height: image.height,
      pngSha256: sha256Hex(bytes),
      rgbaSha256: sha256Hex(Uint8Array.from(image.pixels)),
    });
    files.push({ filename, bytes, mimeType: 'image/png' });
  }
  const native = await addon(names.name, extension);
  const manifest: GodotPrecisionManifest = {
    version: 1,
    profileId: 'godot-static-custom0-float32-v1',
    options: { ...input.options },
    sourceSnapshotSha256: snapshot.sha256,
    sourceSnapshotOptionsJSON: snapshot.optionsJSON,
    sourceMaster: {
      filename: `${basename}-source.${masterExtension}`,
      sha256: sha256Hex(master.bytes),
      role: master.role,
    },
    geometry: { filename: `${basename}-precision.bin`, byteLength: geometry.length, sha256: sha256Hex(geometry) },
    shaderSha256: sha256Hex(utf8Bytes(native.shader)),
    importerSha256: sha256Hex(utf8Bytes(native.importer)),
    objects: scene.objects.map((o) => ({
      id: o.id,
      parentId: o.parentId,
      name: o.name,
      authoredTransformJSON: canonicalJSON(o.transform),
    })),
    surfaces,
    images,
    triangles,
    vertices,
  };
  const add = (filename: string, text: string, mimeType = 'text/plain') =>
    files.push({ filename, bytes: utf8Bytes(text), mimeType });
  files.push(
    { filename: manifest.geometry.filename, bytes: geometry, mimeType: 'application/octet-stream' },
    { filename: manifest.sourceMaster.filename, bytes: master.bytes, mimeType: 'application/json' },
  );
  add(`${basename}.${extension}`, canonicalJSON(manifest), 'application/json');
  add(folder + 'precision.gdshader', native.shader);
  add(folder + 'importer.gd', native.importer);
  add(folder + 'plugin.gd', native.plugin);
  add(folder + 'plugin.cfg', native.pluginConfig);
  add(`${basename}-godot-precision-README.txt`, readme(names.name, names.upper, extension, basename, masterExtension));
  return { files, manifest };
}

function fail(label: string): never {
  throw new RangeError('GODOT_PRECISION_PACKAGE_INVALID: ' + label);
}
const same = (a: unknown, b: unknown, label: string) => {
  if (!canonicalEqual(a, b)) fail(label);
};

/**
 * Independently checks a Godot precision bundle against the faces it was captured from, never the producer's
 * primitives: the exact member inventory and manifest, snapshot identity, the source master, object identities and
 * authored transforms, the addon's bytes, complete ordered stream coverage and hashes, every triangle corner's
 * Float32 world position (exact, within 1e-5), normal (1e-5), UV and RGBA (exact), clockwise indices that keep the
 * source winding, totals, and every original image pixel.
 * @throws RangeError `GODOT_PRECISION_PACKAGE_INVALID: <what differs>` at the first difference.
 */
export async function verifyGodotPrecisionBundle(
  scene: PrecisionScene,
  artifact: GodotPrecisionArtifact,
  expected: GodotPrecisionExpectation,
): Promise<GodotPrecisionVerification> {
  const names = nativeAppNames(expected.appName),
    extension = nativeExtension(expected.extension, 'extension'),
    masterExtension = nativeExtension(expected.master.extension, 'master.extension'),
    folder = `addons/${names.lower}_precision/`;
  const files = new Map(artifact.files.map((file) => [file.filename, file.bytes]));
  if (files.size !== artifact.files.length) fail('duplicate source files');
  const manifests = [...files.keys()].filter((name) => name.endsWith('.' + extension));
  if (manifests.length !== 1) fail('source manifest inventory');
  const basename = manifests[0]!.slice(0, -('.' + extension).length);
  if (!/^[A-Za-z0-9_-]+$/.test(basename)) fail('unsafe source basename');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.get(manifests[0]!)!));
  same(manifest, artifact.manifest, 'persisted manifest differs from returned manifest');
  same(manifest.sourceMaster.filename, `${basename}-source.${masterExtension}`, 'source master filename');
  same(manifest.geometry.filename, `${basename}-precision.bin`, 'source geometry filename');
  const expectedFiles = new Set([
    `${basename}.${extension}`,
    `${basename}-source.${masterExtension}`,
    `${basename}-precision.bin`,
    `${basename}-godot-precision-README.txt`,
    folder + 'importer.gd',
    folder + 'precision.gdshader',
    folder + 'plugin.gd',
    folder + 'plugin.cfg',
    ...manifest.images.map((image: { filename: string }, index: number) => {
      const name = `${basename}-atlas-${index}.png`;
      same(image.filename, name, 'ordered source image filename');
      return name;
    }),
  ]);
  same([...files.keys()].sort(), [...expectedFiles].sort(), 'complete safe source package inventory');
  if (manifest.version !== 1 || manifest.profileId !== 'godot-static-custom0-float32-v1') fail('manifest version');
  same(
    manifest.options,
    { layout: 'objects', transformMode: 'bake', animation: 'static', skin: false, objectAnimation: false },
    'native representation options',
  );
  same(manifest.sourceSnapshotSha256, expected.snapshot.sha256, 'captured evaluated scene identity');
  same(manifest.sourceSnapshotOptionsJSON, expected.snapshot.optionsJSON, 'exact capture options JSON');
  if (expected.reproduces && !expected.reproduces())
    fail('original full master and exact capture options reconstruct evaluated source');
  const master = files.get(manifest.sourceMaster.filename);
  if (!master) fail('missing complete master');
  same(manifest.sourceMaster.role, expected.master.role, 'master role');
  same(sha256Hex(master), sha256Hex(expected.master.bytes), 'complete original master and workspace');
  same(manifest.sourceMaster.sha256, sha256Hex(master), 'master hash');
  same(
    manifest.objects,
    scene.objects.map((o) => ({
      id: o.id,
      parentId: o.parentId,
      name: o.name,
      authoredTransformJSON: canonicalJSON(o.transform),
    })),
    'logical parents, exact names and authored transform metadata',
  );
  const native = await addon(names.name, extension);
  for (const [path, text] of [
    [folder + 'importer.gd', native.importer],
    [folder + 'precision.gdshader', native.shader],
    [folder + 'plugin.gd', native.plugin],
    [folder + 'plugin.cfg', native.pluginConfig],
  ]) {
    const bytes = files.get(path!);
    if (!bytes || sha256Hex(bytes) !== sha256Hex(utf8Bytes(text!))) fail('exact native importer/shader/plugin source');
  }
  same(manifest.shaderSha256, sha256Hex(utf8Bytes(native.shader)), 'shader hash');
  same(manifest.importerSha256, sha256Hex(utf8Bytes(native.importer)), 'importer hash');
  const geometry = files.get(manifest.geometry.filename);
  if (
    !geometry ||
    geometry.byteLength !== manifest.geometry.byteLength ||
    sha256Hex(geometry) !== manifest.geometry.sha256
  )
    fail('complete geometry binary');
  const view = new DataView(geometry.buffer, geometry.byteOffset, geometry.byteLength);
  let consumed = 0;
  const read = (stream: GodotPrecisionStream, components: number, count: number) => {
    if (
      stream.offset !== consumed ||
      stream.components !== components ||
      stream.count !== count ||
      stream.byteLength !== count * components * 4 ||
      consumed + stream.byteLength > geometry.length
    )
      fail('complete ordered raw stream coverage');
    if (sha256Hex(geometry.subarray(consumed, consumed + stream.byteLength)) !== stream.sha256) fail('raw stream hash');
    consumed += stream.byteLength;
    return (index: number, axis = 0) => view.getFloat32(stream.offset + (index * components + axis) * 4, true);
  };
  const groups = new Map<string, PrecisionFace[]>();
  for (const face of scene.faces) {
    const key = JSON.stringify([face.source.objectId, face.source.materialId]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(face);
  }
  if (manifest.surfaces.length !== groups.size) fail('complete source surface inventory');
  const seen = new Set<string>(),
    imageIds = new Set<string>();
  let triangles = 0,
    vertices = 0;
  for (const surface of manifest.surfaces) {
    const key = JSON.stringify([surface.objectId, surface.materialId]),
      faces = groups.get(key);
    if (!faces || seen.has(key)) fail('duplicate or unknown source surface association');
    seen.add(key);
    const count = faces.reduce((n, face) => n + face.worldBakedTriangles.length * 3, 0);
    same(
      [surface.vertexCount, surface.triangleCount],
      [count, count / 3],
      'every source triangle and unwelded associated corner',
    );
    same(surface.imageId, scene.document.materials[surface.materialId]!.assetId, 'source material image binding');
    imageIds.add(surface.imageId);
    const p = read(surface.attributes.position, 3, count),
      n = read(surface.attributes.normal, 3, count),
      uv = read(surface.attributes.uv, 2, count),
      color = read(surface.attributes.color, 4, count);
    read(surface.attributes.indices, 1, count);
    let vertex = 0;
    for (const face of faces)
      for (const corners of face.worldBakedTriangles) {
        const points = corners.map((corner) => face.outputWorldCorners[corner]!);
        const ab = points[1]!.map((value, axis) => value - points[0]![axis]!),
          ac = points[2]!.map((value, axis) => value - points[0]![axis]!);
        const scale = Math.max(...ab.map(Math.abs), ...ac.map(Math.abs));
        const u = ab.map((value) => value / scale),
          v = ac.map((value) => value / scale);
        const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        const length = Math.hypot(...cross),
          normal = cross.map((value) => value / length);
        if (!Number.isFinite(length) || length === 0) fail('independent nondegenerate source normal');
        const nativePoints: number[][] = [];
        for (let slot = 0; slot < 3; slot++) {
          const corner = corners[slot]!,
            actual = vertex + slot;
          for (let axis = 0; axis < 3; axis++) {
            if (
              !Object.is(p(actual, axis), Math.fround(points[slot]![axis]!)) ||
              Math.abs(p(actual, axis) - points[slot]![axis]!) > 1e-5
            )
              fail('source Float32 world-position association');
            if (!Number.isFinite(n(actual, axis)) || Math.abs(n(actual, axis) - normal[axis]!) > 1e-5)
              fail('source normal association');
          }
          nativePoints.push([p(actual, 0), p(actual, 1), p(actual, 2)]);
          for (let axis = 0; axis < 2; axis++)
            if (!Object.is(uv(actual, axis), Math.fround(face.effectiveUVs[corner]![axis]!)))
              fail('source UV association');
          for (let axis = 0; axis < 4; axis++)
            if (!Object.is(color(actual, axis), Math.fround(face.source.colors[corner]![axis]!)))
              fail('source corner RGBA association');
          const index = view.getInt32(surface.attributes.indices.offset + actual * 4, true);
          if (index !== vertex + [0, 2, 1][slot]!) fail('native CW index association');
        }
        const a = nativePoints[1]!.map((value, axis) => value - nativePoints[0]![axis]!),
          b = nativePoints[2]!.map((value, axis) => value - nativePoints[0]![axis]!);
        const area = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
        if (!(area.reduce((sum, value, axis) => sum + value * normal[axis]!, 0) > 0))
          fail('native Float32 geometry collapsed or reversed source winding');
        vertex += 3;
      }
    triangles += count / 3;
    vertices += count;
  }
  same(consumed, geometry.byteLength, 'no omitted or extra geometry streams');
  same([manifest.triangles, manifest.vertices], [triangles, vertices], 'actual decoded geometry totals');
  if (manifest.images.length !== imageIds.size) fail('original image inventory');
  for (const image of manifest.images) {
    if (!imageIds.delete(image.id)) fail('duplicate or unknown image identity');
    const originalImage = scene.document.assets[image.id]!,
      bytes = files.get(image.filename);
    if (!bytes || sha256Hex(bytes) !== image.pngSha256) fail('original PNG bytes');
    const decoded = decodePNG(bytes);
    same(
      [image.width, image.height, decoded.width, decoded.height],
      [originalImage.width, originalImage.height, originalImage.width, originalImage.height],
      'original full image dimensions',
    );
    same(sha256Hex(decoded.data), sha256Hex(Uint8Array.from(originalImage.pixels)), 'every original RGBA pixel');
    same(image.rgbaSha256, sha256Hex(decoded.data), 'RGBA hash');
  }
  return {
    triangles,
    vertices,
    surfaces: seen.size,
    gate: 'independent-source-package-byte-verification',
    nativeAcceptanceClaimed: false,
  };
}
