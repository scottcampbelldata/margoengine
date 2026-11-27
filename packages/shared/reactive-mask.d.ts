/** Publishes a reactive mask (red 0 to 1, how far TAA distrusts history) for this pass context's encoder and view only. */
export function publishReactiveMask(context: object, texture: GPUTexture): void;
/** Every mask `publishReactiveMask` gave for this context's encoder and view, in publishing order; empty if none. Counts as a read for `reactiveMaskWanted`. */
export function reactiveMasks(context: object): readonly GPUTexture[];
/** Whether a reader (TAA) read masks on this context since `owner`'s previous frame; the same answer for every view of a frame. */
export function reactiveMaskWanted(context: object, owner: object): boolean;
/** The shared particle mask's colour attachment for this frame and view (cleared by the first draw, loaded after), published for TAA. */
export function reactiveTarget(context: {
  device: GPUDevice;
  encoder: GPUCommandEncoder;
  view?: unknown;
  width: number;
  height: number;
  descriptor: { multisample?: { count?: number } };
}): GPURenderPassColorAttachment;
/** The blend of a draw into the shared particle mask: each pixel keeps the largest coverage drawn over it. */
export const reactiveBlend: GPUBlendState;
