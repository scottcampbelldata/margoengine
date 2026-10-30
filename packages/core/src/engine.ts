import { TransformStore, syncStoredRotation } from './kernel.js';
import { Camera, type CameraOptions, type Vec3 } from './camera.js';
import { F32_OVERFLOW, Geometry, PbrMaterial, finite } from './geometry.js';
import { hypot } from '../../shared/hypot.js';
import {
  GPURenderer,
  validateRectangle,
  type Renderer,
  type Batch,
  type GeometryBuffers,
  type RenderView,
} from './renderer.js';
import { FrameGraph, type EnginePlugin } from './plugin.js';
import { sceneSamples } from './quality.js';
import { checkLayers, layerRegistry, meshLayers } from '../../shared/view-rect.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

const DISPOSED = 'Engine disposed',
  WEBGPU = 'WebGPU required';

/** `fallback` supplies a renderer when WebGPU is unavailable or `backend` is 'webgl2', for example `webglRenderer` from @margoengine/webgl. */
export interface EngineOptions {
  /** Initial mesh capacity, 1..8388608; the store doubles when full. Default 1024. */
  capacity?: number;
  /** Renderer choice. 'auto' tries WebGPU then `fallback`; 'webgpu' fails without WebGPU. Default 'auto'. */
  backend?: 'auto' | 'webgpu' | 'webgl2';
  /** Initial camera settings. */
  camera?: CameraOptions;
  /** Builds the non-WebGPU renderer. */
  fallback?: (canvas: HTMLCanvasElement) => Renderer;
  /** Extra WebGPU features to request when the adapter offers them, e.g. ['timestamp-query'] for Stats GPU timing. */
  features?: GPUFeatureName[];
  /**
   * Pixel-exact drawing for pixel art and pixel-perfect 2D: the backbuffer stays exactly `[width, height]` (or, with
   * `true`, the canvas's own `width` and `height` attributes), with no device-pixel-ratio scaling and no MSAA. Zoom by
   * an integer with CSS (`width: 4 * w px; image-rendering: pixelated`); `engine.pick` still takes CSS pixels. Set
   * `canvas.width`/`height` to resize. Default false: the backbuffer follows the CSS size times the pixel ratio.
   */
  exactSize?: boolean | readonly [number, number];
}
/** Called by the frame loop before each render with the seconds since the previous frame (0 on the first, at most 0.1). */
export type FrameCallback = (engine: Engine, delta: number) => void;
const positionFields = ['x', 'y', 'z'] as const,
  scaleFields = ['sx', 'sy', 'sz'] as const;
const owners = new WeakMap<EnginePlugin, Scene>();

/**
 * Live x/y/z view of a mesh's position (world units), rotation (Euler radians) or scale in the transform store. Writes
 * must be finite as float32, and scale components non-zero (RangeError otherwise); throws Error 'Mesh disposed' after disposal.
 */
export class VectorRef {
  constructor(
    private readonly mesh: Mesh,
    private readonly kind: 'position' | 'rotation' | 'scale',
  ) {}
  private get(axis: number): number {
    this.mesh.check();
    return this.kind === 'rotation'
      ? this.mesh.engine.store.rotations[this.mesh.id * 3 + axis]
      : this.mesh.engine.store.transforms[(this.kind === 'scale' ? scaleFields : positionFields)[axis]][this.mesh.id];
  }
  private validate(value: number): void {
    // Compares, not Math.fround: a setter runs per moving mesh each frame (F32_OVERFLOW in geometry.ts). Math.fround(v)
    // is 0 exactly when |v| <= 2 ** -150 (7.006492321624085e-46: halfway to the least float rounds to 0). No
    // Math.abs here: V8 13 Maglev calls it for a setter's argument and boxes the result.
    if (
      typeof value !== 'number' ||
      !(value < F32_OVERFLOW && value > -F32_OVERFLOW) ||
      (this.kind === 'scale' && !(value > 7.006492321624085e-46 || value < -7.006492321624085e-46))
    )
      throw rangeError('Invalid transform', 'transform');
  }
  private write(axis: number, value: number): void {
    this.mesh.check();
    this.validate(value);
    if (this.kind === 'rotation') {
      this.mesh.engine.store.rotations[this.mesh.id * 3 + axis] = value;
      this.mesh.syncRotation();
    } else
      this.mesh.engine.store.transforms[(this.kind === 'scale' ? scaleFields : positionFields)[axis]][this.mesh.id] =
        value;
  }
  set(x: number, y: number, z: number): this {
    this.mesh.check();
    this.validate(x);
    this.validate(y);
    this.validate(z);
    const fields = this.kind === 'scale' ? scaleFields : positionFields,
      t = this.mesh.engine.store.transforms,
      id = this.mesh.id;
    for (let axis = 0; axis < 3; axis++) {
      const value = axis === 0 ? x : axis === 1 ? y : z;
      if (this.kind === 'rotation') this.mesh.engine.store.rotations[id * 3 + axis] = value;
      else t[fields[axis]][id] = value;
    }
    if (this.kind === 'rotation') this.mesh.syncRotation();
    return this;
  }
  setAll(value: number): this {
    return this.set(value, value, value);
  }
  get x(): number {
    return this.get(0);
  }
  set x(v: number) {
    this.write(0, v);
  }
  get y(): number {
    return this.get(1);
  }
  set y(v: number) {
    this.write(1, v);
  }
  get z(): number {
    return this.get(2);
  }
  set z(v: number) {
    this.write(2, v);
  }
}

/** 1 when a mesh needs back faces drawn (double-sided or mirrored); batches without one draw with cullMode back. */
const keep = ({ matrix: m, material }: Mesh) =>
  +(
    material.data[6] > 0 ||
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]) < 0
  );
