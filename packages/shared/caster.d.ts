/** Vertex buffers of a 24-byte (core) or 80-byte (gltf-pro) caster, plus instance matrices when `instanced`. */
export function casterBuffers(stride: number, displaced?: boolean, instanced?: boolean): GPUVertexBufferLayout[];
/** A depth-only caster pipeline (less-equal depth into depth32float, line lists for `lines`). */
export function casterPipeline(
  device: GPUDevice,
  module: GPUShaderModule,
  stride: number,
  displaced: boolean,
  instanced: boolean,
  lines: boolean | undefined,
): GPURenderPipeline;
/** The per-primitive draw records of `node` in `draws`, created empty on first use. */
export function nodeRecords<N, K, R>(draws: Map<N, Map<K, R>>, node: N): Map<K, R>;
/** The runtime object of a caster source; throws MargoError 'disposed' or 'attached'. */
export function casterRuntime<S extends object, R>(source: S, engine: unknown, noun: string): R;
/** The bind group of a displaced caster: its feature uniform, map and sampler; else undefined. */
export function displacementGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  displacement: { buffer: GPUBuffer; view: GPUTextureView; sampler: GPUSampler } | undefined,
): GPUBindGroup | undefined;
/** A cleared depth-only pass descriptor; set `depthStencilAttachment.view` before each use. */
export function depthPassDescriptor(): GPURenderPassDescriptor & {
  depthStencilAttachment: GPURenderPassDepthStencilAttachment;
};
/** Writes one caster's uniform (view, node matrix, alpha, cutoff, uv set, alpha transform), uploads it and draws. */
export function drawCaster(
  pass: GPURenderPassEncoder,
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  group: GPUBindGroup,
  uniform: GPUBuffer,
  values: Float32Array<ArrayBuffer>,
  view: ArrayLike<number>,
  p: {
    node: { matrix: ArrayLike<number> };
    alpha?: number;
    cutoff?: number;
    texCoord?: number;
    vertex: GPUBuffer;
    index: GPUBuffer;
    count: number;
  },
  transform: ArrayLike<number> | undefined | null,
  displaced: GPUBindGroup | undefined,
  instances: { upload(device: GPUDevice): GPUBuffer; count: number } | undefined | null,
): void;
/** Whether a caster's cached draw `record` no longer fits primitive `p` drawn with `pipeline` and `displacement`. */
export function staleCaster<R extends object>(
  record: R | undefined,
  p: { vertex: GPUBuffer; alphaTexture?: unknown; alphaSampler?: unknown },
  pipeline: GPURenderPipeline,
  displacement: unknown,
): record is undefined;
