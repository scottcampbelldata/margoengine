import { TransformStore, syncStoredRotation } from './kernel.js';
import { Camera, type CameraOptions, type Vec3 } from './camera.js';
import { Geometry, PbrMaterial, finite } from './geometry.js';
import { GPURenderer, type Renderer, type Batch, type GeometryBuffers } from './renderer.js';
import { FrameGraph, type EnginePlugin } from './plugin.js';
import { sceneSamples } from './quality.js';

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
}
/** Called by the frame loop before each render with the seconds since the previous frame (0 on the first, at most 0.1). */
export type FrameCallback = (engine: Engine, delta: number) => void;
const positionFields = ['x', 'y', 'z'] as const,
  scaleFields = ['sx', 'sy', 'sz'] as const;
const owners = new WeakMap<EnginePlugin, Engine>();

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
    if (
      typeof value !== 'number' ||
      !Number.isFinite(Math.fround(value)) ||
      (this.kind === 'scale' && Math.fround(value) === 0)
    )
      throw new RangeError('Invalid transform');
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
 * `engine.createMesh`. Positions are world units relative to the parent, rotations Euler radians, parents at most 64 deep.
 */
export class Mesh {
  name = '';
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
  constructor(
    readonly engine: Engine,
    readonly id: number,
  ) {
    views(this);
  }
  get visible(): boolean {
    this.check();
    return this.engine.store.hidden[this.id] === 0;
  }
  set visible(value: boolean) {
    this.check();
    if (typeof value !== 'boolean') throw new TypeError('Invalid Visibility');
    this.engine.store.hidden[this.id] = +!value;
  }
  check(): void {
    if (this.engine.disposed || this.engine.meshes.get(this.id) !== this) throw new Error('Mesh disposed');
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
    if (value.some((v) => Math.fround(v) === 0)) throw new RangeError('Scale nonzero');
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
    const length = Math.hypot(...value);
    if (!length) throw new RangeError('Quaternion nonzero');
    const [x, y, z, w] = value.map((v) => v / length),
      t = this.engine.store.transforms,
      id = this.id;
    t.qx[id] = x;
    t.qy[id] = y;
    t.qz[id] = z;
    t.qw[id] = w;
    const lanes = this.engine.store.rotations,
      at = id * 3;
    lanes[at + 1] = Math.asin(Math.max(-1, Math.min(1, 2 * (x * z + w * y))));
    lanes[at] = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y));
    lanes[at + 2] = Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z));
    return this;
  }
  setParent(parent: Mesh | null): this {
    this.check();
    parent?.check();
    if (parent && parent.engine !== this.engine) throw new TypeError('Foreign parent');
    let depth = 0;
    for (let id = parent?.id ?? -1; id !== -1; id = this.engine.store.parents[id]) {
      if (id === this.id) throw new Error('Hierarchy cycle');
      if (++depth >= 64) throw new RangeError('Parent depth: 64');
    }
    this.engine.store.parents[this.id] = parent?.id ?? -1;
    return this;
  }
  setGeometry(geometry: Geometry | null): this {
    this.check();
    if (geometry !== null && !(geometry instanceof Geometry)) throw new TypeError('Invalid geometry');
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
    if (!(material instanceof PbrMaterial)) throw new TypeError('Invalid material');
    this.material = material;
    return this;
  }
  dispose(): void {
    if (this.engine.meshes.get(this.id) === this) this.engine.remove(this);
  }
}

/**
 * Runtime engine behind the public `EngineKernel` surface, with extension access to the store, frame graph and
 * GPU device. Create it with `Engine.create(canvas, options)`; deltas are seconds, and `render` rejects a delta outside
 * [0, 1] with RangeError.
 */
