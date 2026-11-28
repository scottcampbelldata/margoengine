import type { SlamStation } from './slamming.js';
import type { HullMesh } from './wetted.js';

/** Settings of the hull slamming bake. Every option has a default. */
export interface HullSlammingOptions {
  /** Water density in kg/m³. Default 1025. */
  readonly density?: number;
  /** Number of longitudinal hull cuts. Default 24. */
  readonly stations?: number;
  /** Number of height cuts used to interpolate each section profile. Default 48. */
  readonly levels?: number;
  /** Total native participants, including the caller. Default 1. */
  readonly threads?: 1 | 2 | 4;
  /** Cancels the bake; it rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

/** Work actually executed on one caller or helper. */
export interface HullSlammingWorkerWork {
  readonly stations: number;
  /** Positive depths evaluated, including those at which the chine is already wet. */
  readonly samples: number;
  readonly bisections: number;
  /** Pairs of angular terms evaluated with the Wasm f64x2 instructions. */
  readonly quadraturePairs: number;
  /** Breadth comparisons while locating the interpolation segments. */
  readonly profileComparisons: number;
}

/** Work accumulated during the bake, with the caller first. */
export interface HullSlammingWorkCounts extends HullSlammingWorkerWork {
  readonly threads: number;
  readonly workers: readonly HullSlammingWorkerWork[];
}

/** Baked Wagner strip tables, tied to a body-frame mesh, water density and longitudinal resolution. */
export interface HullSlammingTable {
  readonly density: number;
  readonly stations: number;
  readonly levels: number;
  readonly meshHash: string;
  readonly work: HullSlammingWorkCounts;
  readonly profiles: readonly SlamStation[];
}

// FNV-1a on separate little-endian binary64 arrays with their lengths. Placement is part of the geometry.
export function slamMeshHash(mesh: HullMesh): string {
  const word = new DataView(new ArrayBuffer(8));
  const bytes = new Uint8Array(word.buffer);
  let hash = 0xcbf29ce484222325n;
  function append(value: number): void {
    word.setFloat64(0, value, true);
    for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  for (const values of [mesh.vertices, mesh.indices]) {
    append(values.length);
    for (let i = 0; i < values.length; i++) append(values[i]!);
  }
  return hash.toString(16).padStart(16, '0');
}

/** Bake hull entry tables with the optional native Wagner quadrature. */
export async function bakeHullSlamming(mesh: HullMesh, options: HullSlammingOptions = {}): Promise<HullSlammingTable> {
  options.signal?.throwIfAborted();
  const { bake } = await import('./slamming-bake.js');
  return bake(mesh, options);
}
