// A set of root meshes, loaded models and plugins handled as one unit. Core fixes a mesh to its scene for life and has
// no detach: `remove` disposes. So a container takes its meshes and models out of the picture by hiding their roots (a
// hidden root hides its subtree), and its plugins, which core can only dispose, by removing them and running their
// factory again when they come back.
import type { EngineKernel, EnginePlugin, Mesh, Scene } from '@margoengine/core';
import { engineRuntime, meshRuntime, PbrMaterial } from '@margoengine/core/extension';
import { Cleanup } from '../../shared/cleanup.js';
import { fault, typeError } from '../../shared/errors.js';
import { sceneScope } from '../../shared/scene-scope.js';
import { cloneSubtree } from './clone.js';
import { children, parent, traverse } from './index.js';

/**
 * A loaded model as a container reads it: a plugin that owns a mesh tree. `PBRModel` of `@margoengine/gltf/pbr` is one.
 */
export interface ContainerModel extends EnginePlugin {
  /** The mesh the whole model hangs under. */
  readonly root: Mesh;
  /** The model's node meshes, in file order; a copy has the same ones. */
  readonly nodes: readonly Mesh[];
  /** Every mesh the model owns, when it makes more than `root` and `nodes`. */
  readonly ownedMeshes?: readonly Mesh[];
  /** Frees the model and its meshes. */
  dispose(): void;
}

/**
 * Makes one of a container's plugins: attach it (`(engine) => Sky.attach(engine)`) or return a new, unattached one and
 * the container attaches it. It runs with the container's scene active, each time the plugin comes into the scene.
 */
export type PluginFactory = (engine: EngineKernel) => EnginePlugin;

/** What a container holds: a root mesh, a loaded model or a plugin factory. */
export type ContainerItem = Mesh | ContainerModel | PluginFactory;

/** Options of {@link AssetContainer}. */
export interface AssetContainerOptions {
  /** The scene its members live in. Default `engine.scene`. */
  scene?: Scene;
  /** Copies a model for `instantiate`. Default `cloneModel` of `@margoengine/animation`, for gltf/pbr models. */
  cloneModel?(model: ContainerModel): Promise<ContainerModel>;
}

/** Options of {@link loadContainer}. */
export interface LoadContainerOptions extends AssetContainerOptions {
  /** Aborts the load: it rejects with `signal.reason` and nothing stays built. Default none. */
  signal?: AbortSignal;
  /** Loads the model into the active scene. Default `loadGLTF` of `@margoengine/gltf/pbr`. */
  load?(url: string, options: { signal?: AbortSignal }): Promise<ContainerModel>;
}

/** Options of {@link AssetContainer.instantiate}. */
export interface InstantiateOptions {
  /**
   * The name of each copy, from the source name and mesh: every mesh of a copied tree, and a model's root and nodes.
   * Default the source name.
   */
  name?(sourceName: string, source: Mesh): string;
  /** Give the copied mesh trees their own materials (shared ones stay shared among the copies). Default false. */
  cloneMaterials?: boolean;
  /** False leaves a mesh or model out of the copy. Default every one. */
  filter?(item: Mesh | ContainerModel): boolean;
  /** Stops the copy: it rejects with `signal.reason` and no copy stays. Default none. */
  signal?: AbortSignal;
}

type Member = Mesh | ContainerModel;
/** A factory's plugin, and everything it registered. */
type Attached = { plugin: EnginePlugin; made: EnginePlugin[] };

/** The container each member root and factory is in: one at a time, since removal and disposal are its own. */
const owners = new WeakMap<object, AssetContainer>();

const isModel = (item: unknown): item is ContainerModel => {
  const model = item as Partial<ContainerModel> | null | undefined;
  return !!model && Array.isArray(model.nodes) && !!model.root && typeof model.dispose === 'function';
};
const isMesh = (item: unknown): item is Mesh =>
  typeof item === 'object' && item !== null && 'setParent' in item && 'setGeometry' in item;
