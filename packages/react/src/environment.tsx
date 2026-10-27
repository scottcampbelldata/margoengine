import { useRef, useState } from 'react';
import type { EngineKernel } from '@margoengine/core';
import type { EnginePlugin } from '@margoengine/core/extension';
import type { PBRModel, LightingEffect } from '@margoengine/gltf-pro';
import type * as EnvironmentModule from '@margoengine/environment';
import type { Environment as IBLEnvironment, EnvironmentBackground } from '@margoengine/environment';
import {
  entry,
  preloadAsset,
  retainAsset,
  trackedFetch,
  type AssetCache,
  type AssetEntry,
  type EnvironmentSource,
} from './assets.js';
import { useCommit, useResourceEffect, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

export * from './lights.js';

function environmentAsset(cache: AssetCache, src: string): AssetEntry<EnvironmentSource> {
  return entry(cache, cache.environments, src, async (signal) => {
    const api = await optionalPeer('@margoengine/environment', () => import('@margoengine/environment'));
    signal.throwIfAborted();
    const fetch = await trackedFetch(cache);
    signal.throwIfAborted();
    const image = await api.loadEnvironmentImage(src, { signal, fetch });
    signal.throwIfAborted();
    return { api, image };
  });
}
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
    throw new RangeError(`Invalid ${label}: pass an array of ${size} finite number(s) between ${min} and ${max}.`);
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
  onError?: (error: unknown) => void;
}
/** The environment component. */
function EnvironmentComponent({
  src,
  exposure = 1,
  background = true,
  rotation = 0,
  blur = 0,
  onError,
}: EnvironmentProps) {
  const { engine, resources, assetCache } = useScene(),
    [environment, setEnvironment] = useState<IBLEnvironment | null>(null);
  const [loading, setLoading] = useState<Loading | null>(null),
    errorHandler = useRef(onError);
  errorHandler.current = onError;
  const [module, setModule] = useState<typeof EnvironmentModule | null>(null);
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
    if (!src) {
      engine.lighting.direction.set([3, 5, 4, 3]);
      engine.lighting.radiance.set([exposure, exposure, exposure, 0.15 * exposure]);
    } else if (previous.current) {
      engine.lighting.direction.set(previous.current.direction);
      engine.lighting.radiance.set(previous.current.radiance);
      for (let i = 0; i < 4; i++) engine.lighting.radiance[i] *= exposure;
    }
    if (environment && !environment.disposed) environment.intensity = exposure;
  }, [engine, src, exposure, environment]);
  useResourceEffect(
    (lease) => {
      setEnvironment(null);
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
        setEnvironment(loaded);
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
    // storage buffer and `<Environment>` stopped compiling on gltf-pro models).
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
  return null;
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