class EulerView {
  constructor(private readonly mesh: Mesh) {}
  private write(axis: number, value: number): void {
    this.mesh.engine.store.rotations[this.mesh.id * 3 + axis] = value;
    syncStoredRotation(this.mesh.engine.store, this.mesh.id);
  }
  private lane(axis: number): number {
    return this.mesh.engine.store.rotations[this.mesh.id * 3 + axis];
  }
  get 0(): number {
    return this.lane(0);
  }
  set 0(value: number) {
    this.write(0, value);
  }
  get 1(): number {
    return this.lane(1);
  }
  set 1(value: number) {
    this.write(1, value);
  }
  get 2(): number {
    return this.lane(2);
  }
  set 2(value: number) {
    this.write(2, value);
  }
  get length(): 3 {
    return 3;
  }
  get buffer(): ArrayBufferLike {
    return this.mesh.engine.store.rotations.buffer;
  }
  *[Symbol.iterator](): IterableIterator<number> {
    yield this[0];
    yield this[1];
    yield this[2];
  }
}
const eulerView = (mesh: Mesh) => new EulerView(mesh);
const views = (mesh: Mesh) =>
  Object.assign(mesh, {
    matrix: mesh.engine.store.matrices.subarray(mesh.id * 16, mesh.id * 16 + 16),
    euler: eulerView(mesh),
  });
/**
 * Runtime mesh: a slot `id` in its engine's transform store plus geometry and material. Create it with
 * `engine.createMesh` or `scene.createMesh`. Positions are world units relative to the parent, rotations Euler radians,
 * parents at most 64 deep and in the same scene.
 */
export class Mesh {
  /** `dispose()`, for `using` (set at the end of this file where the runtime has `Symbol.dispose`). */
  declare [Symbol.dispose]: () => void;
  name = '';
  /** @internal Ids of this mesh's children, so removing it unparents them without scanning every slot. */
  declare kids?: Set<number>;
  readonly position = new VectorRef(this, 'position');
  readonly rotation = new VectorRef(this, 'rotation');
  readonly scale = new VectorRef(this, 'scale');
  /**
   * Euler XYZ radians for this mesh. An index write updates the quaternion. `setQuaternion` writes the lanes after
   * the quaternion and leaves that quaternion in place. `createMesh` replaces this object when the store grows; a
   * kept view still reads the current lanes.
   */
  declare readonly euler: {
    0: number;
    1: number;
    2: number;
    readonly length: 3;
    readonly buffer: ArrayBufferLike;
    [Symbol.iterator](): IterableIterator<number>;
  };
  /** World matrix view into the store. `createMesh` replaces it when the store grows, so read it, never keep it. */
  declare readonly matrix: Float32Array;
  geometry: Geometry | null = null;
  private current = new PbrMaterial();
  get material(): PbrMaterial {
    return this.current;
  }
  /** Assigning a material makes the next frame re-collect instances. */
  set material(value: PbrMaterial) {
    this.current = value;
    this.engine.collected = -1;
  }
  private receives = true;
  /** Shadowed by shadow plugins (default true). Assigning re-collects instances next frame; false adds 0.25 to float 22. */
  get receiveShadow(): boolean {
    return this.receives;
  }
  set receiveShadow(value: boolean) {
    if (typeof value !== 'boolean') throw typeError('receiveShadow: boolean', 'arguments');
    this.receives = value;
    this.engine.collected = -1;
  }
  constructor(
    readonly engine: Engine,
    readonly id: number,
    /** The scene this mesh belongs to, fixed at creation. */
    readonly scene: Scene = engine.scene,
  ) {
    views(this);
  }
  get visible(): boolean {
    this.check();
    return this.engine.store.hidden[this.id] === 0;
  }
  set visible(value: boolean) {
    this.check();
    if (typeof value !== 'boolean') throw typeError('Visibility: boolean', 'arguments');
    this.engine.store.hidden[this.id] = +!value;
  }
  check(): void {
    if (this.engine.disposed || this.engine.meshes.get(this.id) !== this) throw fault('disposed', 'Mesh disposed');
  }
  setPosition(value: Vec3): this {
    this.check();
    finite(value, 3, 'Position');
    this.position.set(value[0], value[1], value[2]);
    return this;
  }
  setScale(value: Vec3): this {
    this.check();
    finite(value, 3, 'Scale');
    if (value.some((v) => Math.fround(v) === 0)) throw rangeError('Scale nonzero', 'transform');
    this.scale.set(value[0], value[1], value[2]);
    return this;
  }
  setRotation(value: Vec3): this {
    this.check();
    finite(value, 3, 'Rotation');
    this.rotation.set(value[0], value[1], value[2]);
    return this;
  }
  syncRotation(): void {
    syncStoredRotation(this.engine.store, this.id);
  }
  setQuaternion(value: readonly number[]): this {
    this.check();
    finite(value, 4, 'Quaternion');
    // No spread or map: physics and animation call this for every moving body each frame.
    const length = hypot(4, value[0], value[1], value[2], value[3]);
    if (!length) throw rangeError('Quaternion nonzero', 'transform');
    const x = value[0] / length,
      y = value[1] / length,
      z = value[2] / length,
      w = value[3] / length,
      t = this.engine.store.transforms,
      id = this.id;
    t.qx[id] = x;
    t.qy[id] = y;
    t.qz[id] = z;
    t.qw[id] = w;
    const lanes = this.engine.store.rotations,
      at = id * 3;
    // A clamp by compares, not Math.max and Math.min: V8 13 (Node 24) Maglev calls them, boxing their numbers. The
    // value is finite (a unit quaternion), so the compares give the same number, -0 included.
    const sinPitch = 2 * (x * z + w * y);
    lanes[at + 1] = Math.asin(sinPitch > 1 ? 1 : sinPitch < -1 ? -1 : sinPitch);
    lanes[at] = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y));
    lanes[at + 2] = Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z));
    return this;
  }
  setParent(parent: Mesh | null): this {
    this.check();
    parent?.check();
    if (parent && (parent.engine !== this.engine || parent.scene !== this.scene))
      throw typeError('Foreign parent', 'hierarchy');
    let depth = 0;
    for (let id = parent?.id ?? -1; id !== -1; id = this.engine.store.parents[id]) {
      if (id === this.id) throw typeError('Hierarchy cycle', 'hierarchy');
      if (++depth >= 64) throw rangeError('Parent depth: 64', 'hierarchy');
    }
    const parents = this.engine.store.parents;
    this.engine.meshes.get(parents[this.id])?.kids?.delete(this.id);
    if (parent) (parent.kids ??= new Set()).add(this.id);
    parents[this.id] = parent?.id ?? -1;
    return this;
  }
  setGeometry(geometry: Geometry | null): this {
    this.check();
    if (geometry !== null && !(geometry instanceof Geometry)) throw typeError('Invalid geometry', 'arguments');
    if (geometry === this.geometry) return this;
    if (geometry) this.engine.retain(geometry);
    const previous = this.geometry;
    this.geometry = geometry;
    const bounds = this.engine.store.bounds;
    bounds.fill(0, this.id * 4, this.id * 4 + 4);
    if (geometry) bounds.set(geometry.bounds, this.id * 4);
    if (previous) this.engine.release(previous);
    this.engine.collected = -1;
    return this;
  }
  setMaterial(material: PbrMaterial): this {
    this.check();
    if (!(material instanceof PbrMaterial)) throw typeError('Invalid material', 'arguments');
    this.material = material;
    return this;
  }
  dispose(): void {
    if (this.engine.meshes.get(this.id) === this) this.engine.remove(this);
  }
}

