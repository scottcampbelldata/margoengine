// Shared scene collection for every exporter: walks a Margo Engine engine (or a plain data scene), validates and
// normalizes geometry and materials, and computes local and world transforms in double precision.
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel, Mesh, Geometry, PbrMaterial } from '@margoengine/core';
import type { Vec2 } from '@margoengine/math';
import type { PBRSource } from '../../shared/pbr-source.js';
import { meshTriangles } from '../../shared/mesh-source.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { splitTRS } from '@margoengine/math/quat';
import { accumulateNormals } from '../../shared/normals.js';

/** Deepest node chain an export walks; one level deeper throws before any node is written. */
const MAX_HIERARCHY_DEPTH = 1024;

/** Plain geometry with optional UVs, tangents and vertex colors, for data that core `Geometry` cannot hold. */
export interface GeometryData {
  /** xyz per vertex. */
  positions: ArrayLike<number>;
  /** xyz per vertex. Normalized on export; zero vectors are replaced by the area-weighted face normal. */
  normals: ArrayLike<number>;
  /** uv per vertex (glTF convention, v down). */
  uvs?: ArrayLike<number>;
  /** Optional second UV set. */
  uvs1?: ArrayLike<number>;
  /** xyzw per vertex, w is the bitangent sign (+1 or -1). */
  tangents?: ArrayLike<number>;
  /** Linear rgb or rgba per vertex, each in [0, 1]. */
  colors?: ArrayLike<number>;
  /** Triangle list. Omit for non-indexed triangles. */
  indices?: ArrayLike<number>;
  /**
   * Corners per face in index order: 3 for one triangle, 4 for the next two triangles forming a quad (sharing an
   * edge, as (a, b, c) and (a, c, d)). OBJ and DAE write those quads as 4-corner faces; other formats write triangles.
   */
  faceSizes?: ArrayLike<number>;
  /** Four joint indices and weights per vertex, required together. */
  joints?: ArrayLike<number>;
  weights?: ArrayLike<number>;
  /** Dense xyz deltas in base-vertex order. */
  morphs?: readonly MorphData[];
}

/** One morph target to write: position deltas and optional normal and tangent deltas. */
export interface MorphData {
  name?: string;
  positions: ArrayLike<number>;
  normals?: ArrayLike<number>;
  /** xyz deltas; the base tangent keeps its handedness component. */
  tangents?: ArrayLike<number>;
}

/**
 * Application data written as a glTF `extras` object (provenance, roles, source ids). JSON only: plain objects,
 * arrays, strings, finite numbers, booleans and null; `undefined` members are left out, as JSON.stringify does.
 * Copied when the scene is exported. Written by the glTF writers only.
 */
export type Extras = { readonly [key: string]: unknown };

/** A skin to write: its joint nodes, inverse bind matrices and optional skeleton root. */
export interface SkinData {
  name?: string;
  /** References to nodes included in this scene. */
  joints: readonly ExportNode[];
  /** Sixteen column-major values per joint. */
  inverseBindMatrices: ArrayLike<number>;
  /** The skeleton root: the joints' closest common root or one of its ancestors. Default none. */
  skeleton?: ExportNode;
  extras?: Extras;
}

/** One animation channel: the node and path it drives, its interpolation, key times and values. */
export interface AnimationChannelData {
  node: ExportNode;
  path: 'translation' | 'rotation' | 'scale' | 'weights';
  interpolation?: 'STEP' | 'LINEAR' | 'CUBICSPLINE';
  /** Nonnegative, strictly increasing seconds after Float32 conversion. */
  times: ArrayLike<number>;
  /** CUBICSPLINE uses in-tangent, value, out-tangent for each key. */
  values: ArrayLike<number>;
}

/** A named animation made of channels, written into the glTF. */
export interface AnimationData {
  name?: string;
  channels: readonly AnimationChannelData[];
  extras?: Extras;
}

/** One STEP track addressing an explicitly authored base-color texture transform on an emitted material object. */
export interface MaterialAnimationChannelData {
  material: MaterialData;
  texture: 'baseColorTexture';
  property: 'offset' | 'scale';
  /** Nonempty, nonnegative and strictly increasing after Float32 conversion. */
  times: ArrayLike<number>;
  /** Two finite Float32 values per key. */
  values: ArrayLike<number>;
  interpolation: 'STEP';
}

/** An ordered material clip, appended after ordinary node clips by the glTF writers. */
export interface MaterialAnimationData {
  name?: string;
  channels: readonly MaterialAnimationChannelData[];
}

/** An encoded PNG or JPEG image referenced by a material, with its sampler. */
export interface TextureData {
  image: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
  name?: string;
  /** Magnification filter. Default 'linear'; 'nearest' keeps pixel art crisp. */
  magFilter?: 'nearest' | 'linear';
  /** Minification filter. Default 'linear'. */
  minFilter?: 'nearest' | 'linear';
  /** Sample mipmaps when minifying. Default true. */
  mipmaps?: boolean;
  /** Wrap mode across u. Default 'repeat'. */
  wrapS?: 'repeat' | 'clamp' | 'mirror';
  /** Wrap mode across v. Default 'repeat'. */
  wrapT?: 'repeat' | 'clamp' | 'mirror';
  /** UV set the material samples it with: 0 (`uvs`, default) or 1 (`uvs1`). glTF writers only. */
  texCoord?: 0 | 1;
  extras?: Extras;
}

/** A glTF metallic-roughness material described as data. Its factors are written as the exact numbers given. */
export interface MaterialData {
  name?: string;
  /** Linear rgb or rgba, default [1, 1, 1, 1]. */
  color?: readonly number[];
  roughness?: number;
  metalness?: number;
  doubleSided?: boolean;
  /** Linear rgb, default black. */
  emissive?: readonly number[];
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  baseColorTexture?: TextureData;
  /**
   * KHR_texture_transform offset and scale of `baseColorTexture` (required by the file), Float32 values. A target of
   * `materialAnimations`. glTF writers only.
   */
  baseColorTextureTransform?: { offset: Vec2; scale: Vec2 };
  metallicRoughnessTexture?: TextureData;
  normalTexture?: TextureData;
  /** Shade with base color only, ignoring lights: KHR_materials_unlit in glTF. Default false. */
  unlit?: boolean;
  /**
   * The lighting model, named as in `@margoengine/materials`: `'standard'` (default, metallic-roughness), `'lambert'`
   * (diffuse only) or `'phong'` (diffuse plus a Blinn-Phong highlight from `specular` and `shininess`). COLLADA writes
   * the matching effect and MTL its `illum`, `Ks` and `Ns`. glTF has neither model, so both are written with metalness
   * 0 and roughness 1 (lambert) or `(2 / (shininess + 2))^(1/4)` (phong); `roughness` and `metalness` are ignored.
   */
  shading?: 'standard' | 'lambert' | 'phong';
  /** Phong highlight color, linear rgb in [0, 1]. Default sRGB #111111. */
  specular?: readonly number[];
  /** Phong highlight exponent, finite and >= 0. Default 30. */
  shininess?: number;
  /** Scale of `normalTexture`'s xy, finite. Default 1. glTF writers only. */
  normalScale?: number;
  /** Ambient occlusion in its red channel. glTF writers only. */
  occlusionTexture?: TextureData;
  /** How much `occlusionTexture` darkens, 0 to 1. Default 1. */
  occlusionStrength?: number;
  /** Emitted color in its rgb, multiplied by `emissive` (so set `emissive`, e.g. [1, 1, 1]). glTF writers only. */
  emissiveTexture?: TextureData;
  /** Multiplier on the emitted color, finite and >= 0, for emission brighter than 1: KHR_materials_emissive_strength. Default 1. */
  emissiveStrength?: number;
  /** Fraction of light transmitted through the surface, 0 to 1: KHR_materials_transmission. Default 0. */
  transmission?: number;
  /** Index of refraction, 0 or >= 1: KHR_materials_ior. Default 1.5. */
  ior?: number;
  extras?: Extras;
}

