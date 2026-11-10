/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Stats } from './index.js';

/** Submitted geometry, including repeated indexed vertices and every instance. */
export interface GeometryReport {
  triangles: number;
  vertices: number;
  instances: number;
  drawCalls: number;
  /** Indirect commands whose arguments were not supplied by the application. */
  unknownDraws: number;
}

/** Optional CPU metadata for indirect commands; read at draw time, never cached. */
export interface GeometryOptions {
  indirect?: (buffer: GPUBuffer, offset: number, indexed: boolean) => { count: number; instances: number } | undefined;
}

/** Draw-argument counters for WebGPU and WebGL2, without reading back geometry. */
export class GeometryStats implements EnginePlugin {
  readonly name = 'stats-geometry';
  triangles = 0;
  vertices = 0;
  instances = 0;
  drawCalls = 0;
  unknownDraws = 0;
  private engine?: Engine;
  private disposed = false;
  private frameOpen = false;
  private readonly pipelines = new WeakMap<GPURenderPipeline, GPUPrimitiveTopology>();
  private readonly encoders = new WeakSet<GPUCommandEncoder>();
  private readonly devices = new WeakSet<GPUDevice>();
  private readonly contexts = new WeakSet<WebGL2RenderingContext>();
  private readonly restores: (() => void)[] = [];
  private row?: HTMLElement;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: GeometryOptions = {}) {}

  /** Attach to an engine; all its views in one task contribute to one frame. */
  static attach(engine: EngineKernel, options: GeometryOptions = {}): GeometryStats {
    const result = new GeometryStats(options);
    engine.use(result);
    return result;
  }

  private alive(): void {
    if (this.disposed) throw new MargoError('disposed', 'GeometryStats is disposed; create a new counter.');
  }

  /** Reset the counters once before recording a custom frame. */
  beginFrame(): void {
    this.alive();
    this.triangles = this.vertices = this.instances = this.drawCalls = this.unknownDraws = 0;
  }

  private count(count: number, instances: number, topology: GPUPrimitiveTopology | number): void {
    if (this.disposed) return;
    this.drawCalls++;
    if (count === 0 || instances === 0) return;
    this.vertices += count * instances;
    this.instances += instances;
    if (topology === 'triangle-list' || topology === 4) this.triangles += Math.floor(count / 3) * instances;
    if (topology === 'triangle-strip' || topology === 5 || topology === 6)
      this.triangles += Math.max(0, count - 2) * instances;
  }

  /** Describe a pipeline made before tracking began. Unregistered pipelines default to triangle-list. */
  pipeline(pipeline: GPURenderPipeline, topology: GPUPrimitiveTopology): this {
    this.alive();
    this.pipelines.set(pipeline, topology);
    return this;
  }

  /** Capture topology of future pipelines, including asynchronous pipeline creation. */
  trackDevice(device: GPUDevice): void {
    this.alive();
    if (this.devices.has(device)) return;
    this.devices.add(device);
    const create = device.createRenderPipeline,
      asyncCreate = device.createRenderPipelineAsync;
    const sync: GPUDevice['createRenderPipeline'] = (descriptor) => {
      const result = create.call(device, descriptor);
      this.pipelines.set(result, descriptor.primitive?.topology ?? 'triangle-list');
      return result;
    };
    const async: GPUDevice['createRenderPipelineAsync'] = async (descriptor) => {
      const result = await asyncCreate.call(device, descriptor);
      this.pipelines.set(result, descriptor.primitive?.topology ?? 'triangle-list');
      return result;
    };
    device.createRenderPipeline = sync;
    device.createRenderPipelineAsync = async;
    this.restores.push(() => {
      if (device.createRenderPipeline === sync) device.createRenderPipeline = create;
      if (device.createRenderPipelineAsync === async) device.createRenderPipelineAsync = asyncCreate;
    });
  }

  /** Wrap render passes on a custom encoder. Existing Stats wrappers compose in either order. */
  track(encoder: GPUCommandEncoder): void {
    this.alive();
    if (this.encoders.has(encoder)) return;
    this.encoders.add(encoder);
    const begin = encoder.beginRenderPass;
    encoder.beginRenderPass = (descriptor) => {
      const pass = begin.call(encoder, descriptor);
      let topology: GPUPrimitiveTopology = 'triangle-list';
      const pipeline = pass.setPipeline,
        draw = pass.draw,
        indexed = pass.drawIndexed,
        indirect = pass.drawIndirect,
        indexedIndirect = pass.drawIndexedIndirect;
      pass.setPipeline = (value) => {
        pipeline.call(pass, value);
        topology = this.pipelines.get(value) ?? 'triangle-list';
      };
      pass.draw = (count, instances = 1, first = 0, firstInstance = 0) => {
        draw.call(pass, count, instances, first, firstInstance);
        this.count(count, instances, topology);
      };
      pass.drawIndexed = (count, instances = 1, first = 0, base = 0, firstInstance = 0) => {
        indexed.call(pass, count, instances, first, base, firstInstance);
        this.count(count, instances, topology);
      };
      const countIndirect = (buffer: GPUBuffer, offset: number, isIndexed: boolean) => {
        if (this.disposed) return;
        const args = this.options.indirect?.(buffer, offset, isIndexed);
        if (args) this.count(args.count, args.instances, topology);
        else {
          this.drawCalls++;
          this.unknownDraws++;
        }
      };
      pass.drawIndirect = (buffer, offset) => {
        indirect.call(pass, buffer, offset);
        countIndirect(buffer, offset, false);
      };
      pass.drawIndexedIndirect = (buffer, offset) => {
        indexedIndirect.call(pass, buffer, offset);
        countIndirect(buffer, offset, true);
      };
      const bundles = pass.executeBundles;
      if (bundles)
        pass.executeBundles = (values) => {
          // An opaque bundle may contain arbitrarily many draws. Report it as unknown.
          const list = Array.from(values);
          bundles.call(pass, list);
          if (!this.disposed) this.unknownDraws += list.length;
        };
      return pass;
    };
  }

  /** Count native WebGL2 arrays, elements, range-elements and instanced commands. */
  trackGL(gl: WebGL2RenderingContext): void {
    this.alive();
    if (this.contexts.has(gl)) return;
    this.contexts.add(gl);
    const arrays = gl.drawArrays,
      elements = gl.drawElements,
      range = gl.drawRangeElements,
      ai = gl.drawArraysInstanced,
      ei = gl.drawElementsInstanced;
    const a: typeof arrays = (mode, first, count) => {
      arrays.call(gl, mode, first, count);
      this.count(count, 1, mode);
    };
    const e: typeof elements = (mode, count, type, offset) => {
      elements.call(gl, mode, count, type, offset);
      this.count(count, 1, mode);
    };
    const r: typeof range = (mode, start, end, count, type, offset) => {
      range.call(gl, mode, start, end, count, type, offset);
      this.count(count, 1, mode);
    };
    const aInst: typeof ai = (mode, first, count, instances) => {
      ai.call(gl, mode, first, count, instances);
      this.count(count, instances, mode);
    };
    const eInst: typeof ei = (mode, count, type, offset, instances) => {
      ei.call(gl, mode, count, type, offset, instances);
      this.count(count, instances, mode);
    };
    gl.drawArrays = a;
    gl.drawElements = e;
    gl.drawRangeElements = r;
    gl.drawArraysInstanced = aInst;
    gl.drawElementsInstanced = eInst;
    this.restores.push(() => {
      if (gl.drawArrays === a) gl.drawArrays = arrays;
      if (gl.drawElements === e) gl.drawElements = elements;
      if (gl.drawRangeElements === r) gl.drawRangeElements = range;
      if (gl.drawArraysInstanced === aInst) gl.drawArraysInstanced = ai;
      if (gl.drawElementsInstanced === eInst) gl.drawElementsInstanced = ei;
    });
  }

  setup(engine: Engine): void {
    this.alive();
    if (this.engine) throw new MargoError('attached', 'GeometryStats is attached; create one per engine.');
    this.engine = engine;
    if (engine.gpu) this.trackDevice(engine.gpu);
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'stats-geometry:begin',
      order: -Number.MAX_VALUE,
      execute: (context) => {
        if (!this.frameOpen) {
          this.beginFrame();
          this.frameOpen = true;
          queueMicrotask(() => {
            this.frameOpen = false;
          });
        }
        if (context.backend === 'webgpu') this.track(context.encoder);
        else this.trackGL(context.gl);
      },
    });
  }

  onDeviceRestored(engine: Engine): void {
    if (engine.gpu) this.trackDevice(engine.gpu);
    this.beginFrame();
  }

  /** Copy the current frame into a JSON-compatible report. */
  toJSON(): GeometryReport {
    return {
      triangles: this.triangles,
      vertices: this.vertices,
      instances: this.instances,
      drawCalls: this.drawCalls,
      unknownDraws: this.unknownDraws,
    };
  }

  /** Show geometry in an existing Stats overlay. */
  view(stats: Stats): this {
    this.alive();
    if (this.row) return this;
    const row = (this.row = stats.element.ownerDocument.createElement('div'));
    const show = () => {
      row.textContent = `${this.triangles} triangles  ${this.vertices} vertices  ${this.instances} instances${this.unknownDraws ? ` (${this.unknownDraws} unknown draws/bundles)` : ''}`;
    };
    stats.element.append(row);
    show();
    this.timer = setInterval(show, 150);
    return this;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
    for (const restore of this.restores.splice(0).reverse()) restore();
    clearInterval(this.timer);
    this.row?.remove();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
