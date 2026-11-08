import { createContext, forwardRef, useContext, useRef, useState, type ReactNode, type Ref } from 'react';
import type { EngineKernel } from '@margoengine/core';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import type * as AudioModule from '@margoengine/audio';
import type { Audio as AudioObject, AudioListener, DistanceModel } from '@margoengine/audio';
import type * as SciVizModule from '@margoengine/sciviz';
import type {
  Figure as FigureObject,
  FigureOptions,
  Layer,
  LineLayer,
  LineLayerOptions,
  ScatterData,
  ScatterLayer,
  ScatterLayerOptions,
  SurfaceLayer,
  SurfaceLayerOptions,
} from '@margoengine/sciviz';
import type * as SpritesModule from '@margoengine/sprites';
import type {
  Sprite as SpriteObject,
  SpriteLayer as SpriteLayerObject,
  SpriteLayerOptions,
  SpriteOptions,
} from '@margoengine/sprites';
import type * as UiReact from '@margoengine/ui/react';
import type { UiRootProps } from '@margoengine/ui/react';
import { MargoError } from '@margoengine/math/errors';
import { live, report, useCommit, useCreated, useLiveRef, useScene, type Scene } from './internal.js';
import { optionalPeer } from './optional.js';

interface ErrorProps {
  /** Receives a failed load or attach, before the Canvas `onError`. */
  onError?: (error: unknown) => void;
}
const none = () => {};

// ---------------------------------------------------------------------------------------------------------------- UI

/** Props of {@link GameUi}: those of `UiRoot` from `@margoengine/ui/react`, without `engine`. */
export interface GameUiProps extends Omit<UiRootProps, 'engine'>, ErrorProps {}
/**
 * The game UI of `@margoengine/ui` on the Canvas engine: `UiRoot` with `engine` filled in. Nest the widgets of
 * `@margoengine/ui/react` (`Panel`, `Label`, `Button`, `HealthBar`, ...) inside. Renders nothing until the package loads.
 */
export function GameUi({ onError, ...props }: GameUiProps): ReactNode {
  const scene = useScene();
  const api = useCreated<typeof UiReact, typeof UiReact>(
    scene,
    {
      load: () => optionalPeer('@margoengine/ui', () => import('@margoengine/ui/react')),
      create: (module) => module,
      dispose: none,
      onError,
    },
    [],
  );
  return api ? <api.UiRoot {...props} engine={scene.engine as unknown as EngineKernel} /> : null;
}

// ------------------------------------------------------------------------------------------------------------- Audio

const listeners = new WeakMap<object, { listener: AudioListener; users: number; owned: boolean }>();
/** One listener per engine, shared by its sounds: the app's own if it attached one, else one made here. */
function acquireListener(scene: Scene, api: typeof AudioModule): AudioListener {
  let entry = listeners.get(scene.engine);
  if (!entry) {
    const existing = scene.engine.plugins.get('margoengine-audio');
    entry =
      existing instanceof api.AudioListener
        ? { listener: existing, users: 0, owned: false }
        : { listener: api.AudioListener.attach(scene.engine as unknown as EngineKernel), users: 0, owned: true };
    listeners.set(scene.engine, entry);
  }
  entry.users++;
  return entry.listener;
}
function releaseListener(scene: Scene): void {
  const entry = listeners.get(scene.engine);
  if (!entry || --entry.users > 0) return;
  listeners.delete(scene.engine);
  if (entry.owned && !scene.engine.disposed) scene.engine.removePlugin(entry.listener.name);
}

/** Props of {@link Sound}. */
export interface SoundProps extends ErrorProps {
  /** A URL (fetched and decoded once per URL) or a decoded `AudioBuffer`. Required. */
  src: string | AudioBuffer;
  /** Plays while true, pauses when false. Default true. Browsers start audio only after a click or key press. */
  playing?: boolean;
  /** Default 1. */
  volume?: number;
  /** Default false. */
  loop?: boolean;
  /** Default 1. */
  playbackRate?: number;
  /** Follows the enclosing `<Mesh>` with distance and direction. Default: true inside a `<Mesh>`, else false. */
  positional?: boolean;
  /** Positional only: distance where the volume starts to fall. Default 1. */
  refDistance?: number;
  /** Positional only. Default 10000. */
  maxDistance?: number;
  /** Positional only. Default 1. */
  rolloffFactor?: number;
  /** Positional only: `'inverse'`, `'linear'` or `'exponential'`. Default `'inverse'`. */
  distanceModel?: DistanceModel;
  /** The sound reached its end (not called for a loop). */
  onEnded?: () => void;
}
/**
 * A sound of `@margoengine/audio`, with the Canvas's one `AudioListener` following its camera. Inside a `<Mesh>` it is
 * positional and moves with the mesh. The ref is the `Audio` (or `PositionalAudio`).
 */
