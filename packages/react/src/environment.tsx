import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { EngineKernel } from '@margoengine/core';
import type { EnginePlugin } from '@margoengine/core/extension';
import type { PBRModel, LightingEffect } from '@margoengine/gltf/pbr';
import type * as EnvironmentModule from '@margoengine/environment/main';
import type { Environment as IBLEnvironment, EnvironmentBackground } from '@margoengine/environment/main';
import { preloadAsset, retainAsset } from './assets.js';
import { environmentAsset } from './environment-asset.js';
import { Mesh } from './components.js';
import type { Captured, EnvironmentCapture as CaptureComponent } from './environment-capture.js';
import { LightformerPending } from './lightformer.js';
import { report, useCommit, useResourceEffect, useScene } from './internal.js';
import { rangeError } from '../../shared/errors.js';

export * from './lights.js';
export { CubeCamera, type CubeCameraFog, type CubeCameraProps } from './cube-camera.js';
export { Lightformer, type LightformerProps } from './lightformer.js';

interface Loading {
  src: string;
  pending: boolean;
  promise: Promise<void>;
}
function values(value: readonly number[], size: number, label: string, min = 0, max = 1): void {
  if (
    !Array.isArray(value) ||
    value.length !== size ||
    value.some((v) => typeof v !== 'number' || !Number.isFinite(Math.fround(v)) || v < min || v > max)
  )
    throw rangeError(`Invalid ${label}: pass an array of ${size} finite number(s) between ${min} and ${max}`, 'react-arguments');
}

/** Props of the Environment component; every prop is optional unless noted. */
export interface EnvironmentProps {
  src?: string;
  exposure?: number;
  background?: boolean;
  /** Turn the environment about +Y, in radians: its lighting and background together. Default 0. */
  rotation?: number;
  /** Background blur: 0 sharp to 1 the roughest prefiltered level. Default 0. */
  blur?: number;
  /**
   * Meshes (typically `<Lightformer>`s) captured into the environment the scene is lit by, over the `src` environment
   * or black, and hidden in the main view (drei's Environment children). Default none.
   */
  children?: ReactNode;
  /** Edge in texels of the cube the children are captured into: a power of two from 8 to 2048. Default 256. */
  resolution?: number;
  /** Captures of the children: 1 captures once, `Infinity` every frame. Default 1. */
  frames?: number;
  /** Near and far planes of the children's capture, in world units. Defaults 1 and 1000. */
  near?: number;
  far?: number;
  onError?: (error: unknown) => void;
}

