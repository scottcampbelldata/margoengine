/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, EnginePlugin, Mesh, RenderView } from '@margoengine/core';
import { engineRuntime, meshRuntime, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { EventDispatcher, type ControlElement } from './controls.js';
import {
  buildDelta,
  buildGizmo,
  pickHandle,
  type GizmoDelta,
  type GizmoFrame,
  type Handle,
  type HandleName,
  type Prim,
  type TransformMode,
} from './gizmo.js';
import { IDENTITY, invertAffine, madd, quatFromMatrix, transformPoint, type Q4, type V3 } from './math.js';
import { add, cross, dot, normalize, scale, sub } from '@margoengine/math/vec3';
import { OverlayRenderer, tessellate } from './overlay.js';
import {
  axisAngleToQuaternion,
  conjugateQuaternion,
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
} from '@margoengine/math/quat';
import { basis, intersectPlane, project, ray, type Basis } from './view.js';
import { viewSize } from '../../shared/view-rect.js';

/** Distance along a ray from `origin` in unit `direction` to the nearest scene surface, null for none. */
export type GizmoOccluder = (origin: readonly number[], direction: readonly number[]) => number | null;

/** The frame the gizmo axes follow: `world` (the default) or the attached object's `local` axes. */
export type TransformSpace = 'world' | 'local';
/**
 * What several attached objects turn and scale about: their `median` point (the default), the `active` object's origin,
 * or `individual`ly, each about its own origin.
 */
export type TransformPivot = 'median' | 'active' | 'individual';
export type { TransformMode, HandleName };

/** Options of `TransformControls`; every field is optional. */
export interface TransformControlsOptions {
  /** Default `translate`. */
  mode?: TransformMode;
  /** Default `world`. */
  space?: TransformSpace;
  /** What several attached objects turn and scale about. Default `median`. */
  pivot?: TransformPivot;
  /** Gizmo size multiplier. Default 1. */
  size?: number;
  /** Snap step for moving, in world units. Default null: no snapping. */
  translationSnap?: number | null;
  /** Snap step for rotating, in radians. Default null: no snapping. */
  rotationSnap?: number | null;
  /** Snap step for scaling. Default null: no snapping. */
  scaleSnap?: number | null;
  /** Show the X handles. Default true. */
  showX?: boolean;
  /** Show the Y handles. Default true. */
  showY?: boolean;
  /** Show the Z handles. Default true. */
  showZ?: boolean;
  /** Turn the move and scale handles to the camera's side of each axis. Default false. */
  flipAxes?: boolean;
  /** Draw a line or swept arc from where a drag began to where it is now. Default true. */
  showDelta?: boolean;
  /** Hide the parts of the gizmo behind scene geometry instead of drawing on top. Default false. */
  occlude?: boolean;
  /**
   * With `occlude`, the distance along a ray to the nearest scene surface, null for none, so a handle behind it cannot be
   * grabbed or hovered. Picking is on the CPU and has no scene depth: pass a ray cast of your own, such as `@margoengine/bvh`.
   * Default none: a hidden handle can still be grabbed.
   */
  occluder?: GizmoOccluder;
  /** Element to listen on. Defaults to the engine canvas. */
  element?: ControlElement;
  /**
   * The engine view (one of `engine.views`) the gizmo lives in: it uses that camera, takes pointers only inside that
   * rectangle and draws only in that view. Default: the engine camera and the whole element.
   */
  view?: RenderView;
  /** Frame graph order of the overlay pass. Default 1000, after the scene and most effects. */
  order?: number;
}

/** One object of a multi-object drag, as it was when the drag began. */
interface Member {
  mesh: Mesh;
  position: V3;
  quaternion: Q4;
  scale: V3;
  parentInverse: number[];
  parentQuaternion: Q4;
  world: V3;
  worldQuaternion: Q4;
}

interface DragStart {
  axis: HandleName;
  origin: V3;
  axes: [V3, V3, V3];
  eye: V3;
  normal: V3;
  pointStart: V3 | null;
  screenStart: { x: number; y: number };
  screenLast: { x: number; y: number };
  position: V3;
  quaternion: Q4;
  scale: V3;
  parent: number[];
  parentInverse: number[];
  parentQuaternion: Q4;
  worldQuaternion: Q4;
  size: number;
  pixelsPerUnit: number;
  angle: number;
  previousAngle: number;
  free: Q4;
  exact: boolean;
  tangent: { x: number; y: number };
  /** Unit direction from the origin to the grab point, for the swept arc of a turn. */
  spoke: V3 | null;
  /** Where an axis or plane scale's pointer is now, relative to the origin. */
  pointNow: V3 | null;
  /** The objects a multi-object drag moves, or null for one attached object. */
  members: Member[] | null;
}

let counter = 0;

/** Share of the viewport height covered by one gizmo unit (the translate arrow length): a fifth of the view. */
const GIZMO_SCREEN_FRACTION = 0.2;
/** Largest tan(fov / 2) used for the gizmo size (a 135 degree lens); wider lenses keep that world size. */
const GIZMO_TAN_CAP = Math.tan((3 * Math.PI) / 8);
/** An axis must face this far past side-on (cos of its angle to the view line) to flip, so a side view does not flicker. */
const FLIP_MARGIN = 0.05;

/**
 * Interactive translate, rotate and scale gizmo for a core `Mesh`.
 *
 * The gizmo is drawn by a frame graph pass on top of the scene (WebGPU, with a WebGL2 fallback) and is hit-tested
 * in screen space with ray math. Drags are applied in the parent's space using the world matrices in
 * `engineRuntime(engine).store.matrices`, so parented meshes move, rotate and scale correctly. `attachMany` edits several
 * meshes at once about the `pivot`.
 *
 * Events: `change`, `mouseDown`, `mouseUp`, `objectChange`, `dragging-changed` (`value`), `axis-changed` (`value`),
 * `mode-changed`, `space-changed` and `pivot-changed`.
 */
export class TransformControls extends EventDispatcher {
  readonly engine: EngineKernel;
  element: ControlElement | null = null;
  /** The view the gizmo lives in (see {@link TransformControlsOptions.view}), or null for the engine camera. */
  view: RenderView | null = null;
  enabled = true;
  /** Draws the gizmo when attached. */
  visible = true;
  mode: TransformMode;
  space: TransformSpace;
  /** What several attached objects turn and scale about. Default `median`. */
  pivot: TransformPivot;
  size: number;
  translationSnap: number | null;
  rotationSnap: number | null;
  scaleSnap: number | null;
  showX: boolean;
  showY: boolean;
  showZ: boolean;
  /** Turn the move and scale handles to the camera's side of each axis (held still during a drag). Default false. */
  flipAxes: boolean;
  /** Draw a line or swept arc from where a drag began to where it is now. Default true. */
  showDelta: boolean;
  /**
   * Hide the parts of the gizmo behind scene geometry instead of drawing on top. Default false. Only the drawing
   * changes unless `occluder` is set: picking is on the CPU and has no scene depth, so a hidden handle can still be grabbed.
   */
  occlude: boolean;
  /** With `occlude`, tells picking how far the scene is along a ray, so a handle behind it takes no pointer. Default none. */
  occluder: GizmoOccluder | undefined;
  /** Attached mesh, or null. With several attached, the active one: its axes are the `local` frame. */
  object: Mesh | null = null;
  /** Hovered or dragged handle. */
  axis: HandleName | null = null;
  dragging = false;
  readonly overlay = new OverlayRenderer();
  private drag: DragStart | null = null;
  private pointerId: number | null = null;
  private resetState: { position: V3; quaternion: Q4; scale: V3 } | null = null;
  /** Everything `attachMany` attached, the active object included; empty with one object. */
  private selection: Mesh[] = [];
  private savedSelection: Array<{ mesh: Mesh; position: V3; quaternion: Q4; scale: V3 }> = [];
  private readonly flip: [number, number, number] = [1, 1, 1];
  /** Name of the engine plugin that owns the overlay pass. */
  readonly pluginName: string;
  private readonly plugin: EnginePlugin;
  private disposed = false;

  /** Creates the TransformControls on `engine` (preferred over the constructor). */
  static attach(engine: EngineKernel, options?: TransformControlsOptions): TransformControls {
    return new TransformControls(engine, options);
  }
  constructor(engine: EngineKernel, options: TransformControlsOptions = {}) {
    super();
    this.engine = engine;
    this.mode = options.mode ?? 'translate';
    this.space = options.space ?? 'world';
    this.pivot = options.pivot ?? 'median';
    this.size = options.size ?? 1;
    this.translationSnap = options.translationSnap ?? null;
    this.rotationSnap = options.rotationSnap ?? null;
    this.scaleSnap = options.scaleSnap ?? null;
    this.showX = options.showX ?? true;
    this.showY = options.showY ?? true;
    this.showZ = options.showZ ?? true;
    this.flipAxes = options.flipAxes ?? false;
    this.showDelta = options.showDelta ?? true;
    this.occlude = options.occlude ?? false;
    this.occluder = options.occluder;
    this.view = options.view ?? null;
    this.pluginName = `margoengine-controls:transform:${++counter}`;
    const order = options.order ?? 1000;
    const plugin = {
      name: this.pluginName,
      setup() {},
      registerPasses: (graph: FrameGraph) => {
        graph.add({ name: this.pluginName + ':overlay', order, execute: this.execute });
      },
      onDeviceRestored: () => this.overlay.release(),
      dispose: () => this.dispose(),
    };
    this.plugin = plugin;
    engine.use(plugin);
    try {
      this.connect(options.element ?? (engine.canvas as unknown as ControlElement));
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  connect(element: ControlElement): void {
    if (this.disposed) throw new MargoError('disposed', 'Controls are disposed; create new controls');
    this.disconnect();
    this.element = element;
    try {
      element.addEventListener('pointerdown', this.onDown);
      element.addEventListener('pointermove', this.onMove);
      element.addEventListener('pointerup', this.onUp);
      element.addEventListener('pointercancel', this.onUp);
      element.addEventListener('pointerleave', this.onLeave);
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }
  disconnect(): void {
    const element = this.element;
    if (!element) return;
    if (this.dragging) this.endDrag();
    element.removeEventListener('pointerdown', this.onDown);
    element.removeEventListener('pointermove', this.onMove);
    element.removeEventListener('pointerup', this.onUp);
    element.removeEventListener('pointercancel', this.onUp);
    element.removeEventListener('pointerleave', this.onLeave);
    this.element = null;
  }

  private owned(object: Mesh): void {
    meshRuntime(object).check();
    if ((meshRuntime(object) as unknown as { engine: unknown }).engine !== engineRuntime(this.engine))
      throw new TypeError('Mesh belongs to another engine; attach a mesh created by this engine');
  }
  attach(object: Mesh): this {
    this.owned(object);
    if (this.dragging) this.endDrag();
    this.object = object;
    this.selection = [];
    this.savedSelection = [];
    this.resetState = this.local();
    this.dispatchEvent({ type: 'change' });
    return this;
  }
  /**
   * Attaches several meshes to edit together; repeats count once and an empty list detaches. `active` (default the last
   * one) gives the `local` axes and the `active` pivot. A mesh whose ancestor is also attached follows that ancestor.
   */
  attachMany(objects: Iterable<Mesh>, active?: Mesh): this {
    const list = [...new Set(objects)];
    for (const object of list) this.owned(object);
    const chosen = active ?? list[list.length - 1];
    if (!chosen) return this.detach();
    if (!list.includes(chosen)) throw new TypeError('The active mesh is not one of the attached meshes');
    if (list.length === 1) return this.attach(chosen);
    if (this.dragging) this.endDrag();
    this.object = chosen;
    this.selection = list;
    this.resetState = this.local();
    this.savedSelection = list.map((mesh) => ({ mesh, ...this.local(mesh) }));
    this.dispatchEvent({ type: 'change' });
    return this;
  }
  /** Every attached mesh that still exists, the active one included. */
  get objects(): readonly Mesh[] {
    const object = this.attached();
    return this.selection.length ? this.selection.filter((mesh) => this.live(mesh)) : object ? [object] : [];
  }
  detach(): this {
    if (this.dragging) this.endDrag();
    this.object = null;
    this.selection = [];
    this.savedSelection = [];
    this.setAxis(null);
    this.dispatchEvent({ type: 'change' });
    return this;
  }
  getMode(): TransformMode {
    return this.mode;
  }
  setMode(mode: TransformMode): void {
    if (mode !== this.mode) {
      this.mode = mode;
      this.dispatchEvent({ type: 'mode-changed', value: mode });
      this.dispatchEvent({ type: 'change' });
    }
  }
  setSpace(space: TransformSpace): void {
    if (space !== this.space) {
      this.space = space;
      this.dispatchEvent({ type: 'space-changed', value: space });
      this.dispatchEvent({ type: 'change' });
    }
  }
  setPivot(pivot: TransformPivot): void {
    if (pivot !== this.pivot) {
      this.pivot = pivot;
      this.dispatchEvent({ type: 'pivot-changed', value: pivot });
      this.dispatchEvent({ type: 'change' });
    }
  }
  setSize(size: number): void {
    if (!(size > 0)) throw new RangeError('Gizmo size must be positive');
    this.size = size;
    this.dispatchEvent({ type: 'change' });
  }
  /**
   * Steps used while Ctrl (or Meta) is held during a drag and no explicit snap is set, like the snap key of CAD and
   * DCC apps. Defaults: 0.25 world units, 15 degrees, 0.1 scale. Set a field to null to turn that one off.
   */
  heldSnap: { translation: number | null; rotation: number | null; scale: number | null } = {
    translation: 0.25,
    rotation: Math.PI / 12,
    scale: 0.1,
  };
  /** Key codes of {@link listenToKeyEvents}. Defaults: W translate, E rotate, R scale, Q toggles space, +/- size, Escape cancels a drag. */
  keys = {
    translate: 'KeyW',
    rotate: 'KeyE',
    scale: 'KeyR',
    space: 'KeyQ',
    larger: 'Equal',
    smaller: 'Minus',
    cancel: 'Escape',
  };
  private holdingSnap = false;
  private keyTarget: { removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => void } | null =
    null;
  /** The snap step in force for `kind`: the explicit snap, else the held-key step while Ctrl or Meta is down. */
  private step(kind: 'translation' | 'rotation' | 'scale'): number | null {
    const explicit =
      kind === 'translation' ? this.translationSnap : kind === 'rotation' ? this.rotationSnap : this.scaleSnap;
    return explicit || (this.holdingSnap ? this.heldSnap[kind] || null : null);
  }
  /**
   * Turns on the keyboard shortcuts in `keys` (W/E/R modes, Q space, +/- size, Escape cancels a drag). Pass `window` or a
   * focusable element; keys typed into text fields are ignored. Returns the controls.
   */
  listenToKeyEvents(target: {
    addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => void;
    removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => void;
  }): this {
    this.stopListenToKeyEvents();
    target.addEventListener('keydown', this.onKey);
    this.keyTarget = target;
    return this;
  }
  /** Turns the keyboard shortcuts off. */
  stopListenToKeyEvents(): void {
    this.keyTarget?.removeEventListener('keydown', this.onKey);
    this.keyTarget = null;
  }
  /** Ends the current drag and puts the mesh back to where the drag began. Returns false when nothing is being dragged. */
  cancelDrag(): boolean {
    if (!this.dragging || !this.object || !this.resetState) return false;
    const pointerId = this.pointerId;
    this.restore();
    if (pointerId !== null) {
      try {
        this.element?.releasePointerCapture?.(pointerId);
      } catch {
        /* ignore */
      }
    }
    this.endDrag();
    this.dispatchEvent({ type: 'objectChange' });
    this.dispatchEvent({ type: 'change' });
    return true;
  }
  private readonly onKey = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    const target = event.target as { tagName?: string; isContentEditable?: boolean } | null;
    if (
      target?.isContentEditable ||
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.tagName === 'SELECT'
    )
      return;
    const k = this.keys,
      code = event.code;
    if (code === k.cancel) {
      if (this.cancelDrag()) event.preventDefault?.();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (code === k.translate) this.setMode('translate');
    else if (code === k.rotate) this.setMode('rotate');
    else if (code === k.scale) this.setMode('scale');
    else if (code === k.space) this.setSpace(this.space === 'world' ? 'local' : 'world');
    else if (code === k.larger || code === 'NumpadAdd') this.setSize(this.size * 1.1);
    else if (code === k.smaller || code === 'NumpadSubtract') this.setSize(this.size / 1.1);
    else return;
    event.preventDefault?.();
  };
  setTranslationSnap(step: number | null): void {
    this.translationSnap = step;
  }
  setRotationSnap(step: number | null): void {
    this.rotationSnap = step;
  }
  setScaleSnap(step: number | null): void {
    this.scaleSnap = step;
  }
  /** Restores the attached mesh to its transform at attach time or at the start of the last drag. */
  reset(): void {
    if (!this.object || !this.resetState || this.dragging) return;
    this.restore();
    this.dispatchEvent({ type: 'objectChange' });
    this.dispatchEvent({ type: 'change' });
  }
  /** Puts every attached mesh back to its saved transform. */
  private restore(): void {
    const s = this.resetState!;
    this.object!.setPosition(s.position).setQuaternion(s.quaternion).setScale(s.scale);
    for (const m of this.savedSelection)
      if (this.live(m.mesh)) m.mesh.setPosition(m.position).setQuaternion(m.quaternion).setScale(m.scale);
  }

  /** The gizmo frame for a viewport size in CSS pixels, or null when nothing is attached. */
  frame(): GizmoFrame | null {
    const object = this.attached();
    if (!object) return null;
    const store = engineRuntime(this.engine).store,
      id = meshRuntime(object).id,
      m = store.matrices.subarray(id * 16, id * 16 + 16);
    const origin: V3 = this.pivotPoint() ?? [m[12], m[13], m[14]],
      camera = this.view?.camera ?? this.engine.camera,
      b = basis(camera);
    // One object scales along its own axes, the only ones it has; a group can also spread along the world's.
    const space = this.mode === 'scale' && !this.selection.length ? 'local' : this.space,
      q = this.worldQuaternion(object);
    const axes: [V3, V3, V3] =
      space === 'local'
        ? [rotateByQuaternion([1, 0, 0], q), rotateByQuaternion([0, 1, 0], q), rotateByQuaternion([0, 0, 1], q)]
        : [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ];
    const toCamera = sub(camera.position, origin),
      distance = Math.hypot(...toCamera) || 1;
    // One gizmo unit spans GIZMO_SCREEN_FRACTION of the viewport height. The visible half height at the gizmo is
    // distance * tan(fov / 2) in perspective (tan capped so very wide lenses stay bounded) or the orthographic half height.
    const halfHeight = b.ortho ?? distance * Math.min(b.tanHalf, GIZMO_TAN_CAP),
      size = 2 * GIZMO_SCREEN_FRACTION * halfHeight * this.size,
      eye = b.ortho !== undefined ? scale(b.forward, -1) : scale(toCamera, 1 / distance);
    if (!this.dragging)
      for (let i = 0; i < 3; i++) {
        const facing = dot(axes[i], eye);
        if (Math.abs(facing) > FLIP_MARGIN) this.flip[i] = facing < 0 ? -1 : 1;
      }
    return {
      mode: this.mode,
      origin,
      axes,
      size,
      eye,
      up: b.up,
      show: { X: this.showX, Y: this.showY, Z: this.showZ },
      axis: this.axis,
      dragging: this.dragging,
      flip: this.flipAxes ? [...this.flip] : undefined,
      delta: this.showDelta ? this.progress(origin) : null,
    };
  }
  /** The active drag's progress for the overlay; `origin` is where the object is now. */
  private progress(origin: V3): GizmoDelta | null {
    const d = this.drag;
    if (!d) return null;
    if (this.mode === 'translate') return { kind: 'line', from: d.origin, to: origin };
    if (this.mode === 'scale')
      return d.pointStart && d.pointNow
        ? { kind: 'line', from: add(d.origin, d.pointStart) as V3, to: add(d.origin, d.pointNow) as V3 }
        : null;
    if (!d.spoke) return null;
    const axis = d.axis === 'E' ? d.eye : d.axes['XYZ'.indexOf(d.axis)];
    return { kind: 'arc', axis, spoke: d.spoke, angle: d.angle, view: d.axis === 'E' };
  }
  /** Handles for the current frame (also what the overlay draws). */
  handles(): Handle[] {
    const f = this.frame();
    return f ? buildGizmo(f) : [];
  }
  /** Screen-space hit test at CSS pixel coordinates relative to the element. */
  pick(x: number, y: number): HandleName | null {
    const f = this.frame(),
      s = this.screen();
    if (!f || !s) return null;
    x -= s.x;
    y -= s.y;
    if (x < 0 || y < 0 || x >= s.width || y >= s.height) return null;
    const handle = pickHandle(buildGizmo(f), s.b, f.origin, x, y, s.width, s.height);
    return handle && this.behindScene(s.b, f, x, y, s.width, s.height) ? null : handle;
  }
  /** True when the scene is nearer along the pointer's ray than the near side of the gizmo. */
  private behindScene(b: Basis, f: GizmoFrame, x: number, y: number, width: number, height: number): boolean {
    if (!this.occlude || !this.occluder) return false;
    const { origin, direction } = ray(b, x, y, width, height),
      hit = this.occluder(origin, direction),
      centre = f.origin.map((value, i) => value - origin[i]);
    return (
      hit !== null && hit < centre[0] * direction[0] + centre[1] * direction[1] + centre[2] * direction[2] - f.size
    );
  }
  /** The camera basis and the view's rectangle on the element in CSS pixels (core viewports are fractions unless `pixels`). */
  private screen(): { b: Basis; x: number; y: number; width: number; height: number } | null {
    const e = this.element;
    if (!e) return null;
    const w = Math.max(1, e.clientWidth),
      h = Math.max(1, e.clientHeight),
      v = this.view;
    if (!v) return { b: basis(this.engine.camera), x: 0, y: 0, width: w, height: h };
    const canvas = this.engine.canvas,
      sx = v.pixels ? w / canvas.width : w,
      sy = v.pixels ? h / canvas.height : h,
      [x, y, width, height] = v.viewport;
    return {
      b: basis(v.camera),
      x: x * sx,
      y: y * sy,
      width: Math.max(1, width * sx),
      height: Math.max(1, height * sy),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopListenToKeyEvents();
    this.disconnect();
    this.object = null;
    this.selection = [];
    this.savedSelection = [];
    this.overlay.release();
    this.engine.sceneOf(this.plugin)?.removePlugin(this.pluginName);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  // ---- pointer handling ----
  private point(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.element?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  private setAxis(axis: HandleName | null): void {
    if (axis === this.axis) return;
    this.axis = axis;
    this.dispatchEvent({ type: 'axis-changed', value: axis });
    this.dispatchEvent({ type: 'change' });
  }
  private readonly onLeave = (): void => {
    if (!this.dragging) this.setAxis(null);
  };
  private readonly onMove = (event: PointerEvent): void => {
    if (!this.enabled || !this.element) return;
    const p = this.point(event);
    if (!this.dragging) {
      if (event.pointerType !== 'touch') this.setAxis(this.pick(p.x, p.y));
      return;
    }
    if (event.pointerId !== this.pointerId) return;
    this.holdingSnap = !!(event.ctrlKey || event.metaKey);
    this.pointerMove(p.x, p.y);
  };
  private readonly onDown = (event: PointerEvent): void => {
    if (
      !this.enabled ||
      !this.element ||
      this.dragging ||
      !this.attached() ||
      (event.button !== 0 && event.pointerType !== 'touch')
    )
      return;
    const p = this.point(event),
      axis = this.pick(p.x, p.y);
    this.setAxis(axis);
    if (!axis) return;
    event.stopImmediatePropagation?.();
    try {
      this.element.setPointerCapture?.(event.pointerId);
    } catch {
      /* ignore */
    }
    this.pointerId = event.pointerId;
    this.pointerDown(p.x, p.y);
  };
  private readonly onUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    try {
      if (this.element?.hasPointerCapture?.(event.pointerId) ?? true)
        this.element?.releasePointerCapture?.(event.pointerId);
    } catch {
      /* ignore */
    }
    this.endDrag();
    if (event.pointerType === 'touch') this.setAxis(null);
  };
  private endDrag(): void {
    this.pointerId = null;
    this.holdingSnap = false;
    if (!this.dragging) return;
    this.dragging = false;
    this.drag = null;
    this.dispatchEvent({ type: 'mouseUp', mode: this.mode });
    this.dispatchEvent({ type: 'dragging-changed', value: false });
    this.dispatchEvent({ type: 'change' });
  }

  /** Starts a drag on the current `axis` at CSS pixel coordinates. Called by the pointer handler. */
  pointerDown(x: number, y: number): void {
    const object = this.attached(),
      f = this.frame(),
      s = this.screen();
    if (!object || !f || !this.axis || !s) return;
    const { b, width, height } = s;
    x -= s.x;
    y -= s.y;
    const axis = this.axis,
      local = this.local(),
      parent = this.parentMatrix(object),
      parentQuaternion = quatFromMatrix(parent);
    const o = f.origin,
      center = project(b, o, width, height);
    const pixelsPerUnit = (height / (2 * (b.ortho ?? Math.max(1e-9, center.depth) * b.tanHalf))) * f.size;
    const drag: DragStart = {
      axis,
      origin: o,
      axes: f.axes,
      eye: f.eye,
      normal: this.planeNormal(axis, f),
      pointStart: null,
      screenStart: { x, y },
      screenLast: { x, y },
      position: local.position,
      quaternion: local.quaternion,
      scale: local.scale,
      parent,
      parentInverse: invertAffine(parent),
      parentQuaternion,
      worldQuaternion: this.worldQuaternion(object),
      size: f.size,
      pixelsPerUnit,
      angle: 0,
      previousAngle: 0,
      free: [0, 0, 0, 1],
      exact: true,
      tangent: { x: 0, y: 0 },
      spoke: null,
      pointNow: null,
      members: this.selection.length ? this.movers().map((mesh) => this.member(mesh)) : null,
    };
    if (this.mode === 'rotate' && 'XYZ'.includes(axis) && axis.length === 1) {
      const a = f.axes['XYZ'.indexOf(axis)],
        hit = intersectPlane(ray(b, x, y, width, height), o, a);
      drag.exact = !!hit && Math.abs(dot(a, f.eye)) > 0.15;
      if (drag.exact) {
        drag.pointStart = sub(hit!, o);
        drag.spoke = normalize(drag.pointStart) as V3;
      } else {
        // Ring seen edge-on: drag along the screen tangent of the ring at the grab point.
        const grab = this.closestOnRing('XYZ'.indexOf(axis), f, b, x, y, width, height),
          t = normalize(cross(a, grab));
        drag.spoke = normalize(grab) as V3;
        const p0 = project(b, add(o, grab), width, height),
          p1 = project(b, madd(add(o, grab), t, f.size * 0.1), width, height);
        const l = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
        drag.tangent = { x: (p1.x - p0.x) / l, y: (p1.y - p0.y) / l };
      }
    } else if (this.mode === 'rotate' && axis === 'E') {
      // From the centre to the grab point on screen, laid in the plane of the ring.
      const across = madd(scale(b.right, x - center.x), b.up, center.y - y);
      drag.spoke = normalize(madd(across, f.eye, -dot(across, f.eye))) as V3;
    } else if (this.mode === 'translate' || (this.mode === 'scale' && axis !== 'XYZ')) {
      const hit = intersectPlane(ray(b, x, y, width, height), o, drag.normal);
      drag.pointStart = hit ? sub(hit, o) : null;
      if (!drag.pointStart) return;
    }
    this.drag = drag;
    this.resetState = local;
    if (this.selection.length) this.savedSelection = this.selection.map((mesh) => ({ mesh, ...this.local(mesh) }));
    this.dragging = true;
    this.dispatchEvent({ type: 'dragging-changed', value: true });
    this.dispatchEvent({ type: 'mouseDown', mode: this.mode });
    this.dispatchEvent({ type: 'change' });
  }

  /** Continues a drag at CSS pixel coordinates. Called by the pointer handler. */
  pointerMove(x: number, y: number): void {
    const d = this.drag,
      object = this.attached(),
      s = this.screen();
    if (!d || !object || !s) return;
    const { b, width, height } = s;
    x -= s.x;
    y -= s.y;
    if (this.mode === 'translate') this.translate(d, object, b, x, y, width, height);
    else if (this.mode === 'rotate') this.rotate(d, object, b, x, y, width, height);
    else this.scale(d, object, b, x, y, width, height);
    d.screenLast = { x, y };
    this.dispatchEvent({ type: 'objectChange' });
    this.dispatchEvent({ type: 'change' });
  }

  private translate(d: DragStart, object: Mesh, b: Basis, x: number, y: number, width: number, height: number): void {
    const hit = intersectPlane(ray(b, x, y, width, height), d.origin, d.normal);
    if (!hit || !d.pointStart) return;
    let offset = sub(sub(hit, d.origin), d.pointStart);
    const active = [d.axis.includes('X'), d.axis.includes('Y'), d.axis.includes('Z')];
    if (d.axis.length === 1) {
      const a = d.axes['XYZ'.indexOf(d.axis)];
      offset = scale(a, dot(offset, a));
    } else if (d.axis.length === 2) offset = sub(offset, scale(d.normal, dot(offset, d.normal)));
    const snap = this.step('translation'),
      local = this.space === 'local';
    if (snap && local && d.axis !== 'XYZ') {
      let snapped: V3 = [0, 0, 0];
      for (let i = 0; i < 3; i++)
        if (active[i]) snapped = madd(snapped, d.axes[i], Math.round(dot(offset, d.axes[i]) / snap) * snap);
      offset = snapped;
    }
    const world = add(d.origin, offset);
    if (snap && (!local || d.axis === 'XYZ'))
      for (let i = 0; i < 3; i++) if (active[i] || d.axis === 'XYZ') world[i] = Math.round(world[i] / snap) * snap;
    if (d.members) this.moveMembers(d, sub(world, d.origin));
    else object.setPosition(transformPoint(d.parentInverse, world));
  }

  private rotate(d: DragStart, object: Mesh, b: Basis, x: number, y: number, width: number, height: number): void {
    let axis: V3, angle: number;
    if (d.axis === 'XYZE') {
      const dx = x - d.screenLast.x,
        dy = y - d.screenLast.y,
        distance = Math.hypot(dx, dy);
      if (!distance) return;
      const drag = normalize(madd(scale(b.right, dx), b.up, -dy));
      d.free = normalizeQuaternion(
        multiplyQuaternions(
          axisAngleToQuaternion(normalize(cross(d.eye, drag)), distance / Math.max(1, d.pixelsPerUnit)),
          d.free,
        ),
      );
      const step = this.step('rotation');
      if (step) {
        // Snap the accumulated turn's angle about its own axis; the unsnapped turn keeps accumulating underneath.
        const [fx, fy, fz, fw] = d.free,
          sine = Math.hypot(fx, fy, fz);
        if (sine > 1e-9) {
          const turn = 2 * Math.atan2(sine, fw),
            snapped = Math.round(turn / step) * step;
          this.applyRotation(d, object, axisAngleToQuaternion([fx / sine, fy / sine, fz / sine], snapped));
          return;
        }
      }
      this.applyRotation(d, object, d.free);
      return;
    }
    if (d.axis === 'E') {
      const center = project(b, d.origin, width, height);
      const current = Math.atan2(y - center.y, x - center.x),
        start = Math.atan2(d.screenStart.y - center.y, d.screenStart.x - center.x);
      angle = this.unwrap(d, -(current - start));
      axis = d.eye;
    } else {
      axis = d.axes['XYZ'.indexOf(d.axis)];
      if (d.exact && d.pointStart) {
        const hit = intersectPlane(ray(b, x, y, width, height), d.origin, axis);
        if (!hit) return;
        const p = sub(hit, d.origin);
        angle = this.unwrap(d, Math.atan2(dot(cross(d.pointStart, p), axis), dot(d.pointStart, p)));
      } else {
        angle =
          ((x - d.screenStart.x) * d.tangent.x + (y - d.screenStart.y) * d.tangent.y) / Math.max(1, d.pixelsPerUnit);
      }
    }
    const rotationStep = this.step('rotation');
    if (rotationStep) angle = Math.round(angle / rotationStep) * rotationStep;
    d.angle = angle;
    this.applyRotation(d, object, axisAngleToQuaternion(axis, angle));
  }
  /** Keeps a continuous angle across the atan2 seam. */
  private unwrap(d: DragStart, raw: number): number {
    let delta = raw - d.previousAngle;
    delta -= Math.round(delta / (2 * Math.PI)) * 2 * Math.PI;
    d.previousAngle += delta;
    return d.previousAngle;
  }
  /** Applies a world-space rotation R: local' = P^-1 R P local, P being the parent's world rotation. */
  private applyRotation(d: DragStart, object: Mesh, rotation: Q4): void {
    if (d.members) {
      this.turnMembers(d, rotation);
      return;
    }
    const P = d.parentQuaternion,
      next = multiplyQuaternions(
        multiplyQuaternions(multiplyQuaternions(conjugateQuaternion(P), rotation), P),
        d.quaternion,
      );
    object.setQuaternion(normalizeQuaternion(next));
  }

  private scale(d: DragStart, object: Mesh, b: Basis, x: number, y: number, width: number, height: number): void {
    const next: V3 = [...d.scale] as V3;
    if (d.axis === 'XYZ') {
      const factor = Math.max(0.01, 1 + (x - d.screenStart.x - (y - d.screenStart.y)) / Math.max(1, d.pixelsPerUnit));
      for (let i = 0; i < 3; i++) next[i] *= factor;
    } else {
      const hit = intersectPlane(ray(b, x, y, width, height), d.origin, d.normal);
      if (!hit || !d.pointStart) return;
      const end = sub(hit, d.origin);
      for (let i = 0; i < 3; i++) {
        if (!d.axis.includes('XYZ'[i])) continue;
        const start = dot(d.pointStart, d.axes[i]);
        if (Math.abs(start) > 1e-9) next[i] = (d.scale[i] * dot(end, d.axes[i])) / start;
      }
      d.pointNow = end;
      if (d.axis.length === 1) {
        const a = d.axes['XYZ'.indexOf(d.axis)];
        d.pointNow = madd(d.pointStart, a, dot(sub(end, d.pointStart), a));
      }
    }
    const snap = this.step('scale');
    for (let i = 0; i < 3; i++) {
      if (snap) next[i] = Math.round(next[i] / snap) * snap || snap;
      if (Math.abs(next[i]) < 1e-4) next[i] = Math.sign(next[i] || d.scale[i]) * 1e-4;
    }
    if (d.members) this.scaleMembers(d, [0, 1, 2].map((i) => (d.scale[i] ? next[i] / d.scale[i] : 1)) as unknown as V3);
    else object.setScale(next);
  }

  // ---- several objects ----
  /** True when each object follows its own axes: `individual` pivot, `local` space and an axis handle. */
  private ownAxes(d: DragStart): boolean {
    return this.pivot === 'individual' && this.space === 'local' && d.axis !== 'XYZ' && !d.axis.includes('E');
  }
  /** Each object moves by `offset`; on its own axes it moves that much along each of them instead. */
  private moveMembers(d: DragStart, offset: V3): void {
    const own = this.ownAxes(d),
      along = d.axes.map((a) => dot(offset, a));
    for (const m of d.members!) {
      if (!this.live(m.mesh)) continue;
      let step = offset;
      if (own) {
        step = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          const unit: V3 = [0, 0, 0];
          unit[i] = 1;
          step = madd(step, rotateByQuaternion(unit, m.worldQuaternion), along[i]);
        }
      }
      m.mesh.setPosition(transformPoint(m.parentInverse, add(m.world, step)));
    }
  }
  /** Each object turns by the world rotation R, about the pivot or in place; on its own axes, the same turn in its frame. */
  private turnMembers(d: DragStart, rotation: Q4): void {
    const own = this.ownAxes(d),
      inPlace = this.pivot === 'individual',
      inFrame = multiplyQuaternions(
        multiplyQuaternions(conjugateQuaternion(d.worldQuaternion), rotation),
        d.worldQuaternion,
      );
    for (const m of d.members!) {
      if (!this.live(m.mesh)) continue;
      const R = own
          ? multiplyQuaternions(multiplyQuaternions(m.worldQuaternion, inFrame), conjugateQuaternion(m.worldQuaternion))
          : rotation,
        P = m.parentQuaternion;
      if (!inPlace)
        m.mesh.setPosition(
          transformPoint(m.parentInverse, add(d.origin, rotateByQuaternion(sub(m.world, d.origin), rotation))),
        );
      m.mesh.setQuaternion(
        normalizeQuaternion(
          multiplyQuaternions(multiplyQuaternions(multiplyQuaternions(conjugateQuaternion(P), R), P), m.quaternion),
        ),
      );
    }
  }
  /**
   * Scales by `factors` along the gizmo axes: positions spread about the pivot, unless in place. An object's size has only
   * its own axes, so each takes the stretch the factors give that axis, exact when the axes line up or the factors match.
   */
  private scaleMembers(d: DragStart, factors: V3): void {
    const own = this.ownAxes(d),
      inPlace = this.pivot === 'individual';
    for (const m of d.members!) {
      if (!this.live(m.mesh)) continue;
      if (!inPlace) {
        const from = sub(m.world, d.origin);
        let to: V3 = [0, 0, 0];
        for (let i = 0; i < 3; i++) to = madd(to, d.axes[i], dot(from, d.axes[i]) * factors[i]);
        m.mesh.setPosition(transformPoint(m.parentInverse, add(d.origin, to)));
      }
      const size: V3 = [...m.scale] as V3;
      for (let j = 0; j < 3; j++) {
        let stretch = factors[j];
        if (!own) {
          const unit: V3 = [0, 0, 0];
          unit[j] = 1;
          const axis = rotateByQuaternion(unit, m.worldQuaternion),
            parts = d.axes.map((a, i) => dot(axis, a) * factors[i]),
            shares = d.axes.map((a) => Math.abs(dot(axis, a))),
            main = shares.indexOf(Math.max(...shares));
          stretch = Math.sign(factors[main]) * Math.hypot(...parts);
        }
        size[j] *= stretch;
        if (Math.abs(size[j]) < 1e-4) size[j] = Math.sign(size[j] || m.scale[j]) * 1e-4;
      }
      m.mesh.setScale(size);
    }
  }
  private member(mesh: Mesh): Member {
    const m = engineRuntime(this.engine).store.matrices,
      id = meshRuntime(mesh).id,
      parent = this.parentMatrix(mesh);
    return {
      mesh,
      ...this.local(mesh),
      parentInverse: invertAffine(parent),
      parentQuaternion: quatFromMatrix(parent),
      world: [m[id * 16 + 12], m[id * 16 + 13], m[id * 16 + 14]],
      worldQuaternion: this.worldQuaternion(mesh),
    };
  }
  /** The live attached meshes with no attached ancestor: moving those carries the rest. */
  private movers(): Mesh[] {
    const store = engineRuntime(this.engine).store,
      list = this.selection.filter((mesh) => this.live(mesh)),
      ids = new Set(list.map((mesh) => meshRuntime(mesh).id));
    return list.filter((mesh) => {
      for (let id = store.parents[meshRuntime(mesh).id]; id >= 0; id = store.parents[id]) if (ids.has(id)) return false;
      return true;
    });
  }
  /** Where the gizmo sits with several attached: the active origin under the `active` pivot, else the median. */
  private pivotPoint(): V3 | null {
    if (!this.selection.length || this.pivot === 'active') return null;
    const m = engineRuntime(this.engine).store.matrices,
      list = this.movers();
    const sum: V3 = [0, 0, 0];
    for (const mesh of list) {
      const at = meshRuntime(mesh).id * 16;
      for (let i = 0; i < 3; i++) sum[i] += m[at + 12 + i];
    }
    return list.length ? (scale(sum, 1 / list.length) as V3) : null;
  }

  // ---- helpers ----
  private planeNormal(axis: HandleName, f: GizmoFrame): V3 {
    if (axis === 'XYZ' || axis === 'E' || axis === 'XYZE') return f.eye;
    if (axis.length === 2) return f.axes['XYZ'.indexOf('XYZ'.split('').find((c) => !axis.includes(c))!)];
    const a = f.axes['XYZ'.indexOf(axis)],
      n = sub(f.eye, scale(a, dot(f.eye, a)));
    if (Math.hypot(...n) > 1e-6) return normalize(n);
    return normalize(Math.abs(a[1]) < 0.9 ? cross(a, [0, 1, 0]) : cross(a, [1, 0, 0]));
  }
  private closestOnRing(
    index: number,
    f: GizmoFrame,
    b: Basis,
    x: number,
    y: number,
    width: number,
    height: number,
  ): V3 {
    const u = f.axes[(index + 1) % 3],
      v = f.axes[(index + 2) % 3];
    let best: V3 = scale(u, f.size),
      bestDistance = Infinity;
    for (let i = 0; i < 64; i++) {
      const t = (i / 64) * Math.PI * 2,
        p = madd(scale(u, Math.cos(t) * f.size), v, Math.sin(t) * f.size),
        s = project(b, add(f.origin, p), width, height);
      const distance = Math.hypot(s.x - x, s.y - y) + (dot(p, f.eye) < 0 ? 3 : 0);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = p;
      }
    }
    return best;
  }
  private live(mesh: Mesh): boolean {
    const runtime = engineRuntime(this.engine);
    return !runtime.disposed && runtime.meshes.get(meshRuntime(mesh).id) === (mesh as unknown);
  }
  private attached(): Mesh | null {
    const object = this.object;
    if (!object) return null;
    if (!this.live(object)) {
      // The last of what is left takes over as active, and its reset point with it.
      const left = this.selection.filter((mesh) => this.live(mesh));
      this.selection = left.length > 1 ? left : [];
      this.object = left[left.length - 1] ?? null;
      this.savedSelection = this.savedSelection.filter((m) => this.live(m.mesh));
      this.resetState = this.savedSelection.find((m) => m.mesh === this.object) ?? null;
      this.dragging = false;
      this.drag = null;
      return this.object;
    }
    return object;
  }
  private local(mesh: Mesh = this.object!): { position: V3; quaternion: Q4; scale: V3 } {
    const t = engineRuntime(this.engine).store.transforms,
      id = meshRuntime(mesh).id;
    return {
      position: [t.x[id], t.y[id], t.z[id]],
      quaternion: [t.qx[id], t.qy[id], t.qz[id], t.qw[id]],
      scale: [t.sx[id], t.sy[id], t.sz[id]],
    };
  }
  private parentMatrix(object: Mesh): number[] {
    const store = engineRuntime(this.engine).store,
      parent = store.parents[meshRuntime(object).id];
    return parent < 0 ? [...IDENTITY] : Array.from(store.matrices.subarray(parent * 16, parent * 16 + 16));
  }
  /** World rotation = parent world rotation x local rotation (shear from non-uniform parent scale is ignored). */
  private worldQuaternion(object: Mesh): Q4 {
    const t = engineRuntime(this.engine).store.transforms,
      id = meshRuntime(object).id;
    return normalizeQuaternion(
      multiplyQuaternions(quatFromMatrix(this.parentMatrix(object)), [t.qx[id], t.qy[id], t.qz[id], t.qw[id]]),
    );
  }

  private readonly execute = (ctx: PassContext): void => {
    if (!this.visible || this.disposed || (this.view && ctx.view && ctx.view.camera !== this.view.camera)) return;
    const f = this.frame();
    if (!f) {
      this.overlay.lastTriangles = 0;
      return;
    }
    const prims: Prim[] = [];
    for (const handle of buildGizmo(f)) prims.push(...handle.prims);
    prims.push(...buildDelta(f));
    const canvas = this.engine.canvas,
      ratio = canvas.clientWidth ? ctx.width / canvas.clientWidth : 1;
    const [width, height] = viewSize(ctx);
    this.overlay.draw(ctx, tessellate(prims, ctx.camera.matrix, width, height, ratio), this.occlude);
  };
}
