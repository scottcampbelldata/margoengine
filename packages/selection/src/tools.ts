/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { meshTriangles } from '../../shared/mesh-source.js';

type V3 = [number, number, number];

/** A screen rectangle in CSS pixels, from the top left of the canvas. */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** How a mesh's projected bounding circle must meet the shape to be selected. */
export type SelectMode =
  /** Its centre is inside (the default; fast and predictable for dense scenes). */
  | 'center'
  /** Any part of its bounds touches the shape (what CAD calls a crossing window). */
  | 'overlap'
  /** All of its bounds are inside the shape (a window selection). */
  | 'contain';

/** Options of {@link selectInRect} and {@link selectInPolygon}. */
export interface ScreenSelectOptions {
  /** Meshes to test. Default: every visible mesh with geometry. */
  meshes?: Iterable<Mesh>;
  /** How the bounds must meet the shape. Default `'center'`. */
  mode?: SelectMode;
  /** Canvas size in CSS pixels. Default: the engine canvas `clientWidth` and `clientHeight`. */
  width?: number;
  height?: number;
}

interface Projected {
  mesh: Mesh;
  x: number;
  y: number;
  radius: number;
}

const sub = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The canvas size and the camera's view-projection (WebGPU depth 0..1), refreshed for the canvas aspect. */
function frame(engine: EngineKernel, options: ScreenSelectOptions) {
  const canvas = engine.canvas as unknown as { clientWidth: number; clientHeight: number };
  const width = options.width ?? canvas.clientWidth,
    height = options.height ?? canvas.clientHeight;
  if (!(width > 0 && height > 0))
    throw new RangeError('Canvas size must be positive; pass width and height when the canvas has no layout');
  const camera = engine.camera;
  camera.update(width / height, true);
  return { camera, matrix: camera.matrix as ArrayLike<number>, width, height };
}

function toPixel(m: ArrayLike<number>, p: ArrayLike<number>, width: number, height: number) {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return { x: ((x / w + 1) / 2) * width, y: ((1 - y / w) / 2) * height, w, z };
}

/** The visible geometry meshes of the engine with their projected bounding circles; those behind the camera are left out. */
function project(engine: EngineKernel, options: ScreenSelectOptions): Projected[] {
  const runtime = engineRuntime(engine),
    { camera, matrix, width, height } = frame(engine, options),
    forward = unit(sub(camera.target, camera.position)),
    right = unit(cross(forward, (camera.up as V3) ?? [0, 1, 0]));
  const meshes = options.meshes ?? runtime.meshes.values();
  const out: Projected[] = [];
  for (const mesh of meshes) {
    const geometry = (mesh as unknown as { geometry?: { bounds: Float32Array } }).geometry;
    if (!geometry) continue;
    const id = meshRuntime(mesh).id;
    if (!runtime.store.visible[id]) continue;
    const m = runtime.store.matrices.subarray(id * 16, id * 16 + 16),
      b = geometry.bounds;
    const centre: V3 = [
      m[0] * b[0] + m[4] * b[1] + m[8] * b[2] + m[12],
      m[1] * b[0] + m[5] * b[1] + m[9] * b[2] + m[13],
      m[2] * b[0] + m[6] * b[1] + m[10] * b[2] + m[14],
    ];
    const scale = Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])),
      world = b[3] * scale;
    const c = toPixel(matrix, centre, width, height);
    if (!(c.w > 0)) continue;
    const edge = toPixel(
      matrix,
      [centre[0] + right[0] * world, centre[1] + right[1] * world, centre[2] + right[2] * world],
      width,
      height,
    );
    out.push({ mesh, x: c.x, y: c.y, radius: Math.hypot(edge.x - c.x, edge.y - c.y) });
  }
  return out;
}

/**
 * Marquee select: the meshes whose projected bounds meet the rectangle (CSS pixels from the canvas's top left),
 * nearest to the camera first is not implied: results follow engine order. Bounds are the geometry's bounding sphere,
 * so `'overlap'` and `'contain'` are conservative for long thin meshes.
 */
