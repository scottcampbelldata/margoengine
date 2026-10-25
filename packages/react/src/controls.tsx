'use client';
import { forwardRef, useRef, type Ref } from 'react';
import type { FrameCallback } from '@margoengine/core';
import type {
  ArcballControls as ArcballInstance,
  ArcballProjection,
  Controls,
  ControlEvent,
  MapControls as MapInstance,
  NavigationProfile,
  OrbitControls as OrbitInstance,
  PROFILES,
} from '@margoengine/controls';
import { useCommit, useCreated, useScene, type Scene } from './internal.js';
import { optionalPeer } from './optional.js';

type ControlsApi = typeof import('@margoengine/controls');
/** A CAD tool's navigation profile by name; the props also take a custom `NavigationProfile`. */
export type ProfileName = keyof typeof PROFILES;
/** Event props every camera controls component takes. */
export interface ControlEventProps {
  /** The camera moved (each frame it moves, damping included). */
  onChange?: (event: ControlEvent) => void;
  /** A drag, wheel or touch gesture began. */
  onStart?: (event: ControlEvent) => void;
  /** The gesture ended. */
  onEnd?: (event: ControlEvent) => void;
  /** Loading `@margoengine/controls` failed. */
  onError?: (error: unknown) => void;
}
const handlers = { change: 'onChange', start: 'onStart', end: 'onEnd' } as const;
const unsubscribe = new WeakMap<Controls, () => void>();
// Drives the controls from the Canvas frame loop, so `frameloop="demand"` and `invalidate()` move them too.
function useControls<T extends Controls>(
  scene: Scene,
  make: (api: ControlsApi, scene: Scene) => T,
  ref: Ref<T> | undefined,
  events: ControlEventProps,
  keys: readonly unknown[] = [],
): T | null {
  const controls = useCreated<ControlsApi, T>(
    scene,
    {
      load: () => optionalPeer('@margoengine/controls', () => import('@margoengine/controls')),
      create: (api) => {
        const instance = make(api, scene),
          frame: FrameCallback = (_, delta) => {
            if (instance.enabled) instance.update(delta);
          };
        scene.frames.callbacks.add(frame);
        unsubscribe.set(instance, () => scene.frames.callbacks.delete(frame));
        return instance;
      },
      dispose: (instance) => {
        unsubscribe.get(instance)?.();
        instance.dispose();
      },
      ref,
      onError: events.onError,
    },
    keys,
  );
  const latest = useRef(events);
  latest.current = events;
  useCommit(() => {
    if (!controls) return;
    const removers = (['change', 'start', 'end'] as const).map((type) => {
      const listener = (event: ControlEvent) => latest.current[handlers[type]]?.(event);
      controls.addEventListener(type, listener);
      return () => controls.removeEventListener(type, listener);
    });
    return () => {
      for (const remove of removers) remove();
    };
  }, [controls]);
  return controls;
}
const defaults = new WeakMap<object, Map<string, unknown>>();
// Applies the props each commit, declaratively: a prop that is removed again restores the controls' own default
// (the value it had before the first prop set it).
function assign(target: object, values: Record<string, unknown>): void {
  let saved = defaults.get(target);
  if (!saved) defaults.set(target, (saved = new Map()));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (!saved.has(key)) saved.set(key, Reflect.get(target, key));
    Reflect.set(target, key, value);
  }
  for (const [key, value] of saved) if (values[key] === undefined) Reflect.set(target, key, value);
}
function distances(minDistance = 0, maxDistance = Infinity, label: string): void {
  if (!(minDistance >= 0) || !(maxDistance >= minDistance))
    throw new RangeError(`Invalid ${label} distances: need 0 <= minDistance <= maxDistance`);
}

