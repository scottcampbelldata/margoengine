// Reference counts, preload groups and templates on top of the asset registry: `AssetPool` is an `AssetRegistry` that
// also counts who holds a key (`acquire`/`release`), preloads named groups through an `AssetQueue` and builds
// templates (a prototype mesh tree made once, copied per instance). Kept apart from `scene/assets` so a registry that
// only defines, loads and swaps keys does not pay for them.
import { fault, typeError } from '../../shared/errors.js';
import type { Mesh, PbrMaterial } from '@margoengine/core';
import { AssetQueue, AssetRegistry } from './assets.js';
import type { AssetQueueOptions, AssetQueueProgress, AssetQueueResult } from './assets.js';

// The base entry's types, so code that uses a pool needs one import line (types only: no bytes).
export type {
  AssetMapEntry,
  AssetMapOptions,
  AssetQueueOptions,
  AssetQueueProgress,
  AssetQueueResult,
  AssetRegistryOptions,
  AssetSlot,
  AssetSource,
  AssetTask,
  AssetTaskContext,
  AssetTaskOptions,
  AssetTaskState,
} from './assets.js';

/** Options of {@link AssetPool.preload}: the queue's own options, a signal and a progress callback. */
export interface AssetPreloadOptions extends AssetQueueOptions {
  /** Aborting cancels the keys still loading and pending. */
  signal?: AbortSignal;
  /** Called after each key ends, as the queue's `progress` event. */
  onProgress?(progress: AssetQueueProgress): void;
}

/** What a template's `build` function is given. */
export interface AssetTemplateContext<T> {
  /** The values of the keys named in `needs`, by key. Each holds one reference while the template is built. */
  assets: Record<string, T>;
  signal: AbortSignal;
  /** Makes an instance of another template from inside `build`; a template that reaches itself this way is a coded cycle error. */
  instantiate(name: string, overrides?: AssetInstanceOverrides): Promise<Mesh>;
}

/** Options of {@link AssetPool.defineTemplate}. */
export interface AssetTemplateOptions {
  /** Registry keys acquired before `build` runs and released by `releaseTemplate`. */
  needs?: readonly string[];
  /** Dispose the prototype in `releaseTemplate`. Default true; set false when the prototype is a mesh of an asset. */
  ownsRoot?: boolean;
}

/** Per-instance changes applied to the copy, never to the shared geometry or materials of the prototype. */
export interface AssetInstanceOverrides {
  name?: string;
  /** Local position, rotation (Euler radians) and scale of the instance root. */
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  visible?: boolean;
  /** Parent of the instance root. Default: the scene root. */
  parent?: Mesh | null;
  /** Replaces the material of every mesh of the instance (the prototype keeps its own). */
  material?: PbrMaterial;
  /** Merged into the instance root's `userData`. */
  userData?: Record<string, unknown>;
  /** Last step: change the copy as you like. If it throws, the copy is disposed. */
  apply?(root: Mesh): void;
}

/** The scene entries a template needs, loaded on first use so the registry itself imports no engine code. */
type SceneTools = typeof import('./pool-tools.js');

interface Template<T> {
  build(context: AssetTemplateContext<T>): Mesh | Promise<Mesh>;
  needs: string[];
  ownsRoot: boolean;
  root?: Mesh;
  building?: Promise<Mesh>;
  held: string[];
}

/** The own enumerable entries of per-instance userData; `__proto__`, `constructor` and `prototype` are refused, as in an asset map. */
function checkUserData(data: Record<string, unknown> | undefined): [string, unknown][] {
  if (data === undefined) return [];
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw typeError('instance userData must be a plain object; check the overrides', 'arguments');
  return Object.keys(data).map((key) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype')
      throw typeError(`instance userData key "${key}" is not allowed; use another name`, 'arguments');
    return [key, data[key]];
  });
}

/**
 * An {@link AssetRegistry} with reference counts, preload groups and templates. Everything the registry does, it does
 * the same; `acquire` is `load` plus one counted reference, and `release` at 0 disposes and unloads the value.
 */
export class AssetPool<T = unknown> extends AssetRegistry<T> {
  private readonly groups = new Map<string, { keys: string[]; held: Set<string> }>();
  private readonly templates = new Map<string, Template<T>>();
  private tools?: SceneTools;

  /** References held on a key by `acquire`, preload groups and templates. 0 for an unknown key. */
  refCount(key: string): number {
    return this.slots.get(key)?.refs ?? 0;
  }

