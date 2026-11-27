// Shared scene collection for every exporter: walks a Margo Engine engine (or a plain data scene), validates and
// normalizes geometry and materials, and computes local and world transforms in double precision.
import { num } from '../../shared/float-text.js';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel, Mesh, Geometry, PbrMaterial } from '@margoengine/core';
import type { Vec2 } from '@margoengine/math';
import type { PBRSource } from '../../shared/pbr-source.js';
import { meshTriangles } from '../../shared/mesh-source.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { vertexValues } from '../../shared/vertex-map.js';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { splitNodeMatrix } from '@margoengine/math/quat';
import { accumulateNormals } from '../../shared/normals.js';

/** Deepest node chain an export walks; one level deeper throws before any node is written. */
const MAX_HIERARCHY_DEPTH = 1024;

/** Plain geometry with optional UVs, tangents and vertex colors, for data that core `Geometry` cannot hold. */
export interface GeometryData {
  /** xyz per vertex. */
  positions: ArrayLike<number>;
  /**
   * xyz per vertex, optional. Normalized on export. A triangle vertex without one (omitted, or a zero vector) takes the
   * area-weighted normal of its faces; a point or line keeps none and is drawn unlit (glTF 2.0 section 3.9.7).
   */
  normals?: ArrayLike<number>;
  /** uv per vertex (glTF convention, v down). */
  uvs?: ArrayLike<number>;
  /** Optional second UV set. */
  uvs1?: ArrayLike<number>;
  /** Optional third UV set. glTF writers only. */
  uvs2?: ArrayLike<number>;
  /** Optional fourth UV set. glTF writers only. */
  uvs3?: ArrayLike<number>;
  /** xyzw per vertex, w is the bitangent sign (+1 or -1). */
  tangents?: ArrayLike<number>;
  /** Linear rgb or rgba per vertex, each in [0, 1]. */
  colors?: ArrayLike<number>;
  /** A second color set, as `colors`. glTF writers only. */
  colors1?: ArrayLike<number>;
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
  /**
   * Four more joint indices and weights per vertex (glTF `JOINTS_1`, `WEIGHTS_1`), with `joints` and `weights`:
   * eight influences in all, normalized together. Default none. glTF, USDZ and the pose bake take them; Roblox refuses.
   */
  joints1?: ArrayLike<number>;
  weights1?: ArrayLike<number>;
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
  /** UV set the material samples it with: 0 (`uvs`, default), 1 (`uvs1`), 2 or 3. glTF writers only. */
  texCoord?: 0 | 1 | 2 | 3;
  extras?: Extras;
}

/** A KHR_texture_transform: uv' = offset + rotation * scale * uv, Float32 values; `rotation` in radians, default 0. */
export interface TextureTransform {
  offset: Vec2;
  scale: Vec2;
  rotation?: number;
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
   * KHR_texture_transform of `baseColorTexture` (required by the file), Float32 values: uv' = offset + rotation *
   * scale * uv. `rotation` (radians, default 0) turns the texture coordinates counter-clockwise about the uv origin
   * (top left, v down), so the image turns clockwise on the surface. glTF writers write it as given; `exportUSDZ`
   * writes a `UsdTransform2d`. `offset` and `scale` are targets of `materialAnimations`.
   */
  baseColorTextureTransform?: TextureTransform;
  metallicRoughnessTexture?: TextureData;
  /** KHR_texture_transform of `metallicRoughnessTexture`, as `baseColorTextureTransform`. glTF writers only. */
  metallicRoughnessTextureTransform?: TextureTransform;
  normalTexture?: TextureData;
  /** KHR_texture_transform of `normalTexture`, as `baseColorTextureTransform`. glTF writers only. */
  normalTextureTransform?: TextureTransform;
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
  /** KHR_texture_transform of `occlusionTexture`, as `baseColorTextureTransform`. glTF writers only. */
  occlusionTextureTransform?: TextureTransform;
  /** How much `occlusionTexture` darkens, 0 to 1. Default 1. */
  occlusionStrength?: number;
  /** Emitted color in its rgb, multiplied by `emissive` (so set `emissive`, e.g. [1, 1, 1]). glTF writers only. */
  emissiveTexture?: TextureData;
  /** KHR_texture_transform of `emissiveTexture`, as `baseColorTextureTransform`. glTF writers only. */
  emissiveTextureTransform?: TextureTransform;
  /** Multiplier on the emitted color, finite and >= 0, for emission brighter than 1: KHR_materials_emissive_strength. Default 1. */
  emissiveStrength?: number;
  /** Fraction of light transmitted through the surface, 0 to 1: KHR_materials_transmission. Default 0. */
  transmission?: number;
  /** Index of refraction, 0 or >= 1: KHR_materials_ior. Default 1.5. */
  ior?: number;
  extras?: Extras;
}

/** A glTF camera on a data-scene node, looking down the node's -Z; a gltf/pbr `GLTFCamera` record fits as it is. */
export interface CameraData {
  type: 'perspective' | 'orthographic';
  name?: string;
  /** Angles in radians; omitted `zfar` is an infinite projection. */
  perspective?: { yfov: number; znear: number; zfar?: number; aspectRatio?: number };
  orthographic?: { xmag: number; ymag: number; znear: number; zfar: number };
  extras?: Extras;
}

/** A KHR_lights_punctual light on a data-scene node, pointing down the node's -Z; a gltf/pbr `GLTFLight` record fits as it is. */
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
  /**
   * Index list into `geometry`'s vertices, used instead of its `indices`, read as `mode` says: whole triangles for
   * triangles (the default), one index a point, two a segment, a run for a strip or loop.
   */
  indices?: ArrayLike<number>;
  /**
   * What the indices draw, by glTF 2.0 name or number (section 3.7.2.1): 'POINTS' 0, 'LINES' 1, 'LINE_LOOP' 2,
   * 'LINE_STRIP' 3, 'TRIANGLES' 4, 'TRIANGLE_STRIP' 5, 'TRIANGLE_FAN' 6. Default 'TRIANGLES'. Strips, loops and fans
   * are written as the point, line or triangle lists they draw. Points and lines go to the writers with a form for
   * them (glTF, OBJ, PLY, COLLADA lines, USDZ); the rest call `onWarning`. A point or line primitive needs no normals
   * and takes no morph targets.
   */
  mode?: PrimitiveMode;
  /** glTF writers only. */
  extras?: Extras;
}

/** A primitive's topology by glTF 2.0 name or `mesh.primitive.mode` number (section 3.7.2.1). */
export type PrimitiveMode =
  | 'POINTS'
  | 'LINES'
  | 'LINE_LOOP'
  | 'LINE_STRIP'
  | 'TRIANGLES'
  | 'TRIANGLE_STRIP'
  | 'TRIANGLE_FAN'
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6;
const MODE_NAMES = ['POINTS', 'LINES', 'LINE_LOOP', 'LINE_STRIP', 'TRIANGLES', 'TRIANGLE_STRIP', 'TRIANGLE_FAN'];

/** @internal A {@link PrimitiveMode} as its glTF number. */
export function modeNumber(mode: unknown): number {
  const at = typeof mode === 'string' ? MODE_NAMES.indexOf(mode) : Number.isInteger(mode) ? (mode as number) : -1;
  if (at < 0 || at > 6)
    throw new TypeError(
      `Unknown primitive mode ${String(mode)}; use a glTF mode name (${MODE_NAMES.join(', ')}) or 0 to 6`,
    );
  return at;
}

/**
 * @internal A mode's index run as the list it draws (glTF 2.0 section 3.7.2.1): points and lines as they are, a loop
 * or strip as segments, a triangle strip or fan as triangles. A strip, loop or fan too short to draw anything is empty.
 */
export function listOfMode(mode: number, run: ArrayLike<number>): number[] {
  const n = run.length,
    out: number[] = [];
  if (mode === 2 || mode === 3) {
    for (let i = 0; i + 1 < n; i++) out.push(run[i], run[i + 1]);
    if (mode === 2 && n > 2) out.push(run[n - 1], run[0]);
  } else if (mode === 5) {
    for (let i = 0; i + 2 < n; i++) out.push(run[i], run[i + 1 + (i % 2)], run[i + 2 - (i % 2)]);
  } else if (mode === 6) {
    for (let i = 1; i + 1 < n; i++) out.push(run[i], run[i + 1], run[0]);
  } else for (let i = 0; i < n; i++) out.push(run[i]);
  return out;
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
  /**
   * Called once per engine mesh or data node for points and lines a writer has no form for: a loaded model's glTF
   * points and lines (`pointsAndLines`), a data primitive's `mode`, or the `@margoengine/lines` lines and
   * `@margoengine/points` clouds that follow a mesh; and once per such line or cloud that follows no mesh. The glTF
   * writers and `exportModel` write them all. Default `console.warn` of the message.
   */
  onWarning?: (warning: ExportWarning) => void;
}
/**
 * What {@link SceneOptions.onWarning} receives: the error code it would carry, a message and the engine mesh or data
 * node, or null for a `@margoengine/lines` line or `@margoengine/points` cloud that follows no mesh (`item` is it).
 */
