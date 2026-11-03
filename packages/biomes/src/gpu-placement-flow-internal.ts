// Internal bridges only. No package entry re-exports this module.
import type { BiomePlacement, PlacedTile } from './placement.js';
import type { HeightGrid, Hydrology, HydrologyOptions } from './hydrology.js';
import type { Stands } from './stands.js';

export interface GPUSpec {
  readonly index: number;
  readonly code: number;
  readonly biomeIndex: number;
  readonly gen: number;
  readonly mu: number;
  readonly e0: number;
  readonly stands?: Stands;
  readonly cluster?: {
    readonly table: Int32Array;
    readonly reach: number;
    readonly cell: number;
    readonly mu: number;
    readonly e0: number;
    readonly beta: number;
    readonly code: number;
  };
}
export interface GPUPlan {
  readonly specs: readonly GPUSpec[];
  readonly strata: readonly {
    readonly species: readonly GPUSpec[];
    readonly g: number;
    readonly gs: number;
    readonly rmax: number;
    readonly dmax: number;
  }[];
  readonly across: number;
  readonly rounds: number;
  readonly factor: Int32Array;
}
export interface RawCandidate {
  readonly h0: number;
  readonly h1: number;
  readonly h2: number;
  readonly h3: number;
  readonly h4: number;
  readonly x: number;
  readonly z: number;
  readonly stand: number;
  readonly cluster: number;
}
export interface CandidateSource {
  count(sp: GPUSpec, gx: number, gz: number): number;
  candidate(sp: GPUSpec, gx: number, gz: number, i: number): RawCandidate;
}
export type TickRect = readonly [number, number, number, number];
export interface GPUPool {
  n: number;
  x: Int32Array;
  z: Int32Array;
  sp: Uint16Array;
  r: Int32Array;
  prio: Uint32Array;
  fate: Uint8Array;
  round: Uint8Array;
  known: Uint8Array;
}
export interface GPURun {
  readonly pools: GPUPool[];
  cell(s: number, x: number, z: number): number;
}
export interface PlacementBridge {
  readonly plan: GPUPlan;
  readonly seed: number;
  readonly tileTicks: number;
  readonly worldX: number;
  readonly worldZ: number;
  open(
    windows: readonly TickRect[],
    source: CandidateSource,
    signal?: AbortSignal,
  ): Promise<{
    run: GPURun;
    render(): PlacedTile;
  }>;
}
export const worldGPU = new WeakMap<object, { device: GPUDevice; signal: AbortSignal }>();

export const placementBridges = new WeakMap<BiomePlacement, (x: number, z: number) => PlacementBridge>();

export interface FlowState {
  grid: HeightGrid;
  options: HydrologyOptions;
  n: number;
  ocean: Uint8Array;
  fill: Int32Array;
  filled: Int32Array;
  direction: Int8Array;
  flat: Uint8Array;
  mask: Int32Array;
}
// The CPU entry installs these functions without importing a GPU implementation.
export const flowBridge: {
  prepare?: (grid: HeightGrid, options: HydrologyOptions) => FlowState;
  drain?: (state: FlowState) => void;
  finish?: (state: FlowState, flow?: Int32Array) => Hydrology;
} = {};
