import { forwardRef, useEffect, useRef, useState, type Ref, type RefObject } from 'react';
import type { EngineKernel, FrameCallback, Mesh as MeshHandle } from '@margoengine/core';
import type {
  PointerLockControls as PointerControls,
  TransformControls as GizmoControls,
  TransformControlsOptions,
  ControlEvent,
} from '@margoengine/controls';
import { Mesh, type MeshProps } from './components.js';
import { splitPointerHandlers } from './events.js';
import { useScene, useCommit, useLiveRef, assignRef, report, type Registry } from './internal.js';
import { optionalPeer } from './optional.js';

interface ErrorProps {
  onError?: (error: unknown) => void;
}

/** Props of the PointerLock component; every prop is optional unless noted. */
export interface PointerLockProps extends ErrorProps {
  enabled?: boolean;
  pointerSpeed?: number;
  movementSpeed?: number;
  requireLock?: boolean;
  minPolarAngle?: number;
  maxPolarAngle?: number;
  lockOnClick?: boolean;
  onLock?: (event: ControlEvent) => void;
  onUnlock?: (event: ControlEvent) => void;
  onChange?: (event: ControlEvent) => void;
}
/** The pointer lock component. */
export const PointerLock = forwardRef<PointerControls, PointerLockProps>(function PointerLock(props, ref) {
  const scene = useScene(),
    latest = useRef(props),
    [controls, setControls] = useState<PointerControls | null>(null),
    handle = useRef(ref);
  handle.current = ref;
  latest.current = props;
  useEffect(() => {
    let active = true,
      current: PointerControls | undefined,
      release = () => {};
    optionalPeer('@margoengine/controls', () => import('@margoengine/controls'))
      .then(({ PointerLockControls }) => {
        if (!active || scene.engine.disposed) return;
        current = new PointerLockControls(scene.engine.camera, scene.engine.canvas);
        const control = current,
          frame: FrameCallback = (_, delta) => {
            control.update(delta);
          };
        const click = () => {
          if (latest.current.lockOnClick !== false && control.enabled) control.lock();
        };
        const lock = (event: ControlEvent) => latest.current.onLock?.(event),
          unlock = (event: ControlEvent) => latest.current.onUnlock?.(event),
          change = (event: ControlEvent) => latest.current.onChange?.(event);
        const error = (event: ControlEvent) => report(scene, event, latest.current.onError);
        control.addEventListener('lock', lock);
        control.addEventListener('unlock', unlock);
        control.addEventListener('change', change);
        control.addEventListener('error', error);
        scene.engine.canvas.addEventListener('click', click);
        scene.frames.callbacks.add(frame);
        release = () => {
          scene.engine.canvas.removeEventListener('click', click);
          scene.frames.callbacks.delete(frame);
          control.removeEventListener('lock', lock);
          control.removeEventListener('unlock', unlock);
          control.removeEventListener('change', change);
          control.removeEventListener('error', error);
          assignRef(handle.current, null);
          setControls((state) => (state === control ? null : state));
          if (control.isLocked) control.unlock();
          control.dispose();
        };
        assignRef(handle.current, control);
        setControls(control);
      })
      .catch((error) => {
        current?.dispose();
        if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    return () => {
      active = false;
      release();
    };
  }, [scene.engine, scene.frames]);
  useCommit(() => {
    if (!controls) return;
    const {
      enabled = true,
      pointerSpeed = 1,
      movementSpeed = 1,
      requireLock = true,
      minPolarAngle = 0,
      maxPolarAngle = Math.PI,
    } = props;
    if (
      ![pointerSpeed, movementSpeed, minPolarAngle, maxPolarAngle].every(Number.isFinite) ||
      pointerSpeed < 0 ||
      movementSpeed < 0 ||
      minPolarAngle < 0 ||
      maxPolarAngle > Math.PI ||
      minPolarAngle > maxPolarAngle
    )
      throw new RangeError(
        'PointerLock: speeds must be >= 0 and polar angles within 0 to PI with min <= max; pass valid numbers.',
      );
    Object.assign(controls, { enabled, pointerSpeed, movementSpeed, requireLock, minPolarAngle, maxPolarAngle });
  }, [
    controls,
    props.enabled,
    props.pointerSpeed,
    props.movementSpeed,
    props.requireLock,
    props.minPolarAngle,
    props.maxPolarAngle,
  ]);
  useLiveRef(ref, controls);
  return null;
});

type ObjectTarget = MeshHandle | RefObject<MeshHandle | null> | null;
/** Props of the TransformControls component; every prop is optional unless noted. */
export interface TransformControlsProps extends Omit<TransformControlsOptions, 'element'>, MeshProps, ErrorProps {
  object?: ObjectTarget;
  enabled?: boolean;
  visible?: boolean;
  onChange?: (event: ControlEvent) => void;
  onObjectChange?: (event: ControlEvent) => void;
  onDraggingChange?: (event: ControlEvent) => void;
}
function target(value: ObjectTarget | undefined, registry: Registry | null): MeshHandle | null {
  return value === undefined
    ? ((registry?.current as unknown as MeshHandle) ?? null)
    : value && 'current' in value
      ? value.current
      : value;
}
function TransformBinding({
  options,
  controlRef,
}: {
  options: TransformControlsProps;
  controlRef: Ref<GizmoControls>;
}) {
  const scene = useScene(),
    latest = useRef(options),
    [controls, setControls] = useState<GizmoControls | null>(null),
    handle = useRef(controlRef);
  handle.current = controlRef;
  latest.current = options;
  useEffect(() => {
    let active = true,
      current: GizmoControls | undefined,
      release = () => {};
    optionalPeer('@margoengine/controls', () => import('@margoengine/controls/transform'))
      .then(({ TransformControls }) => {
        if (!active || scene.engine.disposed) return;
        current = new TransformControls(scene.engine as unknown as EngineKernel, latest.current);
        const control = current,
          attach = () => {
            const object = target(latest.current.object, scene.registry);
            if (object !== control.object) {
              if (object) control.attach(object);
              else control.detach();
            }
          };
        const frame: FrameCallback = () => attach(),
          change = (event: ControlEvent) => latest.current.onChange?.(event),
          objectChange = (event: ControlEvent) => latest.current.onObjectChange?.(event),
          dragging = (event: ControlEvent) => latest.current.onDraggingChange?.(event);
        control.addEventListener('change', change);
        control.addEventListener('objectChange', objectChange);
        control.addEventListener('dragging-changed', dragging);
        scene.frames.callbacks.add(frame);
        release = () => {
          scene.frames.callbacks.delete(frame);
          control.removeEventListener('change', change);
          control.removeEventListener('objectChange', objectChange);
          control.removeEventListener('dragging-changed', dragging);
          assignRef(handle.current, null);
          setControls((state) => (state === control ? null : state));
          control.dispose();
        };
        attach();
        assignRef(handle.current, control);
        setControls(control);
      })
      .catch((error) => {
        release();
        current?.dispose();
        if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    return () => {
      active = false;
      release();
    };
  }, [scene.engine, scene.frames, scene.registry, options.order]);
  useCommit(() => {
    if (!controls) return;
    const {
      enabled = true,
      visible = true,
      mode = 'translate',
      space = 'world',
      size = 1,
      translationSnap = null,
      rotationSnap = null,
      scaleSnap = null,
      showX = true,
      showY = true,
      showZ = true,
    } = options;
    if (
      !['translate', 'rotate', 'scale'].includes(mode) ||
      !['world', 'local'].includes(space) ||
      !Number.isFinite(size) ||
      size <= 0 ||
      [translationSnap, rotationSnap, scaleSnap].some(
        (value) => value !== null && (!Number.isFinite(value) || value <= 0),
      )
    )
      throw new RangeError(
        'TransformControls: mode must be translate, rotate or scale, space world or local, and size and snaps above 0.',
      );
    controls.enabled = enabled;
    controls.visible = visible;
    controls.setMode(mode);
    controls.setSpace(space);
    controls.setSize(size);
    controls.setTranslationSnap(translationSnap);
    controls.setRotationSnap(rotationSnap);
    controls.setScaleSnap(scaleSnap);
    Object.assign(controls, { showX, showY, showZ });
    const object = target(options.object, scene.registry);
    if (object !== controls.object) {
      if (object) controls.attach(object);
      else controls.detach();
    }
  });
  useLiveRef(controlRef, controls);
  return null;
}
/** The transform controls component. */
export const TransformControls = forwardRef<GizmoControls, TransformControlsProps>(function TransformControls(
  { children, ...options },
  ref,
) {
  return children !== undefined ? (
    <Mesh
      position={options.position}
      rotation={options.rotation}
      scale={options.scale}
      {...splitPointerHandlers(options)[0]}
    >
      <TransformBinding options={options} controlRef={ref} />
      {children}
    </Mesh>
  ) : (
    <TransformBinding options={options} controlRef={ref} />
  );
});