export const Sound = forwardRef<AudioObject, SoundProps>(function Sound(props, ref) {
  const scene = useScene(),
    registry = scene.registry,
    positional = props.positional ?? registry !== null,
    latest = useRef(props),
    [loaded, setLoaded] = useState<AudioBuffer | null>(null);
  latest.current = props;
  if (positional && !registry)
    throw new MargoError('state', 'A positional <Sound> follows a mesh; put it inside a <Mesh>, or set positional={false}.');
  const sound = useCreated<typeof AudioModule, { sound: AudioObject; release: () => void }>(
    scene,
    {
      load: () => optionalPeer('@margoengine/audio', () => import('@margoengine/audio')),
      create: (api) => {
        const listener = acquireListener(scene, api),
          p = latest.current,
          common = { volume: p.volume ?? 1, loop: p.loop ?? false, playbackRate: p.playbackRate ?? 1 };
        const made = positional
          ? new api.PositionalAudio(listener, {
              ...common,
              refDistance: p.refDistance,
              maxDistance: p.maxDistance,
              rolloffFactor: p.rolloffFactor,
              distanceModel: p.distanceModel,
            })
          : new api.Audio(listener, common);
        made.onEnded = () => latest.current.onEnded?.();
        const follow = (mesh: EngineMesh) => (made as AudioModule.PositionalAudio).attach(mesh as never);
        if (positional && registry) {
          registry.attachments.add(follow);
          const mesh = live(registry);
          if (mesh) follow(mesh);
        }
        return {
          sound: made,
          release() {
            registry?.attachments.delete(follow);
            made.dispose();
            releaseListener(scene);
          },
        };
      },
      dispose: (value) => value.release(),
      onError: props.onError,
    },
    [positional],
  );
  const current = sound?.sound ?? null;
  // The buffer: decoded once per URL by the listener, then given to the sound.
  useCommit(() => {
    if (!current) return;
    const abort = new AbortController(),
      { src } = latest.current;
    setLoaded(null);
    const listener = listeners.get(scene.engine)!.listener;
    (typeof src === 'string' ? listener.load(src, { signal: abort.signal }) : Promise.resolve(src))
      .then((buffer) => {
        if (abort.signal.aborted) return;
        current.stop();
        current.setBuffer(buffer);
        setLoaded(buffer);
      })
      .catch((error) => {
        if (!abort.signal.aborted && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    return () => abort.abort();
  }, [current, props.src]);
  useCommit(() => {
    if (!current) return;
    current.volume = props.volume ?? 1;
    current.loop = props.loop ?? false;
    current.playbackRate = props.playbackRate ?? 1;
    if (current instanceof Object && 'refDistance' in current) {
      const spatial = current as AudioModule.PositionalAudio;
      if (props.refDistance !== undefined) spatial.refDistance = props.refDistance;
      if (props.maxDistance !== undefined) spatial.maxDistance = props.maxDistance;
      if (props.rolloffFactor !== undefined) spatial.rolloffFactor = props.rolloffFactor;
      if (props.distanceModel !== undefined) spatial.distanceModel = props.distanceModel;
    }
  }, [
    current,
    props.volume,
    props.loop,
    props.playbackRate,
    props.refDistance,
    props.maxDistance,
    props.rolloffFactor,
    props.distanceModel,
  ]);
  const playing = props.playing ?? true;
  useCommit(() => {
    if (!current || !loaded) return;
    if (playing && !current.isPlaying) current.play();
    else if (!playing && current.isPlaying) current.pause();
  }, [current, loaded, playing]);
  useLiveRef(ref, current);
  return null;
});

// --------------------------------------------------------------------------------------------------------------- 2D

const LayerContext = createContext<SpriteLayerObject | null>(null);
/** Props of {@link SpriteLayer}: the `@margoengine/sprites` layer options. */
export interface SpriteLayerProps extends SpriteLayerOptions, ErrorProps {
  children?: ReactNode;
}
/**
 * A `@margoengine/sprites` layer on the Canvas engine: one instanced draw of its `<Sprite>` children at exact pixels.
 * `atlas` swaps in place; `camera`, `snap` and `ySort` are read each frame; other options recreate the layer.
 */
export const SpriteLayer = forwardRef<SpriteLayerObject, SpriteLayerProps>(function SpriteLayer(
  { children, onError, atlas, camera, snap, ySort, ...options },
  ref,
) {
  const scene = useScene(),
    first = useRef({ atlas, camera, snap, ySort });
  const layer = useCreated<typeof SpritesModule, SpriteLayerObject>(
    scene,
    {
      load: () => optionalPeer('@margoengine/sprites', () => import('@margoengine/sprites')),
      create: (api) =>
        api.SpriteLayer.attach(scene.engine as unknown as EngineKernel, { ...options, ...first.current }),
      dispose: (value) => value.dispose(),
      onError,
      ref,
    },
    [options.order, options.layers, options.capacity, options.name, options.target, options.normals, options.clear],
  );
  useCommit(() => {
    if (!layer) return;
    if (camera) layer.camera = camera;
    if (snap !== undefined) layer.snap = snap;
    if (ySort !== undefined) layer.ySort = ySort;
  }, [layer, camera, snap, ySort]);
  const shown = useRef(atlas);
  useCommit(() => {
    if (layer && shown.current !== atlas) {
      shown.current = atlas;
      layer.setAtlas(atlas);
    }
  }, [layer, atlas]);
  return <LayerContext.Provider value={layer}>{layer ? children : null}</LayerContext.Provider>;
});
/** Props of {@link Sprite}: the fields of a `@margoengine/sprites` sprite. */
export interface SpriteProps extends SpriteOptions {}
/** One sprite of the enclosing `<SpriteLayer>`; props update its fields in place. The ref is the `Sprite`. */
export const Sprite = forwardRef<SpriteObject, SpriteProps>(function Sprite(props, ref) {
  const layer = useContext(LayerContext);
  if (!layer) throw new MargoError('state', '<Sprite> draws in a layer; put it inside a <SpriteLayer>.');
  const [sprite, setSprite] = useState<SpriteObject | null>(null),
    latest = useRef(props);
  latest.current = props;
  useCommit(() => {
    const made = layer.add({ ...latest.current });
    setSprite(made);
    return () => {
      layer.remove(made);
      setSprite((value) => (value === made ? null : value));
    };
  }, [layer]);
  useCommit(() => {
    if (sprite) Object.assign(sprite, props);
  });
  useLiveRef(ref, sprite);
  return null;
});

// ----------------------------------------------------------------------------------------------------------- SciViz

const FigureContext = createContext<FigureObject | null>(null);
/** Props of {@link Figure}: the `@margoengine/sciviz` figure options. */
export interface FigureProps extends FigureOptions, ErrorProps {
  /** Axes and labels are drawn (`figure.ready()` resolved). */
  onReady?: (figure: FigureObject) => void;
  children?: ReactNode;
}
/**
 * A `@margoengine/sciviz` figure on the Canvas engine, with its plot children (`ScatterPlot`, `LinePlot`,
 * `SurfacePlot`). The camera stays the Canvas's. Changed options (compared by value) recreate the figure. WebGPU only.
 */
export const Figure = forwardRef<FigureObject, FigureProps>(function Figure(
  { children, onError, onReady, ...options },
  ref,
) {
  const scene = useScene(),
    latest = useRef({ options, onReady, onError });
  latest.current = { options, onReady, onError };
  const key = byValue(options);
  const figure = useCreated<typeof SciVizModule, FigureObject>(
    scene,
    {
      load: () => optionalPeer('@margoengine/sciviz', () => import('@margoengine/sciviz')),
      create: (api) => {
        const made = api.Figure.attach(scene.engine as unknown as EngineKernel, latest.current.options);
        made.ready().then(
          () => latest.current.onReady?.(made),
          (error) => report(scene, error, latest.current.onError),
        );
        return made;
      },
      dispose: (value) => value.dispose(),
      onError,
      ref,
    },
    [key],
  );
  return <FigureContext.Provider value={figure}>{figure ? children : null}</FigureContext.Provider>;
});
/** A plot layer of the enclosing figure: made when the figure and the data are there, removed when they change. */
function usePlot<L extends Layer>(
  name: string,
  make: (figure: FigureObject) => L | Promise<L>,
  keys: readonly unknown[],
  ref: Ref<L> | undefined,
  onError: ((error: unknown) => void) | undefined,
): void {
  const scene = useScene(),
    figure = useContext(FigureContext),
    [layer, setLayer] = useState<L | null>(null),
    build = useRef(make),
    errors = useRef(onError);
  build.current = make;
  errors.current = onError;
  if (!figure) throw new MargoError('state', `<${name}> plots into a figure; put it inside a <Figure>.`);
  useCommit(() => {
    let closed = false,
      made: L | undefined;
    Promise.resolve()
      .then(() => build.current(figure))
      .then((value) => {
        if (closed) figure.remove(value);
        else {
          made = value;
          setLayer(value);
        }
      })
      .catch((error) => {
        if (!closed && !scene.engine.disposed) report(scene, error, errors.current);
      });
    return () => {
      closed = true;
      if (made) {
        figure.remove(made);
        setLayer((value) => (value === made ? null : value));
      }
    };
  }, [figure, ...keys]);
  useLiveRef(ref, layer);
}
/** Props of {@link ScatterPlot}. A new `data` object rebuilds the layer: keep it in `useMemo` or state. */
export interface ScatterPlotProps extends ErrorProps {
  data: ScatterData;
  options?: ScatterLayerOptions;
}
/** `figure.scatter(data, options)` of the enclosing `<Figure>`. The ref is the layer. */
export const ScatterPlot = forwardRef<ScatterLayer, ScatterPlotProps>(function ScatterPlot(
  { data, options, onError },
  ref,
) {
  usePlot('ScatterPlot', (figure) => figure.scatter(data, options), [data, byValue(options)], ref, onError);
  return null;
});
/** Props of {@link LinePlot}. A new `data` object rebuilds the layer: keep it in `useMemo` or state. */
export interface LinePlotProps extends ErrorProps {
  data: Parameters<FigureObject['line']>[0];
  options?: LineLayerOptions;
}
/** `figure.line(data, options)` of the enclosing `<Figure>`. The ref is the layer. */
export const LinePlot = forwardRef<LineLayer, LinePlotProps>(function LinePlot({ data, options, onError }, ref) {
  usePlot('LinePlot', (figure) => figure.line(data, options), [data, byValue(options)], ref, onError);
  return null;
});
/** Props of {@link SurfacePlot}. A new `z` rebuilds the layer: keep it in `useMemo` or state. */
export interface SurfacePlotProps extends ErrorProps {
  z: Parameters<FigureObject['surface']>[0];
  options?: SurfaceLayerOptions;
}
/** `figure.surface(z, options)` of the enclosing `<Figure>`. The ref is the layer. */
export const SurfacePlot = forwardRef<SurfaceLayer, SurfacePlotProps>(function SurfacePlot(
  { z, options, onError },
  ref,
) {
  usePlot('SurfacePlot', (figure) => figure.surface(z, options), [z, byValue(options)], ref, onError);
  return null;
});

// ----------------------------------------------------------------------------------------------------------- shared

/** Options compared by value, so an inline object does not rebuild; functions and typed arrays by identity. */
function byValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  const seen: unknown[] = [];
  const text = JSON.stringify(value, (_, v) => {
    if (typeof v === 'function' || ArrayBuffer.isView(v)) {
      if (!seen.includes(v)) seen.push(v);
      return `#${seen.indexOf(v)}`;
    }
    return v;
  });
  return text + seen.map(identity).join('');
}
const ids = new WeakMap<object, number>();
let nextId = 0;
function identity(value: unknown): string {
  const key = value as object;
  if (!ids.has(key)) ids.set(key, ++nextId);
  return `@${ids.get(key)}`;
}
