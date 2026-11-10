/// <reference lib="esnext.disposable" preserve="true" />
import type { Camera, EngineKernel, EnginePlugin, Mesh, RenderView } from '@margoengine/core';
import { engineRuntime, meshRuntime, type FrameGraph } from '@margoengine/core/extension';
import {
  cameraCSSTransform,
  composeMatrix,
  cssPerspective,
  lookAtView,
  objectCSSTransform,
  orthographicCSSTransform,
  type Vec3,
} from './projection.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { fault, rangeError, vectorAssignment } from '../../shared/errors.js';
import { createScreenPoint, isOrthographic, projectPoint, type ScreenPoint } from '@margoengine/math/mat4';

/** Where a label sits this frame: its screen position, depth, distance from the camera and world anchor. */
export interface LabelInfo {
  /** Projected position in CSS pixels relative to the canvas. */
  readonly x: number;
  readonly y: number;
  /** Normalized depth, 0 near to 1 far. */
  readonly depth: number;
  /** Euclidean distance from the camera in world units. */
  readonly distance: number;
  /** World-space anchor point. */
  readonly world: Vec3;
}
/** Return true to hide the label this frame (custom occlusion, for example a raycast against the scene). */
export type OccludeHook = (label: Label, info: LabelInfo) => boolean;
/**
 * Return true to hide the CSS 3D object this frame, for example when scene geometry is in front of it. `info`
 * describes the object's origin; its `x` and `y` are NaN when the origin is behind the camera.
 */
export type CSS3DOccludeHook = (object: CSS3DObject, info: LabelInfo) => boolean;
/** Scales a label by distance: a reference distance, optionally clamped between min and max scale. */
export type DistanceScale = number | { reference: number; min?: number; max?: number };

/**
 * What a {@link LabelLayout} gets each update: the view size, each label's measured size, and the two decisions it
 * can make. The renderer applies them in the same update, before any label is drawn.
 */
export interface LayoutContext {
  /** Size of the view rectangle in CSS pixels; label `screen` coordinates are relative to its corner. */
  readonly width: number;
  readonly height: number;
  /** The overlay root the labels sit in, with its corner at the view's corner; for layouts that draw (`Callouts`). */
  readonly root: HTMLElement;
  /**
   * The element's size in CSS pixels before distance scaling, measured once (`offsetWidth`, `offsetHeight`) and
   * kept until `label.remeasure()`. Multiply by `label.scale` for its size on screen.
   */
  size(label: Label): readonly [number, number];
  /** Hides the label this update; `label.onScreen` reads false. */
  hide(label: Label): void;
  /** Places the label with another anchor this update; its own `anchor` is kept for the next one. */
  place(label: Label, anchor: readonly [number, number]): void;
}
/**
 * Arranges the labels that passed culling and occlusion before they are drawn, for example to remove overlaps
 * (`Declutter` from `@margoengine/labels/declutter`). Called once per update with the labels in the order added,
 * also with none, so a layout can clear what it drew.
 */
export interface LabelLayout {
  arrange(labels: readonly Label[], context: LayoutContext): void;
}

/** Options of a label: the mesh or position it follows, its offset, anchor, culling, occlusion and visibility. */
export interface LabelOptions {
  /** Mesh to follow. The anchor is the mesh origin plus `offset`. */
  mesh?: Mesh | null;
  /** World position when not following a mesh. */
  position?: Vec3;
  /** Offset from the mesh origin, in the mesh's local space (like a child object) or world space. */
  offset?: Vec3;
  offsetSpace?: 'local' | 'world';
  /** Which point of the element sits on the anchor, as fractions of its size. Default [0.5, 0.5] (center). */
  anchor?: readonly [number, number];
  /**
   * Moves the element this many CSS pixels from its projected point, x right and y down, for a callout with a leader
   * line (`Callouts` from `@margoengine/labels/callouts`). Default [0, 0].
   */
  screenOffset?: readonly [number, number];
  /** 'none' lets pointer events pass through to the canvas (default); 'auto' makes the label interactive. */
  pointerEvents?: 'none' | 'auto';
  /** Hide when outside the view frustum. Default true. Labels behind the camera are always hidden. */
  frustumCulling?: boolean;
  /** Hide while the mesh or an ancestor is hidden. Default true. */
  followVisibility?: boolean;
  /** Scale the element by `reference / distance` (clamped to min..max). */
  distanceScale?: DistanceScale;
  /** Take part in depth sorting (z-index). Default true. */
  sort?: boolean;
  /** Rank for a {@link LabelLayout}: a decluttering layout keeps higher priorities first. Default 0. */
  priority?: number;
  occlude?: OccludeHook;
  visible?: boolean;
}

