import { forwardRef, useImperativeHandle, useRef, type Ref } from 'react';
import type { FrameCallback } from '@margoengine/core';
import type {
  ArcballControls as ArcballInstance,
  FirstPersonControls as FirstPersonInstance,
  FlyControls as FlyInstance,
  TrackballControls as TrackballInstance,
  ArcballProjection,
  Controls,
  ControlEvent,
  MapControls as MapInstance,
  NavigationProfile,
  OrbitControls as OrbitInstance,
  PROFILES,
} from '@margoengine/controls';
import type { CameraTransitions, FitOptions, TransitionOptions } from '@margoengine/controls/transitions';
import type { Mesh as MeshHandle } from '@margoengine/core';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import { sceneWorldBounds } from './center.js';
import { useCommit, useCreated, useScene, type Scene } from './internal.js';
import { optionalPeer } from './optional.js';
import { rangeError } from '../../shared/errors.js';

// Each component loads only the controls entry it uses (`@margoengine/controls/orbit`, `/arcball`), never the package
// index, so a page with OrbitControls does not also fetch TransformControls, DragControls and their BVH raycaster.
type OrbitApi = typeof import('@margoengine/controls/orbit') & typeof import('@margoengine/controls/profiles');
type ArcballApi = typeof import('@margoengine/controls/arcball');
const loadOrbit = (): Promise<OrbitApi> =>
  optionalPeer('@margoengine/controls', () =>
    Promise.all([import('@margoengine/controls/orbit'), import('@margoengine/controls/profiles')]).then(
      ([orbit, profiles]) => ({ ...orbit, ...profiles }),
    ),
  );
type TransitionsApi = typeof import('@margoengine/controls/transitions') &
  typeof import('@margoengine/controls/profiles');
const loadTransitions = (): Promise<TransitionsApi> =>
  optionalPeer('@margoengine/controls', () =>
    Promise.all([import('@margoengine/controls/transitions'), import('@margoengine/controls/profiles')]).then(
      ([transitions, profiles]) => ({ ...transitions, ...profiles }),
    ),
  );
const loadArcball = (): Promise<ArcballApi> =>
  optionalPeer('@margoengine/controls', () => import('@margoengine/controls/arcball'));
type FlyApi = typeof import('@margoengine/controls/fly');
type FirstPersonApi = typeof import('@margoengine/controls/first-person');
type TrackballApi = typeof import('@margoengine/controls/trackball');
const loadFly = (): Promise<FlyApi> => optionalPeer('@margoengine/controls', () => import('@margoengine/controls/fly'));
const loadFirstPerson = (): Promise<FirstPersonApi> =>
  optionalPeer('@margoengine/controls', () => import('@margoengine/controls/first-person'));
