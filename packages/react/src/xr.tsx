'use client';
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
import { useScene, useResourceEffect } from './internal.js';
import { setWorldPose } from './scene-transform.js';
import { MargoError } from '@margoengine/math/errors';

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
const Context = createContext<XRState | null>(null);
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
          return Promise.reject(new Error('XR is not ready; wait for useXR().ready before requesting a session'));
        const requested = { ...latest.current.options, ...options },
          onFrame = requested.onFrame,
          sessionMode = mode ?? latest.current.mode ?? 'immersive-vr';
        // No await before requestSession: browsers require the caller's user activation.
        return instance
          .requestSession(sessionMode, {
            ...requested,
            onFrame(state) {
              if (sessionMode !== 'inline') {
                sceneFrames.elapsed += state.delta;
                for (const callback of sceneFrames.callbacks) callback(engine as unknown as EngineKernel, state.delta);
              }
              for (const update of frames) update(state);
              onFrame?.(state);
              latest.current.onFrame?.(state);
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
  if (!value) throw new MargoError('state', 'useXR requires <XR>; call it inside one.');
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
export function Controller({
  children,
  position,
  rotation,
  scale,
  onClick,
  onPointerOver,
  onPointerOut,
  ...props
}: ControllerProps) {
  return (
    <Mesh
      position={position}
      rotation={rotation}
      scale={scale}
      onClick={onClick}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
    >
      <ControllerBinding {...props} />
      {children}
    </Mesh>
  );
}
function ControllerBinding(props: Omit<ControllerProps, keyof MeshProps>) {
  const context = useContext(Context);
  if (!context) throw new MargoError('state', 'Controller requires <XR>; render it inside one.');
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
export type { XRMode, XRSessionOptions, XRNativeSession, XRFrameState, XRInputPose } from '@margoengine/xr';
