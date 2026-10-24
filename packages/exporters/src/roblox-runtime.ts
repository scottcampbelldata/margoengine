// Roblox runtime source bundle: every surface's exact world-baked geometry and the original images as base64 parts
// in an inert source Folder (place and model), with a Restore ModuleScript that rebuilds them live in Studio.
import { decodePNG } from '@margoengine/decoders/png';
import { nativeAppNames, nativeExtension } from './native-names.js';
import {
  canonicalEqual,
  canonicalJSON,
  onlyFields,
  type PrecisionFace,
  type PrecisionFile,
  type PrecisionImage,
  type PrecisionScene,
  type PrecisionSourceChecks,
  sha256Hex,
  utf8Bytes,
} from './precision-shared.js';
import {
  type RobloxPrimitiveInput,
  type RobloxTriangleIdentity,
  robloxChunkTriangleCounts,
  splitRobloxPrimitives,
} from './roblox.js';
import type { RobloxChunkOptions, RobloxDiagnostic } from './roblox-chunks.js';

export type { PrecisionFile, PrecisionScene, PrecisionSourceChecks } from './precision-shared.js';
export type { RobloxPrimitiveInput, RobloxTriangleIdentity } from './roblox.js';
export type { RobloxDiagnostic } from './roblox-chunks.js';

/** Triangles per runtime MeshPart: two under 20,000, where measured native copies lose data at 60,000 vertices. */
export const ROBLOX_RUNTIME_TRIANGLES_PER_CHUNK = 19_998;
/** The runtime representation's ID, written as the manifest's `profileId`. */
export const ROBLOX_RUNTIME_REPRESENTATION = 'roblox-editable-source-v1-candidate';

/** Export choices the runtime bundle accepts; native Roblox lighting must be accepted explicitly. */
export interface RobloxRuntimeOptions extends RobloxChunkOptions {
  readonly nativeLighting: boolean;
}
/** One payload: a file beside the source and the same bytes as base64 parts in the source Folder. */
export interface RobloxRuntimePayload {
  readonly id: string;
  readonly filename: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly partCount: number;
}
/** One runtime MeshPart: its surface, centre in studs, payload and source triangles. */
export interface RobloxRuntimeChunk {
  readonly chunkIndex: number;
  readonly objectId: string;
  readonly materialId: string | null;
  readonly imageId: string | null;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly centerStuds: readonly number[];
  readonly payload: RobloxRuntimePayload;
  readonly triangles: readonly RobloxTriangleIdentity[];
  readonly doubleSided: boolean;
}
/** One original image: raw top-left RGBA8 payload plus its lossless PNG. */
export interface RobloxRuntimeImage {
  readonly imageId: string;
  readonly width: number;
  readonly height: number;
  readonly rgbaSha256: string;
  readonly pngFilename: string;
  readonly payload: RobloxRuntimePayload;
}
/** Manifest of a runtime bundle, written as canonical JSON beside and inside the source Folder. */
export interface RobloxRuntimeManifest {
  readonly version: 1;
  readonly profileId: typeof ROBLOX_RUNTIME_REPRESENTATION;
  readonly triangleBudget: typeof ROBLOX_RUNTIME_TRIANGLES_PER_CHUNK;
  readonly sourceSnapshotSha256: string;
  readonly sourceMaster: {
    readonly role: 'original-full-source-project' | 'export-snapshot';
    readonly documentId: string;
    readonly filename: string;
    readonly sha256: string;
  };
  readonly outputName: string;
  readonly sourceFolderName: string;
  readonly options: RobloxRuntimeOptions;
  readonly transform: {
    readonly basis: 'Y180';
    readonly studsPerMeterNumerator: 25;
    readonly studsPerMeterDenominator: 7;
    readonly coordinateFrame: 'world-baked';
    readonly positionToleranceMeters: 0.00001;
    readonly normalTolerance: 0.00001;
  };
  readonly objects: readonly { readonly id: string; readonly parentId: string | null; readonly name: string }[];
  readonly chunks: readonly RobloxRuntimeChunk[];
  readonly images: readonly RobloxRuntimeImage[];
  readonly persistence: 'source-restored-live-objects';
  readonly nativeLighting: true;
  readonly limitations: readonly string[];
}
/** A runtime bundle: its files (source model, manifest, master, README, source place, then payloads) and manifest. */
export interface RobloxRuntimeArtifact {
  readonly files: readonly PrecisionFile[];
  readonly manifest: RobloxRuntimeManifest;
}

/**
 * What only the application can judge about its own records, for the runtime policy. Unlike the precision
 * bundles it reports face fields and vertex records separately, once per face or vertex.
 */
export interface RobloxRuntimeSourceChecks<S extends PrecisionScene = PrecisionScene>
  extends Omit<PrecisionSourceChecks<S>, 'faceExtension'> {
  /** True when a face's source record has fields with no mapping. */
  faceFieldsExtension(face: S['faces'][number]): boolean;
  /** True when a vertex is missing or has fields with no mapping. */
  vertexExtension(vertexId: string, scene: S): boolean;
}

/** Whether executed evidence qualifies the runtime representation; the preflight blocks export until it does. */
export interface RobloxRuntimeQualification {
  readonly representation: string;
  readonly qualified: boolean;
  readonly evidenceId: string | null;
}

/** The source master as stored in a runtime bundle. */
export interface RobloxRuntimeMaster {
  readonly bytes: Uint8Array;
  /** File extension without the dot; the member is `<basename>-source.<extension>`. */
  readonly extension: string;
  readonly role: 'original-full-source-project' | 'export-snapshot';
  /** The master document's ID. */
  readonly documentId: string;
}

/** Input of {@link createRobloxRuntimeBundle}. */
export interface RobloxRuntimeBundleInput {
  /** The owning application; names the source Folder (`<basename>_<appName>Source`) and Restore's attributes. */
  readonly appName: string;
  /** A legal single file name without extension or path, at most 180 characters. */
  readonly basename: string;
  readonly options: RobloxRuntimeOptions;
  /** The scene that passed {@link robloxRuntimeSourceDiagnostics}. */
  readonly scene: PrecisionScene;
  /** The scene's surfaces baked to world space with their triangle identities, in capture order. */
  readonly inputs: readonly RobloxPrimitiveInput[];
  /** Encodes a lossless PNG of every bound image, by image ID; called once the geometry is written. */
  readonly images: () => Promise<ReadonlyMap<string, Uint8Array>>;
  readonly master: RobloxRuntimeMaster;
  /** SHA-256 of the application's canonical encoding of the captured scene. */
  readonly snapshotSha256: string;
}

/** What {@link verifyRobloxRuntimeBundle} checks a bundle against, besides its scene. */
export interface RobloxRuntimeExpectation<S extends PrecisionScene = PrecisionScene> {
  readonly appName: string;
  readonly master: RobloxRuntimeMaster;
  readonly snapshotSha256: string;
  readonly checks: RobloxRuntimeSourceChecks<S>;
  /** False when the original master does not reproduce the captured scene. Omit for an export snapshot. */
  readonly reproduces?: (() => boolean) | undefined;
  /** False when parsing the stored master does not give back the complete project, workspace included. */
  readonly masterRoundTrips: (bytes: Uint8Array) => boolean;
  /** Parses the embedded manifest; pass a strict parser that rejects duplicate keys. Default `JSON.parse`. */
  readonly parseJSON?: (text: string) => unknown;
}

const FRAGMENT_CHARACTERS = 49_152;
const STUDS_PER_METER = 25 / 7;

/**
 * Checks a Roblox output basename: a legal single file name without extension or path, at most 180 characters.
 * @throws TypeError otherwise.
 */
export function assertRobloxBasename(value: string): void {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 180 ||
    value !== value.trim() ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(value) ||
    /[. ]$/.test(value) ||
    /^\.{1,2}$/.test(value) ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)
  )
    throw new TypeError('Roblox basename must be a legal single filename without an extension or path.');
}

const rgbaBytes = (image: PrecisionImage): boolean => {
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  )
    return false;
  const count = image.width * image.height * 4;
  if (!Number.isSafeInteger(count) || !Array.isArray(image.pixels) || image.pixels.length !== count) return false;
  return image.pixels.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
};

