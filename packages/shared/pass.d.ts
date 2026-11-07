/** A reusable pass descriptor drawing over the frame: colour load/store, depth and stencil read only. */
export function overlayPass(): GPURenderPassDescriptor & {
  colorAttachments: [GPURenderPassColorAttachment];
  depthStencilAttachment: GPURenderPassDepthStencilAttachment;
};
/** {@link overlayPass} that also loads and stores depth. */
export function overlayDepthPass(): GPURenderPassDescriptor & {
  colorAttachments: [GPURenderPassColorAttachment];
  depthStencilAttachment: GPURenderPassDepthStencilAttachment;
};
/** Straight (non-premultiplied) alpha blending. */
export const alphaBlend: GPUBlendState;
/** Straight alpha blending that leaves the target's alpha channel unchanged: precipitation and other overlays drawn into a frame. */
export const overlayBlend: GPUBlendState;

/** `mesh` when it is null or a core mesh handle (checked live); else a TypeError. */
export function attachableMesh<M extends { check(): void } | null>(mesh: M): M;
/**
 * What an order-independent pass offers an effect that is no PBR surface (particles, splats, points), in place of
 * gltf-pro's transparency hook. Same contract, but `surface` declares `fn margoTransparentAt(color:vec4f,clip:vec4f,
 * depth:f32)->MargoTransparent`: `clip` is the fragment's position builtin, `depth` its view depth.
 */
export interface SurfaceTransparency {
  /** Module-scope WGSL: `struct MargoTransparent` (one output per target), `margoTransparentAt` and its bindings in `group`. */
  surface(group: number): string;
  /** Layout of those bindings, for an effect with explicit pipeline layouts. */
  readonly layout: readonly GPUBindGroupLayoutEntry[];
  /** Entries for those bindings. */
  bindings(): GPUBindGroupEntry[];
  /** True: declarations hold `override margoKind:u32`, 0 normal, 1 additive; additive surfaces may draw here. */
  readonly blends?: boolean;
  /** Colour targets of the transparent pass, in `MargoTransparent` location order. */
  readonly targets: readonly GPUColorTargetState[];
  /** This frame's transparent pass, begun on the first draw and ended by the owner. */
  begin(): GPURenderPassEncoder;
}
/** The fragment entry `transparent` of an effect under a transparency hook: `inputs` are its parameters, the rest WGSL expressions. */
export function surfaceEntry(declarations: string, inputs: string, color: string, clip: string, depth: string): string;
/** Holds an effect's transparency hook: `set` takes it and `released`, and returns the remover. */
export function transparencySlot(): {
  hook?: SurfaceTransparency;
  released?: () => void;
  set(hook: SurfaceTransparency, released?: () => void): () => void;
};
/** `hook`'s pass with `pipeline` set, `group` at group 0 and the hook's bindings at group 1, for an effect with an auto layout. */
export function surfacePass(
  device: GPUDevice,
  hook: SurfaceTransparency,
  pipeline: GPURenderPipeline,
  group: GPUBindGroup,
): GPURenderPassEncoder;
/** The WGSL `make(group)` builds for bind group `group`, made once per group and kept in `cache`. */
export function groupCode(cache: Map<number, string>, group: number, make: (group: number) => string): string;
