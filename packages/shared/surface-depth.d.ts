/** Publishes this pass context's scene depth with a late surface (Water's) drawn into it, for this encoder and view only. */
export function publishSurfaceDepth(context: object, texture: GPUTexture): void;
/** The depth `publishSurfaceDepth` gave for this context's encoder and view, or undefined. */
export function surfaceDepth(context: object): GPUTexture | undefined;
