import { useEffect, useRef } from 'react';
import type { Mesh as MeshHandle } from '@margoengine/core';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import type { ShadowOptions } from '@margoengine/shadows';
import { live, report, useCommit, useMesh, useScene } from './internal.js';

/** Live `@margoengine/shadows` options. `cascades` is fixed when the Canvas creates the shadows, so it is not here. */
export type ShadowsProps = Omit<ShadowOptions, 'cascades'>;
const saved = new WeakMap<object, Map<string, unknown>>();
/**
 * Turns on the Canvas's cascaded shadows for as long as it is mounted and sets their options (map size, distance,
 * bias, filter, fixed `bounds` or `frustum`). A prop that is removed again restores its default. Meshes cast with
 * `<Mesh castShadow>`, `<Box castShadow>` or `<Model castShadow>`. Needs WebGPU and `@margoengine/shadows`.
 */
export function Shadows(props: ShadowsProps): null {
  const scene = useScene();
  useEffect(() => scene.requestShadows(), [scene.requestShadows]);
  useCommit(() => {
    const shadows = scene.shadows;
    if (!shadows) return;
    const options = shadows.options as Record<string, unknown>,
      values = props as Record<string, unknown>;
    let defaults = saved.get(shadows);
    if (!defaults) saved.set(shadows, (defaults = new Map()));
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (!defaults.has(key)) defaults.set(key, options[key]);
      options[key] = value;
    }
    for (const [key, value] of defaults)
      if (values[key] === undefined) {
        if (value === undefined) delete options[key];
        else options[key] = value;
      }
  });
  return null;
}

/**
 * Adds the enclosing mesh to the Canvas shadows while mounted (`castShadow` puts it in the shadow map,
 * `receiveShadow: false` leaves it unshadowed), following the mesh when it is recreated.
 */
export function MeshShadows({
  castShadow = false,
  receiveShadow = true,
  onError,
}: {
  castShadow?: boolean;
  receiveShadow?: boolean;
  onError?: (error: unknown) => void;
}): null {
  const scene = useScene(),
    registry = useMesh(),
    error = useRef(onError),
    enabled = castShadow || !receiveShadow;
  error.current = onError;
  useEffect(() => {
    if (enabled) return scene.requestShadows();
  }, [scene.requestShadows, enabled]);
  useEffect(() => {
    if (!enabled || !scene.shadows) return;
    let remove: (() => void) | undefined;
    const attach = (mesh: EngineMesh) => {
      remove?.();
      remove = undefined;
      try {
        remove = scene.shadows!.add(mesh as unknown as MeshHandle, { castShadow, receiveShadow });
      } catch (cause) {
        report(scene, cause, error.current);
      }
    };
    registry.attachments.add(attach);
    const mesh = live(registry);
    if (mesh) attach(mesh);
    return () => {
      registry.attachments.delete(attach);
      remove?.();
    };
  }, [registry, scene.shadows, enabled, castShadow, receiveShadow]);
  return null;
}
