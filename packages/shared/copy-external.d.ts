/** Whether `source` is a video element or a VideoFrame. */
export function isVideoSource(source: unknown): boolean;
/**
 * `device.queue.copyExternalImageToTexture(info, destination, size)`; a video or VideoFrame the queue's browser refuses
 * (a TypeError, Firefox) is drawn on a canvas and that canvas copied instead, chosen once per queue.
 */
export function copyExternal(
  device: GPUDevice,
  info: GPUCopyExternalImageSourceInfo | { source: unknown; origin?: GPUOrigin2D; flipY?: boolean },
  destination: GPUCopyExternalImageDestInfo,
  size: GPUExtent3D,
): void;