/** Options of a CSS3D object: the mesh or matrix it follows, its pixel scale and visibility. */
export interface CSS3DOptions {
  mesh?: Mesh | null;
  /** Column-major world matrix when not following a mesh. */
  matrix?: ArrayLike<number>;
  position?: Vec3;
  /** Quaternion [x, y, z, w]. */
  quaternion?: readonly number[];
  /** World units per CSS pixel. Default 0.01, so a 100 px wide element spans one world unit. */
  pixelScale?: number;
  pointerEvents?: 'none' | 'auto';
  followVisibility?: boolean;
  /** Hides the object while it returns true; CSS 3D objects are not depth-tested against the canvas. */
  occlude?: CSS3DOccludeHook;
  visible?: boolean;
}

/** Options of LabelRenderer: parent element, z-index, default occlusion, frame-pass order and view. */
export interface LabelRendererOptions {
  /** Element that receives the overlay. Default: the canvas's parent, right after the canvas. */
  parent?: HTMLElement;
  /** z-index of the overlay root. Default 1. */
  zIndex?: number;
  /** Optional class name for the overlay root. */
  className?: string;
  /** Default occlusion hook for every label. */
  occlude?: OccludeHook;
  name?: string;
  /** Frame-pass order. Default 1000, after the scene and other overlays. */
  order?: number;
  /** Arranges the visible labels each update, for example `new Declutter()`; see {@link LabelRenderer.layout}. */
  layout?: LabelLayout | null;
  /** Engine view the labels belong to; see {@link LabelRenderer.view}. Default the engine camera and whole canvas. */
  view?: LabelView;
}
/**
 * The camera and rectangle labels are placed in, as in an engine `RenderView`: `viewport` is fractions of the canvas,
 * or drawing-buffer pixels with `pixels`. Labels outside the rectangle are clipped.
 */
export type LabelView = Pick<RenderView, 'camera' | 'viewport' | 'pixels'>;

type StyleCache = Record<string, string>;
const write = (element: HTMLElement, cache: StyleCache, property: string, value: string): void => {
  if (cache[property] === value) return;
  cache[property] = value;
  (element.style as unknown as Record<string, string>)[property] = value;
};
const px = (value: number): string => `${Math.round(value * 100) / 100}px`;
const checkPriority = (value: number): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) throw rangeError('priority must be a number', 'labels');
  return value;
};
const checkVec = (value: Vec3, name: string): Vec3 => {
  if (!value || value.length < 3 || ![value[0], value[1], value[2]].every(Number.isFinite))
    throw new RangeError(`${name} must be three finite numbers`);
  return [value[0], value[1], value[2]];
};

abstract class Item {
  readonly element: HTMLElement;
  visible: boolean;
  followVisibility: boolean;
  /** True when the element was shown at the last update. */
  onScreen = false;
  /** Euclidean distance to the camera at the last update. */
  distance = Number.NaN;
  protected meshValue: Mesh | null;
  /** @internal */ readonly cache: StyleCache = {};
  /** @internal */ owner: LabelRenderer | null;
  constructor(
    owner: LabelRenderer,
    element: HTMLElement,
    mesh: Mesh | null | undefined,
    followVisibility: boolean | undefined,
    visible: boolean | undefined,
  ) {
    if (!element || typeof element !== 'object' || !('style' in element))
      throw new TypeError('Expected an HTMLElement');
    this.owner = owner;
    this.element = element;
    this.meshValue = mesh ?? null;
    this.followVisibility = followVisibility ?? true;
    this.visible = visible ?? true;
  }
  /** @internal Element size in CSS pixels, measured once (`offsetWidth`, `offsetHeight`); null until measured. */
  measured: [number, number] | null = null;
  get mesh(): Mesh | null {
    return this.meshValue;
  }
  /** Measures the element again at the next update, after its content or style changed its size. */
  remeasure(): this {
    this.measured = null;
    return this;
  }
  /** Removes the element from the overlay and stops tracking it. */
  remove(): void {
    this.owner?.remove(this as unknown as Label | CSS3DObject);
  }
}