/** A glTF camera on a data-scene node, looking down the node's -Z; a gltf-pro `GLTFCamera` record fits as it is. */
export interface CameraData {
  type: 'perspective' | 'orthographic';
  name?: string;
  /** Angles in radians; omitted `zfar` is an infinite projection. */
  perspective?: { yfov: number; znear: number; zfar?: number; aspectRatio?: number };
  orthographic?: { xmag: number; ymag: number; znear: number; zfar: number };
  extras?: Extras;
}

/** A KHR_lights_punctual light on a data-scene node, pointing down the node's -Z; a gltf-pro `GLTFLight` record fits as it is. */
export interface LightData {
  type: 'directional' | 'point' | 'spot';
  name?: string;
  /** Linear rgb in [0, 1]. */
  color: readonly number[];
  /** Candela (point, spot) or lux (directional). */
  intensity: number;
  /** Point and spot cutoff distance; omitted is infinite. */
  range?: number;
  /** Spot cone angles in radians. Defaults 0 and PI / 4. */
  innerConeAngle?: number;
  outerConeAngle?: number;
  extras?: Extras;
}

/**
 * One primitive of a multi-material mesh: its triangles and the material they use. Primitives that share one
 * `geometry` object and give their own `indices` write its vertex attributes once (shared glTF accessors), each with
 * its own index list, as one palette-colored model split by material.
 */
export interface ExportPrimitive {
  geometry: Geometry | GeometryData;
  material?: PbrMaterial | MaterialData;
  /** Triangle list into `geometry`'s vertices, used instead of its `indices`. Nonempty, whole triangles. */
  indices?: ArrayLike<number>;
  /** glTF writers only. */
  extras?: Extras;
}

/** An {@link ExportPrimitive} as plain data with its material, the form an application's own mesh builder hands over. */
export interface ExportPrimitiveData extends ExportPrimitive {
  geometry: GeometryData;
  material: MaterialData;
}

/**
 * A node of a plain data scene. Rotation is a quaternion [x, y, z, w]. A scale of [0, 0, 0] collapses the node: the
 * glTF writers keep it (a hidden geometry cel, shown later by a scale channel), the mesh-only formats leave it and its
 * descendants out. Translation, rotation, scale and matrix are JSON numbers: the glTF writers keep each finite value
 * exactly (no Float32 rounding), write the fields given even when they equal glTF's defaults, and scale a rotation to
 * unit length only when it is more than 1e-5 off.
 */
export interface ExportNode {
  name?: string;
  translation?: readonly number[];
  rotation?: readonly number[];
  scale?: readonly number[];
  /**
   * Column-major local transform, instead of translation, rotation and scale. It must be affine and free of shear
   * (glTF forbids sheared node matrices), and the node cannot be an animation target.
   */
  matrix?: readonly number[];
  geometry?: Geometry | GeometryData;
  material?: PbrMaterial | MaterialData;
  /** A multi-material mesh, instead of `geometry` and `material`. */
  primitives?: readonly ExportPrimitive[];
  visible?: boolean;
  /**
   * glTF writers only: emit KHR_node_visibility while retaining this node, its geometry and descendants.
   * Unlike `visible`, this does not filter the export. Explicit true is written too; omitted means no extension.
   * Requires the hierarchy (`flatten: false`, the default).
   */
  retainedVisibility?: boolean;
  children?: readonly ExportNode[];
  skin?: SkinData;
  morphWeights?: readonly number[];
  /** Written by the glTF writers only. */
  camera?: CameraData;
  /** Written by the glTF writers only. */
  light?: LightData;
  /** glTF writers only. */
  extras?: Extras;
  /** Name of the glTF mesh. Default the node's name. */
  meshName?: string;
  /** `extras` of the glTF mesh. */
  meshExtras?: Extras;
}

/**
 * A baked lightmap. glTF has no standard lightmap material slot, so the glTF writers put `texture` into the
 * document's textures and record it under the root `extras[key]` as `{ texture: <index>, texCoord, ...extras }`.
 * Standard viewers ignore it; an import script binds it (a Godot post-import script, for example).
 */
export interface LightmapData {
  texture: TextureData;
  /** UV set the lightmap uses: 1 (`uvs1`, default) or 0. Every drawn geometry needs that set. */
  texCoord?: 0 | 1;
  /** Root `extras` member holding the record. Default 'lightmap'. */
  key?: string;
  /** Further members of the record: encoding, scale, padding. */
  extras?: Extras;
  /** Baked emission atlas, written as `emission: <texture index>` so a game can reload the finished lighting. */
  emission?: TextureData;
  /** Multiplier that restores the lightmap texture's linear values, at least 1 (as @margoengine/lightmap returns it). */
  lightmapScale?: number;
  /** Multiplier that restores the emission texture's linear values, at least 1. */
  emissionScale?: number;
}

/** A plain data scene; geometry and material objects shared between nodes are written once. */
export interface ExportScene {
  nodes: readonly ExportNode[];
  animations?: readonly AnimationData[];
  /** STEP base-color texture clips written by the glTF writers only; unsupported with flatten. */
  materialAnimations?: readonly MaterialAnimationData[];
  /** Root `extras` of the glTF document. glTF writers only, as are `scene`, `asset` and `lightmap`. */
  extras?: Extras;
  /** The glTF scene's name and extras. */
  scene?: { name?: string; extras?: Extras };
  /** The glTF asset's copyright and extras (`asset.generator` is an option of the writer). */
  asset?: { copyright?: string; extras?: Extras };
  lightmap?: LightmapData;
}

/** Either a Margo Engine engine (from `Engine.create`) or a plain data scene. */
export type ExportSource = EngineKernel | ExportScene;

interface Lookup<K, V> {
  get(key: K): V | undefined;
}

/**
 * Options shared by every scene exporter: visibility, the root mesh to export and richer geometry and material data.
 */
export interface SceneOptions {
  /** Skip hidden meshes and their descendants. Default true. */
  onlyVisible?: boolean;
  /** Export only this engine mesh and its descendants. */
  root?: Mesh;
  /** Richer data (UVs, tangents, colors) to write in place of a core Geometry. */
  geometryData?: Lookup<Geometry, GeometryData>;
  /** Richer data (textures, emission) to write in place of a core PbrMaterial. */
  materialData?: Lookup<PbrMaterial, MaterialData>;
  /**
   * Sample every texture as pixel art: nearest magnification and minification, with `mipmaps: 'none'` (default; glTF
   * NEAREST) or `'nearest'` (NEAREST_MIPMAP_NEAREST), and `wrap` replacing both wrap modes when given. `true` is
   * `{mipmaps: 'none'}`. Godot's glTF import maps these to TEXTURE_FILTER_NEAREST and NEAREST_WITH_MIPMAPS; Unreal's
   * Interchange needs `@margoengine/exporters/unreal-pixel-art` after import.
   */
  pixelArt?: boolean | PixelArtSampling;
}
/** How {@link SceneOptions.pixelArt} samples textures. */
export interface PixelArtSampling {
  /** 'none' (default): no mip levels; 'nearest': mip levels picked nearest, never blended. */
  mipmaps?: 'none' | 'nearest';
  /** Replaces both wrap modes; omitted keeps each texture's own. */
  wrap?: 'repeat' | 'clamp' | 'mirror';
}
/**
 * `texture` with pixel-art sampling: nearest magnification and minification, `mipmaps` 'none' (default) or 'nearest',
 * and `wrap` for both axes when given. The image bytes are shared, not copied. Throws RangeError for unknown values.
 */
export function pixelArtTexture(texture: TextureData, sampling: PixelArtSampling = {}): TextureData {
  const s = pixelArtOf(sampling);
  if (!s) return texture;
  return {
    ...texture,
    magFilter: 'nearest',
    minFilter: 'nearest',
    mipmaps: s.mipmaps === 'nearest',
    ...(s.wrap ? { wrapS: s.wrap, wrapT: s.wrap } : {}),
  };
}
/** @internal The validated pixel-art sampling of an option, or undefined when off. */
export function pixelArtOf(option: SceneOptions['pixelArt']): PixelArtSampling | undefined {
  if (option === undefined || option === false) return undefined;
  if (option === true) return { mipmaps: 'none' };
  if (!option || typeof option !== 'object')
    throw new TypeError('pixelArt must be true, false or {mipmaps, wrap}; pass true for no-mip nearest sampling');
  const { mipmaps = 'none', wrap } = option;
  if (mipmaps !== 'none' && mipmaps !== 'nearest')
    throw new RangeError(`pixelArt mipmaps must be 'none' or 'nearest', not ${String(mipmaps)}`);
  if (wrap !== undefined && !wraps.includes(wrap))
    throw new RangeError(`pixelArt wrap must be 'repeat', 'clamp' or 'mirror', not ${String(wrap)}`);
  return { mipmaps, wrap };
}

