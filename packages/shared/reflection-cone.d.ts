/** Largest reflected cone half-angle, radians. */
export const coneLimit: number;
/** Tangent of the reflected cone's half-angle for perceptual roughness 0..1. */
export function reflectionConeTangent(roughness: number): number;
/** Mip level for a cone of `roughness` reaching `distance` world units along the ray, where one world unit spans `pixelsPerUnit` level-0 texels; clamped to 0..maxLevel. */
export function reflectionConeLevel(roughness: number, distance: number, pixelsPerUnit: number, maxLevel: number): number;
/** WGSL: margoConeTangent, margoConeLevel and margoCaptureRay. */
export const reflectionConeShader: string;
