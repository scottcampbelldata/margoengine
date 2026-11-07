// A running scene as a save document and back, with no mapping to write. captureScene reads the meshes (transform,
// parent, geometry, material), the glTF models (their URL, material variant and the nodes that moved), the camera, the
// lighting and the plugins' state. restoreScene loads the models, builds everything, and only then swaps it in, so a
// save that fails to load leaves the running scene as it was.
import { Geometry, type EngineKernel, type EnginePlugin, type Mesh, type Scene } from '@margoengine/core';
import type { Mesh as RuntimeMesh } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import {
  type Json,
  type SaveDocument,
  type SavedEntity,
  type SavedTransform,
  type ValidateOptions,
  parseSave,
} from './document.js';
import { type LoadOptions, loadWorld } from './load.js';
import type { Migrations } from './migrations.js';
import { type ResolvedEntity, expandSave } from './prefab.js';
import { fromBase64, toBase64 } from './storage.js';

/** The part of a glTF model the binding reads; `PBRModel` of `@margoengine/gltf-pro` is one. */
export interface ModelLike extends EnginePlugin {
  readonly root: Mesh;
  readonly nodes: readonly Mesh[];
  /** Every mesh the model owns, when it makes more than `root` and `nodes`. */
  readonly ownedMeshes?: readonly Mesh[];
  readonly asset: { readonly baseURL?: string; readonly doc?: { nodes?: readonly unknown[] } };
  readonly selectedVariant?: number;
  selectVariant?(variant?: number): void;
  dispose(): void;
}

/**
 * How one plugin is saved, for a plugin that needs more than the default. By default a plugin's own `saveState()` and
 * `loadState(state)` are used, else its JSON `options` and every property with both a getter and a setter.
 */
export interface PluginBinding<P extends EnginePlugin = EnginePlugin> {
  /** The class, to attach the plugin with its saved `options` when a restored scene does not have it. */
  type?: { attach(engine: EngineKernel, options?: never): EnginePlugin };
  /** Properties to save, in place of the getter and setter pairs. Public fields such as `time` go here. */
  properties?: readonly string[];
  /** Returns the plugin's state as JSON, in place of `properties`. */
  save?(plugin: P): Json;
  /** Applies what `save` returned. A throw undoes the whole restore. */
  load?(plugin: P, state: Json): void;
}

/** Bindings by plugin name; `null` leaves a plugin out. */
export type PluginBindings = Readonly<Record<string, PluginBinding<never> | null>>;

/** Options of {@link captureScene}. */
export interface CaptureOptions {
  /** The scene to save. Default `engine.scene`. */
  scene?: Scene;
  /** Your schema version, for `Migrations`. Default 1. */
  version?: number;
  /** Anything else to keep with the save: a title, a play time. The key `engine` is the binding's. */
  meta?: Record<string, Json>;
  /** Save the camera. Default true. */
  camera?: boolean;
  /** Bindings for plugins the default does not fit. Default none. */
  plugins?: PluginBindings;
  /** False leaves a mesh out, and everything under it. Default every mesh. */
  filter?(mesh: Mesh): boolean;
  /** Components of your own for a mesh or model root. Default none. */
  components?(mesh: Mesh): Record<string, Json> | undefined;
  /** The address of a model that was not loaded from a URL. Default `model.asset.baseURL`. */
  modelURL?(model: ModelLike): string | undefined;
  /** Called for each plugin left out because nothing in it could be read. Default none. */
  onSkip?(plugin: EnginePlugin): void;
}

/** Options of {@link restoreScene}. */
export interface RestoreOptions extends ValidateOptions {
  /** The scene to restore into. Default `engine.scene`. */
  scene?: Scene;
  /** Brings an older save to the current schema version first. Default none. */
  migrations?: Migrations;
  /** Remove what the scene holds once the new one is in: meshes that `filter` keeps, and models. Default true. */
  clear?: boolean;
  /** Restore the camera. Default true. */
  camera?: boolean;
  /** Bindings by plugin name, as for {@link captureScene}. Default none. */
  plugins?: PluginBindings;
  /** The meshes `clear` removes: false keeps a mesh and everything under it. Default every mesh. */
  filter?(mesh: Mesh): boolean;
  /** Called once per entity after all exist, for your own components. A throw undoes the whole restore. */
  onEntity?(mesh: Mesh, entity: ResolvedEntity, get: (id: string) => Mesh): void;
  /** Loads a model. Default `loadGLTF` of `@margoengine/gltf-pro`. */
  load?(url: string, options: { signal?: AbortSignal }): Promise<ModelLike>;
  /** Makes another copy of a loaded model, for a URL used twice. Default `cloneModel` of `@margoengine/animation`. */
  clone?(model: ModelLike): Promise<ModelLike>;
  /** Stops the restore before the swap; nothing stays built. */
  signal?: AbortSignal;
}