export interface ExportWarning {
  code: 'unsupported';
  message: string;
  node: Mesh | ExportNode | null;
  /** The plugin line, point cloud or splat cloud left out, for a warning about one that follows no mesh. */
  item?: object;
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
  uvs2?: Float32Array;
  uvs3?: Float32Array;
  tangents?: Float32Array;
  colors?: Float32Array;
  colorSize: 3 | 4;
  colors1?: Float32Array;
  colors1Size?: 3 | 4;
  indices: Uint32Array;
  count: number;
  faceSizes?: Uint8Array;
  joints?: Uint16Array;
  weights?: Float32Array;
  /** The second four influences of each vertex, normalized with the first four. */
  joints1?: Uint16Array;
  weights1?: Float32Array;
  /**
   * A plugin stroke's or cloud's per-point multiplier of its material `width` (a `Stroke`'s `widths`, a cloud's
   * `sizes`): glTF `_WIDTH`, USD vertex `widths`.
   */
  widths?: Float32Array;
  morphs?: { name?: string; positions: Float32Array; normals?: Float32Array; tangents?: Float32Array }[];
  /** The geometry whose vertex attributes this primitive shares, with its own `indices`. */
  base?: Geo;
  /**
   * A point list (`indices` one vertex each) or line list (`indices` two per segment) instead of triangles. Only a
   * node's `lines` hold these, so the triangle writers never see one.
   */
  topology?: 'points' | 'lines';
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
  baseColorTextureTransform?: TextureTransform;
  metallicRoughnessTexture?: TextureData;
  metallicRoughnessTextureTransform?: TextureTransform;
  normalTexture?: TextureData;
  normalTextureTransform?: TextureTransform;
  occlusionTexture?: TextureData;
  occlusionTextureTransform?: TextureTransform;
  emissiveTexture?: TextureData;
  emissiveTextureTransform?: TextureTransform;
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
  /**
   * A plugin line's width or point cloud's diameter, in CSS pixels or world units. The USD writers write world units as
   * `widths`; the glTF writers write it in the primitive's extras.
   */
  width?: { value: number; units: 'pixels' | 'world'; kind: 'points' | 'lines' };
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
  /** Points and lines, in source order, for the writers that pass `writes` to `collect`. */
  lines?: { geometry: Geo; material?: Mat; extras?: Extras }[];
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

/** @internal Map slots of an @margoengine/materials Material, in gltf/pbr's map order. */
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
  'diffuseRoughnessMap',
] as const;

// The key gltf/pbr defines on each node it creates, holding its PBRModel (gltf/pbr src/model.ts `cpuSource`).
const pbrModelKey = Symbol.for('margoengine.pbr-source.v1');
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

/** A validated point list (one index each) or line list (two per segment) into `count` vertices; all of them when omitted. */
function listIndices(source: unknown, count: number, topology: 'points' | 'lines'): Uint32Array {
  if (source === undefined) {
    if (topology === 'lines' && count % 2) throw new RangeError('Non-indexed lines need complete segments');
    return Uint32Array.from({ length: count }, (_, i) => i);
  }
  if (!isObject(source) || typeof source.length !== 'number' || (topology === 'lines' && source.length % 2))
    throw new RangeError(
      `${topology === 'lines' ? 'Line' : 'Point'} indices must hold complete ${topology === 'lines' ? 'segments' : 'points'}`,
    );
  const indices = new Uint32Array(source.length);
  for (let i = 0; i < indices.length; i++) {
    const index = (source as unknown as ArrayLike<number>)[i];
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new RangeError('Index exceeds vertices; keep every index below the vertex count');
    indices[i] = index;
  }
  return indices;
}

type Part = { geometry: Geo; material: Mat; extras: Extras };
/** A `@margoengine/lines` line or `@margoengine/points` cloud, found by its public fields. */
interface PluginItem {
  object: object;
  visible: boolean;
  matrix: ArrayLike<number>;
  name?: string;
  mesh: Mesh | null;
  topology: 'points' | 'lines';
  /** Bytes its vertex attributes and indices take, for a writer's size plan. */
  bytes: number;
  /** Its point or line list, or null when it draws nothing (fewer than two line points, no finite cloud point). */
  part: () => Part | null;
}
/** The public fields of a `@margoengine/lines` Line that the exporters read. */
interface PluginLine {
  visible: boolean;
  matrix: Float32Array;
  points: Float32Array;
  colors: Float32Array | null;
  count: number;
  mode: 'segments' | 'strip' | 'loop';
  attachedMesh: Mesh | null;
  material: PluginLineStyle & {
    color: Float32Array;
    opacity: number;
    width: number;
    worldUnits: boolean;
    vertexColors?: boolean;
    colorMode?: string;
  };
}
/** The public style fields of a line material or batch that go in the primitive's extras. */
interface PluginLineStyle {
  join?: string;
  cap?: string;
  miterLimit?: number;
  dashed?: boolean;
  dashCap?: string;
  dashSize?: number;
  gapSize?: number;
  dashOffset?: number;
  onTop?: boolean;
  antialias?: boolean;
  depthWrite?: boolean;
  depthBias?: number;
  behind?: boolean;
  alphaToCoverage?: boolean;
  fog?: boolean;
}
/** The public fields of a `@margoengine/points` PointCloud that the exporters read. */
interface PluginCloud {
  name: string;
  visible: boolean;
  matrix: Float32Array;
  count: number;
  positions: Float32Array;
  normals: Float32Array | null;
  colors: Uint32Array | null;
  floatColors: Float32Array | null;
  colorSpace: 'srgb' | 'linear';
  sizes: Float32Array | null;
  attachedMesh: Mesh | null;
  material: {
    color: Float32Array;
    opacity: number;
    size: number;
    sizeUnits: 'pixels' | 'world';
    shading: string;
    vertexColors: boolean;
  } & Partial<Record<keyof typeof POINT_DEFAULTS, unknown>>;
}
const isPluginLine = (v: unknown): v is PluginLine =>
  isObject(v) &&
  v.points instanceof Float32Array &&
  v.matrix instanceof Float32Array &&
  typeof v.count === 'number' &&
  typeof v.mode === 'string' &&
  isObject(v.material) &&
  typeof v.material.width === 'number' &&
  v.material.color instanceof Float32Array;
const isPluginCloud = (v: unknown): v is PluginCloud =>
  isObject(v) &&
  v.positions instanceof Float32Array &&
  v.matrix instanceof Float32Array &&
  typeof v.count === 'number' &&
  isObject(v.material) &&
  typeof v.material.size === 'number' &&
  v.material.color instanceof Float32Array;
/** A batch of a `LineBatches` plugin: packed segments of 32 bytes, x, y, z and sRGB rgba8 at each end. */
interface PluginBatch {
  visible?: boolean;
  matrix: Float32Array;
  attachedMesh: Mesh | null;
  data: ArrayBuffer;
  count: number;
  color: Float32Array;
  opacity: number;
  width: number;
  worldUnits: boolean;
  onTop?: boolean;
  antialias?: boolean;
}
const isPluginBatch = (v: unknown): v is PluginBatch =>
  isObject(v) &&
  v.data instanceof ArrayBuffer &&
  v.matrix instanceof Float32Array &&
  v.color instanceof Float32Array &&
  typeof v.count === 'number' &&
  v.data.byteLength >= v.count * 32 &&
  typeof v.width === 'number';
/** sRGB-encoded 0..1 to linear (IEC 61966-2-1:1999). */
const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * The lines of a `Lines` plugin (its `lines`), the batches of a `LineBatches` plugin (its `batches`) and the clouds of
 * a `PointsPlugin` (its `pointClouds`). A `DebugLines` plugin's batches are one frame's debug drawing, so none is read.
 */
