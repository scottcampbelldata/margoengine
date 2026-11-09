// Internal bridge: rendering owns the resources, the optional query entry owns all capture/query work.
import type { CoastalFlow } from './coastal.js';
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
  coast?: CoastalFlow;
  still?: boolean;
  resolution?: number;
  lengths?: readonly number[];
  field?: GPUBuffer;
}
export const queryStates = new WeakMap<object, () => QueryState | undefined>();