const rootOf = (member: Member): Mesh => (isModel(member) ? member.root : member);
const live = (mesh: Mesh): boolean => {
  const runtime = meshRuntime(mesh);
  return !runtime.engine.disposed && runtime.engine.meshes.get(runtime.id) === runtime;
};
const checkOptions = (value: unknown, label: string): void => {
  if (typeof value !== 'object' || value === null) throw typeError(`${label}: pass an options object`, 'arguments');
};
const checkCallbacks = (label: string, values: Record<string, unknown>): void => {
  for (const [name, value] of Object.entries(values))
    if (value !== undefined && typeof value !== 'function') throw typeError(`${label}: ${name} must be a function`, 'arguments');
};
const checkSignal = (signal: AbortSignal | undefined, label: string): void => {
  if (signal !== undefined && typeof signal?.throwIfAborted !== 'function')
    throw typeError(`${label}: signal must be an AbortSignal`, 'arguments');
};
const loadDefault = async (
  engine: EngineKernel,
  scope: ReturnType<typeof sceneScope>,
  url: string,
  signal: AbortSignal | undefined,
): Promise<ContainerModel> => {
  const { loadGLTF } = await import('@margoengine/gltf/pbr');
  signal?.throwIfAborted();
  // The container's scene, which need not be the active one once the import has resolved.
  return scope.run(() => loadGLTF(engine, url, { signal })) as unknown as Promise<ContainerModel>;
};
const cloneDefault = async (model: ContainerModel): Promise<ContainerModel> => {
  const { cloneModel } = await import('@margoengine/animation/skeleton-utils');
  return cloneModel(model as never) as unknown as ContainerModel;
};

/**
 * Root meshes, loaded models and plugins handled as one unit: add them all to the scene, remove them all without
 * destroying them, copy them, or dispose them. A new container is in the scene; one from {@link loadContainer} is not.
 * A mesh brings everything under it.
 */
export class AssetContainer {
  /** The scene the members live in. */
  readonly scene: Scene;
  private readonly clone: (model: ContainerModel) => Promise<ContainerModel>;
  private readonly members = new Set<Member>();
  /** Each factory with what it attached: null while the container is out of the scene. */
  private readonly factories = new Map<PluginFactory, Attached | null>();
  /** While out of the scene: what `visible` was on each member root. */
  private readonly hidden = new Map<Mesh, boolean>();
  private shown = true;
  private ended = false;

  constructor(
    readonly engine: EngineKernel,
    options: AssetContainerOptions = {},
  ) {
    checkOptions(options, 'AssetContainer');
    const runtime = engineRuntime(engine),
      { scene = engine.scene, cloneModel = cloneDefault } = options;
    if (runtime.disposed) throw fault('disposed', 'AssetContainer: engine disposed');
    if (!(runtime.scenes as ReadonlySet<unknown>).has(scene))
      throw typeError('AssetContainer: scene must be a live scene of this engine', 'scene');
    checkCallbacks('AssetContainer', { cloneModel });
    this.scene = scene;
    this.clone = cloneModel;
  }

  /** Whether the members are in the scene: true until `removeAllFromScene`. */
  get inScene(): boolean {
    return this.shown;
  }
  /** True once `dispose` ran. */
  get disposed(): boolean {
    return this.ended;
  }
  /** The member meshes (each the root of its tree), in the order added. A new array. */
  get meshes(): Mesh[] {
    this.prune();
    return [...this.members].filter((member): member is Mesh => !isModel(member));
  }
  /** The member models, in the order added. A new array. */
  get models(): ContainerModel[] {
    this.prune();
    return [...this.members].filter(isModel);
  }
  /** The plugins the factories have attached now; empty while out of the scene. A new array. */
  get plugins(): EnginePlugin[] {
    return [...this.factories.values()].flatMap((entry) => (entry ? [entry.plugin] : []));
  }

  /** Whether `mesh` is a member or under one: the `filter` that saves this container alone with `captureScene`. */
  contains(mesh: Mesh): boolean {
    if (!live(mesh)) return false;
    // The nearest member decides: another container's root under one of ours is still the other's.
    for (let at: Mesh | null = mesh; at; at = parent(at)) {
      const owner = owners.get(at);
      if (owner) return owner === this;
    }
    return false;
  }

