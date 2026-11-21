import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react';
import type { EngineKernel, FrameCallback } from '@margoengine/core';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import type { CubeCamera as NativeCubeCamera } from '@margoengine/environment/cube-camera';
import type * as EnvironmentModule from '@margoengine/environment/main';
import type { EnvironmentBackground, Fog as FogPlugin, FogOptions } from '@margoengine/environment/main';
import { Mesh, type MeshProps, type MeshRef } from './components.js';
import { live, report, useMesh, useResourceEffect, useScene, type Scene } from './internal.js';
import { sceneOwner } from './scene-owner.js';
import { retainAsset } from './assets.js';
import { environmentAsset } from './environment-asset.js';
import { optionalPeer } from './optional.js';
import { rangeError } from '../../shared/errors.js';

/** Props of `<CubeCamera>`; every prop is optional. */
export interface CubeCameraProps extends Omit<MeshProps, 'children'> {
  /**
   * Gets the live cube texture (`rgba16float`, six layers) and returns what to draw: pass it to a material's `envMap`.
   * What it returns is left out of the cube, so an object does not reflect itself. Called again when the texture is
   * replaced (device restore).
   */
  children?: (texture: GPUTexture) => ReactNode;
  /** Face edge in texels: a power of two from 8 to 2048. Default 256. */
  resolution?: number;
  /** Near clip distance of the six face cameras. Default 0.1. */
  near?: number;
  /** Far clip distance of the six face cameras. Default 1000. */
  far?: number;
  /** Frames to capture, from the first: a positive integer, or Infinity for every frame. Default Infinity. */
  frames?: number;
  /** Give the cube a box-filtered mip chain, so rough materials read a blurred cube. Default false. */
  mips?: boolean;
  /** Layer mask the faces draw (@margoengine/cameras/layers). Default every layer. */
  layers?: number;
  /**
   * An .hdr or .exr the faces draw as their background in place of the scene's (drei's `envMap`), loaded through the
   * Canvas cache like `<Environment src>`; the main view keeps its own. Faces wait for it to load. Default none.
   */
  envMap?: string;
  /**
   * Fog the faces draw with in place of the scene's `<Fog>` (drei's `fog`): fog options (an option left out takes its
   * `<Fog>` default), or false for no fog in the faces. The main view keeps its own. Default the scene's fog.
   */
  fog?: CubeCameraFog | false;
  /** Called with the native CubeCamera of `@margoengine/environment/cube-camera` once it is attached. */
  onCreated?: (camera: NativeCubeCamera) => void;
  onError?: (error: unknown) => void;
}

/** The `fog` of `<CubeCamera>`: `<Fog>`'s options. */
export type CubeCameraFog = Omit<FogOptions, 'name'>;

const FOG_KEYS = ['color', 'near', 'far', 'density', 'heightFalloff', 'height', 'enabled'] as const;
const FOG_DEFAULTS = { color: '#ffffff', near: 1, far: 1000, density: 0, heightFalloff: 0, height: 0 };
let fogs = 0; // name counter of the private fogs and environments

