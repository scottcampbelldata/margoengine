import { forwardRef } from 'react';
import type { EngineKernel } from '@margoengine/core';
import type { ColorInput } from '@margoengine/math';
import type {
  AmbientLight as AmbientPlugin,
  Fog as FogPlugin,
  FogOptions,
  HemisphereLight as HemispherePlugin,
} from '@margoengine/environment';
import { useCommit, useCreated, useModelSources, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

type EnvironmentApi = typeof import('@margoengine/environment');
const load = () => optionalPeer('@margoengine/environment', () => import('@margoengine/environment'));
interface ErrorProps {
  /** Loading `@margoengine/environment` or attaching failed (these lights need WebGPU). */
  onError?: (error: unknown) => void;
}

/** Props of `<AmbientLight>`. */
export interface AmbientLightProps extends ErrorProps {
  /** Hex is sRGB, `[r, g, b]` linear. Default '#ffffff'. */
  color?: ColorInput;
  /** Default 1. */
  intensity?: number;
}
/**
 * The same light from every direction on core meshes and models (`@margoengine/environment`'s AmbientLight, which
 * takes the place of the built-in ambient). Colour and intensity are live. The ref is the live light. WebGPU only.
 */
export const AmbientLight = forwardRef<AmbientPlugin, AmbientLightProps>(function AmbientLight(
  { color = '#ffffff', intensity = 1, onError },
  ref,
) {
  const scene = useScene();
  const light = useCreated<EnvironmentApi, AmbientPlugin>(
    scene,
    {
      load,
      create: (api) => api.AmbientLight.attach(scene.engine as unknown as EngineKernel),
      dispose: (value) => value.dispose(),
      ref,
      onError,
    },
    [],
  );
  useModelSources(scene, light);
  useCommit(() => {
    if (!light) return;
    light.color = color;
    light.intensity = intensity;
  });
  return null;
});

/** Props of `<HemisphereLight>`. */
export interface HemisphereLightProps extends ErrorProps {
  /** Light from above. Default '#ffffff'. */
  sky?: ColorInput;
  /** Light from below. Default the sky colour. */
  ground?: ColorInput;
  /** Default 1. */
  intensity?: number;
}
/**
 * Ambient light of `sky` colour from above and `ground` colour from below (`@margoengine/environment`'s
 * HemisphereLight) on core meshes and models. Live; the ref is the live light. WebGPU only.
 */
export const HemisphereLight = forwardRef<HemispherePlugin, HemisphereLightProps>(function HemisphereLight(
  { sky = '#ffffff', ground, intensity = 1, onError },
  ref,
) {
  const scene = useScene();
  const light = useCreated<EnvironmentApi, HemispherePlugin>(
    scene,
    {
      load,
      create: (api) => api.HemisphereLight.attach(scene.engine as unknown as EngineKernel),
      dispose: (value) => value.dispose(),
      ref,
      onError,
    },
    [],
  );
  useModelSources(scene, light);
  useCommit(() => {
    if (!light) return;
    light.sky = sky;
    light.ground = ground;
    light.intensity = intensity;
  });
  return null;
});

/** Props of `<Fog>`: linear (`near`, `far`), exponential-squared (`density`) and height fog, all live. */
export interface FogProps extends Omit<FogOptions, 'name'>, ErrorProps {
  /** Default true. */
  enabled?: boolean;
}
/**
 * Distance and height fog computed in the mesh shaders (`@margoengine/environment`'s Fog), so it also covers
 * transparent models. Every option is live; a removed one returns to its default. WebGPU only.
 */
export const Fog = forwardRef<FogPlugin, FogProps>(function Fog(
  { color = '#ffffff', near = 1, far = 1000, density = 0, heightFalloff = 0, height = 0, enabled = true, onError },
  ref,
) {
  const scene = useScene();
  const fog = useCreated<EnvironmentApi, FogPlugin>(
    scene,
    {
      load,
      create: (api) => api.Fog.attach(scene.engine as unknown as EngineKernel),
      dispose: (value) => value.dispose(),
      ref,
      onError,
    },
    [],
  );
  useModelSources(scene, fog);
  useCommit(() => {
    if (!fog) return;
    Object.assign(fog, { color, near, far, density, heightFalloff, height, enabled });
  });
  return null;
});
