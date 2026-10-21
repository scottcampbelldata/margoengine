/// <reference lib="esnext.disposable" preserve="true" />
// Render layers for drawing: a 32-bit mask per mesh (default 1, layer 0) and one per
// view; a view draws a mesh when the two masks share a bit. Built on core's `mesh.visible`: a filtered render hides the
// meshes outside its mask and restores them afterwards, so core needs no change. Masks live in one registry on
// `globalThis`, so every copy of this module shares them, and @margoengine/environment's captures read them without a
// dependency on this package.
import type { EngineKernel, Mesh } from '@margoengine/core';
import type { Camera, Engine, EnginePlugin, FrameGraph } from '@margoengine/core/extension';

/** Every layer: the mask that filters nothing. */
export const ALL_LAYERS = 0xffffffff;

// Shared with @margoengine/environment (packages/environment/src/layers.ts reads `maskOf` and `depth`). Keep the shape.
interface LayerRegistry {
  readonly masks: WeakMap<object, number>;
  readonly cameras: WeakMap<object, number>;
  source: ((mesh: Mesh) => number) | null;
  used: boolean;
  /** Filtered renders in progress; CameraLayers leaves the primary mask off while one runs. */
  depth: number;
  maskOf(mesh: Mesh): number;
}
type RuntimeMesh = Mesh & { readonly id: number; readonly engine: Engine };
const KEY = Symbol.for('margoengine.layers');
const registry: LayerRegistry = ((globalThis as Record<symbol, LayerRegistry | undefined>)[KEY] ??= {
  masks: new WeakMap(),
  cameras: new WeakMap(),
  source: null,
  used: false,
  depth: 0,
  maskOf(mesh) {
    if (this.source) return this.source(mesh) >>> 0;
    if (!this.used) return 1;
    // A mesh without its own mask takes its nearest ancestor's, so a model is layered by its root.
    let current = mesh as RuntimeMesh | undefined;
    for (let depth = 0; current && depth < 64; depth++) {
      const own = this.masks.get(current);
      if (own !== undefined) return own;
      const parent = current.engine.store.parents[current.id];
      current = parent >= 0 ? (current.engine.meshes.get(parent) as RuntimeMesh | undefined) : undefined;
    }
    return 1;
  },
});

function checkMask(mask: number, subject: string): number {
  if (!Number.isInteger(mask) || mask < 0 || mask > ALL_LAYERS)
    throw new RangeError(`${subject} ${mask} is not a 32-bit layer mask; pass an integer from 0 to 0xffffffff`);
  return mask >>> 0;
}

/** Mask with the given layers (0-31) enabled: `layerMask(0, 2)` is 0b101. */
export function layerMask(...layers: number[]): number {
  let mask = 0;
  for (const layer of layers) {
    if (!Number.isInteger(layer) || layer < 0 || layer > 31)
      throw new RangeError(`Layer ${layer} is outside 0..31; pass a layer index from 0 to 31`);
    mask |= 1 << layer;
  }
  return mask >>> 0;
}

/**
 * Sets the render layer mask of `mesh` (32-bit, default 1 = layer 0). Its descendants without a mask of their own
 * follow it, so `setRenderLayers(model.root, mask)` layers a whole model.
 * @throws RangeError for a mask that is not an integer from 0 to 0xffffffff.
 */
export function setRenderLayers(mesh: Mesh, mask: number): void {
  registry.masks.set(mesh, checkMask(mask, 'Render layer mask'));
  registry.used = true;
}
/** Render layer mask of `mesh`: its own, else its nearest ancestor's, else 1; or the `useLayerSource` reader's value. */
export function getRenderLayers(mesh: Mesh): number {
  return registry.maskOf(mesh);
}
/**
 * Reads every mesh mask through `source` instead of `setRenderLayers`, or restores the default with null. Pass
 * `getMeshLayers` from @margoengine/bvh so raycasts and drawing share one set of masks.
 * @throws TypeError when `source` is neither a function nor null.
 */