// Runs `capture` with the faces' fog: the scene's Fog (any Fog the engine holds) set to `options` and restored after;
// with no Fog in the scene, a private one (off in the main view) is attached for the faces and dropped once the scene
// gets its own, as shaders must not mix two fogs.
interface OwnFog {
  fog?: FogPlugin;
  /** The scene's glTF PBR models the private fog is added to, with their removers. */
  models: Map<{ disposed?: boolean }, () => void>;
}
function dropFog(scene: Scene, own: OwnFog): void {
  if (!own.fog) return;
  for (const remove of own.models.values()) remove();
  own.models.clear();
  if (!scene.engine.disposed && sceneOwner(scene).plugins.has(own.fog.name)) sceneOwner(scene).removePlugin(own.fog.name);
  own.fog.dispose();
  own.fog = undefined;
}
function withFog(scene: Scene, api: typeof EnvironmentModule, own: OwnFog, options: CubeCameraFog | false, capture: () => void): void {
  let fog: FogPlugin | undefined;
  for (const plugin of sceneOwner(scene).plugins.values()) if (plugin instanceof api.Fog && plugin !== own.fog) fog = plugin;
  if (fog) dropFog(scene, own);
  else if (options) {
    if (!own.fog) sceneOwner(scene).use((own.fog = new api.Fog({ name: `cube-camera-fog:${fogs++}` })));
    own.fog.enabled = false;
    // Core meshes take the fog through the plugin; glTF PBR models (every material component) are added one by one.
    // The Canvas's models stay in the default scene, so a named Scene's faces leave them alone.
    const models = (scene.world ? new Set() : scene.resources.models) as Set<{ disposed?: boolean }>;
    for (const [model, remove] of own.models)
      if (!models.has(model) || model.disposed) {
        remove();
        own.models.delete(model);
      }
    for (const model of models)
      if (!model.disposed && !own.models.has(model)) own.models.set(model, own.fog.add(model as never));
  }
  fog ??= own.fog;
  if (!fog) return capture();
  const saved = FOG_KEYS.map((key) => fog[key]);
  try {
    if (options) Object.assign(fog, FOG_DEFAULTS, options, { enabled: true });
    else fog.enabled = false;
    capture();
  } finally {
    FOG_KEYS.forEach((key, i) => Object.assign(fog, { [key]: saved[i] }));
  }
}

/** @internal True when `mesh` is `root` or under it in the transform tree. */
export function descendant(scene: Scene, mesh: EngineMesh, root: EngineMesh): boolean {
  for (let id = mesh.id, depth = 0; id >= 0 && depth < 64; id = scene.engine.store.parents[id], depth++)
    if (id === root.id) return true;
  return false;
}

type Settings = Required<Pick<CubeCameraProps, 'resolution' | 'near' | 'far' | 'frames' | 'mips' | 'layers'>> &
  Pick<CubeCameraProps, 'envMap' | 'fog' | 'onCreated' | 'onError'>;

