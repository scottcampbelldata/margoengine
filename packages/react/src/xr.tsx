import { optionalPeer } from './optional.js';
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EngineKernel } from '@margoengine/core';
import type {
  XR as XRManager,
  XRMode,
  XRSessionOptions,
  XRNativeSession,
  XRFrameState,
  XRInputPose,
} from '@margoengine/xr';
import { Mesh, type MeshProps } from './components.js';
import { splitPointerHandlers } from './events.js';
import { useScene, useResourceEffect } from './internal.js';
import { setWorldPose, worldPose } from './scene-transform.js';
import { advanceFrames, frameTakeover, xrFrameScope } from './frame-priority.js';
import { fault } from '../../shared/errors.js';

/** The xrcontext value component. */
export interface XRContextValue {
  readonly manager: XRManager | null;
  readonly ready: boolean;
  readonly session: XRNativeSession | null;
  /** Call directly from a user gesture after ready becomes true. */
  enter(mode?: XRMode, options?: XRSessionOptions): Promise<XRNativeSession>;
  exit(): Promise<void>;
}
interface XRState extends XRContextValue {
  frames: Set<(state: XRFrameState) => void>;
}
const Context = /* @__PURE__ */ createContext<XRState | null>(null);
/** Props of the XR component; every prop is optional unless noted. */
export interface XRProps {
  children?: ReactNode;
  mode?: XRMode;
  options?: XRSessionOptions;
  onReady?: (manager: XRManager) => void;
  onError?: (error: unknown) => void;
  onSessionStart?: (session: XRNativeSession) => void;
  onSessionEnd?: () => void;
  onFrame?: (state: XRFrameState) => void;
}
/** Prepare the optional plugin on mount. Session entry remains an explicit user action. */
export function XR({ children, ...props }: XRProps) {
  const { engine, frames: sceneFrames } = useScene(),
    [manager, setManager] = useState<XRManager | null>(null),
    [session, setSession] = useState<XRNativeSession | null>(null);
  const current = useRef<XRManager | null>(null),
    mounted = useRef(false),
    detach = useRef<(() => void) | null>(null),
    latest = useRef(props);
  latest.current = props;
  const frames = useMemo(() => new Set<(state: XRFrameState) => void>(), [engine]);
  const report = (error: unknown) => {
    if (mounted.current && !engine.disposed) {
      try {
        latest.current.onError?.(error);
      } finally {
        engine.onError(error);
      }
    }
  };
  useResourceEffect(
    (lease) => {
      mounted.current = true;
      setManager(null);
      setSession(null);
      let instance: XRManager | undefined;
      void optionalPeer('@margoengine/xr', () => import('@margoengine/xr'))
        .then((api) => {
          if (!lease.active || engine.disposed) return;
          return api.XR.create(engine as unknown as EngineKernel);
        })
        .then((value) => {
          if (!value) return;
          instance = value;
          if (!lease.active || engine.disposed) {
            value.dispose();
            return;
          }
          current.current = value;
          setManager(value);
          latest.current.onReady?.(value);
        })
        .catch(report);
      return () => {
        mounted.current = false;
        detach.current?.();
        detach.current = null;
        current.current = null;
        instance?.dispose();
      };
    },
    [engine],
  );
  const actions = useMemo(
    () => ({
      enter(mode?: XRMode, options?: XRSessionOptions): Promise<XRNativeSession> {
        const instance = current.current;
        if (!instance)
          return Promise.reject(
            fault('state', 'XR is not ready; wait for useXR().ready before requesting a session', 'react-usage'),
          );
        const requested = { ...latest.current.options, ...options },
          onFrame = requested.onFrame,
          sessionMode = mode ?? latest.current.mode ?? 'immersive-vr';
        // No await before requestSession: browsers require the caller's user activation.
        return instance
          .requestSession(sessionMode, {
            ...requested,
            onFrame(state) {
              if (sessionMode === 'inline') {
                for (const update of frames) update(state);
                const external: unknown = onFrame?.(state);
                latest.current.onFrame?.(state);
                return external;
              }
              return xrFrameScope(
                sceneFrames,
                () => instance.renderFrame(),
                () => {
                  advanceFrames(sceneFrames, engine, state.delta);
                  for (const update of frames) update(state);
                  const external: unknown = onFrame?.(state);
                  latest.current.onFrame?.(state);
                  return frameTakeover(sceneFrames) ? false : external;
                },
              );
            },
          })
          .then((value) => {
            if (!mounted.current || engine.disposed) {
              void instance.end();
              return value;
            }
            detach.current?.();
            const ended = () => {
              if (sceneFrames.mode === 'demand' && !engine.disposed) engine.stop();
              if (mounted.current) {
                setSession(null);
                latest.current.onSessionEnd?.();
              }
              value.removeEventListener('end', ended);
              if (detach.current === remove) detach.current = null;
            };
            const remove = () => value.removeEventListener('end', ended);
            detach.current = remove;
            value.addEventListener('end', ended, { once: true });
            setSession(value);
            latest.current.onSessionStart?.(value);
            return value;
          })
          .catch((error) => {
            if (sceneFrames.mode === 'demand' && !engine.disposed) engine.stop();
            report(error);
            throw error;
          });
      },
      exit(): Promise<void> {
        return current.current?.end() ?? Promise.resolve();
      },
    }),
    [engine, frames, sceneFrames],
  );
  const value = useMemo<XRState>(
    () => ({ manager, ready: !!manager, session, ...actions, frames }),
    [manager, session, actions, frames],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
/** Returns the XR session controls of the nearest XR component; throws a MargoError (`state`) outside one. */
export function useXR(): XRContextValue {
  const value = useContext(Context);
  if (!value) throw fault('state', 'useXR requires <XR>; call it inside one', 'react-usage');
  return value;
}
/** The controller event component. */
export interface ControllerEvent {
  nativeEvent: Event;
  controller: XRInputPose;
}
/** Props of the Controller component; every prop is optional unless noted. */
export interface ControllerProps extends MeshProps {
  handedness?: 'left' | 'right' | 'none';
  index?: number;
  pose?: 'grip' | 'targetRay';
  onFrame?: (controller: XRInputPose, state: XRFrameState) => void;
  onConnected?: (controller: XRInputPose) => void;
  onDisconnected?: (controller: XRInputPose) => void;
  onSelect?: (event: ControllerEvent) => void;
  onSelectStart?: (event: ControllerEvent) => void;
  onSelectEnd?: (event: ControllerEvent) => void;
  onSqueeze?: (event: ControllerEvent) => void;
  onSqueezeStart?: (event: ControllerEvent) => void;
  onSqueezeEnd?: (event: ControllerEvent) => void;
}
/** The controller component. */
export function Controller({ children, position, rotation, scale, ...all }: ControllerProps) {
  const [events, props] = splitPointerHandlers(all);
  return (
    <Mesh position={position} rotation={rotation} scale={scale} {...events}>
      <ControllerBinding {...props} />
      {children}
    </Mesh>
  );
}
function ControllerBinding(props: Omit<ControllerProps, keyof MeshProps>) {
  const context = useContext(Context);
  if (!context) throw fault('state', 'Controller requires <XR>; render it inside one', 'react-usage');
  const { engine, registry } = useScene(),
    latest = useRef(props);
  latest.current = props;
  useResourceEffect(() => {
    let active: XRInputPose | null = null;
    const update = (state: XRFrameState) => {
      const p = latest.current,
        mesh = registry?.current;
      const controller =
        state.inputs.filter((input) => p.handedness === undefined || input.source.handedness === p.handedness)[
          p.index ?? 0
        ] ?? null;
      if (controller !== active) {
        if (active) p.onDisconnected?.(active);
        active = controller;
        if (controller) p.onConnected?.(controller);
      }
      const pose = p.pose === 'targetRay' ? controller?.targetRay : (controller?.grip ?? controller?.targetRay);
      if (mesh && engine.meshes.get(mesh.id) === mesh) {
        mesh.visible = !!pose;
        if (pose) {
          const t = pose.transform;
          setWorldPose(
            mesh,
            [t.position.x, t.position.y, t.position.z],
            [t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w],
          );
        }
      }
      if (controller) p.onFrame?.(controller, state);
    };
    const attach = () => {
      const mesh = registry?.current;
      if (mesh) mesh.visible = false;
    };
    registry?.attachments.add(attach);
    attach();
    context.frames.add(update);
    const session = context.session;
    const events = [
      ['select', 'onSelect'],
      ['selectstart', 'onSelectStart'],
      ['selectend', 'onSelectEnd'],
      ['squeeze', 'onSqueeze'],
      ['squeezestart', 'onSqueezeStart'],
      ['squeezeend', 'onSqueezeEnd'],
    ] as const;
    const handlers = events.map(([type, key]) => {
      const handler = (event: Event) => {
        if (active && (event as Event & { inputSource?: object }).inputSource === active.source)
          latest.current[key]?.({ nativeEvent: event, controller: active });
      };
      session?.addEventListener(type, handler);
      return () => session?.removeEventListener(type, handler);
    });
    return () => {
      registry?.attachments.delete(attach);
      context.frames.delete(update);
      for (const remove of handlers) remove();
      if (active) latest.current.onDisconnected?.(active);
    };
  }, [engine, registry, context.frames, context.session]);
  return null;
}
/** Props of `<TrackingOrigin>`: the `<Mesh>` props of the node the tracked space hangs from. */
export type TrackingOriginProps = MeshProps;
type Space = Parameters<XRManager['useReferenceSpace']>[0];
/**
 * The node the XR tracking origin is fixed to: the headset camera and every `<Controller>` are posed in its space, so
 * moving, turning or parenting it (a vehicle seat, a teleport target, a moving platform) moves the player, and its
 * children ride along. Its world position and rotation become the session's reference space through WebXR
 * `getOffsetReferenceSpace` (scale is ignored: tracked metres stay metres). A move applies from the next XR frame.
 * Unmounting it, or putting it back at the world origin, gives the session its own space again. One per `<XR>`.
 */
export function TrackingOrigin({ children, ...props }: TrackingOriginProps) {
  return (
    <Mesh {...props}>
      <OriginBinding />
      {children}
    </Mesh>
  );
}
const identity = '0,0,0,0,0,0,1';
function OriginBinding() {
  const context = useContext(Context);
  if (!context) throw fault('state', 'TrackingOrigin requires <XR>; render it inside one', 'react-usage');
  const { engine, registry } = useScene(),
    { manager, session } = context;
  useResourceEffect(() => {
    if (!manager || !session) return;
    // The session's own space, before any offset: each pose of the origin offsets it afresh.
    const base = manager.referenceSpace as (Space & { getOffsetReferenceSpace(transform: unknown): Space }) | undefined;
    let applied = identity;
    const use = (space: Space, key: string) => {
      if (manager.session !== session) return;
      manager.useReferenceSpace(space);
      applied = key;
    };
    const update = () => {
      const mesh = registry?.current;
      if (!base || !mesh || engine.meshes.get(mesh.id) !== mesh) return;
      const { position: p, rotation: q } = worldPose(mesh),
        key = [...p, ...q].join();
      if (key === applied) return;
      if (key === identity) return use(base, key);
      const Rigid = (globalThis as { XRRigidTransform?: new (p: object, o: object) => unknown }).XRRigidTransform;
      if (!Rigid)
        throw fault(
          'unsupported',
          'TrackingOrigin needs XRRigidTransform; run it inside a WebXR browser',
          'react-usage',
        );
      // Poses in the offset space are t^-1 times poses in the base, so t is the inverse of the origin's pose: orientation
      // q^-1 and position -(q^-1 p), where q^-1 p = p - 2w(v x p) + 2 v x (v x p) for a unit q = (v, w).
      const [x, y, z, w] = q,
        cx = y * p[2] - z * p[1],
        cy = z * p[0] - x * p[2],
        cz = x * p[1] - y * p[0],
        rx = p[0] - 2 * w * cx + 2 * (y * cz - z * cy),
        ry = p[1] - 2 * w * cy + 2 * (z * cx - x * cz),
        rz = p[2] - 2 * w * cz + 2 * (x * cy - y * cx);
      use(base.getOffsetReferenceSpace(new Rigid({ x: -rx, y: -ry, z: -rz, w: 1 }, { x: -x, y: -y, z: -z, w })), key);
    };
    context.frames.add(update);
    return () => {
      context.frames.delete(update);
      if (base && applied !== identity) use(base, identity);
    };
  }, [engine, registry, manager, session, context.frames]);
  return null;
}
export type { XRMode, XRSessionOptions, XRNativeSession, XRFrameState, XRInputPose } from '@margoengine/xr';
