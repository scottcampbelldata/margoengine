export const neutralShader: string;
export const displayShader: string;
/** Khronos PBR Neutral on the CPU (display-linear, before the sRGB encoding); writes into `out` when given. */
export function pbrNeutral(c: ArrayLike<number>, out?: number[]): number[];
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
