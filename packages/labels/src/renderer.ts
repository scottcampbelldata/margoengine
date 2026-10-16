/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, EnginePlugin, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime, type FrameGraph } from '@margoengine/core/extension';
import {
  cameraCSSTransform,
  composeMatrix,
  createScreenPoint,
  cssPerspective,
  isOrthographic,
  lookAtView,
  objectCSSTransform,
  orthographicCSSTransform,
  projectPoint,
  type ScreenPoint,
  type Vec3,
} from './projection.js';

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
export type DistanceScale = number | { reference: number; min?: number; max?: number };

export interface LabelOptions {
  /** Mesh to follow. The anchor is the mesh origin plus `offset`. */
  mesh?: Mesh | null;
  /** World position when not following a mesh. */
  position?: Vec3;
  /** Offset from the mesh origin, in the mesh's local space (like a THREE child object) or world space. */
  offset?: Vec3;
  offsetSpace?: 'local' | 'world';
  /** Which point of the element sits on the anchor, as fractions of its size. Default [0.5, 0.5] (center). */
  anchor?: readonly [number, number];
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
  occlude?: OccludeHook;
  visible?: boolean;
}

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
  visible?: boolean;
}

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
}

type StyleCache = Record<string, string>;
const write = (element: HTMLElement, cache: StyleCache, property: string, value: string): void => {
  if (cache[property] === value) return;
  cache[property] = value;
  (element.style as unknown as Record<string, string>)[property] = value;
};
const px = (value: number): string => `${Math.round(value * 100) / 100}px`;
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
  get mesh(): Mesh | null {
    return this.meshValue;
  }
  /** Removes the element from the overlay and stops tracking it. */
  remove(): void {
    this.owner?.remove(this as unknown as Label | CSS3DObject);
  }
}

