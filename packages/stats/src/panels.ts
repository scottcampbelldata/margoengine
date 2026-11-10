/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { Stats } from './index.js';
import { GPUMemory } from './report.js';
import { FramePhases } from './phases.js';
import { GLStats, type GLPassTime } from './gl.js';
import { PanelGPU } from './panel-gpu.js';

/** A custom-loop sample. GPU and memory are null when unavailable. */
export interface PanelSample {
  fps: number;
  cpuMilliseconds: number;
  gpuMilliseconds: number | null;
  memoryBytes: number | null;
  passes?: readonly GLPassTime[];
}
/** Panel construction and sampling options. */
export interface StatsPanelsOptions {
  /** Existing Stats overlay, if provided. Its ownership stays with the caller. */
  stats?: Stats;
  /** Parent for an owned Stats overlay. Default document.body. */
  parent?: HTMLElement;
  /** Fixed history capacity, 2..4096. Default 120. */
  samples?: number;
  /** DOM refresh interval, 16..60000 ms. Default 150. */
  refreshMilliseconds?: number;
  /** Custom memory sampler in bytes. Default tracked GPU resources, or browser JS heap when exposed. */
  memory?: () => number | null;
}
/** Oldest-first graph history; missing values are null, never fabricated zeros. */
export interface StatsPanelsReport {
  fps: (number | null)[];
  cpuMilliseconds: (number | null)[];
  gpuMilliseconds: (number | null)[];
  memoryBytes: (number | null)[];
  passes: GLPassTime[];
}
type Metric = 'fps' | 'cpuMilliseconds' | 'gpuMilliseconds' | 'memoryBytes';
const METRICS: readonly Metric[] = ['fps', 'cpuMilliseconds', 'gpuMilliseconds', 'memoryBytes'];

/** FPS, CPU, GPU and memory history with a named per-pass GPU list on both backends. */
export class StatsPanels implements EnginePlugin {
  readonly name = 'stats-panels';
  readonly stats: Stats;
  readonly element: HTMLDivElement;
  readonly graphs: Readonly<Record<Metric, HTMLCanvasElement>>;
  readonly series: Readonly<Record<Metric, Float64Array>>;
  sampleCount = 0;
  sampleIndex = 0;
  private readonly labels: Record<Metric, HTMLElement>;
  private readonly contexts: Record<Metric, CanvasRenderingContext2D | null>;
  private readonly list: HTMLElement;
  private readonly ownStats: boolean;
  private readonly graphDisplay: string;
  private readonly timer: ReturnType<typeof setInterval>;
  private engine?: Engine;
  private readonly phases = new FramePhases();
  private memory?: GPUMemory;
  private gpu?: PanelGPU;
  private gl?: GLStats;
  private gpuTime: number | null = null;
  private gpuPasses: GLPassTime[] = [];
  private latestPasses: GLPassTime[] = [];
  private queued = false;
  private disposed = false;
  private memoryLabel = 'Memory MiB';

  constructor(private readonly options: StatsPanelsOptions = {}) {
    const { samples = 120, refreshMilliseconds = 150 } = options;
    if (!Number.isInteger(samples) || samples < 2 || samples > 4096)
      throw new RangeError('Invalid samples; use an integer from 2 to 4096.');
    if (!Number.isFinite(refreshMilliseconds) || refreshMilliseconds < 16 || refreshMilliseconds > 60000)
      throw new RangeError('Invalid refreshMilliseconds; use 16 to 60000 milliseconds.');
    this.ownStats = !options.stats;
    this.stats = options.stats ?? new Stats({ parent: options.parent, samples });
    this.graphDisplay = this.stats.graph.style.display;
    this.stats.graph.style.display = 'none';
    const doc = this.stats.element.ownerDocument;
    this.element = doc.createElement('div');
    this.element.dataset.margoStatsPanels = '';
    this.element.style.cssText = 'max-height:calc(100vh - 120px);overflow:auto;pointer-events:auto';
    const graphs = {} as Record<Metric, HTMLCanvasElement>,
      series = {} as Record<Metric, Float64Array>,
      contexts = {} as Record<Metric, CanvasRenderingContext2D | null>,
      labels = {} as Record<Metric, HTMLElement>;
    for (const metric of METRICS) {
      const label = (labels[metric] = doc.createElement('div')),
        graph = (graphs[metric] = doc.createElement('canvas'));
      graph.width = samples;
      graph.height = 40;
      graph.style.cssText = 'display:block;width:100%;height:40px;margin:2px 0 6px';
      graph.setAttribute('role', 'img');
      contexts[metric] = graph.getContext('2d');
      series[metric] = new Float64Array(samples).fill(NaN);
      this.element.append(label, graph);
    }
    this.graphs = graphs;
    this.series = series;
    this.contexts = contexts;
    this.labels = labels;
    this.list = doc.createElement('div');
    this.list.style.whiteSpace = 'pre-line';
    this.list.setAttribute('aria-label', 'Named GPU pass durations');
    this.element.append(this.list);
    if (this.ownStats) {
      this.stats.element.style.width = '360px';
      this.stats.element.replaceChildren(this.element);
    } else this.stats.element.append(this.element);
    this.refresh();
    this.timer = setInterval(() => this.refresh(), refreshMilliseconds);
  }