/**
 * The runtime representation's source policy, without splitting, encoding or decoding anything: objects layout,
 * baked transforms, a static unrigged snapshot without object clips, accepted native lighting, mappable document,
 * object, face and vertex records, a complete acyclic hierarchy at most 61 deep, white corner colours, finite
 * Float32 UVs (within 1e-6) and positions, materials in the bounded unlit profile, and one opaque RGBA8 image of
 * at most 1024 × 1024. One finding per failing record.
 */
export function robloxRuntimeSourceDiagnostics<S extends PrecisionScene>(
  scene: S,
  options: RobloxRuntimeOptions,
  checks: RobloxRuntimeSourceChecks<S>,
  appName: string,
): readonly RobloxDiagnostic[] {
  const app = nativeAppNames(appName).name;
  const result: RobloxDiagnostic[] = [];
  if (options.layout !== 'objects')
    result.push({
      code: 'ROBLOX_RUNTIME_OBJECTS_REQUIRED',
      message:
        'Roblox runtime export requires Objects layout to retain logical object and chunk ownership. Choose Objects before exporting.',
    });
  if (options.transformMode !== 'bake')
    result.push({
      code: 'ROBLOX_RUNTIME_BAKE_REQUIRED',
      message:
        'Roblox runtime export requires explicit Bake transforms. It writes captured world geometry with logical parents; authored editable local TRS remains in the complete source project. Choose Bake transforms to accept that representation.',
    });
  if (options.animation !== 'static')
    result.push({
      code: 'ROBLOX_RUNTIME_STATIC_REQUIRED',
      message:
        'Roblox runtime export currently supports an evaluated static snapshot. Choose Static; flipbook playback has no qualified runtime mapping.',
    });
  if (options.skin || scene.rigMode === 'skin')
    result.push({
      code: 'ROBLOX_RUNTIME_SKIN_UNSUPPORTED',
      message:
        'Roblox runtime export cannot preserve editable skins or rigs. Choose a supported unrigged static snapshot or retain the complete source project.',
    });
  if (options.objectAnimation)
    result.push({
      code: 'ROBLOX_RUNTIME_OBJECT_CLIPS_UNSUPPORTED',
      message:
        'Roblox runtime export cannot preserve object animation clips. Choose Static and disable preserved object clips, or retain the complete source project.',
    });
  if (options.nativeLighting !== true)
    result.push({
      code: 'ROBLOX_RUNTIME_NATIVE_LIGHTING_REQUIRED',
      message: `Explicitly accept native Roblox lighting before runtime export. Roblox does not preserve ${app} basic/unlit lighting; geometry, normals and original texture pixels still require independent preservation.`,
    });

  const document = scene.document,
    source = checks.document(scene);
  if (!source.fields || source.extensions || !source.extensionShape)
    result.push({
      code: 'ROBLOX_RUNTIME_METADATA_UNSUPPORTED',
      message:
        'The initial Roblox runtime representation cannot interpret unknown document extensions or shader metadata. Preserve the source project and choose a supported static source; opaque metadata is never assumed to have no effect.',
    });
  try {
    checks.readMetadata(scene);
  } catch (error) {
    result.push({
      code: 'ROBLOX_RUNTIME_METADATA_UNSUPPORTED',
      message: `Static snapshot metadata is unsupported: ${error instanceof Error ? error.message : String(error)} Preserve the source and use a supported evaluated pose/frame; unknown rig or clip versions are never discarded implicitly.`,
    });
  }

  const objects = new Map(scene.objects.map((object) => [object.id, object]));
  const resolvedDepths = new Map<string, number>();
  for (const object of scene.objects) {
    if (
      !onlyFields(object, ['id', 'name', 'parentId', 'transform']) ||
      !onlyFields(object.transform, ['position', 'rotation', 'scale'])
    )
      result.push({
        code: 'ROBLOX_RUNTIME_OBJECT_EXTENSION_UNSUPPORTED',
        objectId: object.id,
        message: `Object ${object.id} has unknown object or transform fields. Preserve the source and use a qualified static object representation.`,
      });
    const path: string[] = [],
      seen = new Set<string>();
    let current: typeof object | undefined = object;
    let invalid = false;
    while (current && !resolvedDepths.has(current.id)) {
      if (seen.has(current.id)) {
        invalid = true;
        break;
      }
      seen.add(current.id);
      path.push(current.id);
      const parent: string | null = current.parentId;
      current = parent === null ? undefined : objects.get(parent);
      if (parent !== null && !current) {
        invalid = true;
        break;
      }
    }
    if (invalid) {
      result.push({
        code: 'ROBLOX_RUNTIME_HIERARCHY_INVALID',
        objectId: object.id,
        message: `Object ${object.id} has a missing or cyclic source parent. Restore a complete acyclic captured hierarchy before exporting.`,
      });
      continue;
    }
    let depth = current ? resolvedDepths.get(current.id)! : 0;
    for (let index = path.length - 1; index >= 0; index--) resolvedDepths.set(path[index]!, ++depth);
    // Conservative space for the owned output root, MeshPart and SurfaceAppearance.
    const emittedDepth = resolvedDepths.get(object.id)! + 3;
    if (emittedDepth > 64)
      result.push({
        code: 'ROBLOX_RUNTIME_HIERARCHY_DEPTH',
        objectId: object.id,
        message: `Object ${object.id} needs runtime hierarchy depth ${emittedDepth}; the limit is 64 including the runtime root, MeshPart and appearance. Shorten the authored ancestry before exporting.`,
      });
  }

  const materials = new Map<string, string>(),
    checkedVertices = new Set<string>();
  for (const face of scene.faces) {
    const faceSource = face.source,
      objectId = faceSource.objectId;
    if (!materials.has(faceSource.materialId)) materials.set(faceSource.materialId, objectId);
    if (checks.faceFieldsExtension(face))
      result.push({
        code: 'ROBLOX_RUNTIME_FACE_EXTENSION_UNSUPPORTED',
        objectId,
        message: `Face ${faceSource.id} on object ${objectId} has unknown geometry fields. Preserve the original source and use a qualified static geometry representation.`,
      });
    if (faceSource.colors.some((color) => color.length !== 4 || color.some((value) => value !== 1)))
      result.push({
        code: 'ROBLOX_RUNTIME_VERTEX_COLOR_UNSUPPORTED',
        objectId,
        materialId: faceSource.materialId,
        message: `Face ${faceSource.id} on object ${objectId} has nonwhite vertex RGBA. Only opaque white corner colors have current runtime appearance evidence; retain the original colors or choose another target.`,
      });
    if (
      face.effectiveUVs.some((uv) => uv.some((value) => !Number.isFinite(Math.fround(value)))) ||
      face.outputWorldCorners.some((point) => point.some((value) => !Number.isFinite(Math.fround(value))))
    )
      result.push({
        code: 'ROBLOX_RUNTIME_ATTRIBUTE_RANGE',
        objectId,
        materialId: faceSource.materialId,
        message: `Face ${faceSource.id} on object ${objectId} has UV or output coordinates outside finite Float32 range. Reduce the source coordinate range explicitly before exporting.`,
      });
    if (face.effectiveUVs.some((uv) => uv.some((value) => Math.abs(Math.fround(value) - value) > 0.000001)))
      result.push({
        code: 'ROBLOX_RUNTIME_UV_PRECISION',
        objectId,
        materialId: faceSource.materialId,
        message: `Face ${faceSource.id} on object ${objectId} has UV coordinates whose Float32 encoding exceeds the 0.000001 source tolerance. Reduce the authored UV range explicitly or choose another target; runtime export cannot silently round away this detail.`,
      });
    for (const id of faceSource.vertices) {
      if (checkedVertices.has(id)) continue;
      checkedVertices.add(id);
      if (checks.vertexExtension(id, scene))
        result.push({
          code: 'ROBLOX_RUNTIME_VERTEX_EXTENSION_UNSUPPORTED',
          objectId,
          message: `Vertex ${id} on object ${objectId} is missing or has unknown vertex fields. Preserve the original source and restore supported static vertex records.`,
        });
    }
  }
  if (!scene.faces.length)
    result.push({
      code: 'ROBLOX_RUNTIME_EMPTY_GEOMETRY',
      message: 'The captured scope has no faces. Choose a scope containing geometry before exporting.',
    });

  const images = new Set<string>();
  for (const [materialId, objectId] of materials) {
    const material = document.materials[materialId] as S['document']['materials'][string] | undefined;
    const imageId = material?.assetId ?? undefined;
    const identities = { objectId, materialId, ...(imageId === undefined ? {} : { imageId }) };
    const label = `Material ${materialId}${imageId === undefined ? '' : ` image ${imageId}`} on object ${objectId}`;
    if (!material) {
      result.push({
        ...identities,
        code: 'ROBLOX_RUNTIME_MATERIAL_INVALID',
        message: `${label} is missing. Restore the complete canonical material before exporting.`,
      });
      continue;
    }
    try {
      if (checks.materialOutsideProfile(material) || material.alphaMode !== 'opaque' || !material.doubleSided)
        result.push({
          ...identities,
          code: 'ROBLOX_RUNTIME_APPEARANCE_UNSUPPORTED',
          message: `${label} requires a qualified opaque, double-sided basic material with white tint, opacity one, black emission/specular, normal blending and nearest filters. Preserve the authored appearance or choose another target; runtime export does not rewrite materials.`,
        });
    } catch (error) {
      result.push({
        ...identities,
        code: 'ROBLOX_RUNTIME_MATERIAL_INVALID',
        message: `${label}: ${error instanceof Error ? error.message : String(error)} Preserve the original appearance and choose a supported material version.`,
      });
    }
    if (imageId === undefined) {
      result.push({
        ...identities,
        code: 'ROBLOX_RUNTIME_TEXTURE_REQUIRED',
        message: `${label} needs an original canonical RGBA8 image for the initial textured runtime representation. Assign a supported image or choose another target.`,
      });
      continue;
    }
    if (images.has(imageId)) continue;
    images.add(imageId);
    const image = document.assets[imageId] as S['document']['assets'][string] | undefined;
    if (!image || !rgbaBytes(image) || checks.imageExtension(image)) {
      result.push({
        ...identities,
        code: 'ROBLOX_RUNTIME_TEXTURE_INVALID',
        message: `${label} needs positive integer dimensions and complete understood RGBA8 image records. Restore original image data before exporting; unknown fields are not assumed harmless.`,
      });
      continue;
    }
    if (image.width > 1024 || image.height > 1024)
      result.push({
        ...identities,
        code: 'ROBLOX_RUNTIME_TEXTURE_LIMIT',
        message: `${label} is ${image.width}×${image.height}; EditableImage supports at most 1024×1024. Choose a target accepting the original dimensions; runtime export never resizes or caps the source.`,
      });
    if (image.pixels.some((value, index) => index % 4 === 3 && value !== 255))
      result.push({
        ...identities,
        code: 'ROBLOX_RUNTIME_TEXTURE_ALPHA_UNSUPPORTED',
        message: `${label} contains nonopaque original alpha. Only fully opaque image pixels have current runtime appearance evidence; preserve all original pixels and choose another target.`,
      });
  }
  if (images.size > 1)
    result.push({
      code: 'ROBLOX_RUNTIME_IMAGE_COUNT_UNQUALIFIED',
      message: `The captured scope uses ${images.size} images. The initial runtime representation has native evidence for one bound original image; multiple-image behavior requires separate qualification. Preserve the source images and choose another target.`,
    });
  return result;
}

