import type { ColorInput } from '@margoengine/math/color';

/**
 * Fog as `@margoengine/environment`'s `Fog` exposes it: pass that Fog, or any object with these fields. Read every
 * frame, so changing the Fog changes the fog at once. Missing fields take Fog's defaults. A negative or non-finite
 * distance, density or falloff (or a non-finite height) throws a RangeError, a malformed colour a TypeError or
 * RangeError, a non-boolean `enabled` a TypeError.
 */
export interface FogLike {
  /** Fog colour: hex is sRGB, `[r, g, b]` linear. Default '#ffffff'. */
  readonly color?: ColorInput;
  /** Linear fog start distance from the camera. Default 1. */
  readonly near?: number;
  /** Linear fog end distance, where fog is full. Default 1000. */
  readonly far?: number;
  /** Above 0 selects exponential-squared fog `1 - exp(-(density * distance)^2)`. Default 0. */
  readonly density?: number;
  /** Height fog: fog thins by `exp(-heightFalloff * (y - height))` above world height `height`. Default 0 (off). */
  readonly heightFalloff?: number;
  /** World height below which fog is at full strength. Default 0. */
  readonly height?: number;
  /** False mixes in no fog; switching never recompiles. Default true. */
  readonly enabled?: boolean;
}

/** Bytes of the fog uniform: colour and height, near/far/density/falloff, camera position. */
export const FOG_BYTES: 48;
/** WGSL: the fog uniform at `@group(group) @binding(binding)` and `fogAmount(world position)`, 0 (clear) to 1. */
export function fogWgsl(group: number, binding: number): string;
/** Throws when `fog` is neither null nor an object; `setFog` calls it so a wrong argument fails where it is passed. */
export function checkFog(fog: FogLike | null): FogLike | null;
/** Validates `fog` and writes the 12-float fog uniform into `out` (colour sRGB-encoded with `encode`). */
export function writeFog(fog: FogLike, eye: ArrayLike<number>, out: Float32Array, encode?: boolean): void;
