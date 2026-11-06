/** Grows `state.base`, with room to spare, to hold `bytes`, and rebinds `state.baseGroup` to it. */
export function ensurePickBase(
  device: GPUDevice,
  state: { baseLayout: GPUBindGroupLayout; base?: GPUBuffer; baseGroup?: GPUBindGroup },
  bytes: number,
): void;
/** Starts a pick overlay's pass over the tile the meshes drew into, with its frame at group 0. */
export function beginPickPass(
  context: { encoder: GPUCommandEncoder; color: GPUTextureView; depth: GPUTextureView },
  frameGroup: GPUBindGroup,
): GPURenderPassEncoder;
