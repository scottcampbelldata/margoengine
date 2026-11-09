import { cross, dot, normalize, sub } from '@margoengine/math/vec3';
import type { FrameGraph, PassContext } from '@margoengine/core/extension';
import type { EngineKernel, EnginePlugin } from '@margoengine/core';
import type { Prim, RGBA } from './gizmo.js';
import { madd, type V3 } from './math.js';
import { OverlayRenderer, tessellate } from './overlay.js';
import { basis, type Basis } from './view.js';
import { viewSize } from '../../shared/view-rect.js';

/** What `ArcballGizmo` draws from: an `ArcballControls` on an engine. */
export interface ArcballGizmoTarget {
  readonly engine: EngineKernel | null;
  readonly element: { clientWidth?: number; clientHeight?: number } | null;
  readonly camera: EngineKernel['camera'];
  readonly state: string;
  /** Set to the gizmo's ring drag while it is attached. */
  handle?: { begin(x: number, y: number): boolean; move(x: number, y: number): void } | null;
  /** Turns the camera about a world axis, as a ring drag does. */
  rotate?(axis: readonly number[], angle: number): void;
}
/** Options of `ArcballGizmo`; every field is optional. */
export interface ArcballGizmoOptions {
  /** Draw only during a gesture. Default true. */
  autoHide?: boolean;
  /** Line width in CSS pixels. Default 2. */
  lineWidth?: number;
  /** Frame graph order of the overlay pass. Default 1000, after the scene and most effects. */
  order?: number;
}

const SEGMENTS = 64;
/** How near a ring a press takes it, in CSS pixels. */
const GRAB_PIXELS = 8;
const AXES: readonly V3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const COLORS: readonly RGBA[] = [
  [0.9, 0.25, 0.25, 0.9],
  [0.3, 0.8, 0.3, 0.9],
  [0.3, 0.5, 0.95, 0.9],
];
/** The share of a ring's opacity left on the far half of the ball. */
const FAR_SIDE = 0.25;
let counter = 0;

/**
 * The arcball on screen: rings about the world X, Y and Z axes and an outline, centred on `camera.target` at the size of
 * the ball the pointer drags. The far half of each ring is dimmed, so the turn reads at a glance. It draws in a frame
 * graph pass of its own. With `autoHide: false` a ring can be grabbed: a left drag that starts on the near half of one
 * turns the view about that ring's axis only, and the point grabbed stays under the pointer. `ArcballGizmo` is an
 * export of its own, so an arcball without it loads none of the overlay code.
 */
export class ArcballGizmo {
  /** Draws when true. Default true. */
  visible = true;
  /** Draw only during a gesture. Default true. */
  autoHide: boolean;
  /** Line width in CSS pixels. Default 2. */
  lineWidth: number;
  readonly overlay = new OverlayRenderer();
  readonly controls: ArcballGizmoTarget;
  /** Name of the engine plugin that owns the overlay pass. */
  readonly pluginName: string;
  private readonly plugin: EnginePlugin;
  private readonly engine: EngineKernel;
  private disposed = false;
  private grabbed: { axis: V3; radial: V3; x: number; y: number } | null = null;

