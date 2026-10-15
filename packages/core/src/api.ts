import { Engine as Runtime } from './engine.js';
import type { EngineOptions } from './engine.js';
import type { Camera, Vec3 } from './camera.js';
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
  check(): void;
  setPosition(value: Vec3): this;
  setScale(value: Vec3): this;
  setRotation(value: Vec3): this;
  setQuaternion(value: readonly number[]): this;
  setParent(parent: Mesh | null): this;
  setGeometry(value: Geometry | null): this;
  setMaterial(value: PbrMaterial): this;
  dispose(): void;
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
  createMesh(parent?: Mesh | null): Mesh;
  pick(x: number, y: number): Promise<Mesh | null>;
  render(options?: { culling?: boolean; delta?: number }): void;
  start(options?: { culling?: boolean }): void;
  stop(): void;
  dispose(): void;
  rebootDevice(): Promise<void>;
  use(plugin: EnginePlugin): this;
  hasPlugin(name: string): boolean;
  removePlugin(name: string): void;
  onFrame(callback: FrameCallback): () => void;
}
/**
 * Extension attached with `engine.use(plugin)`. `name` must be non-empty and unique per engine; `setup` runs once on
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