/**
 * Count-only emitted-chunk bounds. Each group follows the same captured face/triangle traversal as the runtime
 * stream, without allocating vertex, attribute or split buffers. Native dimensions must fit the measured
 * MeshPart.Size range without clamping.
 */
export function robloxRuntimeSizeDiagnostics(scene: PrecisionScene): readonly RobloxDiagnostic[] {
  type Bounds = {
    readonly objectId: string;
    readonly materialId: string;
    readonly min: number[];
    readonly max: number[];
    triangles: number;
    chunk: number;
    readonly limits: readonly number[];
  };
  const totals = new Map<string, number>();
  for (const face of scene.faces) {
    const key = JSON.stringify([face.source.objectId, face.source.materialId]);
    totals.set(key, (totals.get(key) ?? 0) + face.worldBakedTriangles.length);
  }
  const groups = new Map<string, Bounds>(),
    result: RobloxDiagnostic[] = [];
  const flush = (bounds: Bounds): void => {
    if (!bounds.triangles) return;
    const extents = bounds.min.map((minimum, axis) => {
      const lo = (axis === 1 ? minimum : -bounds.max[axis]!) * (25 / 7),
        hi = (axis === 1 ? bounds.max[axis]! : -minimum) * (25 / 7),
        center = Math.fround((lo + hi) / 2);
      return Math.fround(Math.fround(hi - center) - Math.fround(lo - center));
    });
    const axes = ['X', 'Y', 'Z'].filter((_axis, index) => !(extents[index]! > 0));
    if (axes.length)
      result.push({
        code: 'ROBLOX_RUNTIME_ZERO_EXTENT_UNQUALIFIED',
        objectId: bounds.objectId,
        materialId: bounds.materialId,
        message: `Object ${bounds.objectId} material ${bounds.materialId} runtime chunk ${bounds.chunk} has zero native ${axes.join('/')} extent after Float32 source coordinates. This geometry has no qualified exact MeshPart size mapping; choose another target. Export never adds thickness, clamps size or drops triangles to fit.`,
      });
    else if (extents.some((extent) => extent < Math.fround(0.001) || extent > 2048))
      result.push({
        code: 'ROBLOX_RUNTIME_SIZE_RANGE_UNSUPPORTED',
        objectId: bounds.objectId,
        materialId: bounds.materialId,
        message: `Object ${bounds.objectId} material ${bounds.materialId} runtime chunk ${bounds.chunk} has native dimensions ${extents.join(' × ')} studs outside the exact MeshPart.Size range of 0.001 through 2048 studs. Choose another target; export never resizes the geometry or changes the source to fit.`,
      });
    bounds.chunk++;
    bounds.triangles = 0;
    bounds.min.fill(Infinity);
    bounds.max.fill(-Infinity);
  };
  for (const face of scene.faces) {
    const { objectId, materialId } = face.source,
      key = JSON.stringify([objectId, materialId]);
    let bounds = groups.get(key);
    if (!bounds) {
      bounds = {
        objectId,
        materialId,
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity],
        triangles: 0,
        chunk: 0,
        limits: robloxChunkTriangleCounts(totals.get(key)!, ROBLOX_RUNTIME_TRIANGLES_PER_CHUNK, 'balanced'),
      };
      groups.set(key, bounds);
    }
    for (const triangle of face.worldBakedTriangles) {
      for (const corner of triangle)
        for (let axis = 0; axis < 3; axis++) {
          // Match the encoder's source Float32 rounding before basis, units and centering.
          const value = Math.fround(face.outputWorldCorners[corner]![axis]!);
          bounds.min[axis] = Math.min(bounds.min[axis]!, value);
          bounds.max[axis] = Math.max(bounds.max[axis]!, value);
        }
      if (++bounds.triangles === bounds.limits[bounds.chunk]) flush(bounds);
    }
  }
  for (const bounds of groups.values()) flush(bounds);
  return result;
}

/**
 * The fixed production gate: {@link robloxRuntimeSourceDiagnostics}, then (when those pass) the emitted chunks'
 * native size range, then `ROBLOX_RUNTIME_UNQUALIFIED` unless `qualification` names executed evidence.
 */
export function robloxRuntimePreflight<S extends PrecisionScene>(
  scene: S,
  options: RobloxRuntimeOptions,
  checks: RobloxRuntimeSourceChecks<S>,
  appName: string,
  qualification: RobloxRuntimeQualification,
): readonly RobloxDiagnostic[] {
  const diagnostics = [...robloxRuntimeSourceDiagnostics(scene, options, checks, appName)];
  if (!diagnostics.length) diagnostics.push(...robloxRuntimeSizeDiagnostics(scene));
  if (!qualification.qualified || !qualification.evidenceId?.trim())
    diagnostics.push({
      code: 'ROBLOX_RUNTIME_UNQUALIFIED',
      message: `Runtime representation ${ROBLOX_RUNTIME_REPRESENTATION} awaits actual app-produced package import, native readback and fresh-place post-restart restore evidence. Candidate source checks do not qualify this target; choose another export target while qualification is open.`,
    });
  return diagnostics;
}

function xmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
function base64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const pieces: string[] = [];
  let piece = '';
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at]!,
      b = bytes[at + 1],
      c = bytes[at + 2];
    piece +=
      alphabet[a >> 2]! +
      alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]! +
      (b === undefined ? '=' : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]!) +
      (c === undefined ? '=' : alphabet[c & 63]!);
    if (piece.length >= FRAGMENT_CHARACTERS) {
      pieces.push(piece);
      piece = '';
    }
  }
  if (piece) pieces.push(piece);
  return pieces.join('');
}
function fragments(bytes: Uint8Array): readonly string[] {
  const encoded = base64(bytes),
    result: string[] = [];
  for (let at = 0; at < encoded.length; at += FRAGMENT_CHARACTERS)
    result.push(encoded.slice(at, at + FRAGMENT_CHARACTERS));
  return result;
}
function serializeSource(
  manifest: RobloxRuntimeManifest,
  manifestBytes: Uint8Array,
  payloadBytes: ReadonlyMap<string, Uint8Array>,
  restoreSourceText: string,
): { readonly model: Uint8Array; readonly place: Uint8Array } {
  let referent = 0;
  const item = (kind: string, name: string, properties: string, children: string): string =>
    `<Item class="${kind}" referent="RBX${referent++}"><Properties><string name="Name">${xmlText(name)}</string>${properties}</Properties>${children}</Item>`;
  const folder = (name: string, children: string): string => item('Folder', name, '', children);
  const data = (name: string, bytes: Uint8Array): string =>
    folder(
      name,
      fragments(bytes)
        .map((part, i) => item('StringValue', String(i).padStart(6, '0'), `<string name="Value">${part}</string>`, ''))
        .join(''),
    );
  const restore = item(
    'ModuleScript',
    'Restore',
    `<ProtectedString name="Source"><![CDATA[${restoreSourceText.replaceAll(']]>', ']]]]><![CDATA[>')}]]></ProtectedString>`,
    '',
  );
  const children =
    restore +
    data('Manifest', manifestBytes) +
    folder('Payloads', [...payloadBytes].map(([id, bytes]) => data(id, bytes)).join(''));
  const sourceItem = folder(manifest.sourceFolderName, children);
  const prefix = `<?xml version="1.0" encoding="utf-8"?><roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="4"><External>null</External><External>nil</External>`;
  return {
    model: utf8Bytes(`${prefix}${sourceItem}</roblox>`),
    place: utf8Bytes(
      `${prefix}<Item class="Workspace" referent="RBXWorkspace"><Properties><string name="Name">Workspace</string></Properties>${sourceItem}</Item></roblox>`,
    ),
  };
}

const restoreText = async (manifestSha256: string, appName: string) =>
  (await import('./roblox-runtime-restore.js')).createRobloxRuntimeRestore(manifestSha256, { appName });

/**
 * Assembles a runtime bundle from a scene that passed {@link robloxRuntimeSourceDiagnostics}: splits each surface
 * into balanced parts of at most {@link ROBLOX_RUNTIME_TRIANGLES_PER_CHUNK} triangles, writes each part's vertices
 * (Float32 position in studs about its centre with the Y-180 basis, normal, UV, RGBA) and indices, every image's raw
 * RGBA and PNG, the manifest, a README and the source Folder as a model (`.rbxmx`) and place (`.rbxlx`). It does not
 * verify the result; call {@link verifyRobloxRuntimeBundle} for that.
 * @throws TypeError for an unsafe basename; RangeError `ROBLOX_RUNTIME_POSITION_PRECISION`, `_UV_PRECISION` or
 * `_FLOAT32` when Float32 cannot carry a value within tolerance, and `_EMPTY_GEOMETRY` for no triangles.
 */
export async function createRobloxRuntimeBundle(input: RobloxRuntimeBundleInput): Promise<RobloxRuntimeArtifact> {
  const { basename, scene, master } = input;
  assertRobloxBasename(basename);
  const app = nativeAppNames(input.appName).name,
    masterExtension = nativeExtension(master.extension, 'master.extension'),
    options = { ...input.options };
  const files: PrecisionFile[] = [],
    payloadBytes = new Map<string, Uint8Array>();
  const payload = (id: string, filename: string, bytes: Uint8Array, mimeType: string): RobloxRuntimePayload => {
    files.push({ filename, bytes, mimeType });
    payloadBytes.set(id, bytes);
    return {
      id,
      filename,
      byteLength: bytes.length,
      sha256: sha256Hex(bytes),
      partCount: Math.ceil((Math.ceil(bytes.length / 3) * 4) / FRAGMENT_CHARACTERS),
    };
  };
  const chunks: RobloxRuntimeChunk[] = [];
  for (const chunk of splitRobloxPrimitives(input.inputs, ROBLOX_RUNTIME_TRIANGLES_PER_CHUNK, 'balanced')) {
    const p = chunk.primitive,
      count = p.positions.length / 3;
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++)
      for (let axis = 0; axis < 3; axis++) {
        const native = Math.fround(p.positions[i * 3 + axis]!) * (axis === 1 ? 1 : -1) * STUDS_PER_METER;
        min[axis] = Math.min(min[axis]!, native);
        max[axis] = Math.max(max[axis]!, native);
      }
    const centerStuds = min.map((lo, axis) => Math.fround((lo + max[axis]!) / 2));
    const bytes = new Uint8Array(count * 48 + p.indices.length * 4),
      view = new DataView(bytes.buffer);
    for (let i = 0; i < count; i++) {
      const tuple: number[] = [];
      for (let axis = 0; axis < 3; axis++) {
        const sign = axis === 1 ? 1 : -1,
          value = p.positions[i * 3 + axis]!;
        const local = Math.fround(Math.fround(value) * sign * STUDS_PER_METER - centerStuds[axis]!);
        const actual = (sign * (local + centerStuds[axis]!)) / STUDS_PER_METER;
        if (!Number.isFinite(local) || !Number.isFinite(centerStuds[axis]) || Math.abs(actual - value) > 0.00001)
          throw new RangeError(
            `ROBLOX_RUNTIME_POSITION_PRECISION: Object ${p.objectId} exceeds native Float32 reconstruction tolerance; source is unchanged.`,
          );
        tuple.push(local);
      }
      for (let axis = 0; axis < 3; axis++) tuple.push(Math.fround(p.normals[i * 3 + axis]!) * (axis === 1 ? 1 : -1));
      for (let axis = 0; axis < 2; axis++) {
        const value = p.uvs[i * 2 + axis]!,
          stored = Math.fround(value);
        if (!Number.isFinite(stored) || Math.abs(stored - value) > 0.000001)
          throw new RangeError(
            `ROBLOX_RUNTIME_UV_PRECISION: Object ${p.objectId} exceeds native Float32 UV reconstruction tolerance; source is unchanged.`,
          );
        tuple.push(stored);
      }
      for (let channel = 0; channel < 4; channel++) tuple.push(Math.fround(p.colors[i * 4 + channel]!));
      if (!tuple.every(Number.isFinite))
        throw new RangeError('ROBLOX_RUNTIME_FLOAT32: Associated source attributes exceed finite Float32 capacity.');
      tuple.forEach((value, at) => view.setFloat32(i * 48 + at * 4, value, true));
    }
    p.indices.forEach((index, at) => view.setUint32(count * 48 + at * 4, index, true));
    const id = `geometry-${String(chunk.chunkIndex).padStart(6, '0')}`,
      material = p.materialId === null ? undefined : scene.document.materials[p.materialId];
    chunks.push({
      chunkIndex: chunk.chunkIndex,
      objectId: p.objectId,
      materialId: p.materialId,
      imageId: material?.assetId ?? null,
      vertexCount: count,
      triangleCount: chunk.triangles.length,
      centerStuds,
      payload: payload(id, `${id}.bin`, bytes, 'application/octet-stream'),
      triangles: chunk.triangles,
      doubleSided: material?.doubleSided ?? false,
    });
  }
  if (!chunks.length) throw new RangeError('ROBLOX_RUNTIME_EMPTY_GEOMETRY: Capture a scope containing triangles.');
  const pngs = await input.images(),
    images: RobloxRuntimeImage[] = [];
  for (const [index, imageId] of [...pngs.keys()].sort().entries()) {
    const asset = scene.document.assets[imageId]!,
      id = `image-${String(index).padStart(6, '0')}`,
      bytes = Uint8Array.from(asset.pixels),
      pngFilename = `${id}.png`;
    const data = payload(id, `${id}.rgba`, bytes, 'application/octet-stream');
    images.push({
      imageId,
      width: asset.width,
      height: asset.height,
      rgbaSha256: data.sha256,
      pngFilename,
      payload: data,
    });
    files.push({ filename: pngFilename, bytes: pngs.get(imageId)!, mimeType: 'image/png' });
  }
  const manifest: RobloxRuntimeManifest = {
    version: 1,
    profileId: ROBLOX_RUNTIME_REPRESENTATION,
    triangleBudget: ROBLOX_RUNTIME_TRIANGLES_PER_CHUNK,
    sourceSnapshotSha256: input.snapshotSha256,
    sourceMaster: {
      role: master.role,
      documentId: master.documentId,
      filename: `${basename}-source.${masterExtension}`,
      sha256: sha256Hex(master.bytes),
    },
    outputName: `${basename}_Live`,
    sourceFolderName: `${basename}_${app}Source`,
    options,
    transform: {
      basis: 'Y180',
      studsPerMeterNumerator: 25,
      studsPerMeterDenominator: 7,
      coordinateFrame: 'world-baked',
      positionToleranceMeters: 0.00001,
      normalTolerance: 0.00001,
    },
    objects: scene.objects.map(({ id, parentId, name }) => ({ id, parentId, name })),
    chunks,
    images,
    persistence: 'source-restored-live-objects',
    nativeLighting: true,
    limitations: [
      'Candidate static opaque nearest-textured source restore; broader production qualification remains open.',
      'The runtime representation retains every source triangle across MeshParts of at most 19,998 triangles. The complete master and other export formats retain their own capacities.',
      `Native Roblox lighting accepted; no ${app} unlit shader or material-rendering parity claim.`,
      'EditableMesh and EditableImage are live objects, not persistent saved mesh/image assets; retain the source Folder and explicitly rerun Restore after reopening in a clean place.',
      'World-baked chunk geometry retains logical object identity; native local pivots are not the editable master transforms.',
      'No upload, publication, collision, animation, skin, cross-device, million-triangle capacity or performance qualification is implied.',
    ],
  };
  const manifestBytes = utf8Bytes(canonicalJSON(manifest)),
    manifestHash = sha256Hex(manifestBytes);
  const readme = `${app} Roblox exact-source restore (version 1 candidate)\n\nIn Roblox Studio choose File > Open and open ${basename}-roblox-source.rbxlx. This source place contains only Workspace and the inert source Folder; it has no built asset geometry and does not run automatically. Then run in the Command Bar:\n\nrequire(workspace:FindFirstChild(${JSON.stringify(manifest.sourceFolderName)}).Restore)()\n\nThe secondary ${basename}-roblox-source.rbxmx contains the identical source Folder for supported model-import workflows. If that Folder is selected in a clean local place, the equivalent command is require(game:GetService("Selection"):Get()[1].Restore)().\n\nThe source Folder contains persistent source data and a ModuleScript returning a restore function. Existing output is never replaced. All payload hashes, full image pixels, associated native vertices/normals/UV/RGBA and triangle counts are checked before a new Model is parented to Workspace. Allocation failure leaves existing objects and source intact.\n\nLive EditableMesh/EditableImage objects do NOT serialize as standalone saved geometry. Keep the original source place/Folder/package. After reopening, open the original clean source .rbxlx file and explicitly rerun Restore. The source .rbxlx and .rbxmx files are persistent source artifacts. Do not infer that saving a built live output preserves complete asset geometry.\n\nSource master role: ${manifest.sourceMaster.role}. ${manifest.sourceMaster.filename} preserves its captured document and workspace; an export-snapshot fallback uses a default workspace and is not an original authoring-project claim.\n\n${manifest.limitations.join('\n')}\n\nManifest SHA-256: ${manifestHash}\nSource master SHA-256: ${manifest.sourceMaster.sha256}\n`;
  const source = serializeSource(manifest, manifestBytes, payloadBytes, await restoreText(manifestHash, app));
  files.unshift(
    { filename: `${basename}-roblox-source.rbxmx`, bytes: source.model, mimeType: 'application/xml' },
    { filename: `${basename}-runtime-manifest.json`, bytes: manifestBytes, mimeType: 'application/json' },
    { filename: manifest.sourceMaster.filename, bytes: master.bytes, mimeType: 'application/json' },
    { filename: `${basename}-roblox-README.txt`, bytes: utf8Bytes(readme), mimeType: 'text/plain' },
    { filename: `${basename}-roblox-source.rbxlx`, bytes: source.place, mimeType: 'application/xml' },
  );
  return { files, manifest };
}

