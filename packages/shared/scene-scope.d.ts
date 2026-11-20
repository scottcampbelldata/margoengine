/** A scene kept from the start of a load; see {@link captureScene}. */
export interface SceneScope {
  /** The captured scene, or undefined on an engine that has no scenes. */
  readonly scene: unknown;
  /** Calls `work` with the captured scene active and returns its result. A throw from `work` is rethrown. */
  run<T>(work: () => T): T;
}
export function captureScene(engine: object | null | undefined): SceneScope;
/** A scope over a scene known from an object, such as the scene a plugin or model is in. */
export function sceneScope(engine: object | null | undefined, scene: unknown): SceneScope;
