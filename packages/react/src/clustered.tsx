import { useMemo } from 'react';
import type { Vec3 } from '@margoengine/core/extension';
import { parseColor, type ColorInput } from '@margoengine/math/color';
import type { Mesh as MeshHandle } from '@margoengine/core';
import type {
  Clustered,
  ClusteredOptions,
  LocalLightShadow,
  LocalShadowOptions,
  LocalShadowSource,
  PointLight as NativePointLight,
  SpotLight as NativeSpotLight,
} from '@margoengine/clustered';
import type { LightingEffect, PBRModel } from '@margoengine/gltf/pbr';
import type { AreaLights, RectAreaLight as NativeRectAreaLight } from '@margoengine/clustered/area';
import { syncCasters, type AddedCasters } from './casters.js';
import { subscribeFrame } from './frame-priority.js';
import { useCommit, useScene, type Scene } from './internal.js';
import { optionalPeer } from './optional.js';
import { attachBinding, detachBinding } from './package-binding.js';

type Native = NativePointLight | NativeSpotLight;
interface Config {
  options: ClusteredOptions;
  /** `options` as text: two configs with the same key need no new lighting. */
  key: string;
  onError?: (error: unknown) => void;
}
interface Item {
  /** Null until the first commit, and while a prop is invalid. */
  light: Native | NativeRectAreaLight | null;
  area: boolean;
  onError?: (error: unknown) => void;
}
// One `Clustered` lighting (and one `AreaLights`) per Canvas or `<Scene>`, shared by every light component in it: the
// native lights are set as one list, so each component only contributes its own entry. The hub loads the packages when
// the first light mounts and detaches them after the last one unmounts. `<ClusteredLighting>` gives it the options the
// engine fixes at construction, so a change of them makes the lighting again with the same lights.
class Hub {
  readonly items = new Set<Item>();
  /** The mounted `<ClusteredLighting>`'s options; without one the engine's defaults. */
  config?: Config;
  private plugin?: Clustered;
  /** The `config.key` the last `Clustered` was made with. */
  private built = '{}';
  private stopCasters?: () => void;
  private area?: AreaLights;
  private areaLoading = false;
  private starting = false;
  private token = 0;
  private scheduled = false;
  private stopModels?: () => void;
  constructor(readonly scene: Scene) {}
  add(item: Item): void {
    this.items.add(item);
    if (!this.plugin && !this.starting) this.start();
    else this.schedule();
  }
  remove(item: Item): void {
    this.items.delete(item);
    this.schedule();
    // A StrictMode replay unmounts and mounts in one tick: only a hub still empty afterwards is torn down.
    if (!this.items.size)
      queueMicrotask(() => {
        if (!this.items.size) this.stop();
      });
  }
  /** Sets the options, or clears them when they are still `config`; `sync` makes the lighting again when they differ. */
  configure(config: Config, clear = false): void {
    if (!clear) this.config = config;
    else if (this.config === config) {
      this.config = undefined;
      if (!this.items.size) hubs.delete(this.scene.world ?? this.scene.engine);
    }
    this.schedule();
  }
  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.sync();
    });
  }
  private fail(error: unknown): void {
    for (const item of this.items) item.onError?.(error);
    this.config?.onError?.(error);
    this.scene.engine.onError(error);
  }
  private start(): void {
    const { scene } = this,
      token = ++this.token;
    this.starting = true;
    this.built = this.config?.key ?? '{}';
    optionalPeer('@margoengine/clustered', () => import('@margoengine/clustered'))
      .then((api) => {
        if (token !== this.token || scene.engine.disposed) return;
        // The options as they are now: a change while the package loaded needs no second lighting.
        const { options = {}, key = '{}' } = this.config ?? {};
        this.starting = false;
        this.built = key;
        const plugin = attachBinding(scene, new api.Clustered(options));
        this.plugin = plugin;
        // The Canvas's castShadow meshes and models cast into the integrated maps, followed every frame as they mount,
        // unmount and are recreated. A caster the maps refuse is reported once and left out.
        if (options.shadows && !scene.world) {
          const added: AddedCasters = new Map(),
            stop = subscribeFrame(
              scene.frames,
              () =>
                syncCasters(scene.engine, added, (target) => {
                  try {
                    return plugin.addShadowCaster(target as MeshHandle | LocalShadowSource);
                  } catch (error) {
                    this.fail(error);
                    return () => {};
                  }
                }),
              -50,
            );
          this.stopCasters = () => {
            stop();
            for (const was of added.values()) was.remove();
          };
        }
        // The Canvas's PBR models take the lights in their own shader, now and as they load, through the lighting
        // registry every model binding reads; a named Scene's lighting leaves them alone, as `<Environment>`'s does.
        if (!scene.world) {
          const effect = plugin as unknown as LightingEffect,
            models = new Map<PBRModel, () => void>();
          scene.resources.lighting.set(effect, models);
          this.stopModels = () => {
            scene.resources.lighting.delete(effect);
            for (const remove of models.values()) remove();
            models.clear();
          };
          for (const model of scene.resources.models) models.set(model, model.addLighting(effect));
        }
        this.sync();
      })
      .catch((error) => {
        if (token !== this.token) return;
        this.starting = false;
        this.fail(error);
      });
  }
  private stop(): void {
    this.token++;
    this.starting = false;
    this.areaLoading = false;
    this.stopModels?.();
    this.stopCasters?.();
    this.stopModels = this.stopCasters = undefined;
    const { area, plugin } = this;
    this.area = this.plugin = undefined;
    if (area) detachBinding(this.scene, area);
    if (plugin) detachBinding(this.scene, plugin);
    if (!this.items.size && !this.config) hubs.delete(this.scene.world ?? this.scene.engine);
  }
  private sync(): void {
    // Changed options: the engine fixes them at construction, so the lighting is made again with the lights it had.
    if (!this.starting && this.built !== (this.config?.key ?? '{}') && (this.plugin || this.items.size)) {
      this.stop();
      if (this.items.size && !this.scene.engine.disposed) this.start();
      return;
    }
    const { plugin } = this;
    if (!plugin || this.scene.engine.disposed) return;
    const items = [...this.items].filter((item) => item.light),
      rects = items.filter((item) => item.area).map((item) => item.light as NativeRectAreaLight);
    try {
      plugin.setLights(items.filter((item) => !item.area).map((item) => item.light as Native));
      if (this.area) this.area.setLights(rects);
      else if (rects.length && !this.areaLoading) this.loadArea(plugin);
    } catch (error) {
      this.fail(error);
    }
  }
  private loadArea(plugin: Clustered): void {
    const token = this.token;
    this.areaLoading = true;
    optionalPeer('@margoengine/clustered/area', () => import('@margoengine/clustered/area'))
      .then((api) => {
        if (token !== this.token || this.plugin !== plugin || this.scene.engine.disposed) return;
        this.area = attachBinding(this.scene, new api.AreaLights({ lights: plugin }));
        this.areaLoading = false;
        this.sync();
      })
      .catch((error) => {
        if (token !== this.token) return;
        this.areaLoading = false;
        this.fail(error);
      });
  }
}
const hubs = new WeakMap<object, Hub>();
const hubOf = (scene: Scene): Hub => {
  const owner = scene.world ?? scene.engine;
  let hub = hubs.get(owner);
  if (!hub) hubs.set(owner, (hub = new Hub(scene)));
  return hub;
};
function useLight(light: () => Item['light'], area: boolean, onError: Item['onError'], keys: readonly unknown[]): void {
  const scene = useScene(),
    owner = scene.world ?? scene.engine,
    item = useMemo<Item>(() => ({ light: null, area, onError }), [owner, area]);
  item.onError = onError;
  useCommit(() => {
    const hub = hubOf(scene);
    hub.add(item);
    return () => hub.remove(item);
  }, [owner, item]);
  useCommit(() => {
    try {
      item.light = light();
    } catch (error) {
      item.light = null;
      for (const handler of [onError, scene.engine.onError]) handler?.(error);
    }
    hubs.get(owner)?.schedule();
  }, [item, ...keys]);
}
const colorKey = (value: ColorInput) => (typeof value === 'object' ? value.join() : value);
const linear = (value: ColorInput): Vec3 => {
  const [r, g, b] = parseColor(value);
  return [r, g, b];
};
interface ErrorProps {
  /** Loading `@margoengine/clustered` failed or a light was invalid. Default: the Canvas's error reporting only. */
  onError?: (error: unknown) => void;
}
/**
 * A light's integrated shadow map settings: `LocalLightShadow` of `@margoengine/clustered` without `radius`, which
 * only its `LocalShadows` reads.
 */