type XmlNode = {
  tag: string;
  attributes: Record<string, string>;
  text: string;
  children: XmlNode[];
  start: number;
  end: number;
};
function fail(message: string): never {
  throw new RangeError(`ROBLOX_RUNTIME_VERIFY: ${message}.`);
}
function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('invalid UTF-8 source');
  }
}
function entities(text: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(text)) fail('unsupported XML entity');
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => {
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name]!;
  });
}
/** A non-networked parser for the emitted XML subset, rejecting foreign declarations and markup. */
function xml(bytes: Uint8Array): XmlNode {
  const text = utf8(bytes),
    declaration = /^<\?xml version="1\.0" encoding="(?:utf-8|UTF-8)"\?>\s*/.exec(text);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) fail('XML control character');
  const parent: XmlNode = { tag: '#document', attributes: {}, text: '', children: [], start: 0, end: text.length },
    stack = [parent],
    tokens = /<!\[CDATA\[([\s\S]*?)\]\]>|<([^>]+)>|([^<]+)/gy;
  let at = declaration?.[0].length ?? 0;
  while (at < text.length) {
    tokens.lastIndex = at;
    const match = tokens.exec(text);
    if (!match) fail('malformed XML token');
    at = tokens.lastIndex;
    const current = stack[stack.length - 1]!;
    if (match[1] !== undefined) {
      if (stack.length === 1) fail('CDATA outside XML root');
      current.text += match[1];
    } else if (match[3] !== undefined) current.text += entities(match[3]);
    else {
      const markup = match[2]!;
      if (markup.startsWith('/')) {
        if (stack.length === 1 || markup.slice(1) !== current.tag) fail('unbalanced XML tree');
        current.end = at;
        stack.pop();
        continue;
      }
      const opening = /^([A-Za-z][A-Za-z0-9_:.-]*)([\s\S]*?)(\/?)$/.exec(markup);
      if (!opening) fail('unsupported XML declaration');
      const attributes: Record<string, string> = Object.create(null),
        rest = opening[2]!,
        attribute = /\s+([A-Za-z][A-Za-z0-9_:.-]*)="([^"<>]*)"/gy;
      let offset = 0;
      while (offset < rest.length) {
        attribute.lastIndex = offset;
        const part = attribute.exec(rest);
        if (!part) {
          if (/^\s*$/.test(rest.slice(offset))) break;
          fail('malformed XML attribute');
        }
        if (Object.hasOwn(attributes, part[1]!)) fail('duplicate XML attribute');
        attributes[part[1]!] = entities(part[2]!);
        offset = attribute.lastIndex;
      }
      const node: XmlNode = {
        tag: opening[1]!,
        attributes,
        text: '',
        children: [],
        start: at - match[0].length,
        end: opening[3] ? at : -1,
      };
      current.children.push(node);
      if (!opening[3]) stack.push(node);
      if (stack.length > 16) fail('unexpected XML nesting');
    }
  }
  if (stack.length !== 1 || parent.text.trim() || parent.children.length !== 1) fail('invalid XML root inventory');
  return parent.children[0]!;
}
const same = (actual: unknown, expected: unknown, label: string): void => {
  if (!canonicalEqual(actual, expected)) fail(`${label} differs from captured source`);
};
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function keys(record: object, expected: readonly string[], label: string): void {
  same(Object.keys(record).sort(), [...expected].sort(), `${label} fields`);
}
function equalBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (actual.length !== expected.length || actual.some((n, i) => n !== expected[i]))
    fail(`${label} bytes differ from captured source`);
}
function fromBase64(text: string): Uint8Array {
  // A repeated-group regexp can exhaust the regexp stack on a full 1024² RGBA image.
  // Scan once; validate trailing pad bits as well as the ordinary alphabet.
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0,
    end = text.length - padding;
  if (text.length % 4 || (padding && end < 2)) fail('invalid canonical base64 payload');
  const value = (code: number): number => {
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 71;
    if (code >= 48 && code <= 57) return code + 4;
    return code === 43 ? 62 : code === 47 ? 63 : -1;
  };
  for (let index = 0; index < end; index++)
    if (value(text.charCodeAt(index)) === -1) fail('invalid canonical base64 payload');
  if ((padding === 2 && value(text.charCodeAt(end - 1)) & 15) || (padding === 1 && value(text.charCodeAt(end - 1)) & 3))
    fail('noncanonical base64 padding bits');
  const decoded = atob(text);
  return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
}
function property(node: XmlNode, tag: string, name: string): string {
  if (node.tag !== tag || node.children.length || node.attributes.name !== name) fail(`invalid ${name} XML property`);
  keys(node.attributes, ['name'], name);
  return node.text;
}
function item(node: XmlNode, className: string): { name: string; properties: XmlNode[]; items: XmlNode[] } {
  if (node.tag !== 'Item' || node.attributes.class !== className || node.text.trim())
    fail(`invalid ${className} instance`);
  keys(node.attributes, ['class', 'referent'], 'instance');
  if (!node.attributes.referent) fail('missing instance referent');
  const properties = node.children.filter((child) => child.tag === 'Properties'),
    items = node.children.filter((child) => child.tag === 'Item');
  if (properties.length !== 1 || items.length + 1 !== node.children.length) fail('invalid instance child inventory');
  const props = properties[0]!;
  if (props.text.trim() || Object.keys(props.attributes).length) fail('invalid Properties element');
  const nameProperties = props.children.filter((p) => p.attributes.name === 'Name');
  if (nameProperties.length !== 1) fail('missing or duplicate instance Name');
  return {
    name: property(nameProperties[0]!, 'string', 'Name'),
    properties: props.children.filter((p) => p.attributes.name !== 'Name'),
    items,
  };
}
function folder(node: XmlNode): { name: string; items: XmlNode[] } {
  const found = item(node, 'Folder');
  if (found.properties.length) fail('unexpected Folder property');
  return found;
}
/** Both model and place use the same constrained Roblox envelope, with exactly one owned root. */
function envelope(root: XmlNode): XmlNode {
  if (root.tag !== 'roblox' || root.attributes.version !== '4' || root.text.trim()) fail('invalid Roblox XML envelope');
  if (
    Object.keys(root.attributes).some(
      (key) => !['version', 'xmlns:xmime', 'xmlns:xsi', 'xsi:noNamespaceSchemaLocation'].includes(key),
    )
  )
    fail('unexpected Roblox XML envelope attribute');
  const roots = root.children.filter((node) => node.tag === 'Item'),
    externals = root.children.filter((node) => node.tag === 'External');
  if (roots.length !== 1 || externals.length !== 2 || root.children.length !== 3) fail('unexpected source model roots');
  same(
    externals.map((node) => node.text),
    ['null', 'nil'],
    'Roblox null external declarations',
  );
  if (externals.some((node) => node.children.length || Object.keys(node.attributes).length))
    fail('unexpected external declaration');
  const referents = new Set<string>();
  const inspectReferents = (node: XmlNode): void => {
    if (node.tag === 'Item') {
      const id = node.attributes.referent;
      if (!id || referents.has(id)) fail('missing or duplicated instance referent');
      referents.add(id!);
    }
    node.children.forEach(inspectReferents);
  };
  inspectReferents(root);
  return roots[0]!;
}
function parts(node: XmlNode): { name: string; bytes: Uint8Array; count: number } {
  const source = folder(node);
  if (!source.items.length) fail('empty payload folder');
  let encoded = '';
  source.items.forEach((child, index) => {
    const entry = item(child, 'StringValue');
    if (entry.name !== String(index).padStart(6, '0') || entry.items.length || entry.properties.length !== 1)
      fail('missing, duplicated or reordered payload part');
    const value = property(entry.properties[0]!, 'string', 'Value');
    if (!value.length || value.length > 49_152) fail('invalid payload part size');
    if (index + 1 < source.items.length && value.length !== 49_152) fail('nonfinal payload part has unexpected size');
    encoded += value;
  });
  return { name: source.name, bytes: fromBase64(encoded), count: source.items.length };
}