export class Engine {
  readonly frameGraph = new FrameGraph();
  readonly meshes = new Map<number, Mesh>();
  readonly camera: Camera;
  readonly lighting = {
    direction: new Float32Array([3, 5, 4, 3]),
    radiance: new Float32Array([1, 1, 1, 0.15]),
    ambient: new Float32Array([1, 1, 1]),
  };
  readonly stats = { visible: 0, drawCalls: 0 };
  disposed = false;
  onError: (error: unknown) => void = (error) => {
    if (typeof reportError === 'function') reportError(error);
    else console.error(error);
  };
  private readonly batches = new Map<Geometry, Batch & { references: number }>();
  private readonly checkedMaterials = new WeakMap<PbrMaterial, number>();
  private materialFrame = 0;
  private readonly free: number[] = [];
  private next = 0;
  private revision = 0;
  // Last full collection: revision, visibility, material values, and each entity's instance offset (-1 when not drawn).
  /** @internal Revision of the last full instance collection; -1 forces one. */ collected = -1;
  private readonly materials = new Set<[PbrMaterial, ...number[]]>();
  private seen: Uint8Array;
  private slots: Int32Array;
  private readonly callbacks = new Set<FrameCallback>();
  private raf: number | null = null;
  private last = 0;
  private running = false;
  private rendering = false;
  private primaryCulling = true;
  private readonly frameOptions: { culling?: boolean; delta: number } = { delta: 0 };
  private disposing = false;
  /** Attached plugins by name (read-only). */
  readonly plugins: ReadonlyMap<string, EnginePlugin> = new Map();
  /** Return false to skip this display refresh (for example a 60 FPS cap on a 120 Hz screen); delta spans skipped refreshes. */
  pace?: (time: number) => boolean;
  private recovery?: Promise<void>;
  /** @internal Features requested at creation, requested again when the device is restored. */ features?: GPUFeatureName[];

