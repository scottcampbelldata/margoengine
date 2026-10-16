/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import { EventDispatcher, type ControlElement } from './controls.js';
import {
  buildGizmo,
  pickHandle,
  type GizmoFrame,
  type Handle,
  type HandleName,
  type Prim,
  type TransformMode,
} from './gizmo.js';
import {
  IDENTITY,
  invertAffine,
  madd,
  quatAxis,
  quatConj,
  quatFromMatrix,
  quatNormalize,
  quatRotate,
  transformPoint,
  type Q4,
  type V3,
} from './math.js';
import { add, cross, dot, normalize, scale, sub } from '@margoengine/math/vec3';
import { OverlayRenderer, tessellate } from './overlay.js';
import { multiplyQuaternions as quatMul } from '@margoengine/math/quat';
import { basis, intersectPlane, project, ray, type Basis } from './view.js';

export type TransformSpace = 'world' | 'local';
export type { TransformMode, HandleName };

export interface TransformControlsOptions {
  mode?: TransformMode;
  space?: TransformSpace;
  /** Gizmo size multiplier. 1 matches three.js. */
  size?: number;
  translationSnap?: number | null;
  /** Radians. */
  rotationSnap?: number | null;
  scaleSnap?: number | null;
  showX?: boolean;
  showY?: boolean;
  showZ?: boolean;
  /** Element to listen on. Defaults to the engine canvas. */
  element?: ControlElement;
  /** Frame graph order of the overlay pass. Default 1000, after the scene and most effects. */
  order?: number;
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
}

let counter = 0;

/**
 * Interactive translate, rotate and scale gizmo for a core `Mesh` (three.js `TransformControls`).
 *
 * The gizmo is drawn by a frame graph pass on top of the scene (WebGPU, with a WebGL2 fallback) and is hit-tested
 * in screen space with ray math. Drags are applied in the parent's space using the world matrices in
 * `engineRuntime(engine).store.matrices`, so parented meshes move, rotate and scale correctly.
 *
 * Events: `change`, `mouseDown`, `mouseUp`, `objectChange`, `dragging-changed` (`value`), `axis-changed` (`value`),
 * `mode-changed` and `space-changed`.
 */