type SourceTriangle = { face: PrecisionFace; ordinal: number; corners: readonly number[] };
/** Traverse captured faces directly; no producer primitive, splitter, mapping or attribute array is trusted. */
function expectedChunks(scene: PrecisionScene): SourceTriangle[][] {
  const groups = new Map<string, SourceTriangle[]>();
  for (const face of scene.faces) {
    const key = JSON.stringify([face.source.objectId, face.source.materialId]);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    face.worldBakedTriangles.forEach((corners, ordinal) => group!.push({ face, ordinal, corners }));
  }
  const result: SourceTriangle[][] = [];
  for (const group of groups.values()) {
    // Reconcile the balanced runtime contract independently of the production splitter.
    const count = Math.ceil(group.length / ROBLOX_RUNTIME_TRIANGLES_PER_CHUNK),
      minimum = Math.floor(group.length / count),
      larger = group.length % count;
    let first = 0;
    for (let index = 0; index < count; index++) {
      const length = minimum + (index < larger ? 1 : 0);
      result.push(group.slice(first, first + length));
      first += length;
    }
  }
  return result;
}
type BinaryNumber = { coefficient: bigint; exponent: number };
const binaryNumberView = new DataView(new ArrayBuffer(8));
function binaryNumber(value: number): BinaryNumber {
  if (!Number.isFinite(value)) fail('nonfinite source triangle edge');
  binaryNumberView.setFloat64(0, value, true);
  const bits = binaryNumberView.getBigUint64(0, true),
    exponent = Number((bits >> 52n) & 2047n),
    significand = (bits & 0xfffffffffffffn) | (exponent ? 0x10000000000000n : 0n);
  return { coefficient: bits >> 63n ? -significand : significand, exponent: exponent ? exponent - 1075 : -1074 };
}
/** Evaluate each 2×2 determinant as an exact dyadic rational before normalization. */
function determinant(a: BinaryNumber, b: BinaryNumber, c: BinaryNumber, d: BinaryNumber): BinaryNumber {
  const leftExponent = a.exponent + b.exponent,
    rightExponent = c.exponent + d.exponent,
    exponent = Math.min(leftExponent, rightExponent);
  return {
    coefficient:
      ((a.coefficient * b.coefficient) << BigInt(leftExponent - exponent)) -
      ((c.coefficient * d.coefficient) << BigInt(rightExponent - exponent)),
    exponent,
  };
}
/** Source triangles determine normals independently of the encoder's primitive buffers. */
function sourceNormal(triangle: SourceTriangle): readonly number[] {
  const points = triangle.face.outputWorldCorners,
    a = points[triangle.corners[0]!]!,
    b = points[triangle.corners[1]!]!,
    c = points[triangle.corners[2]!]!,
    u = b.map((n, axis) => binaryNumber(n - a[axis]!)),
    v = c.map((n, axis) => binaryNumber(n - a[axis]!)),
    exact = [
      determinant(u[1]!, v[2]!, u[2]!, v[1]!),
      determinant(u[2]!, v[0]!, u[0]!, v[2]!),
      determinant(u[0]!, v[1]!, u[1]!, v[0]!),
    ],
    lengths = exact.map(({ coefficient }) =>
      coefficient === 0n ? 0 : (coefficient < 0n ? -coefficient : coefficient).toString(2).length,
    ),
    peak = Math.max(...exact.map(({ exponent }, axis) => (lengths[axis] ? lengths[axis]! + exponent : -Infinity))),
    cross = exact.map(({ coefficient, exponent }, axis) => {
      if (coefficient === 0n) return 0;
      const shift = Math.max(0, lengths[axis]! - 53),
        magnitude = coefficient < 0n ? -coefficient : coefficient;
      const fraction = Number(magnitude >> BigInt(shift)) / 2 ** (lengths[axis]! - shift);
      return (coefficient < 0n ? -1 : 1) * fraction * 2 ** (exponent + lengths[axis]! - peak);
    }),
    length = Math.hypot(...cross);
  if (!Number.isFinite(length) || length === 0) fail('invalid source triangle normal');
  return cross.map((n, axis) => Math.fround((axis === 1 ? 1 : -1) * Math.fround(n / length)));
}

