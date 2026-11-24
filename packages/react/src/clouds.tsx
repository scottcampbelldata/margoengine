import { createContext, forwardRef, useContext, useEffect, useId, useRef, useState } from 'react';
import type {
  Clouds as NativeClouds,
  CloudOptions,
  CloudsOptions,
  CloudTexture,
  ColorInput,
  FogLike,
} from '@margoengine/vfx/clouds';
import type { DepthTexture as DepthPlugin } from '@margoengine/post/depth';
import type { EngineKernel } from '@margoengine/core';
import { Mesh, type MeshProps, type MeshRef } from './components.js';
import { subscribeFrame } from './frame-priority.js';
import { live, report, useCommit, useMesh, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { fault } from '../../shared/errors.js';

/** The native Clouds of the nearest `<Clouds>`: undefined outside one, null while it loads. */
const CloudsContext = /* @__PURE__ */ createContext<NativeClouds | null | undefined>(undefined);

/** Props of `<Clouds>`: `@margoengine/vfx/clouds` options and group props, every one optional. */
export interface CloudsProps extends MeshProps, Omit<CloudsOptions, 'texture' | 'shading' | 'depth'> {
  /** Puff texture: a URL (fetched, nothing drawn until it decodes) or pixels or an image. Default: a generated puff. */
  texture?: string | CloudTexture | null;
  /**
   * drei's material override, as Margo's shading: 'scatter' (default) lights the puffs by the light reaching them
   * through the cloud; 'unlit' draws the colour as it is.
   */
  material?: 'scatter' | 'unlit';
  /** Fog the puffs are drawn in (`@margoengine/environment`'s Fog or an object with its fields). Default none. */
  fog?: FogLike | null;
  /** Called with the native Clouds once it is attached. */
  onReady?: (clouds: NativeClouds) => void;
  onError?: (error: unknown) => void;
}

/** Props of `<Cloud>`: one cloud's options and group props (position, rotation, scale), every one optional. */
export interface CloudProps extends MeshProps, Omit<CloudOptions, 'color'> {
  /** Colour: hex is sRGB, an [r, g, b] array linear. Default white. */
  color?: ColorInput;
}

const cloudKeys = [
  'seed',
  'segments',
  'bounds',
  'concentrate',
  'volume',
  'smallestVolume',
  'distribute',
  'growth',
  'speed',
  'fade',
  'opacity',
  'color',
] as const;
const cloudsKeys = [
  'limit',
  'range',
  'frustumCulled',
  'lightDirection',
  'lightColor',
  'ambient',
  'density',
  'softness',
] as const;
function pick<T extends object>(props: T, keys: readonly string[]): [Record<string, unknown>, Record<string, unknown>] {
  const picked: Record<string, unknown> = {},
    rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props))
    if (keys.includes(key)) {
      if (value !== undefined) picked[key] = value;
    } else rest[key] = value;
  return [picked, rest];
}
/** Replaces every field of `target` with those of `source`. */
function replace(target: object, source: object): void {
  for (const key of Object.keys(target)) delete (target as Record<string, unknown>)[key];
  Object.assign(target, source);
}

/**
 * drei's Clouds: every `<Cloud>` inside is drawn in one instanced draw, back to front, by `@margoengine/vfx/clouds`.
 * `limit` caps the puffs (default 200), `range` draws the first ones only, `texture` replaces the generated puff,
 * `softness` fades puffs into the surfaces behind them (it adds `@margoengine/post/depth`'s scene depth).
 */
