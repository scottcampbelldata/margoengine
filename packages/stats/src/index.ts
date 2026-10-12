import type {EngineKernel} from '@margoengine/core';
import type {Engine, EnginePlugin, FrameGraph} from '@margoengine/core/extension';
import {GPUProfiler} from './profiler.js';
export {GPUProfiler};

export interface StatsOptions {
  parent?: HTMLElement;
  /** Number of rolling frame samples, 2..4096. Default 120. */
  samples?: number;
  /** Profile passes when timestamp-query is already enabled on the device. */
  profiling?: boolean;
}

export class Stats implements EnginePlugin {
  readonly name = 'stats';
  readonly samples: Float64Array;
  readonly element: HTMLDivElement;
  readonly graph: HTMLCanvasElement;
  fps = 0;
  frameTime = 0;
  drawCalls = 0;
  dispatches = 0;
  gpuTime: number | null = null;
  sampleCount = 0;
  sampleIndex = 0;
  private total = 0;
  private last = 0;
  private engine?: Engine;
  private profiler?: GPUProfiler;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly text: HTMLElement;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly tracked = new WeakSet<GPUCommandEncoder>();
  private disposed = false;
  private readonly profiling: boolean;

  constructor({parent = document.body, samples = 120, profiling = false}: StatsOptions = {}) {
    if (!Number.isInteger(samples) || samples < 2 || samples > 4096) throw new RangeError('Sample count must be 2..4096');
    if (typeof profiling !== 'boolean') throw new TypeError('profiling must be boolean');
    this.profiling = profiling; this.samples = new Float64Array(samples);
    const doc = parent.ownerDocument;
    this.element = doc.createElement('div'); this.element.dataset.margoStats = '';
    this.element.style.cssText = 'position:fixed;top:12px;left:12px;width:224px;max-width:calc(100vw - 24px);padding:10px;box-sizing:border-box;background:#202226;color:#f5f7fa;border:1px solid #4b5058;border-radius:4px;font:12px/1.5 monospace;z-index:10000;pointer-events:none';
    this.text = doc.createElement('div'); this.text.style.whiteSpace = 'pre-line';
    this.graph = doc.createElement('canvas'); this.graph.width = samples; this.graph.height = 52;
    this.graph.style.cssText = 'display:block;width:100%;height:52px;margin-top:6px';
    this.graph.setAttribute('role', 'img'); this.graph.setAttribute('aria-label', 'Rolling frame time in milliseconds');
    this.context = this.graph.getContext('2d');
    this.element.append(this.text, this.graph); parent.append(this.element);
    this.refresh(); this.timer = setInterval(() => this.refresh(), 250);
  }

  static attach(engine: EngineKernel, options: StatsOptions = {}): Stats {
    const stats = new Stats(options); try {engine.use(stats); return stats;} catch (error) {stats.dispose(); throw error;}
  }

  /** Numeric sampling only: no DOM writes, arrays, strings or callbacks are created here. */
  tick(milliseconds: number, drawCalls = this.drawCalls, dispatches = this.dispatches): void {
    if (this.disposed) throw new Error('Stats is disposed');
    if (!Number.isFinite(milliseconds) || milliseconds <= 0 ||
      !Number.isSafeInteger(drawCalls) || drawCalls < 0 || !Number.isSafeInteger(dispatches) || dispatches < 0) throw new RangeError('Invalid frame sample or counters');
    const index = this.sampleIndex;
    this.total += milliseconds - this.samples[index]; this.samples[index] = milliseconds;
    if (this.sampleCount < this.samples.length) this.sampleCount++;
    this.sampleIndex = (index + 1) % this.samples.length;
    this.frameTime = this.total / this.sampleCount; this.fps = 1000 / this.frameTime;
    this.drawCalls = drawCalls; this.dispatches = dispatches;
  }

  enableGPUProfiling(device: GPUDevice): boolean {
    if (this.disposed) throw new Error('Stats is disposed');
    this.profiler?.dispose(); this.profiler = new GPUProfiler(device); this.gpuTime = null;
    return this.profiler.supported;
  }