/** A 2D HTML label pinned to a projected world point. */
export class Label extends Item {
  anchor: [number, number];
  /** CSS pixels the element is moved from its projected point, x right and y down. */
  screenOffset: [number, number];
  frustumCulling: boolean;
  distanceScale: DistanceScale | null;
  sort: boolean;
  occlude: OccludeHook | null;
  private priorityValue: number;
  /** Distance scale applied at the last update; 1 without `distanceScale`. */
  scale = 1;
  /** Anchor used at the last update: `anchor`, or the one a layout placed the label with. */
  readonly placedAnchor: [number, number] = [0.5, 0.5];
  /** @internal Layout decision of the current update: hidden, or placed with another anchor. */
  layoutHidden = false;
  /** @internal */ layoutAnchor: [number, number] | null = null;
  /** Projected position at the last update. */
  readonly screen: ScreenPoint = createScreenPoint();
  /** World anchor at the last update. */
  readonly world: [number, number, number] = [0, 0, 0];
  /** @internal Numbers the current transform text was built from: x, y, scaled flag, scale, anchor. */
  readonly placement = new Float64Array(6).fill(NaN);
  private positionValue: Vec3;
  private offsetValue: Vec3;
  offsetSpace: 'local' | 'world';
  constructor(owner: LabelRenderer, element: HTMLElement, options: LabelOptions) {
    super(owner, element, options.mesh, options.followVisibility, options.visible);
    this.positionValue = checkVec(options.position ?? [0, 0, 0], 'position');
    this.offsetValue = checkVec(options.offset ?? [0, 0, 0], 'offset');
    this.offsetSpace = options.offsetSpace ?? 'local';
    this.anchor = [options.anchor?.[0] ?? 0.5, options.anchor?.[1] ?? 0.5];
    const offset = options.screenOffset ?? [0, 0];
    if (!offset || !Number.isFinite(offset[0]) || !Number.isFinite(offset[1]))
      throw rangeError('screenOffset must be two finite numbers', 'labels');
    this.screenOffset = [offset[0], offset[1]];
    this.frustumCulling = options.frustumCulling ?? true;
    this.distanceScale = options.distanceScale ?? null;
    this.sort = options.sort ?? true;
    this.priorityValue = checkPriority(options.priority ?? 0);
    this.occlude = options.occlude ?? null;
    element.style.pointerEvents = options.pointerEvents ?? 'none';
  }
  /** Rank for a {@link LabelLayout}; higher is kept first. */
  get priority(): number {
    return this.priorityValue;
  }
  set priority(value: number) {
    this.priorityValue = checkPriority(value);
  }
  get position(): Vec3 {
    return this.positionValue;
  }
  get offset(): Vec3 {
    return this.offsetValue;
  }
  setMesh(mesh: Mesh | null): this {
    this.meshValue = mesh;
    return this;
  }
  /** Pins the label to a world position and stops following a mesh. */
  setPosition(position: Vec3): this {
    this.positionValue = checkVec(position, 'position');
    this.meshValue = null;
    return this;
  }
  setOffset(offset: Vec3): this {
    this.offsetValue = checkVec(offset, 'offset');
    return this;
  }
}

// Keep the public getter-only type while giving rejected assignment the core transform diagnostic.
Object.defineProperty(Label.prototype, 'position', { set: vectorAssignment });

