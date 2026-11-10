import type { EngineKernel, EnginePlugin, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { add, cross, dot, normalize, scale, sub } from '@margoengine/math/vec3';
import { axisAngleToQuaternion, multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';
import {
  Controls,
  documentOf,
  type ControlElement,
  type EventTargetLike,
  type InputEventListener,
} from './controls.js';
import { IDENTITY, transformPoint, type V3, type Q4 } from './math.js';
import { rollFrame, project, type Basis } from './view.js';
import { OverlayRenderer, tessellate } from './overlay.js';
import type { Prim, RGBA } from './gizmo.js';

/** A corner scale handle or an edge rotation handle, in world coordinates. */
export interface BoxHandle {
  /** Stable identifier: corner-0 through corner-7, or edge-0 through edge-11. */
  id: string;
  /** Operation performed by this handle. */
  kind: 'scale' | 'rotate';
  /** World position. */
  position: V3;
  /** Local rotation axis, 0=X, 1=Y, 2=Z; absent for scale. */
  axis?: number;
}
/** Optional bounding-box editor settings. */
export interface BoxGizmoOptions {
  /** Default engine canvas. */
  element?: ControlElement | null;
  /** Handle diameter in CSS pixels. Default 12. */
  handleSize?: number;
  /** Scale about the centre instead of the opposite corner. Default false. */
  scaleFromCenter?: boolean;
  /** Uniform scaling from corners. Default true. */
  uniformScaling?: boolean;
  /** Positive scale-ratio snap step, or null. Default null. */
  scaleSnap?: number | null;
  /** Positive rotation snap in radians, or null. Default null. */
  rotationSnap?: number | null;
}
interface Pose {
  position: V3;
  scale: V3;
  quaternion: Q4;
}
interface Grab {
  handle: BoxHandle;
  pose: Pose;
  pivot: V3;
  anchor: V3;
  x: number;
  y: number;
  dx: number;
  dy: number;
  length: number;
  basis: Basis;
  width: number;
  height: number;
}
let serial = 0;
const validateOptions = (handleSize: number, scaleSnap: number | null, rotationSnap: number | null): void => {
  if (
    !Number.isFinite(handleSize) ||
    handleSize <= 0 ||
    [scaleSnap, rotationSnap].some((v) => v !== null && (!Number.isFinite(v) || v <= 0))
  )
    throw new RangeError('BoxGizmo options must be positive finite numbers; use null to disable snapping');
};
const corner = (i: number, lo: V3, hi: V3): V3 => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];

/** Bounding-box editor: eight corner scale handles and twelve edge rotation handles. */
export class BoxGizmo extends Controls {
  /** Display and pick handles. Default true. */
  visible = true;
  /** Handle diameter in CSS pixels. Default 12. */
  handleSize: number;
  /** Scale about the centre instead of the opposite corner. Default false. */
  scaleFromCenter: boolean;
  /** Uniform corner scaling. Default true; false scales each screen-visible local axis. */
  uniformScaling: boolean;
  /** Ratio snap step, null for continuous. Default null. */
  scaleSnap: number | null;
  /** Angle snap in radians, null for continuous. Default null. */
  rotationSnap: number | null;
  /** Attached mesh, null when detached. */
  get object(): Mesh | null {
    return this.mesh;
  }
  /** Whether a handle is currently dragged. */
  get dragging(): boolean {
    return this.grab !== null;
  }
  /** GPU overlay diagnostics, released on device restoration and disposal. */
  readonly overlay = new OverlayRenderer();
  private mesh: Mesh | null = null;
  private lo: V3 = [0, 0, 0];
  private hi: V3 = [0, 0, 0];
  private grab: Grab | null = null;
  private pointer: number | null = null;
  private touchAction: string | null = null;
  private dead = false;
  private overlayPlugin: EnginePlugin & { registerPasses(graph: FrameGraph): void };
  constructor(engine: EngineKernel, options: BoxGizmoOptions = {}) {
    validateOptions(options.handleSize ?? 12, options.scaleSnap ?? null, options.rotationSnap ?? null);
    super(engine, options.element);
    this.handleSize = options.handleSize ?? 12;
    this.scaleFromCenter = options.scaleFromCenter ?? false;
    this.uniformScaling = options.uniformScaling ?? true;
    this.scaleSnap = options.scaleSnap ?? null;
    this.rotationSnap = options.rotationSnap ?? null;
    this.validate();
    const name = `margoengine-controls:box:${++serial}`;
    this.overlayPlugin = {
      name,
      setup() {},
      registerPasses: (graph: FrameGraph) => {
        graph.add({ name: name + ':overlay', order: 1000, execute: this.draw });
      },
      onDeviceRestored: () => this.overlay.release(),
      dispose: () => this.dispose(),
    };
    engine.use(this.overlayPlugin);
    this.init();
  }
  private validate(): void {
    validateOptions(this.handleSize, this.scaleSnap, this.rotationSnap);
  }
  /** Attach a live mesh with geometry. Recompute bounds after replacing its geometry. */
  attach(mesh: Mesh): this {
    if (this.dead) throw new MargoError('disposed', 'BoxGizmo is disposed; create a new gizmo');
    const runtime = engineRuntime(this.engine!);
    if (runtime.meshes.get(meshRuntime(mesh).id) !== mesh || !mesh.geometry?.vertices.length)
      throw new TypeError('BoxGizmo needs a live mesh with geometry from its engine; attach such a mesh');
    this.detach();
    this.mesh = mesh;
    this.refreshBounds();
    return this;
  }
  /** Detach and finish any active edit. */
  detach(): this {
    this.endDrag();
    this.mesh = null;
    return this;
  }
  /** Recompute exact local min/max bounds from geometry vertices. */
  refreshBounds(): void {
    if (!this.mesh) return;
    const vertices = this.mesh.geometry?.vertices;
    if (!vertices?.length) {
      this.detach();
      return;
    }
    this.lo = [Infinity, Infinity, Infinity];
    this.hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertices.length; i += 6)
      for (let a = 0; a < 3; a++) {
        this.lo[a] = Math.min(this.lo[a], vertices[i + a]);
        this.hi[a] = Math.max(this.hi[a], vertices[i + a]);
      }
  }
  private live(): Mesh | null {
    if (this.mesh && engineRuntime(this.engine!).meshes.get(meshRuntime(this.mesh).id) !== this.mesh) this.detach();
    return this.mesh;
  }
  private pose(): Pose {
    const t = engineRuntime(this.engine!).store.transforms,
      id = meshRuntime(this.mesh!).id;
    return {
      position: [t.x[id], t.y[id], t.z[id]],
      scale: [t.sx[id], t.sy[id], t.sz[id]],
      quaternion: [t.qx[id], t.qy[id], t.qz[id], t.qw[id]],
    };
  }
  private parent(): ArrayLike<number> {
    const s = engineRuntime(this.engine!).store,
      p = s.parents[meshRuntime(this.mesh!).id];
    return p < 0 ? IDENTITY : s.matrices.subarray(p * 16, p * 16 + 16);
  }
  private world(p: V3, pose = this.pose()): V3 {
    return transformPoint(
      this.parent(),
      add(
        pose.position,
        rotateByQuaternion(
          p.map((v, i) => v * pose.scale[i]),
          pose.quaternion,
        ),
      ),
    );
  }
  /** Current world corners, in the stable bit order X=1, Y=2, Z=4. */
  corners(): V3[] {
    return this.live() ? Array.from({ length: 8 }, (_, i) => this.world(corner(i, this.lo, this.hi))) : [];
  }
  /** Current pickable handles. */
  handles(): BoxHandle[] {
    const points = this.corners();
    if (!points.length) return [];
    const handles: BoxHandle[] = points.map((position, i) => ({ id: `corner-${i}`, kind: 'scale', position }));
    let n = 0;
    for (let a = 0; a < 3; a++)
      for (let i = 0; i < 8; i++)
        if (!(i & (1 << a)))
          handles.push({
            id: `edge-${n++}`,
            kind: 'rotate',
            axis: a,
            position: scale(add(points[i], points[i | (1 << a)]), 0.5),
          });
    return handles;
  }
  /** Screen-space hit test. Nearest depth wins when handles overlap. */
  pick(x: number, y: number): BoxHandle | null {
    if (!this.visible || !this.enabled || !this.element || this.dead) return null;
    const w = this.element.clientWidth,
      h = this.element.clientHeight,
      b = rollFrame(this.camera);
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    let best: BoxHandle | null = null,
      depth = Infinity;
    for (const handle of this.handles()) {
      const p = project(b, handle.position, w, h);
      if (p.depth > this.camera.near && Math.hypot(p.x - x, p.y - y) <= this.handleSize * 0.7 && p.depth < depth) {
        best = handle;
        depth = p.depth;
      }
    }
    return best;
  }
  /** Begin a handle drag at CSS coordinates, optionally choosing a known handle id. */
  beginDrag(x: number, y: number, id?: string): boolean {
    this.validate();
    if (this.dead || !this.enabled || !this.visible || !this.live() || !this.element || this.grab) return false;
    const handle = id ? this.handles().find((h) => h.id === id) : this.pick(x, y);
    if (!handle) return false;
    const pose = this.pose(),
      width = this.element.clientWidth,
      height = this.element.clientHeight,
      basis = rollFrame(this.camera);
    const pivot =
      handle.kind === 'scale' && !this.scaleFromCenter
        ? corner(Number(handle.id.slice(7)) ^ 7, this.lo, this.hi)
        : scale(add(this.lo, this.hi), 0.5);
    const anchor = this.world(pivot, pose),
      c = project(basis, anchor, width, height),
      p = project(basis, handle.position, width, height);
    let dx = p.x - c.x,
      dy = p.y - c.y,
      length = Math.hypot(dx, dy);
    if (handle.kind === 'rotate') {
      const axis = [0, 0, 0] as V3;
      axis[handle.axis!] = 1;
      const aw = normalize(sub(this.world(add(pivot, axis), pose), anchor)),
        tangent = cross(aw, sub(handle.position, anchor));
      const q = project(
        basis,
        add(handle.position, normalize(Math.hypot(...tangent) > 1e-9 ? tangent : basis.up)),
        width,
        height,
      );
      dx = q.x - p.x;
      dy = q.y - p.y;
      length = Math.hypot(dx, dy);
    }
    if (length < 1e-6) return false;
    this.grab = { handle, pose, pivot, anchor, x, y, dx: dx / length, dy: dy / length, length, basis, width, height };
    this.dispatchEvent({ type: 'start', handle: handle.id });
    this.dispatchEvent({ type: 'dragging-changed', value: true });
    return true;
  }
  /** Apply drag displacement from its original pose; snapping never accumulates rounding error. */
  dragTo(x: number, y: number): boolean {
    const g = this.grab,
      mesh = this.live();
    if (!g || !mesh || !this.enabled) return false;
    this.validate();
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new RangeError('Drag coordinates must be finite; pass CSS pixels');
    let q = g.pose.quaternion,
      s = [...g.pose.scale] as V3;
    const travel = (x - g.x) * g.dx + (y - g.y) * g.dy;
    if (g.handle.kind === 'scale') {
      for (let a = 0; a < 3; a++) {
        let ratio = 1 + travel / g.length;
        if (!this.uniformScaling) {
          const p = corner(Number(g.handle.id.slice(7)), this.lo, this.hi),
            axis = [...g.pivot] as V3;
          axis[a] = p[a];
          const c = project(g.basis, g.anchor, g.width, g.height),
            v = project(g.basis, this.world(axis, g.pose), g.width, g.height),
            dx = v.x - c.x,
            dy = v.y - c.y,
            l2 = dx * dx + dy * dy;
          ratio = l2 < 1e-9 ? 1 : 1 + ((x - g.x) * dx + (y - g.y) * dy) / l2;
        }
        if (this.scaleSnap) ratio = Math.round(ratio / this.scaleSnap) * this.scaleSnap;
        s[a] *= Math.max(1e-4, ratio);
      }
    } else {
      let angle = travel / Math.max(40, g.length);
      if (this.rotationSnap) angle = Math.round(angle / this.rotationSnap) * this.rotationSnap;
      const axis = [0, 0, 0] as V3;
      axis[g.handle.axis!] = 1;
      q = multiplyQuaternions(g.pose.quaternion, axisAngleToQuaternion(axis, angle));
    }
    // Preserve the local pivot in parent coordinates, including nonuniform parent scales.
    const pivotBefore = add(
      g.pose.position,
      rotateByQuaternion(
        g.pivot.map((v, i) => v * g.pose.scale[i]),
        g.pose.quaternion,
      ),
    );
    const position = sub(
      pivotBefore,
      rotateByQuaternion(
        g.pivot.map((v, i) => v * s[i]),
        q,
      ),
    );
    mesh.setScale(s).setQuaternion(q).setPosition(position);
    this.dispatchEvent({ type: 'objectChange', handle: g.handle.id });
    this.dispatchEvent({ type: 'change' });
    return true;
  }
  /** Commit the active edit and release its pointer capture. */
  endDrag(): void {
    if (this.pointer !== null) {
      this.release(this.pointer);
      this.pointer = null;
    }
    if (!this.grab) return;
    this.grab = null;
    this.dispatchEvent({ type: 'end' });
    this.dispatchEvent({ type: 'dragging-changed', value: false });
  }
  /** Restore the original transform and end the edit. */
  cancelDrag(): boolean {
    const g = this.grab;
    if (!g || !this.live()) return false;
    this.mesh!.setPosition(g.pose.position).setQuaternion(g.pose.quaternion).setScale(g.pose.scale);
    this.endDrag();
    this.dispatchEvent({ type: 'objectChange' });
    this.dispatchEvent({ type: 'change' });
    return true;
  }
  protected override bind(
    element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    if (element.style) {
      this.touchAction = element.style.touchAction;
      element.style.touchAction = 'none';
    }
    return [
      [element, 'pointerdown', this.down],
      [element, 'pointermove', this.move],
      [element, 'pointerup', this.up],
      [element, 'pointercancel', this.cancel],
      [documentOf(element), 'keydown', this.key],
    ];
  }
  private down = (event: PointerEvent): void => {
    if (event.button !== 0 || this.pointer !== null) return;
    const p = this.local(event);
    if (this.beginDrag(p.x, p.y)) {
      this.pointer = event.pointerId;
      this.capture(event.pointerId);
      event.preventDefault();
    }
  };
  private move = (event: PointerEvent): void => {
    if (event.pointerId === this.pointer) {
      const p = this.local(event);
      this.dragTo(p.x, p.y);
    }
  };
  private up = (event: PointerEvent): void => {
    if (event.pointerId === this.pointer) this.endDrag();
  };
  private cancel = (event: PointerEvent): void => {
    if (event.pointerId === this.pointer) this.cancelDrag();
  };
  private key = (event: KeyboardEvent): void => {
    if (event.code === 'Escape' && this.cancelDrag()) event.preventDefault();
  };
  protected override onDisconnect(): void {
    this.cancelDrag();
    if (this.element?.style && this.touchAction !== null) this.element.style.touchAction = this.touchAction;
    this.touchAction = null;
  }
  override update(): boolean {
    if (this.dead) return false;
    this.live();
    return false;
  }
  private draw = (ctx: PassContext): void => {
    const points = this.corners();
    if (this.dead || !this.visible || !points.length) return;
    const width = this.element?.clientWidth || ctx.width,
      height = this.element?.clientHeight || ctx.height,
      b = rollFrame(ctx.camera),
      prims: Prim[] = [];
    const white: RGBA = [0.3, 0.75, 1, 1],
      yellow: RGBA = [1, 0.8, 0.15, 1];
    const edges: V3[] = [];
    for (let a = 0; a < 3; a++)
      for (let i = 0; i < 8; i++) if (!(i & (1 << a))) edges.push(points[i], points[i | (1 << a)]);
    prims.push({ kind: 'lines', points: edges, width: 1.5, colors: [white] });
    for (const handle of this.handles()) {
      const depth = dot(sub(handle.position, b.position), b.forward),
        r = ((b.ortho ?? depth * b.tanHalf) * this.handleSize) / height;
      if (depth <= ctx.camera.near) continue;
      const steps = handle.kind === 'scale' ? 4 : 12,
        pts: V3[] = [];
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2,
          angle2 = ((i + 1) / steps) * Math.PI * 2;
        const at = (t: number) =>
          add(handle.position, add(scale(b.right, Math.cos(t) * r), scale(b.up, Math.sin(t) * r)));
        pts.push(handle.position, at(angle), at(angle2));
      }
      prims.push({ kind: 'triangles', points: pts, color: handle.kind === 'scale' ? white : yellow });
    }
    this.overlay.draw(ctx, tessellate(prims, ctx.camera.matrix, ctx.width, ctx.height, ctx.width / width));
  };
  override dispose(): void {
    if (this.dead) return;
    this.detach();
    this.dead = true;
    this.overlay.release();
    const plugin = this.overlayPlugin;
    if (plugin) this.engine?.sceneOf(plugin)?.removePlugin(plugin.name);
    super.dispose();
  }
}
