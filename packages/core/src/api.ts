/// <reference lib="esnext.disposable" preserve="true" />
import { Engine as Runtime } from './engine.js';
import type { EngineOptions } from './engine.js';
import type { Camera, Vec3 } from './camera.js';
import type { RenderView } from './renderer.js';
import type { Geometry, PbrMaterial } from './geometry.js';
/**
 * Live x/y/z view of a mesh's position (world units), rotation (Euler radians) or scale. Writes must be finite as
 * float32, and scale components non-zero; invalid values throw RangeError. Throws Error 'Mesh disposed' after disposal.
 */
export interface VectorRef {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): this;
  setAll(value: number): this;
}
/**
 * A drawable node in an engine's transform hierarchy, created by {@link EngineKernel.createMesh}. Positions are world
 * units relative to the parent, rotations are Euler radians, and parents nest at most 64 deep. Methods throw Error
 * 'Mesh disposed' once the mesh or its engine is disposed.
 */
export interface Mesh {
  name: string;
  visible: boolean;
  readonly position: VectorRef;
  readonly rotation: VectorRef;
  readonly scale: VectorRef;
  readonly geometry: Geometry | null;
  readonly material: PbrMaterial;
  /**
   * Whether `@margoengine/shadows` and clustered local-light shadows darken this mesh (default true); `false` keeps
   * its direct light unshadowed while it still casts. Throws TypeError for a non-boolean.
   */
  receiveShadow: boolean;
  check(): void;
  setPosition(value: Vec3): this;
  setScale(value: Vec3): this;
  setRotation(value: Vec3): this;
  setQuaternion(value: readonly number[]): this;
  setParent(parent: Mesh | null): this;
  setGeometry(value: Geometry | null): this;
  setMaterial(value: PbrMaterial): this;
  dispose(): void;
  /** `dispose()`, so `using mesh = engine.createMesh()` disposes it at the end of the block (where the runtime has `Symbol.dispose`). */
  [Symbol.dispose](): void;
}
/**
 * Meshes, lighting and plugins drawn together, from {@link EngineKernel.createScene}; `engine.scene` is the default.
 * Draw one with a view's `scene`: a HUD overlay, a menu item preview or a portal. While a scene is drawn or set up,
 * `engine.lighting`, `stats`, `plugins` and `createMesh` are that scene's. A mesh's parent must be in its scene.
 */
export interface Scene {
  readonly name: string;
  /** Clear colour (`#rrggbb`) for views of this scene, or null to keep the colour below (overlays). A view's `clear` wins. */
  background?: string | null;
  /** This scene's sun and ambient light, as `engine.lighting`. */
  readonly lighting: { direction: Float32Array; radiance: Float32Array; ambient: Float32Array };
  readonly stats: { visible: number; drawCalls: number };
  readonly meshes: ReadonlyMap<number, Mesh>;
  readonly plugins: ReadonlyMap<string, EnginePlugin>;
  createMesh(parent?: Mesh | null): Mesh;
  /** Attaches a plugin to this scene; its passes draw in this scene's views only. */
  use(plugin: EnginePlugin): this;
  removePlugin(name: string): void;
  /**
   * Disposes this scene's plugins and meshes and removes the scene; views must stop naming it. Throws Error for the
   * default scene, which lives as long as the engine.
   */
  dispose(): void;
  /** `dispose()`, for `using` (where the runtime has `Symbol.dispose`). */
  [Symbol.dispose](): void;
}
/**
 * Public engine surface: owns the canvas, camera, meshes, plugins and the frame loop. Create it with
 * `Engine.create(canvas, options)`. Frame deltas are seconds.
 */
export interface EngineKernel {
  readonly canvas: HTMLCanvasElement;
  readonly camera: Camera;
  readonly backend: 'webgpu' | 'webgl2';
  readonly fallbackReason: string | null;
  readonly disposed: boolean;
  readonly stats: { visible: number; drawCalls: number };
  onError: (error: unknown) => void;
  /** A mesh in the scene being drawn or set up (the default scene otherwise). */
  createMesh(parent?: Mesh | null): Mesh;
  /** The default scene: the meshes, lighting and plugins the engine camera draws. */
  readonly scene: Scene;
  /** A new scene with its own meshes, lighting and plugins; draw it with a view's `scene`. */
  createScene(name?: string): Scene;
  /** The scene `plugin` is attached to, or undefined when it is not attached to this engine. */
  sceneOf(plugin: EnginePlugin): Scene | undefined;
  /**
   * Views the frame loop draws each frame instead of the full-canvas camera view, for split screen, a four-view
   * layout or a minimap. List `engine.camera` in one of them to keep it. Unset or empty: the full-canvas view.
   */
  views?: readonly RenderView[];
  /**
   * The mesh under CSS pixel (x, y), or null. With `view`, picks through that view (null outside its rectangle);
   * without, through the canvas view under the point when the last frame drew views, else the engine camera. Calls
   * may overlap: one readback runs at a time and the others wait, answered in order, each for its own point and view.
   * A pick waiting or in flight when the engine is disposed, and one in flight when the device is lost, resolves null.
   */
  pick(x: number, y: number, view?: RenderView): Promise<Mesh | null>;
  /**
   * Draws one frame. Without `views`: the full canvas through `camera` (default the engine camera); the primary camera
   * and culling state are restored on return. With `views`: each view in order (canvas views stack, the first clears),
   * with plugin updates once per scene and each camera advanced once.
   */
  render(options?: { camera?: Camera; culling?: boolean; delta?: number; views?: readonly RenderView[] }): void;
  start(options?: { culling?: boolean }): void;
  stop(): void;
  dispose(): void;
  /** `dispose()`, so `using engine = await Engine.create(canvas)` disposes it at the end of the block (where the runtime has `Symbol.dispose`). Disposal is synchronous, so there is no `Symbol.asyncDispose`. */
  [Symbol.dispose](): void;
  rebootDevice(): Promise<void>;
  use(plugin: EnginePlugin): this;
  hasPlugin(name: string): boolean;
  removePlugin(name: string): void;
  onFrame(callback: FrameCallback): () => void;
}
/**
 * Extension attached with `engine.use(plugin)`. `name` must be non-empty and unique in its scene; `setup` runs once on
 * attach, `onPreUpdate` receives each frame's delta in seconds, and `dispose` runs on removal or engine disposal.
 */
export interface EnginePlugin {
  name: string;
  setup(engine: EngineKernel): void;
  onPreUpdate?(delta: number): void;
  onDeviceRestored?(engine: EngineKernel): void;
  dispose?(): void;
}
/** Called by the frame loop before each render with the seconds since the previous frame (0 on the first, at most 0.1). */
export type FrameCallback = (engine: EngineKernel, delta: number) => void;
/** Alias of {@link EngineKernel}. */
export type Engine = EngineKernel;
/**
 * Engine factory. `Engine.create(canvas, options)` resolves to an engine using WebGPU, or `options.fallback` when WebGPU
 * is unavailable or `backend` is 'webgl2'. Rejects with TypeError for a missing canvas or unknown backend, and with
 * Error 'WebGPU unavailable' when no renderer can be made.
 */
export const Engine: { create(canvas: HTMLCanvasElement, options?: EngineOptions): Promise<EngineKernel> } =
  Runtime as unknown as typeof Engine;
/** Same factory as {@link Engine}. */
export const EngineKernel = Engine;