  /** Attach with GPU timestamp support requested when creating a WebGPU engine. */
  static attach(engine: EngineKernel, options: StatsPanelsOptions = {}): StatsPanels {
    const panels = new StatsPanels(options);
    try {
      engine.use(panels);
      return panels;
    } catch (error) {
      panels.dispose();
      throw error;
    }
  }

  /** Add one validated custom sample to all four fixed-capacity histories. */
  sample(sample: PanelSample): void {
    if (this.disposed) throw new MargoError('disposed', 'StatsPanels is disposed; create a new overlay.');
    for (const metric of METRICS) {
      const value = sample[metric];
      if (value === null && (metric === 'gpuMilliseconds' || metric === 'memoryBytes')) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        throw new RangeError(
          'Invalid panel sample; use non-negative finite values or null for unavailable GPU/memory.',
        );
    }
    for (const pass of sample.passes ?? [])
      if (
        typeof pass.name !== 'string' ||
        !pass.name.trim() ||
        !Number.isFinite(pass.milliseconds) ||
        pass.milliseconds < 0
      )
        throw new RangeError('Invalid GPU pass; use a non-empty name and non-negative finite milliseconds.');
    for (const metric of METRICS) this.series[metric][this.sampleIndex] = sample[metric] ?? NaN;
    this.latestPasses = sample.gpuMilliseconds === null ? [] : (sample.passes ?? []).map((pass) => ({ ...pass }));
    this.sampleCount = Math.min(this.sampleCount + 1, this.series.fps.length);
    this.sampleIndex = (this.sampleIndex + 1) % this.series.fps.length;
  }

