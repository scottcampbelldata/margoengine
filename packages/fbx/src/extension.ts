import type { FBXImportLimits } from './limits.js';
import type { MaterialData, TextureData } from '@margoengine/exporters';
import type { Curve, LayerRead, StackTracks } from './animation.js';
import type { MeshBinding } from './scene.js';
import type { ParseBudget, FBXNode } from './document.js';
import type { SceneContext } from './scene.js';

/**
 * An optional part of the FBX import, from an entry of this package, passed in `FBXOptions.extensions`. It stays out of
 * the bundle of an app that does not import it.
 */
export interface FBXExtension {
  /** The entry's name, which is how a worker finds its own copy. */
  readonly name: string;
  /** Optional per-import resource caps from the large entry. Default ordinary import caps. */
  readonly limits?: Readonly<Partial<FBXImportLimits>>;
}

/** One material as the base reader left it, for an entry to finish. */
export interface MaterialRead {
  source: FBXNode;
  out: MaterialData;
  /** Every texture and layered texture on the material, by the property it drives. */
  links: readonly { property: string; node: FBXNode }[];
  /** Properties the base reader took. */
  handled: ReadonlySet<string>;
  /** Loads a texture object; nothing when its image is missing or unreadable, which the material then records. */
  texture(node: FBXNode): Promise<TextureData | undefined>;
  /** The objects connected under one. */
  children(node: FBXNode): FBXNode[];
}

/** A skin after its joints and weights are on the mesh. */
export interface SkinRead {
  source: FBXNode;
  mesh: MeshBinding;
  cpCount: number;
}

/** What an extension does: each hook runs at its step of the conversion. */
export interface ExtensionHooks extends FBXExtension {
  /** Normalize an older document before object indexing. */
  document?(roots: FBXNode[], version: number, budget: ParseBudget): void;
  /** Lowest binary version this entry can normalize. Default 7100. */
  minimumVersion?: number;
  /** After the node tree is built. True when it added something worth a file with no mesh. */
  scene?(ctx: SceneContext): boolean | void;
  /** Takes the skins and clusters the base reader refuses, and records what glTF has no place for. */
  skinned?(read: SkinRead): void;
  /** The shapes of a progressive channel with the percent of each, lowest first. */
  inbetweens?(channel: FBXNode, sources: readonly FBXNode[]): { shape: FBXNode; percent: number }[];
  /** The weight of the shape at `percent` when a channel with these stops stands at `value`. */
  inbetweenWeight?(stops: readonly number[], percent: number, value: number): number;
  /** Finishes a material after the base reader. */
  material?(read: MaterialRead): Promise<void>;
  /** Makes PNG bytes of an image in another format; nothing when it cannot. */
  image?(bytes: Uint8Array): Promise<Uint8Array | undefined>;
  /** Reads one animation curve of any kind, in place of the linear and step reader. */
  curve?(node: FBXNode, times: number[], values: ArrayLike<number>): Curve;
  /** Turns a stack's layers into one set of tracks, in place of the single layer reader. */
  blend?(ctx: SceneContext, layers: readonly FBXNode[], read: LayerRead): StackTracks;
}
