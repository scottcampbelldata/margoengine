import { Children, forwardRef, useCallback, useMemo, useState, type ReactNode } from 'react';
import type { Mesh as MeshHandle, Vec3 } from '@margoengine/core';
import type { LOD, LODSystem } from '@margoengine/lod';
import { Mesh } from './components.js';
import { useCreated, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { attachBinding, detachBinding } from './package-binding.js';

/** Distance thresholds, hysteresis and transform for the child detail levels. */
export interface DetailedProps {
  /** One increasing distance per child; first is ignored (usually 0). World units. */
  distances: readonly number[];
  /** Fraction by which the switch shrinks when returning to a finer level. Default 0.1. */
  hysteresis?: number;
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  children: ReactNode;
  onError?: (error: unknown) => void;
}
const owners = new WeakMap<LOD, LODSystem>();
/** Switch between child groups by distance. Each child may contain any number of nested meshes or models. */
export const Detailed = forwardRef<LOD, DetailedProps>(function Detailed(
  { distances, hysteresis = 0.1, position, rotation, scale, children, onError },
  ref,
) {
  const scene = useScene(),
    items = Children.toArray(children),
    count = items.length;
  if (!count || count !== distances.length)
    throw new RangeError('Detailed needs one distance per child and at least one child.');
  const [anchor, setAnchor] = useState<MeshHandle | null>(null),
    [levels, setLevels] = useState<ReadonlyMap<number, MeshHandle>>(new Map());
  const register = useCallback((index: number, mesh: MeshHandle | null) => {
    setLevels((old) => {
      if (old.get(index) === mesh || (!mesh && !old.has(index))) return old;
      const next = new Map(old);
      if (mesh) next.set(index, mesh);
      else next.delete(index);
      return next;
    });
  }, []);
  const ready = anchor && levels.size === count;
  const bind = ready ? (
    <DetailedBinding
      scene={scene}
      anchor={anchor}
      levels={levels}
      distances={distances}
      hysteresis={hysteresis}
      onError={onError}
      ref={ref}
    />
  ) : null;
  return (
    <Mesh position={position} rotation={rotation} scale={scale} ref={setAnchor}>
      {items.map((child, index) => (
        <Level key={(child as { key?: string }).key ?? index} index={index} register={register}>
          {child}
        </Level>
      ))}
      {bind}
    </Mesh>
  );
});
const DetailedBinding = forwardRef<
  LOD,
  {
    scene: ReturnType<typeof useScene>;
    anchor: MeshHandle;
    levels: ReadonlyMap<number, MeshHandle>;
    distances: readonly number[];
    hysteresis: number;
    onError?: (error: unknown) => void;
  }
>(function DetailedBinding({ scene, anchor, levels, distances, hysteresis, onError }, ref) {
  useCreated(
    scene,
    {
      load: () => optionalPeer('@margoengine/lod', () => import('@margoengine/lod')),
      create: (api) => {
        const system = attachBinding(scene, new api.LODSystem({ hysteresis }));
        try {
          const lod = system.add(
            anchor,
            distances.map((distance, index) => ({ object: levels.get(index)!, distance })),
          );
          owners.set(lod, system);
          return lod;
        } catch (error) {
          detachBinding(scene, system);
          throw error;
        }
      },
      dispose: (lod) => {
        lod.remove();
        detachBinding(scene, owners.get(lod)!);
      },
      ref,
      onError,
    },
    [scene.world, anchor, levels, distances.join(), hysteresis],
  );
  return null;
});
function Level({
  index,
  register,
  children,
}: {
  index: number;
  register: (index: number, mesh: MeshHandle | null) => void;
  children: ReactNode;
}) {
  const ref = useMemo(() => (mesh: MeshHandle | null) => register(index, mesh), [index, register]);
  return <Mesh ref={ref}>{children}</Mesh>;
}