  /** Creates the gizmo for `controls` (preferred over the constructor). */
  static attach(controls: ArcballGizmoTarget, options?: ArcballGizmoOptions): ArcballGizmo {
    return new ArcballGizmo(controls, options);
  }
  constructor(controls: ArcballGizmoTarget, options: ArcballGizmoOptions = {}) {
    const engine = controls.engine;
    if (!engine) throw new TypeError('ArcballGizmo needs controls made on an engine, not a bare Camera');
    this.controls = controls;
    this.engine = engine;
    this.autoHide = options.autoHide ?? true;
    this.lineWidth = options.lineWidth ?? 2;
    this.pluginName = `margoengine-controls:arcball-gizmo:${++counter}`;
    const order = options.order ?? 1000;
    if (controls.rotate) controls.handle = this.ringDrag;
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
  }
  /** The ball's radius in world units at the target: half the smaller side of the element, as the pointer drag uses. */
  radius(): number {
    const { camera, element } = this.controls,
      width = Math.max(1, element?.clientWidth ?? 1),
      height = Math.max(1, element?.clientHeight ?? 1),
      b = basis(camera);
    return ((2 * (b.ortho ?? b.distance * b.tanHalf)) / height) * (Math.min(width, height) / 2);
  }
  /** The lines of the current frame. */
  prims(): Prim[] {
    const { camera } = this.controls,
      b = basis(camera),
      center = [...camera.target] as V3,
      r = this.radius(),
      back: V3 = [-b.forward[0], -b.forward[1], -b.forward[2]],
      prims: Prim[] = [];
    AXES.forEach((axis, i) => {
      const u = normalize(cross(axis, AXES[(i + 1) % 3])) as V3,
        v = cross(axis, u) as V3,
        points: V3[] = [],
        colors: RGBA[] = [];
      this.ring(center, u, v, r, points, (mid) => {
        const c = COLORS[i],
          near = mid[0] * back[0] + mid[1] * back[1] + mid[2] * back[2] >= 0;
        colors.push(near ? c : [c[0], c[1], c[2], c[3] * FAR_SIDE]);
      });
      prims.push({ kind: 'lines', points, width: this.lineWidth, colors });
    });
    const outline: V3[] = [];
    this.ring(center, b.right as V3, b.up as V3, r, outline);
    prims.push({ kind: 'lines', points: outline, width: this.lineWidth, colors: [[1, 1, 1, 0.5]] });
    return prims;
  }
  /** Element pixels of a world point. */
  private screen(point: readonly number[], b: Basis): [number, number] {
    const { element } = this.controls,
      width = Math.max(1, element?.clientWidth ?? 1),
      height = Math.max(1, element?.clientHeight ?? 1),
      v = sub(point, b.position),
      scale = height / 2 / (b.ortho ?? dot(v, b.forward) * b.tanHalf);
    return [width / 2 + dot(v, b.right) * scale, height / 2 - dot(v, b.up) * scale];
  }
  /** Hands a press near a ring's near half to the ring; the far half is behind the ball, and the ball takes that. */
  private readonly ringDrag = {
    begin: (x: number, y: number): boolean => {
      this.grabbed = null;
      if (!this.visible || this.disposed || this.autoHide) return false;
      const { camera } = this.controls,
        b = basis(camera),
        center = [...camera.target] as V3,
        r = this.radius();
      let best = GRAB_PIXELS;
      AXES.forEach((axis, i) => {
        const u = normalize(cross(axis, AXES[(i + 1) % 3])) as V3,
          v = cross(axis, u) as V3;
        for (let s = 0; s < SEGMENTS; s++) {
          const a = (s / SEGMENTS) * Math.PI * 2,
            radial = madd(madd([0, 0, 0], u, Math.cos(a) * r), v, Math.sin(a) * r);
          if (dot(radial, b.forward) > 0) continue;
          const [px, py] = this.screen(madd(center, radial, 1), b),
            distance = Math.hypot(px - x, py - y);
          if (distance < best) {
            best = distance;
            this.grabbed = { axis, radial, x, y };
          }
        }
      });
      return !!this.grabbed;
    },
    move: (x: number, y: number): void => {
      const grabbed = this.grabbed;
      if (!grabbed) return;
      const { camera } = this.controls,
        b = basis(camera),
        point = madd([...camera.target] as V3, grabbed.radial, 1),
        // The ring's tangent at the grabbed point, as pixels for a small turn of the scene.
        step = 1e-3,
        [ax, ay] = this.screen(point, b),
        [bx, by] = this.screen(madd(point, cross(grabbed.axis, grabbed.radial), step), b),
        sx = (bx - ax) / step,
        sy = (by - ay) / step,
        speed = sx * sx + sy * sy;
      // Edge on, the ring has no direction on screen to follow.
      if (speed < 1) return;
      this.controls.rotate?.(grabbed.axis, -((x - grabbed.x) * sx + (y - grabbed.y) * sy) / speed);
      grabbed.x = x;
      grabbed.y = y;
    },
  };
  private ring(c: V3, u: V3, v: V3, r: number, out: V3[], each?: (mid: V3) => void): void {
    const at = (a: number): V3 => madd(madd(c, u, Math.cos(a) * r), v, Math.sin(a) * r);
    for (let i = 0; i < SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2,
        z = ((i + 1) / SEGMENTS) * Math.PI * 2;
      out.push(at(a), at(z));
      if (each) {
        const m = (a + z) / 2;
        each(madd(madd([0, 0, 0], u, Math.cos(m)), v, Math.sin(m)));
      }
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.controls.handle === this.ringDrag) this.controls.handle = null;
    this.overlay.release();
    this.engine.sceneOf(this.plugin)?.removePlugin(this.pluginName);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private readonly execute = (ctx: PassContext): void => {
    if (!this.visible || this.disposed || (this.autoHide && this.controls.state === 'none')) {
      this.overlay.lastTriangles = 0;
      return;
    }
    const canvas = this.engine.canvas,
      ratio = canvas.clientWidth ? ctx.width / canvas.clientWidth : 1,
      [width, height] = viewSize(ctx);
    this.overlay.draw(ctx, tessellate(this.prims(), ctx.camera.matrix, width, height, ratio));
  };
}
