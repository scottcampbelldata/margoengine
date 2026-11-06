/// <reference lib="esnext.disposable" preserve="true" />
import type { Clustered, PointLight, SpotLight } from '@margoengine/clustered';
import type { CameraOptions, Mesh } from '@margoengine/core';
import type { Engine as RuntimeEngine, Mesh as RuntimeMesh } from '@margoengine/core/extension';
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
  /** Frame the camera on what loaded. Default true, or false when the document's `camera` sets the view. */
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
  /** Each `camera` component in world space, by entity id: `Object.assign(stage.engine.camera, cameras.get(id))` switches. */
  readonly cameras: ReadonlyMap<string, Required<CameraOptions>>;
  /** The `Clustered` holding the scene's point and spot lights, for `add`ing more receivers. Undefined when it has none. */
  readonly lights: Clustered | undefined;
  /** The document's `meta`. */
  readonly meta: Readonly<Record<string, Json>>;
  /** Removes every mesh, model and light of the scene and puts the sun back. The camera stays where it is. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/** A `light` component. Names and defaults are `KHR_lights_punctual`'s; a light shines down its entity's -Z. */
export interface SceneLight {
  /** Default `'directional'`. The first directional light of a scene is the engine's sun. */
  type?: 'directional' | 'point' | 'spot';
  /** Linear RGB. Default `[1, 1, 1]`. */
  color?: [number, number, number];
  /** Default 1. */
  intensity?: number;
  /** Point and spot. Default where inverse-square light falls under 1/256, as gltf-pro gives a light with none. */
  range?: number;
  /** Spot, radians. Default 0. */
  innerConeAngle?: number;
  /** Spot, radians, up to pi / 2. Default pi / 4. */
  outerConeAngle?: number;
  /** The sun's ambient strength. Default the engine's. */
  ambient?: number;
}

type Placement = Pick<MeshOptions, 'position' | 'scale' | 'name'>;
/** Keys a document's `mesh` and `material` may not set: where a mesh goes is the transform's and the parent's job. */
const placement = ['position', 'rotation', 'scale', 'name', 'parent', 'scene'];
const look = (value: Record<string, Json> | undefined): Record<string, Json> =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !placement.includes(key)));
const record = (value: unknown): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const vector = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every(Number.isFinite);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const lightOf = (entity: ResolvedEntity) => entity.components.light as unknown as SceneLight;

/** Refuses a `light` before anything loads. */
function checkLight(entity: ResolvedEntity): void {
  const light = entity.components.light,
    wrong = (text: string) => typeError(`Entity '${entity.id}' light: ${text}`, 'arguments');
  if (!record(light)) throw wrong("{ type: 'directional', 'point' or 'spot', color, intensity }");
  const { type = 'directional', color, intensity, range, innerConeAngle = 0, outerConeAngle = Math.PI / 4, ambient } = light,
    inner = innerConeAngle as number,
    outer = outerConeAngle as number;
  if (type !== 'directional' && type !== 'point' && type !== 'spot') throw wrong("type: 'directional', 'point' or 'spot'");
  if (color !== undefined && !(vector(color, 3) && color.every((v) => v >= 0))) throw wrong('color: [r, g, b], linear, 0 or more');
  if (intensity !== undefined && !(typeof intensity === 'number' && intensity >= 0)) throw wrong('intensity: 0 or more');
  if (range !== undefined && !positive(range)) throw wrong('range: more than 0');
  if (ambient !== undefined && !(type === 'directional' && typeof ambient === 'number' && ambient >= 0))
    throw wrong('ambient: 0 or more, on a directional light');
  if (type === 'spot' && !(inner >= 0 && inner < outer && outer <= Math.PI / 2))
    throw wrong('0 <= innerConeAngle < outerConeAngle <= pi / 2, in radians');
}

/** Refuses a `camera` before anything loads. */
function checkCamera(entity: ResolvedEntity): void {
  const camera = entity.components.camera,
    wrong = (text: string) => typeError(`Entity '${entity.id}' camera: ${text}`, 'arguments');
  if (!record(camera)) throw wrong('{ fov, near, far, target, active }');
  const { fov, near, far, target, active } = camera;
  if (fov !== undefined && !(positive(fov) && fov < 180)) throw wrong('fov: degrees, between 0 and 180');
  if (near !== undefined && !positive(near)) throw wrong('near: more than 0');
  if (far !== undefined && !(positive(far) && far > ((near as number) ?? 0))) throw wrong('far: more than near');
  if (target !== undefined && !vector(target, 3)) throw wrong('target: [x, y, z]');
  if (active !== undefined && typeof active !== 'boolean') throw wrong('active: boolean');
}

