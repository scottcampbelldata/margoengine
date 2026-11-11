import { margoError } from '../../shared/errors.js';
import type { PassContext } from '@margoengine/core/extension';
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/**
 * Draws a model's PBR shader into a caller-owned render pass on another device: prepare() encodes deformation, draw() appends the draw calls, dispose() releases the replica.
 */
export interface PBRDeviceRenderer {
  /** Encode deformation on this renderer's device before opening the eye pass. */
  prepare(context: Pick<Context, 'backend' | 'device' | 'encoder'>): void;
  /**
   * Append the ordinary PBR shader to a caller-owned forward-Z eye pass. Returns the pass that is open afterwards: `pass`
   * itself, or the one `options.snapshot` reopened. Keep recording on the returned pass.
   */
  draw(
    context: Context,
    pass: GPURenderPassEncoder,
    view: ArrayLike<number>,
    options?: PBRDeviceDrawOptions,
  ): GPURenderPassEncoder;
  dispose(): void;
}
/** Options of {@link PBRDeviceRenderer.draw}. */
export interface PBRDeviceDrawOptions {
  /**
   * Lets glass (KHR_materials_transmission) on a display-encoded target (any format but `rgba16float`) add its light to
   * the light behind it in linear values. Before each glass surface the renderer calls it with the open pass and a
   * texture of the context's width, height and format: end `pass`, write the colour drawn so far into `target` (the
   * resolved colour for a multisampled pass, for example with `copyTextureToTexture`), and return a pass reopened on the
   * same attachments with `loadOp: 'load'`, viewport and scissor. Default: unset, and glass multiplies and adds in the
   * target's stored values, exact only on a linear `rgba16float` target.
   */
  snapshot?(pass: GPURenderPassEncoder, target: GPUTexture): GPURenderPassEncoder;
}
/** Encodes only a model's skinning and morph deformation on another device; dispose() releases it. */
export interface PBRDeformationRenderer {
  prepare(context: Pick<Context, 'backend' | 'device' | 'encoder'>): void;
  dispose(): void;
}

/** Own only replica resources. The source retains its nodes, decoded images and device. */
export function deviceRenderer(
  device: GPUDevice,
  prepare: PBRDeviceRenderer['prepare'],
  draw: PBRDeviceRenderer['draw'],
  release: () => void,
  onDispose: (cleanup: () => void) => () => void,
): PBRDeviceRenderer {
  let disposed = false,
    unsubscribe: (() => void) | undefined;
  const renderer: PBRDeviceRenderer = {
    prepare(context) {
      if (disposed) throw margoError('disposed', 'PBR device renderer is disposed; create a new one');
      if (context.device !== device)
        throw margoError('attached', 'PBR renderer belongs to another GPU device; create one per device');
      prepare(context);
    },
    draw(context, pass, view, options) {
      if (disposed) throw margoError('disposed', 'PBR device renderer is disposed; create a new one');
      if (context.device !== device)
        throw margoError('attached', 'PBR renderer belongs to another GPU device; create one per device');
      return draw(context, pass, view, options);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      release();
    },
  };
  unsubscribe = onDispose(() => renderer.dispose());
  return renderer;
}