  /** Counts direct/indirect commands on this encoder; pass wrappers are separate from tick(). */
  track(encoder: GPUCommandEncoder): void {
    if (this.disposed) throw new Error('Stats is disposed');
    if (this.tracked.has(encoder)) return;
    this.tracked.add(encoder); this.drawCalls = this.dispatches = 0;
    const stats = this, profiler = this.profiler;
    profiler?.beginFrame();
    const render = encoder.beginRenderPass, compute = encoder.beginComputePass, finish = encoder.finish;
    encoder.beginRenderPass = function(descriptor) {
      const writes = descriptor.timestampWrites ? undefined : profiler?.timestampWrites();
      const pass = render.call(this, writes ? {...descriptor, timestampWrites: writes} : descriptor);
      const draw = pass.draw, indexed = pass.drawIndexed, indirect = pass.drawIndirect, indexedIndirect = pass.drawIndexedIndirect;
      pass.draw = function(v, n = 1, first = 0, instance = 0) {stats.drawCalls++; draw.call(this, v, n, first, instance);};
      pass.drawIndexed = function(v, n = 1, first = 0, base = 0, instance = 0) {stats.drawCalls++; indexed.call(this, v, n, first, base, instance);};
      pass.drawIndirect = function(buffer, offset) {stats.drawCalls++; indirect.call(this, buffer, offset);};
      pass.drawIndexedIndirect = function(buffer, offset) {stats.drawCalls++; indexedIndirect.call(this, buffer, offset);};
      return pass;
    };
    encoder.beginComputePass = function(descriptor = {}) {
      const writes = descriptor.timestampWrites ? undefined : profiler?.timestampWrites();
      const pass = compute.call(this, writes ? {...descriptor, timestampWrites: writes} : descriptor);
      const dispatch = pass.dispatchWorkgroups, indirect = pass.dispatchWorkgroupsIndirect;
      pass.dispatchWorkgroups = function(x, y = 1, z = 1) {stats.dispatches++; dispatch.call(this, x, y, z);};
      pass.dispatchWorkgroupsIndirect = function(buffer, offset) {stats.dispatches++; indirect.call(this, buffer, offset);};
      return pass;
    };
    encoder.finish = function(descriptor) {
      const resolved = profiler?.resolve(this), result = finish.call(this, descriptor);
      if (resolved) queueMicrotask(() => {
        void profiler!.read().then(value => {if (!stats.disposed && stats.profiler === profiler && value !== null) stats.gpuTime = value;}, error => stats.engine?.onError(error));
      });
      return result;
    };
  }

  setup(engine: Engine): void {
    if (this.disposed || this.engine) throw new Error('Stats is disposed or attached');
    this.engine = engine;
    if (this.profiling && engine.gpu) this.enableGPUProfiling(engine.gpu);
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({name: 'stats:begin', order: -Number.MAX_VALUE, execute: context => {if (context.backend === 'webgpu') this.track(context.encoder);}});
    graph.add({name: 'stats:sample', order: Number.MAX_VALUE, execute: context => {
      const now = performance.now(), milliseconds = this.last ? now - this.last : context.delta * 1000;
      this.last = now;
      if (milliseconds > 0) this.tick(milliseconds, context.backend === 'webgpu' ? this.drawCalls : this.engine!.stats.drawCalls, this.dispatches);
    }});
  }

  refresh(): void {
    if (this.disposed) return;
    this.text.textContent = `${this.fps.toFixed(0)} FPS  ${this.frameTime.toFixed(2)} ms\n${this.drawCalls} draws  ${this.dispatches} dispatches\nGPU ${this.gpuTime === null ? 'unavailable' : this.gpuTime.toFixed(2) + ' ms'}`;
    const c = this.context;
    if (!c) return;
    const width = this.graph.width, height = this.graph.height;
    c.fillStyle = '#151719'; c.fillRect(0, 0, width, height);
    let ceiling = 33.3;
    for (let i = 0; i < this.sampleCount; i++) ceiling = Math.max(ceiling, this.samples[i]);
    c.strokeStyle = '#6c757d'; c.beginPath(); c.moveTo(0, height * (1 - 16.67 / ceiling)); c.lineTo(width, height * (1 - 16.67 / ceiling)); c.stroke();
    c.strokeStyle = '#63d9b0'; c.beginPath();
    const start = this.sampleCount === width ? this.sampleIndex : 0;
    for (let i = 0; i < this.sampleCount; i++) {
      const y = height - 1 - this.samples[(start + i) % width] / ceiling * (height - 2);
      if (i === 0) c.moveTo(i, y); else c.lineTo(i, y);
    }
    c.stroke();
  }

  onDeviceRestored(engine: Engine): void {
    this.profiler?.dispose(); this.profiler = undefined; this.gpuTime = null; this.last = 0;
    if (this.profiling && engine.gpu) this.enableGPUProfiling(engine.gpu);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.engine?.removePlugin(this.name); this.engine = undefined;
    clearInterval(this.timer); this.profiler?.dispose(); this.element.remove();
  }
}