/** @internal Normalized geometry. */
export interface Geo {
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  uvs1?: Float32Array;
  tangents?: Float32Array;
  colors?: Float32Array;
  colorSize: 3 | 4;
  indices: Uint32Array;
  count: number;
  faceSizes?: Uint8Array;
  joints?: Uint16Array;
  weights?: Float32Array;
  morphs?: { name?: string; positions: Float32Array; normals?: Float32Array; tangents?: Float32Array }[];
  /** The geometry whose vertex attributes this primitive shares, with its own `indices`. */
  base?: Geo;
}
/** @internal Normalized material. */
export interface Mat {
  /** Original collector identity, resolved only if this material is actually emitted. */
  source?: object;
  name?: string;
  color: number[];
  roughness: number;
  metalness: number;
  doubleSided: boolean;
  emissive: number[];
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  baseColorTexture?: TextureData;
  baseColorTextureTransform?: { offset: Vec2; scale: Vec2 };
  metallicRoughnessTexture?: TextureData;
  normalTexture?: TextureData;
  occlusionTexture?: TextureData;
  emissiveTexture?: TextureData;
  unlit?: boolean;
  shading: 'standard' | 'lambert' | 'phong';
  specular: number[];
  shininess: number;
  normalScale: number;
  occlusionStrength: number;
  emissiveStrength: number;
  transmission: number;
  ior: number;
  /** Copied by the glTF writers, which alone write extras. */
  extras?: Extras;
}
/** @internal Normalized node. */
export interface Node {
  name?: string;
  t: number[];
  r: number[];
  s: number[];
  local: Float64Array;
  world: Float64Array;
  geometry?: Geo;
  material?: Mat;
  children: Node[];
  source?: ExportNode;
  skin?: SkinData;
  morphWeights?: Float32Array;
  /** Multi-material primitives: optional-package meshes, or a data node's `primitives`. */
  primitives?: { geometry: Geo; material?: Mat; extras?: Extras }[];
  /** The data node's `primitives` array, so nodes sharing it share one glTF mesh. */
  primitivesKey?: object;
  camera?: CameraData;
  light?: LightData;
  /** Column-major local matrix, written instead of TRS. */
  matrix?: number[];
  /** Transform fields a data node gave: written even when they equal glTF's default. */
  given?: { t: boolean; r: boolean; s: boolean };
  extras?: Extras;
  meshName?: string;
  meshExtras?: Extras;
  retainedVisibility?: boolean;
}

/** @internal Map slots of an @margoengine/materials Material, in gltf-pro's map order. */
export const materialSlots = [
  'map',
  'metalRoughnessMap',
  'normalMap',
  'aoMap',
  'emissiveMap',
  'clearcoatMap',
  'clearcoatRoughnessMap',
  'clearcoatNormalMap',
  'transmissionMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'specularIntensityMap',
  'specularColorMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'anisotropyMap',
  'thicknessMap',
] as const;

function fail(message: string): never {
  throw new TypeError(message);
}
export const isObject = <T>(value: T): value is T & Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isCoreGeometry = (value: unknown): value is Geometry =>
  isObject(value) &&
  value.vertices instanceof Float32Array &&
  value.indices instanceof Uint32Array &&
  value.bounds instanceof Float32Array;
const isCoreMaterial = (value: unknown): value is PbrMaterial =>
  isObject(value) && value.data instanceof Float32Array && value.data.length === 8;

function floats(values: ArrayLike<number> | undefined, size: number, label: string): Float32Array {
  if (!isObject(values) || typeof values.length !== 'number' || values.length !== size)
    fail(`${label} needs ${size} values`);
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const value = values![i];
    if (typeof value !== 'number' || !Number.isFinite(Math.fround(value)))
      throw new RangeError(`${label} must be finite Float32 values`);
    out[i] = value;
  }
  return out;
}

/**
 * Finite JavaScript numbers, copied exactly: node translations, rotations, scales and matrices are JSON numbers, never
 * Float32 accessor data, so no Float32 rounding, underflow or range limit applies to them.
 */
function exact(values: unknown, fallback: number[], label: string): number[] {
  if (values === undefined) return fallback.slice();
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) fail(`${label} must be an array`);
  const list = values as unknown as ArrayLike<unknown>;
  if (list.length !== fallback.length) fail(`${label} needs ${fallback.length} values`);
  const out = Array.from(list);
  if (out.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
    throw new RangeError(`${label} must be finite numbers`);
  return out as number[];
}

function vector(values: readonly number[] | undefined, fallback: number[], label: string): number[] {
  if (values === undefined) return fallback.slice();
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) fail(`${label} must be an array`);
  return Array.from(floats(values, fallback.length, label));
}

function unit(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new RangeError(`${label} must be in [0, 1]`);
  return value;
}

/** A validated triangle list into `count` vertices. */
function triangleIndices(source: unknown, count: number, label: string): Uint32Array {
  if (!isObject(source) || typeof source.length !== 'number' || source.length === 0 || source.length % 3)
    throw new RangeError(`${label} must hold complete triangles`);
  const indices = new Uint32Array(source.length);
  for (let i = 0; i < indices.length; i++) {
    const index = (source as unknown as ArrayLike<number>)[i];
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new RangeError('Index exceeds vertices; keep every index below the vertex count');
    indices[i] = index;
  }
  return indices;
}