// The key on the plugins gltf/pbr adds to draw a model's wide points and lines (gltf/pbr src/strokes.ts `strokesKey`):
// the model writes those primitives itself, with their widths.
const gltfStrokesKey = Symbol.for('margoengine.gltf-strokes.v1');
function pluginItems(plugin: unknown): PluginItem[] {
  if (!isObject(plugin) || (plugin as Record<symbol, unknown>)[gltfStrokesKey]) return [];
  const out: PluginItem[] = [],
    { lines, batches, pointClouds, drawLine } = plugin as {
      lines?: unknown;
      batches?: unknown;
      pointClouds?: unknown;
      drawLine?: unknown;
    };
  if (lines instanceof Set)
    for (const line of lines)
      if (isPluginLine(line))
        out.push({
          object: line,
          visible: line.visible !== false,
          matrix: line.matrix,
          mesh: line.attachedMesh ?? null,
          topology: 'lines',
          bytes: line.count * 40,
          part: () => linePart(line),
        });
  if (batches instanceof Set && typeof drawLine !== 'function')
    for (const batch of batches)
      if (isPluginBatch(batch))
        out.push({
          object: batch,
          visible: batch.visible !== false,
          matrix: batch.matrix,
          mesh: batch.attachedMesh ?? null,
          topology: 'lines',
          bytes: batch.count * 64,
          part: () => batchPart(batch),
        });
  if (pointClouds instanceof Set)
    for (const cloud of pointClouds)
      if (isPluginCloud(cloud))
        out.push({
          object: cloud,
          visible: cloud.visible !== false,
          matrix: cloud.matrix,
          name: cloud.name || undefined,
          mesh: cloud.attachedMesh ?? null,
          topology: 'points',
          bytes: cloud.count * 44,
          part: () => cloudPart(cloud),
        });
  return out;
}

/** The plugin's colour and opacity as an unlit (or, for lit sphere points, lit) material with the item's width. */
function pluginMaterial(
  color: Float32Array,
  opacity: number,
  unlit: boolean,
  translucent: boolean,
  width: { value: number; units: 'pixels' | 'world'; kind: 'points' | 'lines' },
): Mat {
  const mat = normalizeMaterial({
    color: [color[0], color[1], color[2], opacity],
    unlit,
    alphaMode: opacity < 1 || translucent ? 'BLEND' : 'OPAQUE',
    roughness: 1,
    metalness: 0,
  });
  mat.width = width;
  return mat;
}

/**
 * A line's centre polyline as a line list: segments in pairs, a strip's run, a loop closed. glTF gives a line no width
 * (glTF 2.0 section 3.9.7), so the line's own goes in the primitive's extras as `lineWidth` with `lineWidthUnits`.
 */
function linePart(line: PluginLine): Part | null {
  const n = line.count;
  if (n < 2) return null;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = line.points[i * 4 + k];
  const run = Uint32Array.from({ length: line.mode === 'segments' ? n - (n % 2) : n }, (_, i) => i),
    indices = line.mode === 'segments' ? run : listOfMode(line.mode === 'loop' ? 2 : 3, run),
    data: GeometryData = { positions, indices },
    m = line.material,
    colors =
      (m.vertexColors ?? true) && line.colors && line.colors.length >= n * 4 ? line.colors.slice(0, n * 4) : null;
  // glTF multiplies COLOR_0 by the base colour (glTF 2.0 section 3.9.2). A line that draws the point's colour alone
  // ('set') or the clamped sum of both ('add') writes what it draws over a white base colour.
  const baked = colors !== null && (m.colorMode === 'set' || m.colorMode === 'add');
  if (baked && m.colorMode === 'add')
    for (let i = 0; i < colors.length; i++) if (i % 4 < 3) colors[i] = Math.min(1, colors[i] + m.color[i % 4]);
  if (colors) data.colors = colors;
  const units = m.worldUnits ? 'world' : 'pixels',
    translucent = colors !== null && colors.some((v, i) => i % 4 === 3 && v < 1),
    geometry = normalizeGeometry(data, 'lines'),
    widths = multipliers((line as { widths?: unknown }).widths, n);
  if (widths) geometry.widths = widths;
  return {
    geometry,
    material: pluginMaterial(baked ? white : m.color, m.opacity, true, translucent, {
      value: m.width,
      units,
      kind: 'lines',
    }),
    extras: { lineWidth: m.width, lineWidthUnits: units, ...lineStyle(m) },
  };
}

/** A `Line`'s defaults for the style fields written as `line` + the field's name. */
const LINE_DEFAULTS = {
  join: 'round',
  cap: 'round',
  miterLimit: 4,
  onTop: false,
  antialias: true,
  depthWrite: false,
  depthBias: 0,
  behind: false,
  alphaToCoverage: false,
  fog: true,
};

/** A `PointsMaterial`'s defaults for the style fields written as `point` + the field's name. */
const POINT_DEFAULTS = {
  shape: 'square',
  minPixelSize: 1,
  maxPixelSize: 256,
  edl: false,
  adaptiveSize: 0,
  alphaTest: 0,
  blending: 'normal',
  depthTest: true,
  depthWrite: null,
  fog: true,
};

/** The fields of `style` that differ from `defaults`, each named `prefix` + the field's name. */
function styleExtras(prefix: string, defaults: object, style: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, usual] of Object.entries(defaults)) {
    const value = (style as Record<string, unknown>)[name];
    if (value !== undefined && value !== usual) out[`${prefix}${name[0].toUpperCase()}${name.slice(1)}`] = value;
  }
  return out;
}

/**
 * What of a line's style differs from a `Line`'s defaults, as primitive extras (glTF 2.0 section 3.12; glTF holds no
 * join, cap, dash or draw order of a line): `lineJoin`, `lineCap`, `lineMiterLimit`, `lineDash` (dash and gap in world
 * units) with `lineDashOffset` and `lineDashCap`, `lineOnTop`, `lineAntialias`, `lineDepthWrite`, `lineDepthBias`,
 * `lineBehind`, `lineAlphaToCoverage` and `lineFog`. gltf/strokes reads them back.
 */
function lineStyle(style: PluginLineStyle): Record<string, unknown> {
  const out = styleExtras('line', LINE_DEFAULTS, style);
  if (style.dashed) {
    out.lineDash = [style.dashSize ?? 1, style.gapSize ?? 1];
    if (style.dashOffset) out.lineDashOffset = style.dashOffset;
    if (style.dashCap !== undefined && style.dashCap !== 'butt') out.lineDashCap = style.dashCap;
  }
  return out;
}

const white = new Float32Array([1, 1, 1]);

/** A batch's segments as a line list, its colours linear RGBA and left out when all are white. */
function batchPart(batch: PluginBatch): Part | null {
  const n = batch.count * 2;
  if (!n) return null;
  const floats = new Float32Array(batch.data, 0, n * 4),
    bytes = new Uint8Array(batch.data, 0, n * 16),
    positions = new Float32Array(n * 3),
    colors = new Float32Array(n * 4);
  let plain = true,
    translucent = false;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = floats[i * 4 + k];
    for (let k = 0; k < 4; k++) {
      const byte = bytes[i * 16 + 12 + k];
      colors[i * 4 + k] = k < 3 ? srgbToLinear(byte / 255) : byte / 255;
      if (byte < 255) plain = false;
      if (k === 3 && byte < 255) translucent = true;
    }
  }
  const data: GeometryData = { positions, indices: Uint32Array.from({ length: n }, (_, i) => i) };
  if (!plain) data.colors = colors;
  const units = batch.worldUnits ? 'world' : 'pixels';
  return {
    geometry: normalizeGeometry(data, 'lines'),
    material: pluginMaterial(batch.color, batch.opacity, true, translucent, {
      value: batch.width,
      units,
      kind: 'lines',
    }),
    // A batch's segments have square ends.
    extras: {
      lineWidth: batch.width,
      lineWidthUnits: units,
      ...lineStyle({ cap: 'square', onTop: batch.onTop, antialias: batch.antialias }),
    },
  };
}

/**
 * A point cloud's finite points as a point list, its colours linear RGBA (the cloud draws non-finite points nowhere).
 * glTF gives a point no size (glTF 2.0 section 3.9.7), so the cloud's diameter goes in the primitive's extras as
 * `pointSize` with `pointSizeUnits`.
 */
function cloudPart(cloud: PluginCloud): Part | null {
  const n = cloud.count,
    p = cloud.positions,
    kept: number[] = [],
    finite = (v: number) => Number.isFinite(Math.fround(v));
  for (let i = 0; i < n; i++) if (finite(p[i * 3]) && finite(p[i * 3 + 1]) && finite(p[i * 3 + 2])) kept.push(i);
  if (!kept.length) return null;
  // A dropped point's position is never read, but the accessor must stay finite: it takes the first kept point's.
  const positions = p.slice(0, n * 3);
  if (kept.length < n)
    for (let i = 0; i < n; i++)
      if (!finite(positions[i * 3]) || !finite(positions[i * 3 + 1]) || !finite(positions[i * 3 + 2]))
        positions.copyWithin(i * 3, kept[0] * 3, kept[0] * 3 + 3);
  const data: GeometryData = { positions, indices: kept },
    m = cloud.material;
  if (cloud.normals) data.normals = cloud.normals.subarray(0, n * 3);
  let translucent = false;
  if (cloud.colors && m.vertexColors) {
    const colors = new Float32Array(n * 4),
      floats = cloud.floatColors,
      decode = cloud.colorSpace === 'srgb' ? srgbToLinear : (c: number) => c;
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 4; k++) {
        const v = floats ? floats[i * 4 + k] : ((cloud.colors[i] >>> (k * 8)) & 255) / 255;
        colors[i * 4 + k] = k < 3 ? decode(v) : v;
        if (k === 3 && v < 1) translucent = true;
      }
    data.colors = colors;
  }
  const geometry = normalizeGeometry(data, 'points'),
    sizes = multipliers(cloud.sizes, n);
  if (sizes) geometry.widths = sizes;
  return {
    geometry,
    material: pluginMaterial(m.color, m.opacity, m.shading !== 'sphere', translucent, {
      value: m.size,
      units: m.sizeUnits,
      kind: 'points',
    }),
    // And the rest of its style, which glTF holds no field for (section 3.12): gltf/strokes reads it back.
    extras: { pointSize: m.size, pointSizeUnits: m.sizeUnits, ...styleExtras('point', POINT_DEFAULTS, m) },
  };
}