const loadTrackball = (): Promise<TrackballApi> =>
  optionalPeer('@margoengine/controls', () => import('@margoengine/controls/trackball'));
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
function useControls<A, T extends Controls>(
  scene: Scene,
  load: () => Promise<A>,
  make: (api: A, scene: Scene) => T,
  ref: Ref<T> | undefined,
  events: ControlEventProps,
  keys: readonly unknown[] = [],
): T | null {
  const controls = useCreated<A, T>(
    scene,
    {
      load,
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
    throw rangeError(`Invalid ${label} distances: need 0 <= minDistance <= maxDistance`, 'react-arguments');
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
function useOrbit<T extends OrbitInstance = OrbitInstance>(
  kind: 'OrbitControls' | 'MapControls',
  props: OrbitControlsProps,
  ref: Ref<T> | undefined,
  load: () => Promise<OrbitApi> = loadOrbit,
): T | null {
  const scene = useScene(),
    api = useRef<OrbitApi | null>(null),
    { onChange, onStart, onEnd, onError, profile, keyEvents, target: center, ...options } = props;
  const controls = useControls<OrbitApi, T>(
    scene,
    load,
    (loaded, { engine }) => {
      api.current = loaded;
      return new loaded[kind](engine.camera, engine.canvas) as T;
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
    if (!chosen)
      throw rangeError(`Unknown navigation profile '${profile}'; use one of ${Object.keys(all)}`, 'react-arguments');
    controls.setProfile(chosen);
  }, [controls, profile]);
  useCommit(() => {
    if (!controls || !keyEvents) return;
    controls.listenToKeyEvents(keyEvents === true ? window : keyEvents);
    return () => controls.stopListenToKeyEvents();
  }, [controls, keyEvents]);
  return controls;
}
/** Orbit the camera around a target: drag rotates, right-drag pans, the wheel zooms. The ref is the `OrbitControls`. */
export const OrbitControls = /* @__PURE__ */ forwardRef<OrbitInstance, OrbitControlsProps>(
  function OrbitControls(props, ref) {
    useOrbit('OrbitControls', props, ref);
    return null;
  },
);
/** Map-style navigation: drag pans across the ground, right-drag rotates. The ref is the `MapControls`. */
export const MapControls = /* @__PURE__ */ forwardRef<MapInstance, OrbitControlsProps>(
  function MapControls(props, ref) {
    useOrbit('MapControls', props, ref as Ref<OrbitInstance>);
    return null;
  },
);
/**
 * CAD navigation: OrbitControls with a CAD tool's mouse bindings and keyboard shortcuts. `profile` defaults to
 * `'margo'`; `'solidworks'`, `'autocad'`, `'inventor'`, `'fusion'`, `'blender'`, `'maya'`, `'onshape'` and
 * `'rhino'` match those tools. Keys are on by default.
 */
export const CadControls = /* @__PURE__ */ forwardRef<OrbitInstance, OrbitControlsProps>(function CadControls(
  { profile = 'margo', keyEvents = true, ...props },
  ref,
) {
  useOrbit('OrbitControls', { ...props, profile, keyEvents }, ref);
  return null;
});

type V3 = [number, number, number];
/** The orbit controls of `@margoengine/controls/transitions`: OrbitControls with `transitions`. */
export type CameraControlsInstance = OrbitInstance & { readonly transitions: CameraTransitions };
/** A world box, a world sphere, or a mesh (its world bounds with every descendant and loaded model). */
export type CameraControlsSubject =
  | { min: readonly [number, number, number]; max: readonly [number, number, number] }
  | MeshHandle
  | EngineMesh;
/**
 * `true` (the default) moves over `duration` seconds, `false` jumps at once, or pass the transition options
 * (`duration`, `easing`, `signal`).
 */
export type CameraControlsTransition = boolean | TransitionOptions;
/**
 * The `ref` of `<CameraControls>`. Each move starts from the view at the call, resolves true when it arrives and false
 * when a drag, a key, `cancel()` or a newer move interrupts it. Angles are radians; azimuth is atan2(x, z) of the
 * camera's offset from the target and polar is measured from +Y, as in `OrbitControls`.
 */
export interface CameraControlsHandle {
  /** The native controls, for everything else (`getDistance()`, `minDistance`, `transitions`, events). */
  readonly controls: CameraControlsInstance;
  /** Move the eye and the target together, orbiting around the moving target. */
  setLookAt(
    position: readonly [number, number, number],
    target: readonly [number, number, number],
    transition?: CameraControlsTransition,
  ): Promise<boolean>;
  /** Move the eye only; the target stays. */
  setPosition(position: readonly [number, number, number], transition?: CameraControlsTransition): Promise<boolean>;
  /** Move the target only; the eye stays. */
  setTarget(target: readonly [number, number, number], transition?: CameraControlsTransition): Promise<boolean>;
  /** Turn around the target by these angles, within the polar and azimuth limits. */
  rotate(azimuth: number, polar: number, transition?: CameraControlsTransition): Promise<boolean>;
  /** Turn around the target to these angles, within the polar and azimuth limits. */
  rotateTo(azimuth: number, polar: number, transition?: CameraControlsTransition): Promise<boolean>;
  /** Move toward the target by `distance` world units (negative moves away), within min and max distance. */
  dolly(distance: number, transition?: CameraControlsTransition): Promise<boolean>;
  /** Move along the view direction to `distance` world units from the target, within min and max distance. */
  dollyTo(distance: number, transition?: CameraControlsTransition): Promise<boolean>;
  /** Slide the eye and the target together along the screen's right (`x`) and up (`y`), in world units. */
  truck(x: number, y: number, transition?: CameraControlsTransition): Promise<boolean>;
  /** Frame a box or a mesh from the current view direction; `padding` is the fraction left on each side (0.05). */
  fitToBox(
    subject: CameraControlsSubject,
    transition?: CameraControlsTransition,
    options?: Pick<FitOptions, 'padding' | 'aspect'>,
  ): Promise<boolean>;
  /** Frame a sphere, or a mesh's bounding sphere, from the current view direction. */
  fitToSphere(
    subject: { centre: readonly [number, number, number]; radius: number } | MeshHandle | EngineMesh,
    transition?: CameraControlsTransition,
    options?: Pick<FitOptions, 'padding' | 'aspect'>,
  ): Promise<boolean>;
  /** Remember the current eye and target for `reset`. The view at mount is saved first. */
  saveState(): void;
  /** Go back to the saved eye and target. */
  reset(transition?: CameraControlsTransition): Promise<boolean>;
  /** Stop a move where it is; its promise resolves false. */
  cancel(): void;
}
/** Props of `<CameraControls>`: those of `<OrbitControls>`, with damping on by default, and the move length. */
export interface CameraControlsProps extends OrbitControlsProps {
  /** Seconds a handle move with `transition` on takes. Default 0.6. */
  duration?: number;
}
const finite = (label: string, ...values: number[]): void => {
  if (values.some((value) => !Number.isFinite(value)))
    throw rangeError(
      `CameraControls.${label} takes finite numbers; pass numbers that are not NaN or Infinity`,
      'react-arguments',
    );
};
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
/**
 * Orbit, dolly and truck the camera with damping on, plus a `ref` that moves it smoothly from code: `setLookAt`,
 * `rotate`, `dolly`, `truck`, `fitToBox`, `fitToSphere`, `reset` (see {@link CameraControlsHandle}). Mouse and
 * touch input interrupts a move. The ref is a {@link CameraControlsHandle}.
 */
export const CameraControls = /* @__PURE__ */ forwardRef<CameraControlsHandle, CameraControlsProps>(
  function CameraControls({ duration = 0.6, enableDamping = true, ...props }, ref) {
    const scene = useScene(),
      controls = useOrbit<CameraControlsInstance>(
        'OrbitControls',
        { ...props, enableDamping },
        undefined,
        loadTransitions as unknown as () => Promise<OrbitApi>,
      ),
      timing = useRef(duration),
      saved = useRef<{ controls: CameraControlsInstance; position: V3; target: V3 } | null>(null);
    timing.current = duration;
    if (!(duration >= 0) || !Number.isFinite(duration))
      throw rangeError('CameraControls duration must be a finite number of seconds >= 0', 'react-arguments');
    if (controls && saved.current?.controls !== controls) {
      const camera = scene.engine.camera;
      saved.current = { controls, position: [...camera.position] as V3, target: [...camera.target] as V3 };
    }
    useImperativeHandle(ref, () => {
      if (!controls) return null as unknown as CameraControlsHandle;
      const camera = () => scene.engine.camera,
        timed = (transition: CameraControlsTransition = true): TransitionOptions =>
          transition === false
            ? { duration: 0 }
            : transition === true
              ? { duration: timing.current }
              : { duration: timing.current, ...transition },
        look = (position: readonly number[], target: readonly number[], transition?: CameraControlsTransition) =>
          controls.transitions.setLookAt(
            [position[0], position[1], position[2]],
            [target[0], target[1], target[2]],
            timed(transition),
          ),
        // A world box from a box literal or a mesh; null when the mesh has nothing to measure.
        box = (subject: CameraControlsSubject) => {
          if ('min' in subject && 'max' in subject) return { min: subject.min, max: subject.max };
          const mesh = scene.engine.meshes.get((subject as EngineMesh).id) as EngineMesh | undefined;
          if (!mesh)
            throw rangeError(
              'CameraControls: that mesh is not in this Canvas; pass a box, a sphere or a mesh drawn by this Canvas',
              'react-arguments',
            );
          const bounds = sceneWorldBounds(scene, mesh);
          if (!bounds)
            throw rangeError(
              'CameraControls: the mesh has no geometry to fit; pass a box or a sphere, or fit after its geometry loads',
              'react-arguments',
            );
          return { min: [bounds[0], bounds[1], bounds[2]] as V3, max: [bounds[3], bounds[4], bounds[5]] as V3 };
        },
        spherical = (azimuth: number, polar: number, transition?: CameraControlsTransition) => {
          const target = camera().target,
            distance = controls.getDistance(),
            a = clamp(azimuth, controls.minAzimuthAngle, controls.maxAzimuthAngle),
            // Keep off the poles, as dragging does, so the view direction never lines up with +Y.
            p = clamp(clamp(polar, controls.minPolarAngle, controls.maxPolarAngle), 1e-6, Math.PI - 1e-6);
          return look(
            [
              target[0] + distance * Math.sin(p) * Math.sin(a),
              target[1] + distance * Math.cos(p),
              target[2] + distance * Math.sin(p) * Math.cos(a),
            ],
            target,
            transition,
          );
        },
        along = (distance: number, transition?: CameraControlsTransition) => {
          const { position, target } = camera(),
            current = controls.getDistance(),
            next = clamp(distance, controls.minDistance, controls.maxDistance);
          if (!current) return look(position, target, transition);
          const scale = next / current;
          return look(
            target.map((value, axis) => value + (position[axis] - value) * scale),
            target,
            transition,
          );
        };
      return {
        controls,
        setLookAt(position, target, transition) {
          finite('setLookAt', ...position, ...target);
          return look(position, target, transition);
        },
        setPosition(position, transition) {
          finite('setPosition', ...position);
          return look(position, camera().target, transition);
        },
        setTarget(target, transition) {
          finite('setTarget', ...target);
          return look(camera().position, target, transition);
        },
        rotate(azimuth, polar, transition) {
          finite('rotate', azimuth, polar);
          return spherical(controls.getAzimuthalAngle() + azimuth, controls.getPolarAngle() + polar, transition);
        },
        rotateTo(azimuth, polar, transition) {
          finite('rotateTo', azimuth, polar);
          return spherical(azimuth, polar, transition);
        },
        dolly(distance, transition) {
          finite('dolly', distance);
          return along(controls.getDistance() - distance, transition);
        },
        dollyTo(distance, transition) {
          finite('dollyTo', distance);
          return along(distance, transition);
        },
        truck(x, y, transition) {
          finite('truck', x, y);
          const { position, target, up } = camera(),
            forward = target.map((value, axis) => value - position[axis]),
            right = [
              forward[1] * up[2] - forward[2] * up[1],
              forward[2] * up[0] - forward[0] * up[2],
              forward[0] * up[1] - forward[1] * up[0],
            ],
            length = Math.hypot(right[0], right[1], right[2]);
          if (!length) return look(position, target, transition);
          for (let axis = 0; axis < 3; axis++) right[axis] /= length;
          const f = Math.hypot(forward[0], forward[1], forward[2]),
            screenUp = [
              (right[1] * forward[2] - right[2] * forward[1]) / f,
              (right[2] * forward[0] - right[0] * forward[2]) / f,
              (right[0] * forward[1] - right[1] * forward[0]) / f,
            ],
            move = right.map((value, axis) => value * x + screenUp[axis] * y);
          return look(
            position.map((value, axis) => value + move[axis]),
            target.map((value, axis) => value + move[axis]),
            transition,
          );
        },
        fitToBox(subject, transition, options) {
          return controls.transitions.fitToBox(box(subject), { ...timed(transition), ...options });
        },
        fitToSphere(subject, transition, options) {
          let sphere: { centre: readonly [number, number, number]; radius: number };
          if ('centre' in subject && 'radius' in subject) sphere = subject;
          else {
            const { min, max } = box(subject);
            sphere = {
              centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
              radius: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2,
            };
          }
          return controls.transitions.fitToSphere(sphere, { ...timed(transition), ...options });
        },
        saveState() {
          const { position, target } = camera();
          saved.current = { controls, position: [...position] as V3, target: [...target] as V3 };
        },
        reset(transition) {
          const state = saved.current!;
          return look(state.position, state.target, transition);
        },
        cancel() {
          controls.transitions.cancel();
        },
      };
    }, [controls, scene]);
    return null;
  },
);

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
export const ArcballControls = /* @__PURE__ */ forwardRef<ArcballInstance, ArcballControlsProps>(
  function ArcballControls(props, ref) {
    const scene = useScene(),
      { onChange, onStart, onEnd, onError, projection, ...options } = props;
    const controls = useControls<ArcballApi, ArcballInstance>(
      scene,
      loadArcball,
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
  },
);

/** Where keyboard controls read keys: the canvas's document (the default) or another target. Read once. */
interface KeyTargetProps {
  /** Element or window the keys are read from. Default the canvas's document. Changing it recreates the controls. */
  keyTarget?: EventTarget;
}
function useKeyed<A, T extends Controls>(
  label: string,
  load: () => Promise<A>,
  make: (api: A, scene: Scene, options: { keyTarget?: EventTarget }) => T,
  props: ControlEventProps & KeyTargetProps & Record<string, unknown>,
  ref: Ref<T> | undefined,
  check?: (values: Record<string, unknown>) => void,
): T | null {
  const scene = useScene(),
    { onChange, onStart, onEnd, onError, keyTarget, ...options } = props;
  const controls = useControls<A, T>(
    scene,
    load,
    (api, current) => make(api, current, keyTarget ? { keyTarget } : {}),
    ref,
    { onChange, onStart, onEnd, onError },
    [keyTarget],
  );
  useCommit(() => {
    if (!controls) return;
    for (const [key, value] of Object.entries(options))
      if (typeof value === 'number' && !Number.isFinite(value) && !(key === 'maxDistance' && value === Infinity))
        throw rangeError(`${label} ${key} must be a finite number`, 'react-arguments');
    check?.(options);
    assign(controls, options);
  });
  return controls;
}

/** Props of `<FlyControls>`: its live fields (a removed prop restores the default) and the key target. */
export interface FlyControlsProps extends ControlEventProps, KeyTargetProps {
  enabled?: boolean;
  /** World units per second. Default 1. */
  movementSpeed?: number;
  /** Radians per second at full steering input. Default 0.01. */
  rollSpeed?: number;
  /** Q and E roll and the turns use the camera's own axes. Default false. */
  enableRoll?: boolean;
  /** Steer only while a button is held. Default false. */
  dragToLook?: boolean;
  /** Keep flying forward. Default false. */
  autoForward?: boolean;
  /** Speed multiplier (Shift adds 0.1 on top). Default 1. */
  movementSpeedMultiplier?: number;
}
/**
 * Free flight: W/S fly along the view, A/D strafe, R/F rise and sink, the arrows and the pointer steer, Q/E roll with
 * `enableRoll`. The ref is the `FlyControls` of `@margoengine/controls/fly`.
 */
export const FlyControls = /* @__PURE__ */ forwardRef<FlyInstance, FlyControlsProps>(function FlyControls(props, ref) {
  useKeyed<FlyApi, FlyInstance>(
    'FlyControls',
    loadFly,
    (api, { engine }, options) => new api.FlyControls(engine.camera, engine.canvas, options),
    props as FlyControlsProps & Record<string, unknown>,
    ref,
  );
  return null;
});

/** Props of `<FirstPersonControls>`: its live fields and the key target. */
export interface FirstPersonControlsProps extends ControlEventProps, KeyTargetProps {
  enabled?: boolean;
  /** World units per second. Default 1. */
  movementSpeed?: number;
  /** Radians per second per CSS pixel of pointer offset from the centre. Default 0.005. */
  lookSpeed?: number;
  /** Let the vertical pointer offset tilt the view. Default true. */
  lookVertical?: boolean;
  /** Keep walking forward. Default false. */
  autoForward?: boolean;
  /** Pointer look and button walking. Default true. */
  activeLook?: boolean;
  /** Walk faster the higher the camera is. Default false. */
  heightSpeed?: boolean;
  /** Default 1. */
  heightCoef?: number;
  /** Default 0. */
  heightMin?: number;
  /** Default 1. */
  heightMax?: number;
  /** Map the vertical look range onto [verticalMin, verticalMax]. Default false. */
  constrainVertical?: boolean;
  /** Radians from +Y. Default 0. */
  verticalMin?: number;
  /** Radians from +Y. Default PI. */
  verticalMax?: number;
}
/**
 * Walk and look: the pointer's offset from the centre turns the view, WASD or the arrows walk, R/F rise and sink, the
 * left and right buttons walk forward and back. The ref is the `FirstPersonControls` of
 * `@margoengine/controls/first-person`.
 */
export const FirstPersonControls = /* @__PURE__ */ forwardRef<FirstPersonInstance, FirstPersonControlsProps>(
  function FirstPersonControls(props, ref) {
    useKeyed<FirstPersonApi, FirstPersonInstance>(
      'FirstPersonControls',
      loadFirstPerson,
      (api, { engine }, options) => new api.FirstPersonControls(engine.camera, engine.canvas, options),
      props as FirstPersonControlsProps & Record<string, unknown>,
      ref,
      (values) => {
        const { verticalMin = 0, verticalMax = Math.PI } = values as { verticalMin?: number; verticalMax?: number };
        if (!(verticalMin >= 0 && verticalMax <= Math.PI && verticalMin <= verticalMax))
          throw rangeError('FirstPersonControls needs 0 <= verticalMin <= verticalMax <= PI', 'react-arguments');
      },
    );
    return null;
  },
);

/** Props of `<TrackballControls>`: its live fields and the key target. */
export interface TrackballControlsProps extends ControlEventProps, KeyTargetProps {
  enabled?: boolean;
  /** Default 1. */
  rotateSpeed?: number;
  /** Default 1.2. */
  zoomSpeed?: number;
  /** Default 0.3. */
  panSpeed?: number;
  noRotate?: boolean;
  noZoom?: boolean;
  noPan?: boolean;
  /** Stop as soon as the pointer stops (no coasting). Default false. */
  staticMoving?: boolean;
  /** Default 0.2. */
  dynamicDampingFactor?: number;
  /** Let the ball roll the view and pass over the poles. Default false. */
  enableRoll?: boolean;
  /** Default 0. */
  minDistance?: number;
  /** Default Infinity. */
  maxDistance?: number;
  /** `KeyboardEvent.code` values that make the left button rotate, zoom or pan. Default `['KeyA', 'KeyS', 'KeyD']`. */
  keys?: string[];
  /** Action of each mouse button (`MOUSE.ROTATE`, `DOLLY`, `PAN` or null). */
  mouseButtons?: { LEFT: number | null; MIDDLE: number | null; RIGHT: number | null };
}
/**
 * Tumble the camera around its target with a virtual trackball, zoom and pan, coasting after a fling. The ref is the
 * `TrackballControls` of `@margoengine/controls/trackball`.
 */
export const TrackballControls = /* @__PURE__ */ forwardRef<TrackballInstance, TrackballControlsProps>(
  function TrackballControls(props, ref) {
    useKeyed<TrackballApi, TrackballInstance>(
      'TrackballControls',
      loadTrackball,
      (api, { engine }, options) => new api.TrackballControls(engine.camera, engine.canvas, options),
      props as TrackballControlsProps & Record<string, unknown>,
      ref,
      ({ minDistance, maxDistance }) => distances(minDistance as number, maxDistance as number, 'TrackballControls'),
    );
    return null;
  },
);
export {
  DragControls,
  type DragControlsProps,
  type DragLimit,
  PivotControls,
  type PivotComponent,
  type PivotControlsProps,
  type PivotDragStart,
  PointerLock,
  TransformControls,
  type PointerLockProps,
  type TransformControlsProps,
} from './controls-helpers.js';