/** Where an entity's mesh is and which way it faces in the world: glTF's rule, a light or camera looks down its -Z. */
function pose(mesh: Mesh): { position: [number, number, number]; forward: [number, number, number] } {
  const m = (mesh as unknown as RuntimeMesh).matrix,
    length = Math.hypot(m[8], m[9], m[10]) || 1;
  return { position: [m[12], m[13], m[14]], forward: [-m[8] / length, -m[9] / length, -m[10] / length] };
}

/** What each scene put on a shared light list, so that two scenes add up and one leaves without taking the other's. */
const held = new WeakMap<object, Set<unknown[]>>();
function hold<T>(list: { setLights(lights: T[]): unknown }, own: T[]): () => void {
  const all = (held.get(list) ?? new Set()) as Set<T[]>;
  held.set(list, all as Set<unknown[]>);
  all.add(own);
  list.setLights([...all].flat());
  return () => {
    all.delete(own);
    list.setLights([...all].flat());
  };
}

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
 * once per URL, or `{shape: 'box', size}` or `{shape: 'sphere', radius, segments}`), `material`
 * (`{color, roughness, metalness}`), `light` (`{type, color, intensity, range, innerConeAngle, outerConeAngle, ambient}`)
 * and `camera` (`{fov, near, far, target, active}`);
 * `onEntity` takes the rest. Rejects with `Install <package>` when one is missing, TypeError for an invalid document,
 * MargoError `'failed'` with the `cause` when a step fails, and AbortError when `signal` aborts or the stage is disposed
 * first; nothing stays built.
 * @example const level = await addScene(stage, '/levels/one.json');
 */
