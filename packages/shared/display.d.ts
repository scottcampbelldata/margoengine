export const neutralShader: string;
export const displayShader: string;
/** Core's lighting shader returning linear HDR radiance; throws MargoError 'unsupported' naming `owner` when it cannot. */
export function linearShader(shader: string): string;
/** The message for an effect `owner` that found no core display transform to replace. */
export function coreShaderRequired(owner: string): string;
