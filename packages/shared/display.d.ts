export const neutralShader: string;
export const displayShader: string;
/** Core's lighting shader returning linear HDR radiance; throws MargoError 'unsupported' naming `owner` when it cannot. */
export function linearShader(shader: string, owner?: string): string;