/** Validates and normalizes geometry data. Normals and tangents become unit length, tangent w becomes +1 or -1. */
export function normalizeGeometry(data: Geometry | GeometryData): Geo {
  if (isCoreGeometry(data)) {
    const count = data.vertices.length / 6,
      positions = new Float32Array(count * 3),
      normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++)
      for (let a = 0; a < 3; a++) {
        positions[i * 3 + a] = data.vertices[i * 6 + a];
        normals[i * 3 + a] = data.vertices[i * 6 + 3 + a];
      }
    return normalizeGeometry({ positions, normals, indices: data.indices });
  }
  if (!isObject(data)) fail('Expected Geometry or geometry data');
  const length = data.positions?.length;
  if (typeof length !== 'number' || length === 0 || length % 3) throw new RangeError('Positions need xyz per vertex');
  const count = length / 3,
    positions = floats(data.positions, length, 'Positions'),
    normals = floats(data.normals, length, 'Normals');
  let indices: Uint32Array;
  if (data.indices === undefined) {
    if (count % 3) throw new RangeError('Non-indexed geometry needs complete triangles');
    indices = Uint32Array.from({ length: count }, (_, i) => i);
  } else indices = triangleIndices(data.indices, count, 'Indices');
  // Area-weighted fallback normals for zero-length inputs.
  let fallback: Float64Array | null = null;
  for (let i = 0; i < count; i++) {
    const x = normals[i * 3],
      y = normals[i * 3 + 1],
      z = normals[i * 3 + 2],
      l = Math.hypot(x, y, z);
    if (l > 1e-12) {
      normals[i * 3] = x / l;
      normals[i * 3 + 1] = y / l;
      normals[i * 3 + 2] = z / l;
      continue;
    }
    fallback ??= faceNormals(positions, indices, count);
    const fx = fallback[i * 3],
      fy = fallback[i * 3 + 1],
      fz = fallback[i * 3 + 2],
      fl = Math.hypot(fx, fy, fz);
    normals.set(fl > 1e-12 ? [fx / fl, fy / fl, fz / fl] : [0, 0, 1], i * 3);
  }
  const geo: Geo = { positions, normals, indices, count, colorSize: 4 };
  if (data.faceSizes !== undefined) {
    const sizes = data.faceSizes;
    if (!isObject(sizes) || typeof sizes.length !== 'number') fail('faceSizes must be an array of 3s and 4s');
    if (sizes.length > indices.length / 3)
      throw new RangeError('faceSizes must cover every triangle once: a 3 per triangle, a 4 per triangle pair');
    let at = 0;
    for (let f = 0; f < sizes.length; f++) {
      if (sizes[f] !== 3 && sizes[f] !== 4) throw new RangeError('faceSizes values must be 3 or 4');
      at += sizes[f] === 4 ? 6 : 3;
      if (at > indices.length) break;
      if (sizes[f] === 4 && !quad(indices, at - 6))
        throw new RangeError(`faceSizes[${f}] is 4 but its two triangles share no edge; write them as two 3s`);
    }
    if (at !== indices.length)
      throw new RangeError('faceSizes must cover every triangle once: a 3 per triangle, a 4 per triangle pair');
    geo.faceSizes = Uint8Array.from(sizes);
  }
  if (data.uvs !== undefined) geo.uvs = floats(data.uvs, count * 2, 'UVs');
  if (data.uvs1 !== undefined) geo.uvs1 = floats(data.uvs1, count * 2, 'UVs 1');
  if (data.tangents !== undefined) {
    const tangents = floats(data.tangents, count * 4, 'Tangents');
    for (let i = 0; i < count; i++) {
      const x = tangents[i * 4],
        y = tangents[i * 4 + 1],
        z = tangents[i * 4 + 2],
        l = Math.hypot(x, y, z);
      if (l <= 1e-12) throw new RangeError('Tangents must be nonzero');
      tangents.set([x / l, y / l, z / l, tangents[i * 4 + 3] < 0 ? -1 : 1], i * 4);
    }
    geo.tangents = tangents;
  }
  if (data.colors !== undefined) {
    const size = data.colors?.length === count * 3 ? 3 : 4,
      colors = floats(data.colors, count * size, 'Colors');
    if (colors.some((v) => v < 0 || v > 1)) throw new RangeError('Colors must be in [0, 1]');
    geo.colors = colors;
    geo.colorSize = size;
  }
  if ((data.joints === undefined) !== (data.weights === undefined))
    fail('Joint indices and weights are required together');
  if (data.joints !== undefined) {
    if (!isObject(data.joints) || data.joints.length !== count * 4) fail('Joints need four values per vertex');
    const joints = new Uint16Array(count * 4),
      weights = floats(data.weights, count * 4, 'Weights');
    for (let i = 0; i < joints.length; i++) {
      const joint = data.joints[i];
      if (!Number.isInteger(joint) || joint < 0 || joint > 65535)
        throw new RangeError('Joint indices must be unsigned 16-bit integers');
      if (weights[i] < 0) throw new RangeError('Skin weights must be nonnegative');
      joints[i] = joint;
    }
    for (let i = 0; i < weights.length; i += 4) {
      const sum = weights[i] + weights[i + 1] + weights[i + 2] + weights[i + 3];
      if (!(sum > 0)) throw new RangeError('Skin weights must have a positive sum');
      for (let c = 0; c < 4; c++) weights[i + c] /= sum;
    }
    geo.joints = joints;
    geo.weights = weights;
  }
  if (data.morphs !== undefined) {
    if (!Array.isArray(data.morphs) || !data.morphs.length) fail('Morphs must be a nonempty array');
    geo.morphs = data.morphs.map((morph: MorphData) => {
      if (!isObject(morph)) fail('Morph targets must be objects');
      if (morph.name !== undefined && typeof morph.name !== 'string') fail('Morph name must be a string');
      const out: NonNullable<Geo['morphs']>[number] = {
        name: morph.name,
        positions: floats(morph.positions, count * 3, 'Morph positions'),
      };
      if (morph.normals !== undefined) out.normals = floats(morph.normals, count * 3, 'Morph normals');
      if (morph.tangents !== undefined) {
        if (!geo.tangents) fail('Morph tangents need base tangents');
        out.tangents = floats(morph.tangents, count * 3, 'Morph tangents');
      }
      return out;
    });
  }
  return geo;
}

const faceNormals = (positions: Float32Array, indices: Uint32Array, count: number): Float64Array =>
  accumulateNormals(positions, indices, new Float64Array(count * 3));

/** @internal A validated texture, or undefined. */
export function checkTexture(texture: unknown, label: string): TextureData | undefined {
  if (texture === undefined) return undefined;
  if (!isObject(texture) || !(texture.image instanceof Uint8Array)) fail(`${label} needs an image Uint8Array`);
  const { image, mimeType, name } = texture as unknown as TextureData;
  if (name !== undefined && typeof name !== 'string') fail(`${label} name must be a string`);
  const png = image.length > 8 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
  const jpeg = image.length > 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  if (mimeType === 'image/png' ? !png : mimeType === 'image/jpeg' ? !jpeg : true)
    fail(`${label} must be a PNG or JPEG matching its mimeType`);
  for (const [key, values] of [
    ['magFilter', filters],
    ['minFilter', filters],
    ['wrapS', wraps],
    ['wrapT', wraps],
  ] as const)
    if (texture[key] !== undefined && !(values as readonly unknown[]).includes(texture[key]))
      fail(`${label} ${key} must be ${values.join(' or ')}`);
  if (texture.mipmaps !== undefined && typeof texture.mipmaps !== 'boolean') fail(`${label} mipmaps must be boolean`);
  if (texture.texCoord !== undefined && texture.texCoord !== 0 && texture.texCoord !== 1)
    throw new RangeError(`${label} texCoord must be 0 or 1`);
  return texture as unknown as TextureData;
}
const filters = ['nearest', 'linear'] as const,
  wraps = ['repeat', 'clamp', 'mirror'] as const;

/** @internal A texture's sampler with the defaults filled in, and pixel-art sampling applied when given. */
export const samplerOf = (
  t: TextureData,
  pixelArt?: PixelArtSampling,
): Required<Pick<TextureData, 'magFilter' | 'minFilter' | 'mipmaps' | 'wrapS' | 'wrapT'>> => ({
  magFilter: pixelArt ? 'nearest' : (t.magFilter ?? 'linear'),
  minFilter: pixelArt ? 'nearest' : (t.minFilter ?? 'linear'),
  mipmaps: pixelArt ? pixelArt.mipmaps === 'nearest' : (t.mipmaps ?? true),
  wrapS: pixelArt?.wrap ?? t.wrapS ?? 'repeat',
  wrapT: pixelArt?.wrap ?? t.wrapT ?? 'repeat',
});

/** sRGB #111111 in linear rgb, the default Phong highlight. */
const PHONG_SPECULAR = [0, 0, 0].map(() => ((17 / 255 + 0.055) / 1.055) ** 2.4);