/** The environment component. */
function EnvironmentComponent({
  src,
  exposure = 1,
  background = true,
  rotation = 0,
  blur = 0,
  children,
  resolution = 256,
  frames = 1,
  near = 1,
  far = 1000,
  onError,
}: EnvironmentProps) {
  const scene = useScene(),
    { engine, resources, assetCache } = scene,
    [source, setSource] = useState<IBLEnvironment | null>(null),
    [captured, setCaptured] = useState<Captured | null>(null),
    [pending] = useState(() => ({ count: 0 })),
    capturing = Children.toArray(children).length > 0;
  if (!(frames === Infinity || (Number.isInteger(frames) && frames > 0)))
    throw rangeError('Environment frames must be a positive integer or Infinity; pass how many captures to make', 'react-arguments');
  const [loading, setLoading] = useState<Loading | null>(null),
    errorHandler = useRef(onError);
  errorHandler.current = onError;
  const [sourceModule, setModule] = useState<typeof EnvironmentModule | null>(null);
  // What lights the scene and is its background: the children's capture when there are children, else the src.
  const environment = capturing ? (captured?.environment ?? null) : source,
    module = capturing ? (captured?.api ?? null) : sourceModule;
  const publish = useCallback((value: Captured | null) => setCaptured(value), []);
  // The capture binding loads with the first child: an Environment without children never fetches it.
  const [Capture, setCapture] = useState<typeof CaptureComponent | null>(null);
  useEffect(() => {
    if (!capturing || Capture) return;
    let active = true;
    import('./environment-capture.js')
      .then((module) => {
        if (active) setCapture(() => module.EnvironmentCapture);
      })
      .catch((error) => {
        if (active && !scene.engine.disposed) report(scene, error, errorHandler.current);
      });
    return () => {
      active = false;
    };
  }, [capturing, Capture, scene]);
  const previous = useRef<{ direction: Float32Array; radiance: Float32Array } | null>(null);
  const backdrop = useRef<EnvironmentBackground | null>(null);
  useCommit(() => {
    const saved = { direction: engine.lighting.direction.slice(), radiance: engine.lighting.radiance.slice() };
    previous.current = saved;
    return () => {
      engine.lighting.direction.set(saved.direction);
      engine.lighting.radiance.set(saved.radiance);
    };
  }, [engine]);
  useCommit(() => {
    values([exposure], 1, 'exposure', 0, Infinity);
    if (!src && !capturing) {
      engine.lighting.direction.set([3, 5, 4, 3]);
      engine.lighting.radiance.set([exposure, exposure, exposure, 0.15 * exposure]);
    } else if (previous.current) {
      engine.lighting.direction.set(previous.current.direction);
      engine.lighting.radiance.set(previous.current.radiance);
      for (let i = 0; i < 4; i++) engine.lighting.radiance[i] *= exposure;
    }
    if (environment && !environment.disposed) environment.intensity = exposure;
  }, [engine, src, capturing, exposure, environment]);
  useResourceEffect(
    (lease) => {
      setSource(null);
      setModule(null);
      if (!src) return;
      let current: IBLEnvironment | undefined;
      const asset = environmentAsset(assetCache, src),
        releaseAsset = retainAsset(assetCache, src, asset, assetCache.environments);
      const release = () => {
        if (current) {
          engine.removePlugin(current.name);
          current.dispose();
          current = undefined;
        }
      };
      const request: Loading = { src, pending: asset.status === 'pending', promise: Promise.resolve() };
      request.promise = (async () => {
        await asset.promise;
        if (!lease.active || engine.disposed) return;
        if (asset.status === 'rejected') throw asset.error;
        const { api, image } = asset.value!;
        const loaded = await api.Environment.create(engine as unknown as EngineKernel, image);
        if (!lease.active || engine.disposed) {
          loaded.dispose();
          return;
        }
        current = loaded;
        engine.use(loaded as unknown as EnginePlugin);
        setModule(api);
        setSource(loaded);
      })()
        .catch((error) => {
          release();
          if (lease.active && !engine.disposed) {
            try {
              errorHandler.current?.(error);
            } finally {
              engine.onError(error);
            }
          }
        })
        .finally(() => {
          request.pending = false;
        });
      setLoading(request);
      return () => {
        releaseAsset();
        release();
      };
    },
    [engine, src, assetCache],
  );
  useCommit(() => {
    if (!environment || environment.disposed || !module) return;
    // The environment package's own lighting: it lights core meshes as a plugin and every PBR model it is added to,
    // with the bindings and WGSL that package keeps current (a copy here went stale when its BRDF table moved to a
    // storage buffer and `<Environment>` stopped compiling on gltf/pbr models).
    const lighting = new module.EnvironmentLighting(environment),
      effect = lighting as unknown as LightingEffect;
    engine.use(lighting);
    const models = new Map<PBRModel, () => void>();
    resources.lighting.set(effect, models);
    const release = () => {
      resources.lighting.delete(effect);
      for (const remove of models.values()) remove();
      models.clear();
      if (!engine.disposed && engine.hasPlugin(lighting.name)) engine.removePlugin(lighting.name);
      lighting.dispose();
    };
    try {
      for (const model of resources.models) models.set(model, model.addLighting(effect));
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }, [engine, resources, environment, module]);
  useCommit(() => {
    if (!environment || environment.disposed || !module || !background) return;
    const effect = new module.EnvironmentBackground(environment);
    engine.use(effect as unknown as EnginePlugin);
    backdrop.current = effect;
    return () => {
      backdrop.current = null;
      engine.removePlugin(effect.name);
      effect.dispose();
    };
  }, [engine, environment, module, background]);
  useCommit(() => {
    if (backdrop.current) {
      backdrop.current.exposure = exposure;
      backdrop.current.blur = blur;
    }
  }, [environment, module, background, exposure, blur]);
  useCommit(() => {
    if (environment && !environment.disposed) environment.rotation = rotation;
  }, [environment, rotation]);
  if (loading && loading.src === src && loading.pending) throw loading.promise;
  if (!capturing) return null;
  return (
    <Mesh>
      <LightformerPending.Provider value={pending}>
        {children}
        {Capture && (
          <Capture settings={{ src, resolution, frames, near, far, onError }} source={source} publish={publish} />
        )}
      </LightformerPending.Provider>
    </Mesh>
  );
}
const preloadEnvironment = (src: string): Promise<void> =>
  preloadAsset(`environment:${src}`, (cache) => {
    const asset = environmentAsset(cache, src);
    asset.users++;
    return asset.promise
      .then(() => {
        if (asset.status === 'rejected') throw asset.error;
      })
      .finally(() => {
        asset.users--;
      });
  });

// A pure Object.assign, not `Component.preload = ...`: a module-level assignment is a side effect that keeps the module
// (and the loaders it imports lazily) in every build that reaches this entry, used or not.
/** The environment component: image-based lighting and background from an .hdr or .exr. */
export const Environment = /* @__PURE__ */ Object.assign(EnvironmentComponent, {
  /** Loads `src` (an .hdr or .exr) into the Canvas cache ahead of the first `<Environment src>` (queued until a Canvas exists). */
  preload: preloadEnvironment,
  displayName: 'Environment',
});
