/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Stats } from './index.js';

/** CPU milliseconds of one frame by phase. The phases add up to `total`. */
export interface FramePhaseTimes {
  /** `onFrame` callbacks, plugin updates, resize and camera, up to the kernel tick. */
  update: number;
  /** The kernel tick: world matrices and the frustum test, one Wasm call. */
  tick: number;
  /** Collecting the visible instances into batches and preparing the frame, up to the command encoder. */
  cull: number;
  /** Recording commands: every frame graph pass, then `encoder.finish()`. */
  encode: number;
  /** `queue.submit`. */
  submit: number;
  /** Anything else inside the frame. */
  other: number;
  /** The first phase's start to the end of the frame's task. */
  total: number;
}
/** What {@link FramePhases.toJSON} returns; safe for `JSON.stringify`. */
export interface FramePhasesReport {
  frames: number;
  last: FramePhaseTimes;
  average: FramePhaseTimes;
}
/** Options for {@link FramePhases}. */
export interface FramePhasesOptions {
  /** Frames in the rolling average, 2..4096. Default 120. */
  samples?: number;
}

const NAMES = ['update', 'tick', 'cull', 'encode', 'submit', 'other', 'total'] as const;
const UPDATE = 0,
  TICK = 1,
  CULL = 2,
  ENCODE = 3,
  SUBMIT = 4,
  OTHER = 5,
  TOTAL = 6,
  CLOSED = -1;
const times = (): FramePhaseTimes => ({ update: 0, tick: 0, cull: 0, encode: 0, submit: 0, other: 0, total: 0 });

/**
 * Times the CPU side of each frame in phases, with no change to core: it wraps `store.tick`, `createCommandEncoder`
 * and `queue.submit` and adds two frame graph passes. Nothing is allocated per frame. A frame ends when its task does,
 * so read the numbers from the next frame or later. Views in one frame add up into that frame.
 */
export class FramePhases implements EnginePlugin {
  readonly name = 'frame-phases';
  /** Frames finished since attach. */
  frames = 0;
  /** The newest finished frame. One object, updated in place. */
  readonly last: FramePhaseTimes = times();
  private readonly ring: Float64Array;
  private readonly size: number;
  private readonly open = new Float64Array(6);
  private phase = CLOSED;
  private mark = 0;
  private started = 0;
  private ended = false;
  private engine?: Engine;
  private removeFrameListener?: () => void;
  private restoreDevice?: () => void;
  private restoreStore?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private row?: HTMLElement;
  private disposed = false;

  /** Adds it to an engine; `dispose()` takes it off. */
  static attach(engine: EngineKernel, options: FramePhasesOptions = {}): FramePhases {
    const phases = new FramePhases(options);
    engine.use(phases);
    return phases;
  }
  constructor({ samples = 120 }: FramePhasesOptions = {}) {
    if (!Number.isInteger(samples) || samples < 2 || samples > 4096)
      throw new RangeError('Sample count must be 2..4096');
    this.size = samples;
    this.ring = new Float64Array(samples * NAMES.length);
  }

  private enter(phase: number): void {
    const now = performance.now();
    this.open[this.phase] += now - this.mark;
    this.mark = now;
    this.phase = phase;
  }
  private readonly begin = (): void => {
    if (this.phase !== CLOSED || this.disposed) return;
    this.open.fill(0);
    this.ended = false;
    this.started = this.mark = performance.now();
    this.phase = UPDATE;
    queueMicrotask(this.close);
  };
  private readonly close = (): void => {
    if (this.disposed) return;
    this.enter(CLOSED);
    const slot = (this.frames++ % this.size) * NAMES.length,
      { last, open, ring } = this;
    for (let i = 0; i < TOTAL; i++) last[NAMES[i]] = ring[slot + i] = open[i];
    last.total = ring[slot + TOTAL] = this.mark - this.started;
  };

