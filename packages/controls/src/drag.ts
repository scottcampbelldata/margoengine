/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { Raycaster, isModel, type ModelLike, type RaycasterHit } from '@margoengine/bvh';
import { EventDispatcher, type ControlElement } from './controls.js';
import { IDENTITY, invertAffine, transformPoint, type V3 } from './math.js';
import { add, cross, dot, normalize, scale, sub } from '@margoengine/math/vec3';
import { basis, intersectPlane } from './view.js';

/** A core mesh, or a gltf-pro `PBRModel` (also @margoengine/materials meshes), which moves by its `root`. */
export type DragObject = Mesh | ModelLike;
export interface DragControlsOptions {
  /** World normal of the drag plane through the grab point. Default 'view': the plane facing the camera, as in three.js. */
  plane?: 'view' | readonly [number, number, number];
  /** Move only along this world axis; the drag plane then contains the axis and faces the camera as far as it can. */
  axis?: readonly [number, number, number] | null;
  /** Element to listen on. Defaults to the engine canvas. */
  element?: ControlElement;
  /** Raycaster for grabbing and hovering (layers, filter, side). Default: a new one. */
  raycaster?: Raycaster;
}
interface Drag {
  object: DragObject;
  moved: Mesh;
  grab: V3;
  start: V3;
  normal: V3;
  axis: V3 | null;
  parentInverse: number[];
}

/**
 * Drags core meshes and gltf-pro models with the pointer, mouse or touch (three.js `DragControls`). Objects are grabbed with
 * the bvh Raycaster, so orthographic cameras from @margoengine/cameras work, and moved on a plane or along an axis in world space.
 * Events: `dragstart` (`object`, `hit`), `drag` (`object`), `dragend` (`object`), `hoveron` and `hoveroff` (`object`).
 * Pointer-down on an object stops other listeners on the element registered after this one; otherwise disable camera
 * controls on `dragstart` and re-enable them on `dragend`.
 */
export class DragControls extends EventDispatcher {
  readonly engine: EngineKernel;
  readonly raycaster: Raycaster;
  element: ControlElement | null = null;
  enabled = true;
  objects: DragObject[];
  plane: 'view' | readonly [number, number, number];
  axis: readonly [number, number, number] | null;
  /** Object under the mouse (hover is not tracked for touch). */
  hovered: DragObject | null = null;
  private drag: Drag | null = null;
  private pointerId: number | null = null;
  private previousTouchAction = '';

  /** Creates the DragControls on `engine` (preferred over the constructor). */
  static attach(engine: EngineKernel, objects?: DragObject[], options?: DragControlsOptions): DragControls {
    return new DragControls(engine, objects, options);
  }
  constructor(engine: EngineKernel, objects: DragObject[] = [], options: DragControlsOptions = {}) {
    super();
    this.engine = engine;
    this.objects = objects;
    this.plane = options.plane ?? 'view';
    this.axis = options.axis ?? null;
    this.raycaster = options.raycaster ?? Object.assign(new Raycaster(), { firstHitOnly: true });
    this.connect(options.element ?? (engine.canvas as unknown as ControlElement));
  }
  /** The object being dragged, or null. */
  get dragging(): DragObject | null {
    return this.drag?.object ?? null;
  }

