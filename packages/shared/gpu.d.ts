import type { Engine, PassContext } from '@margoengine/core/extension';
type Context = Extract<PassContext, { backend: 'webgpu' }>;
export const fullscreen: string;
export const meshVertex: string;
export function group(
  device: GPUDevice,
  pipeline: GPURenderPipeline | GPUComputePipeline,
  resources: GPUBindingResource[],
): GPUBindGroup;
export function render(
  device: GPUDevice,
  code: string,
  format: GPUTextureFormat,
  extra?: Partial<GPURenderPipelineDescriptor>,
): GPURenderPipeline;
export function compute(device: GPUDevice, code: string, entryPoint?: string): GPUComputePipeline;
export function draw(c: Context, pipeline: GPURenderPipeline, bindGroup: GPUBindGroup, loadOp?: GPULoadOp): void;
export function dispatch(
  c: Context,
  pipeline: GPUComputePipeline,
  bindGroup: GPUBindGroup,
  x: number,
  y?: number,
): void;
export function acquireDepth(engine: Engine): { texture: () => GPUTexture | undefined; release(): void };
/** A reusable pass descriptor drawing over the frame (colour load/store; depth read only, or load/store with `depthWrites`). */
export function overlayPass(depthWrites?: boolean): GPURenderPassDescriptor & {
  colorAttachments: [GPURenderPassColorAttachment];
  depthStencilAttachment: GPURenderPassDepthStencilAttachment;
};