  static async create(canvas: HTMLCanvasElement, options: EngineOptions = {}): Promise<Engine> {
    if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('Expected canvas');
    const backend = options.backend ?? 'auto';
    if (!['auto', 'webgpu', 'webgl2'].includes(backend)) throw new TypeError('Unknown backend');
    const store = await TransformStore.create(options.capacity ?? 1024);
    let renderer: Renderer | undefined,
      fallbackReason: string | null = null;
    try {
      if (backend !== 'webgl2')
        try {
          renderer = await GPURenderer.create(canvas, options.features);
        } catch (error) {
          if (backend === 'webgpu') throw error;
          fallbackReason = String(error);
        }
      renderer ??= (
        options.fallback ??
        (() => {
          throw new Error('WebGPU unavailable');
        })
      )(canvas);
      const engine = new Engine(canvas, store, renderer, options.camera, fallbackReason);
      engine.features = options.features;
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
    if (this.disposed || this.disposing) return Promise.reject(new Error('Engine disposed'));
    if (this.backend !== 'webgpu') return Promise.reject(new Error('WebGPU required'));
    if (this.recovery) return this.recovery;
    this.recovery = (async () => {
      const previous = this.renderer,
        next = await GPURenderer.create(this.canvas, this.features);
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
      for (const plugin of this.plugins.values()) plugin.onDeviceRestored?.(this);
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
    if (this.disposed || this.disposing || this.recovery) throw new Error('Geometry unavailable');
    return this.renderer.geometryBuffers?.(geometry) ?? null;
  }
  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }
  use(plugin: EnginePlugin): this {
    if (this.disposed || this.disposing) throw new Error('Engine disposed');
    if (!plugin.name || this.plugins.has(plugin.name) || owners.has(plugin) || typeof plugin.setup !== 'function')
      throw new TypeError('Invalid plugin');
    try {
      this.frameGraph.withOwner(plugin.name, () => {
        plugin.setup(this);
        plugin.registerPasses?.(this.frameGraph);
      });
      (this.plugins as Map<string, EnginePlugin>).set(plugin.name, plugin);
      owners.set(plugin, this);
    } catch (error) {
      this.frameGraph.removeOwner(plugin.name);
      try {
        plugin.dispose?.();
      } catch {}
      throw error;
    }
    return this;
  }
  removePlugin(name: string): void {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    this.frameGraph.removeOwner(name);
    (this.plugins as Map<string, EnginePlugin>).delete(name);
    owners.delete(plugin);
    plugin.dispose?.();
  }
  createMesh(parent: Mesh | null = null): Mesh {
    if (this.disposed || this.disposing) throw new Error('Engine disposed');
    parent?.check();
    if (parent && parent.engine !== this) throw new TypeError('Foreign parent');
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
    const mesh = new Mesh(this, id);
    this.meshes.set(id, mesh);
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
    // Detach children with a native scan of the parent column (free slots are reset on reuse); skipped when the engine goes.
    const parents = this.store.parents;
    mesh.check();
    if (!this.disposing)
      for (let id = parents.indexOf(mesh.id); id >= 0; id = parents.indexOf(mesh.id, id + 1)) parents[id] = -1;
    if (mesh.geometry) this.release(mesh.geometry);
    this.meshes.delete(mesh.id);
    this.revision++;
    this.store.active[mesh.id] = 0;
    this.store.visible[mesh.id] = 0;
    this.free.push(mesh.id);
  }
  retain(geometry: Geometry): void {
    let batch = this.batches.get(geometry);
    if (!batch)
      this.batches.set(geometry, (batch = { geometry, instances: new Float32Array(), count: 0, references: 0 }));
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
    }
  }
  private readonly collect = (mesh: Mesh): void => {
    if (mesh.geometry && this.store.visible[mesh.id]) {
      if (this.checkedMaterials.get(mesh.material) !== this.materialFrame) {
        const material = mesh.material.data;
        finite(material, 8, 'Material');
        for (let i = 0; i < 8; i++) if (material[i] < 0 || material[i] > 1) throw new RangeError('Invalid material');
        if (material[3] !== 1 || material[4] < Math.fround(0.045) || (material[6] !== 0 && material[6] !== 1))
          throw new RangeError('Invalid material');
        this.checkedMaterials.set(mesh.material, this.materialFrame);
        this.materials.add([mesh.material, ...material]);
      }
      const batch = this.batches.get(mesh.geometry)!,
        offset = batch.count++ * 24;
      batch.mask! |= keep(mesh);
      this.slots[mesh.id] = offset;
      batch.instances.set(mesh.matrix, offset);
      batch.instances.set(mesh.material.data, offset + 16);
      batch.instances[offset + 23] = mesh.id;
      this.stats.visible++;
    }
  };
  /** Draw through `camera` for this call, restoring the primary view before returning. Alternate views are sequential. */
  render({
    camera = this.camera,
    culling = true,
    delta = 0,
  }: {
    camera?: Camera;
    culling?: boolean;
    delta?: number;
  } = {}): void {
    if (this.rendering) throw new Error('Render recursion');
    if (!(camera instanceof Camera)) throw new TypeError('Invalid camera');
    this.rendering = true;
    let failed = false;
    try {
      this.update(culling, delta, camera);
      if (!this.recovery) this.renderer.render(camera, this.lighting, this.batches.values(), this.frameGraph, delta);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        if (camera !== this.camera && !this.disposed && !this.disposing) {
          this.camera.update(this.canvas.width / this.canvas.height, this.backend === 'webgpu');
          this.store.planes.set(this.camera.planes);
          this.store.tick(this.primaryCulling);
          this.collectInstances();
        }
      } catch (error) {
        if (!failed) throw error;
      } finally {
        this.rendering = false;
      }
    }
  }
  private update(culling: boolean, delta: number, camera = this.camera): void {
    if (this.disposed || this.disposing) throw new Error('Engine disposed');
    if (!Number.isFinite(delta) || delta < 0 || delta > 1) throw new RangeError('Invalid delta');
    for (const plugin of this.plugins.values()) plugin.onPreUpdate?.(delta);
    // Avoid multiplying desktop 4x MSAA by another 4x in HiDPI backing pixels; the light tier caps DPR at margoLow.
    const dpr = Math.min(globalThis.devicePixelRatio ?? 1, globalThis.margoLow || 2, 4 / sceneSamples()),
      width = Math.max(1, Math.min(4096, Math.round(this.canvas.clientWidth * dpr) || this.canvas.width)),
      height = Math.max(1, Math.min(4096, Math.round(this.canvas.clientHeight * dpr) || this.canvas.height));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    camera.advance(delta);
    camera.update(this.canvas.width / this.canvas.height, this.backend === 'webgpu');
    this.store.planes.set(camera.planes);
    this.store.tick(culling);
    finite(this.lighting.direction, 4, 'Light');
    finite(this.lighting.radiance, 4, 'Radiance');
    if (this.lighting.ambient !== undefined) finite(this.lighting.ambient, 3, 'Ambient');
    if (
      !Math.hypot(this.lighting.direction[0], this.lighting.direction[1], this.lighting.direction[2]) ||
      this.lighting.direction[3] < 0 ||
      this.lighting.radiance.some((v) => v < 0) ||
      this.lighting.ambient?.some((v) => v < 0)
    )
      throw new RangeError('Invalid lighting');
    this.collectInstances();
    if (camera === this.camera) this.primaryCulling = culling;
  }
  private collectInstances(): void {
    // Reuse last frame's instances unless the mesh set, visibility or a material changed; then patch moved matrices only.
    const { visible, changed } = this.store,
      seen = this.seen;
    let full = this.collected !== this.revision;
    for (let id = 0; !full && id < this.next; id++) full = visible[id] !== seen[id];
    for (const values of this.materials)
      for (let i = 0; !full && i < 8; i++) full = values[0].data[i] !== values[i + 1];
    if (full) {
      for (const batch of this.batches.values()) batch.count = batch.mask = 0;
      this.stats.visible = 0;
      this.stats.drawCalls = 0;
      this.materialFrame++;
      this.materials.clear();
      this.slots.fill(-1);
      this.meshes.forEach(this.collect);
      this.collected = this.revision;
      seen.set(visible);
      changed.fill(0);
      for (const batch of this.batches.values()) {
        if (batch.count) this.stats.drawCalls++;
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
          batch.start = Math.min(batch.start!, offset);
          batch.end = Math.max(batch.end!, offset + 16);
        }
      }
  }
  async pick(x: number, y: number): Promise<Mesh | null> {
    if (![x, y].every(Number.isFinite)) throw new RangeError('Invalid pick');
    if (this.disposed || this.disposing) throw new Error('Engine disposed');
    if (this.backend !== 'webgpu') throw new Error('WebGPU required');
    const w = this.canvas.clientWidth || this.canvas.width,
      h = this.canvas.clientHeight || this.canvas.height;
    if (x < 0 || y < 0 || x >= w || y >= h || this.recovery) return null;
    this.update(true, 0);
    const renderer = this.renderer as GPURenderer,
      revision = this.revision,
      picker = [...this.plugins.values()].find((plugin) => plugin.onPick);
    const mesh = picker
      ? await picker.onPick!(x, y)
      : (this.meshes.get(
          (await renderer.pick(
            this.camera,
            this.lighting,
            this.batches.values(),
            this.frameGraph,
            (x * this.canvas.width) / w,
            (y * this.canvas.height) / h,
          )) ?? -1,
        ) ?? null);
    return this.renderer === renderer && this.revision === revision ? mesh : null;
  }
  onFrame(callback: FrameCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }
  start({ culling }: { culling?: boolean } = {}): void {
    if (this.disposed || this.disposing) throw new Error('Engine disposed');
    this.frameOptions.culling = culling;
    if (this.running) return;
    this.running = true;
    this.last = 0;
    this.raf = requestAnimationFrame(this.frame);
  }
  private readonly frame = (time: number): void => {
    this.raf = null;
    if (this.disposed || !this.running) return;
    if (this.pace && !this.pace(time)) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    const delta = this.last ? Math.min((time - this.last) / 1000, 0.1) : 0;
    this.last = time;
    try {
      for (const callback of this.callbacks) callback(this, delta);
      this.frameOptions.delta = delta;
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
    for (const name of this.plugins.keys()) cleanup(() => this.removePlugin(name));
    for (const mesh of this.meshes.values()) cleanup(() => mesh.dispose());
    this.callbacks.clear();
    cleanup(() => this.renderer.dispose());
    cleanup(() => this.store.dispose());
    this.disposed = true;
    if (failed) throw failure;
  }
}
