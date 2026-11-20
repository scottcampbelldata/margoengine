import { Suspense, forwardRef, lazy, useEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import type { EngineKernel, FrameCallback, Mesh as MeshHandle } from '@margoengine/core';
import type {
  DragControls as DragInstance,
  DragMode,
  PointerLockControls as PointerControls,
  TransformControls as GizmoControls,
  TransformControlsOptions,
  ControlEvent,
  HandleName,
  GizmoColor,
} from '@margoengine/controls';
import { composeMatrix, invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { normalizeQuaternion, splitTRS } from '@margoengine/math/quat';
import { Mesh, type MeshProps } from './components.js';
import { gather } from './center.js';
import { splitPointerHandlers } from './events.js';
import { useScene, useCommit, useLiveRef, assignRef, report, type Registry, type Scene } from './internal.js';
import { optionalPeer } from './optional.js';
import { rangeError } from '../../shared/errors.js';

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
export const PointerLock = /* @__PURE__ */ forwardRef<PointerControls, PointerLockProps>(function PointerLock(props, ref) {
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
      throw rangeError('PointerLock: speeds must be >= 0 and polar angles within 0 to PI with min <= max; pass valid numbers', 'react-arguments');
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
const none: readonly never[] = [];
const origin: readonly [number, number, number] = [0, 0, 0];
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
      pivot = 'median',
      flipAxes = false,
      showDelta = true,
      occlude = false,
      occluder,
      hide = none,
      offset = origin,
      fixed = true,
      axisColors = null,
      hoveredColor = null,
      lineWidth = 2.5,
    } = options;
    if (
      !['translate', 'rotate', 'scale', 'all'].includes(mode) ||
      !['world', 'local'].includes(space) ||
      !['median', 'active', 'individual'].includes(pivot) ||
      !Number.isFinite(size) ||
      size <= 0 ||
      [translationSnap, rotationSnap, scaleSnap].some(
        (value) => value !== null && (!Number.isFinite(value) || value <= 0),
      )
    )
      throw rangeError('TransformControls: mode must be translate, rotate, scale or all, space world or local, pivot median, active or individual, and size and snaps above 0', 'react-arguments');
    controls.enabled = enabled;
    controls.visible = visible;
    controls.setMode(mode);
    controls.setSpace(space);
    controls.setSize(size);
    controls.setTranslationSnap(translationSnap);
    controls.setRotationSnap(rotationSnap);
    controls.setScaleSnap(scaleSnap);
    controls.setPivot(pivot);
    // Every live field follows its prop; a removed prop puts the default back.
    Object.assign(controls, { showX, showY, showZ, flipAxes, showDelta, occlude, occluder, hide, fixed });
    // The setters check these and throw a message naming the fix.
    controls.offset = offset;
    controls.axisColors = axisColors;
    controls.hoveredColor = hoveredColor;
    controls.lineWidth = lineWidth;
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
export const TransformControls = /* @__PURE__ */ forwardRef<GizmoControls, TransformControlsProps>(function TransformControls(
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

/** The part of a `<PivotControls>` gizmo a drag began on, as drei names them, plus `Center` for the free-move centre. */
export type PivotComponent = 'Arrow' | 'Slider' | 'Rotator' | 'Scale' | 'Center';
/** What `onDragStart` of `<PivotControls>` reports. */
export interface PivotDragStart {
  component: PivotComponent;
  /** 0, 1 or 2 for X, Y or Z (for a slider, the axis normal to its plane); null for the centre. */
  axis: 0 | 1 | 2 | null;
  /** World position of the gizmo when the drag began. */
  origin: [number, number, number];
  /** Unit world directions of the grabbed handle: its axis, or the two axes of its plane or ring. */
  directions: Array<[number, number, number]>;
}
type Limits = readonly [DragLimit, DragLimit, DragLimit];
/** Props of `<PivotControls>`; every prop is optional. */
export interface PivotControlsProps extends ErrorProps {
  children?: ReactNode;
  /** Take the pointer. Default true. */
  enabled?: boolean;
  /** Draw the gizmo. Default true. */
  visible?: boolean;
  /** The group's transform in its parent's space, column-major 4 by 4 (no shear). Applied when it changes. Default identity. */
  matrix?: ArrayLike<number>;
  /** Move the group as the gizmo is dragged. With false the group stays at `matrix` and `onDrag` reports where it would go. Default true. */
  autoTransform?: boolean;
  /** Gizmo size: its length in world units, or with `fixed` a multiplier of its constant size on screen. Default 1. */
  scale?: number;
  /** Keep the gizmo a constant size on screen, `scale` then multiplying it. With false (drei's default too), `scale` is its length in world units. Default false. */
  fixed?: boolean;
  /** Where the gizmo sits in the group's own space, added to the `anchor` point. Default [0, 0, 0]. */
  offset?: readonly [number, number, number];
  /**
   * Put the gizmo on the children's bounding box in the group's own space: each axis -1 (the low side), 0 (the centre)
   * or 1 (the high side), or any value between. Default none: the group's origin.
   */
  anchor?: readonly [number, number, number];
  /** Colours of the X, Y and Z handles: `'#rgb'`, `'#rrggbb'`, `'#rrggbbaa'` or `[r, g, b(, a)]` in 0..1. Default red, green, blue. */
  axisColors?: readonly [GizmoColor, GizmoColor, GizmoColor];
  /** Colour of the hovered or dragged handle, as `axisColors`. Default yellow. */
  hoveredColor?: GizmoColor;
  /** Width in CSS pixels of the arrow shafts, scale lines and rings. Default 2.5. */
  lineWidth?: number;
  /** During a drag, show a label at the gizmo with the distance moved, the angle turned or the scale factor. Needs `@margoengine/html`. Default false. */
  annotations?: boolean;
  /** Class name of the annotation label's element. Default none. */
  annotationsClass?: string;
  /** Gizmo axes: the group's own (`local`, the default) or the world's. */
  space?: 'local' | 'world';
  /** Which axes have handles, `[x, y, z]`. Default all three. */
  activeAxes?: readonly [boolean, boolean, boolean];
  /** Leave out the move arrows. Default false. */
  disableAxes?: boolean;
  /** Leave out the plane sliders. Default false. */
  disableSliders?: boolean;
  /** Leave out the rotation rings. Default false. */
  disableRotations?: boolean;
  /** Leave out the scale handles. Default false. */
  disableScaling?: boolean;
  /** Leave out the free-move centre. Default false. */
  disableCenter?: boolean;
  /** Limits of the group's position on each axis in its parent's space, `[[min, max], undefined, ...]`. Default none. */
  translationLimits?: Limits;
  /** Limits of the group's XYZ Euler angles in radians. Default none. */
  rotationLimits?: Limits;
  /** Limits of the group's scale on each axis. Default none. */
  scaleLimits?: Limits;
  /** Hide the gizmo where scene geometry is in front of it. Default false: it draws on top. */
  depthTest?: boolean;
  /** Snap steps: world units, radians and scale. Default none. */
  translationSnap?: number | null;
  rotationSnap?: number | null;
  scaleSnap?: number | null;
  /** A drag began. */
  onDragStart?: (event: PivotDragStart) => void;
  /**
   * The gizmo moved: `local` is the group's new transform in its parent's space, `deltaLocal` the change since the drag
   * began (`local` = `deltaLocal` x start), and `world`, `deltaWorld` the same in world space. Column-major 4 by 4.
   */
  onDrag?: (local: Float64Array, deltaLocal: Float64Array, world: Float64Array, deltaWorld: Float64Array) => void;
  /** The drag ended. */
  onDragEnd?: () => void;
}
const COMPONENTS: Record<string, PivotComponent> = { '': 'Arrow', R: 'Rotator', S: 'Scale' };
function localMatrix(scene: Scene, group: MeshHandle): Float64Array {
  const { transforms: t } = scene.engine.store,
    id = (group as unknown as { id: number }).id;
  return composeMatrix(
    [t.x[id], t.y[id], t.z[id]],
    normalizeQuaternion([t.qx[id], t.qy[id], t.qz[id], t.qw[id]]),
    [t.sx[id], t.sy[id], t.sz[id]],
    new Float64Array(16),
  );
}
function parentWorld(scene: Scene, group: MeshHandle): Float64Array {
  const { store } = scene.engine,
    parent = store.parents[(group as unknown as { id: number }).id];
  return parent >= 0
    ? Float64Array.from(store.matrices.subarray(parent * 16, parent * 16 + 16))
    : Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
function setLocal(group: MeshHandle, matrix: ArrayLike<number>): void {
  const split = splitTRS(matrix);
  if (!split.ok)
    throw rangeError(`PivotControls: matrix is ${split.reason}; pass a translation, rotation and scale matrix`, 'react-arguments');
  group.setPosition(split.position).setQuaternion(split.rotation).setScale(split.scale);
}
const clamp = (value: number, limit: DragLimit) => (limit ? Math.min(limit[1], Math.max(limit[0], value)) : value);
const held = (v: { x: number; y: number; z: number }, limits: Limits): [number, number, number] => [
  clamp(v.x, limits[0]),
  clamp(v.y, limits[1]),
  clamp(v.z, limits[2]),
];
type V3 = readonly [number, number, number];
interface Begun {
  local: Float64Array;
  parent: Float64Array;
  component: PivotComponent;
  axis: 0 | 1 | 2 | null;
  /** Gizmo position in world space and the grabbed handle's world direction (the ring's normal for a Rotator). */
  origin: V3;
  direction: V3;
}
const triple = (value: V3 | undefined, name: string): V3 | undefined => {
  if (value !== undefined && !(value?.length === 3 && value.every(Number.isFinite)))
    throw rangeError(`PivotControls: ${name} must be three finite numbers; pass [x, y, z]`, 'react-arguments');
  return value;
};
/** Bounds of `root`'s descendants in `root`'s own space, or null with no geometry or a root that cannot be inverted. */
function sceneLocalBounds(scene: Scene, root: MeshHandle, output: Float32Array): Float32Array | null {
  scene.engine.store.tick(false);
  const inverse = invertMatrix((root as unknown as { matrix: ArrayLike<number> }).matrix);
  return inverse && gather(scene, root as never, output, inverse, multiplyMatrices);
}
const AnnotationHtml = /* @__PURE__ */ lazy(() => import('./html.js').then((module) => ({ default: module.Html })));
/** The annotation of a drag: distance along an arrow, distance for a slider or the centre, degrees turned, scale factor. */
function annotate(begun: Begun, point: V3, local: Float64Array, world: Float64Array, deltaWorld: Float64Array): string {
  const { component, axis, origin, direction: d } = begun;
  if (component === 'Rotator') {
    const m = deltaWorld,
      cos = Math.min(1, Math.max(-1, (m[0] + m[5] + m[10] - 1) / 2)),
      sign = Math.sign((m[6] - m[9]) * d[0] + (m[8] - m[2]) * d[1] + (m[1] - m[4]) * d[2]) || 1;
    return `${((sign * Math.acos(cos) * 180) / Math.PI).toFixed(1)}\u00b0`;
  }
  if (component === 'Scale') {
    const i = 4 * axis!,
      length = (m: Float64Array) => Math.hypot(m[i], m[i + 1], m[i + 2]);
    return `\u00d7${(length(local) / length(begun.local)).toFixed(2)}`;
  }
  const at = [0, 1, 2].map(
      (r) => world[r] * point[0] + world[r + 4] * point[1] + world[r + 8] * point[2] + world[r + 12] - origin[r],
    ),
    distance = component === 'Arrow' ? at[0] * d[0] + at[1] * d[1] + at[2] * d[2] : Math.hypot(at[0], at[1], at[2]);
  return distance.toFixed(2);
}
function PivotBinding({ options, controlRef }: { options: PivotControlsProps; controlRef: Ref<GizmoControls> }) {
  const scene = useScene(),
    latest = useRef(options),
    gizmo = useRef<GizmoControls | null>(null),
    start = useRef<Begun | null>(null),
    [controls, setControls] = useState<GizmoControls | null>(null),
    [point, setPoint] = useState<V3>(origin),
    [note, setNote] = useState<string | null>(null);
  latest.current = options;
  triple(options.anchor, 'anchor');
  triple(options.offset, 'offset');
  const anchorKey = options.anchor ? options.anchor.join() : '',
    offsetKey = options.offset ? options.offset.join() : '';
  // The gizmo point in the group's space: `offset`, plus the anchored point of the children's local box. Children load
  // and change, so an anchored gizmo follows their box each frame; it holds still during a drag.
  useEffect(() => {
    const bounds = new Float32Array(6);
    const place = () => {
      const { anchor, offset = origin } = latest.current,
        group = scene.registry?.current as unknown as MeshHandle | null;
      if (anchor && start.current) return;
      const box = anchor && group && sceneLocalBounds(scene, group, bounds);
      const next: V3 = box
        ? [0, 1, 2].map((i) => offset[i] + (box[i] + box[i + 3]) / 2 + (anchor[i] * (box[i + 3] - box[i])) / 2) as never
        : offset;
      setPoint((previous) => (previous.every((v, i) => v === next[i]) ? previous : next));
    };
    place();
    if (!anchorKey) return;
    const frame: FrameCallback = () => place();
    scene.frames.callbacks.add(frame);
    // Children mount after this binding; place again once they have.
    queueMicrotask(() => {
      if (scene.frames.callbacks.has(frame) && !scene.engine.disposed) place();
    });
    return () => {
      scene.frames.callbacks.delete(frame);
    };
  }, [scene, scene.frames, scene.registry, anchorKey, offsetKey]);
  const matrixKey = options.matrix ? Array.from(options.matrix).join() : '';
  useCommit(() => {
    const group = scene.registry?.current as unknown as MeshHandle | null;
    if (group && options.matrix) setLocal(group, options.matrix);
  }, [scene.registry, controls, matrixKey]);
  const handle = useRef(controlRef);
  handle.current = controlRef;
  // One function for the life of the binding, so the inner binding's ref effect does not rerun every render.
  const [bind] = useState(() => (value: GizmoControls | null) => {
    gizmo.current = value;
    assignRef(handle.current, value);
    setControls(value);
  });
  const dragging = (event: ControlEvent) => {
    const group = scene.registry?.current as unknown as MeshHandle | null,
      control = gizmo.current;
    if (!group || !control) return;
    if (!event.value) {
      start.current = null;
      setNote(null);
      latest.current.onDragEnd?.();
      return;
    }
    const name = control.axis ?? 'XYZ',
      frame = control.frame(),
      letters = name.replace(/^[RS]/, ''),
      prefix = name.length > letters.length ? name[0] : '',
      axes = frame?.axes ?? [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      used = [0, 1, 2].filter((i) => letters.includes('XYZ'[i]));
    const component: PivotComponent =
      letters === 'XYZ' ? 'Center' : letters.length === 2 ? 'Slider' : COMPONENTS[prefix];
    const axis =
      component === 'Center'
        ? null
        : component === 'Slider'
          ? ([0, 1, 2].find((i) => !used.includes(i)) as 0 | 1 | 2)
          : (used[0] as 0 | 1 | 2);
    const directions =
      component === 'Rotator'
        ? [0, 1, 2].filter((i) => i !== axis).map((i) => [...axes[i]] as [number, number, number])
        : used.map((i) => [...((prefix === 'S' && frame?.scaleAxes) || axes)[i]] as [number, number, number]);
    const origin: [number, number, number] = frame ? [...frame.origin] : [0, 0, 0];
    start.current = {
      local: localMatrix(scene, group),
      parent: parentWorld(scene, group),
      component,
      axis,
      origin,
      direction: component === 'Rotator' ? axes[axis!] : (directions[0] ?? origin),
    };
    if (latest.current.annotations)
      setNote(component === 'Rotator' ? '0.0\u00b0' : component === 'Scale' ? '\u00d71.00' : '0.00');
    latest.current.onDragStart?.({ component, axis, origin: [...origin], directions });
  };
  const changed = () => {
    const group = scene.registry?.current as unknown as MeshHandle | null,
      begun = start.current;
    if (!group || !begun) return;
    const o = latest.current,
      { translationLimits: tl, rotationLimits: rl, scaleLimits: sl } = o;
    if (tl) group.setPosition(held(group.position, tl));
    if (rl) group.setRotation(held(group.rotation, rl));
    if (sl) group.setScale(held(group.scale, sl));
    // Core rejects a zero scale and a parent's world matrix is built from such meshes, so both inverses exist.
    const local = localMatrix(scene, group),
      deltaLocal = multiplyMatrices(local, invertMatrix(begun.local)!),
      world = multiplyMatrices(begun.parent, local),
      deltaWorld = multiplyMatrices(world, invertMatrix(multiplyMatrices(begun.parent, begun.local))!);
    // Without autoTransform the group stays where `matrix` puts it; the drag is measured from its start each move.
    if (o.autoTransform === false) setLocal(group, o.matrix ?? IDENTITY);
    if (o.annotations) setNote(annotate(begun, point, local, world, deltaWorld));
    o.onDrag?.(local, deltaLocal, world, deltaWorld);
  };
  const {
    activeAxes = [true, true, true],
    disableAxes,
    disableSliders,
    disableRotations,
    disableScaling,
    disableCenter,
  } = options;
  const hide: HandleName[] = [];
  if (disableAxes) hide.push('X', 'Y', 'Z');
  if (disableSliders) hide.push('XY', 'YZ', 'XZ');
  if (disableRotations) hide.push('RX', 'RY', 'RZ');
  if (disableScaling) hide.push('SX', 'SY', 'SZ');
  if (disableCenter) hide.push('XYZ');
  return (
    <>
    <TransformBinding
      controlRef={bind}
      options={{
        mode: 'all',
        space: options.space ?? 'local',
        size: options.scale ?? 1,
        fixed: options.fixed ?? false,
        offset: point,
        axisColors: options.axisColors,
        hoveredColor: options.hoveredColor,
        lineWidth: options.lineWidth,
        enabled: options.enabled,
        visible: options.visible,
        showX: activeAxes[0],
        showY: activeAxes[1],
        showZ: activeAxes[2],
        hide,
        occlude: options.depthTest ?? false,
        translationSnap: options.translationSnap,
        rotationSnap: options.rotationSnap,
        scaleSnap: options.scaleSnap,
        onDraggingChange: dragging,
        onObjectChange: changed,
        onError: options.onError,
      }}
    />
    {options.annotations && note !== null ? (
      <Suspense fallback={null}>
        <AnnotationHtml position={point as [number, number, number]} className={options.annotationsClass} occlude={false}>
          {note}
        </AnnotationHtml>
      </Suspense>
    ) : null}
    </>
  );
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/**
 * A gizmo that moves, turns and scales its children as one group, like drei's PivotControls: move arrows, plane sliders,
 * a free-move centre, rotation rings and scale handles together (the `all` mode of `@margoengine/controls/transform`).
 * The ref is that `TransformControls`. Turn camera controls off in `onDragStart` and back on in `onDragEnd`.
 */
export const PivotControls = /* @__PURE__ */ forwardRef<GizmoControls, PivotControlsProps>(function PivotControls(
  { children, ...options },
  ref,
) {
  return (
    <Mesh>
      <PivotBinding options={options} controlRef={ref} />
      {children}
    </Mesh>
  );
});

type Axis = 'x' | 'y' | 'z';
const AXES: Record<Axis, [number, number, number]> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
/** Lowest and highest value of one axis, or undefined for no limit on it. */
export type DragLimit = readonly [number, number] | undefined;
/** Props of `<DragControls>`: the group's starting transform, how a drag moves it, and its events. */
export interface DragControlsProps extends Pick<MeshProps, 'position' | 'rotation' | 'scale' | 'children'>, ErrorProps {
  /** Turn dragging off without unmounting. Default true. */
  enabled?: boolean;
  /** Move (`translate`, the default) or turn (`rotate`) what is grabbed. */
  mode?: DragMode;
  /** Radians per CSS pixel in `rotate` mode. Default 0.01. */
  rotateSpeed?: number;
  /** World normal of the drag plane, or `'view'` (the default) for the plane facing the camera. */
  plane?: 'view' | readonly [number, number, number];
  /** Move only along this world axis (`'x'`, `'y'`, `'z'` or a direction), or turn only about it. Default none. */
  axisLock?: Axis | readonly [number, number, number] | null;
  /** Limits of the group's position on each axis, in its parent's space: `[[minX, maxX], undefined, [minZ, maxZ]]`. */
  dragLimits?: readonly [DragLimit, DragLimit, DragLimit];
  /** A drag began on the group; `origin` is the group's position then. */
  onDragStart?: (origin: [number, number, number]) => void;
  /** The group moved or turned; `position` is its position in its parent's space after the limits. */
  onDrag?: (position: [number, number, number]) => void;
  /** The drag ended. */
  onDragEnd?: () => void;
  /** The mouse went over the group (true) or left it (false). */
  onHover?: (hovering: boolean) => void;
}
function DragBinding({ options, controlRef }: { options: DragControlsProps; controlRef: Ref<DragInstance> }) {
  const scene = useScene(),
    latest = useRef(options),
    [controls, setControls] = useState<DragInstance | null>(null),
    handle = useRef(controlRef);
  handle.current = controlRef;
  latest.current = options;
  useEffect(() => {
    let active = true,
      release = () => {};
    optionalPeer('@margoengine/controls', () => import('@margoengine/controls/drag'))
      .then(({ DragControls }) => {
        const group = scene.registry?.current as unknown as MeshHandle | null;
        if (!active || scene.engine.disposed || !group) return;
        const control = new DragControls(scene.engine as unknown as EngineKernel, [group], { transformGroup: true }),
          where = (): [number, number, number] => [group.position.x, group.position.y, group.position.z],
          start = () => latest.current.onDragStart?.(where()),
          drag = () => {
            const limits = latest.current.dragLimits,
              now = where(),
              held = now.map((value, axis) => {
                const limit = limits?.[axis];
                return limit ? Math.min(limit[1], Math.max(limit[0], value)) : value;
              }) as [number, number, number];
            if (held.some((value, axis) => value !== now[axis])) group.setPosition(held);
            latest.current.onDrag?.(held);
          },
          end = () => latest.current.onDragEnd?.(),
          on = () => latest.current.onHover?.(true),
          off = () => latest.current.onHover?.(false);
        const listeners: Array<[string, () => void]> = [
          ['dragstart', start],
          ['drag', drag],
          ['dragend', end],
          ['hoveron', on],
          ['hoveroff', off],
        ];
        for (const [type, listener] of listeners) control.addEventListener(type, listener);
        release = () => {
          for (const [type, listener] of listeners) control.removeEventListener(type, listener);
          assignRef(handle.current, null);
          setControls((state) => (state === control ? null : state));
          control.dispose();
        };
        assignRef(handle.current, control);
        setControls(control);
      })
      .catch((error) => {
        if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    return () => {
      active = false;
      release();
    };
  }, [scene.engine, scene.registry]);
  useCommit(() => {
    if (!controls) return;
    const {
      enabled = true,
      mode = 'translate',
      rotateSpeed = 0.01,
      plane = 'view',
      axisLock = null,
      dragLimits,
    } = options;
    const axis = typeof axisLock === 'string' ? AXES[axisLock] : axisLock;
    if (
      !['translate', 'rotate'].includes(mode) ||
      !(rotateSpeed > 0 && Number.isFinite(rotateSpeed)) ||
      (typeof axisLock === 'string' && !axis) ||
      (axis && (axis.length !== 3 || !axis.every(Number.isFinite) || !axis.some(Boolean))) ||
      (plane !== 'view' && (plane.length !== 3 || !plane.every(Number.isFinite) || !plane.some(Boolean))) ||
      dragLimits?.some((limit) => limit && !(limit[0] <= limit[1]))
    )
      throw rangeError("Invalid DragControls props; pass mode translate or rotate, rotateSpeed above 0, axisLock 'x', 'y', 'z' or a non-zero direction, plane 'view' or a non-zero normal, and each limit as [min, max] with min <= max", 'react-arguments');
    Object.assign(controls, { enabled, mode, rotateSpeed, plane, axis });
  });
  useLiveRef(controlRef, controls);
  return null;
}
/**
 * Drag its children with the pointer, mouse or touch: they move together as one group on the plane facing the camera
 * (or `plane`), along `axisLock`, or turn in `rotate` mode, within `dragLimits`. The ref is the `DragControls` of
 * `@margoengine/controls/drag`. Pointer-down on the group stops canvas listeners added after it; turn camera controls
 * off in `onDragStart` and back on in `onDragEnd` when they were added first.
 */
export const DragControls = /* @__PURE__ */ forwardRef<DragInstance, DragControlsProps>(function DragControls(
  { children, position, rotation, scale, ...options },
  ref,
) {
  return (
    <Mesh position={position} rotation={rotation} scale={scale}>
      <DragBinding options={options} controlRef={ref} />
      {children}
    </Mesh>
  );
});
