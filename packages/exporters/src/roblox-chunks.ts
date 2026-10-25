// Chunked Roblox GLBs: the capability preflight, emitted-chunk geometry checks and an independent verifier of a GLB
// whose every object/material surface is written as chunks of at most 20,000 triangles with a node mapping.
import { decodePNG } from '@margoengine/decoders/png';
import { type AccessorValues, type GLBParts, readAccessor, splitGLB } from './glb.js';
import type { PrecisionMaterial, PrecisionObject, PrecisionScene } from './precision-shared.js';
import type { RobloxChunk, RobloxTriangleIdentity } from './roblox.js';

export type { PrecisionImage, PrecisionMaterial, PrecisionObject, PrecisionScene } from './precision-shared.js';
export type { RobloxChunk, RobloxPrimitiveInput, RobloxSourcePrimitive, RobloxTriangleIdentity } from './roblox.js';

/** Export choices a chunked Roblox GLB accepts. */
export interface RobloxChunkOptions {
  readonly layout: 'objects' | 'combined';
  readonly transformMode: 'preserve' | 'bake';
  readonly animation: 'static' | 'flipbook';
  readonly skin: boolean;
  readonly objectAnimation: boolean;
}

/** One finding, with the object, material and image it concerns when it has them. */
export interface RobloxDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly objectId?: string;
  readonly materialId?: string;
  readonly imageId?: string;
}

/**
 * What a consumer has been shown to accept: dated evidence, the appearance signatures and emitted geometry
 * conditions qualified with it, and its texture size limits. Strict export needs all of them.
 */
export interface RobloxCapabilityProfile {
  readonly id: string;
  readonly evidenceId: string | null;
  readonly appearances: readonly string[];
  readonly geometryConditions: readonly ('closed-volume' | 'open-boundary' | 'zero-volume')[];
  readonly maxTextureWidth: number | null;
  readonly maxTextureHeight: number | null;
}

/** One emitted node: an export origin, an authored object, an object's raw rotation frame, or a chunk mesh node. */
export interface RobloxChunkNode {
  readonly kind: 'origin' | 'object' | 'transform-frame' | 'chunk';
  readonly objectId: string | null;
  readonly chunkIndex: number | null;
  readonly nodeIndex: number;
  readonly meshIndex: number | null;
  readonly primitiveIndex: number | null;
  readonly parentNodeIndex: number | null;
}

/** Which emitted node is which, and each chunk's source triangles. */
export interface RobloxChunkMapping {
  readonly version: 1;
  readonly nodes: readonly RobloxChunkNode[];
  readonly chunks: readonly {
    readonly chunkIndex: number;
    readonly objectId: string;
    readonly materialId: string | null;
    readonly triangles: readonly RobloxTriangleIdentity[];
  }[];
}

/** A chunked Roblox GLB and its mapping. */
export interface RobloxChunkGLB {
  readonly bytes: Uint8Array;
  readonly mapping: RobloxChunkMapping;
}

/** A material's rendering as the application defines it. */
export interface RobloxMaterialAppearance {
  readonly shading: string;
  readonly color: readonly number[];
  readonly opacity: number;
  readonly emissive: readonly number[];
  readonly shininess: number;
  readonly magFilter: string;
  readonly minFilter: string;
}

/** What only the application can say about its own scene and materials. */
export interface RobloxSourceChecks<S extends PrecisionScene = PrecisionScene> {
  /** The application's generic GLB findings for the scene with the objects layout. */
  sceneDiagnostics(scene: S, transformMode: 'preserve' | 'bake'): readonly RobloxDiagnostic[];
  /** How the material is written to GLB: its format-loss warnings and shading. Throws when it cannot be written. */
  materialPlan(material: S['document']['materials'][string]): {
    readonly warnings: readonly { readonly code: string; readonly message: string }[];
    readonly shading: string;
  };
  /** The material's appearance signature, matched against {@link RobloxCapabilityProfile.appearances}. */
  appearanceKey(material: S['document']['materials'][string]): string;
}

/** What the verifier needs from the application. */
export interface RobloxVerifySource<S extends PrecisionScene = PrecisionScene> {
  /** The material's rendering; throws when it cannot be read. */
  appearance(material: S['document']['materials'][string]): RobloxMaterialAppearance;
  /** A point through the object's own authored transform alone (no ancestry), as the application maps it. */
  localTransform(object: S['objects'][number], point: readonly number[]): readonly number[];
}

function hasEvidence(profile: RobloxCapabilityProfile): boolean {
  return typeof profile.evidenceId === 'string' && profile.evidenceId.trim().length > 0;
}

function validLimit(limit: number | null): limit is number {
  return limit !== null && Number.isSafeInteger(limit) && limit > 0;
}

function validImage(image: PrecisionScene['document']['assets'][string] | undefined): boolean {
  if (!image || !validLimit(image.width) || !validLimit(image.height)) return false;
  const bytes = image.width * image.height * 4;
  if (!Number.isSafeInteger(bytes) || !Array.isArray(image.pixels) || image.pixels.length !== bytes) return false;
  for (let index = 0; index < bytes; index++) {
    const value = image.pixels[index];
    if (!Number.isInteger(value) || value! < 0 || value! > 255) return false;
  }
  return true;
}

/** True when a preserved object needs its own frame node: a rotation that is not unit length and not a pure W. */
export function robloxUsesTransformFrame(object: PrecisionObject): boolean {
  const q = object.transform.rotation;
  return Math.abs(Math.hypot(...q) - 1) > 1e-12 && (q[0] !== 0 || q[1] !== 0 || q[2] !== 0);
}

/**
 * `ROBLOX_HIERARCHY_DEPTH` for every object whose emitted depth (roots at zero, counting an export origin, raw
 * transform frames and its chunk children) passes Roblox's 64.
 */
