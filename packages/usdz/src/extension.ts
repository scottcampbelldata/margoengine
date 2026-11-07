import type { GLTFDocument } from '../../shared/gltf.js';
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
}
/** A mesh of the scene, as the scene hook gets it. */
export interface SceneMesh {
  /** Prim path. */
  path: string;
  /** Index of its node in the document. */
  node: number;
  /** Index of its mesh in the document. */
  mesh: number;
  /** The authored point behind each expanded vertex. */
  vertexOf: Uint32Array;
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
  /** A prim's xformOpOrder, when it authors one. */
  opOrder(path: string): string[] | undefined;
  /** A prim's local matrix from its ordered ops, with `get` reading each op's value. */
  transform(path: string, get: (name: string) => unknown): number[];
  /** Lists something that could not be used; the file still opens. */
  soft(message: string): void;
}
/** What an extension does: each hook runs at its step of the import. */
export interface ExtensionHooks extends USDExtension {
  /** Turns the root layer into one flat spec map, in place of reading it as a single static layer. */
  compose?(read: LayerRead): Specs;
  /** Adds to the finished scene: skins, clips and the like. */
  scene?(read: SceneRead): void;
  /** Keeps a prim that starts invisible but has a visible sample later, so this extension can show it then. */
  showsLater?: boolean;
}