/** A 2D HTML label pinned to a projected world point (THREE.CSS2DObject counterpart). */
export class Label extends Item {
  anchor: [number, number];
  frustumCulling: boolean;
  distanceScale: DistanceScale | null;
  sort: boolean;
  occlude: OccludeHook | null;
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
    this.frustumCulling = options.frustumCulling ?? true;
    this.distanceScale = options.distanceScale ?? null;
    this.sort = options.sort ?? true;
    this.occlude = options.occlude ?? null;
    element.style.pointerEvents = options.pointerEvents ?? 'none';
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

/** An HTML element placed in world space with a CSS matrix3d transform (THREE.CSS3DObject counterpart). */
export class CSS3DObject extends Item {
  pixelScale: number;
  /** World matrix used at the last update (column-major). */
  readonly matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  private readonly own = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  constructor(owner: LabelRenderer, element: HTMLElement, options: CSS3DOptions) {
    super(owner, element, options.mesh, options.followVisibility, options.visible);
    this.pixelScale = options.pixelScale ?? 0.01;
    if (!Number.isFinite(this.pixelScale) || this.pixelScale <= 0) throw new RangeError('pixelScale must be > 0');
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
 * Engine plugin that keeps HTML labels and CSS 3D objects registered over the canvas every frame
 * (THREE.CSS2DRenderer plus CSS3DRenderer counterpart). DOM writes happen only when a value changes.
 */
export class LabelRenderer implements EnginePlugin {
  readonly name: string;
  /** Overlay root; created in setup, removed on dispose. */
  root: HTMLDivElement | null = null;
  occlude: OccludeHook | null;
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
  private readonly view = new Float64Array(16);
  private readonly point = createScreenPoint();
  private readonly visibleLabels: Label[] = [];
  private readonly world: [number, number, number] = [0, 0, 0];
  private left = 0;
  private top = 0;
  /** Number of style properties written during the last update (diagnostics and tests). */
  writes = 0;

  /** Same as `engine.use(new LabelRenderer(...))`; returns the LabelRenderer. */
  static attach(engine: EngineKernel, options?: LabelRendererOptions): LabelRenderer {
    const value = new LabelRenderer(options);
    engine.use(value);
    return value;
  }
  constructor(options: LabelRendererOptions = {}) {
    this.options = options;
    this.name = options.name ?? 'margoengine-labels';
    this.order = options.order ?? 1000;
    this.occlude = options.occlude ?? null;
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
    root.dataset.margoengineLabels = '';
    const parent = this.options.parent ?? canvas.parentElement ?? document.body;
    if (parent === canvas.parentElement) parent.insertBefore(root, canvas.nextSibling);
    else parent.appendChild(root);
    this.root = root;
    this.left = 0;
    this.top = 0;
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
      camera = engine.camera,
      backend = engine.backend;
    const width = canvas.clientWidth || canvas.width,
      height = canvas.clientHeight || canvas.height;
    const runtime = engineRuntime(engine),
      store = runtime.store,
      matrices = store.matrices;
    this.syncRoot(canvas, width, height);
    const visible = this.visibleLabels;
    visible.length = 0;
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
        if (runtime.meshes.get(id) !== mesh || (label.followVisibility && this.hidden(store, id))) show = false;
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
      if (!show) {
        this.set(label.element, label.cache, 'display', 'none');
        continue;
      }
      const key = label.placement,
        x = Math.round(screen!.x * 100) / 100,
        y = Math.round(screen!.y * 100) / 100,
        ax = label.anchor[0],
        ay = label.anchor[1];
      let scaled = 0,
        factor = 0;
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
        scaled = 1;
      }
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
    if (this.objects.size) this.update3D(width, height, runtime, backend);
  }

  private update3D(
    width: number,
    height: number,
    runtime: ReturnType<typeof engineRuntime>,
    backend: 'webgpu' | 'webgl2',
  ): void {
    const camera = runtime.camera,
      store = runtime.store,
      matrices = store.matrices;
    const viewer = this.viewer!,
      cameraElement = this.cameraElement!,
      orthographic = isOrthographic(camera.matrix);
    const perspective = cssPerspective(camera.fov, height);
    this.set(viewer, this.viewerCache, 'perspective', orthographic ? 'none' : px(perspective));
    this.set(cameraElement, this.cameraCache, 'width', px(width));
    this.set(cameraElement, this.cameraCache, 'height', px(height));
    const view = orthographic ? this.view : lookAtView(camera.position, camera.target, this.view, camera.up);
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
        if (runtime.meshes.get(id) !== mesh || (object.followVisibility && this.hidden(store, id))) show = false;
        else for (let i = 0; i < 16; i++) matrix[i] = matrices[id * 16 + i];
      } else if (show) matrix.set(object.ownMatrix);
      if (show) {
        // Hide objects whose origin is at or behind the near plane; CSS perspective cannot clip them.
        const viewZ = view[2] * matrix[12] + view[6] * matrix[13] + view[10] * matrix[14] + view[14];
        if (
          orthographic
            ? projectPoint(camera.matrix, matrix[12], matrix[13], matrix[14], width, height, backend, this.point)
                .depth < 0
            : -viewZ <= camera.near
        )
          show = false;
        object.distance = Math.hypot(
          matrix[12] - camera.position[0],
          matrix[13] - camera.position[1],
          matrix[14] - camera.position[2],
        );
      }
      object.onScreen = show;
      if (!show) {
        this.set(object.element, object.cache, 'display', 'none');
        continue;
      }
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

  private set(element: HTMLElement, cache: StyleCache, property: string, value: string): void {
    if (cache[property] === value) return;
    write(element, cache, property, value);
    this.writes++;
  }
  private hidden(store: { parents: ArrayLike<number>; hidden: ArrayLike<number> }, id: number): boolean {
    for (let current = id, depth = 0; current >= 0 && depth < 64; current = store.parents[current], depth++)
      if (store.hidden[current]) return true;
    return false;
  }
  private syncRoot(canvas: HTMLCanvasElement, width: number, height: number): void {
    const root = this.root!;
    // Correct the root by the measured offset to the canvas content box, so any containing block works.
    const target = canvas.getBoundingClientRect(),
      current = root.getBoundingClientRect();
    const dx = target.left + canvas.clientLeft - current.left,
      dy = target.top + canvas.clientTop - current.top;
    if (Math.abs(dx) > 0.01) this.left += dx;
    if (Math.abs(dy) > 0.01) this.top += dy;
    this.set(root, this.rootCache, 'left', px(this.left));
    this.set(root, this.rootCache, 'top', px(this.top));
    this.set(root, this.rootCache, 'width', px(width));
    this.set(root, this.rootCache, 'height', px(height));
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