export function robloxHierarchyDiagnostics(
  scene: PrecisionScene,
  transformMode: 'preserve' | 'bake',
  chunkObjectIds: ReadonlySet<string> = new Set(scene.faces.map((face) => face.source.objectId)),
): readonly RobloxDiagnostic[] {
  const objects = new Map(scene.objects.map((object) => [object.id, object]));
  const depths = new Map<string, number>(),
    result: RobloxDiagnostic[] = [];
  const origin = transformMode === 'preserve' && scene.outputFrame.originMode === 'bottom-base' ? 1 : 0;
  for (const object of scene.objects) {
    const path: PrecisionObject[] = [],
      seen = new Set<string>();
    let current: PrecisionObject | undefined = object;
    while (current && !depths.has(current.id)) {
      // Canonical snapshot/native ancestry validation owns malformed graphs.
      if (seen.has(current.id)) break;
      seen.add(current.id);
      path.push(current);
      current = current.parentId === null ? undefined : objects.get(current.parentId);
    }
    let depth = current ? depths.get(current.id) : origin - 1;
    if (depth === undefined) continue;
    for (let i = path.length - 1; i >= 0; i--) {
      const entry = path[i]!;
      depth += 1 + Number(transformMode === 'preserve' && robloxUsesTransformFrame(entry));
      depths.set(entry.id, depth);
    }
    const emittedDepth = depths.get(object.id)! + Number(chunkObjectIds.has(object.id));
    if (emittedDepth > 64)
      result.push({
        code: 'ROBLOX_HIERARCHY_DEPTH',
        objectId: object.id,
        message: `Object ${object.id} emits Roblox native depth ${emittedDepth}; the limit is 64 including chunk children, raw transform frames and any export origin. Shorten the object ancestry before exporting.`,
      });
  }
  return result;
}

/**
 * Strict diagnostics over a captured scene before anything is encoded: objects layout, static, no skins or object
 * clips, a qualified profile, the application's own findings (except generic material, bake and depth notes this
 * policy restates), emitted hierarchy depth, every used material's GLB plan and qualified appearance signature, and
 * every image's completeness and the profile's size limits.
 */
export function robloxPreflight<S extends PrecisionScene>(
  scene: S,
  options: RobloxChunkOptions,
  profile: RobloxCapabilityProfile,
  checks: RobloxSourceChecks<S>,
): readonly RobloxDiagnostic[] {
  const result: RobloxDiagnostic[] = [];
  if (options.layout !== 'objects')
    result.push({
      code: 'ROBLOX_OBJECTS_REQUIRED',
      message:
        'Roblox Studio export requires Objects layout; choose Objects to preserve object/material chunk ownership.',
    });
  if (options.animation !== 'static')
    result.push({
      code: 'ROBLOX_STATIC_REQUIRED',
      message:
        'Roblox Studio export cannot preserve flipbook playback; choose an evaluated static pose/frame snapshot or save the editable project.',
    });
  if (options.skin)
    result.push({
      code: 'ROBLOX_SKIN_UNSUPPORTED',
      message:
        'Roblox Studio export cannot preserve skins/rig editability; choose an evaluated static pose snapshot or save the editable project.',
    });
  if (options.objectAnimation)
    result.push({
      code: 'ROBLOX_OBJECT_CLIPS_UNSUPPORTED',
      message:
        'Roblox Studio export cannot preserve object clips; choose an evaluated static pose snapshot or save the editable project.',
    });
  if (!hasEvidence(profile) || !validLimit(profile.maxTextureWidth) || !validLimit(profile.maxTextureHeight))
    result.push({
      code: 'ROBLOX_PROFILE_UNQUALIFIED',
      message: `Roblox profile ${profile.id} lacks qualified consumer evidence or exact texture limits; qualify the static GLB representation before strict Studio export, or choose another export target.`,
    });
  // Generic Bake/Combined notices describe explicitly requested layout choices, not geometry failures. Combined has
  // its own strict diagnostic above. Material checks below keep generic codes and add object/material/image IDs.
  for (const diagnostic of checks.sceneDiagnostics(scene, options.transformMode))
    if (
      !['MATERIAL_FORMAT_LOSS', 'MATERIAL_UNSUPPORTED', 'BAKED_TRANSFORMS', 'HIERARCHY_DEPTH'].includes(diagnostic.code)
    )
      result.push(diagnostic);
  for (const diagnostic of robloxHierarchyDiagnostics(scene, options.transformMode)) result.push(diagnostic);
  const checkedImages = new Set<string>();
  const materials = new Map<string, string>();
  for (const face of scene.faces)
    if (!materials.has(face.source.materialId)) materials.set(face.source.materialId, face.source.objectId);
  for (const [materialId, objectId] of materials) {
    const material = scene.document.materials[materialId] as S['document']['materials'][string] | undefined;
    const imageId = material?.assetId ?? undefined;
    const identities = { objectId, materialId, ...(imageId === undefined ? {} : { imageId }) };
    const label = `Material ${materialId}${imageId === undefined ? '' : ` image ${imageId}`} on object ${objectId}`;
    if (!material) {
      result.push({
        ...identities,
        code: 'MATERIAL_UNSUPPORTED',
        message: `${label} is missing; restore its canonical material before exporting.`,
      });
      continue;
    }
    try {
      const plan = checks.materialPlan(material);
      for (const warning of plan.warnings)
        result.push({
          ...identities,
          code: warning.code,
          message: `${label}: ${warning.message} Strict Roblox export blocks this format loss; preserve the editable project or choose a qualified representation.`,
        });
      if (!profile.appearances.includes(checks.appearanceKey(material)))
        result.push({
          ...identities,
          code: 'ROBLOX_APPEARANCE_UNSUPPORTED',
          message: `${label} has unqualified ${plan.shading} appearance (UV0, RGBA, alpha, sidedness and sampler semantics); qualify this representation with consumer evidence or choose another export target.`,
        });
    } catch (error) {
      result.push({
        ...identities,
        code: 'MATERIAL_UNSUPPORTED',
        message: `${label}: ${error instanceof Error ? error.message : String(error)} Preserve the editable project or choose a supported material representation.`,
      });
    }
    if (imageId === undefined || checkedImages.has(imageId)) continue;
    checkedImages.add(imageId);
    const image = scene.document.assets[imageId];
    if (!validImage(image))
      result.push({
        ...identities,
        code: 'ROBLOX_TEXTURE_INVALID',
        message: `${label} needs a canonical image with positive integer dimensions and complete RGBA8 texels; restore complete image data before exporting.`,
      });
    else if (
      validLimit(profile.maxTextureWidth) &&
      validLimit(profile.maxTextureHeight) &&
      (image!.width > profile.maxTextureWidth || image!.height > profile.maxTextureHeight)
    )
      result.push({
        ...identities,
        code: 'ROBLOX_TEXTURE_LIMIT',
        message: `${label} is ${image!.width}×${image!.height}; profile ${profile.id} permits at most ${profile.maxTextureWidth}×${profile.maxTextureHeight}. Qualify a profile supporting the original dimensions or choose another export target; canonical texels are never resized.`,
      });
  }
  return result;
}