/** An HTML element placed in world space with a CSS matrix3d transform. */
export class CSS3DObject extends Item {
  pixelScale: number;
  occlude: CSS3DOccludeHook | null;
  /** True when part of the element was behind the near plane at the last update and was cut off (`clip-path`). */
  clipped = false;
  /** World matrix used at the last update (column-major). */
  readonly matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  private readonly own = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  constructor(owner: LabelRenderer, element: HTMLElement, options: CSS3DOptions) {
    super(owner, element, options.mesh, options.followVisibility, options.visible);
    this.pixelScale = options.pixelScale ?? 0.01;
    if (!Number.isFinite(this.pixelScale) || this.pixelScale <= 0) throw new RangeError('pixelScale must be > 0');
    this.occlude = options.occlude ?? null;
    if (options.matrix) this.setMatrix(options.matrix);
    else
      composeMatrix(
        checkVec(options.position ?? [0, 0, 0], 'position'),
        options.quaternion ?? [0, 0, 0, 1],
        [1, 1, 1],
        this.own,
      );
    element.style.pointerEvents = options.pointerEvents ?? 'none';
  }
  setMesh(mesh: Mesh | null): this {
    this.meshValue = mesh;
    return this;
  }
  /** Sets a world matrix (column-major) and stops following a mesh. */
  setMatrix(matrix: ArrayLike<number>): this {
    if (!matrix || matrix.length < 16) throw new RangeError('Expected a 16-element matrix');
    for (let i = 0; i < 16; i++) if (!Number.isFinite(matrix[i])) throw new RangeError('Matrix must be finite');
    for (let i = 0; i < 16; i++) this.own[i] = matrix[i];
    this.meshValue = null;
    return this;
  }
  setPose(position: Vec3, quaternion: readonly number[] = [0, 0, 0, 1]): this {
    composeMatrix(checkVec(position, 'position'), quaternion, [1, 1, 1], this.own);
    this.meshValue = null;
    return this;
  }
  /** @internal */ get ownMatrix(): Float64Array {
    return this.own;
  }
}

/**
 * Engine plugin that keeps HTML labels and CSS 3D objects registered over the canvas every frame.
 * DOM writes happen only when a value changes.
 */
export class LabelRenderer implements EnginePlugin {
  readonly name: string;
  /** Overlay root; created in setup, removed on dispose. */
  root: HTMLDivElement | null = null;
  occlude: OccludeHook | null;
  /** Arranges the visible labels each update (for example `new Declutter()`); null places each label on its own. */
  layout: LabelLayout | null;
  private readonly order: number;
  private readonly options: LabelRendererOptions;
  private engine: EngineKernel | null = null;
  private readonly labels = new Set<Label>();
  private readonly objects = new Set<CSS3DObject>();
  private viewer: HTMLDivElement | null = null;
  private cameraElement: HTMLDivElement | null = null;
  private readonly rootCache: StyleCache = {};
  private readonly viewerCache: StyleCache = {};
  private readonly cameraCache: StyleCache = {};
  private readonly cssView = new Float64Array(16);
  private readonly point = createScreenPoint();
  /** Signed distances in front of the near plane at a CSS 3D element's corners, reused every update. */
  private readonly depths = new Float64Array(4);
  private readonly visibleLabels: Label[] = [];
  private readonly shownLabels: Label[] = [];
  private readonly layoutContext = {
    width: 0,
    height: 0,
    root: null as unknown as HTMLElement,
    size: (label: Label): readonly [number, number] => this.measure(label),
    hide: (label: Label): void => {
      label.layoutHidden = true;
    },
    place: (label: Label, anchor: readonly [number, number]): void => {
      if (!anchor || !Number.isFinite(anchor[0]) || !Number.isFinite(anchor[1]))
        throw rangeError('place(label, anchor) takes two finite numbers', 'labels');
      label.layoutAnchor = [anchor[0], anchor[1]];
    },
  };
  private readonly world: [number, number, number] = [0, 0, 0];
  private left = 0;
  private top = 0;
  /** CSS scale written on the root, from the canvas's ancestor scale over the root's; 1 when they agree. */
  private rootScale = 1;
  /** Number of style properties written during the last update (diagnostics and tests). */
  writes = 0;

  /**
   * Same as `engine.use(new LabelRenderer(...))`; returns the LabelRenderer.
   * @throws MargoError with code `state` and reuse/name guidance when the plugin name is already registered.
   */
  static attach(engine: EngineKernel, options?: LabelRendererOptions): LabelRenderer {
    const name = options?.name ?? 'margoengine-labels';
    if (engineRuntime(engine).plugins.has(name))
      throw fault(
        'state',
        `A plugin named "${name}" is already attached; reuse its LabelRenderer or pass an unused name in LabelRenderer.attach(engine, { name: 'annotations' })`,
      );
    const value = new LabelRenderer(options);
    engine.use(value);
    return value;
  }
  /**
   * Engine view the labels belong to: they project through its camera and sit in its rectangle, clipped to it, and
   * hook and `LabelInfo` coordinates are relative to its corner. Null: the engine camera and the whole canvas.
   */
  view: LabelView | null;
  constructor(options: LabelRendererOptions = {}) {
    this.options = options;
    this.view = options.view ?? null;
    this.name = options.name ?? 'margoengine-labels';
    this.order = options.order ?? 1000;
    this.occlude = options.occlude ?? null;
    this.layout = options.layout ?? null;
  }

