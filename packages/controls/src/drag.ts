/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { Raycaster, isModel, type ModelLike, type RaycasterHit } from '@margoengine/bvh';
import { EventDispatcher, type ControlElement } from './controls.js';
import { IDENTITY, invertAffine, quatFromMatrix, rotateAxis, transformPoint, type Q4, type V3 } from './math.js';
import { add, cross, dot, normalize, scale, sub } from '@margoengine/math/vec3';
import {
  axisAngleToQuaternion,
  conjugateQuaternion,
  multiplyQuaternions,
  normalizeQuaternion,
} from '@margoengine/math/quat';
import { basis, intersectPlane } from './view.js';

/** A core mesh, or a gltf-pro `PBRModel` (also @margoengine/materials meshes), which moves by its `root`. */
export type DragObject = Mesh | ModelLike;
/** What a drag does: move the object (`translate`, the default) or turn it (`rotate`). */
export type DragMode = 'translate' | 'rotate';
/** Options of `DragControls`; every field is optional. */
export interface DragControlsOptions {
  /** World normal of the drag plane through the grab point. Default 'view': the plane facing the camera. */
  plane?: 'view' | readonly [number, number, number];
  /** Move only along this world axis; the drag plane then contains the axis and faces the camera as far as it can. */
  axis?: readonly [number, number, number] | null;
  /** Move or turn what is grabbed. Default `translate`. */
  mode?: DragMode;
  /** Radians per CSS pixel of drag in `rotate` mode. Default 0.01. */
  rotateSpeed?: number;
  /** Objects that move and turn together: grabbing any one of them carries them all. Default none. */
  group?: readonly DragObject[];
  /** Also grab the children of listed core meshes, and drag the child itself. Default false. */
  recursive?: boolean;
  /** Also grab the children of listed core meshes, and drag the listed mesh with all of them. Default false. */
  transformGroup?: boolean;
  /** Element to listen on. Defaults to the engine canvas. */
  element?: ControlElement;
  /** Raycaster for grabbing and hovering (layers, filter, side). Default: a new one. */
  raycaster?: Raycaster;
}
/** One mesh a drag carries, as it was when the drag began. */
interface Carried {
  object: DragObject;
  mesh: Mesh;
  start: V3;
  parentInverse: number[];
  parentQuaternion: Q4;
  quaternion: Q4;
}
interface Drag {
  object: DragObject;
  grab: V3;
  normal: V3;
  axis: V3 | null;
  carried: Carried[];
  /** World point a turn goes about: the grabbed object's origin. */
  pivot: V3;
  /** Pointer position at the last move, and the turn so far (rotate mode). */
  pointer: { x: number; y: number };
  turn: Q4;
}