  /**
   * Adds root meshes (no parent), loaded models and plugin factories, and gives them the container's state: out of the
   * scene, a mesh or model is hidden and a factory waits. All or nothing: a refused item or a factory that throws
   * leaves the container and the scene as they were.
   * @throws TypeError for an item of another scene, a mesh with a parent, an item already in a container, or a factory
   * that returns no new plugin; MargoError `'disposed'`.
   */
  add(...items: ContainerItem[]): this {
    this.live();
    this.prune();
    const members: Member[] = [],
      factories: PluginFactory[] = [],
      seen = new Set<object>();
    for (const item of items) {
      let key: object;
      if (isModel(item) || isMesh(item)) {
        const root = rootOf(item);
        root.check();
        const at = meshRuntime(root);
        if (at.engine !== engineRuntime(this.engine) || at.scene !== this.scene)
          throw typeError('AssetContainer.add: the item must be in the container scene', 'scene');
        if (!isModel(item) && parent(root))
          throw typeError('AssetContainer.add: add a root mesh (no parent); it brings its children', 'hierarchy');
        if (!isModel(item) && [...this.scene.plugins.values()].some((each) => isModel(each) && each.root === root))
          throw typeError('AssetContainer.add: this mesh is the root of a model; add the model instead', 'arguments');
        members.push(item);
        key = root;
      } else if (typeof item === 'function') {
        factories.push(item);
        key = item;
      } else throw typeError('AssetContainer.add: pass a root mesh, a loaded model or a plugin factory', 'arguments');
      if (owners.has(key) || seen.has(key))
        throw typeError('AssetContainer.add: the item is already in a container; release it there first', 'arguments');
      seen.add(key);
    }
    const attached = this.shown ? this.attach(factories) : undefined;
    for (const factory of factories) {
      owners.set(factory, this);
      this.factories.set(factory, attached?.get(factory) ?? null);
    }
    for (const member of members) {
      this.members.add(member);
      owners.set(rootOf(member), this);
      if (!this.shown) this.hide(rootOf(member));
    }
    return this;
  }

  /**
   * Takes an item out of the container without disposing it: it is the caller's again, with the visibility it had in
   * the scene. A factory's attached plugins stay attached. Returns false when the item is not in this container.
   */
  release(item: ContainerItem): boolean {
    this.live();
    if (typeof item === 'function') {
      if (!this.factories.delete(item)) return false;
      owners.delete(item);
      return true;
    }
    if (!this.members.delete(item)) return false;
    const root = rootOf(item),
      visible = this.hidden.get(root);
    owners.delete(root);
    this.hidden.delete(root);
    if (visible !== undefined && live(root)) root.visible = visible;
    return true;
  }

  /**
   * Puts every member back in the scene, each with the visibility it had, and runs the plugin factories. All or
   * nothing: a factory that throws leaves the container out of the scene. Does nothing when already in.
   */
  addAllToScene(): this {
    this.live();
    if (this.shown) return this;
    this.prune();
    for (const [factory, entry] of this.attach([...this.factories.keys()])) this.factories.set(factory, entry);
    for (const [root, visible] of this.hidden) root.visible = visible;
    this.hidden.clear();
    this.shown = true;
    return this;
  }

  /**
   * Takes every member out of the scene without destroying it: meshes and models are hidden (not drawn or picked), and
   * the factories' plugins are removed, which disposes them. Does nothing when already out. A plugin whose `dispose`
   * throws does not stop the rest; the first error is thrown once the container is out.
   */
  removeAllFromScene(): this {
    this.live();
    if (!this.shown) return this;
    this.prune();
    this.shown = false;
    for (const member of this.members) this.hide(rootOf(member));
    const cleanup = new Cleanup();
    this.detach(cleanup);
    cleanup.finish();
    return this;
  }

  /**
   * Moves every root mesh and model of the scene into this container and removes them, with the members it already had,
   * from the scene. `keep` returning true leaves an item in the scene. Members of other containers and plugins that are
   * not models stay: core can only dispose a plugin, so add those as factories.
   */
  moveAllFromScene(keep?: (item: Mesh | ContainerModel) => boolean): this {
    this.live();
    this.prune();
    checkCallbacks('AssetContainer.moveAllFromScene', { keep });
    const models = new Map<Mesh, ContainerModel>(),
      owned = new Set<Mesh>();
    for (const plugin of this.scene.plugins.values())
      if (isModel(plugin)) {
        models.set(plugin.root, plugin);
        for (const mesh of plugin.ownedMeshes ?? plugin.nodes) owned.add(mesh);
      }
    const taken: Member[] = [];
    for (const mesh of this.scene.meshes.values() as Iterable<Mesh>) {
      const model = models.get(mesh);
      if (owners.has(mesh) || (!model && (parent(mesh) || owned.has(mesh)))) continue;
      const item = model ?? mesh;
      if (!keep?.(item)) taken.push(item);
    }
    return this.add(...taken).removeAllFromScene();
  }

