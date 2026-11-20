import { useContext, useEffect, useRef } from 'react';
import type { EngineKernel, FrameCallback } from '@margoengine/core';
import type { EnginePlugin, Mesh as EngineMesh } from '@margoengine/core/extension';
import type * as EnvironmentModule from '@margoengine/environment';
import type { ColorBackground, Environment as IBLEnvironment, EnvironmentBackground } from '@margoengine/environment';
import type { CubeCamera as NativeCubeCamera } from '@margoengine/environment/cube-camera';
import { descendant } from './cube-camera.js';
import { LightformerPending } from './lightformer.js';
import { live, report, useMesh, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

// Loaded by `<Environment>` only when it has children (import() in environment.tsx), so an app with an Environment
// and no children never downloads the capture binding.

let captures = 0;
type CaptureBackground = EnvironmentBackground | ColorBackground;
export interface CaptureSettings {
  src?: string;
  resolution: number;
  frames: number;
  near: number;
  far: number;
  onError?: (error: unknown) => void;
}
export interface Captured {
  environment: IBLEnvironment;
  api: typeof EnvironmentModule;
}

// EnvironmentCapture: `<Environment>`'s children captured into the environment the scene is lit by (drei's
// Environment children, with Lightformers as the studio lights). A native CubeCamera at the group's origin draws only
// the group (every other mesh excluded) over the `src` environment or black, then `Environment.create` processes the
// cube (prefiltered specular and SH irradiance) and later captures refresh it in place. The group is hidden in the
// main view and shown for its own capture only.
export function EnvironmentCapture({
  settings,
  source,
  publish,
}: {
  settings: CaptureSettings;
  source: IBLEnvironment | null;
  publish: (captured: Captured | null) => void;
}) {
  const scene = useScene(),
    registry = useMesh(),
    pending = useContext(LightformerPending)!,
    latest = useRef(settings),
    backdrop = useRef<CaptureBackground | null>(null);
  latest.current = settings;
  const { resolution, near, far } = settings,
    wantsSource = settings.src !== undefined;
  // What the capture draws behind the children: the src environment, else black.
  useEffect(() => {
    let active = true,
      value: CaptureBackground | undefined;
    if (wantsSource && !source) return;
    void optionalPeer('@margoengine/environment', () => import('@margoengine/environment'))
      .then((api) => {
        if (!active) return;
        value = source
          ? new api.EnvironmentBackground(source, { name: `${source.name}:capture-background` })
          : new api.ColorBackground({ color: '#000000', name: `environment-capture-background:${captures++}` });
        backdrop.current = value;
      })
      .catch((error) => {
        if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    return () => {
      active = false;
      if (backdrop.current === value) backdrop.current = null;
      value?.dispose();
    };
  }, [scene, source, wantsSource]);
  useEffect(() => {
    let active = true,
      cube: NativeCubeCamera | undefined,
      api: typeof EnvironmentModule | undefined,
      environment: IBLEnvironment | undefined,
      creating = false,
      drawn = 0;
    const hidden = new Set<EngineMesh>();
    const fail = (error: unknown) => {
      if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
    };
    const frame: FrameCallback = () => {
      const root = live(registry);
      if (!root) return;
      const inside = new Set<EngineMesh>(),
        outside: EngineMesh[] = [];
      for (const mesh of scene.engine.meshes.values())
        if (descendant(scene, mesh, root)) inside.add(mesh);
        else outside.push(mesh);
      // Hidden in the main view: every mesh of the group, Lightformer nodes included.
      for (const mesh of inside)
        if (mesh.visible) {
          mesh.visible = false;
          hidden.add(mesh);
        }
      for (const mesh of hidden) if (!scene.engine.meshes.has(mesh.id) || !inside.has(mesh)) hidden.delete(mesh);
      if (!cube || !api || creating || drawn >= latest.current.frames) return;
      // A capture waits for what it draws: the background and every Lightformer of the group.
      if (!backdrop.current || pending.count > 0) return;
      try {
        scene.engine.store.tick(false);
        const m = root.matrix;
        cube.position = [m[12], m[13], m[14]];
        cube.exclude = outside;
        cube.background = backdrop.current;
        for (const mesh of hidden) mesh.visible = true;
        let ok: number;
        try {
          ok = cube.update(6);
        } finally {
          for (const mesh of hidden) mesh.visible = false;
        }
        if (!ok) return;
        drawn++;
        if (environment) {
          environment.refresh().catch(fail);
          return;
        }
        creating = true;
        const module = api;
        void module.Environment.create(scene.engine as unknown as EngineKernel, cube, {
          name: `environment-capture:${captures++}`,
        })
          .then((value) => {
            creating = false;
            if (!active || scene.engine.disposed) return value.dispose();
            environment = value;
            scene.engine.use(value as unknown as EnginePlugin);
            publish({ environment: value, api: module });
          })
          .catch((error) => {
            creating = false;
            fail(error);
          });
      } catch (error) {
        fail(error);
      }
    };
    void Promise.all([
      optionalPeer('@margoengine/environment', () => import('@margoengine/environment/cube-camera')),
      optionalPeer('@margoengine/environment', () => import('@margoengine/environment')),
    ])
      .then(([cubeApi, environmentApi]) => {
        if (!active || scene.engine.disposed) return;
        const value = new cubeApi.CubeCamera({ size: resolution, near, far });
        (scene.world ?? scene.engine).use(value as unknown as Parameters<EngineKernel['use']>[0]);
        cube = value;
        api = environmentApi;
      })
      .catch(fail);
    scene.frames.callbacks.add(frame);
    return () => {
      active = false;
      scene.frames.callbacks.delete(frame);
      publish(null);
      if (environment) {
        if (!scene.engine.disposed && scene.engine.hasPlugin(environment.name)) scene.engine.removePlugin(environment.name);
        environment.dispose();
      }
      cube?.dispose();
      if (!scene.engine.disposed) for (const mesh of hidden) if (scene.engine.meshes.has(mesh.id)) mesh.visible = true;
    };
  }, [scene, registry, resolution, near, far, publish, pending]);
  return null;
}
