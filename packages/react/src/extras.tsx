'use client';
import { createContext, forwardRef, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import type { ColorInput, Vec3 } from '@margoengine/math';
import type { Material, MeshGeometry } from '@margoengine/materials';
import type { BatchedMesh as Batch, BatchedMeshOptions } from '@margoengine/materials/batched';
import type { DepthTexture as DepthPlugin, DepthTextureOptions } from '@margoengine/post/depth';
import type { SceneTargets as TargetsPlugin, SceneTargetsOptions } from '@margoengine/post/mrt';
import type { SectionOptions, SectionPlanes as SectionPlugin } from '@margoengine/machinery/section';
import { MargoError } from '@margoengine/math/errors';
import { composeMatrix } from '@margoengine/math/mat4';
import { eulerToQuaternion } from '@margoengine/math/quat';
import { useCommit, useCreated, useScene, type Scene } from './internal.js';
import { optionalPeer } from './optional.js';

type Model = Scene['resources']['models'] extends Set<infer T> ? T : never;
interface ErrorProps {
  /** Loading the optional package or attaching failed. */
  onError?: (error: unknown) => void;
}

// Keeps `effect` given every live PBR model of the Canvas, now and as they load or unmount (the SSAO pattern).
function useModelSources(scene: Scene, effect: { add(model: never): () => void } | null): void {
  useCommit(() => {
    if (!effect) return;
    const added = new Map<Model, () => void>();
    const sync = () => {
      for (const [model, remove] of added)
        if (!scene.resources.models.has(model) || model.disposed) {
          remove();
          added.delete(model);
        }
      for (const model of scene.resources.models)
        if (!model.disposed && !added.has(model)) added.set(model, effect.add(model as never));
    };
    sync();
    scene.frames.callbacks.add(sync);
    return () => {
      scene.frames.callbacks.delete(sync);
      for (const remove of added.values()) remove();
    };
  }, [scene, effect]);
}

const BatchContext = createContext<Batch | null>(null);
/** Props of `<BatchedMesh>`: its fixed capacity, an optional material, and `<BatchedItem>` children. */
export interface BatchedMeshProps extends BatchedMeshOptions, ErrorProps {
  /** The batch's `@margoengine/materials` material. Default a plain PBR material that shows vertex colours. */
  material?: Material;
  /** Draw the batch into the Canvas shadows. Default false. */
  castShadow?: boolean;
  children?: ReactNode;
}
/**
 * Many different geometries drawn in one draw call per pass (`@margoengine/materials`' BatchedMesh): put a
 * `<BatchedItem>` per object inside. Capacity (`maxItems`, `maxVertices`, `maxIndices`), `renderOrder` and `material`
 * are fixed: changing one recreates the batch. The ref is the live BatchedMesh. WebGPU only.
 */
export const BatchedMesh = forwardRef<Batch, BatchedMeshProps>(function BatchedMesh(
  { maxItems, maxVertices, maxIndices, renderOrder, material, castShadow = false, children, onError },
  ref,
) {
  const scene = useScene();
  const batch = useCreated<
    [typeof import('@margoengine/materials/batched'), typeof import('@margoengine/materials')],
    Batch
  >(
    scene,
    {
      load: () =>
        Promise.all([
          optionalPeer('@margoengine/materials', () => import('@margoengine/materials/batched')),
          optionalPeer('@margoengine/materials', () => import('@margoengine/materials')),
        ]),
      create: ([api, materials]) =>
        api.BatchedMesh.attach(scene.engine as unknown as EngineKernel, material ?? new materials.Material(), {
          maxItems,
          maxVertices,
          maxIndices,
          renderOrder,
        }),
      dispose: (value) => value.dispose(),
      ref,
      onError,
    },
    [maxItems, maxVertices, maxIndices, renderOrder, material],
  );
  useEffect(() => {
    if (castShadow) return scene.requestShadows();
  }, [scene.requestShadows, castShadow]);
  useEffect(() => {
    if (castShadow && batch && scene.shadows) return scene.shadows.add(batch.mesh as unknown as MeshHandle);
  }, [batch, scene.shadows, castShadow]);
  return <BatchContext.Provider value={batch}>{batch && children}</BatchContext.Provider>;
});

/** Props of `<BatchedItem>`: one object of the enclosing `<BatchedMesh>`. */
export interface BatchedItemProps {
  /** Its geometry; a new object adds the item again (its vertices are copied into the batch once). */
  geometry: MeshGeometry;
  /** World units, relative to the batch's root. Ignored when `matrix` is given. */
  position?: Vec3;
  /** XYZ Euler angles in radians, as `Mesh`. */
  rotation?: Vec3;
  scale?: Vec3;
  /** Column-major 4x4 matrix, in place of position, rotation and scale. */
  matrix?: ArrayLike<number>;
  /** Tint multiplied into the geometry's vertex colours. Default white. */
  color?: ColorInput;
  /** Default true. */
  visible?: boolean;
}
const scratch = new Float64Array(16);
/** One object in a `<BatchedMesh>`: moving, tinting or hiding it costs a few floats of upload, no React render. */
export function BatchedItem({
  geometry,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = [1, 1, 1],
  matrix,
  color = '#ffffff',
  visible = true,
}: BatchedItemProps): null {
  const batch = useContext(BatchContext);
  if (!batch) throw new MargoError('state', 'BatchedItem is outside a BatchedMesh; render it inside <BatchedMesh>');
  const id = useRef<number | null>(null),
    transform = (): ArrayLike<number> =>
      matrix ?? composeMatrix(position, eulerToQuaternion(rotation[0], rotation[1], rotation[2]), scale, scratch);
  useCommit(() => {
    const item = batch.add(geometry, { matrix: transform(), color, visible });
    id.current = item;
    return () => {
      id.current = null;
      batch.remove(item);
    };
  }, [batch, geometry]);
  useCommit(() => {
    if (id.current === null) return;
    batch.setMatrix(id.current, transform());
  }, [batch, matrix, ...position, ...rotation, ...scale]);
  useCommit(() => {
    if (id.current !== null) batch.setColor(id.current, color).setVisible(id.current, visible);
  }, [batch, typeof color === 'object' ? color.join() : color, visible]);
  return null;
}

/** Props of `<DepthTexture>`. */
export interface DepthTextureProps extends DepthTextureOptions, ErrorProps {
  /** Called whenever the textures are replaced (resize, device restore) with the live DepthTexture. */
  onResize?: (depth: DepthPlugin) => void;
}
/**
 * The scene's depth as textures for your own passes and materials (`@margoengine/post`'s DepthTexture): the ref
 * is the live plugin, whose `texture` (reversed-Z depth) and `distance` (world distance) follow resizes. PBR models in
 * the Canvas are added for you. `order` is fixed. WebGPU only.
 */
export const DepthTexture = forwardRef<DepthPlugin, DepthTextureProps>(function DepthTexture(
  { order, onResize, onError },
  ref,
) {
  const scene = useScene(),
    resized = useRef(onResize);
  resized.current = onResize;
  const depth = useCreated(
    scene,
    {
      load: () => optionalPeer('@margoengine/post/depth', () => import('@margoengine/post/depth')),
      create: (api) => api.DepthTexture.attach(scene.engine as unknown as EngineKernel, { order }),
      dispose: (value) => value.dispose(),
      ref,
      onError,
    },
    [order],
  );
  useModelSources(scene, depth);
  useCommit(() => {
    if (depth) return depth.onResize(() => resized.current?.(depth));
  }, [depth]);
  return null;
});

/** Props of `<SceneTargets>`. */
export interface SceneTargetsProps extends SceneTargetsOptions, ErrorProps {}
/**
 * Extra render targets written in one scene pass (multiple render targets, `@margoengine/post`'s SceneTargets):
 * `outputs` names each one (`'albedo'`, `'normal'`, `'position'`, `'distance'`, `'emissive'`, `'material'` or your
 * own WGSL). The ref is the live plugin: `texture(name)` and `depth`. PBR models are added for you. Changing `outputs`
 * (by value) or `order` recreates the targets. WebGPU only.
 */
export const SceneTargets = forwardRef<TargetsPlugin, SceneTargetsProps>(function SceneTargets(
  { outputs, order, onError },
  ref,
) {
  const scene = useScene(),
    key = JSON.stringify(outputs),
    latest = useRef(outputs);
  latest.current = outputs;
  const targets = useCreated(
    scene,
    {
      load: () => optionalPeer('@margoengine/post/mrt', () => import('@margoengine/post/mrt')),
      create: (api) =>
        api.SceneTargets.attach(scene.engine as unknown as EngineKernel, { outputs: latest.current, order }),
      dispose: (value) => value.dispose(),
      ref,
      onError,
    },
    [key, order],
  );
  useModelSources(scene, targets);
  return null;
});

/** Props of `<SectionPlanes>`. */
export interface SectionPlanesProps extends SectionOptions, ErrorProps {
  /** Clip while true; switching does not recompile. Default true. */
  enabled?: boolean;
}
/**
 * Cuts the scene with up to 6 planes `[a, b, c, d]` (points with a x + b y + c z + d < 0 are cut away) and caps the
 * cut faces of closed solids (`@margoengine/machinery`'s SectionPlanes). Plane values update every frame from the
 * props; the number of planes, `cap`, `capOpenShells`, `color` and `hatch` are fixed and recreate it when changed.
 * WebGPU only.
 */
export const SectionPlanes = forwardRef<SectionPlugin, SectionPlanesProps>(function SectionPlanes(
  { planes, enabled = true, cap, capOpenShells, color, hatch, onError },
  ref,
) {
  const scene = useScene(),
    latest = useRef(planes);
  latest.current = planes;
  const section = useCreated(
    scene,
    {
      load: () => optionalPeer('@margoengine/machinery', () => import('@margoengine/machinery/section')),
      create: (api) =>
        api.SectionPlanes.attach(scene.engine as unknown as EngineKernel, {
          planes: latest.current,
          cap,
          capOpenShells,
          color,
          hatch,
        }),
      dispose: (value) => value.dispose(),
      ref,
      onError,
    },
    [planes.length, cap, capOpenShells, typeof color === 'object' ? color?.join() : color, hatch],
  );
  useCommit(() => {
    if (!section) return;
    section.options.planes = planes;
    section.enabled = enabled;
  });
  return null;
});
