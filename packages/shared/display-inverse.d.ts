/** The inverse of {@link pbrNeutral}: display-linear back to scene light; display white takes `white` (default {@link neutralWhite}). */
export function pbrNeutralInverse(c: ArrayLike<number>, out?: number[], white?: number): number[];
/** The least grey scene light the display transform writes as 8-bit white (about 13.49). */
export const neutralWhite: number;
/** WGSL `fn pbrNeutralInverse(input:vec3f)->vec3f`, the twin of {@link pbrNeutralInverse}. */
export const neutralInverseShader: string;