/** Validates and normalizes a core PbrMaterial or material data. Base color is linear. */
export function normalizeMaterial(data: PbrMaterial | MaterialData): Mat {
  if (isCoreMaterial(data)) {
    const d = data.data;
    for (let i = 0; i < 8; i++)
      if (!Number.isFinite(d[i]) || d[i] < 0 || d[i] > 1)
        throw new RangeError('Invalid material values; use finite values from 0 to 1');
    return {
      color: [d[0], d[1], d[2], d[3]],
      roughness: d[4],
      metalness: d[5],
      doubleSided: d[6] === 1,
      emissive: [0, 0, 0],
      alphaMode: 'OPAQUE',
      shading: 'standard',
      specular: [...PHONG_SPECULAR],
      shininess: 30,
      ...MATERIAL_DEFAULTS,
    };
  }
  if (!isObject(data) || Array.isArray(data)) fail('Expected PbrMaterial or material data');
  const m = data as MaterialData;
  // Factors are JSON numbers in glTF, so they keep their exact values (Float32 only where a format needs it).
  const color =
    m.color === undefined ? [1, 1, 1, 1] : exact(m.color, m.color.length === 3 ? [0, 0, 0] : [0, 0, 0, 0], 'Color');
  if (color.length === 3) color.push(1);
  const emissive = exact(m.emissive, [0, 0, 0], 'Emissive');
  if ([...color, ...emissive].some((v) => v < 0 || v > 1)) throw new RangeError('Material colors must be in [0, 1]');
  if (m.name !== undefined && typeof m.name !== 'string') fail('Material name must be a string');
  if (m.doubleSided !== undefined && typeof m.doubleSided !== 'boolean') fail('doubleSided must be boolean');
  if (m.unlit !== undefined && typeof m.unlit !== 'boolean') fail('unlit must be boolean');
  const alphaMode = m.alphaMode ?? 'OPAQUE';
  if (!['OPAQUE', 'MASK', 'BLEND'].includes(alphaMode)) fail('Unknown alphaMode');
  if (m.alphaCutoff !== undefined && (alphaMode !== 'MASK' || !Number.isFinite(m.alphaCutoff) || !(m.alphaCutoff >= 0)))
    throw new RangeError('alphaCutoff needs MASK mode and a value >= 0');
  const shading = m.shading ?? 'standard';
  if (!['standard', 'lambert', 'phong'].includes(shading))
    fail("Material shading must be 'standard', 'lambert' or 'phong'");
  const specular = vector(m.specular, [...PHONG_SPECULAR], 'Specular'),
    shininess = m.shininess ?? 30;
  if (specular.some((v) => v < 0 || v > 1)) throw new RangeError('Material specular must be linear rgb in [0, 1]');
  if (!(shininess >= 0 && shininess < Infinity)) throw new RangeError('Material shininess must be finite and >= 0');
  const lit = shading !== 'standard';
  const baseColorTexture = checkTexture(m.baseColorTexture, 'baseColorTexture');
  let baseColorTextureTransform: Mat['baseColorTextureTransform'];
  if (m.baseColorTextureTransform !== undefined) {
    const transform = m.baseColorTextureTransform;
    if (!baseColorTexture || !isObject(transform) || Array.isArray(transform))
      fail('baseColorTextureTransform needs an object with offset/scale and a baseColorTexture');
    const offset = floats(transform.offset, 2, 'Texture transform offset'),
      scale = floats(transform.scale, 2, 'Texture transform scale');
    baseColorTextureTransform = { offset: [offset[0], offset[1]], scale: [scale[0], scale[1]] };
  }
  return {
    name: m.name,
    color,
    emissive,
    alphaMode,
    alphaCutoff: m.alphaCutoff,
    doubleSided: m.doubleSided ?? false,
    // Phong exponent to glTF roughness: Walter et al. 2007 sec. 5.2 (Beckmann alpha = sqrt(2 / (n + 2))), then sqrt.
    roughness: shading === 'phong' ? (2 / (shininess + 2)) ** 0.25 : lit ? 1 : unit(m.roughness, 'Roughness', 1),
    metalness: lit ? 0 : unit(m.metalness, 'Metalness', 0),
    baseColorTexture,
    baseColorTextureTransform,
    metallicRoughnessTexture: checkTexture(m.metallicRoughnessTexture, 'metallicRoughnessTexture'),
    normalTexture: checkTexture(m.normalTexture, 'normalTexture'),
    occlusionTexture: checkTexture(m.occlusionTexture, 'occlusionTexture'),
    emissiveTexture: checkTexture(m.emissiveTexture, 'emissiveTexture'),
    unlit: m.unlit,
    shading,
    specular,
    shininess,
    normalScale: factor(m.normalScale, 'normalScale', 1, () => true),
    occlusionStrength: unit(m.occlusionStrength, 'occlusionStrength', 1),
    emissiveStrength: factor(m.emissiveStrength, 'emissiveStrength', 1, (v) => v >= 0),
    transmission: unit(m.transmission, 'transmission', 0),
    ior: factor(m.ior, 'ior', 1.5, (v) => v === 0 || v >= 1),
    extras: m.extras,
  };
}

const MATERIAL_DEFAULTS = { normalScale: 1, occlusionStrength: 1, emissiveStrength: 1, transmission: 0, ior: 1.5 };
function factor(value: unknown, label: string, fallback: number, valid: (value: number) => boolean): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number') fail(`Material ${label} must be a number`);
  if (!Number.isFinite(value) || !valid(value))
    throw new RangeError(`Material ${label} ${value} is outside its glTF range; use a value inside the glTF range`);
  return value;
}

const TEXTURE_SLOTS = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'occlusionTexture',
  'emissiveTexture',
] as const;

/**
 * Buffer bytes of a geometry's vertex attributes as the glTF writers store them (POSITION, NORMAL, optional TANGENT,
 * TEXCOORD_0/1, COLOR_0, JOINTS_0 as 16-bit, WEIGHTS_0, morph targets), all Float32 and 4-byte multiples, from its
 * vertex count alone. Indices are counted when written, since primitives may replace them.
 */
function vertexCount(data: Geometry | GeometryData): number {
  if (isCoreGeometry(data)) return data.vertices.length / 6;
  const length = isObject(data) && isObject(data.positions) ? data.positions.length : 0;
  return typeof length === 'number' ? Math.floor(length / 3) : 0;
}

function attributeBytes(data: Geometry | GeometryData): number {
  if (isCoreGeometry(data)) return (data.vertices.length / 6) * 24;
  const count = vertexCount(data);
  let perVertex = 24;
  if (data.uvs !== undefined) perVertex += 8;
  if (data.uvs1 !== undefined) perVertex += 8;
  if (data.tangents !== undefined) perVertex += 16;
  if (data.colors !== undefined) perVertex += data.colors?.length === count * 3 ? 12 : 16;
  if (data.joints !== undefined) perVertex += 24;
  for (const morph of Array.isArray(data.morphs) ? data.morphs : [])
    perVertex += 12 + (morph?.normals !== undefined ? 12 : 0) + (morph?.tangents !== undefined ? 12 : 0);
  return count * perVertex;
}

// --- column-major 4x4 math in double precision ---

export function compose(t: number[], q: number[], s: number[]): Float64Array {
  const [x, y, z, w] = q;
  return new Float64Array([
    (1 - 2 * (y * y + z * z)) * s[0],
    2 * (x * y + w * z) * s[0],
    2 * (x * z - w * y) * s[0],
    0,
    2 * (x * y - w * z) * s[1],
    (1 - 2 * (x * x + z * z)) * s[1],
    2 * (y * z + w * x) * s[1],
    0,
    2 * (x * z + w * y) * s[2],
    2 * (y * z - w * x) * s[2],
    (1 - 2 * (x * x + y * y)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ]);
}

export const determinant3 = (m: Float64Array): number =>
  m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

/** Inverse transpose of the upper 3x3, as a column-major 3x3. */
export function normalMatrix(m: Float64Array): Float64Array {
  const a = m[0],
    b = m[1],
    c = m[2],
    d = m[4],
    e = m[5],
    f = m[6],
    g = m[8],
    h = m[9],
    i = m[10];
  const det = determinant3(m);
  if (!det || !Number.isFinite(det))
    throw new RangeError('Singular transform; use a transform with a non-zero determinant');
  // Cofactor matrix equals det * inverse transpose.
  return new Float64Array([
    (e * i - f * h) / det,
    (f * g - d * i) / det,
    (d * h - e * g) / det,
    (c * h - b * i) / det,
    (a * i - c * g) / det,
    (b * g - a * h) / det,
    (b * f - c * e) / det,
    (c * d - a * f) / det,
    (a * e - b * d) / det,
  ]);
}

/** Splits an affine matrix into translation, unit quaternion and scale, or returns null when it has shear. */
export function decompose(m: Float64Array): { t: number[]; r: number[]; s: number[] } | null {
  const trs = splitTRS(m, 1e-6);
  return typeof trs === 'string' ? null : { t: trs[0], r: unitQuaternion(trs[1]), s: trs[2] };
}

/**
 * @internal A saved rotation: kept exactly when it is a unit quaternion to within 1e-5 (the glTF validator's own
 * tolerance is wider), else scaled to unit length. Its sign is kept either way.
 */
export function savedRotation(q: number[]): number[] {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!length || !Number.isFinite(length)) throw new RangeError('Quaternion must be nonzero');
  return Math.abs(length - 1) <= 1e-5 ? q : q.map((v) => v / length);
}