export class TransformControls extends EventDispatcher {
  readonly engine: EngineKernel;
  element: ControlElement | null = null;
  enabled = true;
  /** Draws the gizmo when attached. */
  visible = true;
  mode: TransformMode;
  space: TransformSpace;
  size: number;
  translationSnap: number | null;
  rotationSnap: number | null;
  scaleSnap: number | null;
  showX: boolean;
  showY: boolean;
  showZ: boolean;
  /** Attached mesh, or null. */
  object: Mesh | null = null;
  /** Hovered or dragged handle. */
  axis: HandleName | null = null;
  dragging = false;
  readonly overlay = new OverlayRenderer();
  private drag: DragStart | null = null;
  private pointerId: number | null = null;
  private resetState: { position: V3; quaternion: Q4; scale: V3 } | null = null;
  /** Name of the engine plugin that owns the overlay pass. */
  readonly pluginName: string;
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
    this.size = options.size ?? 1;
    this.translationSnap = options.translationSnap ?? null;
    this.rotationSnap = options.rotationSnap ?? null;
    this.scaleSnap = options.scaleSnap ?? null;
    this.showX = options.showX ?? true;
    this.showY = options.showY ?? true;
    this.showZ = options.showZ ?? true;
    this.pluginName = `margoengine-controls:transform:${++counter}`;
    const order = options.order ?? 1000;
    engine.use({
      name: this.pluginName,
      setup() {},
      registerPasses: (graph: FrameGraph) => {
        graph.add({ name: this.pluginName + ':overlay', order, execute: this.execute });
      },
      onDeviceRestored: () => this.overlay.release(),
      dispose: () => this.dispose(),
    } as Parameters<EngineKernel['use']>[0]);
    try {
      this.connect(options.element ?? (engine.canvas as unknown as ControlElement));
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  connect(element: ControlElement): void {
    if (this.disposed) throw new Error('Controls are disposed');
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

  attach(object: Mesh): this {
    meshRuntime(object).check();
    if ((meshRuntime(object) as unknown as { engine: unknown }).engine !== engineRuntime(this.engine))
      throw new TypeError('Mesh belongs to another engine');
    if (this.dragging) this.endDrag();
    this.object = object;
    this.resetState = this.local();
    this.dispatchEvent({ type: 'change' });
    return this;
  }
  detach(): this {
    if (this.dragging) this.endDrag();
    this.object = null;
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
  setSize(size: number): void {
    if (!(size > 0)) throw new RangeError('Gizmo size must be positive');
    this.size = size;
    this.dispatchEvent({ type: 'change' });
  }
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
    const s = this.resetState;
    this.object.setPosition(s.position).setQuaternion(s.quaternion).setScale(s.scale);
    this.dispatchEvent({ type: 'objectChange' });
    this.dispatchEvent({ type: 'change' });
  }

  /** The gizmo frame for a viewport size in CSS pixels, or null when nothing is attached. */
  frame(): GizmoFrame | null {
    const object = this.attached();
    if (!object) return null;
    const store = engineRuntime(this.engine).store,
      id = meshRuntime(object).id,
      m = store.matrices.subarray(id * 16, id * 16 + 16);
    const origin: V3 = [m[12], m[13], m[14]],
      camera = this.engine.camera,
      b = basis(camera);
    const space = this.mode === 'scale' ? 'local' : this.space,
      q = this.worldQuaternion(object);
    const axes: [V3, V3, V3] =
      space === 'local'
        ? [quatRotate(q, [1, 0, 0]), quatRotate(q, [0, 1, 0]), quatRotate(q, [0, 0, 1])]
        : [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ];
    const toCamera = sub(camera.position, origin),
      distance = Math.hypot(...toCamera) || 1;
    // Constant screen size: a fixed fraction of the visible height at the gizmo (the whole view height when orthographic,
    // where every point also sees the camera along the same direction).
    const size = ((b.ortho !== undefined ? b.ortho * 1.9 : distance * Math.min(1.9 * b.tanHalf, 7)) / 4) * this.size;
    return {
      mode: this.mode,
      origin,
      axes,
      size,
      eye: b.ortho !== undefined ? scale(b.forward, -1) : scale(toCamera, 1 / distance),
      up: b.up,
      show: { X: this.showX, Y: this.showY, Z: this.showZ },
      axis: this.axis,
      dragging: this.dragging,
    };
  }
  /** Handles for the current frame (also what the overlay draws). */
  handles(): Handle[] {
    const f = this.frame();
    return f ? buildGizmo(f) : [];
  }
  /** Screen-space hit test at CSS pixel coordinates relative to the element. */
  pick(x: number, y: number): HandleName | null {
    const f = this.frame(),
      e = this.element;
    if (!f || !e) return null;
    return pickHandle(
      buildGizmo(f),
      basis(this.engine.camera),
      f.origin,
      x,
      y,
      Math.max(1, e.clientWidth),
      Math.max(1, e.clientHeight),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnect();
    this.object = null;
    this.overlay.release();
    if (!this.engine.disposed && this.engine.hasPlugin(this.pluginName)) this.engine.removePlugin(this.pluginName);
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
      element = this.element;
    if (!object || !f || !this.axis || !element) return;
    const width = Math.max(1, element.clientWidth),
      height = Math.max(1, element.clientHeight),
      b = basis(this.engine.camera);
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
    };
    if (this.mode === 'rotate' && 'XYZ'.includes(axis) && axis.length === 1) {
      const a = f.axes['XYZ'.indexOf(axis)],
        hit = intersectPlane(ray(b, x, y, width, height), o, a);
      drag.exact = !!hit && Math.abs(dot(a, f.eye)) > 0.15;
      if (drag.exact) drag.pointStart = sub(hit!, o);
      else {
        // Ring seen edge-on: drag along the screen tangent of the ring at the grab point.
        const grab = this.closestOnRing('XYZ'.indexOf(axis), f, b, x, y, width, height),
          t = normalize(cross(a, grab));
        const p0 = project(b, add(o, grab), width, height),
          p1 = project(b, madd(add(o, grab), t, f.size * 0.1), width, height);
        const l = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
        drag.tangent = { x: (p1.x - p0.x) / l, y: (p1.y - p0.y) / l };
      }
    } else if (this.mode === 'translate' || (this.mode === 'scale' && axis !== 'XYZ')) {
      const hit = intersectPlane(ray(b, x, y, width, height), o, drag.normal);
      drag.pointStart = hit ? sub(hit, o) : null;
      if (!drag.pointStart) return;
    }
    this.drag = drag;
    this.resetState = local;
    this.dragging = true;
    this.dispatchEvent({ type: 'dragging-changed', value: true });
    this.dispatchEvent({ type: 'mouseDown', mode: this.mode });
    this.dispatchEvent({ type: 'change' });
  }

  /** Continues a drag at CSS pixel coordinates. Called by the pointer handler. */
  pointerMove(x: number, y: number): void {
    const d = this.drag,
      object = this.attached(),
      element = this.element;
    if (!d || !object || !element) return;
    const width = Math.max(1, element.clientWidth),
      height = Math.max(1, element.clientHeight),
      b = basis(this.engine.camera);
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
    const snap = this.translationSnap,
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
    object.setPosition(transformPoint(d.parentInverse, world));
  }

  private rotate(d: DragStart, object: Mesh, b: Basis, x: number, y: number, width: number, height: number): void {
    let axis: V3, angle: number;
    if (d.axis === 'XYZE') {
      const dx = x - d.screenLast.x,
        dy = y - d.screenLast.y,
        distance = Math.hypot(dx, dy);
      if (!distance) return;
      const drag = normalize(madd(scale(b.right, dx), b.up, -dy));
      d.free = quatNormalize(
        quatMul(quatAxis(normalize(cross(d.eye, drag)), distance / Math.max(1, d.pixelsPerUnit)), d.free),
      );
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
    if (this.rotationSnap) angle = Math.round(angle / this.rotationSnap) * this.rotationSnap;
    d.angle = angle;
    this.applyRotation(d, object, quatAxis(axis, angle));
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
    const P = d.parentQuaternion,
      next = quatMul(quatMul(quatMul(quatConj(P), rotation), P), d.quaternion);
    object.setQuaternion(quatNormalize(next));
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
    }
    const snap = this.scaleSnap;
    for (let i = 0; i < 3; i++) {
      if (snap) next[i] = Math.round(next[i] / snap) * snap || snap;
      if (Math.abs(next[i]) < 1e-4) next[i] = Math.sign(next[i] || d.scale[i]) * 1e-4;
    }
    object.setScale(next);
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
  private attached(): Mesh | null {
    const object = this.object;
    if (!object) return null;
    const runtime = engineRuntime(this.engine);
    if (runtime.disposed || runtime.meshes.get(meshRuntime(object).id) !== (object as unknown)) {
      this.object = null;
      this.dragging = false;
      this.drag = null;
      return null;
    }
    return object;
  }
  private local(): { position: V3; quaternion: Q4; scale: V3 } {
    const t = engineRuntime(this.engine).store.transforms,
      id = meshRuntime(this.object!).id;
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
    return quatNormalize(quatMul(quatFromMatrix(this.parentMatrix(object)), [t.qx[id], t.qy[id], t.qz[id], t.qw[id]]));
  }

  private readonly execute = (ctx: PassContext): void => {
    if (!this.visible || this.disposed) return;
    const f = this.frame();
    if (!f) {
      this.overlay.lastTriangles = 0;
      return;
    }
    const prims: Prim[] = [];
    for (const handle of buildGizmo(f)) prims.push(...handle.prims);
    const canvas = this.engine.canvas,
      ratio = canvas.clientWidth ? ctx.width / canvas.clientWidth : 1;
    this.overlay.draw(ctx, tessellate(prims, ctx.camera.matrix, ctx.width, ctx.height, ratio));
  };
}
