/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Stats } from './index.js';

/** A completed named GPU interval in milliseconds. */
export interface GLPassTime {
  name: string;
  milliseconds: number;
}
/** A completed asynchronous WebGL2 timer sample and current frame draw count. */
export interface GLStatsReport {
  supported: boolean;
  drawCalls: number;
  frameMilliseconds: number | null;
  passes: GLPassTime[];
  sampleId: number;
  droppedFrames: number;
}
/** Bounds on query storage. */
export interface GLStatsOptions {
  /** Named passes per sample, 1..128. Default 128. */
  maxPasses?: number;
  /** Outstanding frames, 1..8. Default 4. */
  maxPendingFrames?: number;
}
type Segment = { query: WebGLQuery; name: string | null };
type Sample = { segments: Segment[]; invalid: boolean };
type TimerExtension = { readonly TIME_ELAPSED_EXT: number; readonly GPU_DISJOINT_EXT: number };

/** WebGL2 asynchronous frame/pass GPU timers and native draw counters. */
export class GLStats implements EnginePlugin {
  readonly name = 'stats-gl';
  drawCalls = 0;
  frameMilliseconds: number | null = null;
  readonly passes: GLPassTime[] = [];
  sampleId = 0;
  droppedFrames = 0;
  private gl?: WebGL2RenderingContext;
  private ext?: TimerExtension;
  private current?: Sample;
  private active?: Segment;
  private frameOpen = false;
  private passName: string | null = null;
  private passCount = 0;
  private readonly pending: Sample[] = [];
  private readonly pool: WebGLQuery[] = [];
  private readonly restore: (() => void)[] = [];
  private engine?: Engine;
  private disposed = false;
  private row?: HTMLElement;
  private timer?: ReturnType<typeof setInterval>;
  private readonly maxPasses: number;
  private readonly maxPending: number;

  constructor({ maxPasses = 128, maxPendingFrames = 4 }: GLStatsOptions = {}) {
    if (!Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 128)
      throw new RangeError('Invalid maxPasses; use an integer from 1 to 128.');
    if (!Number.isInteger(maxPendingFrames) || maxPendingFrames < 1 || maxPendingFrames > 8)
      throw new RangeError('Invalid maxPendingFrames; use an integer from 1 to 8.');
    this.maxPasses = maxPasses;
    this.maxPending = maxPendingFrames;
  }

  /** Attach before other optional plugins to name their registered passes automatically. */
  static attach(engine: EngineKernel, options: GLStatsOptions = {}): GLStats {
    const result = new GLStats(options);
    engine.use(result);
    return result;
  }

  get supported(): boolean {
    return !!this.ext && !this.gl?.isContextLost();
  }

  private alive(): void {
    if (this.disposed) throw new MargoError('disposed', 'GLStats is disposed; create a new profiler.');
  }

  /** Wrap draws on a context. Reattaching after context restoration reacquires the extension. */
  track(gl: WebGL2RenderingContext): void {
    this.alive();
    if (this.gl === gl) return;
    if (this.gl) throw new MargoError('attached', 'GLStats already tracks a context; create one per context.');
    this.gl = gl;
    this.ext = (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null) ?? undefined;
    const methods = [
      'drawArrays',
      'drawElements',
      'drawRangeElements',
      'drawArraysInstanced',
      'drawElementsInstanced',
    ] as const;
    for (const name of methods) {
      const original = gl[name];
      const wrapped = (...args: number[]) => {
        Reflect.apply(original, gl, args);
        if (!this.disposed && this.frameOpen) this.drawCalls++;
      };
      Object.assign(gl, { [name]: wrapped });
      this.restore.push(() => {
        if (gl[name] === wrapped) Object.assign(gl, { [name]: original });
      });
    }
    const lost = () => {
        this.clear();
        this.ext = undefined;
        this.frameOpen = false;
      },
      restored = () => {
        if (!this.disposed)
          this.ext = (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null) ?? undefined;
      };
    gl.canvas.addEventListener('webglcontextlost', lost);
    gl.canvas.addEventListener('webglcontextrestored', restored);
    this.restore.push(() => {
      gl.canvas.removeEventListener('webglcontextlost', lost);
      gl.canvas.removeEventListener('webglcontextrestored', restored);
    });
  }

  private start(name: string | null): void {
    if (!this.current || this.current.invalid || !this.ext) return;
    const gl = this.gl!,
      query = this.pool.pop() ?? gl.createQuery();
    if (!query) {
      this.clear();
      this.frameOpen = false;
      this.passName = null;
      throw new MargoError('failed', 'Cannot allocate a GL timer query; reduce profiler capacity.');
    }
    const segment = { query, name };
    this.current.segments.push(segment);
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = segment;
  }
  private end(): void {
    if (this.active && this.ext) this.gl!.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = undefined;
  }

  /** Begin a custom frame. Pending samples are polled without blocking. */
  beginFrame(gl?: WebGL2RenderingContext): boolean {
    this.alive();
    if (gl) this.track(gl);
    if (!this.gl) throw new MargoError('state', 'No WebGL2 context; call track(gl) or beginFrame(gl) first.');
    if (this.frameOpen) throw new MargoError('state', 'A GL frame is open; call endFrame() before beginning another.');
    this.poll();
    this.drawCalls = 0;
    this.passCount = 0;
    this.passName = null;
    this.frameOpen = true;
    if (!this.supported) return false;
    if (this.pending.length >= this.maxPending || this.gl.getQuery(this.ext!.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY)) {
      this.droppedFrames++;
      return false;
    }
    this.current = { segments: [], invalid: false };
    this.start(null);
    return true;
  }

