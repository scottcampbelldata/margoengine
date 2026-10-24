/**
 * WGSL `fn agx(c: vec3f) -> vec3f` (with helpers `agxRail`, `agxHsv`, `agxRgb` and `agxSide`): linear Rec.709 in,
 * linear Rec.709 display out, each channel in 0..1. Same transform as {@link agx}.
 */
export const agxShader: string;
/**
 * Linear Rec.709 in, linear Rec.709 display out, each channel in 0..1. Same transform as {@link agxShader}.
 * Writes into `out` when given (it may be the input array) and returns it.
 */
export function agx(c: ArrayLike<number>, out?: number[]): number[];
