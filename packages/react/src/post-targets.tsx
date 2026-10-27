import { forwardRef, useRef } from 'react';
import type { EngineKernel } from '@margoengine/core';
import type { DepthTexture as DepthPlugin, DepthTextureOptions } from '@margoengine/post/depth';
import type { SceneTargets as TargetsPlugin, SceneTargetsOptions } from '@margoengine/post/mrt';
import { useCommit, useCreated, useModelSources, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

interface ErrorProps {
  /** Loading the optional package or attaching failed. */
  onError?: (error: unknown) => void;
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