  setup(engine: EngineKernel): void {
    this.engine = engine;
    const canvas = engine.canvas,
      document = canvas.ownerDocument;
    const root = document.createElement('div');
    if (this.options.className) root.className = this.options.className;
    const style = root.style;
    style.position = 'absolute';
    style.pointerEvents = 'none';
    style.overflow = 'hidden';
    style.zIndex = String(this.options.zIndex ?? 1);
    style.left = '0px';
    style.top = '0px';
    style.margin = '0';
    style.padding = '0';
    style.transformOrigin = '0 0';
    root.dataset.margoengineLabels = '';
    const parent = this.options.parent ?? canvas.parentElement ?? document.body;
    if (parent === canvas.parentElement) parent.insertBefore(root, canvas.nextSibling);
    else parent.appendChild(root);
    this.root = root;
    this.left = 0;
    this.top = 0;
    this.rootScale = 1;
    for (const label of this.labels) this.mount(label);
    for (const object of this.objects) this.mount(object);
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name, order: this.order, execute: () => this.update() });
  }

  /** Adds a 2D label. The element is moved into the overlay. */
  add(element: HTMLElement, options: LabelOptions = {}): Label {
    const label = new Label(this, element, options);
    this.labels.add(label);
    this.mount(label);
    return label;
  }
  /** Adds a CSS 3D object. The element is moved into the overlay's 3D layer. */
  add3D(element: HTMLElement, options: CSS3DOptions = {}): CSS3DObject {
    const object = new CSS3DObject(this, element, options);
    this.objects.add(object);
    this.mount(object);
    return object;
  }
  remove(item: Label | CSS3DObject): void {
    if (item.owner !== this) return;
    item.owner = null;
    this.labels.delete(item as Label);
    this.objects.delete(item as CSS3DObject);
    item.element.remove();
  }
  get size(): number {
    return this.labels.size + this.objects.size;
  }

  /** Positions every label and CSS 3D object for the current camera. Runs as a frame pass; safe to call manually. */
  update(): void {
    const engine = this.engine,
      root = this.root;
    this.writes = 0;
    if (!engine || engine.disposed || !root) return;
    const canvas = engine.canvas,
      view = this.view,
      camera = view?.camera ?? engine.camera,
      backend = engine.backend,
      cssWidth = canvas.clientWidth || canvas.width,
      cssHeight = canvas.clientHeight || canvas.height;
    // The view rectangle in CSS pixels: fractions of the canvas, or drawing-buffer pixels scaled to CSS.
    const [x, y, w, h] = view?.viewport ?? [0, 0, 1, 1],
      sx = view?.pixels ? cssWidth / canvas.width : cssWidth,
      sy = view?.pixels ? cssHeight / canvas.height : cssHeight,
      width = w * sx,
      height = h * sy;
    const runtime = engineRuntime(engine),
      store = runtime.store,
      matrices = store.matrices;
    this.syncRoot(canvas, x * sx, y * sy, width, height);
    const visible = this.visibleLabels,
      shown = this.shownLabels;
    visible.length = 0;
    shown.length = 0;
    const [ex, ey, ez] = camera.position,
      m = camera.matrix;
    // Orthographic: size does not change with distance, so distanceScale uses the distance at which a perspective
    // camera with this fov shows the same zoom.
    const zoomDistance = isOrthographic(m)
      ? 1 / (Math.hypot(m[1], m[5], m[9]) * Math.tan((camera.fov * Math.PI) / 360))
      : 0;
    for (const label of this.labels) {
      let show = label.visible;
      const mesh = label.mesh;
      const world = label.world;
      if (show && mesh) {
        const id = meshRuntime(mesh).id;
        if (runtime.meshes.get(id) !== mesh || (label.followVisibility && hiddenInTree(store, id))) show = false;
        else {
          const o = id * 16,
            [ox, oy, oz] = label.offset;
          if (label.offsetSpace === 'world') {
            world[0] = matrices[o + 12] + ox;
            world[1] = matrices[o + 13] + oy;
            world[2] = matrices[o + 14] + oz;
          } else {
            world[0] = matrices[o] * ox + matrices[o + 4] * oy + matrices[o + 8] * oz + matrices[o + 12];
            world[1] = matrices[o + 1] * ox + matrices[o + 5] * oy + matrices[o + 9] * oz + matrices[o + 13];
            world[2] = matrices[o + 2] * ox + matrices[o + 6] * oy + matrices[o + 10] * oz + matrices[o + 14];
          }
        }
      } else if (show) {
        const p = label.position,
          o = label.offset;
        world[0] = p[0] + o[0];
        world[1] = p[1] + o[1];
        world[2] = p[2] + o[2];
      }
      let screen: ScreenPoint | null = null;
      if (show) {
        screen = projectPoint(camera.matrix, world[0], world[1], world[2], width, height, backend, label.screen);
        if (!screen.inFront || (label.frustumCulling && !screen.inFrustum)) show = false;
      }
      if (show) {
        label.distance = Math.hypot(world[0] - ex, world[1] - ey, world[2] - ez);
        const hook = label.occlude ?? this.occlude;
        if (
          hook &&
          hook(label, {
            x: screen!.x,
            y: screen!.y,
            depth: screen!.depth,
            distance: label.distance,
            world: [world[0], world[1], world[2]],
          })
        )
          show = false;
      }
      label.onScreen = show;
      label.layoutHidden = false;
      label.layoutAnchor = null;
      if (!show) {
        this.set(label.element, label.cache, 'display', 'none');
        continue;
      }
      let factor = 1;
      if (label.distanceScale !== null) {
        const options =
          typeof label.distanceScale === 'number' ? { reference: label.distanceScale } : label.distanceScale;
        factor =
          Math.round(
            Math.min(
              options.max ?? Infinity,
              Math.max(options.min ?? 0, options.reference / Math.max(zoomDistance || label.distance, 1e-6)),
            ) * 1e4,
          ) / 1e4;
      }
      label.scale = factor;
      shown.push(label);
    }
    const layout = this.layout;
    if (layout) {
      const context = this.layoutContext;
      context.width = width;
      context.height = height;
      context.root = root;
      layout.arrange(shown, context);
    }
    for (const label of shown) {
      if (label.layoutHidden) {
        label.onScreen = false;
        this.set(label.element, label.cache, 'display', 'none');
        continue;
      }
      const anchor = label.layoutAnchor ?? label.anchor,
        key = label.placement,
        x = Math.round((label.screen.x + label.screenOffset[0]) * 100) / 100,
        y = Math.round((label.screen.y + label.screenOffset[1]) * 100) / 100,
        ax = anchor[0],
        ay = anchor[1],
        scaled = label.distanceScale !== null || label.scale !== 1 ? 1 : 0,
        factor = scaled ? label.scale : 0;
      label.placedAnchor[0] = ax;
      label.placedAnchor[1] = ay;
      // The transform text depends only on these numbers: format and compare it again only when one changed.
      if (key[0] !== x || key[1] !== y || key[2] !== scaled || key[3] !== factor || key[4] !== ax || key[5] !== ay) {
        key[0] = x;
        key[1] = y;
        key[2] = scaled;
        key[3] = factor;
        key[4] = ax;
        key[5] = ay;
        this.set(
          label.element,
          label.cache,
          'transform',
          `translate(${x}px,${y}px)${scaled ? ` scale(${factor})` : ''} translate(${-ax * 100}%,${-ay * 100}%)`,
        );
      }
      this.set(label.element, label.cache, 'display', '');
      if (label.sort) visible.push(label);
    }
    // Far labels first: nearer labels get higher z-index and draw on top.
    visible.sort((a, b) => b.distance - a.distance);
    for (let i = 0; i < visible.length; i++) this.set(visible[i].element, visible[i].cache, 'zIndex', String(i + 1));
    if (this.objects.size) this.update3D(camera, width, height, runtime, backend);
  }

  private update3D(
    camera: Camera,
    width: number,
    height: number,
    runtime: ReturnType<typeof engineRuntime>,
    backend: 'webgpu' | 'webgl2',
  ): void {
    const store = runtime.store,
      matrices = store.matrices;
    const viewer = this.viewer!,
      cameraElement = this.cameraElement!,
      orthographic = isOrthographic(camera.matrix);
    const perspective = cssPerspective(camera.fov, height);
    this.set(viewer, this.viewerCache, 'perspective', orthographic ? 'none' : px(perspective));
    this.set(cameraElement, this.cameraCache, 'width', px(width));
    this.set(cameraElement, this.cameraCache, 'height', px(height));
    const view = orthographic ? this.cssView : lookAtView(camera.position, camera.target, this.cssView, camera.up);
    this.set(
      cameraElement,
      this.cameraCache,
      'transform',
      orthographic
        ? orthographicCSSTransform(camera.matrix, width, height, backend)
        : cameraCSSTransform(view, perspective, width, height),
    );
    for (const object of this.objects) {
      let show = object.visible;
      const mesh = object.mesh,
        matrix = object.matrix;
      if (show && mesh) {
        const id = meshRuntime(mesh).id;
        if (runtime.meshes.get(id) !== mesh || (object.followVisibility && hiddenInTree(store, id))) show = false;
        else for (let i = 0; i < 16; i++) matrix[i] = matrices[id * 16 + i];
      } else if (show) matrix.set(object.ownMatrix);
      let clip = '';
      if (show) {
        // CSS perspective cannot clip at the near plane, so the renderer does: the signed distance in front of the
        // plane at the element's four corners (affine over the element) says whether it is whole, cut or gone.
        const [w, h] = this.measure(object),
          scale = object.pixelScale,
          depths = this.depths;
        let low = Infinity,
          high = -Infinity;
        for (let i = 0; i < 4; i++) {
          // Corners (0, 0), (w, 0), (w, h), (0, h) in element pixels, from the centre, CSS y down to world y up.
          const u = (i === 1 || i === 2 ? 0.5 : -0.5) * w * scale,
            v = (i >= 2 ? -0.5 : 0.5) * h * scale,
            px = matrix[0] * u + matrix[4] * v + matrix[12],
            py = matrix[1] * u + matrix[5] * v + matrix[13],
            pz = matrix[2] * u + matrix[6] * v + matrix[14];
          const depth = orthographic
            ? projectPoint(camera.matrix, px, py, pz, width, height, backend, this.point).depth
            : -(view[2] * px + view[6] * py + view[10] * pz + view[14]) - camera.near;
          depths[i] = depth;
          low = Math.min(low, depth);
          high = Math.max(high, depth);
        }
        if (!(high > 0)) show = false;
        else if (low < 0) clip = this.nearClip(w, h);
        object.distance = Math.hypot(
          matrix[12] - camera.position[0],
          matrix[13] - camera.position[1],
          matrix[14] - camera.position[2],
        );
      }
      if (show && object.occlude) {
        const point = projectPoint(
          camera.matrix,
          matrix[12],
          matrix[13],
          matrix[14],
          width,
          height,
          backend,
          this.point,
        );
        show = !object.occlude(object, {
          x: point.x,
          y: point.y,
          depth: point.depth,
          distance: object.distance,
          world: [matrix[12], matrix[13], matrix[14]],
        });
      }
      object.onScreen = show;
      object.clipped = show && clip !== '';
      if (!show) {
        this.set(object.element, object.cache, 'display', 'none');
        continue;
      }
      // Written only while cut, and once more to clear it.
      if (clip || object.cache.clipPath) this.set(object.element, object.cache, 'clipPath', clip);
      this.set(object.element, object.cache, 'transform', objectCSSTransform(matrix, object.pixelScale));
      this.set(object.element, object.cache, 'display', '');
    }
  }

  /** Removes the overlay root, every label and CSS 3D element, and detaches from the engine. */
  dispose(): void {
    const engine = this.engine;
    this.engine = null;
    if (engine && !engine.disposed && engine.hasPlugin?.(this.name)) engine.removePlugin(this.name);
    for (const item of [...this.labels, ...this.objects]) this.remove(item);
    this.root?.remove();
    this.root = null;
    this.viewer = null;
    this.cameraElement = null;
    for (const cache of [this.rootCache, this.viewerCache, this.cameraCache])
      for (const key of Object.keys(cache)) delete cache[key];
    this.engine = null;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private measure(item: Label | CSS3DObject): readonly [number, number] {
    if (item.measured) return item.measured;
    // A hidden element measures 0: show it for the reading. The update then writes its final display.
    this.set(item.element, item.cache, 'display', '');
    return (item.measured = [item.element.offsetWidth || 0, item.element.offsetHeight || 0]);
  }
  /**
   * The part of a `w` x `h` element in front of the near plane, as a CSS `polygon()` in element pixels: one-plane
   * Sutherland-Hodgman clipping of its corners by the signed distances in `depths` (corner order (0, 0), (w, 0),
   * (w, h), (0, h)).
   */
  private nearClip(w: number, h: number): string {
    const depths = this.depths;
    let text = '';
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) & 3,
        a = depths[i],
        b = depths[j],
        ax = i === 1 || i === 2 ? w : 0,
        ay = i >= 2 ? h : 0,
        bx = j === 1 || j === 2 ? w : 0,
        by = j >= 2 ? h : 0;
      if (a >= 0) text += `${text ? ',' : ''}${px(ax)} ${px(ay)}`;
      if (a >= 0 !== b >= 0) {
        const t = a / (a - b);
        text += `${text ? ',' : ''}${px(ax + (bx - ax) * t)} ${px(ay + (by - ay) * t)}`;
      }
    }
    return `polygon(${text})`;
  }
  private set(element: HTMLElement, cache: StyleCache, property: string, value: string): void {
    if (cache[property] === value) return;
    write(element, cache, property, value);
    this.writes++;
  }
  private syncRoot(canvas: HTMLCanvasElement, x: number, y: number, width: number, height: number): void {
    const root = this.root!;
    this.set(root, this.rootCache, 'width', px(width));
    this.set(root, this.rootCache, 'height', px(height));
    // Correct the root by the measured offset to the view's corner in the canvas content box, so any containing
    // block works. A CSS scale on an ancestor scales what getBoundingClientRect reports, not `left` and `top`, so the
    // offset is converted with the scale of the root's ancestors: its drawn width over the width it was given.
    const target = canvas.getBoundingClientRect(),
      current = root.getBoundingClientRect(),
      written = Number.parseFloat(this.rootCache.width);
    const outer = current.width > 0 && written > 0 ? current.width / (written * this.rootScale) : 1;
    // Beside the canvas the root shares its ancestors, so their scale is the canvas's. Elsewhere (a `parent` outside a
    // scaled element) the canvas's own is measured and the root is scaled by the difference, so a CSS pixel of the
    // labels is a CSS pixel of the canvas.
    const sibling = root.parentElement === canvas.parentElement,
      inner = !sibling && target.width > 0 && canvas.offsetWidth > 0 ? target.width / canvas.offsetWidth : outer,
      scale = sibling ? 1 : Math.round((inner / outer) * 1e6) / 1e6;
    const dx = (target.left + (canvas.clientLeft + x) * inner - current.left) / outer,
      dy = (target.top + (canvas.clientTop + y) * inner - current.top) / outer;
    if (Math.abs(dx) > 0.01) this.left += dx;
    if (Math.abs(dy) > 0.01) this.top += dy;
    this.set(root, this.rootCache, 'left', px(this.left));
    this.set(root, this.rootCache, 'top', px(this.top));
    this.rootScale = scale;
    if (scale !== 1 || this.rootCache.transform)
      this.set(root, this.rootCache, 'transform', scale === 1 ? '' : `scale(${scale})`);
  }
  private mount(item: Label | CSS3DObject): void {
    const root = this.root;
    if (!root) return;
    const element = item.element,
      style = element.style;
    style.position = 'absolute';
    style.left = '0px';
    style.top = '0px';
    if (item instanceof Label) {
      style.transformOrigin = '0 0';
      write(element, item.cache, 'display', 'none');
      root.appendChild(element);
      return;
    }
    if (!this.viewer) {
      const document = root.ownerDocument;
      const viewer = document.createElement('div'),
        camera = document.createElement('div');
      viewer.style.position = 'absolute';
      viewer.style.left = '0px';
      viewer.style.top = '0px';
      viewer.style.width = '100%';
      viewer.style.height = '100%';
      viewer.style.overflow = 'hidden';
      viewer.style.pointerEvents = 'none';
      camera.style.position = 'absolute';
      camera.style.left = '0px';
      camera.style.top = '0px';
      camera.style.transformStyle = 'preserve-3d';
      camera.style.pointerEvents = 'none';
      viewer.appendChild(camera);
      root.insertBefore(viewer, root.firstChild);
      this.viewer = viewer;
      this.cameraElement = camera;
    }
    write(element, item.cache, 'display', 'none');
    this.cameraElement!.appendChild(element);
  }
}