export type LightShadow = Omit<LocalLightShadow, 'radius'>;
const shadowOf = (shadow: boolean | LightShadow) => (shadow ? { shadow: shadow === true ? true : { ...shadow } } : {});
const shadowKey = (shadow: boolean | LightShadow) => (typeof shadow === 'object' ? JSON.stringify(shadow) : shadow);

/** Props of `<ClusteredLighting>`: `ClusteredOptions` of `@margoengine/clustered`, with the engine's defaults. */
export interface ClusteredLightingProps {
  /** Clusters along screen X, Y and log depth, each an integer 1-128, product at most 32,768. Default [16, 9, 24]. */
  grid?: readonly [number, number, number];
  /**
   * Most point and spot lights of the Canvas, an integer from 1 to 65,536. Default 1,024. The light buffer grows in
   * pages of 1,024 lights as they mount, so a high cap costs nothing until used.
   */
  maxLights?: number;
  /**
   * Integrated shadow maps for the lights with a `shadow`: `true`, or `resolution` (texels of every map layer, default
   * 512) and `maxLights` (lights with a `shadow`, 1-32, default 4). Each of those slots reserves six `depth32float`
   * layers. Default false: no maps, and a light with a `shadow` is then an error.
   */
  shadows?: boolean | LocalShadowOptions;
  /** An option was invalid, or a caster could not be added. Default: the Canvas's error reporting only. */
  onError?: (error: unknown) => void;
}
/**
 * Options of the `Clustered` lighting that the `<PointLight>`, `<SpotLight>` and `<RectAreaLight>` of this Canvas (or
 * `<Scene>`) share: the cluster grid, the light cap and the integrated shadow maps. Mount one per Canvas or Scene (of
 * several, the last one committed sets them). The engine fixes these at construction, so a changed prop makes the shared
 * lighting again with the same lights, as mounting and unmounting this component do; no lighting is made while no light
 * is mounted. With `shadows`, every `castShadow` mesh and model of the Canvas casts into the maps.
 */