export function selectInRect(engine: EngineKernel, rect: ScreenRect, options: ScreenSelectOptions = {}): Mesh[] {
  const mode = options.mode ?? 'center',
    x0 = Math.min(rect.x, rect.x + rect.width),
    x1 = Math.max(rect.x, rect.x + rect.width),
    y0 = Math.min(rect.y, rect.y + rect.height),
    y1 = Math.max(rect.y, rect.y + rect.height);
  return project(engine, options)
    .filter((p) => {
      if (mode === 'center') return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
      if (mode === 'contain')
        return p.x - p.radius >= x0 && p.x + p.radius <= x1 && p.y - p.radius >= y0 && p.y + p.radius <= y1;
      const dx = Math.max(x0 - p.x, 0, p.x - x1),
        dy = Math.max(y0 - p.y, 0, p.y - y1);
      return dx * dx + dy * dy <= p.radius * p.radius;
    })
    .map((p) => p.mesh);
}

function inside(polygon: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i],
      [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function edgeDistance(polygon: readonly (readonly [number, number])[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j],
      [bx, by] = polygon[i],
      dx = bx - ax,
      dy = by - ay,
      l = dx * dx + dy * dy,
      t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/**
 * Lasso select: the meshes whose projected bounds meet a free-form polygon (CSS pixel points, implicitly closed).
 * `'center'` tests the projected centre, `'overlap'` any part of the bounding circle, `'contain'` the whole circle.
 * @throws RangeError with fewer than three points.
 */
export function selectInPolygon(
  engine: EngineKernel,
  polygon: readonly (readonly [number, number])[],
  options: ScreenSelectOptions = {},
): Mesh[] {
  if (polygon.length < 3) throw new RangeError('A lasso needs at least three points');
  const mode = options.mode ?? 'center';
  return project(engine, options)
    .filter((p) => {
      const within = inside(polygon, p.x, p.y);
      if (mode === 'center') return within;
      const near = edgeDistance(polygon, p.x, p.y);
      if (mode === 'overlap') return within || near <= p.radius;
      return within && near >= p.radius;
    })
    .map((p) => p.mesh);
}

// ---- Face, edge and vertex picking on the CPU ----

/** A mesh element under a screen point. Indices refer to the geometry's vertex and triangle numbering. */
export interface ElementHit {
  mesh: Mesh;
  /** Index of the triangle (face) hit: its vertices are `geometry.indices[3 * face .. 3 * face + 2]`. */
  face: number;
  /** World-space hit point. */
  point: [number, number, number];
  /** Distance from the camera to the hit point. */
  distance: number;
  /** The three vertex indices of the face. */
  vertices: [number, number, number];
  /** The face vertex nearest the hit point. */
  vertex: number;
  /** The face edge nearest the hit point, as two vertex indices. */
  edge: [number, number];
}

function invert(m: ArrayLike<number>): Float64Array | null {
  const a = Float64Array.from(m),
    inv = new Float64Array(16);
  const s0 = a[0] * a[5] - a[4] * a[1],
    s1 = a[0] * a[9] - a[8] * a[1],
    s2 = a[0] * a[13] - a[12] * a[1],
    s3 = a[4] * a[9] - a[8] * a[5],
    s4 = a[4] * a[13] - a[12] * a[5],
    s5 = a[8] * a[13] - a[12] * a[9],
    c5 = a[10] * a[15] - a[14] * a[11],
    c4 = a[6] * a[15] - a[14] * a[7],
    c3 = a[6] * a[11] - a[10] * a[7],
    c2 = a[2] * a[15] - a[14] * a[3],
    c1 = a[2] * a[11] - a[10] * a[3],
    c0 = a[2] * a[7] - a[6] * a[3];
  const det = s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;
  if (!det) return null;
  const d = 1 / det;
  inv[0] = (a[5] * c5 - a[9] * c4 + a[13] * c3) * d;
  inv[1] = (-a[1] * c5 + a[9] * c2 - a[13] * c1) * d;
  inv[2] = (a[1] * c4 - a[5] * c2 + a[13] * c0) * d;
  inv[3] = (-a[1] * c3 + a[5] * c1 - a[9] * c0) * d;
  inv[4] = (-a[4] * c5 + a[8] * c4 - a[12] * c3) * d;
  inv[5] = (a[0] * c5 - a[8] * c2 + a[12] * c1) * d;
  inv[6] = (-a[0] * c4 + a[4] * c2 - a[12] * c0) * d;
  inv[7] = (a[0] * c3 - a[4] * c1 + a[8] * c0) * d;
  inv[8] = (a[7] * s5 - a[11] * s4 + a[15] * s3) * d;
  inv[9] = (-a[3] * s5 + a[11] * s2 - a[15] * s1) * d;
  inv[10] = (a[3] * s4 - a[7] * s2 + a[15] * s0) * d;
  inv[11] = (-a[3] * s3 + a[7] * s1 - a[11] * s0) * d;
  inv[12] = (-a[6] * s5 + a[10] * s4 - a[14] * s3) * d;
  inv[13] = (a[2] * s5 - a[10] * s2 + a[14] * s1) * d;
  inv[14] = (-a[2] * s4 + a[6] * s2 - a[14] * s0) * d;
  inv[15] = (a[2] * s3 - a[6] * s1 + a[10] * s0) * d;
  return inv;
}
const unproject = (inv: Float64Array, x: number, y: number, z: number): V3 => {
  const px = inv[0] * x + inv[4] * y + inv[8] * z + inv[12],
    py = inv[1] * x + inv[5] * y + inv[9] * z + inv[13],
    pz = inv[2] * x + inv[6] * y + inv[10] * z + inv[14],
    pw = inv[3] * x + inv[7] * y + inv[11] * z + inv[15];
  return [px / pw, py / pw, pz / pw];
};

/**
 * Face, edge and vertex picking: casts the ray under a canvas point (CSS pixels) against the triangles of core meshes
 * and returns the nearest hit with the face, its nearest vertex and nearest edge. Walks every triangle of the meshes whose
 * bounding sphere the ray crosses, so it suits editing tools on models of up to a few hundred thousand triangles;
 * back faces count. Loaded glTF models are not triangle-listed here; pick them with `Picking` and test their own data.
 * Returns null when nothing is hit.
 */
export function pickElement(
  engine: EngineKernel,
  x: number,
  y: number,
  options: ScreenSelectOptions = {},
): ElementHit | null {
  const runtime = engineRuntime(engine),
    { camera, matrix, width, height } = frame(engine, options),
    inv = invert(matrix);
  if (!inv) return null;
  const nx = (x / width) * 2 - 1,
    ny = 1 - (y / height) * 2;
  // Depth 0 and 1 are the two clip planes; which one is the near plane depends on the depth convention, so the ray
  // starts at whichever is closer to the camera.
  const p0 = unproject(inv, nx, ny, 0),
    p1 = unproject(inv, nx, ny, 1),
    distance0 = Math.hypot(...sub(p0, camera.position)),
    distance1 = Math.hypot(...sub(p1, camera.position)),
    near = distance0 <= distance1 ? p0 : p1,
    dir = unit(distance0 <= distance1 ? sub(p1, p0) : sub(p0, p1));
  let best: ElementHit | null = null;
  for (const mesh of options.meshes ?? runtime.meshes.values()) {
    const source = meshTriangles(mesh as never) as {
      kind: string;
      geometry?: { vertices: Float32Array; indices: Uint32Array; bounds: Float32Array };
    } | null;
    if (!source || source.kind !== 'core' || !source.geometry) continue;
    const id = meshRuntime(mesh).id;
    if (!runtime.store.visible[id]) continue;
    const m = runtime.store.matrices.subarray(id * 16, id * 16 + 16),
      { vertices, indices } = source.geometry;
    const world = (i: number): V3 => {
      const px = vertices[i * 6],
        py = vertices[i * 6 + 1],
        pz = vertices[i * 6 + 2];
      return [
        m[0] * px + m[4] * py + m[8] * pz + m[12],
        m[1] * px + m[5] * py + m[9] * pz + m[13],
        m[2] * px + m[6] * py + m[10] * pz + m[14],
      ];
    };
    // Bounding sphere reject.
    const b = source.geometry.bounds,
      centre: V3 = [
        m[0] * b[0] + m[4] * b[1] + m[8] * b[2] + m[12],
        m[1] * b[0] + m[5] * b[1] + m[9] * b[2] + m[13],
        m[2] * b[0] + m[6] * b[1] + m[10] * b[2] + m[14],
      ],
      radius =
        b[3] * Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));
    const oc = sub(centre, near),
      along = oc[0] * dir[0] + oc[1] * dir[1] + oc[2] * dir[2];
    if (oc[0] ** 2 + oc[1] ** 2 + oc[2] ** 2 - along * along > radius * radius * 1.0001) continue;
    for (let f = 0; f * 3 < indices.length; f++) {
      const ia = indices[f * 3],
        ib = indices[f * 3 + 1],
        ic = indices[f * 3 + 2],
        a = world(ia),
        e1 = sub(world(ib), a),
        e2 = sub(world(ic), a),
        p = cross(dir, e2),
        det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
      if (Math.abs(det) < 1e-14) continue;
      const t0 = sub(near, a),
        u = (t0[0] * p[0] + t0[1] * p[1] + t0[2] * p[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = cross(t0, e1),
        v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) / det;
      if (v < 0 || u + v > 1) continue;
      const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (t < 0 || (best && t >= best.distance)) continue;
      const point: V3 = [near[0] + dir[0] * t, near[1] + dir[1] * t, near[2] + dir[2] * t];
      // Nearest vertex by barycentre, nearest edge by the smallest barycentre weight (the edge opposite it).
      const w = [1 - u - v, u, v],
        corner = [ia, ib, ic],
        biggest = w.indexOf(Math.max(...w)),
        smallest = w.indexOf(Math.min(...w));
      best = {
        mesh,
        face: f,
        point,
        distance: t,
        vertices: [ia, ib, ic],
        vertex: corner[biggest],
        edge: [corner[(smallest + 1) % 3], corner[(smallest + 2) % 3]],
      };
    }
  }
  // Distance from the camera, not from the near plane.
  if (best) best.distance = Math.hypot(...sub(best.point, camera.position));
  return best;
}

// ---- Pointer-driven marquee and lasso ----

type PointerLike = {
  clientX: number;
  clientY: number;
  pointerId: number;
  button: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  pointerType?: string;
  stopImmediatePropagation?: () => void;
  preventDefault?: () => void;
};
/** The canvas-like element the tool listens on. */
export interface SelectionElement {
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
  getBoundingClientRect?(): { left: number; top: number };
  setPointerCapture?(id: number): void;
  releasePointerCapture?(id: number): void;
  clientWidth: number;
  clientHeight: number;
  ownerDocument?: { createElement(tag: string): unknown };
  parentElement?: { appendChild(node: unknown): unknown; removeChild(node: unknown): unknown } | null;
}
/** What happened to the set. */
export type SelectOperation = 'replace' | 'add' | 'subtract';
/** Options of {@link SelectionTool}. */
export interface SelectionToolOptions extends Omit<ScreenSelectOptions, 'meshes'> {
  /** `'marquee'` drags a rectangle, `'lasso'` a free-form outline. Default `'marquee'`. */
  shape?: 'marquee' | 'lasso';
  /** Meshes that can be selected. Default: every visible mesh with geometry. */
  meshes?: () => Iterable<Mesh>;
  /** Decides which presses start a drag. Default: left button with Shift held. */
  trigger?: (event: PointerLike) => boolean;
  /** CSS pixels the pointer must travel before the drag counts (a plain click is left alone). Default 4. */
  threshold?: number;
  /** Element to listen on. Default: the engine canvas. */
  element?: SelectionElement;
  /** Draws the rubber band with DOM nodes next to the canvas. Default true (skipped without a DOM). */
  overlay?: boolean;
  /** Called with the new selection when a drag ends. */
  onSelect?: (meshes: Mesh[], operation: SelectOperation) => void;
  /** Detaches the tool when aborted. */
  signal?: AbortSignal;
}

/**
 * Drag a rubber band or a lasso over the canvas to select meshes. Shift + drag replaces the selection, Shift + Ctrl
 * (or Meta) adds, Shift + Alt removes. The tool stops the press from reaching later listeners, so create it before
 * the camera controls; a press that does not match `trigger` passes through. The current set is `tool.selected`; give
 * `onSelect` or listen for the `select` event to outline it, for example with `Selection.set`.
 */
export class SelectionTool extends EventTarget {
  /** The meshes selected so far. */
  selected: Mesh[] = [];
  enabled = true;
  readonly shape: 'marquee' | 'lasso';
  private readonly engine: EngineKernel;
  private readonly options: SelectionToolOptions;
  private element: SelectionElement | null;
  private start: { x: number; y: number } | null = null;
  private points: [number, number][] = [];
  private active = false;
  private pointer = -1;
  private node: { style: Record<string, string>; remove?: () => void } | null = null;
  private operation: SelectOperation = 'replace';

  /** Creates the tool on `engine` (preferred over the constructor). */
  static attach(engine: EngineKernel, options?: SelectionToolOptions): SelectionTool {
    return new SelectionTool(engine, options);
  }
  constructor(engine: EngineKernel, options: SelectionToolOptions = {}) {
    super();
    this.engine = engine;
    this.options = options;
    this.shape = options.shape ?? 'marquee';
    const element = options.element ?? (engine.canvas as unknown as SelectionElement);
    this.element = element;
    element.addEventListener('pointerdown', this.onDown);
    element.addEventListener('pointermove', this.onMove);
    element.addEventListener('pointerup', this.onUp);
    element.addEventListener('pointercancel', this.cancel);
    options.signal?.addEventListener('abort', () => this.dispose(), { once: true });
    if (options.signal?.aborted) this.dispose();
  }

  /** Detaches every listener and removes the rubber band. */
  dispose(): void {
    const element = this.element;
    if (!element) return;
    this.cancel();
    element.removeEventListener('pointerdown', this.onDown);
    element.removeEventListener('pointermove', this.onMove);
    element.removeEventListener('pointerup', this.onUp);
    element.removeEventListener('pointercancel', this.cancel);
    this.element = null;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private local(event: PointerLike): { x: number; y: number } {
    const rect = this.element?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  private readonly onDown = (event: PointerLike): void => {
    if (!this.enabled || this.active || !this.element) return;
    const trigger = this.options.trigger ?? ((e: PointerLike) => e.button === 0 && !!e.shiftKey);
    if (!trigger(event)) return;
    event.stopImmediatePropagation?.();
    event.preventDefault?.();
    this.pointer = event.pointerId;
    this.element.setPointerCapture?.(event.pointerId);
    this.start = this.local(event);
    this.points = [[this.start.x, this.start.y]];
    this.operation = event.ctrlKey || event.metaKey ? 'add' : event.altKey ? 'subtract' : 'replace';
    this.active = false;
    this.armed = true;
  };
  private armed = false;
  private readonly onMove = (event: PointerLike): void => {
    if (!this.armed || event.pointerId !== this.pointer || !this.start) return;
    const p = this.local(event);
    if (!this.active) {
      if (Math.hypot(p.x - this.start.x, p.y - this.start.y) < (this.options.threshold ?? 4)) return;
      this.active = true;
      this.dispatchEvent(new Event('start'));
    }
    this.points.push([p.x, p.y]);
    this.draw(p);
  };
  private readonly onUp = (event: PointerLike): void => {
    if (!this.armed || event.pointerId !== this.pointer) return;
    const was = this.active,
      end = this.local(event),
      points = this.points;
    this.element?.releasePointerCapture?.(event.pointerId);
    this.reset();
    if (!was) return;
    const base = { mode: this.options.mode, width: this.options.width, height: this.options.height };
    const found = this.options.meshes ? [...this.options.meshes()] : undefined;
    const options = { ...base, meshes: found };
    const start = points[0];
    const hits =
      this.shape === 'marquee'
        ? selectInRect(
            this.engine,
            { x: start[0], y: start[1], width: end.x - start[0], height: end.y - start[1] },
            options,
          )
        : points.length >= 3
          ? selectInPolygon(this.engine, points, options)
          : [];
    const set = new Set(this.selected);
    if (this.operation === 'replace') this.selected = hits;
    else if (this.operation === 'add') this.selected = [...new Set([...set, ...hits])];
    else this.selected = this.selected.filter((m) => !hits.includes(m));
    this.dispatchEvent(Object.assign(new Event('select'), { meshes: this.selected, operation: this.operation }));
    this.options.onSelect?.(this.selected, this.operation);
  };
  private readonly cancel = (): void => {
    if (!this.armed) return;
    if (this.element && this.pointer >= 0) {
      try {
        this.element.releasePointerCapture?.(this.pointer);
      } catch {
        /* ignore */
      }
    }
    const was = this.active;
    this.reset();
    if (was) this.dispatchEvent(new Event('cancel'));
  };
  private reset(): void {
    this.armed = false;
    this.active = false;
    this.start = null;
    this.points = [];
    this.pointer = -1;
    if (this.node) {
      this.node.remove?.();
      this.node = null;
    }
  }
  private draw(p: { x: number; y: number }): void {
    const element = this.element;
    if (this.options.overlay === false || !element?.ownerDocument || !element.parentElement || !this.start) return;
    if (!this.node) {
      const node = element.ownerDocument.createElement('div') as { style: Record<string, string>; remove?: () => void };
      Object.assign(node.style, {
        position: 'absolute',
        pointerEvents: 'none',
        border: '1px dashed rgba(255,255,255,0.9)',
        background: 'rgba(80,160,255,0.18)',
        boxSizing: 'border-box',
      });
      element.parentElement.appendChild(node);
      this.node = node;
    }
    const style = this.node.style;
    // Lasso: the bounding box of the path stands in for the outline (a DOM outline of the free-form path needs SVG).
    const xs = this.shape === 'lasso' ? this.points.map((q) => q[0]) : [this.start.x, p.x],
      ys = this.shape === 'lasso' ? this.points.map((q) => q[1]) : [this.start.y, p.y];
    style.left = `${Math.min(...xs)}px`;
    style.top = `${Math.min(...ys)}px`;
    style.width = `${Math.max(...xs) - Math.min(...xs)}px`;
    style.height = `${Math.max(...ys) - Math.min(...ys)}px`;
  }
}

// ---- Hover highlight ----

/** What {@link HoverHighlight} needs from a `Picking` effect. */
export interface HoverPicker {
  pick(x: number, y: number): Promise<{ mesh: Mesh } | null>;
}
/** What {@link HoverHighlight} needs from a `Selection` effect: give it its own, with a name such as `'hover'`. */
export interface HoverOutline {
  set(meshes: Iterable<Mesh>): void;
}
/** Options of {@link HoverHighlight}. */
export interface HoverHighlightOptions {
  /** `Picking.attach(engine)`. */
  picking: HoverPicker;
  /**
   * A `Selection` used only for the hover outline: `Selection.attach(engine, {name: 'hover', color: [1, 0.9, 0.3]})`.
   * Default: no outline, only `onHover`, which is the way on the WebGL2 preview, where `Selection` cannot draw.
   */
  outline?: HoverOutline;
  /** Element to listen on. Default: the engine canvas. */
  element?: SelectionElement;
  /** Called with the mesh under the pointer (or null) whenever it changes. */
  onHover?: (mesh: Mesh | null) => void;
  /** Detaches the highlight when aborted. */
  signal?: AbortSignal;
}

/**
 * Outlines the mesh under the mouse. One pick is in flight at a time and the newest pointer position always wins, so a
 * fast mouse never queues work. No highlight while a button is down (a drag is not a hover) or for touch input.
 */
export class HoverHighlight {
  /** The mesh currently highlighted, or null. */
  mesh: Mesh | null = null;
  enabled = true;
  private element: SelectionElement | null;
  private pending: { x: number; y: number } | null = null;
  private busy = false;
  private readonly options: HoverHighlightOptions;

  /** Creates the highlight on `engine` (preferred over the constructor). */
  static attach(engine: EngineKernel, options: HoverHighlightOptions): HoverHighlight {
    return new HoverHighlight(engine, options);
  }
  constructor(engine: EngineKernel, options: HoverHighlightOptions) {
    this.options = options;
    const element = options.element ?? (engine.canvas as unknown as SelectionElement);
    this.element = element;
    element.addEventListener('pointermove', this.onMove);
    element.addEventListener('pointerleave', this.onLeave);
    options.signal?.addEventListener('abort', () => this.dispose(), { once: true });
    if (options.signal?.aborted) this.dispose();
  }
  /** Removes the listeners and the outline. */
  dispose(): void {
    const element = this.element;
    if (!element) return;
    element.removeEventListener('pointermove', this.onMove);
    element.removeEventListener('pointerleave', this.onLeave);
    this.element = null;
    this.pending = null;
    this.change(null);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private change(mesh: Mesh | null): void {
    if (mesh === this.mesh) return;
    this.mesh = mesh;
    this.options.outline?.set(mesh ? [mesh] : []);
    this.options.onHover?.(mesh);
  }
  private readonly onLeave = (): void => {
    this.pending = null;
    this.change(null);
  };
  private readonly onMove = (event: PointerLike & { buttons?: number }): void => {
    if (!this.enabled || event.pointerType === 'touch') return;
    if (event.buttons) {
      this.pending = null;
      this.change(null);
      return;
    }
    const rect = this.element?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    this.pending = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    void this.run();
  };
  private async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending && this.element) {
        const { x, y } = this.pending;
        this.pending = null;
        const hit = await this.options.picking.pick(x, y);
        if (this.element && !this.pending) this.change(hit ? hit.mesh : null);
      }
    } finally {
      this.busy = false;
    }
  }
}