  /** The mean of each phase over the frames kept. */
  average(): FramePhaseTimes {
    const result = times(),
      count = Math.min(this.frames, this.size);
    for (let frame = 0; frame < count; frame++)
      for (let i = 0; i <= TOTAL; i++) result[NAMES[i]] += this.ring[frame * NAMES.length + i] / count;
    return result;
  }
  /** A copy of the numbers. */
  toJSON(): FramePhasesReport {
    return { frames: this.frames, last: { ...this.last }, average: this.average() };
  }
  /** Shows the averages in a row of the Stats panel, refreshed twice a second until `dispose()`. */
  view(stats: Stats): this {
    if (this.row) return this;
    const row = (this.row = stats.element.ownerDocument.createElement('div')),
      show = () => {
        const a = this.average(),
          ms = (value: number) => value.toFixed(2);
        row.textContent = `CPU ${ms(a.total)} ms\nupdate ${ms(a.update)}  tick ${ms(a.tick)}  cull ${ms(a.cull)}\nencode ${ms(a.encode)}  submit ${ms(a.submit)}`;
      };
    row.style.whiteSpace = 'pre-line';
    stats.element.append(row);
    show();
    this.timer = setInterval(show, 500);
    return this;
  }

  private wrapDevice(device: GPUDevice): void {
    const { queue } = device,
      { createCommandEncoder } = device,
      { submit } = queue,
      encoder: GPUDevice['createCommandEncoder'] = (descriptor) => {
        if (this.phase === CULL) this.enter(ENCODE);
        return createCommandEncoder.call(device, descriptor);
      },
      wrapped: GPUQueue['submit'] = (commands) => {
        const before = this.phase;
        if (before === CLOSED) return submit.call(queue, commands);
        this.enter(SUBMIT);
        submit.call(queue, commands);
        // A pass can submit its own work mid-frame; that goes back to recording. The frame's own submit comes last.
        this.enter(this.ended ? OTHER : before);
      };
    device.createCommandEncoder = encoder;
    queue.submit = wrapped;
    this.restoreDevice = () => {
      // Something that wrapped these after us owns them now; writing the originals back would remove it.
      if (device.createCommandEncoder === encoder) device.createCommandEncoder = createCommandEncoder;
      if (queue.submit === wrapped) queue.submit = submit;
      this.restoreDevice = undefined;
    };
  }
  setup(engine: Engine): void {
    if (this.disposed)
      throw new MargoError('disposed', 'FramePhases is disposed; create a new one and add it to the engine.');
    if (this.engine)
      throw new MargoError('attached', 'FramePhases is already attached to an engine; create one per engine.');
    this.engine = engine;
    this.removeFrameListener = engine.onFrame(this.begin);
    const { store } = engine,
      { tick } = store,
      wrapped: typeof tick = (culling) => {
        if (this.phase === CLOSED) return tick.call(store, culling);
        this.enter(TICK);
        tick.call(store, culling);
        this.enter(CULL);
      };
    store.tick = wrapped;
    this.restoreStore = () => {
      if (store.tick === wrapped) store.tick = tick;
    };
    if (engine.gpu) this.wrapDevice(engine.gpu);
  }
  onPreUpdate(): void {
    this.begin();
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'frame-phases:begin',
      order: -Number.MAX_VALUE,
      execute: () => {
        this.ended = false;
        // WebGPU reached this phase at createCommandEncoder; WebGL2 has no encoder.
        if (this.phase === CULL) this.enter(ENCODE);
      },
    });
    graph.add({
      name: 'frame-phases:end',
      order: Number.MAX_VALUE,
      execute: (context) => {
        this.ended = true;
        if (context.backend !== 'webgpu' && this.phase === ENCODE) this.enter(OTHER);
      },
    });
  }
  onDeviceRestored(engine: Engine): void {
    this.restoreDevice?.();
    if (engine.gpu) this.wrapDevice(engine.gpu);
  }
  /** Stops timing and removes the view; the engine goes back to its own calls. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeFrameListener?.();
    this.removeFrameListener = undefined;
    this.engine?.removePlugin(this.name);
    this.engine = undefined;
    this.restoreDevice?.();
    this.restoreStore?.();
    clearInterval(this.timer);
    this.row?.remove();
    this.row = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
