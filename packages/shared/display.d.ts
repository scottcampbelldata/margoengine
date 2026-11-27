export const neutralShader: string;
export const displayShader: string;
/** Khronos PBR Neutral on the CPU (display-linear, before the sRGB encoding); writes into `out` when given. */
export function pbrNeutral(c: ArrayLike<number>, out?: number[]): number[];
/** The inverse of {@link pbrNeutral}: display-linear back to scene light; display white takes `white` (default {@link neutralWhite}). */
export function pbrNeutralInverse(c: ArrayLike<number>, out?: number[], white?: number): number[];
/** The least grey scene light the display transform writes as 8-bit white (about 13.49). */
export const neutralWhite: number;
/** WGSL `fn pbrNeutralInverse(input:vec3f)->vec3f`, the twin of {@link pbrNeutralInverse}. */
export const neutralInverseShader: string;
/** Core's lighting shader returning linear HDR radiance; throws MargoError 'unsupported' naming `owner` when it cannot. */
export function linearShader(shader: string): string;
/** The message for an effect `owner` that found no core display transform to replace. */
export function coreShaderRequired(owner: string): string;
/** True when `engine` draws to a premultiplied canvas (TransparentCanvas), so display transforms take straight colour. */
export function premultipliedCanvas(engine: { canvas?: unknown } | undefined): boolean;
/** The display shader for a premultiplied canvas: `vec4f(toDisplay(c),a)` encodes the straight colour times a. */
export function straightDisplay(code: string): string;
/** `code` as straightDisplay gives it on a premultiplied canvas of `engine`, else unchanged. */
export function displayFor(engine: { canvas?: unknown } | undefined, code: string): string;