export function ClusteredLighting({ grid, maxLights, shadows = false, onError }: ClusteredLightingProps): null {
  const scene = useScene(),
    owner = scene.world ?? scene.engine,
    // Only what is set goes to the engine, so its own defaults apply to the rest.
    options: ClusteredOptions = {
      ...(grid ? { grid: [...grid] as unknown as ClusteredOptions['grid'] } : {}),
      ...(maxLights === undefined ? {} : { maxLights }),
      ...(shadows ? { shadows: shadows === true ? {} : { ...shadows } } : {}),
    },
    key = JSON.stringify(options),
    config = useMemo<Config>(() => ({ options, key }), [owner, key]);
  config.onError = onError;
  useCommit(() => {
    const hub = hubOf(scene);
    hub.configure(config);
    return () => hub.configure(config, true);
  }, [owner, config]);
  return null;
}

/** Props of `<PointLight>`. */
export interface PointLightProps extends ErrorProps {
  /** World position. Default [0, 0, 0]. */
  position?: Vec3;
  /** Hex is sRGB, `[r, g, b]` linear. Default '#ffffff'. */
  color?: ColorInput;
  /** Radiance multiplier, 0 or more. Default 1. */
  intensity?: number;
  /** Distance where the light ends, windowed smoothly. 0 is unlimited. Default 0. */
  range?: number;
  /** Distance falloff exponent: 2 is inverse-square, 0 is none. Default 2. */
  decay?: number;
  /** Radius of the sphere of light, world units. 0 is a point. Default 0. */
  radius?: number;
  /**
   * Integrated shadow map: `true`, or its `near` (default `min(0.1, far / 100)`), `far` (default `range`; required
   * when `range` is 0), `bias` (default 0.0005), `normalBias` (world units, default 0.02) and `resolution` (texels, one
   * number or `[width, height]`, default the maps' `resolution`). Needs `<ClusteredLighting shadows>`. Default false.
   */
  shadow?: boolean | LightShadow;
}
/**
 * A point light (`PointLight` of `@margoengine/clustered`): the clustered forward lighting of up to 1,024 point and spot
 * lights per Canvas (or `<Scene>`; `<ClusteredLighting maxLights>` raises that), shared by every `<PointLight>` and
 * `<SpotLight>` in it. Core meshes, the Canvas's
 * PBR models and materials meshes receive it. Every prop is live. WebGPU only; needs `@margoengine/clustered`.
 */