/** The first `n` of a per-point width multiplier array, or undefined when there is none or all are 1. */
function multipliers(values: unknown, n: number): Float32Array | undefined {
  if (!(values instanceof Float32Array) || values.length < n) return undefined;
  const out = values.slice(0, n);
  if (out.some((v) => !Number.isFinite(v) || v < 0))
    throw new RangeError('Width multipliers must be finite and non-negative');
  return out.every((v) => v === 1) ? undefined : out;
}

/** `geo` with an affine matrix applied to its positions and (by the cofactor matrix, sign kept) its normals. */
function bakeMatrix(geo: Geo, m: Float64Array): Geo {
  const positions = new Float32Array(geo.positions.length),
    normals = new Float32Array(geo.normals.length),
    c = [
      m[5] * m[10] - m[6] * m[9],
      m[6] * m[8] - m[4] * m[10],
      m[4] * m[9] - m[5] * m[8],
      m[2] * m[9] - m[1] * m[10],
      m[0] * m[10] - m[2] * m[8],
      m[1] * m[8] - m[0] * m[9],
      m[1] * m[6] - m[2] * m[5],
      m[2] * m[4] - m[0] * m[6],
      m[0] * m[5] - m[1] * m[4],
    ],
    sign = m[0] * c[0] + m[1] * c[1] + m[2] * c[2] < 0 ? -1 : 1;
  for (let i = 0; i < positions.length; i += 3) {
    const x = geo.positions[i],
      y = geo.positions[i + 1],
      z = geo.positions[i + 2];
    for (let r = 0; r < 3; r++) positions[i + r] = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
    const nx = geo.normals[i],
      ny = geo.normals[i + 1],
      nz = geo.normals[i + 2],
      out = [0, 1, 2].map((r) => sign * (c[r] * nx + c[3 + r] * ny + c[6 + r] * nz)),
      l = Math.hypot(out[0], out[1], out[2]);
    if (l > 0) for (let r = 0; r < 3; r++) normals[i + r] = out[r] / l;
  }
  return { ...geo, positions, normals };
}