type GeometryCondition = RobloxCapabilityProfile['geometryConditions'][number];

/** Exact position topology joins seam vertices, without merging or changing output. */
function chunkConditions(chunk: RobloxChunk): { conditions: readonly GeometryCondition[]; invalid?: string } {
  const { positions, indices } = chunk.primitive;
  if (!indices.length || indices.length % 3 || positions.length % 3)
    return { conditions: [], invalid: 'incomplete or empty triangle geometry' };
  const count = indices.length / 3;
  const parent = Array.from({ length: count }, (_, index) => index);
  const find = (start: number): number => {
    let current = start;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]!]!;
      current = parent[current]!;
    }
    return current;
  };
  const vertices = new Map<string, number>();
  const edges = new Map<string, { count: number; balance: number; triangle: number }>();
  for (let triangle = 0; triangle < count; triangle++) {
    const corners: number[] = [];
    for (let corner = 0; corner < 3; corner++) {
      const index = indices[triangle * 3 + corner]!;
      if (!Number.isSafeInteger(index) || index < 0 || index >= positions.length / 3)
        return { conditions: [], invalid: 'out-of-range triangle indices' };
      const point = positions.slice(index * 3, index * 3 + 3);
      if (!point.every(Number.isFinite)) return { conditions: [], invalid: 'nonfinite positions' };
      const key = point.join(',');
      let vertex = vertices.get(key);
      if (vertex === undefined) {
        vertex = vertices.size;
        vertices.set(key, vertex);
      }
      corners.push(vertex);
    }
    if (new Set(corners).size !== 3) return { conditions: [], invalid: 'collapsed triangle edges' };
    for (let corner = 0; corner < 3; corner++) {
      const a = corners[corner]!,
        b = corners[(corner + 1) % 3]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const edge = edges.get(key);
      if (edge) {
        edge.count++;
        edge.balance += a < b ? 1 : -1;
        parent[find(triangle)] = find(edge.triangle);
      } else edges.set(key, { count: 1, balance: a < b ? 1 : -1, triangle });
    }
  }
  const open = new Set<number>();
  for (const edge of edges.values()) {
    if (edge.count > 2 || (edge.count === 2 && edge.balance !== 0))
      return { conditions: [], invalid: 'nonmanifold edges or inconsistent triangle winding' };
    if (edge.count === 1) open.add(find(edge.triangle));
  }
  // Per-component reference and scale avoid translation cancellation, scale overflow,
  // and cancellation between separate solids whose winding happens to be opposite.
  const components = new Map<number, { reference: readonly number[]; scale: number; volume: number }>();
  for (let triangle = 0; triangle < count; triangle++) {
    const root = find(triangle);
    if (open.has(root)) continue;
    let component = components.get(root);
    if (!component) {
      const offset = indices[triangle * 3]! * 3;
      component = { reference: positions.slice(offset, offset + 3), scale: 0, volume: 0 };
      components.set(root, component);
    }
    for (let corner = 0; corner < 3; corner++)
      for (let axis = 0; axis < 3; axis++)
        component.scale = Math.max(
          component.scale,
          Math.abs(positions[indices[triangle * 3 + corner]! * 3 + axis]! - component.reference[axis]!),
        );
  }
  for (let triangle = 0; triangle < count; triangle++) {
    const component = components.get(find(triangle));
    if (!component) continue;
    const points = [0, 1, 2].map((corner) =>
      [0, 1, 2].map(
        (axis) =>
          (positions[indices[triangle * 3 + corner]! * 3 + axis]! - component.reference[axis]!) / component.scale,
      ),
    );
    const [a, b, c] = points as [number[], number[], number[]];
    component.volume +=
      a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) +
      a[1]! * (b[2]! * c[0]! - b[0]! * c[2]!) +
      a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
  }
  const conditions: GeometryCondition[] = open.size ? ['open-boundary'] : [];
  for (const component of components.values()) {
    const condition =
      !Number.isFinite(component.volume) || Math.abs(component.volume) <= Number.EPSILON * count
        ? 'zero-volume'
        : 'closed-volume';
    if (!conditions.includes(condition)) conditions.push(condition);
  }
  return { conditions };
}

/**
 * `ROBLOX_GEOMETRY_UNQUALIFIED` for each emitted chunk whose geometry (open boundary, closed volume or zero volume,
 * found from exact position topology) the profile has not qualified, or that is invalid (empty, out-of-range,
 * nonfinite, collapsed, nonmanifold or inconsistently wound). Run after splitting, before encoding.
 */
export function robloxChunkPreflight(
  chunks: readonly RobloxChunk[],
  profile: RobloxCapabilityProfile,
): readonly RobloxDiagnostic[] {
  const result: RobloxDiagnostic[] = [];
  for (const chunk of chunks) {
    const { conditions, invalid } = chunkConditions(chunk);
    const unsupported = conditions.filter((condition) => !profile.geometryConditions.includes(condition));
    if (invalid || !hasEvidence(profile) || unsupported.length)
      result.push({
        code: 'ROBLOX_GEOMETRY_UNQUALIFIED',
        objectId: chunk.primitive.objectId,
        ...(chunk.primitive.materialId === null ? {} : { materialId: chunk.primitive.materialId }),
        message: `Object ${chunk.primitive.objectId} chunk ${chunk.chunkIndex} material ${chunk.primitive.materialId ?? 'none'} has ${invalid ?? conditions.join(', ')} geometry unqualified for profile ${profile.id}. Qualify this exact emitted condition in Studio or choose another export target; triangles cannot be capped, repaired or discarded silently.`,
      });
  }
  return result;
}

