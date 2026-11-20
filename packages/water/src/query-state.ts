// Internal bridge: rendering owns the resources, the optional query entry owns all capture/query work.
import type { PassContext } from '@margoengine/core/extension';
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** Optional consumers run after current wave uploads and before the surface draw. */
export const surfacePasses = new WeakMap<object, { order: number; draw(context: Context): boolean | void }[]>();
export interface QueryState {
  kind: 'water' | 'fft';
  device: GPUDevice;
  token: GPUBuffer;
  values: Float32Array;
  time: number;
  shader: string;
  segments: number;
  positions?: Float32Array;
  resources?: GPUBindingResource[];
  extraBindings?: GPUBindGroupEntry[];
  extraVelocity?: string[];
  coast?: WaterSolver;
  still?: boolean;
  resolution?: number;
  lengths?: readonly number[];
  field?: GPUBuffer;
}
export const queryStates = new WeakMap<object, () => QueryState | undefined>();
/** Optional water/rivers kernels replacing Water's coastal flow and integrate steps (internal bridge). */
export interface RiverKernels {
  readonly flow: string;
  readonly integrate: string;
  readonly substeps: number;
  /** [count, 0, 0, 0] then [x, z, discharge, radius] per source; uploaded every frame. */
  readonly sources: Float32Array;
}
export const riverKernels = new WeakMap<object, RiverKernels>();
/**
 * A shallow-water solver that runs in place of Water's coastal flow (internal bridge; `water/flood` registers one). It has
 * CoastalFlow's shape: `states[current]` holds rgba32float (depth m, ground m, foam, breaker) per heightmap cell, which the
 * surface, spray and queries read; `fluxes[current]` holds (west, east, south, north) outflows in m^2/s, of which spray and
 * queries read the velocity (east - west, north - south) / depth; `connected` is 0 for open-sea cells (the swell's surf
 * and wall impacts), else any other value. `step` records one frame of flow.
 */
export interface WaterSolver {
  readonly terrain: GPUTexture;
  readonly states: readonly GPUTexture[];
  readonly views: readonly GPUTextureView[];
  readonly fluxes: readonly GPUTexture[];
  readonly connected: GPUBuffer;
  readonly current: number;
  step(encoder: GPUCommandEncoder): void;
  dispose(): void;
}
/** What Water gives a solver factory: the device, its 560 B frame uniform, the heightmap and the `fill` surface per cell. */
export interface WaterSolverInput {
  readonly device: GPUDevice;
  readonly uniform: GPUBuffer;
  readonly terrain: GPUTexture;
  readonly fill?: Float32Array;
}
/** Solver factories by Water; Water rebuilds its flow (and spray) on the next frame when the entry changes. */
export const waterSolvers = new WeakMap<object, (input: WaterSolverInput) => WaterSolver>();