  private readonly collect = (): void => {
    this.queued = false;
    if (this.disposed) return;
    const gl = this.gl;
    gl?.poll();
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    const bytes = this.options.memory ? this.options.memory() : this.memory ? this.memory.bytes : (heap ?? null);
    this.memoryLabel = this.options.memory ? 'Memory MiB' : this.memory ? 'Tracked GPU MiB' : 'JS heap MiB';
    this.sample({
      fps: this.stats.fps,
      cpuMilliseconds: this.phases.last.total,
      gpuMilliseconds: gl ? gl.frameMilliseconds : this.gpuTime,
      memoryBytes: bytes,
      passes: gl ? gl.passes : this.gpuPasses,
    });
  };

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'StatsPanels is disposed; create a new overlay.');
    if (this.engine) throw new MargoError('attached', 'StatsPanels is attached; create one per engine.');
    this.engine = engine;
    if (this.ownStats) this.stats.setup(engine);
    this.phases.setup(engine);
    this.bindGPU(engine);
    if (!engine.gpu) {
      this.gl = new GLStats();
      this.gl.setup(engine);
    }
  }

  private bindGPU(engine: Engine): void {
    this.memory?.dispose();
    this.gpu?.dispose();
    this.gpuTime = null;
    this.gpuPasses = [];
    this.memory = undefined;
    this.gpu = undefined;
    if (engine.gpu) {
      this.memory = GPUMemory.attach(engine.gpu);
      this.gpu = new PanelGPU(
        engine.gpu,
        (value, passes) => {
          this.gpuTime = value;
          this.gpuPasses = passes;
        },
        (error) => engine.onError(error),
      );
    }
  }

  registerPasses(graph: FrameGraph): void {
    if (this.ownStats) this.stats.registerPasses(graph);
    this.phases.registerPasses(graph);
    this.gl?.registerPasses(graph);
    graph.add({
      name: 'stats-panels:sample',
      order: -Number.MAX_VALUE,
      execute: (context) => {
        if (context.backend === 'webgpu') this.gpu?.track(context.encoder);
        if (!this.queued) {
          this.queued = true;
          queueMicrotask(this.collect);
        }
      },
    });
  }

  onPreUpdate(): void {
    this.phases.onPreUpdate();
  }
  onDeviceRestored(engine: Engine): void {
    if (this.ownStats) this.stats.onDeviceRestored(engine);
    this.phases.onDeviceRestored(engine);
    this.bindGPU(engine);
  }

  /** Refresh DOM text and draw the histories; never called by sample(). */
  refresh(): void {
    if (this.disposed) return;
    for (const metric of METRICS) {
      const values = this.series[metric],
        graph = this.graphs[metric],
        c = this.contexts[metric],
        title =
          metric === 'fps'
            ? 'FPS'
            : metric === 'cpuMilliseconds'
              ? 'CPU ms'
              : metric === 'gpuMilliseconds'
                ? 'GPU ms'
                : this.memoryLabel,
        factor = metric === 'memoryBytes' ? 1 / 1048576 : 1;
      const latest = this.sampleCount ? values[(this.sampleIndex + values.length - 1) % values.length] : NaN;
      let sum = 0,
        count = 0,
        peak = 0;
      for (const value of values)
        if (Number.isFinite(value)) {
          sum += value;
          count++;
          peak = Math.max(peak, value);
        }
      const text = count
        ? `${title}: ${Number.isFinite(latest) ? (latest * factor).toFixed(2) : 'unavailable'}  avg ${((sum / count) * factor).toFixed(2)}  peak ${(peak * factor).toFixed(2)}`
        : `${title}: unavailable`;
      this.labels[metric].textContent = text;
      graph.setAttribute('aria-label', text);
      if (!c) continue;
      c.fillStyle = '#151719';
      c.fillRect(0, 0, graph.width, graph.height);
      c.strokeStyle =
        metric === 'fps'
          ? '#63d9b0'
          : metric === 'cpuMilliseconds'
            ? '#e6c76a'
            : metric === 'gpuMilliseconds'
              ? '#82b9ef'
              : '#d3a0e8';
      c.beginPath();
      let connected = false;
      for (let i = 0; i < this.sampleCount; i++) {
        const value = values[(this.sampleIndex - this.sampleCount + i + values.length) % values.length];
        if (!Number.isFinite(value)) {
          connected = false;
          continue;
        }
        const y = graph.height - 1 - (value / Math.max(peak, 1)) * (graph.height - 2);
        if (connected) c.lineTo(i, y);
        else c.moveTo(i, y);
        connected = true;
      }
      c.stroke();
    }
    this.list.textContent = this.latestPasses.length
      ? 'GPU passes\n' + this.latestPasses.map((pass) => `${pass.name}: ${pass.milliseconds.toFixed(2)} ms`).join('\n')
      : 'GPU passes unavailable';
  }

  /** Copy graph history in chronological order, with named pass results. */
  toJSON(): StatsPanelsReport {
    const history = {} as Record<Metric, (number | null)[]>;
    for (const metric of METRICS) {
      const values = this.series[metric];
      history[metric] = [];
      for (let i = 0; i < this.sampleCount; i++) {
        const value = values[(this.sampleIndex - this.sampleCount + i + values.length) % values.length];
        history[metric].push(Number.isFinite(value) ? value : null);
      }
    }
    return { ...history, passes: this.latestPasses.map((pass) => ({ ...pass })) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
    clearInterval(this.timer);
    this.phases.dispose();
    this.gpu?.dispose();
    this.gl?.dispose();
    this.memory?.dispose();
    this.element.remove();
    this.stats.graph.style.display = this.graphDisplay;
    if (this.ownStats) this.stats.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
