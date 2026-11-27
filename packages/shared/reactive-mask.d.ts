/** Publishes a reactive mask (red 0 to 1, how far TAA distrusts history) for this pass context's encoder and view only. */
export function publishReactiveMask(context: object, texture: GPUTexture): void;
/** Every mask `publishReactiveMask` gave for this context's encoder and view, in publishing order; empty if none. */
export function reactiveMasks(context: object): readonly GPUTexture[];