  /**
   * Like `load`, and takes one reference on the key. Pair every `acquire` with a `release`. A failed or aborted load
   * takes none.
   */
  async acquire(key: string, signal?: AbortSignal): Promise<T> {
    this.live();
    const before = this.slots.get(key);
    if (before) before.refs = (before.refs ?? 0) + 1; // held during the load, so a release elsewhere cannot unload it underneath
    let value: T;
    try {
      value = await this.load(key, signal);
    } catch (error) {
      if (before && this.slots.get(key) === before && before.refs) before.refs--;
      throw error;
    }
    const slot = this.slots.get(key);
    if (!slot) throw fault('state', `asset "${key}" was removed while it loaded; do not remove() a key in use`, 'scene-registry');
    if (!before) slot.refs = (slot.refs ?? 0) + 1;
    return value;
  }

  /**
   * Gives back one reference taken by `acquire`. At 0 the value is disposed (`dispose` option, else its
   * `Symbol.dispose`) and unloaded, keeping the definition, so the next `acquire` loads it again. Returns the references left.
   * Throws a coded error for an unknown key or a release past 0.
   */
  release(key: string): number {
    const slot = this.slots.get(key);
    if (!slot) throw fault('state', `asset "${key}" is not defined; nothing to release`, 'scene-registry');
    if (!slot.refs)
      throw fault('state', `asset "${key}" was released more often than it was acquired; pair each acquire() with one release()`, 'scene-registry');
    if (--slot.refs > 0) return slot.refs;
    const value = slot.value as { [Symbol.dispose]?: () => void } | undefined;
    if (!this.options.dispose && typeof value?.[Symbol.dispose] === 'function') value[Symbol.dispose]!();
    this.unload(key);
    return 0;
  }

  /** Names a set of keys to preload together. Throws when the group exists. */
  defineGroup(name: string, keys: readonly string[]): this {
    this.live();
    if (this.groups.has(name)) throw fault('state', `preload group "${name}" is already defined`, 'scene-registry');
    this.groups.set(name, { keys: [...keys], held: new Set() });
    return this;
  }

  /**
   * Acquires every key of a group through an {@link AssetQueue} (concurrency, retries and progress as the queue has them)
   * and resolves with how each ended; it never rejects for a key. Each loaded key holds one reference for the group until
   * `releaseGroup`. Keys the group already holds are skipped, so a repeat call finishes what failed.
   */
  preload(name: string, options: AssetPreloadOptions = {}): Promise<AssetQueueResult> {
    this.live();
    const group = this.groups.get(name);
    if (!group) throw fault('state', `preload group "${name}" is not defined; defineGroup() it first`, 'scene-registry');
    const { signal, onProgress, ...queueOptions } = options,
      queue = new AssetQueue(queueOptions);
    if (onProgress) queue.on('progress', onProgress);
    for (const key of group.keys)
      if (!group.held.has(key))
        queue.add(key, async ({ signal: taskSignal }) => {
          const value = await this.acquire(key, taskSignal);
          group.held.add(key);
          return value;
        });
    return queue.run(signal);
  }

  /** Releases the references a group holds. Returns how many it released. */
  releaseGroup(name: string): number {
    const group = this.groups.get(name);
    if (!group) throw fault('state', `preload group "${name}" is not defined`, 'scene-registry');
    const held = [...group.held];
    group.held.clear();
    for (const key of held) this.release(key);
    return held.length;
  }

  /**
   * Defines a template: `build` makes the prototype mesh tree once, on the first `instantiate`, after acquiring the
   * assets named in `needs`. Throws when the name exists.
   */
  defineTemplate(name: string, build: (context: AssetTemplateContext<T>) => Mesh | Promise<Mesh>, options: AssetTemplateOptions = {}): this {
    this.live();
    if (this.templates.has(name)) throw fault('state', `template "${name}" is already defined`, 'scene-registry');
    this.templates.set(name, { build, needs: [...(options.needs ?? [])], ownsRoot: options.ownsRoot ?? true, held: [] });
    return this;
  }

  /**
   * Copies a template's prototype with `cloneSubtree` (geometry and materials are shared) and applies `overrides` to the
   * copy. The prototype is built on the first call. Rejects with a coded error for an unknown template or a template
   * that builds itself through `context.instantiate`.
   */
  instantiate(name: string, overrides: AssetInstanceOverrides = {}, signal?: AbortSignal): Promise<Mesh> {
    return this.instantiateFrom(name, overrides, signal, []);
  }

