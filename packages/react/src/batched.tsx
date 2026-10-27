import { createContext, forwardRef, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import type { ColorInput, Vec3 } from '@margoengine/math';
import type { Material, MeshGeometry } from '@margoengine/materials';
import type { BatchedMesh as Batch, BatchedMeshOptions } from '@margoengine/materials/batched';
import { MargoError } from '@margoengine/math/errors';
import { composeMatrix } from '@margoengine/math/mat4';
import { eulerToQuaternion } from '@margoengine/math/quat';
import { useCommit, useCreated, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

interface ErrorProps {
  /** Loading the optional package or attaching failed. */
  onError?: (error: unknown) => void;
}

const BatchContext = createContext<Batch | null>(null);
/** Props of `<BatchedMesh>`: its fixed capacity, an optional material, and `<BatchedItem>` children. */
export interface BatchedMeshProps extends BatchedMeshOptions, ErrorProps {
  /** The batch's `@margoengine/materials` material. Default a plain PBR material that shows vertex colours. */
  material?: Material;
  /** Draw the batch into the Canvas shadows, once a `<Shadows>` (`@margoengine/react/shadows`) turns them on. Default false. */
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