/** Validates and normalizes geometry data. Normals and tangents become unit length, tangent w becomes +1 or -1. */
export function normalizeGeometry(data: Geometry | GeometryData, topology?: 'points' | 'lines'): Geo {
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
    // Omitted normals stay zero: a triangle vertex then takes its faces' normal below, a point or line keeps none.
    normals = data.normals === undefined ? new Float32Array(length) : floats(data.normals, length, 'Normals');
  let indices: Uint32Array;
  if (topology) indices = listIndices(data.indices, count, topology);
  else if (data.indices === undefined) {
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
    // A point or line has no face to take a normal from: an unset normal stays zero, and writers leave it out.
    if (topology) continue;
    fallback ??= faceNormals(positions, indices, count);
    const fx = fallback[i * 3],
      fy = fallback[i * 3 + 1],
      fz = fallback[i * 3 + 2],
      fl = Math.hypot(fx, fy, fz);
    normals.set(fl > 1e-12 ? [fx / fl, fy / fl, fz / fl] : [0, 0, 1], i * 3);
  }
  const geo: Geo = { positions, normals, indices, count, colorSize: 4 };
  if (topology) geo.topology = topology;
  if (data.faceSizes !== undefined) {
    if (topology) fail('faceSizes needs triangles');
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
  if (data.uvs2 !== undefined) geo.uvs2 = floats(data.uvs2, count * 2, 'UVs 2');
  if (data.uvs3 !== undefined) geo.uvs3 = floats(data.uvs3, count * 2, 'UVs 3');
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
  if (data.colors1 !== undefined) {
    const size = data.colors1?.length === count * 3 ? 3 : 4,
      colors = floats(data.colors1, count * size, 'Colors 1');
    if (colors.some((v) => v < 0 || v > 1)) throw new RangeError('Colors must be in [0, 1]');
    geo.colors1 = colors;
    geo.colors1Size = size;
  }
  if ((data.joints === undefined) !== (data.weights === undefined))
    fail('Joint indices and weights are required together');
  if ((data.joints1 === undefined) !== (data.weights1 === undefined))
    fail('Joint indices and weights are required together');
  if (data.joints1 !== undefined && data.joints === undefined)
    fail('joints1 and weights1 add to joints and weights; pass the first four influences in joints and weights');
  if (data.joints !== undefined) {
    const sets = data.joints1 === undefined ? 1 : 2,
      joints = new Uint16Array(count * 4 * sets),
      weights = new Float32Array(count * 4 * sets);
    for (let set = 0; set < sets; set++) {
      const given = set ? data.joints1 : data.joints;
      if (!isObject(given) || given!.length !== count * 4)
        fail(set ? 'joints1 needs four values per vertex' : 'Joints need four values per vertex');
      const values = floats(set ? data.weights1 : data.weights, count * 4, set ? 'Weights 1' : 'Weights');
      for (let i = 0; i < count * 4; i++) {
        const joint = given![i],
          at = (i >> 2) * 4 * sets + set * 4 + (i & 3);
        if (!Number.isInteger(joint) || joint < 0 || joint > 65535)
          throw new RangeError('Joint indices must be unsigned 16-bit integers');
        if (values[i] < 0) throw new RangeError('Skin weights must be nonnegative');
        joints[at] = joint;
        weights[at] = values[i];
      }
    }
    // Normalized over every influence of the vertex in double precision, then split back into sets of four.
    const width = 4 * sets;
    for (let i = 0; i < weights.length; i += width) {
      let sum = 0;
      for (let c = 0; c < width; c++) sum += weights[i + c];
      if (!(sum > 0)) throw new RangeError('Skin weights must have a positive sum');
      for (let c = 0; c < width; c++) weights[i + c] /= sum;
    }
    const split = (from: Uint16Array | Float32Array, set: number) => {
      const out = new (from.constructor as Uint16ArrayConstructor | Float32ArrayConstructor)(count * 4);
      for (let v = 0; v < count; v++) for (let c = 0; c < 4; c++) out[v * 4 + c] = from[v * width + set * 4 + c];
      return out;
    };
    geo.joints = sets === 1 ? joints : (split(joints, 0) as Uint16Array);
    geo.weights = sets === 1 ? weights : (split(weights, 0) as Float32Array);
    if (sets === 2) {
      geo.joints1 = split(joints, 1) as Uint16Array;
      geo.weights1 = split(weights, 1) as Float32Array;
    }
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

const isPNG = (image: Uint8Array): boolean =>
  image.length > 8 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
const isJPEG = (image: Uint8Array): boolean =>
  image.length > 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;

/** The glTF extensions that hold a texture's image, tried after its plain `source`. */
const IMAGE_EXTENSIONS = ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif', 'MSFT_texture_dds'] as const;
/** Images of a loaded model not yet a PNG or JPEG in memory, by `TextureData.image`: bytes held in WebP, KTX2, DDS or AVIF, or a file beside the model. */
const undecoded = new WeakMap<Uint8Array, Uint8Array | URL>();

/** @internal A validated texture, or undefined. */
export function checkTexture(texture: unknown, label: string): TextureData | undefined {
  if (texture === undefined) return undefined;
  if (!isObject(texture) || !(texture.image instanceof Uint8Array)) fail(`${label} needs an image Uint8Array`);
  const { image, mimeType, name } = texture as unknown as TextureData;
  if (name !== undefined && typeof name !== 'string') fail(`${label} name must be a string`);
  if (
    !undecoded.has(image) &&
    (mimeType === 'image/png' ? !isPNG(image) : mimeType === 'image/jpeg' ? !isJPEG(image) : true)
  )
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
  if (texture.texCoord !== undefined && ![0, 1, 2, 3].includes(texture.texCoord as number))
    throw new RangeError(`${label} texCoord must be 0, 1, 2 or 3`);
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

/** A texture slot's KHR_texture_transform, validated; it needs the slot's texture. */
function checkTransform(
  transform: TextureTransform | undefined,
  texture: TextureData | undefined,
  slot: string,
): TextureTransform | undefined {
  if (transform === undefined) return undefined;
  if (!texture || !isObject(transform) || Array.isArray(transform))
    fail(`${slot}Transform needs an object with offset/scale and a ${slot}`);
  const offset = floats(transform.offset, 2, 'Texture transform offset'),
    scale = floats(transform.scale, 2, 'Texture transform scale'),
    out: TextureTransform = { offset: [offset[0], offset[1]], scale: [scale[0], scale[1]] };
  if (transform.rotation !== undefined) {
    const rotation = transform.rotation;
    if (typeof rotation !== 'number' || !Number.isFinite(Math.fround(rotation)))
      throw new RangeError('Texture transform rotation must be a finite Float32 number of radians');
    out.rotation = rotation;
  }
  return out;
}

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
  if (typeof shininess !== 'number' || !(shininess >= 0 && shininess < Infinity))
    throw new RangeError('Material shininess must be finite and >= 0');
  const lit = shading !== 'standard';
  const baseColorTexture = checkTexture(m.baseColorTexture, 'baseColorTexture');
  const baseColorTextureTransform = checkTransform(m.baseColorTextureTransform, baseColorTexture, 'baseColorTexture'),
    metallicRoughnessTexture = checkTexture(m.metallicRoughnessTexture, 'metallicRoughnessTexture'),
    normalTexture = checkTexture(m.normalTexture, 'normalTexture'),
    occlusionTexture = checkTexture(m.occlusionTexture, 'occlusionTexture'),
    emissiveTexture = checkTexture(m.emissiveTexture, 'emissiveTexture');
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
    metallicRoughnessTexture,
    metallicRoughnessTextureTransform: checkTransform(
      m.metallicRoughnessTextureTransform,
      metallicRoughnessTexture,
      'metallicRoughnessTexture',
    ),
    normalTexture,
    normalTextureTransform: checkTransform(m.normalTextureTransform, normalTexture, 'normalTexture'),
    occlusionTexture,
    occlusionTextureTransform: checkTransform(m.occlusionTextureTransform, occlusionTexture, 'occlusionTexture'),
    emissiveTexture,
    emissiveTextureTransform: checkTransform(m.emissiveTextureTransform, emissiveTexture, 'emissiveTexture'),
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
  if (data.uvs2 !== undefined) perVertex += 8;
  if (data.uvs3 !== undefined) perVertex += 8;
  if (data.tangents !== undefined) perVertex += 16;
  if (data.colors !== undefined) perVertex += data.colors?.length === count * 3 ? 12 : 16;
  if (data.colors1 !== undefined) perVertex += data.colors1?.length === count * 3 ? 12 : 16;
  if (data.joints !== undefined) perVertex += 24;
  if (data.joints1 !== undefined) perVertex += 24;
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

/**
 * The matrix that turns a normal, as a column-major 3x3: the inverse transpose of the upper 3x3, or for a zero determinant
 * (a scale of 0 flattens the node) its cofactor matrix, which maps every normal onto the flattened axis or to zero
 * (Turkowski, "Properties of Surface-Normal Transformations", Graphics Gems, 1990). Callers normalize the result, and
 * {@link unitNormal} turns a zero one into +Y as the engine shades it.
 */
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
  const determinant = determinant3(m);
  if (!Number.isFinite(determinant)) throw new RangeError('Transform must be finite');
  // Cofactor matrix equals det * inverse transpose; at det 0 the cofactor matrix itself, as not mirrored.
  const det = determinant || 1;
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

/**
 * @internal Writes the unit of normal `v` into `out` at `at`, or world +Y when `v` is zero, as the engine shades a
 * normal a flattened (zero scale) matrix maps to zero.
 */
export function unitNormal(v: ArrayLike<number>, out: { [i: number]: number }, at: number): void {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!l) {
    out[at] = 0;
    out[at + 1] = 1;
    out[at + 2] = 0;
  } else for (let r = 0; r < 3; r++) out[at + r] = v[r] / l;
}

/**
 * Splits an affine matrix into translation, unit quaternion and scale (a zero column is a zero scale, as glTF 2.0
 * section 3.5.3 allows), or returns null when its nonzero columns are sheared or dependent.
 */
export function decompose(m: Float64Array): { t: number[]; r: number[]; s: number[] } | null {
  const trs = splitNodeMatrix(m, { tolerance: 1e-6 });
  return trs.ok ? { t: trs.position, r: unitQuaternion(trs.rotation), s: trs.scale } : null;
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
 * @internal What a format does with a loaded model's textures and material extensions: 'refuse' them, keep the 'shape'
 * and flat colors because the format has no place for more, or also keep the 'baseColor' texture, as the file holds it.
 */
export type LoadedModels = 'refuse' | 'shape' | 'baseColor';

/**
 * @internal Collects the exported node forest. `plan`, when given, receives the buffer bytes each new geometry's
 * vertex attributes and each new image will take, before the data is normalized, so a size limit can refuse early.
 * `loaded` says what a format does with a loaded model's textures and material extensions.
 */
export function collect(
  source: ExportSource,
  options: SceneOptions = {},
  plan?: (bytes: number) => void,
  loaded: LoadedModels = 'refuse',
  writes: readonly ('points' | 'lines')[] = [],
): Node[] {
  if (!isObject(options)) fail('Options must be an object');
  const onlyVisible = options.onlyVisible ?? true;
  if (typeof onlyVisible !== 'boolean') fail('onlyVisible must be boolean');
  if (options.onWarning !== undefined && typeof options.onWarning !== 'function') fail('onWarning must be a function');
  const warn = options.onWarning ?? ((warning: ExportWarning) => console.warn(warning.message));
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
  /**
   * A data primitive of `mode` (not 4) as its own normalized geometry: a point or line list, or a strip's or fan's
   * triangles. Its run is `indices`, else the geometry's own indices, else every vertex in order.
   */
  const listGeometry = (value: Geometry | GeometryData, mode: number, indices: unknown, at: number): Geo => {
    const given = (isCoreGeometry(value) && options.geometryData?.get(value)) || value;
    let data: GeometryData;
    if (isCoreGeometry(given)) {
      const count = given.vertices.length / 6;
      data = {
        positions: Float32Array.from({ length: count * 3 }, (_, i) => given.vertices[Math.floor(i / 3) * 6 + (i % 3)]),
        normals: Float32Array.from(
          { length: count * 3 },
          (_, i) => given.vertices[Math.floor(i / 3) * 6 + 3 + (i % 3)],
        ),
        indices: given.indices,
      };
    } else data = given;
    if (!isObject(data)) fail(`primitives[${at}] needs geometry`);
    plan?.(attributeBytes(data));
    const count = vertexCount(data),
      run = indices ?? data.indices;
    if (run !== undefined && (!isObject(run) || typeof (run as unknown as ArrayLike<number>).length !== 'number'))
      fail(`primitives[${at}] indices must be an array of vertex indices`);
    const list = listOfMode(
      mode,
      (run as ArrayLike<number> | undefined) ?? Uint32Array.from({ length: count }, (_, i) => i),
    );
    if (mode >= 5) {
      if (!list.length) throw new RangeError(`primitives[${at}] draws no triangle; a strip or fan needs 3 vertices`);
      return normalizeGeometry({ ...data, indices: list, faceSizes: undefined });
    }
    const topology = mode ? 'lines' : 'points';
    if (data.morphs?.length) fail(`primitives[${at}] is ${topology}; points and lines take no morph targets`);
    if (!list.length) throw new RangeError(`primitives[${at}] draws no ${topology}; give it vertices`);
    return normalizeGeometry({ ...data, indices: list, faceSizes: undefined }, topology);
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
  const pbrSkins = new Map<PBRSource, Map<number, SkinData>>(),
    pbrMaterials = new Map<unknown, Mat>(),
    pbrImages = new Map<unknown, TextureData>();
  /** The base color texture a loaded material's file names, with its bytes as the file holds them. */
  const baseColorOf = (source: PBRSource, index: number | undefined) => {
    const { doc } = source.asset,
      info = index === undefined ? undefined : doc.materials?.[index]?.pbrMetallicRoughness?.baseColorTexture;
    if (!info) return undefined;
    const definition = doc.textures?.[info.index],
      named = definition?.extensions as Record<string, { source?: number } | undefined> | undefined,
      held = [definition?.source, ...IMAGE_EXTENSIONS.map((name) => named?.[name]?.source)]
        .filter((at): at is number => at !== undefined)
        .map((at) => {
          const image = doc.images?.[at],
            data = /^data:[^;,]*;base64,(.*)$/s.exec(image?.uri ?? '');
          return {
            image,
            bytes:
              image?.bufferView !== undefined
                ? source.asset.view(image.bufferView)
                : data
                  ? Uint8Array.from(atob(data[1]), (c) => c.charCodeAt(0))
                  : undefined,
            file: image?.uri && !data && source.asset.baseURL ? new URL(image.uri, source.asset.baseURL) : undefined,
          };
        })
        .filter(({ bytes, file }) => bytes || file),
      // A PNG or JPEG needs no decoding, so a fallback image beats a compressed one.
      chosen = held.find(({ bytes }) => bytes && (isPNG(bytes) || isJPEG(bytes))) ?? held[0];
    if (!chosen)
      fail(
        'A base color texture here has no image the model can reach; pass textures: false for its shape and colors, or use exportModel (@margoengine/exporters/model)',
      );
    const { image, bytes, file } = chosen!;
    let texture = pbrImages.get(image);
    if (!texture) {
      const jpeg = bytes ? isJPEG(bytes) : image?.mimeType === 'image/jpeg' || /\.jpe?g$/i.test(image?.uri ?? '');
      texture = { image: bytes ?? new Uint8Array(0), mimeType: jpeg ? 'image/jpeg' : 'image/png', name: image?.name };
      if (!bytes || (!isPNG(bytes) && !jpeg)) undecoded.set(texture.image, bytes ?? file!);
      pbrImages.set(image, texture);
    }
    const transform = info.extensions?.KHR_texture_transform;
    return {
      texture,
      texCoord: transform?.texCoord ?? info.texCoord ?? 0,
      transform: transform && {
        offset: transform.offset ?? [0, 0],
        scale: transform.scale ?? [1, 1],
        rotation: transform.rotation ?? 0,
      },
    };
  };
  type PBRPart = PBRSource['primitives'][number];
  /** One gltf\/pbr primitive as normalized geometry and material; `topology` for a point or line list. */
  const pbrPart = (
    source: PBRSource,
    primitive: PBRPart,
    topology?: 'points' | 'lines',
  ): { geometry: Geo; material: Mat } => {
    {
      // A materials mesh (createMesh) draws its live Material's textures, which gltf/pbr's maps do not list.
      const owner = (source as { material?: Record<string, unknown> | readonly Record<string, unknown>[] }).material;
      const { vertices, indices, definition, material: mat } = primitive,
        count = vertices.length / 20,
        side = mat.side ?? (mat.settings[2] === 2 ? 'back' : mat.settings[2] ? 'double' : 'front');
      if (!Number.isInteger(count) || !count) fail('Invalid PBR primitive vertices');
      const live = materialSlots.some((k) => (Array.isArray(owner) ? owner[definition.material!] : owner)?.[k]);
      if (
        loaded === 'refuse' &&
        (mat.maps.some((map: unknown) => map) ||
          live ||
          mat.extension ||
          primitive.extension ||
          Object.keys(mat.extensions ?? {}).length)
      )
        fail(
          'PBR texture and material extension export is unsupported; export textured models with exportModel (@margoengine/exporters/model), whose GLB bytes exportUSDZ and exportAnimatedUSDZ also take, or as OBJ, STL or PLY',
        );
      if (loaded === 'baseColor' && live)
        fail(
          'A live Material has no image file to name; pass textures: false for its shape and colors, or use exportModel (@margoengine/exporters/model)',
        );
      const base = loaded === 'baseColor' ? baseColorOf(source, definition.material) : undefined;
      const attribute = (offset: number, width: number): Float32Array => {
        const out = new Float32Array(count * width);
        for (let i = 0; i < count; i++)
          for (let c = 0; c < width; c++) out[i * width + c] = vertices[i * 20 + offset + c];
        return out;
      };
      const attrs = definition.attributes ?? {},
        // A part of a split primitive reads the definition's per-vertex accessors through its vertexMap.
        perVertex = (id: number, type: string, width: number) =>
          vertexValues(source.asset.accessor(id, type), width, primitive.part?.vertexMap);
      // A point or line without NORMAL has none to keep (gltf/pbr's packed slot holds zeros or a placeholder).
      const data: GeometryData = {
        positions: attribute(0, 3),
        normals: topology && attrs.NORMAL === undefined ? new Float32Array(count * 3) : attribute(4, 3),
        indices,
      };
      if (attrs.TANGENT !== undefined) data.tangents = attribute(8, 4);
      if (attrs.TEXCOORD_0 !== undefined) data.uvs = attribute(12, 2);
      if (attrs.TEXCOORD_1 !== undefined) data.uvs1 = attribute(14, 2);
      if (owner) {
        // A materials mesh lists no attributes and holds its UVs v up, for flipY uploads; everything here is v down, as glTF is.
        const uvs = attribute(12, 2);
        if (uvs.some((v) => v)) {
          for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
          data.uvs = uvs;
        }
      }
      // One UV set is all a format that names image files has, so it holds the set the texture samples. The
      // interleaved vertices hold sets 0 and 1 only; a higher set is read from its own accessor. glTF 2.0
      // textureInfo.texCoord names TEXCOORD_<n>, which the primitive must have.
      if (base && base.texCoord !== 0) {
        const set = attrs[`TEXCOORD_${base.texCoord}`];
        if (set === undefined)
          fail(
            `A base color texture samples TEXCOORD_${base.texCoord}, which its primitive does not have; add that UV set or set texCoord to one the primitive has`,
          );
        data.uvs = base.texCoord === 1 ? data.uvs1 : perVertex(set, 'VEC2', 2).slice();
      }
      if (attrs.COLOR_0 !== undefined) data.colors = attribute(16, 4);
      for (const name of Object.keys(attrs))
        if (/^(JOINTS|WEIGHTS)_([2-9]|dd)/.test(name))
          fail('Export supports at most eight skin influences per vertex; keep JOINTS_0 and JOINTS_1');
      if (attrs.JOINTS_0 !== undefined) data.joints = perVertex(attrs.JOINTS_0, 'VEC4', 4);
      if (attrs.WEIGHTS_0 !== undefined) data.weights = perVertex(attrs.WEIGHTS_0, 'VEC4', 4);
      if (attrs.JOINTS_1 !== undefined) data.joints1 = perVertex(attrs.JOINTS_1, 'VEC4', 4);
      if (attrs.WEIGHTS_1 !== undefined) data.weights1 = perVertex(attrs.WEIGHTS_1, 'VEC4', 4);
      if (definition.targets?.length)
        data.morphs = definition.targets.map((target: Record<string, number>, i: number) => ({
          name: primitive.targetNames[i],
          positions:
            target.POSITION === undefined ? new Float32Array(count * 3) : perVertex(target.POSITION, 'VEC3', 3),
          normals: target.NORMAL === undefined ? undefined : perVertex(target.NORMAL, 'VEC3', 3),
          tangents: target.TANGENT === undefined ? undefined : perVertex(target.TANGENT, 'VEC3', 3),
        }));
      const geometry = normalizeGeometry(data, topology);
      // A point's or line's per-vertex width multipliers, as @margoengine/lines and @margoengine/points write them.
      if (topology && attrs._WIDTH !== undefined) geometry.widths = perVertex(attrs._WIDTH, 'SCALAR', 1).slice();
      if (side === 'back' && !topology) {
        // normalizeGeometry owns these arrays, so the source's shared front-side geometry remains untouched.
        for (let i = 0; i < geometry.indices.length; i += 3)
          [geometry.indices[i + 1], geometry.indices[i + 2]] = [geometry.indices[i + 2], geometry.indices[i + 1]];
        for (let i = 0; i < geometry.normals.length; i++)
          geometry.normals[i] = geometry.normals[i] ? -geometry.normals[i] : 0;
        for (const morph of geometry.morphs ?? [])
          if (morph.normals)
            for (let i = 0; i < morph.normals.length; i++) morph.normals[i] = morph.normals[i] ? -morph.normals[i] : 0;
      }
      let material = pbrMaterials.get(mat);
      if (!material) {
        material = normalizeMaterial({
          name: mat.name,
          color: mat.base,
          roughness: mat.factors[0],
          metalness: mat.factors[1],
          emissive: mat.emission,
          doubleSided: side === 'double',
          alphaMode: (mat.alphaMode as MaterialData['alphaMode']) ?? 'OPAQUE',
          alphaCutoff: mat.alphaMode === 'MASK' ? mat.settings[1] : undefined,
          baseColorTexture: base?.texture,
          baseColorTextureTransform: base?.transform,
        });
        pbrMaterials.set(mat, material);
      }
      return { geometry, material };
    }
  };
  const pbr = (triangles: Extract<ReturnType<typeof meshTriangles>, { kind: 'pbr' }>, node: Node): void => {
    const { model: source, primitives } = triangles.source;
    if (!primitives.length) return;
    node.primitives = primitives.map((primitive) => pbrPart(source, primitive));
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

  // A loaded model has nodes too, so without this it fails later with an error about a node's transform.
  if (isObject(source) && 'asset' in source && 'primitives' in source)
    fail('A loaded model is not a scene: pass the engine it was added to, or use exportModel for its own file');
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
    // @margoengine/lines and @margoengine/points draw through plugins, not meshes: their lines, line batches and clouds
    // are read by public fields, without importing either package, and go with the mesh they follow or as nodes of their
    // own.
    const plugged = new Map<Mesh | null, PluginItem[]>();
    for (const plugin of (source as { plugins?: ReadonlyMap<string, unknown> }).plugins?.values() ?? [])
      for (const item of pluginItems(plugin)) {
        if (onlyVisible && !item.visible) continue;
        let list = plugged.get(item.mesh);
        if (!list) plugged.set(item.mesh, (list = []));
        list.push(item);
      }
    // A splat cloud of @margoengine/splats is a plugin of its own, and no scene writer holds one.
    if (options.root === undefined)
      for (const [name, plugin] of (source as { plugins?: ReadonlyMap<string, unknown> }).plugins ?? [])
        if (/^splats:\d+$/.test(name))
          warn({
            code: 'unsupported',
            message: `Splat cloud "${name}" left out: scene writers do not hold splats; write its data with exportGaussianGLB (@margoengine/exporters/splats)`,
            node: null,
            item: plugin as object,
          });
    const formOf = `this format writes ${[...writes, 'triangles'].join(' and ')} only`,
      pluginPart = (item: PluginItem): Part | null => {
        plan?.(item.bytes);
        return item.part();
      };
    const takePlugged = (items: readonly PluginItem[] | undefined, node: Node, handle: Mesh): void => {
      let left = 0;
      for (const item of items ?? []) {
        if (!writes.includes(item.topology)) left++;
        else {
          const part = pluginPart(item);
          if (part) (node.lines ??= []).push(part);
        }
      }
      if (left)
        warn({
          code: 'unsupported',
          message: `Mesh "${node.name ?? ''}": ${left} plugin lines or point clouds left out; ${formOf}`,
          node: handle,
        });
    };
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
      // gltf/pbr marks each node it creates with its model; points and lines stay out of the triangle source.
      const model = (handle as unknown as Record<symbol, PBRSource | undefined>)[pbrModelKey],
        parts = model?.pointsAndLines?.filter((p) => p.node === (handle as unknown)) ?? [];
      let left = 0;
      for (const part of parts) {
        const topology = part.topology === 'point-list' ? 'points' : 'lines';
        // The width the file gave (primitive extras `lineWidth` or `pointSize`) goes back with it.
        if (writes.includes(topology))
          (node.lines ??= []).push({
            ...pbrPart(model!, part, topology),
            ...(isObject(part.definition.extras) ? { extras: part.definition.extras as Extras } : {}),
          });
        else left++;
      }
      if (left)
        warn({
          code: 'unsupported',
          message: `Mesh "${mesh.name ?? ''}": ${left} point or line primitives left out; this format writes ${[...writes, 'triangles'].join(' and ')} only, use exportModel (@margoengine/exporters/model) to keep them`,
          node: handle,
        });
      takePlugged(plugged.get(handle), node, handle);
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
    // A line or cloud that follows no mesh is a node of its own at its matrix, in a whole-scene export.
    if (options.root === undefined)
      for (const item of plugged.get(null) ?? []) {
        if (!writes.includes(item.topology)) {
          warn({
            code: 'unsupported',
            message: `A plugin ${item.topology === 'lines' ? 'line' : 'point cloud'} left out; ${formOf}`,
            node: null,
            item: item.object,
          });
          continue;
        }
        const part = pluginPart(item);
        if (!part) continue;
        const m = Float64Array.from(item.matrix),
          parts = decompose(m),
          node = parts
            ? makeNode(item.name, parts.t, parts.r, parts.s, null)
            : makeNode(item.name, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1], null);
        // A sheared matrix has no TRS: its points (and normals) are placed in world space under an identity node.
        if (!parts) part.geometry = bakeMatrix(part.geometry, m);
        node.lines = [part];
        collected.push(node);
      }
    if (collected.length && !drawables(collected, writes.length > 0).length)
      fail('Engine export has no supported mesh geometry');
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
      if (!parts) throw new RangeError('Matrix must split into translation, rotation and scale; glTF forbids shear');
      node = makeNode(data.name, parts.t, parts.r, parts.s, parent);
      node.local = m;
      node.world = parent ? multiplyMatrices(parent, m) : m;
      // A zero column (a zero scale) is written as its translation, rotation and scale: the glTF validator reads such a
      // matrix as not decomposable to TRS (NODE_MATRIX_NON_TRS), while the same node as TRS is valid.
      if (!parts.s.includes(0)) node.matrix = values;
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
      const triangles: NonNullable<Node['primitives']> = [];
      let left = 0;
      data.primitives.forEach((primitive: ExportPrimitive, i: number) => {
        if (!isObject(primitive) || primitive.geometry === undefined) fail(`primitives[${i}] needs geometry`);
        const mode = primitive.mode === undefined ? 4 : modeNumber(primitive.mode),
          mat = primitive.material === undefined ? undefined : material(primitive.material);
        if (mode === 4) {
          let geo = geometry(primitive.geometry);
          if (primitive.indices !== undefined)
            geo = {
              ...geo,
              indices: triangleIndices(primitive.indices, geo.count, `primitives[${i}] indices`),
              faceSizes: undefined,
              base: geo,
            };
          triangles.push({ geometry: geo, material: mat, extras: primitive.extras });
          return;
        }
        const topology = mode === 0 ? 'points' : mode < 4 ? 'lines' : undefined;
        if (topology && !writes.includes(topology)) {
          left++;
          return;
        }
        const geo = listGeometry(primitive.geometry, mode, primitive.indices, i);
        if (topology) (node.lines ??= []).push({ geometry: geo, material: mat, extras: primitive.extras });
        else triangles.push({ geometry: geo, material: mat, extras: primitive.extras });
      });
      if (left)
        warn({
          code: 'unsupported',
          message: `Node "${data.name ?? ''}": ${left} point or line primitives left out; this format writes ${[...writes, 'triangles'].join(' and ')} only`,
          node: data,
        });
      if (triangles.length) {
        const targets = triangles[0].geometry.morphs?.length ?? 0;
        if (triangles.some((primitive) => (primitive.geometry.morphs?.length ?? 0) !== targets))
          fail('Every primitive of a mesh needs the same number of morph targets');
        node.primitives = triangles;
        node.geometry = triangles[0].geometry;
        node.material = triangles[0].material;
      }
      if (triangles.length || node.lines) node.primitivesKey = data.primitives;
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
export function textureFiles(prefix: unknown): {
  files: Map<string, Uint8Array>;
  held: Map<string, Uint8Array | URL>;
  name(texture: TextureData): string;
} {
  if (typeof prefix !== 'string' || !/^[\w./-]*$/.test(prefix))
    throw new TypeError('texturePrefix may hold only letters, digits, _ . - and /');
  const files = new Map<string, Uint8Array>(),
    held = new Map<string, Uint8Array | URL>(),
    names = new Map<Uint8Array, string>();
  return {
    files,
    held,
    name(texture) {
      let name = names.get(texture.image);
      if (name === undefined) {
        const base =
            prefix +
            ((texture.name ?? '').replace(/\.(png|jpe?g)$/i, '').replace(/[^\w.-]+/g, '_') || `texture_${names.size}`),
          ext = texture.mimeType === 'image/png' ? '.png' : '.jpg';
        name = base + ext;
        for (let n = 2; files.has(name) || held.has(name); n++) name = `${base}_${n}${ext}`;
        names.set(texture.image, name);
        const waiting = undecoded.get(texture.image);
        if (waiting) held.set(name, waiting);
        else files.set(name, texture.image);
      }
      return name;
    },
  };
}

/** @internal Whether an `upAxis` option turns a Y-up scene onto a format's Z-up axes. */
export function turnsToZUp(upAxis: unknown, format: string): boolean {
  if (upAxis !== undefined && upAxis !== 'y' && upAxis !== 'z')
    throw new RangeError(`${format} upAxis must be 'y' or 'z'`);
  return upAxis !== 'z';
}

/** @internal A quarter turn about X that stands Y-up vectors on Z up: a turn, so triangles keep their winding. */
export function standZUp(values: Float64Array): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 3) {
    out[i] = values[i];
    out[i + 1] = -values[i + 2];
    out[i + 2] = values[i + 1];
  }
  return out;
}

/**
 * @internal A line list's segments joined into polylines, in order: a segment that starts where the previous one
 * ended extends it, so a strip comes back as one polyline and a loop as one that ends on its first vertex.
 */
export function polylines(indices: Uint32Array): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 1 < indices.length; i += 2) {
    const last = out[out.length - 1];
    if (last && last[last.length - 1] === indices[i]) last.push(indices[i + 1]);
    else out.push([indices[i], indices[i + 1]]);
  }
  return out;
}

/** @internal A drawable with its world transform, in depth-first order. */
export interface Drawable {
  name?: string;
  /** The data node or engine mesh it came from. */
  source?: Mesh | ExportNode;
  geometry: Geo;
  material?: Mat;
  world: Float64Array;
}

/** A [0, 0, 0] scale: the node and its descendants are hidden. */
const collapsed = (s: readonly number[]): boolean => s.every((v) => v === 0);

/**
 * @internal What the nodes draw, depth first. With `lines`, each node's points and lines follow its triangles, their
 * geometry's `topology` set; writers without a point or line form leave it false.
 */
export function drawables(nodes: Node[], lines = false): Drawable[] {
  const out: Drawable[] = [],
    shape = shaper(nodes);
  const walk = (node: Node) => {
    if (collapsed(node.s)) return;
    if (node.primitives)
      for (const primitive of node.primitives)
        out.push({
          name: node.name,
          source: node.source,
          geometry: shape(node, primitive.geometry),
          material: primitive.material,
          world: node.world,
        });
    else if (node.geometry)
      out.push({
        name: node.name,
        source: node.source,
        geometry: shape(node, node.geometry),
        material: node.material,
        world: node.world,
      });
    if (lines)
      for (const part of node.lines ?? [])
        out.push({ name: node.name, geometry: shape(node, part.geometry), material: part.material, world: node.world });
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/** Inverse of an affine column-major matrix, or null when it has none. */
function invertAffine(m: Float64Array): Float64Array | null {
  const c0 = m[5] * m[10] - m[6] * m[9],
    c1 = m[2] * m[9] - m[1] * m[10],
    c2 = m[1] * m[6] - m[2] * m[5],
    determinant = m[0] * c0 + m[4] * c1 + m[8] * c2;
  if (!determinant || !Number.isFinite(determinant)) return null;
  const k = 1 / determinant,
    o = new Float64Array(16);
  o[0] = c0 * k;
  o[1] = c1 * k;
  o[2] = c2 * k;
  o[4] = (m[6] * m[8] - m[4] * m[10]) * k;
  o[5] = (m[0] * m[10] - m[2] * m[8]) * k;
  o[6] = (m[2] * m[4] - m[0] * m[6]) * k;
  o[8] = (m[4] * m[9] - m[5] * m[8]) * k;
  o[9] = (m[1] * m[8] - m[0] * m[9]) * k;
  o[10] = (m[0] * m[5] - m[1] * m[4]) * k;
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14]);
  o[15] = 1;
  return o;
}

/**
 * @internal For formats with no skeleton or morph targets: gives the geometry a node shows at its nodes' current pose, in the
 * node's own space so that `node.world` still places it. Morphs apply first, then the skin, as in glTF, where a skinned mesh's
 * own node does not place it. Geometry with neither comes back as it is.
 */
export function shaper(roots: Node[]): (node: Node, geometry: Geo) => Geo {
  const bySource = new Map<ExportNode, Node>(),
    index = (node: Node): void => {
      if (node.source) bySource.set(node.source, node);
      node.children.forEach(index);
    };
  roots.forEach(index);
  return (node, geometry) => {
    const weights = node.morphWeights,
      morphs = weights?.some((w) => w) ? geometry.morphs : undefined,
      skin = node.skin && geometry.joints && geometry.weights ? node.skin : undefined;
    if (!morphs && !skin) return geometry;
    const { count } = geometry,
      positions = Float64Array.from(geometry.positions),
      normals = Float64Array.from(geometry.normals);
    morphs?.forEach((morph, m) => {
      const w = weights![m];
      if (!w) return;
      for (let i = 0; i < count * 3; i++) {
        positions[i] += w * morph.positions[i];
        if (morph.normals) normals[i] += w * morph.normals[i];
      }
    });
    let indices = geometry.indices;
    if (skin) {
      const toNode = invertAffine(node.world);
      if (!toNode) fail('A skinned node needs an invertible transform');
      // joint world * inverse bind, taken back into the node's own space.
      const palette = skin.joints.map((joint, j) => {
        const target = bySource.get(joint);
        if (!target) fail('Every skin joint must be exported; pass onlyVisible: false to keep hidden joints');
        const bind = Float64Array.from({ length: 16 }, (_, i) => skin.inverseBindMatrices[j * 16 + i]);
        return multiplyMatrices(toNode!, multiplyMatrices(target!.world, bind));
      });
      const m = new Float64Array(16),
        flip = new Uint8Array(count);
      const sets: [Uint16Array, Float32Array][] = [[geometry.joints!, geometry.weights!]];
      if (geometry.joints1 && geometry.weights1) sets.push([geometry.joints1, geometry.weights1]);
      for (let v = 0; v < count; v++) {
        let total = 0;
        for (const [, weights] of sets) for (let k = 0; k < 4; k++) total += weights[v * 4 + k];
        if (!total) continue;
        m.fill(0);
        for (let k = 0; k < 4 * sets.length; k++) {
          const [joints, weights] = sets[k >> 2],
            w = weights[v * 4 + (k & 3)] / total;
          if (!w) continue;
          const joint = palette[joints[v * 4 + (k & 3)]];
          if (!joint)
            throw new RangeError('Joint index exceeds skin joints; keep joint indices below the skin joint count');
          for (let i = 0; i < 16; i++) m[i] += w * joint[i];
        }
        const x = positions[v * 3],
          y = positions[v * 3 + 1],
          z = positions[v * 3 + 2],
          nx = normals[v * 3],
          ny = normals[v * 3 + 1],
          nz = normals[v * 3 + 2],
          determinant = determinant3(m),
          // A bone scaled to zero hides its part: its vertices collapse as they do when drawn, and keep the normal they had.
          n = determinant ? normalMatrix(m) : null;
        for (let r = 0; r < 3; r++) {
          positions[v * 3 + r] = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
          if (n) normals[v * 3 + r] = n[r] * nx + n[3 + r] * ny + n[6 + r] * nz;
        }
        flip[v] = determinant < 0 ? 1 : 0;
      }
      if (!geometry.topology && flip.some((f) => f)) {
        indices = indices.slice();
        for (let i = 0; i < indices.length; i += 3)
          if (flip[indices[i]]) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
      }
    }
    for (let v = 0; v < count; v++) {
      const l = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]) || 1;
      for (let r = 0; r < 3; r++) normals[v * 3 + r] /= l;
    }
    return {
      ...geometry,
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      indices,
      joints: undefined,
      weights: undefined,
      joints1: undefined,
      weights1: undefined,
      morphs: undefined,
      base: undefined,
    };
  };
}