  private async instantiateFrom(name: string, overrides: AssetInstanceOverrides, signal: AbortSignal | undefined, chain: string[]): Promise<Mesh> {
    this.live();
    const extra = checkUserData(overrides.userData);
    const root = await this.prototypeOf(name, signal, chain);
    const { cloneSubtree, traverse, userData } = await this.loadTools();
    const copy = cloneSubtree(root, { parent: overrides.parent ?? null });
    try {
      if (overrides.name !== undefined) copy.name = overrides.name;
      if (overrides.position) copy.setPosition(overrides.position);
      if (overrides.rotation) copy.setRotation(overrides.rotation);
      if (overrides.scale) copy.setScale(overrides.scale);
      if (overrides.visible !== undefined) copy.visible = overrides.visible;
      if (extra.length) {
        const target = userData(copy);
        // defineProperty never runs a setter, so no key can reach a prototype
        for (const [key, value] of extra) Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
      }
      const material = overrides.material;
      if (material) traverse(copy, (mesh) => void mesh.setMaterial(material));
      overrides.apply?.(copy);
    } catch (error) {
      this.disposeTree(copy);
      throw error;
    }
    return copy;
  }

  private async loadTools(): Promise<SceneTools> {
    if (!this.tools) {
      const { cloneSubtree, traverse, userData } = await import('./pool-tools.js');
      this.tools = { cloneSubtree, traverse, userData };
    }
    return this.tools;
  }

  /** Disposes a mesh and its descendants (core's `dispose` detaches children, it does not dispose them). */
  private disposeTree(root: Mesh): void {
    try {
      root.check();
    } catch {
      return; // already gone with its engine or scene
    }
    const all: Mesh[] = [];
    this.tools?.traverse(root, (mesh) => void all.push(mesh));
    for (const mesh of all.reverse()) mesh.dispose();
    if (!all.length) root.dispose();
  }

  private prototypeOf(name: string, signal: AbortSignal | undefined, chain: string[]): Promise<Mesh> {
    const template = this.templates.get(name);
    if (!template) return Promise.reject(fault('state', `template "${name}" is not defined; defineTemplate() it first`, 'scene-registry'));
    if (chain.includes(name))
      return Promise.reject(fault('state', `template cycle: ${[...chain, name].join(' -> ')}; a template cannot instantiate itself, directly or through another`, 'scene-registry'));
    if (template.root) {
      try {
        template.root.check();
        return Promise.resolve(template.root);
      } catch {
        template.root = undefined; // the prototype was disposed by someone else: build again
      }
    }
    template.building ??= (async () => {
      const assets: Record<string, T> = {},
        held: string[] = [];
      try {
        await this.loadTools();
        for (const key of template.needs) {
          assets[key] = await this.acquire(key, signal);
          held.push(key);
        }
        const root = await template.build({
          assets,
          signal: signal ?? new AbortController().signal,
          instantiate: (other, overrides = {}) => this.instantiateFrom(other, overrides, signal, [...chain, name]),
        });
        template.root = root;
        template.held = held;
        return root;
      } catch (error) {
        for (const key of held) this.release(key);
        throw error;
      }
    })().finally(() => {
      template.building = undefined;
    });
    return template.building;
  }

  /**
   * Disposes a template's prototype (unless `ownsRoot` is false) and releases the assets it holds, keeping the
   * definition. Instances stay valid: core keeps a geometry's GPU data while any mesh uses it. Returns false for an unknown name.
   */
  releaseTemplate(name: string): boolean {
    const template = this.templates.get(name);
    if (!template) return false;
    const { root, held } = template;
    template.root = undefined;
    template.held = [];
    if (root && template.ownsRoot) this.disposeTree(root);
    for (const key of held) this.release(key);
    return true;
  }

  /** `releaseTemplate`, and forgets the definition. */
  removeTemplate(name: string): boolean {
    const found = this.releaseTemplate(name);
    this.templates.delete(name);
    return found;
  }

  /** Removes every key and releases every template. The pool cannot be used afterwards. */
  override dispose(): void {
    if (this.disposed) return;
    for (const name of [...this.templates.keys()]) this.removeTemplate(name);
    this.groups.clear();
    super.dispose();
  }
}