/**
 * Independently checks a persisted runtime bundle against the captured faces: the place and model source Folders
 * (identical XML, constrained envelope, unique referents), the embedded and external canonical manifest, the
 * trusted Restore source, policy fields, the source policy itself, the master and its round trip, every payload's
 * fragments, hash and external copy, every part's balanced triangle partition, centre, Float32 positions (within
 * 1e-5 m), exact normals, UVs and RGBA and kept winding, every image's raw RGBA and PNG, and complete inventories.
 * Native engine acceptance is separate.
 * @throws RangeError `ROBLOX_RUNTIME_VERIFY: <what differs>.` at the first difference.
 */
export async function verifyRobloxRuntimeBundle<S extends PrecisionScene>(
  scene: S,
  artifact: { readonly files: readonly PrecisionFile[]; readonly manifest: RobloxRuntimeManifest },
  expected: RobloxRuntimeExpectation<S>,
): Promise<void> {
  const app = nativeAppNames(expected.appName).name,
    masterExtension = nativeExtension(expected.master.extension, 'master.extension'),
    parse = expected.parseJSON ?? JSON.parse;
  const files = new Map<string, PrecisionFile>();
  for (const file of artifact.files) {
    if (
      typeof file.filename !== 'string' ||
      !file.filename ||
      file.filename !== file.filename.trim() ||
      /[<>:"/\\|?*\u0000-\u001f]/.test(file.filename) ||
      /[. ]$/.test(file.filename) ||
      files.has(file.filename) ||
      !(file.bytes instanceof Uint8Array)
    )
      fail('unsafe, duplicated or invalid artifact file');
    files.set(file.filename, file);
  }
  const xmlFiles = [...files.values()].filter((file) => file.filename.endsWith('-roblox-source.rbxmx'));
  if (xmlFiles.length !== 1) fail('source model file inventory');
  const sourceFile = xmlFiles[0]!,
    basename = sourceFile.filename.slice(0, -'-roblox-source.rbxmx'.length);
  if (!basename) fail('missing source basename');
  const sourceRoot = envelope(xml(sourceFile.bytes)),
    source = folder(sourceRoot),
    placeFile = files.get(`${basename}-roblox-source.rbxlx`);
  if (!placeFile) fail('missing persistent source place');
  const workspace = item(envelope(xml(placeFile!.bytes)), 'Workspace');
  if (workspace.name !== 'Workspace' || workspace.properties.length || workspace.items.length !== 1)
    fail('source place must contain only Workspace and the owned source Folder');
  const placedSource = workspace.items[0]!;
  if (
    utf8(placeFile!.bytes).slice(placedSource.start, placedSource.end) !==
    utf8(sourceFile.bytes).slice(sourceRoot.start, sourceRoot.end)
  )
    fail('place and model source Folder XML differ');
  if (source.name !== `${basename}_${app}Source` || source.items.length !== 3)
    fail('source Folder identity or child inventory');
  const restoreNodes = source.items.filter((node) => node.attributes.class === 'ModuleScript'),
    folderNodes = source.items.filter((node) => node.attributes.class === 'Folder');
  if (restoreNodes.length !== 1 || folderNodes.length !== 2) fail('unexpected executable or source Folder inventory');
  const folderMap = new Map<string, XmlNode>();
  for (const node of folderNodes) {
    const value = folder(node);
    if (folderMap.has(value.name)) fail('duplicate source Folder');
    folderMap.set(value.name, node);
  }
  if (!folderMap.has('Manifest') || !folderMap.has('Payloads')) fail('missing source Folder');
  const embeddedManifest = parts(folderMap.get('Manifest')!),
    manifestText = utf8(embeddedManifest.bytes),
    manifest = parse(manifestText) as RobloxRuntimeManifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('invalid manifest record');
  keys(
    manifest,
    [
      'version',
      'profileId',
      'triangleBudget',
      'sourceSnapshotSha256',
      'sourceMaster',
      'outputName',
      'sourceFolderName',
      'options',
      'transform',
      'objects',
      'chunks',
      'images',
      'persistence',
      'nativeLighting',
      'limitations',
    ],
    'manifest',
  );
  if (manifestText !== canonicalJSON(manifest)) fail('noncanonical embedded manifest');
  same(artifact.manifest, manifest, 'artifact and embedded manifest');
  const externalManifest = files.get(`${basename}-runtime-manifest.json`);
  if (!externalManifest) fail('missing external manifest');
  equalBytes(externalManifest!.bytes, embeddedManifest.bytes, 'external and embedded manifest');
  const restore = item(restoreNodes[0]!, 'ModuleScript');
  if (restore.name !== 'Restore' || restore.items.length || restore.properties.length !== 1)
    fail('invalid Restore ModuleScript inventory');
  same(
    property(restore.properties[0]!, 'ProtectedString', 'Source'),
    await restoreText(sha256Hex(embeddedManifest.bytes), app),
    'trusted Restore ModuleScript',
  );
  same(manifest.version, 1, 'manifest version');
  same(manifest.profileId, ROBLOX_RUNTIME_REPRESENTATION, 'candidate profile');
  same(manifest.triangleBudget, ROBLOX_RUNTIME_TRIANGLES_PER_CHUNK, 'fixed runtime triangle budget');
  same(manifest.persistence, 'source-restored-live-objects', 'source persistence policy');
  same(manifest.nativeLighting, true, 'native lighting policy');
  same(manifest.sourceFolderName, source.name, 'source Folder manifest binding');
  same(manifest.outputName, `${basename}_Live`, 'live output identity');
  same(manifest.sourceSnapshotSha256, expected.snapshotSha256, 'snapshot hash');
  keys(
    manifest.options,
    ['layout', 'transformMode', 'animation', 'skin', 'objectAnimation', 'nativeLighting'],
    'options',
  );
  same(
    manifest.options,
    {
      layout: 'objects',
      transformMode: 'bake',
      animation: 'static',
      skin: false,
      objectAnimation: false,
      nativeLighting: true,
    },
    'supported export options',
  );
  const diagnostics = robloxRuntimeSourceDiagnostics(scene, manifest.options, expected.checks, app);
  if (diagnostics.length) fail(`unsupported captured source policy: ${diagnostics.map((row) => row.code).join(', ')}`);
  same(
    manifest.transform,
    {
      basis: 'Y180',
      studsPerMeterNumerator: 25,
      studsPerMeterDenominator: 7,
      coordinateFrame: 'world-baked',
      positionToleranceMeters: 0.00001,
      normalTolerance: 0.00001,
    },
    'native coordinate policy',
  );
  same(
    manifest.objects,
    scene.objects.map(({ id, parentId, name }) => ({ id, parentId, name })),
    'captured object hierarchy',
  );
  if (
    !Array.isArray(manifest.limitations) ||
    !manifest.limitations.length ||
    manifest.limitations.some((value) => typeof value !== 'string' || !value.trim())
  )
    fail('missing source persistence limitations');
  if (expected.reproduces && !expected.reproduces())
    fail('original project evaluated export snapshot differs from captured source');
  keys(manifest.sourceMaster, ['role', 'documentId', 'filename', 'sha256'], 'source master');
  same(manifest.sourceMaster.role, expected.master.role, 'source master role');
  same(manifest.sourceMaster.documentId, expected.master.documentId, 'source master document');
  same(manifest.sourceMaster.filename, `${basename}-source.${masterExtension}`, 'source master filename');
  const master = files.get(manifest.sourceMaster.filename);
  if (!master) fail('missing source master');
  same(manifest.sourceMaster.sha256, sha256Hex(master!.bytes), 'source master hash');
  equalBytes(master!.bytes, expected.master.bytes, 'source master');
  if (!expected.masterRoundTrips(master!.bytes))
    fail('parsed source project including workspace differs from captured source');

  const payloadNodes = folder(folderMap.get('Payloads')!).items,
    payloads = new Map<string, ReturnType<typeof parts>>();
  for (const node of payloadNodes) {
    const payload = parts(node);
    if (payloads.has(payload.name)) fail('duplicate payload source');
    payloads.set(payload.name, payload);
  }
  const usedPayloads = new Set<string>(),
    usedFiles = new Set([
      sourceFile.filename,
      placeFile!.filename,
      externalManifest!.filename,
      master!.filename,
      `${basename}-roblox-README.txt`,
    ]);
  if (!files.has(`${basename}-roblox-README.txt`)) fail('missing restore instructions');
  const readPayload = (descriptor: RobloxRuntimePayload, expectedId: string, suffix: string): Uint8Array => {
    keys(descriptor, ['id', 'filename', 'byteLength', 'sha256', 'partCount'], 'payload descriptor');
    if (descriptor.id !== expectedId || descriptor.filename !== expectedId + suffix || usedPayloads.has(descriptor.id))
      fail('duplicated or mismatched payload identity');
    const embedded = payloads.get(descriptor.id),
      external = files.get(descriptor.filename);
    if (!embedded || !external) fail('missing payload source or external file');
    if (
      !integer(descriptor.byteLength) ||
      !integer(descriptor.partCount) ||
      !descriptor.partCount ||
      descriptor.byteLength !== embedded!.bytes.length ||
      descriptor.partCount !== embedded!.count
    )
      fail('payload length or fragment count mismatch');
    same(descriptor.sha256, sha256Hex(embedded!.bytes), 'payload hash');
    equalBytes(external!.bytes, embedded!.bytes, 'external and embedded payload');
    usedPayloads.add(descriptor.id);
    usedFiles.add(descriptor.filename);
    return embedded!.bytes;
  };
  const expectedTriangles = expectedChunks(scene);
  if (
    !expectedTriangles.length ||
    !Array.isArray(manifest.chunks) ||
    manifest.chunks.length !== expectedTriangles.length
  )
    fail('chunk inventory does not cover captured source');
  const imageIds = new Set<string>();
  for (let chunkIndex = 0; chunkIndex < expectedTriangles.length; chunkIndex++) {
    const triangles = expectedTriangles[chunkIndex]!,
      chunk = manifest.chunks[chunkIndex]!,
      first = triangles[0]!.face.source,
      material = scene.document.materials[first.materialId]!;
    keys(
      chunk,
      [
        'chunkIndex',
        'objectId',
        'materialId',
        'imageId',
        'vertexCount',
        'triangleCount',
        'centerStuds',
        'payload',
        'triangles',
        'doubleSided',
      ],
      'chunk',
    );
    same(chunk.chunkIndex, chunkIndex, 'ordered chunk identity');
    same(chunk.objectId, first.objectId, 'chunk source object');
    same(chunk.materialId, first.materialId, 'chunk source material');
    same(chunk.imageId, material.assetId, 'chunk source image');
    same(chunk.doubleSided, material.doubleSided, 'chunk material sidedness');
    same(
      chunk.triangles,
      triangles.map(({ face, ordinal }) => [face.source.objectId, face.source.id, ordinal]),
      'ordered source triangle identities',
    );
    same(chunk.triangleCount, triangles.length, 'chunk triangle count');
    same(chunk.vertexCount, triangles.length * 3, 'unwelded source corner count');
    if (material.assetId !== null) imageIds.add(material.assetId);
    const bytes = readPayload(chunk.payload, `geometry-${String(chunkIndex).padStart(6, '0')}`, '.bin'),
      vertexCount = triangles.length * 3;
    if (bytes.length !== vertexCount * 48 + triangles.length * 12) fail('geometry binary layout length');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      minimum = [Infinity, Infinity, Infinity],
      maximum = [-Infinity, -Infinity, -Infinity];
    for (const { face, corners } of triangles)
      for (const corner of corners)
        for (let axis = 0; axis < 3; axis++) {
          const native = Math.fround(face.outputWorldCorners[corner]![axis]!) * (axis === 1 ? 1 : -1) * (25 / 7);
          minimum[axis] = Math.min(minimum[axis]!, native);
          maximum[axis] = Math.max(maximum[axis]!, native);
        }
    const center = minimum.map((n, axis) => Math.fround((n + maximum[axis]!) / 2));
    same(chunk.centerStuds, center, 'source-derived Float32 center');
    for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex++) {
      const triangle = triangles[triangleIndex]!,
        normal = sourceNormal(triangle),
        actualPoints: number[][] = [];
      for (let slot = 0; slot < 3; slot++) {
        const vertex = triangleIndex * 3 + slot,
          corner = triangle.corners[slot]!,
          position = triangle.face.outputWorldCorners[corner]!,
          tuple = Array.from({ length: 12 }, (_, axis) => view.getFloat32(vertex * 48 + axis * 4, true));
        if (tuple.some((n) => !Number.isFinite(n))) fail('nonfinite geometry attribute');
        if (view.getUint32(vertexCount * 48 + vertex * 4, true) !== vertex)
          fail('missing, reused or reordered triangle corner slot');
        for (let axis = 0; axis < 3; axis++) {
          const sign = axis === 1 ? 1 : -1,
            local = Math.fround(Math.fround(position[axis]!) * sign * (25 / 7) - center[axis]!);
          if (!Object.is(tuple[axis], local)) fail('source Float32 position changed');
          if (Math.abs((sign * (tuple[axis]! + center[axis]!)) / (25 / 7) - position[axis]!) > 1e-5)
            fail('position reconstruction exceeds 1e-5 metres');
          if (!Object.is(tuple[axis + 3], normal[axis])) fail('triangle normal differs from source');
        }
        if (Math.abs(Math.hypot(...tuple.slice(3, 6)) - 1) > 1e-5) fail('nonunit triangle normal');
        const attributes = [...triangle.face.effectiveUVs[corner]!, ...triangle.face.source.colors[corner]!];
        attributes.forEach((value, axis) => {
          if (!Object.is(tuple[axis + 6], Math.fround(value))) fail('source Float32 UV or RGBA changed');
          if (axis < 2 && Math.abs(Math.fround(value) - value) > 1e-6) fail('source UV reconstruction exceeds 1e-6');
        });
        actualPoints.push(tuple.slice(0, 3));
      }
      const a = actualPoints[0]!,
        b = actualPoints[1]!,
        c = actualPoints[2]!,
        ab = b.map((n, axis) => n - a[axis]!),
        ac = c.map((n, axis) => n - a[axis]!),
        edgeScale = Math.max(...ab.map(Math.abs), ...ac.map(Math.abs));
      // Position error alone cannot certify topology: distinct valid binary64 corners may round to
      // coincident/collinear Float32 positions within the allowed error. Test the actual emitted triangle,
      // without replacing its original normal.
      if (!Number.isFinite(edgeScale) || edgeScale === 0) fail('Float32 native geometry collapsed or changed winding');
      const u = ab.map((n) => n / edgeScale),
        v = ac.map((n) => n / edgeScale),
        cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!],
        area = Math.hypot(...cross);
      if (!Number.isFinite(area) || area === 0 || cross.reduce((sum, n, axis) => sum + n * normal[axis]!, 0) <= 0)
        fail('Float32 native geometry collapsed or changed winding');
    }
  }
  if (!Array.isArray(manifest.images) || manifest.images.length !== imageIds.size) fail('source image inventory');
  const expectedImages = [...imageIds].sort();
  for (let imageIndex = 0; imageIndex < expectedImages.length; imageIndex++) {
    const id = expectedImages[imageIndex]!,
      row = manifest.images[imageIndex]!,
      image = scene.document.assets[id]!;
    keys(row, ['imageId', 'width', 'height', 'rgbaSha256', 'pngFilename', 'payload'], 'image');
    same(row.imageId, id, 'ordered image identity');
    same([row.width, row.height], [image.width, image.height], 'original image dimensions');
    const rgba = readPayload(row.payload, `image-${String(imageIndex).padStart(6, '0')}`, '.rgba');
    equalBytes(rgba, Uint8Array.from(image.pixels), 'original RGBA including hidden RGB');
    same(row.rgbaSha256, sha256Hex(rgba), 'original RGBA hash');
    same(row.pngFilename, `image-${String(imageIndex).padStart(6, '0')}.png`, 'source PNG identity');
    const png = files.get(row.pngFilename);
    if (!png) fail('missing source PNG');
    const decoded = decodePNG(png!.bytes);
    same([decoded.width, decoded.height], [image.width, image.height], 'decoded PNG dimensions');
    equalBytes(decoded.data, rgba, 'source PNG decoded pixels');
    usedFiles.add(row.pngFilename);
  }
  same([...payloads.keys()].sort(), [...usedPayloads].sort(), 'complete payload inventory');
  same([...files.keys()].sort(), [...usedFiles].sort(), 'complete package file inventory');
}
