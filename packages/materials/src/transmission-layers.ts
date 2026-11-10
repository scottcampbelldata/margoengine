/// <reference lib="esnext.disposable" preserve="true" />
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
import { Transmission, type TransmissionPassOptions } from './transmission.js';
import { alphaBlend } from '../../shared/pass.js';
import { applyView } from '../../shared/view-rect.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** A background render list for refraction. Selected layers composite once, before the transmission capture. */
export interface TransmissionLayersOptions extends TransmissionPassOptions {
  /** Order of background layers, after opaque/sky and before transmission. Default `order - 0.1`. */
  layerOrder?: number;
  /** Caller-owned OIT pass attached after layerOrder and before order; only needed by weighted layers. */
  weighted?: TransmissionBackgroundOIT;
}
/** An attached OIT background pass. The structural contract avoids a package dependency cycle. */
export interface TransmissionBackgroundOIT {
  readonly order: number;
  add(model: PBRModel): () => void;
}
/** Background surfaces use sorted alpha (default) or weighted blended OIT. A model belongs to one list at a time. */
export interface TransmissionLayerOptions {
  mode?: 'sorted' | 'weighted';
}

/**
 * Transmission with an explicit background render list, including alpha blends and weighted OIT.
 * `add` registers glass; `addLayer` registers surfaces behind that glass, just as an explicit refraction render list.
 * Foreground transparency stays in its later pass. Requires an HDR PostStack. Resources and model ownership are released
 * together; caller-owned models and materials are never disposed. Import this entry only when background layers are needed.
 */
export class TransmissionLayers implements EnginePlugin {
  readonly transmission: Transmission;
  private readonly weighted?: TransmissionBackgroundOIT;
  readonly name: string;
  readonly order: number;
  private engine?: Engine;
  private disposed = false;
  private readonly layers = new Map<PBRModel, { release: () => void; mode: 'sorted' | 'weighted' }>();
  private readonly ordered: PBRModel[] = [];
  private readonly distances = new Map<PBRModel, number>();
  private readonly glass = new Map<PBRModel, () => void>();
  private context?: Context;
  private pass?: GPURenderPassEncoder;
  private readonly hook: PBRTransparency & { targets: GPUColorTargetState[] } = {
    targets: [],
    declarations: () => `struct MargoTransparent {@location(0) color:vec4f}
fn margoTransparent(color:vec4f,i:Out)->MargoTransparent {var o:MargoTransparent;o.color=color;return o;}`,
    bindings: () => [],
    begin: () => {
      if (this.pass) return this.pass;
      const c = this.context!;
      this.pass = c.encoder.beginRenderPass({
        label: 'transmission-layers:sorted',
        colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true },
      });
      applyView(this.pass, c);
      return this.pass;
    },
  };

  static attach(engine: EngineKernel, options?: TransmissionLayersOptions): TransmissionLayers {
    const value = new TransmissionLayers(options);
    engineRuntime(engine).use(value);
    return value;
  }
  constructor({ order = 3, layerOrder = order - 0.1, weighted }: TransmissionLayersOptions = {}) {
    if (!Number.isFinite(layerOrder) || layerOrder <= 2 || layerOrder >= order)
      throw new RangeError(
        'Transmission layerOrder must be after sky (2) and before order; pass order 3 and layerOrder 2.9',
      );
    this.transmission = new Transmission({ order });
    if (weighted && (typeof weighted.add !== 'function' || !(weighted.order > layerOrder && weighted.order < order)))
      throw new RangeError('Background OIT must run after layerOrder and before order; attach OIT with order 2.95');
    this.weighted = weighted;
    this.name = 'layers:' + this.transmission.name;
    this.order = layerOrder;
  }
  /** Registers a refractive model; the returned remover restores its previous native tint path. */
  add(model: PBRModel): () => void {
    this.ready();
    if (this.layers.has(model))
      throw new MargoError('state', 'A glass model cannot be its own background; remove its layer first');
    let release = this.glass.get(model);
    if (release) return release;
    const restore = this.transmission.add(model);
    const forget = model.onDispose(() => {
      this.glass.delete(model);
    });
    release = () => {
      if (this.glass.get(model) !== release) return;
      this.glass.delete(model);
      forget();
      restore();
    };
    this.glass.set(model, release);
    return release;
  }
  /**
   * Moves a background model's BLEND surfaces out of beauty and into the background list. Opaque/MASK surfaces keep beauty.
   * Add each background through this owner rather than also registering it with another OIT pass.
   */
  addLayer(model: PBRModel, { mode = 'sorted' }: TransmissionLayerOptions = {}): () => void {
    this.ready();
    if (mode !== 'sorted' && mode !== 'weighted') throw new TypeError('Invalid layer mode; pass sorted or weighted');
    if (this.glass.has(model))
      throw new MargoError('state', 'A background cannot be its own glass; remove its glass registration first');
    const existing = this.layers.get(model);
    if (existing) {
      if (existing.mode !== mode)
        throw new MargoError('state', 'Layer already has another mode; remove it before changing mode');
      return existing.release;
    }
    if (mode === 'weighted' && !this.weighted)
      throw new MargoError(
        'state',
        'Weighted layers need a background OIT pass; pass weighted: OIT.attach(engine, { order: 2.95 })',
      );
    const restore = mode === 'weighted' ? this.weighted!.add(model) : model.setTransparency(this.hook);
    const forget = model.onDispose(() => {
      this.layers.delete(model);
    });
    const release = () => {
      if (this.layers.get(model)?.release !== release) return;
      this.layers.delete(model);
      forget();
      restore();
    };
    this.layers.set(model, { release, mode });
    return release;
  }
  private ready(): void {
    if (this.disposed || !this.engine)
      throw new MargoError(
        this.disposed ? 'disposed' : 'state',
        'TransmissionLayers needs attach on a live engine; create a new attached instance',
      );
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'TransmissionLayers is disposed; create a new instance');
    this.transmission.setup(engine);
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.render(c);
      },
    });
    this.transmission.registerPasses(graph);
  }
  private render(c: Context): void {
    this.context = c;
    this.hook.targets = [{ format: c.format, blend: alphaBlend }];
    const eye = c.camera.position;
    const distance = (model: PBRModel) => {
      const b = model.bounds;
      return Math.hypot((b[0] + b[3]) * 0.5 - eye[0], (b[1] + b[4]) * 0.5 - eye[1], (b[2] + b[5]) * 0.5 - eye[2]);
    };
    for (const [model, { mode }] of this.layers)
      if (mode === 'sorted') {
        this.ordered.push(model);
        this.distances.set(model, distance(model));
      }
    this.ordered.sort((a, b) => this.distances.get(b)! - this.distances.get(a)!);
    try {
      for (const model of this.ordered) model.drawTransparent(c, this.hook);
    } finally {
      this.pass?.end();
      this.pass = undefined;
      this.context = undefined;
      this.ordered.length = 0;
      this.distances.clear();
    }
  }
  onDeviceRestored(engine: Engine): void {
    this.transmission.onDeviceRestored(engine);
    this.engine = engine;
  }
  /** Restores each model and releases captures and OIT attachments. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { release } of [...this.layers.values()]) release();
    for (const release of [...this.glass.values()]) release();
    this.transmission.dispose();
    this.engine?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
