/** @internal Retained numeric data and live GPU resources, never driver allocation estimates. */
export interface LayerResources {
  readonly children?: readonly object[];
  readonly cpu: readonly (ArrayBufferView | ArrayLike<number> | undefined | null)[];
  readonly gpu: readonly (GPUBuffer | { readonly texture: GPUTexture; readonly bytesPerTexel: number } | undefined)[];
}