  /**
   * Copies the meshes and models into a new container that is in the scene, whatever state this one is in. Mesh trees
   * are copied with {@link cloneSubtree} (geometry and materials shared unless `cloneMaterials`), models with
   * `cloneModel`. Plugin factories are not copied. Dispose the result to remove the copies. All or nothing.
   * @example const copy = await camp.instantiate({ name: (name) => `${name} 2` });
   */
  async instantiate(options: InstantiateOptions = {}): Promise<AssetContainer> {
    this.live();
    checkOptions(options, 'AssetContainer.instantiate');
    const { name, cloneMaterials = false, filter, signal } = options;
    checkCallbacks('AssetContainer.instantiate', { name, filter });
    checkSignal(signal, 'AssetContainer.instantiate');
    if (typeof cloneMaterials !== 'boolean')
      throw typeError('AssetContainer.instantiate: cloneMaterials must be boolean', 'arguments');
    signal?.throwIfAborted();
    this.prune();
    const members = [...this.members].filter((member) => filter?.(member) ?? true),
      copy = new AssetContainer(this.engine, { scene: this.scene, cloneModel: this.clone }),
      shown = new Map<Mesh, boolean>(),
      materials = new Map<PbrMaterial, PbrMaterial>();
    const rename = (target: Mesh, source: Mesh): void => {
      if (!name) return;
      const value = name(source.name, source);
      if (typeof value !== 'string') throw typeError('AssetContainer.instantiate: name must return a string', 'arguments');
      target.name = value;
    };
    const ownMaterial = (mesh: Mesh): void => {
      let material = materials.get(mesh.material);
      if (!material) {
        material = new PbrMaterial();
        material.data.set(mesh.material.data);
        materials.set(mesh.material, material);
      }
      mesh.setMaterial(material);
    };
    const check = (): void => {
      signal?.throwIfAborted();
      this.live();
    };
    try {
      for (const member of members) {
        // A member disposed or released while an earlier model was being copied is not part of the copy.
        const source = rootOf(member);
        if (!this.members.has(member) || !live(source)) continue;
        // What it shows in the scene, which a removed container holds aside.
        const visible = (): boolean => this.hidden.get(source) ?? source.visible;
        if (isModel(member)) {
          const model = await this.clone(member);
          if (!isModel(model)) throw typeError('AssetContainer.instantiate: cloneModel must resolve to a model', 'arguments');
          try {
            check();
            shown.set(model.root, visible());
            // Hidden until every copy exists, so no frame shows part of the set.
            model.root.visible = false;
            copy.add(model);
          } catch (error) {
            new Cleanup(error).run(() => model.dispose());
            throw error;
          }
          rename(model.root, source);
          member.nodes.forEach((node, i) => model.nodes[i] && rename(model.nodes[i], node));
        } else {
          const mesh = cloneSubtree(source);
          shown.set(mesh, visible());
          mesh.visible = false;
          copy.add(mesh);
          const from: Mesh[] = [],
            to: Mesh[] = [];
          traverse(source, (each) => from.push(each));
          traverse(mesh, (each) => to.push(each));
          to.forEach((each, i) => {
            rename(each, from[i]);
            if (cloneMaterials) ownMaterial(each);
          });
        }
      }
      check();
      for (const [mesh, visible] of shown) if (live(mesh)) mesh.visible = visible;
      return copy;
    } catch (error) {
      new Cleanup(error).run(() => copy.dispose());
      throw error;
    }
  }