/**
 * Meshes, lighting and plugins drawn together. `engine.scene` is the default; make more with `engine.createScene()`
 * and draw one with a view's `scene`. While a scene is drawn or set up, `engine.lighting`, `frameGraph`, `plugins`,
 * `stats` and `createMesh` are that scene's, so packages work in any scene unchanged; otherwise they are the default
 * scene's.
 */
export class Scene {
  /** `dispose()`, for `using` (set at the end of this file where the runtime has `Symbol.dispose`). */
  declare [Symbol.dispose]: () => void;
  /** Clear colour (`#rrggbb`) for views of this scene, or null to keep the colour below (overlays). A view's `clear` wins. Default: core's clear colour. */
  background?: string | null;
  readonly frameGraph = new FrameGraph();
  readonly plugins: ReadonlyMap<string, EnginePlugin> = new Map();
  readonly meshes: ReadonlyMap<number, Mesh> = new Map();
  readonly stats = { visible: 0, drawCalls: 0 };
  readonly lighting = {
    direction: new Float32Array([3, 5, 4, 3]),
    // Sun strength 3 and ambient strength 0.15: Margo design choices.
    radiance: new Float32Array([1, 1, 1, 0.15]),
    ambient: new Float32Array([1, 1, 1]),
  };
  constructor(
    readonly engine: Engine,
    readonly name: string,
  ) {}
  /** A mesh in this scene; same as `engine.createMesh(parent)` while this scene is set up. */
  createMesh(parent: Mesh | null = null): Mesh {
    return this.engine.createMesh(parent, this);
  }
  /** Attaches a plugin to this scene; its passes draw in this scene's views only. */
  use(plugin: EnginePlugin): this {
    this.engine.use(plugin, this);
    return this;
  }
  /** Removes this scene's plugin and its passes, then disposes it. */
  removePlugin(name: string): void {
    this.engine.removePlugin(name, this);
  }
  /** Disposes this scene's plugins and meshes and removes the scene. The default scene lives as long as the engine. */
  dispose(): void {
    const engine = this.engine;
    if (this === engine.scene) throw typeError('Default scene: dispose the engine instead', 'scene');
    if (!engine.scenes.delete(this)) return;
    for (const name of this.plugins.keys()) engine.removePlugin(name, this);
    for (const mesh of this.meshes.values()) engine.remove(mesh);
  }
}

/**
 * Runtime engine behind the public `EngineKernel` surface, with extension access to the store, frame graph and
 * GPU device. Create it with `Engine.create(canvas, options)`; deltas are seconds, and `render` rejects a delta outside
 * [0, 1] with RangeError.
 */
