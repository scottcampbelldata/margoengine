import type { EngineKernel } from '@margoengine/core';
import type { ReceivedCanvas } from './canvas.js';

/** A scene's shared environment, identical on page and worker apart from mode. */
export interface SceneContext {
  /** Page canvas or the worker's forwarded OffscreenCanvas element facade. */
  canvas: HTMLCanvasElement;
  /** User data, structured cloned for the worker and passed directly on the page. */
  data: unknown;
  /** Lifetime cancellation, aborted on startup cancellation and disposal. */
  signal: AbortSignal;
  /** Where this instance is running. */
  mode: 'worker' | 'page';
  /** Ties an engine to canvas visibility and lifetime. */
  attach(engine: EngineKernel): void;
}
/** Scene instance cleanup, optionally asynchronous. */
export interface SceneInstance {
  /** Releases scene resources. Called once by the scene owner. */
  dispose(): void | Promise<void>;
}
/** A module URL must export createScene with this shape. The same module is loaded on either thread. */
export interface SceneModule {
  /** Starts this scene, returning its cleanup owner. */
  createScene(context: SceneContext): SceneInstance | Promise<SceneInstance>;
}
/** @internal RPC protocol shared by the lazy worker and page entry. */
export interface SceneTasks {
  prepare(url: string, backend: 'auto' | 'webgpu' | 'webgl2'): Promise<boolean>;
  start(): Promise<void>;
  dispose(): Promise<void>;
}
/** @internal A scene loader shared by page and worker. No import executes at entry import time. */
export const loadScene = (url: string): Promise<SceneModule> => import(/* @vite-ignore */ url);
/** @internal Worker scene context with the existing canvas bridge's visibility behavior. */
export const workerContext = (view: ReceivedCanvas, signal: AbortSignal): SceneContext => ({
  canvas: view.canvas,
  data: view.data,
  signal,
  mode: 'worker',
  attach: (engine) => {
    view.attach(engine);
  },
});
