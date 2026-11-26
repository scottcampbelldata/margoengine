import { exp } from '@margoengine/math/pinned';
import type { HullMesh, Vec3 } from './wetted.js';

/** Reference geometry and sampling of a linear three-dimensional water response. */
export interface HullPanelOptions {
  /** Still-water height in hull coordinates, default 0 metres. */
  readonly waterline?: number;
  /** Centre of mass in hull coordinates, default [0, 0, 0] metres. */
  readonly centre?: Vec3;
  /** Still water depth in metres, default Infinity. */
  readonly depth?: number;
  /** Water density in kg/m³, default 1025. */
  readonly density?: number;
  /** Downward gravitational acceleration in m/s², default 9.81. */
  readonly gravity?: number;
  /** Ascending intrinsic angular frequencies in rad/s, 2 to 64. */
  readonly frequencies: ArrayLike<number>;
  /** Evenly spaced incident headings starting at +X. Default 16. Use 0 for radiation alone. */
  readonly headings?: number;
  readonly signal?: AbortSignal;
}

/** Hydrodynamic coefficients at one intrinsic angular frequency. */
export interface HullPanelSample {
  /** SI, symmetric 6×6 row-major, about the hull centre for surge, heave, sway, roll, yaw and pitch. */
  readonly addedMass: readonly number[];
  /** SI, symmetric 6×6 row-major, in the same axes. */
  readonly damping: readonly number[];
  /** Scattered-wave load per metre of incident amplitude, in heading order, with real/imaginary pairs for the six axes. */
  readonly diffraction: readonly number[];
}

/** Reusable reference response from a hull's wetted triangular panels. */
export interface HullPanelResponse {
  readonly waterline: number;
  readonly centre: Vec3;
  readonly depth: number;
  readonly gravity: number;
  readonly density: number;
  readonly headings: number;
  readonly panelCount: number;
  readonly frequencies: readonly number[];
  readonly samples: readonly HullPanelSample[];
  readonly infiniteMass: readonly number[];
}

/** Lazily bakes the linear water response on the hull's reference geometry with the optional panel Wasm. */
export async function bakeHullPanels(mesh: HullMesh, options: HullPanelOptions): Promise<HullPanelResponse> {
  options.signal?.throwIfAborted();
  const { bake } = await import('./panel-bake.js');
  return bake(mesh, options);
}

/** Linear dispersion ratio tanh(kd), pinned for deterministic world stepping. */
export function depthRatio(k: number, depth: number): number {
  if (depth === Infinity) return 1;
  const kd = k * depth;
  if (kd < 1e-5) return kd;
  const bottom = exp(-2 * kd);
  return (1 - bottom) / (1 + bottom);
}
