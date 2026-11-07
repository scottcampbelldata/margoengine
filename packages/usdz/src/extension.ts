import type { GLTFDocument, GLTFMaterial } from '../../shared/gltf.js';
import type { Specs } from './crate.js';

/**
 * An optional part of the USD import, from an entry of this package, passed in `USDOptions.extensions`. It stays out of
 * the bundle of an app that does not import it.
 */
export interface USDExtension {
  /** The entry's name, which is how a worker finds its own copy. */
  readonly name: string;
}
/** Something a reader could not use. The file still opens; `USDAsset.issues` lists these. */
export interface USDIssue {
  /** What went wrong, such as `missing-layer`, `missing-default-prim`, `cycle` or `unsupported-layer`. */
  code: string;
  message: string;
}
/** What the composing hook gets: the root layer, what the archive holds, and the limits. */
export interface LayerRead {
  id: string;
  data: Uint8Array;
  entries: Map<string, Uint8Array>;
  maxBytes: number;
  maxDepth: number;
  issues: USDIssue[];
  signal?: AbortSignal;
  /** Reads a file that is not a USD layer, through the extensions that know one. */
  foreign?(read: ForeignLayer): Specs | undefined;
}
/** An authored mesh, as the shape hook gets it. */
export interface MeshRead {
  specs: Specs;
  path: string;
  points: ArrayLike<number>;
  counts: ArrayLike<number>;
  faces: ArrayLike<number>;
  /** True for a left-handed mesh. */
  flip: boolean;
  maxTriangles: number;
  /** An attribute of this mesh, at the stage's first time. */
  value(name: string): unknown;
  /** An attribute of any prim. */
  attr(path: string, name: string): unknown;
  soft(message: string): void;
}
/** A mesh's new faces. Streams of the authored mesh reach them through `corners`. */
export interface MeshShape {
  points: Float32Array;
  counts: Uint32Array;
  faces: Uint32Array;
  /** The authored face behind each face, in rising order. */
  face: Uint32Array;
  /** Normals per corner. Without them, authored normals come through `corners`. */
  normals?: Float32Array;
  /** A stream per authored point, per new point. Absent when the points did not change. */
  spread?(stream: ArrayLike<number>, width: number): Float32Array;
  /** Joint influences per authored point, per new point, `width` to a point. */
  influences?(joints: Uint16Array, weights: Float32Array, width: number): { joints: Uint16Array; weights: Float32Array };
  /** An authored stream as one value per corner of the new faces. */
  corners(stream: ArrayLike<number>, width: number, indices: ArrayLike<number> | undefined, interpolation: string | undefined): Float32Array;
}
/** A mesh of the scene, as the scene hook gets it. */
export interface SceneMesh {
  /** Prim path. */
  path: string;
  /** Index of its node in the document. */
  node: number;
  /** Index of its mesh in the document. */
  mesh: number;
  /** The point behind each expanded vertex. */
  vertexOf: Uint32Array;
  /** Set when an extension changed the mesh's faces. */
  shape?: MeshShape;
}
/** What the scene hook gets once every prim has its node. */
export interface SceneRead {
  specs: Specs;
  document: GLTFDocument;
  /** Node index by prim path. */
  nodes: Map<string, number>;
  meshes: SceneMesh[];
  /** Adds a buffer and an accessor over it, and returns the accessor's index. */
  accessor(data: Float32Array | Uint32Array | Uint16Array | Uint8Array, type: string): number;
  /** The ops of a prim's xformOpOrder that place it, when it authors one: what comes after its last reset. */
  opOrder(path: string): string[] | undefined;
  /** A prim's local matrix from its ordered ops, with `get` reading each op's value. */
  transform(path: string, get: (name: string) => unknown): number[];
  /** Prims that reset the transform stack. Their nodes hang from the stage's node, not their parent's. */
  detached: ReadonlySet<string>;
  /** Lists something that could not be used; the file still opens. */
  soft(message: string): void;
}
/** A file of a stage that is not a USD layer, as the layer hook gets it. */
export interface ForeignLayer {
  id: string;
  data: Uint8Array;
  /** Another file, by id, when it is there. */
  file(id: string): Uint8Array | undefined;
  issues: USDIssue[];
}
/** How a texture is sampled. */
export interface USDImagePlacement {
  /** As KHR_texture_transform, on the document's uvs. */
  transform?: { offset: [number, number]; rotation: number; scale: [number, number] };
  wrapS: number;
  wrapT: number;
}
/** An image of the document: one file, or two packed as a glTF metal and rough texture. */
export interface USDImage {
  path?: string;
  /** The file's colours are linear, where a base colour texture is read as sRGB. */
  linearColor?: boolean;
  roughness?: { path: string; channel: number };
  metallic?: { path: string; channel: number };
  roughnessValue?: number;
  metallicValue?: number;
}
/** A bound material, as the surface hook gets it. */
export interface SurfaceRead {
  specs: Specs;
  document: GLTFDocument;
  /** The Material prim. */
  path: string;
  /** A property of a prim, at the stage's first time. */
  attr(path: string, name: string): unknown;
  /** What feeds a property, through any interface on the way. */
  connection(path: string, name: string): string | undefined;
  /** True when the file can be read. */
  has(file: string): boolean;
  /** Adds a texture and gives its glTF texture info. */
  image(source: USDImage, where: USDImagePlacement): { index: number; extensions?: Record<string, unknown>; scale?: number };
  soft(message: string): void;
}
/** A material the surface hook made. */
export interface USDSurface {
  material: GLTFMaterial;
  /** The primvar its textures read. */
  uv?: string;
  /** Kept on the material's `extras.materialX`. */
  network?: unknown;
}
/** What an extension does: each hook runs at its step of the import. */
export interface ExtensionHooks extends USDExtension {
  /** Turns the root layer into one flat spec map, in place of reading it as a single static layer. */
  compose?(read: LayerRead): Specs;
  /** The specs of a file that is not a USD layer, or nothing when it is not this extension's. */
  layer?(read: ForeignLayer): Specs | undefined;
  /** A glTF material for a bound Material, or nothing to read it as UsdPreviewSurface. */
  surface?(read: SurfaceRead): USDSurface | undefined;
  /** New faces for a mesh, or nothing to keep its own. */
  shape?(read: MeshRead): MeshShape | undefined;
  /** Adds to the finished scene: skins, clips and the like. */
  scene?(read: SceneRead): void;
  /** Keeps a prim that starts invisible but has a visible sample later, so this extension can show it then. */
  showsLater?: boolean;
}
