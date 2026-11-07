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
/** What an extension does: each hook runs at its step of the import. */
export interface ExtensionHooks extends USDExtension {
  /** Turns the root layer into one flat spec map, in place of reading it as a single static layer. */
  compose?(read: LayerRead): Specs;
}