type Node = {
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  children?: number[];
  mesh?: number;
  matrix?: number[];
  skin?: number;
};
type Primitive = {
  attributes: Record<string, number>;
  indices: number;
  material?: number;
  mode?: number;
  targets?: unknown;
};
type Content = {
  scene?: number;
  scenes: { nodes?: number[] }[];
  nodes: Node[];
  meshes: { primitives: Primitive[] }[];
  accessors: {
    bufferView: number;
    byteOffset?: number;
    count: number;
    componentType: number;
    type: string;
    normalized?: boolean;
    sparse?: unknown;
  }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers: { byteLength: number; uri?: string }[];
  materials?: {
    name?: string;
    alphaMode?: string;
    alphaCutoff?: number;
    doubleSided?: boolean;
    emissiveFactor?: number[];
    extensions?: Record<string, unknown>;
    normalTexture?: unknown;
    occlusionTexture?: unknown;
    emissiveTexture?: unknown;
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      metallicFactor?: number;
      roughnessFactor?: number;
      metallicRoughnessTexture?: unknown;
      baseColorTexture?: { index: number; texCoord?: number; extensions?: unknown };
    };
  }[];
  textures?: { source: number; sampler?: number; extensions?: unknown }[];
  images?: { bufferView: number; mimeType?: string; name?: string; uri?: string }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  animations?: unknown[];
  skins?: unknown[];
  extensionsRequired?: string[];
  extensionsUsed?: string[];
};
function fail(label: string): never {
  throw new RangeError(`ROBLOX_VERIFY: ${label}; emitted bytes do not preserve the captured source.`);
}
/** Static output models only unlit materials. Metadata in extras is not traversed. */
function verifyExtensions(value: object, material = false): void {
  const extensions = Reflect.get(value, 'extensions');
  if (extensions === undefined) return;
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) fail('invalid extension inventory');
  for (const key of Object.keys(extensions)) {
    if (!material || key !== 'KHR_materials_unlit') fail(`unsupported rendering extension ${key}`);
    const payload = Reflect.get(extensions, key);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length)
      fail('unsupported unlit extension payload');
  }
}
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const near = (a: readonly number[], b: readonly number[], label: string): void => {
  if (a.length !== b.length || a.some((n, i) => !Number.isFinite(n) || Math.abs(n - b[i]!) > 1e-5))
    fail(`${label} exceeds 1e-5 precision`);
};
const cross = (a: readonly number[], b: readonly number[]): number[] => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const unit = (a: readonly number[]): number[] => {
  const length = Math.hypot(...a);
  if (!Number.isFinite(length) || length === 0) fail('invalid normal');
  return a.map((n) => n / length);
};
function normal(points: readonly (readonly number[])[], triangle: readonly number[]): number[] {
  const a = points[triangle[0]!]!,
    b = points[triangle[1]!]!,
    c = points[triangle[2]!]!;
  const ab = b.map((n, i) => n - a[i]!),
    ac = c.map((n, i) => n - a[i]!);
  const scale = Math.max(...ab.map(Math.abs), ...ac.map(Math.abs));
  return unit(
    cross(
      ab.map((n) => n / scale),
      ac.map((n) => n / scale),
    ),
  );
}
function transformed(p: readonly number[], node: Node, vector = false): number[] {
  const s = node.scale ?? [1, 1, 1],
    q = node.rotation ?? [0, 0, 0, 1],
    t = node.translation ?? [0, 0, 0];
  const [x, y, z] = p.map((n, i) => n * s[i]!) as [number, number, number];
  const tx = 2 * (q[1]! * z - q[2]! * y),
    ty = 2 * (q[2]! * x - q[0]! * z),
    tz = 2 * (q[0]! * y - q[1]! * x);
  return [
    x + q[3]! * tx + q[1]! * tz - q[2]! * ty,
    y + q[3]! * ty + q[2]! * tx - q[0]! * tz,
    z + q[3]! * tz + q[0]! * ty - q[1]! * tx,
  ].map((n, i) => n + (vector ? 0 : t[i]!));
}
/** The face's geometric normal from both triangles of an emitted quad, with the checks editing applies. */
function quadNormal(points: readonly (readonly number[])[], label: string): number[] {
  if (!points.every((p) => p.every(Number.isFinite)))
    throw new RangeError(`${label} has nonfinite world corners; use finite transforms and positions before exporting.`);
  const sub = (a: readonly number[], b: readonly number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
  const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const normals = [
    [0, 1, 2],
    [0, 1, 2],
  ].map(([a, b, c]) => cross(sub(points[b!]!, points[a!]!), sub(points[c!]!, points[a!]!)));
  if (normals.some((n) => !n.every(Number.isFinite) || Math.hypot(...n) < 1e-10))
    throw new RangeError(`${label} has a degenerate triangle; move distinct corners before exporting.`);
  if (normals.some((n) => !Number.isFinite(Math.hypot(...n))))
    throw new RangeError(
      `${label} has a nonfinite world normal magnitude; reduce coordinate or transform magnitude before exporting.`,
    );
  if (dot(normals[0]!, normals[1]!) <= 0)
    throw new RangeError(`${label} has folded or inconsistent triangles; adjust corners or diagonal before exporting.`);
  const length = Math.hypot(...normals[0]!);
  const result = normals[0]!.map((n) => n / length);
  if (!result.every(Number.isFinite) || Math.hypot(...result) === 0)
    throw new RangeError(
      `${label} has a zero or nonfinite world normal; reduce coordinate or transform magnitude before exporting.`,
    );
  return result;
}

/** Bounded scalar accessor reader over splitGLB and readAccessor: flat values, no nested arrays. */
function decode(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array)) fail('invalid GLB container');
  let parts: GLBParts;
  try {
    parts = splitGLB(bytes, { copy: false });
  } catch {
    return fail('invalid GLB chunks');
  }
  if (!parts.bin || parts.chunks.length) fail('invalid binary length');
  const json = parts.json as unknown as Content,
    bin = parts.bin!;
  if (
    !Array.isArray(json.nodes) ||
    !Array.isArray(json.meshes) ||
    !Array.isArray(json.scenes) ||
    json.buffers?.length !== 1 ||
    json.buffers[0]!.uri !== undefined ||
    !integer(json.buffers[0]!.byteLength) ||
    json.buffers[0]!.byteLength > bin.length ||
    bin.length - json.buffers[0]!.byteLength > 3 ||
    json.animations?.length ||
    json.skins?.length ||
    json.extensionsUsed?.some((extension) => extension !== 'KHR_materials_unlit') ||
    json.extensionsRequired?.some((extension) => extension !== 'KHR_materials_unlit')
  )
    fail('unsupported static GLB inventory');
  // Check actual extension payload sites as well as declarations: an omitted
  // extensionsUsed entry must not conceal extra instances or alternative data.
  for (const value of [
    json,
    ...json.scenes,
    ...json.nodes,
    ...json.meshes,
    ...json.meshes.flatMap((mesh) => mesh.primitives),
    ...(json.accessors ?? []),
    ...(json.bufferViews ?? []),
    ...json.buffers,
    ...(json.textures ?? []),
    ...(json.images ?? []),
    ...(json.samplers ?? []),
  ])
    verifyExtensions(value);
  for (const material of json.materials ?? []) {
    verifyExtensions(material, true);
    if (material.pbrMetallicRoughness) verifyExtensions(material.pbrMetallicRoughness);
    if (
      material.normalTexture !== undefined ||
      material.occlusionTexture !== undefined ||
      material.emissiveTexture !== undefined ||
      material.pbrMetallicRoughness?.metallicRoughnessTexture !== undefined
    )
      fail('unsupported material texture input');
  }
  const buffer = (index: number): Uint8Array => {
    const v = json.bufferViews?.[index];
    if (
      !v ||
      v.buffer !== 0 ||
      !integer(v.byteOffset ?? 0) ||
      !integer(v.byteLength) ||
      (v.byteOffset ?? 0) + v.byteLength > json.buffers[0]!.byteLength
    )
      fail('buffer view bounds');
    return bin.subarray(v!.byteOffset ?? 0, (v!.byteOffset ?? 0) + v!.byteLength);
  };
  const accessor = (index: number, type: string, indices = false) => {
    const a = json.accessors?.[index],
      width = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[type]!;
    if (
      !a ||
      a.type !== type ||
      a.normalized ||
      a.sparse ||
      !integer(a.count) ||
      (indices ? ![5121, 5123, 5125].includes(a.componentType) : a.componentType !== 5126)
    )
      fail('accessor representation');
    buffer(a!.bufferView);
    const v = json.bufferViews[a!.bufferView]!,
      size = a!.componentType === 5121 ? 1 : a!.componentType === 5123 ? 2 : 4;
    const offset = a!.byteOffset ?? 0,
      stride = v.byteStride ?? width * size;
    if (
      !integer(offset) ||
      offset % size ||
      !integer(stride) ||
      stride < width * size ||
      stride % size ||
      (a!.count && offset + (a!.count - 1) * stride + width * size > v.byteLength)
    )
      fail('accessor bounds');
    let values: AccessorValues['values'];
    try {
      values = readAccessor(parts, index).values;
    } catch {
      return fail('nonfinite accessor value');
    }
    return {
      count: a!.count,
      read(row: number, column = 0): number {
        if (!integer(row) || row >= a!.count || !integer(column) || column >= width) fail('accessor index range');
        return values[row * width + column]!;
      },
    };
  };
  return { json, buffer, accessor };
}