function unitQuaternion(q: number[]): number[] {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!length || !Number.isFinite(length)) throw new RangeError('Quaternion must be nonzero');
  const out = q.map((v) => v / length);
  return out[3] < 0 ? out.map((v) => -v) : out;
}

// --- collection ---

function makeNode(name: unknown, t: number[], r: number[], s: number[], parent: Float64Array | null): Node {
  // Checked on the given numbers: a tiny nonzero scale such as 1e-50 is valid, only an exact 0 is zero.
  if (s.some((v) => v === 0) && !collapsed(s))
    throw new RangeError('Scale must be nonzero on every axis, or [0, 0, 0] to collapse a hidden node');
  // The written rotation keeps its saved value; the matrices use it at unit length.
  const length = Math.hypot(r[0], r[1], r[2], r[3]),
    local = compose(
      t,
      r.map((v) => v / length),
      s,
    );
  return {
    name: typeof name === 'string' && name ? name : undefined,
    t,
    r,
    s,
    local,
    world: parent ? multiplyMatrices(parent, local) : local,
    children: [],
  };
}

function isEngine(source: unknown): source is EngineKernel {
  return (
    isObject(source) &&
    typeof source.createMesh === 'function' &&
    isObject(source.store) &&
    source.meshes instanceof Map
  );
}

/**
 * @internal Collects the exported node forest. `plan`, when given, receives the buffer bytes each new geometry's
 * vertex attributes and each new image will take, before the data is normalized, so a size limit can refuse early.
 */