/** What {@link restoreScene} returns. */
export interface RestoredScene {
  /** One mesh per entity, by entity id; a model's is its `root`. */
  readonly meshes: ReadonlyMap<string, Mesh>;
  /** The models, by entity id. */
  readonly models: ReadonlyMap<string, ModelLike>;
  /** The document's `meta`, without the binding's own key. */
  readonly meta: Readonly<Record<string, Json>>;
}

/** The binding's own block, `meta.engine`. */
interface EngineState {
  camera?: { fov: number; near: number; far: number; position: number[]; target: number[]; up: number[] };
  lighting?: { direction: number[]; radiance: number[]; ambient: number[] };
  background?: string | null;
  geometries?: { vertices: string; indices: string }[];
  plugins?: Record<string, Json>;
}

/** Keys of a captured entity's components that are the binding's. */
const RESERVED = ['mesh', 'model', 'geometry', 'material', 'sharedMaterial', 'node', 'visible', 'receiveShadow'];
/** Two float32 steps at 1: what normalising a stored quaternion can move a value by, so such a node has not moved. */
const SAME = 2.4e-7;

const ids = new WeakMap<object, string>();
/** The id `mesh` has in saves, once a capture or a restore has given it one. It stays the same across saves. */
export function meshId(mesh: Mesh): string | undefined {
  return ids.get(mesh);
}

const runtime = (mesh: Mesh): RuntimeMesh => mesh as unknown as RuntimeMesh;
const parentOf = (mesh: Mesh): Mesh | undefined => {
  const { engine, id } = runtime(mesh),
    parent = engine.store.parents[id];
  return parent < 0 ? undefined : (engine.meshes.get(parent) as unknown as Mesh);
};
const isModel = (plugin: EnginePlugin): plugin is ModelLike => {
  const model = plugin as Partial<ModelLike>;
  return Array.isArray(model.nodes) && typeof model.root === 'object' && typeof model.asset === 'object';
};
const modelsOf = (scene: Scene): ModelLike[] => [...scene.plugins.values()].filter(isModel);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const numbers = (value: unknown, length?: number): value is number[] =>
  Array.isArray(value) && (length === undefined || value.length === length) && value.every(Number.isFinite);
const bytesOf = (view: ArrayBufferView): Uint8Array => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

/** The rotation a mesh has, as a quaternion: the store's, which an Euler setter brings up to date on request. */
function quaternion(mesh: Mesh): [number, number, number, number] {
  const handle = runtime(mesh),
    { qx, qy, qz, qw } = handle.engine.store.transforms,
    id = handle.id;
  handle.syncRotation();
  return [qx[id], qy[id], qz[id], qw[id]];
}

/** A mesh's local transform; a field at its default is left out. */
function transformOf(mesh: Mesh): SavedTransform | undefined {
  const out: SavedTransform = {},
    { position: p, scale: s } = mesh,
    rotation = quaternion(mesh);
  if (p.x || p.y || p.z) out.position = [p.x, p.y, p.z];
  if (rotation[0] || rotation[1] || rotation[2] || rotation[3] !== 1) out.rotation = rotation;
  if (s.x !== 1 || s.y !== 1 || s.z !== 1) out.scale = [s.x, s.y, s.z];
  return Object.keys(out).length ? out : undefined;
}

function place(mesh: Mesh, transform: SavedTransform | undefined): void {
  if (transform?.position) mesh.setPosition(transform.position);
  if (transform?.rotation) mesh.setQuaternion(transform.rotation);
  if (transform?.scale) mesh.setScale(transform.scale);
}

