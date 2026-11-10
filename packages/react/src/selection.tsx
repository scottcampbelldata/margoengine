import { forwardRef, type RefObject } from 'react';
import type { Mesh } from '@margoengine/core';
import type { Selection, SelectionOptions, ModelLike } from '@margoengine/selection';
import { useCommit, useCreated, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { attachBinding, detachBinding } from './package-binding.js';

type Selected = Mesh | ModelLike;
/** A selected set (or the enclosing Mesh) and the native outline appearance. */
export interface OutlineProps extends Omit<SelectionOptions, 'name'> {
  /** Live meshes/models or their refs. Default: the enclosing Mesh. Empty clears the outline. */
  selection?: readonly (Selected | RefObject<Selected | null>)[];
  onError?: (error: unknown) => void;
}
let serial = 0;
/** Outline a selection with jump flooding or morphology, including optional dashed hidden edges. */
export const Outline = forwardRef<Selection, OutlineProps>(function Outline({ selection, onError, ...options }, ref) {
  const scene = useScene();
  const effect = useCreated(
    scene,
    {
      load: () => optionalPeer('@margoengine/selection', () => import('@margoengine/selection')),
      create: (api) => attachBinding(scene, new api.Selection({ ...options, name: `react-outline:${++serial}` })),
      dispose: (value) => detachBinding(scene, value),
      ref,
      onError,
    },
    [scene.world, JSON.stringify(options)],
  );
  useCommit(() => {
    if (!effect) return;
    const sync = () => {
      const values = selection ?? (scene.registry?.current ? [scene.registry.current as unknown as Mesh] : []);
      effect.set(
        values.map((value) => ('current' in value ? value.current : value)).filter((v): v is Selected => v !== null),
      );
    };
    sync();
    scene.frames.callbacks.add(sync);
    return () => {
      scene.frames.callbacks.delete(sync);
    };
  }, [effect, scene.registry, scene.frames, selection]);
  return null;
});