export function useLayerSource(source: ((mesh: Mesh) => number) | null): void {
  if (source !== null && typeof source !== 'function')
    throw new TypeError('Layer source must be a function (mesh) => mask or null; pass getMeshLayers or null');
  registry.source = source;
}
/**
 * Sets the layer mask a camera draws (default 1 = layer 0). `CameraLayers` applies the engine
 * camera's mask to every frame, `renderView` the given camera's.
 * @throws RangeError for a mask that is not an integer from 0 to 0xffffffff.
 */
export function setCameraLayers(camera: Camera, mask: number): void {
  registry.cameras.set(camera, checkMask(mask, 'Camera layer mask'));
}
/** Layer mask `camera` draws: the one set with `setCameraLayers`, else 1. */
export function getCameraLayers(camera: Camera): number {
  return registry.cameras.get(camera) ?? 1;
}

// Hides the visible meshes outside `mask` and the visible `exclude` meshes; returns them for `show`.
function hide(engine: EngineKernel, mask: number, exclude?: Iterable<Mesh>): Mesh[] {
  const runtime = engine as unknown as Engine,
    hidden: Mesh[] = [];
  // Every mesh is on layer 0 until a mask is set or a source installed.
  if (mask !== ALL_LAYERS && (registry.source || registry.used || !(mask & 1)))
    for (const mesh of runtime.meshes.values())
      if (!runtime.store.hidden[mesh.id] && !(registry.maskOf(mesh) & mask)) {
        mesh.visible = false;
        hidden.push(mesh);
      }
  if (exclude)
    for (const mesh of exclude) {
      const handle = mesh as RuntimeMesh;
      if (runtime.meshes.get(handle.id) === (handle as unknown) && !runtime.store.hidden[handle.id]) {
        mesh.visible = false;
        hidden.push(mesh);
      }
    }
  return hidden;
}
function show(engine: EngineKernel, hidden: readonly Mesh[]): void {
  const runtime = engine as unknown as Engine;
  if (runtime.disposed) return;
  for (const mesh of hidden)
    if (runtime.meshes.get((mesh as RuntimeMesh).id) === (mesh as unknown)) mesh.visible = true;
}

/**
 * Runs `run` with only the meshes in `mask` (and not in `exclude`) visible, then makes the hidden ones visible again,
 * also when `run` throws. Use it around `engine.render({camera})` or a capture. A hidden parent hides its children.
 * @throws RangeError for a mask that is not an integer from 0 to 0xffffffff.
 */
export function withLayers<T>(engine: EngineKernel, mask: number, run: () => T, exclude?: Iterable<Mesh>): T {
  const hidden = hide(engine, checkMask(mask, 'Layer mask'), exclude);
  registry.depth++;
  try {
    return run();
  } finally {
    registry.depth--;
    show(engine, hidden);
  }
}

/** Options of {@link renderView}. */
export interface RenderViewOptions {
  /** Camera to draw through. Default `engine.camera`. */
  camera?: Camera;
  /** Layers to draw. Default the camera's (`getCameraLayers`). */
  layers?: number;
  /** Meshes to leave out of this render. */
  exclude?: Iterable<Mesh>;
  /** As `engine.render`. Default true. */
  culling?: boolean;
  /** As `engine.render`; use 0 for extra views so simulation does not advance twice. Default 0. */
  delta?: number;
}
/** `engine.render({camera, culling, delta})` drawing only the meshes in the camera's layers (or `layers`). */
export function renderView(engine: EngineKernel, options: RenderViewOptions = {}): void {
  const camera = options.camera ?? engine.camera;
  withLayers(
    engine,
    options.layers ?? getCameraLayers(camera),
    () => engine.render({ camera, culling: options.culling ?? true, delta: options.delta ?? 0 }),
    options.exclude,
  );
}

/**
 * Applies the engine camera's layer mask (`setCameraLayers(engine.camera, mask)`, default 1) to every frame the
 * engine draws: meshes outside it are hidden from the frame start (`onPreUpdate`) to its last pass, then shown
 * again, so `mesh.visible` reads and writes between frames see your own values. Captures inside `withLayers`
 * (Reflector, CubeCamera, `renderView`) use their own masks. A hidden parent hides its children.
 */
