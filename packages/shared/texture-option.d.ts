/** A texture, or a function read each frame for one that changes, such as a pixel layer's `target` getter. */
export type TextureSource2D = GPUTexture | (() => GPUTexture);

/** One texture option: a per-frame getter, or a caller's texture held by the borrowed-object rule. */
export class TextureOption {
  value: TextureSource2D | undefined;
  constructor(value: TextureSource2D | undefined, name: string, setter: string);
  /** A new value; a plain texture belongs to `device` (the engine's at this moment). */
  set(value: TextureSource2D | undefined, device: GPUDevice | null | undefined): void;
  /** Ties a texture given before attach to the device the pass is set up on. */
  fix(device: GPUDevice | null | undefined): void;
  /** The texture to use on `device` this frame, or undefined (none given, or lost with its device). */
  get(device: GPUDevice, engine?: { onError(error: unknown): void }): GPUTexture | undefined;
}