export const Clouds = /* @__PURE__ */ forwardRef<MeshRef, CloudsProps>(function Clouds(
  { texture, material, fog, onReady, onError, children, ...props },
  ref,
) {
  const [options, meshProps] = pick(props, cloudsKeys),
    scene = useScene(),
    [clouds, setClouds] = useState<NativeClouds | null>(null),
    [image, setImage] = useState<CloudTexture | null | undefined>(undefined),
    [depth, setDepth] = useState<DepthPlugin | null>(null),
    latest = useRef({ onReady, onError });
  latest.current = { onReady, onError };
  const fail = (error: unknown) => {
    if (!scene.engine.disposed && !(error instanceof DOMException && error.name === 'AbortError'))
      report(scene, error, latest.current.onError);
  };
  useEffect(() => {
    let active = true,
      made: NativeClouds | undefined;
    optionalPeer('@margoengine/vfx', () => import('@margoengine/vfx/clouds'))
      .then(({ Clouds: Native }) => {
        if (!active || scene.engine.disposed) return;
        made = Native.attach(scene.engine as unknown as EngineKernel, { range: 0 });
        setClouds(made);
        latest.current.onReady?.(made);
      })
      .catch((error) => active && fail(error));
    return () => {
      active = false;
      setClouds(null);
      made?.dispose();
    };
  }, [scene.engine]);
  // A URL is fetched and decoded; nothing is drawn until it is.
  useEffect(() => {
    if (typeof texture !== 'string') {
      setImage(texture ?? null);
      return;
    }
    setImage(undefined);
    const controller = new AbortController();
    fetch(texture, { signal: controller.signal })
      .then((response) => {
        if (!response.ok)
          throw Object.assign(
            fault('failed', 'Clouds texture URL answered with an error status; check the URL', 'react-usage'),
            { cause: { url: texture, status: response.status } },
          );
        return response.blob();
      })
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => !controller.signal.aborted && setImage(bitmap))
      .catch(fail);
    return () => controller.abort();
  }, [texture]);
  const soft = ((options.softness as number | undefined) ?? 0) > 0;
  useEffect(() => {
    if (!soft) return;
    let active = true,
      made: DepthPlugin | undefined;
    optionalPeer('@margoengine/post', () => import('@margoengine/post/depth'))
      .then((api) => {
        if (!active || scene.engine.disposed) return;
        made = api.DepthTexture.attach(scene.engine as unknown as EngineKernel);
        setDepth(made);
      })
      .catch((error) => active && fail(error));
    return () => {
      active = false;
      setDepth(null);
      made?.dispose();
    };
  }, [scene.engine, soft]);
  useCommit(() => {
    if (!clouds) return;
    const waiting = image === undefined || (soft && !depth);
    replace(clouds.options, {
      ...options,
      ...(waiting ? { range: 0, softness: 0 } : {}),
      ...(material ? { shading: material } : {}),
      ...(image ? { texture: image } : {}),
      ...(soft && depth ? { depth: () => depth.texture } : {}),
    });
    clouds.setFog(fog ?? null);
  });
  return (
    <Mesh {...(meshProps as MeshProps)} ref={ref}>
      <CloudsContext.Provider value={clouds}>{children}</CloudsContext.Provider>
    </Mesh>
  );
});

// A stable number for React's id, so a Cloud with no seed keeps its shape across renders and runs.
const hash = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};

function CloudPart({ clouds, options }: { clouds: NativeClouds | null; options: CloudOptions }) {
  const scene = useScene(),
    registry = useMesh(),
    [cloud, setCloud] = useState<ReturnType<NativeClouds['add']> | null>(null);
  useEffect(() => {
    if (!clouds) return;
    const made = clouds.add({ ...options });
    setCloud(made);
    // The cloud follows its group's world matrix each frame.
    const stop = subscribeFrame(
      scene.frames,
      () => {
        const mesh = live(registry);
        if (!mesh) return;
        scene.engine.store.tick(false);
        made.matrix.set(mesh.matrix);
      },
      -50,
    );
    return () => {
      stop();
      made.remove();
      setCloud(null);
    };
  }, [clouds, scene, registry]);
  useCommit(() => {
    if (cloud) replace(cloud.options, options);
  });
  return null;
}

/**
 * drei's Cloud: a seeded set of soft puffs in a `bounds` box (default 5 x 1 x 1), drawn by the nearest `<Clouds>` (a
 * Cloud on its own makes one). `segments` puffs (20) of up to `volume` wide (6), smaller toward the edges with
 * `concentrate: 'inside'`, turning and breathing with `speed`, fading out within `fade` (10) of the camera.
 */
export const Cloud = /* @__PURE__ */ forwardRef<MeshRef, CloudProps>(function Cloud(props, ref) {
  const clouds = useContext(CloudsContext);
  if (clouds === undefined)
    return (
      <Clouds>
        <CloudIn {...props} ref={ref} />
      </Clouds>
    );
  return <CloudIn {...props} ref={ref} />;
});
// A Cloud inside a Clouds (its own when it had none).
const CloudIn = /* @__PURE__ */ forwardRef<MeshRef, CloudProps>(function CloudIn(props, ref) {
  const clouds = useContext(CloudsContext) ?? null,
    id = useId();
  const [picked, meshProps] = pick(props, cloudKeys),
    options = { seed: hash(id), ...picked } as CloudOptions;
  const { children, ...rest } = meshProps as MeshProps;
  return (
    <Mesh {...rest} ref={ref}>
      <CloudPart clouds={clouds} options={options} />
      {children}
    </Mesh>
  );
});
