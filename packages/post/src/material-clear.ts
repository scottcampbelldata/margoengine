import type { PassContext } from '@margoengine/core/extension';
import { clearColorValue, clearDraw } from '../../shared/clear-color.js';
import { applyView, partialRect, viewRect } from '../../shared/view-rect.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
const zero = [0, 0, 0, 0];

// A full viewport with an independent partial scissor still needs a scoped clear.
export function partialMaterialView(c: Context): boolean {
  const rect = viewRect(c);
  return !!rect && (partialRect(rect, c.width, c.height) || partialRect(c.view?.scissor, c.width, c.height));
}

function components(color: GPUColor | undefined): number[] {
  if (color === undefined) return zero;
  if (Symbol.iterator in Object(color)) return Array.from(color as Iterable<number>);
  const value = color as GPUColorDict;
  return [value.r, value.g, value.b, value.a];
}

/**
 * Clears a material pass's targets inside a partial view (core's attachment clear would cover the whole target):
 * target 0 to the view's clear colour when it owns the depth, else to zero, the extra targets to their clear values.
 */
export class MaterialClear {
  readonly extra: GPURenderPassColorAttachment[];
  private readonly values: number[][];
  private readonly attachments: GPURenderPassColorAttachment[];
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  constructor(
    private readonly formats: readonly GPUTextureFormat[],
    extra: GPURenderPassColorAttachment[],
  ) {
    this.values = extra.map((a) => components(a.clearValue));
    this.extra = extra.map((a) => ({ view: a.view, loadOp: 'load', storeOp: 'store' }));
    this.attachments = [{ view: undefined!, loadOp: 'load', storeOp: 'store' }, ...this.extra];
  }
  draw(c: Context, ownedDepth: boolean): void {
    const clearDepth = ownedDepth && (c.view?.clear?.depth ?? true);
    this.attachments[0].view = c.color;
    const pass = c.encoder.beginRenderPass({
      colorAttachments: this.attachments,
      ...(clearDepth
        ? { depthStencilAttachment: { view: c.depth, depthLoadOp: 'load' as const, depthStoreOp: 'store' as const } }
        : {}),
    });
    try {
      applyView(pass, c);
      clearDraw(c.device, this.pipelines, pass, {
        formats: this.formats,
        values: this.values,
        depthFormat: clearDepth ? c.descriptor.depthStencil!.format : undefined,
        writeDepth: clearDepth,
        tint: ownedDepth ? clearColorValue(c.view?.clear?.color) : zero,
      });
    } finally {
      pass.end();
    }
  }
}