/**
 * Independently verifies a chunked Roblox GLB against the captured scene and the chunks it was written from: the
 * active node tree (no cycles, at most 64 deep, unit rotations) against the mapping, the export origin, every
 * object's parent and local transform (through raw rotation frames), chunk order and partition, every chunk's
 * material (factors, alpha, sidedness, unlit, sampler) and original PNG texels, and every triangle corner's stored
 * position (exact Float32), normal, composed world position and normal, UV and RGBA, with the source's winding kept.
 * @throws RangeError `ROBLOX_VERIFY: <what differs>; ...` at the first difference.
 */
export async function verifyRobloxChunkGLB<S extends PrecisionScene>(
  scene: S,
  chunks: readonly RobloxChunk[],
  artifact: RobloxChunkGLB,
  transformMode: 'preserve' | 'bake',
  source: RobloxVerifySource<S>,
): Promise<void> {
  if (transformMode !== 'preserve' && transformMode !== 'bake') fail('transform mode');
  const { json, buffer, accessor } = decode(artifact.bytes),
    map = artifact.mapping;
  if (
    map.version !== 1 ||
    map.nodes.length !== json.nodes.length ||
    map.chunks.length !== chunks.length ||
    !chunks.length
  )
    fail('mapping inventory');
  if (!integer(json.scene) || !json.scenes[json.scene]) fail('explicit active scene index');
  const parents = new Map<number, number | null>(),
    active = json.scenes[json.scene!]?.nodes;
  if (!Array.isArray(active) || !active.length) fail('active scene roots');
  const visit = (index: number, parent: number | null, depth: number): void => {
    if (!integer(index) || !json.nodes[index] || parents.has(index) || depth > 64)
      fail('cycle, duplicate instance or invalid scene reachability');
    parents.set(index, parent);
    const node = json.nodes[index]!;
    if (node.matrix !== undefined || node.skin !== undefined) fail('unsupported node transform or skin');
    for (const [values, size] of [
      [node.translation, 3],
      [node.rotation, 4],
      [node.scale, 3],
    ] as const)
      if (values !== undefined && (!Array.isArray(values) || values.length !== size || !values.every(Number.isFinite)))
        fail('invalid node TRS');
    if (node.rotation && Math.abs(Math.hypot(...node.rotation) - 1) > 1e-5) fail('nonunit emitted rotation');
    for (const child of node.children ?? []) visit(child, index, depth + 1);
  };
  for (const root of active!) visit(root, null, 0);
  if (parents.size !== json.nodes.length) fail('unreachable emitted node');
  const entries = new Map<number, RobloxChunkNode>(),
    objects = new Map<string, RobloxChunkNode>(),
    frames = new Map<string, RobloxChunkNode>(),
    chunkNodes = new Map<number, RobloxChunkNode>();
  let origin: RobloxChunkNode | undefined;
  for (const entry of map.nodes) {
    if (
      !integer(entry.nodeIndex) ||
      !json.nodes[entry.nodeIndex] ||
      entries.has(entry.nodeIndex) ||
      parents.get(entry.nodeIndex) !== entry.parentNodeIndex
    )
      fail('mapping node/parent bijection');
    entries.set(entry.nodeIndex, entry);
    const node = json.nodes[entry.nodeIndex]!;
    if (entry.kind === 'origin') {
      if (origin || entry.objectId !== null || entry.chunkIndex !== null) fail('origin inventory');
      origin = entry;
    } else if (entry.kind === 'object' || entry.kind === 'transform-frame') {
      const target = entry.kind === 'object' ? objects : frames;
      if (entry.objectId === null || target.has(entry.objectId) || entry.chunkIndex !== null)
        fail('object/frame inventory');
      target.set(entry.objectId!, entry);
    } else if (entry.kind === 'chunk') {
      if (!integer(entry.chunkIndex) || chunkNodes.has(entry.chunkIndex)) fail('chunk node inventory');
      chunkNodes.set(entry.chunkIndex!, entry);
    } else fail('unknown mapping kind');
    if (
      entry.kind !== 'chunk' &&
      (node.mesh !== undefined || entry.meshIndex !== null || entry.primitiveIndex !== null)
    )
      fail('logical node mesh ownership');
  }
  const wantOrigin = transformMode === 'preserve' && scene.outputFrame.originMode === 'bottom-base';
  if (Boolean(origin) !== wantOrigin || objects.size !== scene.objects.length || chunkNodes.size !== chunks.length)
    fail('source object/origin/chunk inventory');
  const basis = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as const;
  if (origin) {
    if (origin.parentNodeIndex !== null || active!.length !== 1 || active![0] !== origin.nodeIndex)
      fail('origin scene parent');
    for (const point of basis)
      near(
        transformed(point, json.nodes[origin.nodeIndex]!),
        point.map((n, i) => n - scene.outputFrame.pivot[i]!),
        'origin',
      );
  }
  const usedFrames = new Set<string>();
  for (const object of scene.objects) {
    const entry = objects.get(object.id);
    if (!entry) fail('missing captured object');
    const parentObject = object.parentId === null ? undefined : objects.get(object.parentId);
    if (object.parentId !== null && !parentObject) fail('missing source ancestry');
    const expectedParent = parentObject
      ? (frames.get(object.parentId!) ?? parentObject).nodeIndex
      : (origin?.nodeIndex ?? null);
    if (entry!.parentNodeIndex !== expectedParent) fail('source object hierarchy');
    const frame = frames.get(object.id),
      q = object.transform.rotation;
    const wantFrame =
      transformMode === 'preserve' &&
      Math.abs(Math.hypot(...q) - 1) > 1e-12 &&
      (q[0] !== 0 || q[1] !== 0 || q[2] !== 0);
    if (Boolean(frame) !== wantFrame || (frame && frame.parentNodeIndex !== entry!.nodeIndex))
      fail('raw transform frame hierarchy');
    if (frame) usedFrames.add(object.id);
    for (const point of basis) {
      const actual = transformed(
        frame ? transformed(point, json.nodes[frame.nodeIndex]!) : point,
        json.nodes[entry!.nodeIndex]!,
      );
      near(
        actual,
        transformMode === 'preserve' ? source.localTransform(object as S['objects'][number], point) : point,
        `object ${object.id} local transform`,
      );
    }
  }
  if (usedFrames.size !== frames.size) fail('extra raw frame');
  const world = (point: readonly number[], node: number, vector = false): number[] => {
    let current: number | null = node,
      value = [...point];
    while (current !== null) {
      value = transformed(value, json.nodes[current]!, vector);
      current = parents.get(current)!;
    }
    return value;
  };
  const faces = new Map(scene.faces.map((face) => [JSON.stringify([face.source.objectId, face.source.id]), face]));
  if (faces.size !== scene.faces.length) fail('duplicate captured face identity');
  const sourceGroups = new Map<
    string,
    { index: number; faces: (typeof scene.faces)[number][]; face: number; ordinal: number; remaining: number }
  >();
  for (const face of scene.faces) {
    const key = JSON.stringify([face.source.objectId, face.source.materialId]);
    let group = sourceGroups.get(key);
    if (!group) {
      group = { index: sourceGroups.size, faces: [], face: 0, ordinal: 0, remaining: 0 };
      sourceGroups.set(key, group);
    }
    group.faces.push(face);
    group.remaining += (transformMode === 'preserve' ? face.localTriangles : face.worldBakedTriangles).length;
  }
  const meshes = new Set<number>(),
    materialOwners = new Map<number, string>(),
    materialIndices = new Map<string, number>();
  const verifiedImages = new Map<number, string>();
  const usedTextures = new Set<number>(),
    usedSamplers = new Set<number>();
  let triangleTotal = 0;
  for (const [index, chunk] of chunks.entries()) {
    const entry = chunkNodes.get(index),
      mapping = map.chunks[index];
    if (
      chunk.chunkIndex !== index ||
      !entry ||
      !mapping ||
      mapping.chunkIndex !== index ||
      entry.objectId !== chunk.primitive.objectId ||
      mapping.objectId !== entry.objectId ||
      mapping.materialId !== chunk.primitive.materialId ||
      !equal(mapping.triangles, chunk.triangles) ||
      chunk.triangles.length < 1 ||
      chunk.triangles.length > 20_000
    )
      fail('chunk identity mapping');
    const group = sourceGroups.get(JSON.stringify([mapping!.objectId, mapping!.materialId]));
    if (
      !group ||
      chunk.sourcePrimitiveIndex !== group.index ||
      (index > 0 && chunk.sourcePrimitiveIndex < chunks[index - 1]!.sourcePrimitiveIndex) ||
      chunk.triangles.length !== Math.min(20_000, group.remaining)
    )
      fail('source traversal chunk order/partition');
    const owner = frames.get(entry!.objectId!) ?? objects.get(entry!.objectId!);
    if (!owner || entry!.parentNodeIndex !== owner.nodeIndex) fail('chunk parent');
    const node = json.nodes[entry!.nodeIndex]!;
    if ((node.children?.length ?? 0) !== 0) fail('chunk children');
    for (const point of basis) near(transformed(point, node), point, 'chunk identity transform');
    const meshIndex = entry!.meshIndex;
    if (
      !integer(meshIndex) ||
      node.mesh !== meshIndex ||
      meshes.has(meshIndex) ||
      entry!.primitiveIndex !== 0 ||
      json.meshes[meshIndex]?.primitives.length !== 1
    )
      fail('mesh/primitive mapping bijection');
    meshes.add(meshIndex!);
    const primitive = json.meshes[meshIndex!]!.primitives[0]!;
    if (
      (primitive.mode ?? 4) !== 4 ||
      primitive.targets !== undefined ||
      !equal(Object.keys(primitive.attributes).sort(), ['COLOR_0', 'NORMAL', 'POSITION', 'TEXCOORD_0'])
    )
      fail('static triangle attributes');
    const pos = accessor(primitive.attributes.POSITION!, 'VEC3'),
      norm = accessor(primitive.attributes.NORMAL!, 'VEC3'),
      uv = accessor(primitive.attributes.TEXCOORD_0!, 'VEC2'),
      color = accessor(primitive.attributes.COLOR_0!, 'VEC4'),
      indices = accessor(primitive.indices, 'SCALAR', true);
    if (
      indices.count !== chunk.triangles.length * 3 ||
      pos.count > indices.count ||
      pos.count !== norm.count ||
      pos.count !== uv.count ||
      pos.count !== color.count
    )
      fail('triangle/attribute totals');
    const usedVertices = new Uint8Array(pos.count);
    const materialId = mapping!.materialId,
      materialIndex = primitive.material;
    const sourceMaterial = (materialId === null ? undefined : scene.document.materials[materialId]) as
      | (S['document']['materials'][string] & PrecisionMaterial)
      | undefined;
    const material = json.materials?.[materialIndex ?? -1];
    if (
      !sourceMaterial ||
      !material ||
      material.name !== sourceMaterial.name ||
      !integer(materialIndex) ||
      (materialOwners.has(materialIndex) && materialOwners.get(materialIndex) !== materialId) ||
      (materialIndices.has(materialId!) && materialIndices.get(materialId!) !== materialIndex)
    )
      fail('source material association');
    materialOwners.set(materialIndex!, materialId!);
    materialIndices.set(materialId!, materialIndex!);
    const appearance = source.appearance(sourceMaterial!),
      pbr = material!.pbrMetallicRoughness;
    if (
      !equal(pbr?.baseColorFactor ?? [1, 1, 1, 1], [...appearance.color, appearance.opacity]) ||
      (material!.alphaMode ?? 'OPAQUE') !== sourceMaterial!.alphaMode.toUpperCase() ||
      (material!.doubleSided ?? false) !== sourceMaterial!.doubleSided ||
      (sourceMaterial!.alphaMode === 'mask' &&
        (material!.alphaCutoff ?? 0.5) !== (sourceMaterial!.alphaCutoff ?? 0.5)) ||
      Boolean(material!.extensions?.KHR_materials_unlit) !== (appearance.shading === 'basic') ||
      !equal(material!.emissiveFactor ?? [0, 0, 0], appearance.emissive) ||
      (pbr?.metallicFactor ?? 1) !== 0 ||
      // Phong exponent to roughness as exporters/model.ts (Walter et al. 2007 sec. 5.2).
      (pbr?.roughnessFactor ?? 1) !== (appearance.shading === 'phong' ? (2 / (appearance.shininess + 2)) ** 0.25 : 1)
    )
      fail('material appearance');
    const reference = pbr?.baseColorTexture;
    if (sourceMaterial!.assetId === null) {
      if (reference) fail('unexpected image material');
    } else {
      const texture = json.textures?.[reference?.index ?? -1],
        imageIndex = texture?.source,
        image = json.images?.[imageIndex ?? -1],
        sampler = json.samplers?.[texture?.sampler ?? -1],
        sourceImage = scene.document.assets[sourceMaterial!.assetId];
      if (
        !reference ||
        !integer(reference.index) ||
        (reference.texCoord ?? 0) !== 0 ||
        reference.extensions ||
        !texture ||
        !integer(texture.source) ||
        !integer(texture.sampler) ||
        texture.extensions ||
        !image ||
        image.uri ||
        image.mimeType !== 'image/png' ||
        !sourceImage ||
        image.name !== sourceImage.id ||
        !sampler ||
        sampler.wrapS !== 33071 ||
        sampler.wrapT !== 33071 ||
        sampler.magFilter !== (appearance.magFilter === 'nearest' ? 9728 : 9729) ||
        sampler.minFilter !== (appearance.minFilter === 'nearest' ? 9728 : 9729)
      )
        fail('material texture/image/sampler association');
      usedTextures.add(reference!.index);
      usedSamplers.add(texture!.sampler!);
      if (verifiedImages.has(imageIndex!) && verifiedImages.get(imageIndex!) !== sourceImage!.id)
        fail('source image ownership');
      if (!verifiedImages.has(imageIndex!)) {
        const decoded = decodePNG(buffer(image!.bufferView));
        if (
          decoded.width !== sourceImage!.width ||
          decoded.height !== sourceImage!.height ||
          decoded.data.length !== sourceImage!.pixels.length ||
          decoded.data.some((n, i) => n !== sourceImage!.pixels[i])
        )
          fail('canonical RGBA dimensions/texels/transparent RGB');
        verifiedImages.set(imageIndex!, sourceImage!.id);
      }
    }
    const columns = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ].map((p) => world(p, entry!.nodeIndex, true));
    const cofactors = [
        cross(columns[1]!, columns[2]!),
        cross(columns[2]!, columns[0]!),
        cross(columns[0]!, columns[1]!),
      ],
      determinant = columns[0]!.reduce((sum, n, i) => sum + n * cofactors[0]![i]!, 0);
    if (!Number.isFinite(determinant) || determinant === 0) fail('singular emitted transform');
    for (const [triangleOffset, identity] of mapping!.triangles.entries()) {
      const [objectId, faceId, ordinal] = identity,
        key = JSON.stringify([objectId, faceId]),
        face = faces.get(key);
      const expectedFace = group!.faces[group!.face];
      if (!expectedFace || expectedFace.source.id !== faceId || group!.ordinal !== ordinal)
        fail('source traversal tuple order');
      group!.ordinal++;
      group!.remaining--;
      if (
        group!.ordinal ===
        (transformMode === 'preserve' ? expectedFace!.localTriangles : expectedFace!.worldBakedTriangles).length
      ) {
        group!.face++;
        group!.ordinal = 0;
      }
      const triangles = transformMode === 'preserve' ? face?.localTriangles : face?.worldBakedTriangles;
      if (
        !face ||
        objectId !== entry!.objectId ||
        face.source.materialId !== materialId ||
        !integer(ordinal) ||
        !triangles?.[ordinal]
      )
        fail('source triangle identity');
      const chosen = triangles![ordinal]!,
        points = transformMode === 'preserve' ? face!.localCorners : face!.outputWorldCorners;
      const expectedNormal = normal(points, chosen),
        expectedWorldNormal = normal(face!.outputWorldCorners, face!.worldBakedTriangles[ordinal]!);
      const emittedWorldPoints: number[][] = [],
        emittedWorldNormals: number[][] = [];
      for (let cornerOffset = 0; cornerOffset < 3; cornerOffset++) {
        const corner = chosen[cornerOffset]!,
          vertex = indices.read(triangleOffset * 3 + cornerOffset);
        if (vertex >= pos.count) fail('triangle index range');
        usedVertices[vertex] = 1;
        const position = [pos.read(vertex, 0), pos.read(vertex, 1), pos.read(vertex, 2)],
          n = [norm.read(vertex, 0), norm.read(vertex, 1), norm.read(vertex, 2)];
        for (let axis = 0; axis < 3; axis++)
          if (position[axis] !== Math.fround(points[corner]![axis]!)) fail('stored source position/corner order');
        near(position, points[corner]!, 'source position');
        near(n, expectedNormal, 'source flat normal');
        const emittedWorld = world(position, entry!.nodeIndex);
        emittedWorldPoints.push([emittedWorld[0]!, emittedWorld[1]!, emittedWorld[2]!]);
        near(emittedWorld, face!.outputWorldCorners[corner]!, 'composed world position');
        const worldNormal = unit(
          [0, 1, 2].map((axis) => n.reduce((sum, value, j) => sum + (value * cofactors[j]![axis]!) / determinant, 0)),
        );
        emittedWorldNormals.push(worldNormal);
        near(worldNormal, expectedWorldNormal, 'composed world normal');
        for (let axis = 0; axis < 2; axis++)
          if (uv.read(vertex, axis) !== Math.fround(face!.effectiveUVs[corner]![axis]!))
            fail('exact source UV/corner association');
        for (let axis = 0; axis < 4; axis++)
          if (color.read(vertex, axis) !== Math.fround(face!.source.colors[corner]![axis]!))
            fail('exact source RGBA/corner association');
      }
      // Mirror-aware source winding may differ from the stored local order. Validate actual quantized world geometry
      // as well as pointwise error: values within 1e-5 can still collapse a narrow source triangle entirely.
      const corrected = face!.worldBakedTriangles[ordinal]!.map(
        (corner) => emittedWorldPoints[chosen.indexOf(corner)]!,
      );
      const geometric = quadNormal(corrected, `Face ${faceId} on object ${objectId} after emitted precision`);
      for (const emittedNormal of emittedWorldNormals)
        if (emittedNormal.reduce((dot, n, axis) => dot + n * geometric[axis]!, 0) <= 0)
          fail(`Face ${faceId} changed normal front orientation after emitted precision`);
      triangleTotal++;
    }
    if (usedVertices.some((used) => !used)) fail('unreferenced vertex inventory');
  }
  let expectedTotal = 0;
  // The source cursors advance exactly once for each emitted tuple in each original primitive. Exhaustion proves
  // conservation even for coincident faces, without retaining a second million-entry set of triangle identities.
  for (const group of sourceGroups.values())
    if (group.remaining !== 0 || group.face !== group.faces.length) fail('missing source triangle tuple');
  for (const face of faces.values()) {
    const expected = transformMode === 'preserve' ? face.localTriangles : face.worldBakedTriangles;
    expectedTotal += expected.length;
  }
  if (
    triangleTotal !== expectedTotal ||
    meshes.size !== json.meshes.length ||
    materialOwners.size !== (json.materials?.length ?? 0) ||
    verifiedImages.size !== (json.images?.length ?? 0) ||
    usedTextures.size !== (json.textures?.length ?? 0) ||
    usedSamplers.size !== (json.samplers?.length ?? 0)
  )
    fail('extra or missing source/mesh/material/image inventory');
}
