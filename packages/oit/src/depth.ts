/// <reference lib="esnext.disposable" preserve="true" />
// Transparent surfaces in the scene depth, after they have drawn, so what reads depth later in the frame sees glass: TAA
// reprojects it and accepts its history, depth of field focuses on it. The surfaces draw again, with no colour, through
// the transparency hook, whichever pass (or plain sorted blending) drew their colour.
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import type { PBRModel, PBRTransparency } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';
import { applyView } from '../../shared/view-rect.js';
import { currentFrame, retire } from '../../shared/frame-resources.js';
import { groupCode } from '../../shared/pass.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** `TransparentDepth` settings, fixed at construction. */
export interface TransparentDepthOptions {
  /** Frame graph order: after the transparent colour (8), before TAA (9), SSAO (10) and the post composites. Default 8.5. */
  order?: number;
  /** Least alpha that enters the depth, above 0, at most 1: fainter parts stay out, as if not there. Default 0.1. */
  threshold?: number;
}
/** What `TAA.add` takes (`VelocitySource`): the model's transparent primitives. */
export interface TransparentVelocitySource {
  readonly shadowPrimitives: PBRModel['tintPrimitives'];
  readonly disposed: boolean;
}

const BINDING = 120;
// Additive and multiply surfaces have no surface to speak of: light and shade, not glass.
const declarations = (group: number) => /* wgsl */ `
override margoKind:u32=0u;
struct MargoTransparent {@location(0) unused:vec4f}
@group(${group}) @binding(${BINDING}) var<uniform> margoOIT:vec4f;
fn margoTransparentTint(share:vec4f)->MargoTransparent {var o:MargoTransparent; return o;}
fn margoTransparent(color:vec4f,i:Out)->MargoTransparent {
  if(margoKind==1u||margoKind==2u||(margoKind==0u&&color.a<margoOIT.x)){discard;}
  var o:MargoTransparent; return o;
}
`;
let serial = 0;

/**
 * Writes transparent surfaces into the scene depth: `glass.add(model)` draws the model's BLEND primitives and native
 * transmission, depth only, after their colour. TAA, depth of field, SSAO and anything else that reads depth later then
 * find the glass, not what is behind it; `taa.add(glass.velocity(model))` adds its motion. Later depth-tested drawing
 * sees it too, so lines at order 20 behind the glass disappear; raise `order` past them to keep them, at the price of TAA
 * and the rest. WebGPU only.
 * @throws RangeError from the constructor for an `order` or `threshold` out of range.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` from `add` before
 * `attach`.
 */
export class TransparentDepth implements EnginePlugin, PBRTransparency {
  readonly name = 'oit-depth:' + serial++;
  readonly order: number;
  readonly targets: readonly GPUColorTargetState[] = [];
  readonly blends = true;
  readonly depthWrite = true;
  private readonly threshold: number;
  private readonly code = new Map<number, string>();
  private readonly models = new Set<PBRModel>();
  private engine?: Engine;
  private device?: GPUDevice;
  private disposed = false;
  private uniform?: GPUBuffer;
  private context?: Context;
  private pass?: GPURenderPassEncoder;

  static attach(engine: EngineKernel, options?: TransparentDepthOptions): TransparentDepth {
    const value = new TransparentDepth(options);
    engineRuntime(engine).use(value);
    return value;
  }
  constructor({ order = 8.5, threshold = 0.1 }: TransparentDepthOptions = {}) {
    if (!Number.isFinite(order) || order <= 0)
      throw new RangeError('Invalid TransparentDepth order; use a number above 0');
    if (!(threshold > 0 && threshold <= 1))
      throw new RangeError('Invalid TransparentDepth threshold; use a number above 0, at most 1');
    this.order = order;
    this.threshold = threshold;
  }
  /** Writes a gltf-pro model's transparent surfaces (or a transparent materials mesh) into the depth. Returns a remover. */
  add(model: PBRModel): () => void {
    if (this.disposed || !this.engine)
      throw new MargoError(
        this.disposed ? 'disposed' : 'state',
        this.disposed
          ? 'TransparentDepth is disposed; create a new TransparentDepth'
          : 'TransparentDepth.add needs TransparentDepth.attach(engine) first',
      );
    this.models.add(model);
    const forget = model.onDispose(() => this.models.delete(model));
    return () => {
      forget();
      this.models.delete(model);
    };
  }
  /** The model's transparent primitives for `taa.add`: moving glass gets its own motion vectors where it wrote depth. */
  velocity(model: PBRModel): TransparentVelocitySource {
    return {
      get shadowPrimitives() {
        return model.tintPrimitives;
      },
      get disposed() {
        return model.disposed;
      },
    };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'TransparentDepth is disposed; create a new TransparentDepth');
    if (!engine.gpu)
      throw new MargoError(
        'unsupported',
        'TransparentDepth requires WebGPU; use a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.uniform = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    engine.gpu.queue.writeBuffer(this.uniform, 0, new Float32Array([this.threshold, 0, 0, 0]));
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.render(c);
      },
    });
  }
  /** @internal gltf-pro transparency hook. */
  declarations(group: number): string {
    return groupCode(this.code, group, declarations);
  }
  /** @internal gltf-pro transparency hook. */
  bindings(): GPUBindGroupEntry[] {
    return [{ binding: BINDING, resource: { buffer: this.uniform! } }];
  }
  /** @internal gltf-pro transparency hook: the depth pass, begun on the first transparent draw of the frame. */
  begin(): GPURenderPassEncoder {
    if (this.pass) return this.pass;
    const c = this.context!;
    const pass = (this.pass = c.encoder.beginRenderPass({
      label: 'oit:depth',
      colorAttachments: [],
      depthStencilAttachment: { view: c.depth, depthLoadOp: 'load', depthStoreOp: 'store', stencilReadOnly: true },
    }));
    applyView(pass, c);
    return pass;
  }
  private render(c: Context): void {
    currentFrame(c.device, c.view ?? c);
    if (this.disposed || !this.models.size) return;
    this.context = c;
    this.pass = undefined;
    try {
      for (const model of this.models) model.drawTransparent(c, this);
    } finally {
      (this.pass as GPURenderPassEncoder | undefined)?.end();
      this.pass = undefined;
      this.context = undefined;
    }
  }
  onDeviceRestored(engine: Engine): void {
    retire(this.device!, this.uniform);
    this.setup(engine);
  }
  /** Stops writing and frees the GPU resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.models.clear();
    retire(this.device!, this.uniform);
    this.uniform = undefined;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