export function collect(source: ExportSource, options: SceneOptions = {}, plan?: (bytes: number) => void): Node[] {
  if (!isObject(options)) fail('Options must be an object');
  const onlyVisible = options.onlyVisible ?? true;
  if (typeof onlyVisible !== 'boolean') fail('onlyVisible must be boolean');
  const geometries = new Map<object, Geo>(),
    materials = new Map<object, Mat>(),
    images = new Set<Uint8Array>(),
    planned = new Set<object>();
  // Index lists that will be written (a geometry's own, once; a primitives array's, once), counted before any copy.
  const planIndices = (key: object, value: Geometry | GeometryData, count?: number): void => {
    if (!plan || planned.has(key)) return;
    planned.add(key);
    const data = (isCoreGeometry(value) && options.geometryData?.get(value)) || value,
      vertices = vertexCount(data),
      indices = count ?? (isObject(data.indices) ? data.indices.length : vertices);
    if (typeof indices === 'number') plan(indices * (vertices <= 65535 ? 2 : 4));
  };
  const geometry = (value: Geometry | GeometryData): Geo => {
    let geo = geometries.get(value);
    if (!geo) {
      const data = (isCoreGeometry(value) && options.geometryData?.get(value)) || value;
      plan?.(attributeBytes(data));
      geo = normalizeGeometry(data);
      geometries.set(value, geo);
    }
    return geo;
  };
  const material = (value: PbrMaterial | MaterialData): Mat => {
    let mat = materials.get(value);
    if (!mat) {
      mat = normalizeMaterial((isCoreMaterial(value) && options.materialData?.get(value)) || value);
      mat.source = value;
      materials.set(value, mat);
      for (const slot of TEXTURE_SLOTS) {
        const image = mat[slot]?.image;
        if (plan && image && !images.has(image)) {
          images.add(image);
          plan(image.length);
        }
      }
    }
    return mat;
  };
  const pbrSkins = new Map<PBRSource, Map<number, SkinData>>();
  const pbr = (triangles: Extract<ReturnType<typeof meshTriangles>, { kind: 'pbr' }>, node: Node): void => {
    const { model: source, primitives } = triangles.source,
      // A materials mesh (createMesh) draws its live Material's textures, which gltf-pro's maps do not list.
      owner = (source as { material?: Record<string, unknown> | readonly Record<string, unknown>[] }).material;
    if (!primitives.length) return;
    node.primitives = primitives.map((primitive) => {
      const { vertices, indices, definition, material: mat } = primitive,
        count = vertices.length / 20,
        side = mat.side ?? (mat.settings[2] === 2 ? 'back' : mat.settings[2] ? 'double' : 'front');
      if (!Number.isInteger(count) || !count) fail('Invalid PBR primitive vertices');
      if (
        mat.maps.some((map: unknown) => map) ||
        materialSlots.some((k) => (Array.isArray(owner) ? owner[definition.material!] : owner)?.[k]) ||
        mat.extension ||
        primitive.extension ||
        Object.keys(mat.extensions ?? {}).length
      )
        fail(
          'PBR texture and material extension export is unsupported; export textured models with exportModel (@margoengine/exporters/model)',
        );
      const attribute = (offset: number, width: number): Float32Array => {
        const out = new Float32Array(count * width);
        for (let i = 0; i < count; i++)
          for (let c = 0; c < width; c++) out[i * width + c] = vertices[i * 20 + offset + c];
        return out;
      };
      const data: GeometryData = { positions: attribute(0, 3), normals: attribute(4, 3), indices };
      const attrs = definition.attributes ?? {};
      if (attrs.TANGENT !== undefined) data.tangents = attribute(8, 4);
      if (attrs.TEXCOORD_0 !== undefined) data.uvs = attribute(12, 2);
      if (attrs.TEXCOORD_1 !== undefined) data.uvs1 = attribute(14, 2);
      if (attrs.COLOR_0 !== undefined) data.colors = attribute(16, 4);
      if (attrs.JOINTS_1 !== undefined || attrs.WEIGHTS_1 !== undefined)
        fail('Export supports at most four skin influences per vertex');
      if (attrs.JOINTS_0 !== undefined) data.joints = source.asset.accessor(attrs.JOINTS_0, 'VEC4');
      if (attrs.WEIGHTS_0 !== undefined) data.weights = source.asset.accessor(attrs.WEIGHTS_0, 'VEC4');
      if (definition.targets?.length)
        data.morphs = definition.targets.map((target: Record<string, number>, i: number) => ({
          name: primitive.targetNames[i],
          positions:
            target.POSITION === undefined
              ? new Float32Array(count * 3)
              : source.asset.accessor(target.POSITION, 'VEC3'),
          normals: target.NORMAL === undefined ? undefined : source.asset.accessor(target.NORMAL, 'VEC3'),
          tangents: target.TANGENT === undefined ? undefined : source.asset.accessor(target.TANGENT, 'VEC3'),
        }));
      const geometry = normalizeGeometry(data);
      if (side === 'back') {
        // normalizeGeometry owns these arrays, so the source's shared front-side geometry remains untouched.
        for (let i = 0; i < geometry.indices.length; i += 3)
          [geometry.indices[i + 1], geometry.indices[i + 2]] = [geometry.indices[i + 2], geometry.indices[i + 1]];
        for (let i = 0; i < geometry.normals.length; i++)
          geometry.normals[i] = geometry.normals[i] ? -geometry.normals[i] : 0;
        for (const morph of geometry.morphs ?? [])
          if (morph.normals)
            for (let i = 0; i < morph.normals.length; i++) morph.normals[i] = morph.normals[i] ? -morph.normals[i] : 0;
      }
      const material = normalizeMaterial({
        name: mat.name,
        color: mat.base,
        roughness: mat.factors[0],
        metalness: mat.factors[1],
        emissive: mat.emission,
        doubleSided: side === 'double',
        alphaMode: (mat.alphaMode as MaterialData['alphaMode']) ?? 'OPAQUE',
        alphaCutoff: mat.alphaMode === 'MASK' ? mat.settings[1] : undefined,
      });
      return { geometry, material };
    });
    node.geometry = node.primitives[0].geometry;
    node.material = node.primitives[0].material;
    const count = node.geometry.morphs?.length ?? 0;
    if (node.primitives.some((primitive) => (primitive.geometry.morphs?.length ?? 0) !== count))
      fail('PBR mesh primitives need matching morph targets');
    if (count) node.morphWeights = floats(primitives[0].weights, count, 'Morph weights');
    const skinIndex = source.asset.doc.nodes?.[primitives[0].nodeIndex]?.skin;
    if (skinIndex !== undefined) {
      let skins = pbrSkins.get(source);
      if (!skins) pbrSkins.set(source, (skins = new Map()));
      let skin = skins.get(skinIndex);
      if (!skin) {
        const definition = source.asset.doc.skins?.[skinIndex];
        if (!definition || !Array.isArray(definition.joints)) fail('Missing PBR skin');
        const joints = definition.joints.map((index: number) => source.nodes[index] as unknown as ExportNode);
        skin = {
          name: definition.name,
          joints,
          inverseBindMatrices:
            definition.inverseBindMatrices === undefined
              ? Float32Array.from({ length: joints.length * 16 }, (_, i) => ((i % 16) % 5 === 0 ? 1 : 0))
              : source.asset.accessor(definition.inverseBindMatrices, 'MAT4'),
        };
        skins.set(skinIndex, skin);
      }
      node.skin = skin;
    }
  };

  if (isEngine(source)) {
    const engine = engineRuntime(source);
    if (engine.disposed)
      throw new MargoError('disposed', 'Engine is disposed; export before dispose() or from a live engine');
    const store = engine.store,
      children = new Map<number, Mesh[]>(),
      tops: Mesh[] = [];
    for (const mesh of engine.meshes.values()) {
      const parent = store.parents[mesh.id];
      if (parent === -1) tops.push(mesh as unknown as Mesh);
      else {
        let list = children.get(parent);
        if (!list) children.set(parent, (list = []));
        list.push(mesh as unknown as Mesh);
      }
    }
    let roots = tops;
    if (options.root !== undefined) {
      if (!isObject(options.root) || engine.meshes.get(meshRuntime(options.root).id) !== (options.root as unknown))
        fail('root must be a live mesh of this engine');
      roots = [options.root];
    }
    const visit = (handle: Mesh, parent: Float64Array | null, depth: number): Node | null => {
      const mesh = meshRuntime(handle),
        id = mesh.id,
        t = store.transforms;
      if (depth > MAX_HIERARCHY_DEPTH)
        throw new RangeError('Hierarchy is too deep; flatten the hierarchy or reduce its depth');
      if (onlyVisible && store.hidden[id]) return null;
      const node = makeNode(
        mesh.name,
        [t.x[id], t.y[id], t.z[id]],
        unitQuaternion([t.qx[id], t.qy[id], t.qz[id], t.qw[id]]),
        [t.sx[id], t.sy[id], t.sz[id]],
        parent,
      );
      node.source = handle as unknown as ExportNode;
      const triangles = meshTriangles(mesh);
      if (triangles?.kind === 'core') {
        node.geometry = geometry(triangles.geometry);
        node.material = material(mesh.material);
      } else if (triangles?.kind === 'pbr') pbr(triangles, node);
      for (const child of children.get(id) ?? []) {
        const out = visit(child, node.world, depth + 1);
        if (out) node.children.push(out);
      }
      return node;
    };
    // An exported subtree root keeps its local transform, but its parents still place it in world space.
    let base: Float64Array | null = null;
    if (options.root !== undefined) {
      const chain: number[] = [],
        parent = store.parents[meshRuntime(options.root).id];
      if (onlyVisible && hiddenInTree(store, parent)) return [];
      for (let id = parent; id !== -1; id = store.parents[id]) chain.unshift(id);
      for (const id of chain) {
        const t = store.transforms,
          local = compose([t.x[id], t.y[id], t.z[id]], unitQuaternion([t.qx[id], t.qy[id], t.qz[id], t.qw[id]]), [
            t.sx[id],
            t.sy[id],
            t.sz[id],
          ]);
        base = base ? multiplyMatrices(base, local) : local;
      }
    }
    const collected = roots.map((mesh) => visit(mesh, base, 0)).filter((node): node is Node => node !== null);
    if (collected.length && !drawables(collected).length) fail('Engine export has no supported mesh geometry');
    return collected;
  }

  if (!isObject(source) || !Array.isArray((source as ExportScene).nodes))
    fail('Expected a Margo Engine engine or {nodes: [...]}');
  if (options.root !== undefined) fail('root applies to engine sources; pass a scene with the wanted nodes instead');
  const seen = new Set<ExportNode>();
  const visit = (data: ExportNode, parent: Float64Array | null, depth: number): Node | null => {
    if (!isObject(data)) fail('Scene nodes must be objects');
    if (seen.has(data)) fail('A scene node appears twice');
    if (depth > MAX_HIERARCHY_DEPTH)
      throw new RangeError('Hierarchy is too deep; flatten the hierarchy or reduce its depth');
    seen.add(data);
    if (data.visible !== undefined && typeof data.visible !== 'boolean') fail('visible must be boolean');
    if (onlyVisible && data.visible === false) return null;
    if (data.retainedVisibility !== undefined && typeof data.retainedVisibility !== 'boolean')
      fail('retainedVisibility must be boolean');
    if (data.name !== undefined && typeof data.name !== 'string') fail('Node name must be a string');
    let node: Node;
    if (data.matrix !== undefined) {
      if (data.translation !== undefined || data.rotation !== undefined || data.scale !== undefined)
        fail('A node takes matrix or translation, rotation and scale, not both');
      // Written as given; the decomposition only checks it and serves the formats that need TRS.
      const values = exact(data.matrix, new Array(16).fill(0), 'Matrix'),
        m = Float64Array.from(values);
      if (m[3] || m[7] || m[11] || m[15] !== 1) throw new RangeError('Matrix must be affine: its last row 0, 0, 0, 1');
      const parts = decompose(m);
      if (!parts)
        throw new RangeError('Matrix must split into translation, rotation and nonzero scale; glTF forbids shear');
      node = makeNode(data.name, parts.t, parts.r, parts.s, parent);
      node.local = m;
      node.world = parent ? multiplyMatrices(parent, m) : m;
      node.matrix = values;
    } else
      node = makeNode(
        data.name,
        exact(data.translation, [0, 0, 0], 'Translation'),
        savedRotation(exact(data.rotation, [0, 0, 0, 1], 'Rotation')),
        exact(data.scale, [1, 1, 1], 'Scale'),
        parent,
      );
    node.source = data;
    node.retainedVisibility = data.retainedVisibility;
    if (data.matrix === undefined)
      node.given = { t: data.translation !== undefined, r: data.rotation !== undefined, s: data.scale !== undefined };
    for (const key of ['camera', 'light'] as const)
      if (data[key] !== undefined) {
        if (!isObject(data[key])) fail(`${key} must be an object`);
        node[key] = data[key] as never;
      }
    node.extras = data.extras;
    if (data.skin !== undefined) {
      if (!isObject(data.skin)) fail('Skin must be an object');
      node.skin = data.skin;
    }
    if (data.primitives !== undefined) {
      if (data.geometry !== undefined || data.material !== undefined)
        fail('A node takes primitives or geometry and material, not both');
      if (!Array.isArray(data.primitives) || !data.primitives.length) fail('primitives must be a nonempty array');
      if (plan && !planned.has(data.primitives)) {
        planned.add(data.primitives);
        for (const primitive of data.primitives)
          if (isObject(primitive) && isObject(primitive.geometry))
            if (primitive.indices === undefined) planIndices(primitive.geometry, primitive.geometry);
            else planIndices(primitive, primitive.geometry, isObject(primitive.indices) ? primitive.indices.length : 0);
      }
      node.primitives = data.primitives.map((primitive: ExportPrimitive, i: number) => {
        if (!isObject(primitive) || primitive.geometry === undefined) fail(`primitives[${i}] needs geometry`);
        let geo = geometry(primitive.geometry);
        if (primitive.indices !== undefined)
          geo = {
            ...geo,
            indices: triangleIndices(primitive.indices, geo.count, `primitives[${i}] indices`),
            faceSizes: undefined,
            base: geo,
          };
        return {
          geometry: geo,
          material: primitive.material === undefined ? undefined : material(primitive.material),
          extras: primitive.extras,
        };
      });
      const targets = node.primitives[0].geometry.morphs?.length ?? 0;
      if (node.primitives.some((primitive) => (primitive.geometry.morphs?.length ?? 0) !== targets))
        fail('Every primitive of a mesh needs the same number of morph targets');
      node.primitivesKey = data.primitives;
      node.geometry = node.primitives[0].geometry;
      node.material = node.primitives[0].material;
    } else if (data.geometry !== undefined) {
      if (isObject(data.geometry)) planIndices(data.geometry, data.geometry);
      node.geometry = geometry(data.geometry);
      if (data.material !== undefined) node.material = material(data.material);
    } else if (data.material !== undefined) fail('A material needs geometry on the same node');
    if (data.meshName !== undefined && typeof data.meshName !== 'string') fail('meshName must be a string');
    node.meshName = data.meshName;
    node.meshExtras = data.meshExtras;
    if (data.skin !== undefined && !node.geometry) fail('A skin needs geometry on the same node');
    if (data.morphWeights !== undefined) {
      const count = node.geometry?.morphs?.length;
      if (!count) fail('Morph weights need morph targets on the same node');
      node.morphWeights = floats(data.morphWeights, count!, 'Morph weights');
    }
    if (data.children !== undefined && !Array.isArray(data.children)) fail('children must be an array');
    for (const child of data.children ?? []) {
      const out = visit(child, node.world, depth + 1);
      if (out) node.children.push(out);
    }
    return node;
  };
  return (source as ExportScene).nodes
    .map((node) => visit(node, null, 0))
    .filter((node): node is Node => node !== null);
}