export async function addScene(
  stage: Stage,
  source: string | URL | SaveDocument | ArrayBuffer | ArrayBufferView,
  { migrations, prefab, parent, base, fit, onEntity, gltf, signal, ...checks }: AddSceneOptions = {},
): Promise<LoadedScene> {
  if (fit !== undefined && typeof fit !== 'boolean') throw typeError('fit: boolean', 'arguments');
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
    wanted = entities.filter((entity) => typeof entity.components.mesh === 'string'),
    lit = entities.filter((entity) => entity.components.light !== undefined),
    viewed = entities.filter((entity) => entity.components.camera !== undefined);
  lit.forEach(checkLight);
  viewed.forEach(checkCamera);
  // Core has one sun: the first directional light. The rest of the lights are clustered ones.
  const suns = lit.filter((entity) => (lightOf(entity).type ?? 'directional') === 'directional'),
    local = lit.filter((entity) => !suns.includes(entity)),
    clustered =
      local.length || suns.length > 1
        ? await optionalPackage('@margoengine/clustered', () => import('@margoengine/clustered'), abort)
        : undefined,
    directional =
      suns.length > 1
        ? await optionalPackage('@margoengine/clustered', () => import('@margoengine/clustered/directional'), abort)
        : undefined;
  const models = new Map<string, PBRModel>(),
    // The stage's disposal already took every model with the engine.
    release = (): void => {
      if (!stage.signal.aborted) for (const model of models.values()) model.dispose();
      models.clear();
    };
  if (wanted.length) {
    const byURL = new Map<string, ResolvedEntity[]>();
    for (const entity of wanted) {
      const url = new URL(entity.components.mesh as string, root).href;
      byURL.set(url, [...(byURL.get(url) ?? []), entity]);
    }
    const { loadGLTF } = await optionalPackage('@margoengine/gltf-pro', () => import('@margoengine/gltf-pro'), abort),
      groups = [...byURL.values()],
      loads = await Promise.allSettled(
        [...byURL.keys()].map((url) => loadGLTF(stage.engine, new URL(url), { ...gltf, signal: abort })),
      );
    loads.forEach((load, index) => {
      if (load.status === 'fulfilled') models.set(groups[index][0].id, load.value);
    });
    const failed = loads.find((load) => load.status === 'rejected');
    if (failed) {
      release();
      throw failed.reason;
    }
    // One asset per URL: a copy shares its parsed file, images and GPU buffers with the first, and has nodes of its own.
    if (groups.some((group) => group.length > 1)) {
      try {
        const { cloneModel } = await optionalPackage(
          '@margoengine/animation',
          () => import('@margoengine/animation/skeleton-utils'),
          abort,
        );
        for (const [first, ...rest] of groups)
          for (const entity of rest) {
            abort.throwIfAborted();
            models.set(entity.id, await cloneModel(models.get(first.id)!));
          }
      } catch (error) {
        release();
        throw error;
      }
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
    undo: (() => void)[] = [],
    dispose = (): void => {
      if (stage.signal.aborted) return;
      for (const step of undo.splice(0).reverse()) step();
      release();
      for (const mesh of built.splice(0)) mesh.dispose();
    };
  const shown = [...meshes.values(), ...[...models.values()].flatMap((model) => model.nodes)],
    cameras = new Map<string, Required<CameraOptions>>(),
    runtime = stage.engine as unknown as RuntimeEngine;
  let lights: Clustered | undefined;
  try {
    if (lit.length || viewed.length) runtime.store.tick(false);
    const camera = stage.engine.camera;
    for (const entity of viewed) {
      const { fov = camera.fov, near = camera.near, far = camera.far, target } = entity.components.camera as CameraOptions,
        { position, forward } = pose(meshes.get(entity.id)!);
      cameras.set(entity.id, {
        fov,
        near,
        far,
        position,
        target: target ?? (position.map((v, i) => v + forward[i] * 10) as [number, number, number]),
      });
    }
    const active = (wanted: boolean | undefined) =>
        viewed.find((entity) => (entity.components.camera as Record<string, Json>).active === wanted),
      chosen = active(true) ?? active(undefined);
    if (chosen) Object.assign(camera, cameras.get(chosen.id));
    const [sun, ...more] = suns;
    if (sun) {
      const { direction, radiance } = runtime.lighting,
        was = [direction.slice(), radiance.slice()],
        { color = [1, 1, 1], intensity = 1, ambient = radiance[3] } = lightOf(sun),
        { forward } = pose(meshes.get(sun.id)!);
      undo.push(() => {
        direction.set(was[0]);
        radiance.set(was[1]);
      });
      direction.set([-forward[0], -forward[1], -forward[2], intensity]);
      radiance.set([...color, ambient]);
    }
    if (clustered) {
      lights = (runtime.plugins.get('clustered') as Clustered | undefined) ?? clustered.Clustered.attach(stage.engine);
      for (const model of models.values()) undo.push(lights.add(model));
      undo.push(
        hold<PointLight | SpotLight>(
          lights,
          local.map((entity) => {
            const { type, color = [1, 1, 1], intensity = 1, range, innerConeAngle = 0, outerConeAngle = Math.PI / 4 } = lightOf(entity),
              { position, forward } = pose(meshes.get(entity.id)!),
              // The range gltf-pro gives a light with none: where inverse-square light falls under 1/256.
              place = { position, color, intensity, range: range ?? (Math.sqrt(intensity * 256) || 1) };
            return type === 'spot'
              ? { ...place, direction: forward, innerAngle: innerConeAngle, outerAngle: outerConeAngle }
              : place;
          }),
        ),
      );
    }
    if (directional)
      undo.push(
        hold(
          (runtime.plugins.get('clustered:directional') as InstanceType<typeof directional.DirectionalLights> | undefined) ??
            directional.DirectionalLights.attach(stage.engine, { lights: lights! }),
          more.map((entity) => {
            const { color = [1, 1, 1], intensity = 1 } = lightOf(entity);
            return { direction: pose(meshes.get(entity.id)!).forward, color, intensity };
          }),
        ),
      );
    if ((fit ?? !chosen) && shown.some((mesh) => mesh.geometry)) stage.fit(shown);
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    meshes,
    models,
    cameras,
    lights,
    meta: document.meta ?? {},
    dispose,
    [Symbol.dispose ?? Symbol()]: dispose,
  } as LoadedScene;
}