function CubeBinding({ settings, publish }: { settings: Settings; publish: (texture: GPUTexture | null) => void }) {
  const scene = useScene(),
    registry = useMesh(),
    latest = useRef(settings),
    background = useRef<EnvironmentBackground | null>(null),
    fogApi = useRef<typeof EnvironmentModule | null>(null);
  latest.current = settings;
  const { resolution, near, far, mips, envMap } = settings,
    wantsFog = settings.fog !== undefined;
  // The faces' background: an Environment of its own, drawn through `record` by the native CubeCamera only.
  useResourceEffect(
    (lease) => {
      background.current = null;
      if (!envMap) return;
      const { engine, assetCache } = scene,
        asset = environmentAsset(assetCache, envMap),
        releaseAsset = retainAsset(assetCache, envMap, asset, assetCache.environments);
      let environment: EnvironmentModule.Environment | undefined, backdrop: EnvironmentBackground | undefined;
      void (async () => {
        await asset.promise;
        if (!lease.active || engine.disposed) return;
        if (asset.status === 'rejected') throw asset.error;
        const { api, image } = asset.value!;
        const loaded = await api.Environment.create(engine as unknown as EngineKernel, image, {
          name: `cube-camera-background:${fogs++}`,
        });
        if (!lease.active || engine.disposed) return loaded.dispose();
        environment = loaded;
        sceneOwner(scene).use(loaded as unknown as Parameters<EngineKernel['use']>[0]);
        backdrop = new api.EnvironmentBackground(loaded, { name: `${loaded.name}:pass` });
        background.current = backdrop;
      })().catch((error) => {
        if (lease.active && !engine.disposed) report(scene, error, latest.current.onError);
      });
      return () => {
        if (background.current === backdrop) background.current = null;
        backdrop?.dispose();
        if (environment) {
          if (!engine.disposed && sceneOwner(scene).plugins.has(environment.name)) sceneOwner(scene).removePlugin(environment.name);
          environment.dispose();
        }
        releaseAsset();
      };
    },
    [scene, envMap],
  );
  useEffect(() => {
    if (!wantsFog) return;
    let active = true;
    void optionalPeer('@margoengine/environment', () => import('@margoengine/environment/main'))
      .then((api) => {
        if (active) fogApi.current = api;
      })
      .catch((error) => {
        if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    return () => {
      active = false;
    };
  }, [scene, wantsFog]);
  useEffect(() => {
    let active = true,
      cube: NativeCubeCamera | undefined,
      version = -1,
      drawn = 0;
    const own: OwnFog = { models: new Map() };
    const frame: FrameCallback = () => {
      const root = live(registry),
        { envMap, fog } = latest.current;
      if (!cube || !root || drawn >= latest.current.frames) return;
      // Faces wait for what they draw with, so a single-frame capture never misses it.
      if ((envMap && !background.current) || (fog !== undefined && !fogApi.current)) return;
      try {
        cube.layers = latest.current.layers;
        // The capture point is the group's world origin; everything under the group stays out of its own cube.
        scene.engine.store.tick(false);
        const m = root.matrix;
        cube.position = [m[12], m[13], m[14]];
        const inside: EngineMesh[] = [];
        for (const mesh of scene.engine.meshes.values()) if (descendant(scene, mesh, root)) inside.push(mesh);
        cube.exclude = inside;
        cube.background = envMap ? background.current : null;
        const capture = () => {
          if (cube!.update(6)) drawn++;
        };
        if (fog === undefined) capture();
        else withFog(scene, fogApi.current!, own, fog, capture);
        if (cube.version !== version) {
          version = cube.version;
          publish(cube.texture);
        }
      } catch (error) {
        report(scene, error, latest.current.onError);
      }
    };
    void optionalPeer('@margoengine/environment', () => import('@margoengine/environment/cube-camera'))
      .then((api) => {
        if (!active || scene.engine.disposed) return;
        const value = new api.CubeCamera({ size: resolution, near, far, mips });
        (scene.world ?? scene.engine).use(value as unknown as Parameters<EngineKernel['use']>[0]);
        cube = value;
        version = value.version;
        publish(value.texture);
        latest.current.onCreated?.(value);
      })
      .catch((error) => {
        if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    scene.frames.callbacks.add(frame);
    return () => {
      active = false;
      scene.frames.callbacks.delete(frame);
      cube?.dispose();
      dropFog(scene, own);
      publish(null);
    };
  }, [scene, registry, resolution, near, far, mips, publish]);
  return null;
}

/**
 * drei's CubeCamera: renders the scene around its position into a cube texture and hands it to `children` for a
 * material's `envMap`, leaving its own children out of the capture. Built on `CubeCamera` of
 * `@margoengine/environment/cube-camera`; WebGPU and the WebGL2 compatibility layer.
 */
export const CubeCamera = /* @__PURE__ */ forwardRef<MeshRef, CubeCameraProps>(function CubeCamera(
  {
    children,
    resolution = 256,
    near = 0.1,
    far = 1000,
    frames = Infinity,
    mips = false,
    layers = 0xffffffff,
    envMap,
    fog,
    onCreated,
    onError,
    ...props
  },
  ref,
) {
  if (!(frames === Infinity || (Number.isInteger(frames) && frames > 0)))
    throw rangeError('CubeCamera frames must be a positive integer or Infinity; pass how many frames to capture', 'react-arguments');
  const [texture, setTexture] = useState<GPUTexture | null>(null);
  return (
    <Mesh {...props} ref={ref}>
      <CubeBinding
        settings={{ resolution, near, far, frames, mips, layers, envMap, fog, onCreated, onError }}
        publish={setTexture}
      />
      {texture && children ? children(texture) : null}
    </Mesh>
  );
});
