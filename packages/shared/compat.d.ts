/** The vendor the WebGL2 compatibility layer's adapters report (`COMPAT_VENDOR` of the layer's device entry). */
export const COMPAT_VENDOR: 'margo-webgl2';
/** Refuses a measured lower-tier precision requirement before allocation. Native devices pass; default minimum full. */
export function requireCompatTier(device: unknown, feature: string, minimum?: 'full' | 'half-float' | 'ldr'): void;
/** `'webgl2'` for a device of the WebGL2 compatibility layer, `'native'` for a browser's own WebGPU device. */
export function compatTier(device: GPUDevice | undefined): 'native' | 'webgl2';
/**
 * Sets a GPU simulation's `stats.backend` for `device` (`'webgl2-compat'` on the WebGL2 layer, else `'webgpu'`) and
 * returns whether it is the WebGL2 layer.
 */
export function reportBackend(stats: { backend: string }, device: GPUDevice | undefined): boolean;
/**
 * On the WebGL2 layer, starts loading a package's compatibility route (`load`, a dynamic import) and resolves what it
 * resolves; on native WebGPU returns undefined and loads nothing.
 */
export function compatibilityLevel(
  device: { adapterInfo?: { vendor?: string }; features?: { has(name: string): boolean } } | undefined,
): boolean;
export function loadCompatRoute<T>(device: GPUDevice | undefined, load: () => Promise<T>): Promise<T> | undefined;
/** Settles (never rejects) once `route` has settled, after the handlers attached before it; resolved at once without one. */
export function routeSettled(route: Promise<unknown> | undefined): Promise<void>;

/** One stage's (or both stages' together) texture units on the WebGL2 layer, against its GL limit. */
export interface CompatStageUnits {
  readonly stage: 'vertex' | 'fragment' | 'combined';
  readonly units: number;
  readonly pairs: number;
  readonly storage: number;
  readonly limit: number;
  readonly bindings: readonly (readonly [number, number])[];
}
/** On the WebGL2 layer, the texture units a render pipeline would take per stage; undefined on native WebGPU. */
export function compatTextureUnits(
  device: GPUDevice | undefined,
  descriptor: GPURenderPipelineDescriptor,
):
  | {
      readonly vertex: CompatStageUnits;
      readonly fragment: CompatStageUnits;
      readonly combined: CompatStageUnits;
      readonly over?: CompatStageUnits;
    }
  | undefined;
