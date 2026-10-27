import { useEffect, useRef } from 'react';
import type { Mesh as MeshHandle } from '@margoengine/core';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import { live, report, useMesh, useScene } from './internal.js';

/**
 * Adds the enclosing mesh to the Canvas shadows while mounted (`castShadow` puts it in the shadow map,
 * `receiveShadow: false` leaves it unshadowed), following the mesh when it is recreated. It does nothing until a
 * `<Shadows>` (`@margoengine/react/shadows`) turns the Canvas shadows on, so `castShadow` alone loads no package.
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