export class Engine {
  /** `dispose()`, for `using` (set at the end of this file where the runtime has `Symbol.dispose`). */
  declare [Symbol.dispose]: () => void;
  /** The default scene. */
  readonly scene: Scene;
  /** @internal Every live scene of this engine, the default one first. */
  readonly scenes = new Set<Scene>();
  readonly meshes = new Map<number, Mesh>();
  readonly camera: Camera;
  disposed = false;
  onError: (error: unknown) => void = (error) => {
    if (typeof reportError === 'function') reportError(error);
    else console.error(error);
  };
  /** Return false to skip this display refresh (for example a 60 FPS cap on a 120 Hz screen); delta spans skipped refreshes. */
  pace?: (time: number) => boolean;
  /**
   * Longest step in seconds the frame loop (`start`) hands to callbacks and `render`; a longer gap (a slow frame, a
   * debugger pause) is clamped to it. Default 0.1. Keep it in (0, 1]: `render` rejects a delta above 1. The loop also
   * restarts its clock when the page becomes visible again, so the first frame after a background tab steps 0.
   */
  maxDelta = 0.1;
  /** Views the frame loop draws each frame instead of the full-canvas camera view; list `engine.camera` to keep it. */
  views?: readonly RenderView[];
  private readonly batches = new Map<Geometry, Batch & { references: number }>();
  /** The batches in insertion order, iterated by index every frame (a Map iterator would be garbage each time). */
  private readonly batchList: Batch[] = [];
  private readonly checkedMaterials = new WeakMap<PbrMaterial, number>();
  private materialFrame = 0;
  private readonly free: number[] = [];
  private next = 0;
  private revision = 0;
  // Last full collection: revision, scene, layers, visibility, material values, and each entity's instance offset
  // (-1 when not drawn).
  /** @internal Revision of the last full instance collection; -1 forces one. */ collected = -1;
  /** @internal Meshes with receiveShadow false at the last full collection; shadow plugins patch for them only then. */ unshadowed = 0;
  private collectedScene?: Scene;
  private collectedLayers = -1;
  private readonly materials: [PbrMaterial, ...number[]][] = [];
  private seen: Uint8Array;
  private slots: Int32Array;
  private readonly callbacks = new Set<FrameCallback>();
  private raf: number | null = null;
  private last = 0;
  private running = false;
  private rendering = false;
  private primaryCulling = true;
  private readonly frameOptions: { culling?: boolean; delta: number; views?: readonly RenderView[] } = { delta: 0 };
  private disposing = false;
  private recovery?: Promise<void>;
  /** The scene being drawn or set up; the default scene otherwise. */
  private active: Scene;
  /** Layer mask of the current draw; -1 draws every layer. */
  private layers = -1;
  /** Canvas views of the last `render({views})`, rectangles copied, for picking. */
  private drawn?: RenderView[];
  // The last pick in flight or waiting; later picks wait for it.
  private picking?: Promise<void>;
  /** Each scene's `claimed`/`redirect` state of a shared batch, swapped in when that scene draws. */
  private readonly claims = new WeakMap<Batch, Map<Scene, [boolean?, Batch['redirect']?]>>();
  /** @internal Features requested at creation, requested again when the device is restored. */ features?: GPUFeatureName[];
  /** @internal 1 for `exactSize` (no MSAA, no resize), else undefined (the quality tier's samples). */ exact?: 1;
  get frameGraph(): FrameGraph {
    return this.active.frameGraph;
  }
  get lighting(): Scene['lighting'] {
    return this.active.lighting;
  }
  get stats(): Scene['stats'] {
    return this.active.stats;
  }
  /** Attached plugins by name (read-only). */
  get plugins(): ReadonlyMap<string, EnginePlugin> {
    return this.active.plugins;
  }

