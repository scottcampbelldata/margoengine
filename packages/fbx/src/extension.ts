import type { SceneContext } from './scene.js';

/**
 * An optional part of the FBX import, from an entry of this package, passed in `FBXOptions.extensions`. It stays out of
 * the bundle of an app that does not import it.
 */
export interface FBXExtension {
  /** The entry's name, which is how a worker finds its own copy. */
  readonly name: string;
}

/** What an extension does: each hook runs at its step of the conversion. */
export interface ExtensionHooks extends FBXExtension {
  /** After the node tree is built. True when it added something worth a file with no mesh. */
  scene?(ctx: SceneContext): boolean | void;
}
