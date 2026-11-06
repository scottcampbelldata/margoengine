/// <reference lib="esnext.disposable" preserve="true" />
import type { Mesh } from '@margoengine/core';
import type { GLTFLoadOptions, PBRModel } from '@margoengine/gltf-pro';
import type { Json, Migrations, ResolvedEntity, SaveDocument, ValidateOptions } from '@margoengine/save';
import type { MeshOptions, Stage } from './index.js';
import { optionalPackage, stageSignal } from './feature.js';
import { fault, typeError } from '../../shared/errors.js';

/** Options for `addScene`. */
export interface AddSceneOptions extends ValidateOptions {
  /** Brings an older document to the current schema version before it loads. */
  migrations?: Migrations;
  /** Load only this prefab of the document, as one instance. Default the document's entities. */
  prefab?: string;
  /** Mesh the scene's top-level entities go under. Default none (root meshes). */
  parent?: Mesh;
  /** Base of relative model URLs. Default the document's URL, or the page's. */
  base?: string | URL;
  /** Frame the camera on what loaded. Default true. */
  fit?: boolean;
  /**
   * Called once per entity after all exist, for your own components. `get(id)` gives another entity's
   * mesh, for `{"$ref": id}` values. A throw undoes the whole load.
   */
  onEntity?: (mesh: Mesh, entity: ResolvedEntity, get: (id: string) => Mesh) => void;
  /** `loadGLTF` options for the models, such as a shared `draco` decoder. */
  gltf?: Omit<GLTFLoadOptions, 'signal'>;
  /** Cancels the load; the stage's disposal cancels it too. */
  signal?: AbortSignal;
}

/** What `addScene` returns. */
export interface LoadedScene {
  /** One mesh per entity, by entity id. */
  readonly meshes: ReadonlyMap<string, Mesh>;
  /** The glTF models, by the id of the entity that holds each. */
  readonly models: ReadonlyMap<string, PBRModel>;
  /** The document's `meta`. */
  readonly meta: Readonly<Record<string, Json>>;
  /** Removes every mesh and model of the scene. */
  dispose(): void;
  [Symbol.dispose](): void;
}

type Placement = Pick<MeshOptions, 'position' | 'scale' | 'name'>;
/** Keys a document's `mesh` and `material` may not set: where a mesh goes is the transform's and the parent's job. */
const placement = ['position', 'rotation', 'scale', 'name', 'parent', 'scene'];
const look = (value: Record<string, Json> | undefined): Record<string, Json> =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !placement.includes(key)));
const record = (value: unknown): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Builds an entity's mesh from its `mesh` and `material` components. */
function build(stage: Stage, entity: ResolvedEntity): Mesh {
  const { mesh: source, material } = entity.components,
    { position, scale } = entity.transform ?? {},
    place: Placement = { name: entity.name ?? '', ...(position && { position }), ...(scale && { scale }) };
  if (material !== undefined && !record(material))
    throw typeError(`Entity '${entity.id}' material: { color, roughness, metalness }`, 'arguments');
  let mesh: Mesh;
  if (record(source) && source.shape === 'box')
    mesh = stage.box({ ...look(material), ...look(source), ...place } as MeshOptions);
  else if (record(source) && source.shape === 'sphere')
    mesh = stage.sphere({ ...look(material), ...look(source), ...place } as MeshOptions);
  else if (source === undefined || typeof source === 'string') {
    mesh = stage.engine.createMesh();
    mesh.name = place.name!;
    if (position) mesh.setPosition(position);
    if (scale) mesh.setScale(scale);
  } else throw typeError(`Entity '${entity.id}' mesh: a model URL, { shape: 'box' } or { shape: 'sphere' }`, 'arguments');
  if (entity.transform?.rotation) mesh.setQuaternion(entity.transform.rotation);
  return mesh;
}

/**
 * Loads a `@margoengine/save` document into the stage: one mesh per entity with its transform and parent, prefabs
 * expanded, migrations run, all or nothing. `source` is a URL, a document, its JSON text or its bytes (gzip or not). A
 * string starting with `{` is JSON text. Built-in components: `mesh` (a glTF URL, loaded with `@margoengine/gltf-pro`,
 * or `{shape: 'box', size}` or `{shape: 'sphere', radius, segments}`) and `material` (`{color, roughness, metalness}`);
 * `onEntity` takes the rest. Rejects with `Install <package>` when one is missing, TypeError for an invalid document,
 * MargoError `'failed'` with the `cause` when a step fails, and AbortError when `signal` aborts or the stage is disposed
 * first; nothing stays built.
 * @example const level = await addScene(stage, '/levels/one.json');
 */