/** Corners [a, b, c, d] of the quad split as (a, b, c) and (a, c, d) at `at`, in any rotation, else null. */
function quad(indices: ArrayLike<number>, at: number): number[] | null {
  for (let k = 0; k < 3; k++) {
    const a = indices[at + k],
      b = indices[at + ((k + 1) % 3)],
      c = indices[at + ((k + 2) % 3)];
    for (let j = 0; j < 3; j++) {
      const d = indices[at + 3 + ((j + 2) % 3)];
      if (indices[at + 3 + j] === a && indices[at + 3 + ((j + 1) % 3)] === c && d !== a && d !== b && d !== c)
        return [a, b, c, d];
    }
  }
  return null;
}

/** @internal Faces in index order: triangles, and quads where `faceSizes` marks them (validated by normalizeGeometry). */
export function polygons(faceSizes: Uint8Array | undefined, indices: Uint32Array): number[][] {
  const out: number[][] = [];
  for (let f = 0, at = 0; at < indices.length; f++)
    if (faceSizes?.[f] === 4) {
      out.push(quad(indices, at)!);
      at += 6;
    } else {
      out.push([indices[at], indices[at + 1], indices[at + 2]]);
      at += 3;
    }
  return out;
}

/** @internal Names each texture image's file once, `${prefix}${name}.png` or `.jpg`, and collects name -> bytes. */
export function textureFiles(prefix: unknown): { files: Map<string, Uint8Array>; name(texture: TextureData): string } {
  if (typeof prefix !== 'string' || !/^[\w./-]*$/.test(prefix))
    throw new TypeError('texturePrefix may hold only letters, digits, _ . - and /');
  const files = new Map<string, Uint8Array>(),
    names = new Map<Uint8Array, string>();
  return {
    files,
    name(texture) {
      let name = names.get(texture.image);
      if (name === undefined) {
        const base =
            prefix +
            ((texture.name ?? '').replace(/\.(png|jpe?g)$/i, '').replace(/[^\w.-]+/g, '_') || `texture_${names.size}`),
          ext = texture.mimeType === 'image/png' ? '.png' : '.jpg';
        name = base + ext;
        for (let n = 2; files.has(name); n++) name = `${base}_${n}${ext}`;
        names.set(texture.image, name);
        files.set(name, texture.image);
      }
      return name;
    },
  };
}

/** @internal A drawable with its world transform, in depth-first order. */
export interface Drawable {
  name?: string;
  geometry: Geo;
  material?: Mat;
  world: Float64Array;
}

/** A [0, 0, 0] scale: the node and its descendants are hidden. */
const collapsed = (s: readonly number[]): boolean => s.every((v) => v === 0);

export function drawables(nodes: Node[]): Drawable[] {
  const out: Drawable[] = [];
  const walk = (node: Node) => {
    if (collapsed(node.s)) return;
    if (node.primitives)
      for (const primitive of node.primitives)
        out.push({ name: node.name, geometry: primitive.geometry, material: primitive.material, world: node.world });
    else if (node.geometry)
      out.push({ name: node.name, geometry: node.geometry, material: node.material, world: node.world });
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/** @internal World-space vertices, unit normals and winding-corrected indices of one drawable. */
export function toWorld({ geometry, world }: Drawable): {
  positions: Float64Array;
  normals: Float64Array;
  indices: Uint32Array;
} {
  const { count } = geometry,
    positions = new Float64Array(count * 3),
    normals = new Float64Array(count * 3),
    n = normalMatrix(world);
  for (let i = 0; i < count; i++) {
    const x = geometry.positions[i * 3],
      y = geometry.positions[i * 3 + 1],
      z = geometry.positions[i * 3 + 2];
    for (let r = 0; r < 3; r++)
      positions[i * 3 + r] = world[r] * x + world[4 + r] * y + world[8 + r] * z + world[12 + r];
    const nx = geometry.normals[i * 3],
      ny = geometry.normals[i * 3 + 1],
      nz = geometry.normals[i * 3 + 2];
    const v = [n[0] * nx + n[3] * ny + n[6] * nz, n[1] * nx + n[4] * ny + n[7] * nz, n[2] * nx + n[5] * ny + n[8] * nz],
      l = Math.hypot(v[0], v[1], v[2]) || 1;
    for (let r = 0; r < 3; r++) normals[i * 3 + r] = v[r] / l;
  }
  let indices = geometry.indices;
  if (determinant3(world) < 0) {
    indices = indices.slice();
    for (let i = 0; i < indices.length; i += 3) {
      const b = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = b;
    }
  }
  return { positions, normals, indices };
}

// Recently written values: meshes repeat most of theirs (shared corners, axis normals, UVs). Cleared when full.
const numCache = new Map<number, string>(),
  numBits = new Uint32Array(new Float32Array(1).buffer),
  numFloat = new Float32Array(numBits.buffer);
/** The fewest significant digits (1 to 9) whose toPrecision text reads back as `f`, and that text as a number. */
function shortest(f: number): string {
  // Integers below 2^24 are exact and distinct in Float32, so their shortest text is the integer itself.
  if (Number.isInteger(f) && Math.abs(f) < 16_777_216) return String(f);
  const fits = (digits: number): boolean => Math.fround(Number(f.toPrecision(digits))) === f;
  numFloat[0] = f;
  const exponent = (numBits[0] >>> 23) & 255;
  // Away from a power of two, f's rounding interval is symmetric, so a correctly rounded text with more digits is never
  // farther from f: once some digit count reads back, every larger one does, and a binary search finds the fewest (3 or
  // 4 toPrecision calls instead of up to 9). A power of two (zero mantissa), the top binade, NaN and infinity have a
  // lopsided or open interval: they scan every count.
  if (numBits[0] & 0x7fffff && exponent > 0 && exponent < 254) {
    let low = 1,
      high = 9; // nine significant digits always identify a Float32
    while (low < high) {
      const mid = (low + high) >> 1;
      if (fits(mid)) high = mid;
      else low = mid + 1;
    }
    return String(Number(f.toPrecision(low)));
  }
  for (let digits = 1; digits < 10; digits++) if (fits(digits)) return String(Number(f.toPrecision(digits)));
  return String(f);
}
/** @internal Shortest decimal that reads back as the same Float32 value. */
export function num(value: number): string {
  const f = Math.fround(value);
  if (f === 0) return '0';
  let text = numCache.get(f);
  if (text === undefined) {
    text = shortest(f);
    if (numCache.size >= 8192) numCache.clear();
    numCache.set(f, text);
  }
  return text;
}

export const toSrgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
export const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

/** @internal Replaces whitespace so a name survives line-based formats. */
export const token = (name: string | undefined, fallback: string): string =>
  (name ?? '').replace(/[\s#]+/g, '_') || fallback;