  /** Begin a non-nested named GPU pass; disjoint samples are discarded as a whole. */
  beginPass(name: string): void {
    this.alive();
    if (!this.frameOpen || this.passName !== null)
      throw new MargoError('state', 'Pass requires an open frame and no open pass; call endPass() first.');
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('Invalid pass name; use a non-empty string.');
    this.end();
    this.passName = name;
    if (++this.passCount > this.maxPasses && this.current) this.current.invalid = true;
    this.start(name);
  }

  endPass(): void {
    this.alive();
    if (this.passName === null) throw new MargoError('state', 'No pass is open; call beginPass(name) first.');
    this.end();
    this.passName = null;
    this.start(null);
  }

  /** Enclose a synchronous pass, restoring query state even when it throws. */
  pass<T>(name: string, work: () => T): T {
    this.beginPass(name);
    try {
      return work();
    } finally {
      this.endPass();
    }
  }

  endFrame(): void {
    this.alive();
    if (!this.frameOpen) throw new MargoError('state', 'No frame is open; call beginFrame() first.');
    this.end();
    this.passName = null;
    this.frameOpen = false;
    if (this.current) {
      this.pending.push(this.current);
      this.current = undefined;
    }
  }

  private recycle(sample: Sample): void {
    for (const segment of sample.segments) this.pool.push(segment.query);
  }
  private clear(): void {
    this.end();
    if (this.current) this.recycle(this.current);
    this.current = undefined;
    for (const sample of this.pending.splice(0)) this.recycle(sample);
    for (const query of this.pool.splice(0)) this.gl!.deleteQuery(query);
    this.frameMilliseconds = null;
    this.passes.length = 0;
  }

  /** Read only queries whose availability is true; call from a later task/frame. */
  poll(): boolean {
    this.alive();
    if (!this.supported) {
      if (this.gl?.isContextLost()) this.clear();
      return false;
    }
    const gl = this.gl!,
      ext = this.ext!;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      this.clear();
      return false;
    }
    let updated = false;
    while (this.pending.length) {
      const sample = this.pending[0];
      if (!sample.segments.every(({ query }) => gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE))) break;
      this.pending.shift();
      const values = sample.segments.map(({ query }) => Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6);
      if (sample.invalid || values.some((value) => !Number.isFinite(value) || value < 0)) {
        this.frameMilliseconds = null;
        this.passes.length = 0;
      } else {
        this.frameMilliseconds = values.reduce((sum, value) => sum + value, 0);
        this.passes.length = 0;
        sample.segments.forEach(({ name }, i) => {
          if (name !== null) this.passes.push({ name, milliseconds: values[i] });
        });
        this.sampleId++;
        updated = true;
      }
      this.recycle(sample);
    }
    return updated;
  }

  setup(engine: Engine): void {
    this.alive();
    if (this.engine) throw new MargoError('attached', 'GLStats is attached; create one per engine.');
    this.engine = engine;
  }

  registerPasses(graph: FrameGraph): void {
    const execute = graph.execute,
      add = graph.add;
    const wrapped: typeof execute = (context) => {
      if (this.disposed || context.backend !== 'webgl2') return execute.call(graph, context);
      const draw = context.draw;
      if (!this.frameOpen) {
        this.beginFrame(context.gl);
        queueMicrotask(() => {
          if (!this.disposed && this.frameOpen) this.endFrame();
        });
      }
      context.draw = (options) =>
        this.passName === null ? this.pass('main', () => draw.call(context, options)) : draw.call(context, options);
      try {
        execute.call(graph, context);
      } finally {
        context.draw = draw;
      }
    };
    const wrappedAdd: typeof add = (pass) =>
      add.call(graph, {
        ...pass,
        execute: (context) => {
          if (this.disposed || context.backend !== 'webgl2' || !this.frameOpen || this.passName !== null)
            return pass.execute(context);
          return this.pass(pass.name, () => pass.execute(context));
        },
      });
    graph.execute = wrapped;
    graph.add = wrappedAdd;
    this.restore.push(() => {
      if (graph.execute === wrapped) graph.execute = execute;
      if (graph.add === wrappedAdd) graph.add = add;
    });
  }

  /** JSON snapshot of the current counters and last complete GPU sample. */
  toJSON(): GLStatsReport {
    return {
      supported: this.supported,
      drawCalls: this.drawCalls,
      frameMilliseconds: this.frameMilliseconds,
      passes: this.passes.map((pass) => ({ ...pass })),
      sampleId: this.sampleId,
      droppedFrames: this.droppedFrames,
    };
  }

  view(stats: Stats): this {
    this.alive();
    if (this.row) return this;
    const row = (this.row = stats.element.ownerDocument.createElement('div'));
    row.style.whiteSpace = 'pre-line';
    const show = () => {
      row.textContent =
        `WebGL2 ${this.drawCalls} draws GPU ${this.frameMilliseconds === null ? (this.supported ? 'warming up' : 'unavailable') : this.frameMilliseconds.toFixed(2) + ' ms'}\n` +
        this.passes.map((pass) => `${pass.name}: ${pass.milliseconds.toFixed(2)} ms`).join('\n');
    };
    stats.element.append(row);
    show();
    this.timer = setInterval(show, 150);
    return this;
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
    for (const restore of this.restore.splice(0).reverse()) restore();
    clearInterval(this.timer);
    this.row?.remove();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
