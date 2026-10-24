import type { PassContext } from '@margoengine/core/extension';
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** A reusable pass descriptor drawing over the frame (colour load/store; depth read only, or load/store with `depthWrites`). */
export function overlayPass(depthWrites?: boolean): GPURenderPassDescriptor & {
  colorAttachments: [GPURenderPassColorAttachment];
  depthStencilAttachment: GPURenderPassDepthStencilAttachment;
};
/** Straight (non-premultiplied) alpha blending. */
export const alphaBlend: GPUBlendState;
/** `mesh` when it is null or a core mesh handle (checked live); else a TypeError. */
export function attachableMesh<M extends { check(): void } | null>(mesh: M): M;
/** A frame-graph pass `name` at `order` that runs `run(context)` on WebGPU frames only. */
export function webgpuPass(
  name: string,
  order: number,
  run: (context: Context) => void,
): { name: string; order: number; execute(context: PassContext): void };
