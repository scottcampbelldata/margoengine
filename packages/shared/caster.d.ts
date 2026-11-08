/** Vertex buffers of a 24-byte (core) or 80-byte (gltf-pro) caster, plus instance matrices when `instanced`. */
export function casterBuffers(stride: number, displaced?: boolean, instanced?: boolean): GPUVertexBufferLayout[];
/** How a caster cuts its surface out like its colour pass, besides its alpha texture and cutoff. */
export interface CasterCutout {
  /** UV transform of `alphaTexture` (80-byte vertices): 8 finite floats, rows (a, b, offset, unused) for u and then v. */
  alphaTransform?: Float32Array;
  /** Opacity map of the cut-out (materials `alphaMap`, 80-byte vertices): its green channel multiplies the alpha tested. */
  opacity?: { readonly buffer: GPUBuffer; readonly view: GPUTextureView; readonly sampler: GPUSampler };
  /** False keeps vertex alpha out of the cut-out, as the colour pass does (materials `vertexColors: false`). Default true. */
  vertexAlpha?: boolean;
  /** Vertex displacement along the normal (materials `displacementMap`, 80-byte vertices). */
  displacement?: CasterDisplacement;
  /** Planes that clip the shadow (materials `clippingPlanes` with `clipShadows`, 80-byte vertices). */
  clip?: GPUBufferBinding;
  /** Planes that clip the surface, whatever `clipShadows` says (80-byte vertices). */
  surfaceClip?: GPUBufferBinding;
}
/**
 * What moves a caster's vertices: a displacement map's uniform, view and sampler, or a shader patch of its own (a
 * NodeMaterial's graph), with a `key` for its pipeline and its bind group.
 */
export type CasterDisplacement =
  | {
      readonly buffer: GPUBuffer;
      readonly view: GPUTextureView;
      readonly sampler: GPUSampler;
      readonly key?: undefined;
      readonly depth?: undefined;
      readonly velocity?: undefined;
      readonly entries?: undefined;
      readonly layout?: undefined;
      readonly cuts?: undefined;
      readonly move?: undefined;
      readonly program?: undefined;
    }
  | {
      readonly key: string;
      depth(code: string, group: number): string;
      /** TAA's object velocity shader, moved and cut as `depth` does it. Absent on a patch that does not support it. */
      velocity?(code: string, group: number): string;
      entries(): GPUBindGroupEntry[];
      /** The group's layout, for passes that build their pipeline layouts by hand. */
      layout(): GPUBindGroupLayout;
      /** The patch discards fragments, so a pass that skips the fragment stage of opaque casters needs it here. */
      readonly cuts: boolean;
      /**
       * The WGSL lines of the patch's move of `margoPosition` alone (empty: no move), and its program: TAA runs a move
       * that reads the uniform block `ndu` again on last frame's bytes of it, bound at `program.next`.
       */
      readonly move?: readonly string[];
      readonly program?: { readonly next: number; readonly buffers: WeakMap<GPUDevice, { bytes: Uint8Array }> };
    };
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
  layout: () => GPUBindGroupLayout,
  displacement: CasterDisplacement | undefined,
): GPUBindGroup | undefined;
/** WGSL of an opacity map at bindings `first` to `first` + 2 (default 4) of `group`, and `margoOpacityAt` of both UV sets. */
export function opacityCode(group: number, first?: number): string;
/** A caster depth shader whose cut-out also multiplies by an opacity map's green channel, bound at 4-6 of `group`. */
export function opacityDepth(code: string, group: number): string;
/** The bind group entries of a caster's `opacity`, from binding `first` (default 4). */
export function opacityEntries(
  opacity: {
    buffer: GPUBuffer;
    view: GPUTextureView;
    sampler: GPUSampler;
  },
  first?: number,
): GPUBindGroupEntry[];
/** A caster shader that leaves vertex alpha out of its cut-out (a primitive with `vertexAlpha: false`). */
export function solidVertexDepth(code: string): string;
/** A caster shader that discards what uniform `name`'s planes cut away, bound at `binding` of group 0. */
export function clippedDepth(code: string, binding: number, name: string, hardware?: boolean): string;
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
    /** Byte offset of the caster's vertices in `vertex`. Default 0. */
    vertexOffset?: number;
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
  p: { vertex: GPUBuffer; alphaTexture?: unknown; alphaSampler?: unknown; opacity?: unknown },
  pipeline: GPURenderPipeline,
  displacement: unknown,
): record is undefined;
