/** The current frame number on `device`, opening a frame when none is recording; `view` draws in it. */
export function currentFrame(device: GPUDevice, view?: object): number;
/** True while a frame with more than one view records on `device`. */
export function recording(device: GPUDevice): boolean;
/** Marks a draw recording on `device` until `endDraw`. */
export function beginDraw(device: GPUDevice, view: object): void;
export function endDraw(device: GPUDevice): void;
/**
 * Destroys `resource` (and its `writeUniform` copies), created on `device`: at once, unless another view of this frame
 * or a draw in progress may still use it; then at the end of the task. Nothing is destroyed once `device` is lost.
 */
export function retire(device: GPUDevice, resource: { destroy(): void } | undefined): void;
/**
 * Writes one draw's uniform `data` for `view`: into `buffer` on its first write this frame or for that same view
 * (returns undefined), else, for another view with other values, into a reused copy whose binding is returned.
 */
export function writeUniform(
  device: GPUDevice,
  buffer: GPUBuffer,
  data: Float32Array<ArrayBuffer>,
  view: object,
): GPUBufferBinding | undefined;
/**
 * Bind groups built around the uniform `buffer` at once; `get(copy)` returns them, or those of a `writeUniform` copy,
 * built on first use and cached.
 */
export function uniformGroups<T>(
  buffer: GPUBuffer,
  make: (binding: GPUBufferBinding) => T,
): {
  get(copy?: GPUBufferBinding): T;
};
