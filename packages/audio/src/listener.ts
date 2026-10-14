/// <reference lib="esnext.disposable" preserve="true" />
import type {EngineKernel, EnginePlugin} from '@margoengine/core';
import type {FrameGraph} from '@margoengine/core/extension';
import {normalize, smoothParam, type Vec3} from './math.js';
import {loadAudioBuffer, type LoadAudioOptions} from './loader.js';

export interface AudioListenerOptions {
  /** An existing context (for example an OfflineAudioContext) or a factory. Default: `new AudioContext()` on first use. */
  context?: BaseAudioContext | (() => BaseAudioContext);
  /** Master volume, default 1. */
  volume?: number;
  /** Resume a suspended context on the first pointer, key or touch gesture. Default true. */
  autoResume?: boolean;
  /** Time constant in seconds for parameter smoothing. 0 sets values immediately. Default 0.02. */
  smoothing?: number;
  /** Plugin and frame-pass name. Default `'margoengine-audio'`. */
  name?: string;
  /** Frame-pass order. Default 900, after the scene and overlay passes. */
  order?: number;
}

/** Internal contract between the listener and the sounds it owns. */
export interface ListenerSource {update(engine: EngineKernel | null): void; dispose(): void}

const gestures = ['pointerdown', 'mousedown', 'keydown', 'touchend'] as const;
const defaultForward: Vec3 = [0, 0, -1], defaultUp: Vec3 = [0, 1, 0];
const audioContextClass = (): (new () => AudioContext) => {
  const constructor = (globalThis as {AudioContext?: new () => AudioContext}).AudioContext;
  if (!constructor) throw new Error('Web Audio is unavailable in this environment');
  return constructor;
};

/**
 * The ears of the scene. As an engine plugin it follows `engine.camera` every frame: position, forward from the
 * camera position toward its target, Y up. Owns the master gain that every Audio and PositionalAudio feeds.
 * Counterpart of THREE.AudioListener. The AudioContext is created lazily on first use, never at import time.
 */
export class AudioListener implements EnginePlugin {
  readonly name: string;
  /** Last pose written to the Web Audio listener (world space). */
  readonly position = new Float64Array(3);
  readonly forward = new Float64Array([0, 0, -1]);
  readonly up = new Float64Array([0, 1, 0]);
  smoothing: number;
  readonly autoResume: boolean;
  private readonly order: number;
  private readonly source?: BaseAudioContext | (() => BaseAudioContext);
  private audioContext?: BaseAudioContext;
  private owned = false;
  private master?: GainNode;
  private volumeValue: number;
  private engine: EngineKernel | null = null;
  private readonly sources = new Set<ListenerSource>();
  private gestureTarget?: EventTarget;
  private written = false;
  private readonly cameraForward: [number, number, number] = [0, 0, -1];
  private readonly forwardScratch = new Float64Array(3);
  private readonly upScratch = new Float64Array(3);
  private readonly onGesture = (): void => {
    const context = this.audioContext;
    if (!context) return;
    if (context.state === 'running') {this.removeGestureListeners(); return;}
    void this.resume().then(() => {if (context.state === 'running') this.removeGestureListeners();}, () => {});
  };

  /** Same as `engine.use(new AudioListener(...))`; returns the AudioListener. */
  static attach(engine: EngineKernel, options?: AudioListenerOptions): AudioListener {const value = new AudioListener(options); engine.use(value); return value;}
  constructor(options: AudioListenerOptions = {}) {
    this.name = options.name ?? 'margoengine-audio';
    this.order = options.order ?? 900;
    this.source = options.context;
    if (options.context && typeof options.context !== 'function') this.audioContext = options.context;
    this.autoResume = options.autoResume ?? true;
    this.smoothing = options.smoothing ?? 0.02;
    this.volumeValue = options.volume ?? 1;
    if (!Number.isFinite(this.volumeValue) || this.volumeValue < 0) throw new RangeError('Volume must be a finite number >= 0');
    if (!Number.isFinite(this.smoothing) || this.smoothing < 0) throw new RangeError('Smoothing must be >= 0');
  }

