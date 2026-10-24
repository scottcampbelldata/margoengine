/** WGSL `fn aces(v: vec3f) -> vec3f`: Stephen Hill's ACES RRT/ODT fit, clamped to 0..1. */
export const acesShader: string;
/**
 * WGSL `fn acesNarkowicz(c: vec3f) -> vec3f`: Krzysztof Narkowicz's fit of the ACES film curve (2016), after the 0.6
 * pre-scale of his reference, clamped to 0..1.
 */
export const acesNarkowiczShader: string;
/** Same curve as {@link acesNarkowiczShader} on the CPU. Writes into `out` when given and returns it. */
export function acesNarkowicz(c: ArrayLike<number>, out?: number[]): number[];