export function PointLight({
  position = [0, 0, 0],
  color = '#ffffff',
  intensity = 1,
  range = 0,
  decay = 2,
  radius = 0,
  shadow = false,
  onError,
}: PointLightProps) {
  useLight(
    () => ({
      position: [...position] as Vec3,
      range,
      color: linear(color),
      intensity,
      decay,
      radius,
      ...shadowOf(shadow),
    }),
    false,
    onError,
    [position.join(), colorKey(color), intensity, range, decay, radius, shadowKey(shadow)],
  );
  return null;
}

/** Props of `<SpotLight>`. */
export interface SpotLightProps extends PointLightProps {
  /** World direction the cone points along, not zero. Default [0, -1, 0]. */
  direction?: Vec3;
  /** Cone half-angle in radians, up to pi / 2. Default pi / 4. */
  angle?: number;
  /** Share of the cone that fades at its edge, 0 (hard edge) to 1. Default 0. */
  penumbra?: number;
}
/** A spot light (`SpotLight` of `@margoengine/clustered`): a point light limited to a cone. Shares the lighting of `<PointLight>`. */
export function SpotLight({
  position = [0, 0, 0],
  direction = [0, -1, 0],
  color = '#ffffff',
  intensity = 1,
  range = 0,
  decay = 2,
  radius = 0,
  angle = Math.PI / 4,
  penumbra = 0,
  shadow = false,
  onError,
}: SpotLightProps) {
  useLight(
    () => ({
      position: [...position] as Vec3,
      direction: [...direction] as Vec3,
      range,
      color: linear(color),
      intensity,
      decay,
      radius,
      angle,
      penumbra,
      ...shadowOf(shadow),
    }),
    false,
    onError,
    [
      position.join(),
      direction.join(),
      colorKey(color),
      intensity,
      range,
      decay,
      radius,
      angle,
      penumbra,
      shadowKey(shadow),
    ],
  );
  return null;
}

/** Props of `<RectAreaLight>`. */
export interface RectAreaLightProps extends ErrorProps {
  /** World centre. Default [0, 0, 0]. */
  position?: Vec3;
  /** The side the light faces, world space; need not be unit length. Default [0, -1, 0]. */
  direction?: Vec3;
  /** Size along the light's right axis, world units. Default 1. */
  width?: number;
  /** Size along the light's up axis, world units. Default 1. */
  height?: number;
  /** Orientation hint, not parallel to `direction`. Default [0, 1, 0], or [0, 0, 1] when `direction` is vertical. */
  up?: Vec3;
  /** Hex is sRGB, `[r, g, b]` linear. Default '#ffffff'. */
  color?: ColorInput;
  /** Emitted radiance, 0 or more. Default 1. */
  intensity?: number;
  /** Emit from both faces. Default false. */
  twoSided?: boolean;
}
/**
 * A rectangular area light (`RectAreaLight` of `@margoengine/clustered/area`), shaded with linearly transformed cosines:
 * GGX specular and Lambert diffuse with the quad clipped to each surface's horizon. Every fragment evaluates every area
 * light (at most 64 per Canvas), so keep them few. Every prop is live. WebGPU only; needs `@margoengine/clustered`.
 */
export function RectAreaLight({
  position = [0, 0, 0],
  direction = [0, -1, 0],
  width = 1,
  height = 1,
  up,
  color = '#ffffff',
  intensity = 1,
  twoSided = false,
  onError,
}: RectAreaLightProps) {
  useLight(
    () => ({
      position: [...position] as Vec3,
      direction: [...direction] as Vec3,
      width,
      height,
      ...(up ? { up: [...up] as Vec3 } : {}),
      color: linear(color),
      intensity,
      twoSided,
    }),
    true,
    onError,
    [position.join(), direction.join(), width, height, up?.join(), colorKey(color), intensity, twoSided],
  );
  return null;
}