  connect(element: ControlElement): void {
    this.disconnect();
    this.element = element;
    if (element.style) {
      this.previousTouchAction = element.style.touchAction;
      element.style.touchAction = 'none';
    }
    element.addEventListener('pointerdown', this.onDown);
    element.addEventListener('pointermove', this.onMove);
    element.addEventListener('pointerup', this.onUp);
    element.addEventListener('pointercancel', this.onUp);
    element.addEventListener('pointerleave', this.onLeave);
  }
  disconnect(): void {
    const element = this.element;
    if (!element) return;
    this.end();
    this.setHovered(null);
    element.removeEventListener('pointerdown', this.onDown);
    element.removeEventListener('pointermove', this.onMove);
    element.removeEventListener('pointerup', this.onUp);
    element.removeEventListener('pointercancel', this.onUp);
    element.removeEventListener('pointerleave', this.onLeave);
    if (element.style) element.style.touchAction = this.previousTouchAction;
    this.element = null;
  }
  dispose(): void {
    this.disconnect();
    this.objects = [];
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  /** Nearest draggable hit at CSS pixel coordinates relative to the element, or null. */
  intersect(x: number, y: number): { object: DragObject; hit: RaycasterHit } | null {
    if (this.engine.disposed || !this.objects.length) return null;
    const [hit] = this.raycaster.setFromEngine(this.engine, x, y).intersectObjects(this.engine, this.objects);
    return hit ? { object: hit.model ?? hit.mesh, hit } : null;
  }
  /** Starts dragging the object under (x, y); returns false when nothing draggable is there. Called by the pointer handler. */
  pointerDown(x: number, y: number): boolean {
    const found = this.intersect(x, y);
    if (!found) return false;
    const { object, hit } = found,
      moved = isModel(object) ? object.root : object,
      store = engineRuntime(this.engine).store,
      id = meshRuntime(moved).id,
      parent = store.parents[id];
    const axis = this.axis ? normalize(this.axis) : null,
      forward = basis(this.engine.camera).forward;
    let normal: V3 = this.plane === 'view' ? forward : normalize(this.plane);
    if (axis) {
      const n = sub(forward, scale(axis, dot(forward, axis)));
      normal =
        Math.hypot(...n) > 1e-6
          ? normalize(n)
          : normalize(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    }
    if (!Math.hypot(...normal)) throw new RangeError('Drag plane normal must be nonzero');
    const m = store.matrices,
      o = id * 16;
    this.drag = {
      object,
      moved,
      grab: [...hit.point] as V3,
      start: [m[o + 12], m[o + 13], m[o + 14]],
      normal,
      axis,
      parentInverse: parent < 0 ? [...IDENTITY] : invertAffine(m.subarray(parent * 16, parent * 16 + 16)),
    };
    this.setHovered(object);
    this.dispatchEvent({ type: 'dragstart', object, hit });
    return true;
  }
  /** Moves the dragged object to follow (x, y). Called by the pointer handler. */
  pointerMove(x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    const runtime = engineRuntime(this.engine),
      moved = meshRuntime(d.moved);
    if (runtime.disposed || runtime.meshes.get(moved.id) !== moved || (isModel(d.object) && d.object.disposed)) {
      this.end();
      return;
    }
    const r = this.raycaster.setFromEngine(this.engine, x, y),
      point = intersectPlane({ origin: [...r.origin] as V3, direction: [...r.direction] as V3 }, d.grab, d.normal);
    if (!point) return;
    let delta = sub(point, d.grab);
    if (d.axis) delta = scale(d.axis, dot(delta, d.axis));
    d.moved.setPosition(transformPoint(d.parentInverse, add(d.start, delta)));
    this.dispatchEvent({ type: 'drag', object: d.object });
  }
  private end(): void {
    const d = this.drag;
    if (!d) return;
    if (this.pointerId !== null) {
      try {
        if (this.element?.hasPointerCapture?.(this.pointerId) ?? true)
          this.element?.releasePointerCapture?.(this.pointerId);
      } catch {
        /* released */
      }
    }
    this.drag = null;
    this.pointerId = null;
    this.dispatchEvent({ type: 'dragend', object: d.object });
  }
  private setHovered(object: DragObject | null): void {
    if (object === this.hovered) return;
    if (this.hovered) this.dispatchEvent({ type: 'hoveroff', object: this.hovered });
    this.hovered = object;
    if (object) this.dispatchEvent({ type: 'hoveron', object });
  }
  private point(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.element?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  private readonly onDown = (event: PointerEvent): void => {
    if (
      !this.enabled ||
      !this.element ||
      this.drag ||
      (event.button !== 0 && event.pointerType !== 'touch') ||
      event.isPrimary === false
    )
      return;
    const p = this.point(event);
    if (!this.pointerDown(p.x, p.y)) return;
    event.stopImmediatePropagation?.();
    this.pointerId = event.pointerId;
    try {
      this.element.setPointerCapture?.(event.pointerId);
    } catch {
      /* not capturable */
    }
  };
  private readonly onMove = (event: PointerEvent): void => {
    if (!this.enabled || !this.element) return;
    const p = this.point(event);
    if (this.drag) {
      if (event.pointerId === this.pointerId) this.pointerMove(p.x, p.y);
      return;
    }
    if (event.pointerType !== 'touch') this.setHovered(this.intersect(p.x, p.y)?.object ?? null);
  };
  private readonly onUp = (event: PointerEvent): void => {
    if (event.pointerId === this.pointerId) {
      this.end();
      if (event.pointerType === 'touch') this.setHovered(null);
    }
  };
  private readonly onLeave = (): void => {
    if (!this.drag) this.setHovered(null);
  };
}