/** @internal World-space vertices, unit normals and winding-corrected indices of one drawable. */
export function toWorld(
  { geometry, world }: Drawable,
  includeNormals = true,
): {
  positions: Float64Array;
  normals: Float64Array;
  indices: Uint32Array;
} {
  const { count } = geometry,
    positions = new Float64Array(count * 3),
    normals = new Float64Array(includeNormals ? count * 3 : 0),
    n = includeNormals ? normalMatrix(world) : undefined;
  for (let i = 0; i < count; i++) {
    const x = geometry.positions[i * 3],
      y = geometry.positions[i * 3 + 1],
      z = geometry.positions[i * 3 + 2];
    for (let r = 0; r < 3; r++)
      positions[i * 3 + r] = world[r] * x + world[4 + r] * y + world[8 + r] * z + world[12 + r];
    if (n) {
      const nx = geometry.normals[i * 3],
        ny = geometry.normals[i * 3 + 1],
        nz = geometry.normals[i * 3 + 2];
      unitNormal(
        [n[0] * nx + n[3] * ny + n[6] * nz, n[1] * nx + n[4] * ny + n[7] * nz, n[2] * nx + n[5] * ny + n[8] * nz],
        normals,
        i * 3,
      );
    }
  }
  let indices = geometry.indices;
  if (!geometry.topology && determinant3(world) < 0) {
    indices = indices.slice();
    for (let i = 0; i < indices.length; i += 3) {
      const b = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = b;
    }
  }
  return { positions, normals, indices };
}

export { num };

export const toSrgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
export const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

/** @internal Replaces whitespace so a name survives line-based formats. */
export const token = (name: string | undefined, fallback: string): string =>
  (name ?? '').replace(/[\s#]+/g, '_') || fallback;