/** Props of `<OrbitControls>`, `<MapControls>` and `<CadControls>`: the controls' live fields, a target, a CAD profile and keys. */
export interface OrbitControlsProps extends ControlEventProps {
  /** Turn the controls off without unmounting them. Default true. */
  enabled?: boolean;
  /** Point to orbit around, in world units; applied when it changes. Default the camera's target. */
  target?: readonly [number, number, number];
  enableDamping?: boolean;
  dampingFactor?: number;
  enableZoom?: boolean;
  zoomSpeed?: number;
  enableRotate?: boolean;
  rotateSpeed?: number;
  enablePan?: boolean;
  panSpeed?: number;
  screenSpacePanning?: boolean;
  keyPanSpeed?: number;
  zoomToCursor?: boolean;
  autoRotate?: boolean;
  /** One turn takes 60 / autoRotateSpeed seconds. Default 2. */
  autoRotateSpeed?: number;
  minDistance?: number;
  maxDistance?: number;
  /** Radians from +Y. */
  minPolarAngle?: number;
  maxPolarAngle?: number;
  minAzimuthAngle?: number;
  maxAzimuthAngle?: number;
  /** Mouse bindings of a CAD tool: a name such as `'solidworks'`, or a `NavigationProfile`. */
  profile?: ProfileName | NavigationProfile;
  /** Arrow-key panning plus the profile's keys: `true` listens on `window`, or pass an element. Default off. */
  keyEvents?: boolean | EventTarget;
}
function useOrbit(
  kind: 'OrbitControls' | 'MapControls',
  props: OrbitControlsProps,
  ref: Ref<OrbitInstance> | undefined,
): void {
  const scene = useScene(),
    api = useRef<ControlsApi | null>(null),
    { onChange, onStart, onEnd, onError, profile, keyEvents, target: center, ...options } = props;
  const controls = useControls<OrbitInstance>(
    scene,
    (loaded, { engine }) => {
      api.current = loaded;
      return new loaded[kind](engine.camera, engine.canvas);
    },
    ref,
    { onChange, onStart, onEnd, onError },
  );
  useCommit(() => {
    if (!controls) return;
    distances(options.minDistance, options.maxDistance, kind);
    assign(controls, options);
  });
  // Only when the prop changes: between renders the controls move the target themselves (panning).
  useCommit(() => {
    if (controls && center) scene.engine.camera.target = [center[0], center[1], center[2]];
  }, [controls, center?.[0], center?.[1], center?.[2]]);
  useCommit(() => {
    if (!controls || profile === undefined) return;
    const all = api.current!.PROFILES,
      chosen = typeof profile === 'object' ? profile : all[profile];
    if (!chosen) throw new RangeError(`Unknown navigation profile '${profile}'; use one of ${Object.keys(all)}`);
    controls.setProfile(chosen);
  }, [controls, profile]);
  useCommit(() => {
    if (!controls || !keyEvents) return;
    controls.listenToKeyEvents(keyEvents === true ? window : keyEvents);
    return () => controls.stopListenToKeyEvents();
  }, [controls, keyEvents]);
}
/** Orbit the camera around a target: drag rotates, right-drag pans, the wheel zooms. The ref is the `OrbitControls`. */
export const OrbitControls = forwardRef<OrbitInstance, OrbitControlsProps>(function OrbitControls(props, ref) {
  useOrbit('OrbitControls', props, ref);
  return null;
});
/** Map-style navigation: drag pans across the ground, right-drag rotates. The ref is the `MapControls`. */
export const MapControls = forwardRef<MapInstance, OrbitControlsProps>(function MapControls(props, ref) {
  useOrbit('MapControls', props, ref as Ref<OrbitInstance>);
  return null;
});
/**
 * CAD navigation: OrbitControls with a CAD tool's mouse bindings and keyboard shortcuts. `profile` defaults to
 * `'margo'`; `'solidworks'`, `'autocad'`, `'inventor'`, `'fusion'`, `'blender'`, `'maya'`, `'onshape'` and
 * `'rhino'` match those tools. Keys are on by default.
 */
export const CadControls = forwardRef<OrbitInstance, OrbitControlsProps>(function CadControls(
  { profile = 'margo', keyEvents = true, ...props },
  ref,
) {
  useOrbit('OrbitControls', { ...props, profile, keyEvents }, ref);
  return null;
});

/** Props of `<ArcballControls>`: its live fields, plus `projection`, which is read once. */
export interface ArcballControlsProps extends ControlEventProps {
  enabled?: boolean;
  enableRotate?: boolean;
  enableZoom?: boolean;
  enablePan?: boolean;
  rotateSpeed?: number;
  zoomSpeed?: number;
  panSpeed?: number;
  enableDamping?: boolean;
  dampingFactor?: number;
  zoomToCursor?: boolean;
  minDistance?: number;
  maxDistance?: number;
  minZoom?: number;
  maxZoom?: number;
  /** Projection zoomed under a fixed-size orthographic camera. Read once: changing it recreates the controls. */
  projection?: ArcballProjection | null;
}
/** Rotate the view freely with a virtual trackball (no locked up direction); pan and zoom as with orbit. */
export const ArcballControls = forwardRef<ArcballInstance, ArcballControlsProps>(function ArcballControls(props, ref) {
  const scene = useScene(),
    { onChange, onStart, onEnd, onError, projection, ...options } = props;
  const controls = useControls<ArcballInstance>(
    scene,
    (api, { engine }) =>
      new api.ArcballControls(engine.camera, engine.canvas, projection === undefined ? {} : { projection }),
    ref,
    { onChange, onStart, onEnd, onError },
    [projection],
  );
  useCommit(() => {
    if (!controls) return;
    distances(options.minDistance, options.maxDistance, 'ArcballControls');
    assign(controls, options);
  });
  return null;
});