/** JSON of a value, keeping what is plain: a typed array becomes an array, and what JSON cannot hold is left out. */
function plain(value: unknown, depth = 0): Json | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth > 16 || typeof value !== 'object') return undefined;
  if (ArrayBuffer.isView(value))
    return value instanceof DataView || value instanceof BigInt64Array || value instanceof BigUint64Array
      ? undefined
      : Array.from(value as Float32Array);
  if (Array.isArray(value)) {
    const items = value.map((item) => plain(item, depth + 1));
    return items.includes(undefined) ? undefined : (items as Json[]);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const out: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value)) {
    const kept = plain(item, depth + 1);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

/** Names of the properties a plugin's class chain gives both a getter and a setter. */
function accessors(plugin: object): string[] {
  const names = new Set<string>();
  for (let proto = Object.getPrototypeOf(plugin); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
    for (const [name, property] of Object.entries(Object.getOwnPropertyDescriptors(proto)))
      if (property.get && property.set) names.add(name);
  return [...names].sort();
}

type Loose = EnginePlugin & {
  options?: unknown;
  saveState?(): Json;
  loadState?(state: Json): void;
} & Record<string, unknown>;
type AnyBinding = PluginBinding<EnginePlugin>;

/** A plugin's state, or undefined when nothing in it could be read. */
function readPlugin(plugin: EnginePlugin, binding: AnyBinding | undefined): Json | undefined {
  const loose = plugin as Loose;
  if (binding?.save) return binding.save(plugin);
  if (!binding?.properties && typeof loose.saveState === 'function') return loose.saveState();
  const properties: Record<string, Json> = {};
  for (const name of binding?.properties ?? accessors(plugin)) {
    const value = plain(loose[name]);
    if (value !== undefined) properties[name] = value;
  }
  const options = plain(loose.options),
    out: Record<string, Json> = {};
  if (Object.keys(properties).length) out.properties = properties;
  if (record(options) && Object.keys(options).length) out.options = options;
  return Object.keys(out).length ? out : undefined;
}

function writePlugin(plugin: EnginePlugin, binding: AnyBinding | undefined, state: Json): void {
  const loose = plugin as Loose;
  if (binding?.load) return binding.load(plugin, state);
  if (!binding?.properties && !binding?.save && typeof loose.loadState === 'function') return loose.loadState(state);
  if (!record(state) || !record(state.properties)) return;
  for (const [name, value] of Object.entries(state.properties)) {
    const current = loose[name];
    if (ArrayBuffer.isView(current)) (current as Float32Array).set(value as number[]);
    else loose[name] = value;
  }
}

const bindingOf = (plugins: PluginBindings | undefined, name: string): AnyBinding | null | undefined =>
  plugins && Object.hasOwn(plugins, name) ? (plugins[name] as AnyBinding | null) : undefined;

/** The nodes of a model that differ from its file, by index. */
function movedNodes(model: ModelLike): Record<string, Json> {
  const out: Record<string, Json> = {},
    defined = (model.asset.doc?.nodes ?? []) as readonly Record<string, unknown>[],
    near = (values: readonly number[], wanted: unknown, fallback: readonly number[]): boolean => {
      const target = (wanted ?? fallback) as readonly number[];
      return values.every((value, i) => Math.abs(value - target[i]) <= SAME * Math.max(1, Math.abs(target[i])));
    };
  model.nodes.forEach((node, index) => {
    const file = defined[index] ?? {},
      { position: p, scale: s } = node,
      visibility = (file.extensions as Record<string, { visible?: boolean }> | undefined)?.KHR_node_visibility,
      rotation = quaternion(node),
      still =
        file.matrix === undefined &&
        near([p.x, p.y, p.z], file.translation, [0, 0, 0]) &&
        near(rotation, file.rotation, [0, 0, 0, 1]) &&
        near([s.x, s.y, s.z], file.scale, [1, 1, 1]);
    if (still && node.visible === (visibility?.visible ?? true)) return;
    const saved: Record<string, Json> = { visible: node.visible };
    if (!still) saved.transform = { position: [p.x, p.y, p.z], rotation, scale: [s.x, s.y, s.z] };
    out[index] = saved;
  });
  return out;
}

const stem = (url: string): string =>
  url
    .split(/[?#]/)[0]
    .split('/')
    .pop()
    ?.replace(/\.[^.]*$/, '') || 'model';

/**
 * The scene as a save document, with no mapping to write: every mesh with its transform, parent, geometry and
 * material; every glTF model as its URL, material variant and the nodes that moved; the camera, lighting and
 * background; and each plugin's state. Write it with `saveGame`, load it with {@link restoreScene}.
 * @throws TypeError when a model has no URL (pass `modelURL`), or a `components` key is one the binding uses.
 * @example await saveGame(storage, 'slot-1', captureScene(engine));
 */
export function captureScene(engine: EngineKernel, options: CaptureOptions = {}): SaveDocument {
  const { scene = engine.scene, version = 1, meta, camera = true, plugins, filter, components, modelURL, onSkip } = options,
    owners = new Map<Mesh, ModelLike>();
  for (const model of modelsOf(scene)) {
    for (const mesh of model.ownedMeshes ?? model.nodes) owners.set(mesh, model);
    owners.set(model.root, model);
  }
  // A mesh leaves with what it hangs from, so nothing is saved under a parent that is not there.
  const kept = new Map<Mesh, boolean>(),
    keep = (mesh: Mesh): boolean => {
      let answer = kept.get(mesh);
      if (answer === undefined) {
        const parent = parentOf(mesh);
        answer = (filter?.(mesh) ?? true) && (!parent || keep(parent));
        kept.set(mesh, answer);
      }
      return answer;
    };
  const listed = [...scene.meshes.values()]
    .filter((mesh) => keep(mesh) && (!owners.has(mesh) || owners.get(mesh)!.root === mesh))
    .sort((a, b) => runtime(a).id - runtime(b).id);
  const urls = new Map<Mesh, string>();
  for (const mesh of listed) {
    const model = owners.get(mesh);
    if (!model) continue;
    const url = modelURL?.(model) ?? model.asset.baseURL;
    if (!url) throw new TypeError(`Model '${model.name}' was not loaded from a URL; pass modelURL to say where it lives`);
    urls.set(mesh, url);
  }
  const used = new Set(listed.map((mesh) => ids.get(mesh)));
  for (const mesh of listed) {
    if (ids.has(mesh)) continue;
    const base = mesh.name || (urls.has(mesh) ? stem(urls.get(mesh)!) : 'mesh');
    let id = base;
    for (let n = 1; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    ids.set(mesh, id);
  }
  const materialUse = new Map<object, number>();
  for (const mesh of listed)
    if (!urls.has(mesh)) materialUse.set(mesh.material, (materialUse.get(mesh.material) ?? 0) + 1);
  const shared = [...materialUse].filter(([, count]) => count > 1).map(([material]) => material),
    geometries = new Map<Geometry, number>(),
    table: { vertices: string; indices: string }[] = [];
  const entities = listed.map((mesh): SavedEntity => {
    const entity: SavedEntity = { id: ids.get(mesh)! },
      parts: Record<string, Json> = {},
      parent = parentOf(mesh),
      model = owners.get(mesh);
    if (mesh.name) entity.name = mesh.name;
    if (parent) {
      const holder = owners.get(parent);
      entity.parent = ids.get(holder ? holder.root : parent)!;
      if (holder && holder.root !== parent) parts.node = holder.nodes.indexOf(parent);
    }
    const transform = transformOf(mesh);
    if (transform) entity.transform = transform;
    if (!mesh.visible) parts.visible = false;
    if (model) {
      parts.mesh = urls.get(mesh)!;
      const moved = movedNodes(model),
        state: Record<string, Json> = {};
      if (model.selectedVariant !== undefined) state.variant = model.selectedVariant;
      if (Object.keys(moved).length) state.nodes = moved;
      if (Object.keys(state).length) parts.model = state;
    } else {
      if (!mesh.receiveShadow) parts.receiveShadow = false;
      if (mesh.geometry) {
        let index = geometries.get(mesh.geometry);
        if (index === undefined) {
          const { vertices, indices } = mesh.geometry;
          index = table.push({ vertices: toBase64(bytesOf(vertices)), indices: toBase64(bytesOf(indices)) }) - 1;
          geometries.set(mesh.geometry, index);
        }
        parts.geometry = index;
      }
      const { data } = mesh.material;
      parts.material = { color: [data[0], data[1], data[2]], roughness: data[4], metalness: data[5], doubleSided: !!data[6] };
      const group = shared.indexOf(mesh.material);
      if (group >= 0) parts.sharedMaterial = group;
    }
    const own = components?.(mesh);
    for (const key of Object.keys(own ?? {}))
      if (RESERVED.includes(key)) throw new TypeError(`Component '${key}' is the save binding's; name yours differently`);
    entity.components = { ...parts, ...own };
    return entity;
  });
  const state: EngineState = {
    lighting: {
      direction: Array.from(scene.lighting.direction),
      radiance: Array.from(scene.lighting.radiance),
      ambient: Array.from(scene.lighting.ambient),
    },
  };
  if (scene.background !== undefined) state.background = scene.background;
  if (camera) {
    const { fov, near, far, position, target, up } = engine.camera;
    state.camera = { fov, near, far, position: [...position], target: [...target], up: [...up] };
  }
  if (table.length) state.geometries = table;
  const pluginState: Record<string, Json> = {};
  for (const plugin of scene.plugins.values()) {
    const binding = bindingOf(plugins, plugin.name);
    if (isModel(plugin) || binding === null) continue;
    const saved = readPlugin(plugin, binding ?? undefined);
    if (saved === undefined) onSkip?.(plugin);
    else pluginState[plugin.name] = saved;
  }
  if (Object.keys(pluginState).length) state.plugins = pluginState;
  return { format: 'margo-save', version, entities, meta: { ...meta, engine: state as unknown as Json } };
}

/** Geometry back from its saved bytes. Its constructor refuses bad values. */
function readGeometry(saved: unknown, index: number): Geometry {
  if (!record(saved) || typeof saved.vertices !== 'string' || typeof saved.indices !== 'string')
    throw new TypeError(`meta.engine.geometries[${index}]: must be { vertices, indices } in base64`);
  const words = (text: string): ArrayBuffer => {
    const bytes = fromBase64(text);
    if (bytes.length % 4) throw new TypeError(`meta.engine.geometries[${index}]: the bytes do not fit; the save is damaged, load an earlier one`);
    return bytes.buffer as ArrayBuffer;
  };
  const vertices = new Float32Array(words(saved.vertices)),
    count = Math.floor(vertices.length / 6),
    positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions.set(vertices.subarray(i * 6, i * 6 + 3), i * 3);
    normals.set(vertices.subarray(i * 6 + 3, i * 6 + 6), i * 3);
  }
  return new Geometry(positions, normals, new Uint32Array(words(saved.indices)));
}

/** Refuses a damaged `meta.engine` before anything is built. */
function readState(document: SaveDocument): EngineState {
  const state = (document.meta?.engine ?? {}) as unknown as EngineState,
    wrong = (text: string): TypeError => new TypeError(`meta.engine.${text}`);
  if (!record(state)) throw wrong('must be what captureScene wrote');
  const { camera, lighting, geometries, plugins } = state;
  if (camera !== undefined) {
    const ok =
      record(camera) &&
      numbers(camera.position, 3) &&
      numbers(camera.target, 3) &&
      numbers(camera.up, 3) &&
      [camera.fov, camera.near, camera.far].every(Number.isFinite);
    if (!ok) throw wrong('camera: { fov, near, far, position, target, up }');
  }
  if (lighting !== undefined) {
    const ok = record(lighting) && numbers(lighting.direction) && numbers(lighting.radiance) && numbers(lighting.ambient);
    if (!ok) throw wrong('lighting: { direction, radiance, ambient } as numbers');
  }
  if (geometries !== undefined && !Array.isArray(geometries)) throw wrong('geometries: an array');
  if (plugins !== undefined && !record(plugins)) throw wrong('plugins: state by plugin name');
  return state;
}

/** A model's saved variant and moved nodes. */
function applyModel(model: ModelLike, saved: Json | undefined): void {
  if (!record(saved)) return;
  if (typeof saved.variant === 'number') model.selectVariant?.(saved.variant);
  for (const [index, value] of Object.entries((saved.nodes ?? {}) as Record<string, Record<string, Json>>)) {
    const node = model.nodes[+index];
    if (!node) throw new TypeError(`Model node ${index} is not in the file; has the model changed since the save?`);
    place(node, value.transform as SavedTransform | undefined);
    node.visible = value.visible !== false;
  }
}

/** A mesh's material; meshes that shared one share one again. */
function applyMaterial(
  mesh: Mesh,
  saved: Json | undefined,
  group: Json | undefined,
  shared: Map<Json, Mesh['material']>,
): void {
  const known = group === undefined ? undefined : shared.get(group);
  if (known) mesh.setMaterial(known);
  else {
    if (record(saved)) mesh.material.set(saved);
    if (group !== undefined) shared.set(group, mesh.material);
  }
}

/** Applies every plugin's state, or none: a failure puts back what was changed and rethrows. */
function applyPlugins(
  engine: EngineKernel,
  scene: Scene,
  wanted: readonly [string, Json][],
  named: ReadonlyMap<string, EnginePlugin>,
  plugins: PluginBindings | undefined,
): void {
  const undo: (() => void)[] = [];
  try {
    for (const [name, saved] of wanted) {
      const binding = bindingOf(plugins, name) ?? undefined;
      let plugin = named.get(name);
      if (plugin) {
        const target = plugin,
          was = readPlugin(target, binding);
        if (was !== undefined) undo.push(() => writePlugin(target, binding, was));
      } else {
        const made = binding!.type!.attach(engine, (record(saved) ? saved.options : undefined) as never);
        undo.push(() => scene.removePlugin(made.name));
        plugin = made;
      }
      writePlugin(plugin, binding, saved);
    }
  } catch (error) {
    // Every step runs, whatever another does: the plugin that failed may refuse its old state too.
    const undoErrors: unknown[] = [];
    for (const step of undo.reverse()) {
      try {
        step();
      } catch (problem) {
        undoErrors.push(problem);
      }
    }
    throw undoErrors.length ? Object.assign(error as object, { undoErrors }) : error;
  }
}

const loadDefault = async (engine: EngineKernel, url: string, options: { signal?: AbortSignal }): Promise<ModelLike> => {
  const { loadGLTF } = await import('@margoengine/gltf-pro');
  return loadGLTF(engine, url, options) as unknown as ModelLike;
};
const cloneDefault = async (model: ModelLike): Promise<ModelLike> => {
  const { cloneModel } = await import('@margoengine/animation/skeleton-utils');
  return cloneModel(model as never) as unknown as ModelLike;
};

/**
 * Loads a save into the running scene, all or nothing: validates and migrates it, loads its models out of sight, builds
 * every mesh, and only then applies plugin state, camera and lighting and removes what the scene held. Any failure
 * before that point leaves the scene as it was. A plugin the scene lacks is attached through its binding's `type`.
 * @throws TypeError for an invalid document or a plugin with no `type`; MargoError `'failed'` with the `cause` when a
 * step fails; the signal's reason when it aborts.
 * @example await restoreScene(engine, await loadGame(storage, 'slot-1'));
 */
export async function restoreScene(
  engine: EngineKernel,
  document: SaveDocument | unknown,
  options: RestoreOptions = {},
): Promise<RestoredScene> {
  const { scene = engine.scene, migrations, clear = true, camera = true, plugins, filter, onEntity, signal } = options,
    { load = (url, how) => loadDefault(engine, url, how), clone = cloneDefault, components, strictComponents } = options,
    checks: LoadOptions = { components, strictComponents, signal };
  signal?.throwIfAborted();
  const shaped = parseSave(document, {}),
    current = migrations ? (migrations.migrate(shaped) as SaveDocument) : shaped,
    entities = expandSave(parseSave(current, { components, strictComponents })),
    state = readState(current),
    geometries = (state.geometries ?? []).map(readGeometry);
  for (const entity of entities) {
    const { geometry, mesh } = entity.components;
    if (geometry !== undefined && !(typeof geometry === 'number' && geometries[geometry]))
      throw new TypeError(`Entity '${entity.id}': no saved geometry ${geometry}; the save is damaged`);
    if (mesh !== undefined && typeof mesh !== 'string')
      throw new TypeError(`Entity '${entity.id}' mesh: a model URL; shapes are for addScene of @margoengine/stage/scene`);
  }
  const named = new Map([...scene.plugins.values()].map((plugin) => [plugin.name, plugin])),
    wanted = Object.entries(state.plugins ?? {}).filter(([name]) => bindingOf(plugins, name) !== null);
  for (const [name] of wanted)
    if (!named.has(name) && !bindingOf(plugins, name)?.type)
      throw new TypeError(`The save has plugin '${name}' and the scene does not; attach it first or pass its type in plugins`);
  // What leaves at the swap, decided before anything new exists.
  const oldModels = clear ? modelsOf(scene) : [],
    owned = new Set(oldModels.flatMap((model) => [model.root, ...(model.ownedMeshes ?? model.nodes)])),
    leaving: Mesh[] = [],
    stays = (mesh: Mesh): boolean => {
      if (!(filter?.(mesh) ?? true)) return true;
      const parent = parentOf(mesh);
      return parent ? stays(parent) : false;
    };
  if (clear) for (const mesh of scene.meshes.values()) if (!owned.has(mesh) && !stays(mesh)) leaving.push(mesh);
  // Models first: loadWorld is synchronous. Each is hidden the moment it arrives, so no frame shows it early.
  const byURL = new Map<string, ResolvedEntity[]>();
  for (const entity of entities) {
    const url = entity.components.mesh as string | undefined;
    if (url !== undefined) byURL.set(url, [...(byURL.get(url) ?? []), entity]);
  }
  const models = new Map<string, ModelLike>(),
    fresh = new Set<ModelLike>(),
    release = (): void => {
      for (const model of fresh) model.dispose();
      fresh.clear();
    },
    hold = (model: ModelLike): ModelLike => {
      model.root.visible = false;
      fresh.add(model);
      return model;
    };
  try {
    const loads = await Promise.allSettled([...byURL.keys()].map((url) => load(url, { signal }).then(hold)));
    const failed = loads.find((result) => result.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
    signal?.throwIfAborted();
    let at = 0;
    for (const group of byURL.values()) {
      const first = (loads[at++] as PromiseFulfilledResult<ModelLike>).value;
      models.set(group[0].id, first);
      for (const entity of group.slice(1)) {
        models.set(entity.id, hold(await clone(first)));
        signal?.throwIfAborted();
      }
    }
  } catch (error) {
    release();
    if (signal?.aborted) throw signal.reason;
    throw Object.assign(new MargoError('failed', 'A model of the save did not load; the scene is unchanged, see error.cause'), {
      cause: error,
    });
  }
  const materials = new Map<Json, Mesh['material']>(),
    modelOf = new Map([...models.values()].map((model) => [model.root, model])),
    shown = new Map<Mesh, boolean>();
  let handles: Map<string, Mesh>;
  try {
    handles = loadWorld<Mesh>(
      current,
      {
        create(entity) {
          const parts = entity.components,
            model = models.get(entity.id),
            mesh = model ? model.root : scene.createMesh();
          mesh.name = entity.name ?? '';
          shown.set(mesh, parts.visible !== false);
          if (model) {
            place(mesh, entity.transform);
            applyModel(model, parts.model);
          } else {
            mesh.visible = false;
            try {
              place(mesh, entity.transform);
              if (parts.receiveShadow === false) mesh.receiveShadow = false;
              if (parts.geometry !== undefined) mesh.setGeometry(geometries[parts.geometry as number]);
              applyMaterial(mesh, parts.material, parts.sharedMaterial, materials);
            } catch (error) {
              // loadWorld undoes what create returned, and this one never was.
              mesh.dispose();
              throw error;
            }
          }
          return mesh;
        },
        link(mesh, entity, get) {
          const node = entity.components.node;
          let parent = entity.parent === undefined ? null : get(entity.parent);
          if (node !== undefined) {
            const target = parent ? modelOf.get(parent)?.nodes[node as number] : undefined;
            if (!target) throw new TypeError(`Entity '${entity.id}' node: ${node} is not a node of '${entity.parent}'; has the model changed since the save?`);
            parent = target;
          }
          mesh.setParent(parent);
          onEntity?.(mesh, entity, get);
        },
        commit(built) {
          applyPlugins(engine, scene, wanted, named, plugins);
          // Nothing below can fail: every value was checked before the first model loaded.
          for (const [id, mesh] of built) {
            ids.set(mesh, id);
            mesh.visible = shown.get(mesh)!;
          }
          fresh.clear();
          const { lighting, background } = state;
          if (lighting) {
            scene.lighting.direction.set(lighting.direction);
            scene.lighting.radiance.set(lighting.radiance);
            scene.lighting.ambient.set(lighting.ambient);
          }
          if (background !== undefined) scene.background = background;
          if (camera && state.camera) {
            engine.camera.cancelFit();
            Object.assign(engine.camera, state.camera);
          }
          for (const model of oldModels) model.dispose();
          for (const mesh of leaving.reverse()) mesh.dispose();
        },
        // A model's root goes with the model, below.
        destroy(mesh) {
          if (!modelOf.has(mesh)) mesh.dispose();
        },
      },
      checks,
    );
  } catch (error) {
    release();
    throw error;
  }
  const { engine: _own, ...meta } = current.meta ?? {};
  return { meshes: handles, models, meta };
}