export class CameraLayers implements EnginePlugin {
  readonly name: string;
  private engine?: EngineKernel;
  private hidden: Mesh[] = [];
  /** Same as `engine.use(new CameraLayers(options))`; returns the CameraLayers. */
  static attach(engine: EngineKernel, options?: { name?: string }): CameraLayers {
    const value = new CameraLayers(options);
    engine.use(value);
    return value;
  }
  constructor(options: { name?: string } = {}) {
    this.name = options.name ?? 'camera-layers';
  }
  setup(engine: EngineKernel): void {
    this.engine = engine;
  }
  onPreUpdate(): void {
    const engine = this.engine;
    if (!engine) return;
    // A pick between frames hides again without a frame: show the previous set first.
    show(engine, this.hidden);
    this.hidden = registry.depth > 0 ? [] : hide(engine, getCameraLayers(engine.camera));
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: 1e9,
      execute: () => this.restore(),
    });
  }
  private restore(): void {
    if (this.engine && this.hidden.length) show(this.engine, this.hidden);
    this.hidden = [];
  }
  dispose(): void {
    this.restore();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/**
 * Several named scenes in one engine, one shown at a time: each `add`ed mesh (with its children) belongs to one
 * scene, and `show(name)` hides the other scenes' meshes and gives the shown scene's meshes back the visibility they
 * had when it was hidden. Meshes in no scene are always drawn. The engine's camera, lights and plugins are shared.
 */
export class SceneSwitch {
  private readonly scenes = new Map<string, Set<Mesh>>();
  private readonly saved = new WeakMap<Mesh, boolean>();
  private current: string | null = null;
  constructor(readonly engine: EngineKernel) {}
  /** The shown scene, or null when every scene is shown. */
  get active(): string | null {
    return this.current;
  }
  /** Scene names in insertion order. */
  get names(): string[] {
    return [...this.scenes.keys()];
  }
  /**
   * Adds meshes to scene `name` (created on first use), moving them out of any other scene. Meshes added to a hidden
   * scene are hidden at once.
   * @throws TypeError for an empty name.
   */
  add(name: string, meshes: Iterable<Mesh>): this {
    if (typeof name !== 'string' || !name) throw new TypeError('Scene name must be a non-empty string; pass a name');
    let scene = this.scenes.get(name);
    if (!scene) this.scenes.set(name, (scene = new Set()));
    for (const mesh of meshes) {
      for (const [other, set] of this.scenes) if (other !== name && set.delete(mesh)) this.reveal(mesh);
      scene.add(mesh);
      if (this.current !== null && this.current !== name) this.conceal(mesh);
    }
    return this;
  }
  /** Removes meshes from their scene; they are shown with their saved visibility and then always drawn. */
  remove(meshes: Iterable<Mesh>): this {
    for (const mesh of meshes) for (const set of this.scenes.values()) if (set.delete(mesh)) this.reveal(mesh);
    return this;
  }
  /**
   * Shows scene `name` and hides every other scene, or shows every scene with null.
   * @throws RangeError for an unknown scene name.
   */
  show(name: string | null): void {
    if (name !== null && !this.scenes.has(name))
      throw new RangeError(`Scene '${name}' is unknown; add meshes to it with add('${name}', meshes) first`);
    for (const [scene, meshes] of this.scenes)
      for (const mesh of meshes) {
        if (name === null || scene === name) this.reveal(mesh);
        else this.conceal(mesh);
      }
    this.current = name;
  }
  private live(mesh: Mesh): boolean {
    const runtime = this.engine as unknown as Engine;
    return !runtime.disposed && runtime.meshes.get((mesh as RuntimeMesh).id) === (mesh as unknown);
  }
  private conceal(mesh: Mesh): void {
    if (!this.live(mesh) || this.saved.has(mesh)) return;
    this.saved.set(mesh, mesh.visible);
    mesh.visible = false;
  }
  private reveal(mesh: Mesh): void {
    const visible = this.saved.get(mesh);
    if (visible === undefined) return;
    this.saved.delete(mesh);
    if (this.live(mesh)) mesh.visible = visible;
  }
}
