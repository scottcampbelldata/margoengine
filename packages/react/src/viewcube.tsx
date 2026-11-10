import { forwardRef } from 'react';
import type { EngineKernel } from '@margoengine/core';
import type { ViewCube, ViewCubeOptions } from '@margoengine/viewcube';
import { useCreated, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

/** Native view-cube navigation and appearance options. */
export interface GizmoHelperProps extends ViewCubeOptions {
  onError?: (error: unknown) => void;
}
/** Interactive view cube with face/edge/corner navigation, drag orbit, roll and projection controls. */
export const GizmoHelper = forwardRef<ViewCube, GizmoHelperProps>(function GizmoHelper({ onError, ...options }, ref) {
  const scene = useScene();
  useCreated(
    scene,
    {
      load: () => optionalPeer('@margoengine/viewcube', () => import('@margoengine/viewcube')),
      create: (api) => api.ViewCube.attach(scene.engine as unknown as EngineKernel, options),
      dispose: (cube) => cube.dispose(),
      ref,
      onError,
    },
    [
      options.container,
      options.view,
      options.corner,
      options.size,
      options.duration,
      options.projection,
      JSON.stringify(options.labels),
      options.flip,
      options.drag,
      JSON.stringify(options.home),
      options.roll,
      JSON.stringify(options.theme),
    ],
  );
  return null;
});