/**
 * Drags core meshes and gltf-pro models with the pointer, mouse or touch. Objects are grabbed with
 * the bvh Raycaster, so orthographic cameras from @margoengine/cameras work, and moved on a plane or along an axis in
 * world space, or turned about their origin (`mode: 'rotate'`; about `axis` when set, else with the screen as a
 * trackball). `group` carries a set of objects together, turning about the grabbed one. `recursive` grabs children of
 * listed meshes, and `transformGroup` grabs through children to drag the listed mesh.
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
  /** Move or turn what is grabbed. Default `translate`. */
  mode: DragMode;
  /** Radians per CSS pixel of drag in `rotate` mode. Default 0.01. */
  rotateSpeed: number;
  /** Objects that move and turn together: grabbing any one carries them all. Default none. */
  group: readonly DragObject[];
  /** Also grab the children of listed core meshes, and drag the child itself. Default false. */
  recursive: boolean;
  /** Also grab the children of listed core meshes, and drag the listed mesh with all of them. Wins over `recursive`. Default false. */
  transformGroup: boolean;
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
    this.mode = options.mode ?? 'translate';
    this.rotateSpeed = options.rotateSpeed ?? 0.01;
    this.group = options.group ?? [];
    this.recursive = options.recursive ?? false;
    this.transformGroup = options.transformGroup ?? false;
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
    const deep = this.recursive || this.transformGroup,
      [hit] = this.raycaster
        .setFromEngine(this.engine, x, y)
        .intersectObjects(this.engine, deep ? this.withChildren() : this.objects);
    if (!hit) return null;
    const object = hit.model ?? hit.mesh;
    return { object: this.transformGroup ? this.listedRoot(object) : object, hit };
  }
  /** The listed objects and every descendant of a listed core mesh. */
  private withChildren(): DragObject[] {
    const runtime = engineRuntime(this.engine),
      parents = runtime.store.parents,
      listed = new Set<number>(),
      out = [...this.objects];
    for (const object of this.objects) if (!isModel(object)) listed.add(meshRuntime(object).id);
    for (const [id, mesh] of runtime.meshes as unknown as Iterable<[number, Mesh]>) {
      if (listed.has(id)) continue;
      for (let up = parents[id]; up >= 0; up = parents[up])
        if (listed.has(up)) {
          out.push(mesh);
          break;
        }
    }
    return out;
  }
  /** The nearest listed ancestor of a hit object, or the object itself. */
  private listedRoot(object: DragObject): DragObject {
    if (isModel(object) || this.objects.includes(object)) return object;
    const parents = engineRuntime(this.engine).store.parents;
    for (let up = parents[meshRuntime(object).id]; up >= 0; up = parents[up]) {
      const found = this.objects.find((o) => !isModel(o) && meshRuntime(o).id === up);
      if (found) return found;
    }
    return object;
  }
  /** What a drag of `object` carries, as it stands now: `group` when `object` is in it, else `object` alone. */
  private carry(object: DragObject): Carried[] {
    const store = engineRuntime(this.engine).store,
      t = store.transforms,
      m = store.matrices;
    return (this.group.includes(object) ? this.group : [object]).map((member) => {
      const mesh = isModel(member) ? member.root : member,
        id = meshRuntime(mesh).id,
        up = store.parents[id],
        parent = up < 0 ? [...IDENTITY] : Array.from(m.subarray(up * 16, up * 16 + 16));
      return {
        object: member,
        mesh,
        start: [m[id * 16 + 12], m[id * 16 + 13], m[id * 16 + 14]],
        parentInverse: up < 0 ? [...IDENTITY] : invertAffine(parent),
        parentQuaternion: quatFromMatrix(parent),
        quaternion: [t.qx[id], t.qy[id], t.qz[id], t.qw[id]],
      };
    });
  }
  /** Starts dragging the object under (x, y); returns false when nothing draggable is there. Called by the pointer handler. */
  pointerDown(x: number, y: number): boolean {
    const found = this.intersect(x, y);
    if (!found) return false;
    const { object, hit } = found;
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
    const carried = this.carry(object);
    this.drag = {
      object,
      grab: [...hit.point] as V3,
      normal,
      axis,
      carried,
      pivot: (carried.find((c) => c.object === object) as Carried).start,
      pointer: { x, y },
      turn: [0, 0, 0, 1],
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
      alive = (c: Carried): boolean => {
        const moved = meshRuntime(c.mesh);
        return runtime.meshes.get(moved.id) === moved && !(isModel(c.object) && c.object.disposed);
      };
    if (runtime.disposed || !alive(d.carried.find((c) => c.object === d.object) as Carried)) {
      this.end();
      return;
    }
    // A member disposed during the drag is left behind.
    d.carried = d.carried.filter(alive);
    if (this.mode === 'rotate') this.turn(d, x, y);
    else {
      const r = this.raycaster.setFromEngine(this.engine, x, y),
        point = intersectPlane({ origin: [...r.origin] as V3, direction: [...r.direction] as V3 }, d.grab, d.normal);
      if (!point) return;
      let delta = sub(point, d.grab);
      if (d.axis) delta = scale(d.axis, dot(delta, d.axis));
      for (const c of d.carried) c.mesh.setPosition(transformPoint(c.parentInverse, add(c.start, delta)));
    }
    this.dispatchEvent({ type: 'drag', object: d.object });
  }
  /**
   * Adds the pointer's latest step to the turn and writes every carried mesh: about `axis` when set, else as a
   * trackball about the screen axis at right angles to the step.
   */
  private turn(d: Drag, x: number, y: number): void {
    const dx = x - d.pointer.x,
      dy = y - d.pointer.y,
      length = Math.hypot(dx, dy);
    d.pointer = { x, y };
    if (!length) return;
    const b = basis(this.engine.camera),
      speed = this.rotateSpeed;
    let axis: V3, angle: number;
    if (d.axis) {
      // The near side of the object follows the pointer: right or down turns it the same way seen along the axis.
      axis = d.axis;
      angle = (dot(d.axis, b.up) >= 0 ? dx : -dx) * speed + (dot(d.axis, b.right) >= 0 ? -dy : dy) * speed;
    } else {
      axis = normalize(add(scale(b.up, dx), scale(b.right, dy))) as V3;
      angle = length * speed;
    }
    d.turn = normalizeQuaternion(multiplyQuaternions(axisAngleToQuaternion(axis, angle), d.turn));
    const [tx, ty, tz, tw] = d.turn,
      sine = Math.hypot(tx, ty, tz),
      spin = 2 * Math.atan2(sine, tw),
      unit: V3 = sine > 1e-12 ? [tx / sine, ty / sine, tz / sine] : [0, 1, 0];
    for (const c of d.carried) {
      // In the parent's space: local' = P^-1 R P local, with the origin swung about the pivot.
      const P = c.parentQuaternion,
        turned = multiplyQuaternions(multiplyQuaternions(conjugateQuaternion(P), d.turn), P);
      c.mesh.setQuaternion(normalizeQuaternion(multiplyQuaternions(turned, c.quaternion)));
      if (c.start !== d.pivot)
        c.mesh.setPosition(
          transformPoint(c.parentInverse, add(d.pivot, rotateAxis(sub(c.start, d.pivot), unit, spin))),
        );
    }
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
