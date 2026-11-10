/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { Selection, type SelectionOptions, type ModelLike, type PickingSource } from './index.js';
import { MargoError } from '@margoengine/math/errors';

/** A sinusoidal brightness pulse. Period is seconds (default 2); minimum is 0..1 (default 0.25). */
export interface OutlinePulse { period?: number; minimum?: number; }
/** Existing outline and hidden-line styling, plus an optional pulse (default true). */
export interface XRaySelectionOptions extends SelectionOptions { pulse?: boolean | OutlinePulse; }

/** Hidden and visible outlines with deterministic pulse time. Reuses Selection's current-pose and occlusion masks. */
export class XRaySelection implements EnginePlugin {
  readonly name: string;
  private readonly selection: Selection;
  private clock = 0;
  private manual = false;
  private disposed = false;
  constructor(readonly options: XRaySelectionOptions = {}) {
    this.name = options.name ?? 'selection-xray';
    this.selection = new Selection({ ...options, name: this.name, xray: options.xray ?? true });
    this.factor(0);
  }
  /** Attach one optional effect; dispose it or use Symbol.dispose to remove its passes and targets. */
  static attach(engine: EngineKernel, options: XRaySelectionOptions = {}): XRaySelection {
    const effect = new XRaySelection(options); engineRuntime(engine).use(effect); return effect;
  }
  /** Select live meshes, loader nodes or models. An empty set removes all outlines. */
  set(meshes: Iterable<Mesh | ModelLike>): void { this.selection.set(meshes); }
  /** Register custom current-pose GPU buffers; the returned function unregisters them. */
  add(source: PickingSource): () => void { return this.selection.add(source); }
  /** Seconds of pulse time. Setting it selects manual time, suitable for animation seeking and tests. */
  get time(): number { return this.clock; }
  set time(seconds: number) {
    if (!Number.isFinite(seconds)) throw new RangeError('Pulse time must be finite; pass seconds.');
    this.clock = seconds; this.manual = true;
  }
  /** Resume advancing time by the frame delta, starting at the current time. */
  play(): void { this.manual = false; }
  /** Borrowed visible mask from the last rendered frame. */
  get maskTexture(): GPUTexture | undefined { return this.selection.maskTexture; }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'XRaySelection is disposed; create a new effect.');
    this.selection.setup(engine);
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({name:this.name+':pulse',order:39.99,execute:c=>{
      if (!this.manual && (!c.view || c.view.index === 0)) this.clock += c.delta;
      const factor=this.factor(this.clock), o=this.options;
      Object.assign(this.selection.options,{algorithm:o.algorithm,width:o.width,
        color:(o.color ?? [1,0.5,0]).map(v=>v*factor),
        xray:o.xray===false ? false : {...(typeof o.xray==='object' ? o.xray : {}),
          color:(typeof o.xray==='object' ? o.xray.color ?? o.color ?? [1,0.5,0] : o.color ?? [1,0.5,0]).map(v=>v*factor),
          opacity:typeof o.xray==='object' ? o.xray.opacity : undefined}});
    }});
    this.selection.registerPasses(graph);
  }
  private factor(time: number): number {
    const pulse=this.options.pulse ?? true;
    if (pulse===false) return 1;
    if (pulse !== true && (!pulse || typeof pulse !== 'object'))
      throw new TypeError('Invalid outline pulse; pass true, false or an options object.');
    const {period=2,minimum=0.25}=typeof pulse==='object' ? pulse : {};
    if (!Number.isFinite(period) || period<=0 || !Number.isFinite(minimum) || minimum<0 || minimum>1)
      throw new RangeError('Invalid outline pulse; use a positive period in seconds and minimum 0..1.');
    return minimum+(1-minimum)*(0.5+0.5*Math.cos(time*2*Math.PI/period));
  }
  onDeviceRestored(engine: Engine): void { this.selection.onDeviceRestored(engine); }
  dispose(): void { if(this.disposed)return;this.disposed=true;this.selection.dispose(); }
  [Symbol.dispose](): void { this.dispose(); }
}