export async function addScene(
  stage: Stage,
  source: string | URL | SaveDocument | ArrayBuffer | ArrayBufferView,
  { migrations, prefab, parent, base, fit = true, onEntity, gltf, signal, ...checks }: AddSceneOptions = {},
): Promise<LoadedScene> {
  if (typeof fit !== 'boolean') throw typeError('fit: boolean', 'arguments');
  const abort = stageSignal(stage, signal);
  abort.throwIfAborted();
  const save = await optionalPackage('@margoengine/save', () => import('@margoengine/save'), abort);
  const text = typeof source === 'string' && source.trimStart().startsWith('{'),
    page = globalThis.location?.href,
    address = source instanceof URL || (typeof source === 'string' && !text) ? new URL(source, page) : null;
  let input: unknown = source;
  if (address) {
    const response = await fetch(address, { signal: abort });
    if (!response.ok) throw fault('failed', `Failed to load ${address}: HTTP ${response.status}; check the URL`);
    input = await save.decodeSave(new Uint8Array(await response.arrayBuffer()), { signal: abort });
  } else if (source instanceof ArrayBuffer) input = await save.decodeSave(new Uint8Array(source), { signal: abort });
  else if (ArrayBuffer.isView(source))
    input = await save.decodeSave(new Uint8Array(source.buffer, source.byteOffset, source.byteLength), { signal: abort });
  abort.throwIfAborted();
  // Migrate and expand first: every model must be on hand before the synchronous, all-or-nothing load starts.
  let document = migrations ? migrations.migrate(save.parseSave(input, {})) : save.parseSave(input, {});
  if (prefab !== undefined) {
    if (!document.prefabs || !Object.hasOwn(document.prefabs, prefab))
      throw typeError(`No prefab '${prefab}' in this document`, 'arguments');
    document = { ...document, entities: [{ id: prefab, prefab }] };
  }
  const entities = save.expandSave(save.parseSave(document, checks)),
    root = base ?? address ?? page,
    wanted = entities.filter((entity) => typeof entity.components.mesh === 'string');
  const models = new Map<string, PBRModel>(),
    // The stage's disposal already took every model with the engine.
    release = (): void => {
      if (!stage.signal.aborted) for (const model of models.values()) model.dispose();
      models.clear();
    };
  if (wanted.length) {
    const { loadGLTF } = await optionalPackage('@margoengine/gltf-pro', () => import('@margoengine/gltf-pro'), abort),
      loads = await Promise.allSettled(
        wanted.map((entity) =>
          loadGLTF(stage.engine, new URL(entity.components.mesh as string, root), { ...gltf, signal: abort }),
        ),
      );
    loads.forEach((load, index) => {
      if (load.status === 'fulfilled') models.set(wanted[index].id, load.value);
    });
    const failed = loads.find((load) => load.status === 'rejected');
    if (failed) {
      release();
      throw failed.reason;
    }
  }
  let meshes: Map<string, Mesh>;
  try {
    meshes = save.loadWorld(
      document,
      {
        create: (entity) => build(stage, entity),
        link(mesh, entity, get) {
          mesh.setParent(entity.parent === undefined ? (parent ?? null) : get(entity.parent));
          (models.get(entity.id)?.root as Mesh | undefined)?.setParent(mesh);
          onEntity?.(mesh, entity, get);
        },
        destroy: (mesh) => mesh.dispose(),
      },
      { ...checks, signal: abort },
    );
  } catch (error) {
    release();
    throw error;
  }
  const built = [...meshes.values()].reverse(),
    dispose = (): void => {
      if (stage.signal.aborted) return;
      release();
      for (const mesh of built.splice(0)) mesh.dispose();
    };
  const shown = [...meshes.values(), ...[...models.values()].flatMap((model) => model.nodes)];
  if (fit && shown.some((mesh) => mesh.geometry)) {
    try {
      stage.fit(shown);
    } catch (error) {
      dispose();
      throw error;
    }
  }
  return {
    meshes,
    models,
    meta: document.meta ?? {},
    dispose,
    [Symbol.dispose ?? Symbol()]: dispose,
  } as LoadedScene;
}