  /**
   * Disposes everything the container holds, in the scene or out: its plugins, its models and its meshes with all that
   * is under them, except another container's members and other models hung there. Core frees a geometry with its last
   * mesh. Safe to call twice and after the engine is disposed.
   */
  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    const cleanup = new Cleanup(),
      meshes: Mesh[] = [],
      foreign = new Set<Mesh>();
    this.detach(cleanup);
    for (const factory of this.factories.keys()) owners.delete(factory);
    for (const plugin of this.scene.plugins.values())
      if (isModel(plugin) && !this.members.has(plugin))
        for (const mesh of [plugin.root, ...(plugin.ownedMeshes ?? plugin.nodes)]) foreign.add(mesh);
    const collect = (mesh: Mesh): void => {
      meshes.push(mesh);
      for (const child of children(mesh)) if (!foreign.has(child) && !owners.has(child)) collect(child);
    };
    // Listed before the models go: disposing one unparents what the caller hung on its nodes.
    for (const member of this.members) if (live(rootOf(member))) collect(rootOf(member));
    for (const member of this.members) owners.delete(rootOf(member));
    for (const member of this.members) if (isModel(member)) cleanup.run(() => member.dispose());
    for (const mesh of meshes.reverse()) cleanup.run(() => mesh.dispose());
    this.factories.clear();
    this.members.clear();
    this.hidden.clear();
    cleanup.finish();
  }
  /** Dispose the container when a using block ends. */
  [Symbol.dispose](): void {
    this.dispose();
  }

  private live(): void {
    if (this.ended || engineRuntime(this.engine).disposed) throw fault('disposed', 'AssetContainer disposed; make a new one');
  }
  /** Forgets members disposed outside the container. */
  private prune(): void {
    for (const member of this.members) {
      const root = rootOf(member);
      if (live(root)) continue;
      this.members.delete(member);
      this.hidden.delete(root);
      owners.delete(root);
    }
  }
  private hide(root: Mesh): void {
    this.hidden.set(root, root.visible);
    root.visible = false;
  }
  /** Runs factories in the container scene: all attach, or every plugin any of them registered is removed again. */
  private attach(factories: readonly PluginFactory[]): Map<PluginFactory, Attached> {
    const scene = this.scene,
      before = new Set(scene.plugins.values()),
      claimed = new Set<EnginePlugin>(),
      done = new Map<PluginFactory, Attached>(),
      added = () => [...scene.plugins.values()].filter((plugin) => !before.has(plugin));
    try {
      for (const factory of factories) {
        const plugin = sceneScope(this.engine, scene).run(() => factory(this.engine)) as EnginePlugin;
        if (typeof plugin?.setup !== 'function' || before.has(plugin) || claimed.has(plugin))
          throw typeError('AssetContainer: a plugin factory must return a new plugin, synchronously', 'arguments');
        if (scene.plugins.get(plugin.name) !== plugin) scene.use(plugin);
        // Everything registered since the last factory is this one's, helpers included.
        const made = added().filter((each) => !claimed.has(each));
        for (const each of made) claimed.add(each);
        done.set(factory, { plugin, made });
      }
      return done;
    } catch (error) {
      const cleanup = new Cleanup(error);
      for (const plugin of added().reverse()) cleanup.run(() => this.remove(plugin));
      throw error;
    }
  }
  /** Removes what the factories attached. */
  private detach(cleanup: Cleanup): void {
    for (const [factory, entry] of [...this.factories].reverse()) {
      if (!entry) continue;
      this.factories.set(factory, null);
      for (const plugin of [...entry.made].reverse()) cleanup.run(() => this.remove(plugin));
    }
  }
  /** By identity: a later plugin of the same name is left alone. */
  private remove(plugin: EnginePlugin): void {
    if (this.scene.plugins.get(plugin.name) === plugin) this.scene.removePlugin(plugin.name);
  }
}

/**
 * Loads a model into a new container that is **not** in the scene: call `addAllToScene` to show it, or `instantiate`
 * for copies. All or nothing: a failed or aborted load leaves nothing behind.
 * @throws TypeError for a bad option or a loader that returns no model; the loader's error; the signal's reason.
 * @example const crates = (await loadContainer(engine, 'crate.glb')).addAllToScene();
 */
export async function loadContainer(
  engine: EngineKernel,
  url: string,
  options: LoadContainerOptions = {},
): Promise<AssetContainer> {
  checkOptions(options, 'loadContainer');
  const { signal, load, ...setup } = options;
  if (typeof url !== 'string' || !url) throw typeError('loadContainer: pass a url string', 'arguments');
  checkCallbacks('loadContainer', { load });
  checkSignal(signal, 'loadContainer');
  const container = new AssetContainer(engine, setup),
    scope = sceneScope(engine, container.scene);
  signal?.throwIfAborted();
  container.removeAllFromScene();
  let model: ContainerModel;
  try {
    model = await (load ? scope.run(() => load(url, { signal })) : loadDefault(engine, scope, url, signal));
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
  if (!isModel(model)) throw typeError('loadContainer: load must resolve to a model with root, nodes and dispose', 'arguments');
  try {
    signal?.throwIfAborted();
    // Added in the same task the load resolved in, so no frame shows it first.
    return container.add(model);
  } catch (error) {
    new Cleanup(error).run(() => model.dispose());
    throw error;
  }
}