  /** The audio context, created on first access. */
  get context(): BaseAudioContext {
    if (!this.audioContext) {
      const source = this.source;
      if (typeof source === 'function') this.audioContext = source();
      else if (source) this.audioContext = source;
      else {this.audioContext = new (audioContextClass())(); this.owned = true;}
    }
    return this.audioContext;
  }
  /** True once the context exists. Reading `context` creates it; this does not. */
  get hasContext(): boolean {return this.audioContext !== undefined;}
  /** Master gain node; every sound connects here. Connected to `context.destination`. */
  get input(): GainNode {
    if (!this.master) {
      const context = this.context;
      this.master = context.createGain();
      this.master.gain.setValueAtTime(this.volumeValue, context.currentTime);
      this.master.connect(context.destination);
    }
    return this.master;
  }
  get volume(): number {return this.volumeValue;}
  set volume(value: number) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Volume must be a finite number >= 0');
    this.volumeValue = value;
    if (this.master) smoothParam(this.master.gain, value, this.context, this.smoothing);
  }
  /** The engine this listener is attached to, if any. */
  get attachedEngine(): EngineKernel | null {return this.engine;}

  /** Resumes a suspended AudioContext. Resolves immediately for offline contexts. */
  async resume(): Promise<void> {
    const context = this.audioContext as AudioContext | undefined;
    if (context && context.state === 'suspended' && typeof (context as AudioContext).close === 'function') await context.resume();
  }
  /** Suspends a running AudioContext (all sounds freeze in place). */
  async suspend(): Promise<void> {
    const context = this.audioContext as AudioContext | undefined;
    if (context && context.state === 'running' && typeof (context as AudioContext).close === 'function') await context.suspend();
  }
  /** Fetches and decodes a sound with this listener's context, cached by URL. */
  load(url: string, options?: LoadAudioOptions): Promise<AudioBuffer> {return loadAudioBuffer(this.context, url, options);}

  setup(engine: EngineKernel): void {
    this.engine = engine;
    if (this.autoResume) {
      const document = engine.canvas.ownerDocument as Document | undefined ?? (globalThis as {document?: Document}).document;
      const target = document?.defaultView ?? document;
      if (target) {
        this.gestureTarget = target;
        for (const type of gestures) target.addEventListener(type, this.onGesture, {capture: true, passive: true});
      }
    }
  }
  registerPasses(graph: FrameGraph): void {graph.add({name: this.name, order: this.order, execute: () => this.update()});}

  /**
   * Copies the camera pose into the Web Audio listener and updates every positional sound. Runs once per frame
   * as a frame pass (after the camera and world matrices are current). Call it yourself when not using an engine.
   */
  update(): void {
    const engine = this.engine;
    if (engine && !engine.disposed) this.followCamera(engine);
    for (const source of this.sources) source.update(engine && !engine.disposed ? engine : null);
  }

  private followCamera(engine: EngineKernel): void {
    const camera = engine.camera, p = camera.position, t = camera.target;
    const forward = this.cameraForward;
    forward[0] = t[0] - p[0]; forward[1] = t[1] - p[1]; forward[2] = t[2] - p[2];
    this.setPose(p, forward);
  }

  /** Sets the listener pose directly (world position, forward direction, up direction). */
  setPose(position: Vec3, forward: Vec3, up: Vec3 = defaultUp): this {
    const f = this.forwardScratch, u = this.upScratch;
    normalize(forward[0], forward[1], forward[2], f, defaultForward);
    normalize(up[0], up[1], up[2], u, defaultUp);
    if (!Number.isFinite(position[0]) || !Number.isFinite(position[1]) || !Number.isFinite(position[2])) throw new RangeError('Listener pose must be finite');
    let changed = !this.written;
    for (let i = 0; i < 3; i++) if (position[i] !== this.position[i] || f[i] !== this.forward[i] || u[i] !== this.up[i]) changed = true;
    for (let i = 0; i < 3; i++) this.position[i] = position[i];
    this.forward.set(f); this.up.set(u);
    if (changed && this.audioContext) this.writePose();
    return this;
  }

  private writePose(): void {
    const context = this.context, listener = context.listener, immediate = !this.written;
    this.written = true;
    const [px, py, pz] = this.position, [fx, fy, fz] = this.forward, [ux, uy, uz] = this.up;
    if (listener.positionX) {
      smoothParam(listener.positionX, px, context, this.smoothing, immediate); smoothParam(listener.positionY, py, context, this.smoothing, immediate); smoothParam(listener.positionZ, pz, context, this.smoothing, immediate);
      smoothParam(listener.forwardX, fx, context, this.smoothing, immediate); smoothParam(listener.forwardY, fy, context, this.smoothing, immediate); smoothParam(listener.forwardZ, fz, context, this.smoothing, immediate);
      smoothParam(listener.upX, ux, context, this.smoothing, immediate); smoothParam(listener.upY, uy, context, this.smoothing, immediate); smoothParam(listener.upZ, uz, context, this.smoothing, immediate);
    } else {
      listener.setPosition(px, py, pz);
      listener.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  /** @internal Registers a sound so the listener updates and disposes it. Creates the context. */
  addSource(source: ListenerSource): void {
    this.sources.add(source);
    // Start at the camera's current pose, so the first sound does not glide in from the origin.
    if (!this.written) {if (this.engine && !this.engine.disposed) this.followCamera(this.engine); else this.writePose();}
  }
  /** @internal */
  removeSource(source: ListenerSource): void {this.sources.delete(source);}

  private removeGestureListeners(): void {
    const target = this.gestureTarget;
    if (!target) return;
    for (const type of gestures) target.removeEventListener(type, this.onGesture, {capture: true});
    this.gestureTarget = undefined;
  }

  /** Stops and disposes every sound, disconnects the master gain and closes a context this listener created. */
  dispose(): void {
    this.removeGestureListeners();
    for (const source of [...this.sources]) source.dispose();
    this.sources.clear();
    this.master?.disconnect();
    this.master = undefined;
    const context = this.audioContext as AudioContext | undefined;
    if (context && this.owned && context.state !== 'closed') void context.close().catch(() => {});
    if (this.owned) {this.audioContext = undefined; this.owned = false; this.written = false;}
    this.engine = null;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
}