  static async create(canvas: HTMLCanvasElement, options: EngineOptions = {}): Promise<Engine> {
    if (!canvas || typeof canvas.getContext !== 'function') throw typeError('Expected canvas', 'arguments');
    const backend = options.backend ?? 'auto';
    if (!['auto', 'webgpu', 'webgl2'].includes(backend)) throw typeError('Unknown backend', 'arguments');
    const size = options.exactSize,
      exact = size ? 1 : undefined;
    if (Array.isArray(size)) {
      if (size.length !== 2 || !size.every((v) => Number.isInteger(v) && v > 0 && v <= 8192))
        throw rangeError('Invalid exactSize', 'pixel-exact');
      [canvas.width, canvas.height] = size;
    }
    const store = await TransformStore.create(options.capacity ?? 1024);
    let renderer: Renderer | undefined,
      fallbackReason: string | null = null;
    try {
      if (backend !== 'webgl2')
        try {
          renderer = await GPURenderer.create(canvas, options.features, exact);
        } catch (error) {
          if (backend === 'webgpu') throw error;
          fallbackReason = String(error);
        }
      renderer ??= (
        options.fallback ??
        (() => {
          throw fault(
            'unsupported',
            backend === 'webgl2' ? 'webgl2 needs fallback: webglRenderer' : 'WebGPU unavailable',
            'webgpu',
          );
        })
      )(canvas);
      const engine = new Engine(canvas, store, renderer, options.camera, fallbackReason);
      engine.features = options.features;
      engine.exact = exact;
      return engine;
    } catch (error) {
      renderer?.dispose();
      store.dispose();
      throw error;
    }
  }
  private constructor(
    readonly canvas: HTMLCanvasElement,
    readonly store: TransformStore,
    private renderer: Renderer,
    camera: CameraOptions | undefined,
    readonly fallbackReason: string | null,
  ) {
    this.camera = new Camera(camera);
    this.scenes.add((this.scene = this.active = new Scene(this, 'default')));
    this.seen = new Uint8Array(store.capacity);
    this.slots = new Int32Array(store.capacity);
    this.watchDevice();
  }
  private watchDevice(): void {
    this.renderer.onLost = () => {
      if (!this.disposed && !this.disposing) void this.rebootDevice().catch((error) => this.onError(error));
    };
  }
  rebootDevice(): Promise<void> {
    if (this.disposed || this.disposing) return Promise.reject(fault('disposed', DISPOSED));
    if (this.backend !== 'webgpu') return Promise.reject(fault('unsupported', WEBGPU, 'webgpu'));
    if (this.recovery) return this.recovery;
    this.recovery = (async () => {
      const previous = this.renderer,
        next = await GPURenderer.create(this.canvas, this.features, this.exact);
      if (this.disposed || this.disposing) {
        next.dispose();
        return;
      }
      try {
        for (const batch of this.batches.values()) next.add(batch.geometry, batch.instances.length / 24);
      } catch (error) {
        next.dispose(false);
        throw error;
      }
      this.renderer = next;
      this.watchDevice();
      previous.dispose(false);
      for (const scene of this.scenes) {
        const outer = this.enter(scene);
        try {
          for (const plugin of scene.plugins.values()) plugin.onDeviceRestored?.(this);
        } finally {
          this.enter(outer);
        }
      }
    })().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }
  get backend(): 'webgpu' | 'webgl2' {
    return this.renderer.backend;
  }
  get gpu(): GPUDevice | null {
    return this.renderer.gpu ?? null;
  }
  geometryBuffers(geometry: Geometry): GeometryBuffers | null {
    if (this.disposed || this.disposing || this.recovery)
      throw fault('state', 'Geometry unavailable', 'device-restore');
    return this.renderer.geometryBuffers?.(geometry) ?? null;
  }
  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }
  /** Makes `scene` the active one and swaps in its batch claims; returns the previous active scene. */
  private enter(scene: Scene): Scene {
    const from = this.active;
    if (from !== scene) {
      for (const batch of this.batches.values()) {
        let states = this.claims.get(batch);
        if (!states) this.claims.set(batch, (states = new Map()));
        states.set(from, [batch.claimed, batch.redirect]);
        [batch.claimed, batch.redirect] = states.get(scene) ?? [];
      }
      this.active = scene;
    }
    return from;
  }
  private live(): void {
    if (this.disposed || this.disposing) throw fault('disposed', DISPOSED);
  }
  private checkScene(scene: Scene): void {
    if (!this.scenes.has(scene)) throw typeError('Unknown scene: use engine.createScene()', 'scene');
  }
  use(plugin: EnginePlugin, scene: Scene = this.active): this {
    this.live();
    this.checkScene(scene);
    const name = plugin.name,
      plugins = scene.plugins as Map<string, EnginePlugin>;
    if (!name || plugins.has(name) || owners.has(plugin) || typeof plugin.setup !== 'function')
      throw typeError('Invalid plugin', 'arguments');
    const outer = this.enter(scene);
    try {
      // withOwner throws during a frame before anything changes. Registered before setup, so `sceneOf` works in it.
      scene.frameGraph.withOwner(name, () => {
        plugins.set(name, plugin);
        owners.set(plugin, scene);
        try {
          plugin.setup(this);
          plugin.registerPasses?.(scene.frameGraph);
        } catch (error) {
          scene.frameGraph.removeOwner(name);
          plugins.delete(name);
          owners.delete(plugin);
          try {
            plugin.dispose?.();
          } catch {}
          throw error;
        }
      });
    } finally {
      this.enter(outer);
    }
    return this;
  }
  removePlugin(name: string, scene: Scene = this.active): void {
    const plugin = scene.plugins.get(name);
    if (!plugin) return;
    scene.frameGraph.removeOwner(name);
    (scene.plugins as Map<string, EnginePlugin>).delete(name);
    owners.delete(plugin);
    const outer = this.enter(scene);
    try {
      plugin.dispose?.();
    } finally {
      this.enter(outer);
    }
  }
  /** A new scene with its own meshes, lighting and plugins. Draw it with a view's `scene`. */
  createScene(name = 'scene'): Scene {
    this.live();
    const scene = new Scene(this, name);
    this.scenes.add(scene);
    return scene;
  }
  /** The scene `plugin` is attached to, or undefined when it is not attached to this engine. */
  sceneOf(plugin: EnginePlugin): Scene | undefined {
    const scene = owners.get(plugin);
    return scene?.engine === this ? scene : undefined;
  }
  createMesh(parent: Mesh | null = null, scene: Scene = this.active): Mesh {
    this.live();
    this.checkScene(scene);
    parent?.check();
    if (parent && (parent.engine !== this || parent.scene !== scene)) throw typeError('Foreign parent', 'hierarchy');
    const id = this.free.pop() ?? this.next++;
    // Double the store when full (seen and slots are rebuilt by the full collection the new mesh forces).
    if (id >= this.store.capacity)
      try {
        const size = Math.min(id * 2, 1 << 23);
        this.seen = new Uint8Array(size);
        this.slots = new Int32Array(size);
        this.store.grow(size);
        this.meshes.forEach(views);
      } catch (error) {
        this.next = id;
        throw error;
      }
    const t = this.store.transforms;
    for (const key of ['x', 'y', 'z', 'qx', 'qy', 'qz'] as const) t[key][id] = 0;
    for (const key of ['qw', 'sx', 'sy', 'sz'] as const) t[key][id] = 1;
    this.store.parents[id] = -1;
    this.store.constrained[id] = 0;
    this.store.hidden[id] = 0;
    this.store.rotations.fill(0, id * 3, id * 3 + 3);
    const mesh = new Mesh(this, id, scene);
    this.meshes.set(id, mesh);
    (scene.meshes as Map<number, Mesh>).set(id, mesh);
    this.revision++;
    this.store.active[id] = 1;
    try {
      return mesh.setParent(parent);
    } catch (error) {
      mesh.dispose();
      throw error;
    }
  }
  remove(mesh: Mesh): void {
    // Detach the children and leave the parent's child set (free slots are reset on reuse); skipped when the engine goes.
    const parents = this.store.parents;
    mesh.check();
    if (!this.disposing) {
      for (const id of mesh.kids ?? []) parents[id] = -1;
      mesh.setParent(null);
    }
    if (mesh.geometry) this.release(mesh.geometry);
    this.meshes.delete(mesh.id);
    (mesh.scene.meshes as Map<number, Mesh>).delete(mesh.id);
    this.revision++;
    this.store.active[mesh.id] = 0;
    this.store.visible[mesh.id] = 0;
    this.free.push(mesh.id);
  }
  retain(geometry: Geometry): void {
    let batch = this.batches.get(geometry);
    if (!batch) {
      this.batches.set(geometry, (batch = { geometry, instances: new Float32Array(), count: 0, references: 0 }));
      this.batchList.push(batch);
    }
    // Size instance storage to the meshes using this geometry, doubling as it grows, not to the engine capacity.
    if (batch.references++ >= batch.instances.length / 24) {
      const size = batch.references * 2;
      batch.instances = new Float32Array(size * 24);
      if (!this.recovery) {
        this.renderer.remove(geometry);
        this.renderer.add(geometry, size);
      }
    }
  }
  release(geometry: Geometry): void {
    const batch = this.batches.get(geometry)!;
    if (--batch.references === 0) {
      this.renderer.remove(geometry);
      this.batches.delete(geometry);
      this.batchList.splice(this.batchList.indexOf(batch), 1);
    }
  }
  private readonly collect = (mesh: Mesh): void => {
    if (this.layers !== -1 && !(meshLayers(mesh) & this.layers)) return;
    const unshadowed = !mesh.receiveShadow;
    this.unshadowed += +unshadowed;
    if (mesh.geometry && this.store.visible[mesh.id]) {
      if (this.checkedMaterials.get(mesh.material) !== this.materialFrame) {
        const material = mesh.material.data;
        finite(material, 8, 'Material');
        for (let i = 0; i < 8; i++)
          if (material[i] < 0 || material[i] > 1) throw rangeError('Invalid material', 'material');
        // 0.045: minimum perceptual roughness, Filament design document (published engine standard).
        if (material[3] !== 1 || material[4] < Math.fround(0.045) || (material[6] !== 0 && material[6] !== 1))
          throw rangeError('Invalid material', 'material');
        this.checkedMaterials.set(mesh.material, this.materialFrame);
        this.materials.push([mesh.material, ...material]);
      }
      const batch = this.batches.get(mesh.geometry)!,
        offset = batch.count++ * 24;
      batch.mask! |= keep(mesh);
      this.slots[mesh.id] = offset;
      batch.instances.set(mesh.matrix, offset);
      batch.instances.set(mesh.material.data, offset + 16);
      // doubleSided (0 or 1) + 0.25: every `< 0.5` single-sided test keeps its meaning.
      if (unshadowed) batch.instances[offset + 22] += 0.25;
      batch.instances[offset + 23] = mesh.id;
      this.stats.visible++;
    }
  };
  /**
   * Draws one frame. Without `views`: the full canvas through `camera` (default the engine camera), restoring the
   * primary view before returning. With `views`: each view in order (see {@link RenderView}); plugins update once
   * per scene and each camera advances once.
   */
  render({
    camera = this.camera,
    culling = true,
    delta = 0,
    views,
  }: {
    camera?: Camera;
    culling?: boolean;
    delta?: number;
    views?: readonly RenderView[];
  } = {}): void {
    if (this.rendering) throw fault('state', 'Render recursion', 'reentrancy');
    if (views) return this.renderViews(views, culling, delta);
    if (!(camera instanceof Camera)) throw typeError('Invalid camera', 'arguments');
    this.rendering = true;
    this.drawn = undefined;
    let failed = false;
    try {
      this.update(culling, delta, camera);
      const background = this.active.background,
        { width, height } = this.canvas;
      if (!this.recovery)
        this.renderer.render(
          camera,
          this.lighting,
          this.batchList,
          this.frameGraph,
          delta,
          // A background or a camera layer mask is passed as a full-canvas view, so passes see it.
          background === undefined && this.layers === -1
            ? undefined
            : {
                rect: [0, 0, width, height],
                index: 0,
                count: 1,
                id: '0',
                clear: background === undefined ? undefined : { color: background ?? false },
                layers: this.layers === -1 ? undefined : this.layers,
              },
        );
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        if (camera !== this.camera && !this.disposed && !this.disposing) {
          this.camera.update(this.canvas.width / this.canvas.height, this.backend === 'webgpu');
          this.store.planes.set(this.camera.planes);
          this.store.tick(this.primaryCulling);
          this.layers = this.cameraLayers(this.camera);
          this.collectInstances();
        }
      } catch (error) {
        if (!failed) throw error;
      } finally {
        this.rendering = false;
      }
    }
  }
  private renderViews(views: readonly RenderView[], culling: boolean, delta: number): void {
    if (!Array.isArray(views) || !views.length) throw typeError('Invalid views', 'views');
    this.rendering = true;
    const cameras = new Set<Camera>(),
      scenes = new Set<Scene>(),
      drawn: RenderView[] = [],
      // Views stack per destination (the canvas, or one target texture) and draw grouped by it, in order of first
      // appearance and caller order within: counts, then positions so far.
      destination = (view?: RenderView) => view?.target?.color ?? this.canvas,
      counts = new Map<object, number>(),
      stacked = new Map<object, number>();
    for (const view of views) counts.set(destination(view), (counts.get(destination(view)) ?? 0) + 1);
    const groups = [...counts.keys()],
      order = views
        .map((_, index) => index)
        .sort((a, b) => groups.indexOf(destination(views[a])) - groups.indexOf(destination(views[b])));
    try {
      this.resize();
      order.forEach((index) => {
        const entry = views[index];
        if (!(entry?.camera instanceof Camera) || !entry.viewport)
          throw typeError('Invalid view: pass {camera, viewport}', 'views');
        // Copy the rectangles: picking uses them after the caller may have changed this view.
        const view: RenderView = {
            ...entry,
            viewport: [...entry.viewport],
            scissor: entry.scissor && [...entry.scissor],
          },
          scene = (view.scene ?? this.scene) as Scene,
          target = view.target?.color,
          size = target ? [target.width, target.height] : [this.canvas.width, this.canvas.height],
          rect = this.viewPixels(view.viewport, view.pixels, size),
          prepare = !scenes.has(scene);
        this.checkScene(scene);
        this.enter(scene);
        this.update(culling, cameras.has(view.camera) ? 0 : delta, view.camera, rect, prepare, delta, view.layers);
        cameras.add(view.camera);
        scenes.add(scene);
        if (!this.recovery)
          this.renderer.render(view.camera, this.lighting, this.batchList, this.frameGraph, prepare ? delta : 0, {
            rect,
            scissor: view.scissor && this.viewPixels(view.scissor, view.pixels, size),
            layers: this.layers === -1 ? undefined : this.layers,
            index: stacked.get(destination(view)) ?? 0,
            count: counts.get(destination(view))!,
            id: view.id ?? String(index),
            clear: view.clear ?? (scene.background === undefined ? undefined : { color: scene.background ?? false }),
            target: view.target,
          });
        stacked.set(destination(view), (stacked.get(destination(view)) ?? 0) + 1);
        if (!target) drawn.push(view);
      });
    } finally {
      this.rendering = false;
      this.drawn = drawn;
      this.enter(this.scene);
    }
  }
  /** A view rectangle in pixels of `size`: fractions of it, or pixels when `pixels` is set. `trusted` skips the bounds check. */
  private viewPixels(
    viewport: readonly number[],
    pixels: boolean | undefined,
    [width, height]: readonly number[],
    trusted?: boolean,
  ): [number, number, number, number] {
    const rect = (
      pixels
        ? [...viewport]
        : [
            Math.round(viewport[0] * width),
            Math.round(viewport[1] * height),
            Math.round((viewport[0] + viewport[2]) * width) - Math.round(viewport[0] * width),
            Math.round((viewport[1] + viewport[3]) * height) - Math.round(viewport[1] * height),
          ]
    ) as [number, number, number, number];
    if (!trusted) validateRectangle(rect, width, height);
    return rect;
  }
  /**
   * Plugin updates (`prepare`), camera, kernel tick and instance collection for one draw. `rect` sets the camera aspect
   * and skips the canvas resize; `layers` defaults to the camera's mask from @margoengine/cameras/layers.
   */
  private update(
    culling: boolean,
    delta: number,
    camera = this.camera,
    rect?: readonly number[],
    prepare = true,
    frameDelta = delta,
    layers?: number,
  ): void {
    this.live();
    if (!Number.isFinite(frameDelta) || frameDelta < 0 || frameDelta > 1)
      throw rangeError('Invalid delta', 'arguments');
    this.delta = frameDelta;
    if (prepare) this.plugins.forEach(this.preUpdate);
    if (!rect) this.resize();
    camera.advance(delta);
    camera.update(rect ? rect[2] / rect[3] : this.canvas.width / this.canvas.height, this.backend === 'webgpu');
    this.layers = this.cameraLayers(camera, layers);
    this.store.planes.set(camera.planes);
    this.store.tick(culling);
    const { direction, radiance, ambient } = this.lighting;
    finite(direction, 4, 'Light');
    finite(radiance, 4, 'Radiance');
    if (ambient !== undefined) finite(ambient, 3, 'Ambient');
    // Loops, not some() with a closure: this runs every frame. Finite values have no length only when all are 0.
    let invalid = !(direction[0] || direction[1] || direction[2]) || direction[3] < 0;
    for (let i = 0; i < 4; i++) invalid ||= radiance[i] < 0 || (i < 3 && !!ambient && ambient[i] < 0);
    if (invalid) throw rangeError('Invalid lighting', 'lighting');
    this.collectInstances();
    if (camera === this.camera) this.primaryCulling = culling;
  }
  /** A view's layer mask: `layers`, else the camera's from @margoengine/cameras/layers, else -1 (every layer). */
  private cameraLayers(camera: Camera, layers?: number): number {
    return (
      (layers === undefined ? (layerRegistry()?.cameras.get(camera) ?? -1) : checkLayers(layers, 'View layers')) | 0
    );
  }
  private resize(): void {
    if (this.exact) return; // exactSize: the caller owns canvas.width and canvas.height
    // Avoid multiplying desktop 4x MSAA by another 4x in HiDPI backing pixels; the light tier caps DPR at margoLow.
    const dpr = Math.min(globalThis.devicePixelRatio ?? 1, globalThis.margoLow || 2, 4 / sceneSamples()),
      width = Math.max(1, Math.min(4096, Math.round(this.canvas.clientWidth * dpr) || this.canvas.width)),
      height = Math.max(1, Math.min(4096, Math.round(this.canvas.clientHeight * dpr) || this.canvas.height));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }
  private collectInstances(): void {
    // Reuse the last collection unless the mesh set, scene, layers, visibility or a material changed (or masks come
    // from a source that can change at any time); then patch moved matrices only.
    const { visible, changed } = this.store,
      seen = this.seen,
      scene = this.active,
      layers = this.layers;
    let full =
      this.collected !== this.revision ||
      this.collectedScene !== scene ||
      this.collectedLayers !== layers ||
      (layers !== -1 && !!layerRegistry()?.source);
    for (let id = 0; !full && id < this.next; id++) full = visible[id] !== seen[id];
    for (let m = 0; !full && m < this.materials.length; m++)
      for (let i = 0, values = this.materials[m]; !full && i < 8; i++) full = values[0].data[i] !== values[i + 1];
    if (full) {
      for (const batch of this.batchList) batch.count = batch.mask = 0;
      this.stats.visible = this.unshadowed = 0;
      this.materialFrame++;
      this.materials.length = 0;
      this.slots.fill(-1);
      scene.meshes.forEach(this.collect);
      this.collected = this.revision;
      this.collectedScene = scene;
      this.collectedLayers = layers;
      seen.set(visible);
      changed.fill(0);
      for (const batch of this.batchList) {
        batch.start = 0;
        batch.end = batch.count * 24;
      }
    } else
      for (let id = changed.indexOf(1); id >= 0; id = changed.indexOf(1, id + 1)) {
        changed[id] = 0;
        const offset = this.slots[id];
        if (offset >= 0) {
          const mesh = this.meshes.get(id)!,
            batch = this.batches.get(mesh.geometry!)!;
          batch.instances.set(mesh.matrix, offset);
          batch.mask! |= keep(mesh);
          // Whole numbers, so compares match Math.min and Math.max (V8 13 Maglev boxes their numbers per moved mesh).
          if (offset < batch.start!) batch.start = offset;
          if (offset + 16 > batch.end!) batch.end = offset + 16;
        }
      }
    // Every frame, with the renderer's own test: a package can claim or release a batch without a new collection.
    this.stats.drawCalls = 0;
    for (let i = 0; i < this.batchList.length; i++)
      if ((this.batchList[i].count || this.batchList[i].redirect) && !this.batchList[i].claimed) this.stats.drawCalls++;
  }
  /**
   * The mesh under CSS pixel (x, y), or null. With `view`, picks through that view (null outside its rectangle);
   * without, through the canvas view under the point when the last frame drew views, else the engine camera.
   * One readback runs at a time; overlapping calls wait and are answered in order, each for its own point and view,
   * reading the scene as it is when its turn comes (EngineKernel.pick).
   */
  pick(x: number, y: number, view?: RenderView): Promise<Mesh | null> {
    const copy = view && { ...view },
      run = this.picking
        ? this.picking.then(() => (this.disposed || this.disposing ? null : this.pickNow(x, y, copy)))
        : this.pickNow(x, y, copy),
      // Settles before the caller's own continuation, so a pick made once this one resolves starts at once.
      done = () => {
        if (this.picking === tail) this.picking = undefined;
      },
      tail: Promise<void> = run.then(done, done);
    this.picking = tail;
    return run;
  }
  private async pickNow(x: number, y: number, view?: RenderView): Promise<Mesh | null> {
    if (![x, y].every(Number.isFinite)) throw rangeError('Invalid pick', 'views');
    this.live();
    if (this.backend !== 'webgpu') throw fault('unsupported', WEBGPU, 'webgpu');
    const w = this.canvas.clientWidth || this.canvas.width,
      h = this.canvas.clientHeight || this.canvas.height;
    if (x < 0 || y < 0 || x >= w || y >= h || this.recovery) return null;
    this.resize();
    const renderer = this.renderer as GPURenderer,
      revision = this.revision,
      size = [this.canvas.width, this.canvas.height],
      px = (x * size[0]) / w,
      py = (y * size[1]) / h,
      inside = (r?: readonly number[]) => !r || (px >= r[0] && py >= r[1] && px < r[0] + r[2] && py < r[1] + r[3]),
      resolve = (v: RenderView, trusted?: boolean): RenderView & { pixels: true } => ({
        ...v,
        viewport: this.viewPixels(v.viewport, v.pixels, size, trusted),
        scissor: v.scissor && this.viewPixels(v.scissor, v.pixels, size, trusted),
        pixels: true,
      });
    let chosen = view && resolve(view);
    if (!view && this.drawn) {
      for (const candidate of this.drawn) {
        const current = resolve(candidate, true);
        if (inside(current.viewport) && inside(current.scissor)) chosen = current;
      }
      if (!chosen) return null;
    }
    if (chosen && !(inside(chosen.viewport) && inside(chosen.scissor))) return null;
    const scene = (chosen?.scene ?? this.scene) as Scene,
      camera = chosen?.camera ?? this.camera,
      rect = chosen?.viewport;
    this.checkScene(scene);
    if (!(camera instanceof Camera)) throw typeError('Invalid camera', 'arguments');
    const outer = this.enter(scene);
    let pending: Promise<Mesh | null>;
    try {
      this.update(true, 0, camera, rect, true, 0, chosen?.layers);
      if (chosen) chosen.layers = this.layers === -1 ? undefined : this.layers;
      const picker = [...this.plugins.values()].find((plugin) => plugin.onPick);
      pending = picker
        ? picker.onPick!(x, y, chosen)
        : renderer
            .pick(
              camera,
              this.lighting,
              this.batchList,
              this.frameGraph,
              px - (rect?.[0] ?? 0),
              py - (rect?.[1] ?? 0),
              rect && [rect[2], rect[3]],
            )
            .then((id) => this.meshes.get(id ?? -1) ?? null);
    } finally {
      this.enter(outer);
    }
    const layers = this.layers,
      mesh = await pending;
    return this.renderer === renderer &&
      this.revision === revision &&
      (!mesh || (mesh.scene === scene && (layers === -1 || meshLayers(mesh) & layers)))
      ? mesh
      : null;
  }
  onFrame(callback: FrameCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }
  start({ culling }: { culling?: boolean } = {}): void {
    this.live();
    this.frameOptions.culling = culling;
    if (this.running) return;
    this.running = true;
    this.last = 0;
    globalThis.document?.addEventListener('visibilitychange', this.wake);
    this.raf = requestAnimationFrame(this.frame);
  }
  // A page coming back from a background tab restarts the clock: its first frame steps 0, not the time away.
  private readonly wake = (): void => {
    this.last = 0;
  };
  // Persistent functions for forEach: a for...of over a Set or Map makes an iterator every frame.
  private delta = 0;
  private readonly preUpdate = (plugin: EnginePlugin): void => plugin.onPreUpdate?.(this.delta);
  private readonly call = (callback: FrameCallback): void => callback(this, this.frameOptions.delta);
  private readonly frame = (time: number): void => {
    this.raf = null;
    if (this.disposed || !this.running) return;
    if (this.pace && !this.pace(time)) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    // Math.min by compares (V8 13 Maglev boxes Math.min's numbers), NaN on either side included. step is never -0.
    const step = (time - this.last) / 1000,
      most = this.maxDelta,
      delta = this.last ? (step < most || step !== step ? step : most) : 0;
    this.last = time;
    try {
      this.frameOptions.delta = delta;
      this.callbacks.forEach(this.call);
      this.frameOptions.views = this.views?.length ? this.views : undefined;
      if (!this.disposed) this.render(this.frameOptions);
    } catch (error) {
      this.stop();
      this.onError(error);
      return;
    }
    if (!this.disposed && this.running) this.raf = requestAnimationFrame(this.frame);
  };
  stop(): void {
    this.running = false;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.last = 0;
    globalThis.document?.removeEventListener('visibilitychange', this.wake);
  }
  dispose(): void {
    if (this.disposed || this.disposing) return;
    this.disposing = true;
    this.stop();
    let failed = false,
      failure: unknown;
    const cleanup = (run: () => void) => {
      try {
        run();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    };
    for (const scene of this.scenes)
      for (const name of scene.plugins.keys()) cleanup(() => this.removePlugin(name, scene));
    for (const mesh of this.meshes.values()) cleanup(() => mesh.dispose());
    this.callbacks.clear();
    cleanup(() => this.renderer.dispose());
    cleanup(() => this.store.dispose());
    this.disposed = true;
    if (failed) throw failure;
  }
}
// `using`: Symbol.dispose is dispose(), on runtimes that have the symbol (others keep plain dispose()).
if (Symbol.dispose)
  for (const type of [Engine, Mesh, Scene])
    (type.prototype as { [Symbol.dispose]?: () => void })[Symbol.dispose] = type.prototype.dispose;
