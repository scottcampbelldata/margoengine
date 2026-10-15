/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import type { AudioListener, ListenerSource } from './listener.js';
import { normalize, smoothParam, type DistanceModel, type Vec3 } from './math.js';

export interface AudioOptions {
  /** Volume of this sound, default 1. */
  volume?: number;
  loop?: boolean;
  /** Loop region start in seconds (buffer sources). */
  loopStart?: number;
  /** Loop region end in seconds; 0 means the end of the buffer. */
  loopEnd?: number;
  playbackRate?: number;
  /** Detune in cents (buffer sources). */
  detune?: number;
  /** Start position in seconds within the buffer. */
  offset?: number;
  /** Seconds to play (buffer sources, ignored while looping). */
  duration?: number;
  /** Start as soon as a buffer is set. */
  autoplay?: boolean;
  /** Effect chain between the source and the volume stage, e.g. BiquadFilterNodes. */
  filters?: AudioNode[];
  /** Called when playback reaches its natural end (not on pause or stop). */
  onEnded?: (audio: Audio) => void;
}

export interface PositionalAudioOptions extends AudioOptions {
  panningModel?: PanningModelType;
  distanceModel?: DistanceModel;
  refDistance?: number;
  maxDistance?: number;
  rolloffFactor?: number;
  /** Cone angles in degrees (360 disables the cone). */
  coneInnerAngle?: number;
  coneOuterAngle?: number;
  coneOuterGain?: number;
  /** Mesh to follow. Position comes from its world matrix; orientation from its local `direction` axis. */
  mesh?: Mesh | null;
  /** Local axis the cone points along, default +Z (THREE.Object3D.getWorldDirection). */
  direction?: Vec3;
  /** Silence the sound (smoothly) while the mesh or any ancestor is hidden. Default false. */
  muteWhenHidden?: boolean;
}

type SourceKind = 'buffer' | 'media' | 'stream' | 'node' | null;
const defaultDirection: Vec3 = [0, 0, 1];
const mediaSources = new WeakMap<BaseAudioContext, WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>>();
const disconnect = (node: AudioNode | null | undefined, destination?: AudioNode): void => {
  if (!node) return;
  try {
    if (destination) node.disconnect(destination);
    else node.disconnect();
  } catch {
    /* already disconnected */
  }
};
const checkFinite = (value: number, name: string, min = -Infinity): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min)
    throw new RangeError(`${name} must be a finite number${min > -Infinity ? ` >= ${min}` : ''}`);
  return value;
};

/**
 * A non-positional sound routed straight to the listener's master gain (THREE.Audio counterpart).
 * Graph: source -> filters -> fade gain -> volume gain -> [panner] -> listener.input.
 */
export class Audio implements ListenerSource {
  readonly listener: AudioListener;
  readonly context: BaseAudioContext;
  /** Volume stage (user volume times hidden-mute). */
  readonly gain: GainNode;
  /** Fade stage driven by fadeIn and fadeOut. */
  readonly fade: GainNode;
  onEnded: ((audio: Audio) => void) | null;
  autoplay: boolean;
  buffer: AudioBuffer | null = null;
  /** Current source node, if any (AudioBufferSourceNode while a buffer plays). */
  source: AudioNode | null = null;
  private kind: SourceKind = null;
  private media: HTMLMediaElement | null = null;
  private playing = false;
  private startedAt = 0;
  private progress = 0;
  private filterList: AudioNode[] = [];
  private loopValue: boolean;
  private loopStartValue: number;
  private loopEndValue: number;
  private rateValue: number;
  private detuneValue: number;
  private offsetValue: number;
  private durationValue: number | undefined;
  private volumeValue: number;
  private muted = false;
  private disposed = false;
  private fadeTimer: ReturnType<typeof setTimeout> | undefined;
  private fading = false;
  private readonly onMediaEnded = (): void => {
    if (this.playing && !this.loopValue) {
      this.playing = false;
      this.onEnded?.(this);
    }
  };

  constructor(listener: AudioListener, options: AudioOptions = {}) {
    this.listener = listener;
    this.context = listener.context;
    this.loopValue = options.loop ?? false;
    this.loopStartValue = checkFinite(options.loopStart ?? 0, 'loopStart', 0);
    this.loopEndValue = checkFinite(options.loopEnd ?? 0, 'loopEnd', 0);
    this.rateValue = checkFinite(options.playbackRate ?? 1, 'playbackRate');
    this.detuneValue = checkFinite(options.detune ?? 0, 'detune');
    this.offsetValue = checkFinite(options.offset ?? 0, 'offset', 0);
    this.durationValue = options.duration === undefined ? undefined : checkFinite(options.duration, 'duration', 0);
    this.volumeValue = checkFinite(options.volume ?? 1, 'volume', 0);
    this.autoplay = options.autoplay ?? false;
    this.onEnded = options.onEnded ?? null;
    this.gain = this.context.createGain();
    this.gain.gain.setValueAtTime(this.volumeValue, this.context.currentTime);
    this.fade = this.context.createGain();
    this.fade.connect(this.gain);
    this.connectOutput();
    if (options.filters?.length) this.setFilters(options.filters);
    listener.addSource(this);
  }

  /** Last node of this sound before the listener (the volume gain, or the panner for positional audio). */
  getOutput(): AudioNode {
    return this.gain;
  }
  protected connectOutput(): void {
    this.getOutput().connect(this.listener.input);
  }
  get isPlaying(): boolean {
    return this.playing;
  }
  get sourceType(): SourceKind {
    return this.kind;
  }

  /** Plays an AudioBuffer (decoded file). */
  setBuffer(buffer: AudioBuffer): this {
    this.replaceSource();
    this.buffer = buffer;
    this.kind = 'buffer';
    this.progress = 0;
    if (this.autoplay) this.play();
    return this;
  }
  /** Routes an `<audio>` or `<video>` element. One element can feed only one context node, which is reused. */
  setMediaElementSource(element: HTMLMediaElement): this {
    this.replaceSource();
    let byElement = mediaSources.get(this.context);
    if (!byElement) {
      byElement = new WeakMap();
      mediaSources.set(this.context, byElement);
    }
    let node = byElement.get(element);
    if (!node) {
      node = (this.context as AudioContext).createMediaElementSource(element);
      byElement.set(element, node);
    }
    this.kind = 'media';
    this.media = element;
    this.source = node;
    element.loop = this.loopValue;
    element.playbackRate = this.rateValue;
    element.addEventListener('ended', this.onMediaEnded);
    node.connect(this.head);
    this.playing = !element.paused;
    return this;
  }
  /** Routes a MediaStream (microphone, WebRTC). play() connects it, pause() and stop() disconnect it. */
  setMediaStreamSource(stream: MediaStream): this {
    this.replaceSource();
    this.kind = 'stream';
    this.source = (this.context as AudioContext).createMediaStreamSource(stream);
    return this;
  }
  /** Routes any AudioNode (oscillator, constant source, worklet). play() connects it, pause() and stop() disconnect it. */
  setNodeSource(node: AudioNode): this {
    this.replaceSource();
    this.kind = 'node';
    this.source = node;
    return this;
  }

  /** Starts or resumes playback after `delay` seconds. */
  play(delay = 0): this {
    this.assertLive();
    checkFinite(delay, 'delay', 0);
    if (this.playing) return this;
    if (!this.fading) this.setFade(1);
    const context = this.context;
    if (this.kind === 'buffer') {
      const buffer = this.buffer!,
        node = context.createBufferSource();
      node.buffer = buffer;
      node.loop = this.loopValue;
      node.loopStart = this.loopStartValue;
      node.loopEnd = this.loopEndValue;
      node.playbackRate.setValueAtTime(this.rateValue, context.currentTime);
      node.detune?.setValueAtTime(this.detuneValue, context.currentTime);
      node.onended = () => {
        disconnect(node);
        if (this.source !== node) return;
        this.source = null;
        if (!this.playing) return;
        this.playing = false;
        this.progress = 0;
        this.onEnded?.(this);
      };
      node.connect(this.head);
      const position = this.playhead(buffer.duration);
      this.progress = position - this.offsetValue;
      this.startedAt = context.currentTime + delay;
      const remaining =
        this.durationValue === undefined || this.loopValue
          ? undefined
          : Math.max(0, this.durationValue - Math.max(0, position - this.offsetValue));
      if (remaining === undefined) node.start(this.startedAt, position);
      else node.start(this.startedAt, position, remaining);
      this.source = node;
    } else if (this.kind === 'media') {
      const media = this.media!;
      if (delay > 0) {
        this.clearTimer();
        this.fadeTimer = setTimeout(() => {
          this.fadeTimer = undefined;
          if (this.playing) void media.play().catch(() => {});
        }, delay * 1000);
      } else void media.play().catch(() => {});
    } else if (this.kind === 'stream' || this.kind === 'node') {
      this.source!.connect(this.head);
    } else
      throw new Error(
        'Audio has no source; call setBuffer, setMediaElementSource, setMediaStreamSource or setNodeSource first',
      );
    this.playing = true;
    return this;
  }

  /** Pauses and remembers the position (buffer sources) so play() continues from there. */
  pause(): this {
    if (!this.playing) return this;
    this.playing = false;
    this.clearTimer();
    if (this.kind === 'buffer') {
      this.progress += Math.max(this.context.currentTime - this.startedAt, 0) * this.rateValue;
      this.progress = this.playhead(this.buffer!.duration) - this.offsetValue;
      this.stopNode();
    } else this.haltOther(false);
    return this;
  }

  /** Stops after `delay` seconds and rewinds to `offset`. */
  stop(delay = 0): this {
    checkFinite(delay, 'delay', 0);
    this.playing = false;
    this.progress = 0;
    this.clearTimer();
    if (this.kind === 'buffer') this.stopNode(delay);
    else if (delay > 0)
      this.fadeTimer = setTimeout(() => {
        this.fadeTimer = undefined;
        this.haltOther(true);
      }, delay * 1000);
    else this.haltOther(true);
    return this;
  }

  /** Ramps from silence to full volume over `seconds`, starting playback if needed. */
  fadeIn(seconds: number): this {
    checkFinite(seconds, 'seconds', 0);
    const param = this.fade.gain,
      now = this.context.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(0, now);
    param.linearRampToValueAtTime(1, now + seconds);
    this.fading = true;
    try {
      if (!this.playing) this.play();
    } finally {
      this.fading = false;
    }
    return this;
  }
  /** Ramps to silence over `seconds`, then stops (or pauses with `{pause: true}`). */
  fadeOut(seconds: number, { pause = false }: { pause?: boolean } = {}): this {
    checkFinite(seconds, 'seconds', 0);
    if (!this.playing) return this;
    const param = this.fade.gain,
      now = this.context.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(0, now + seconds);
    if (!pause && this.kind === 'buffer') {
      this.stop(seconds);
    } else {
      this.clearTimer();
      this.fadeTimer = setTimeout(() => {
        this.fadeTimer = undefined;
        if (pause) this.pause();
        else this.stop();
      }, seconds * 1000);
    }
    return this;
  }

  /** Replaces the effect chain. Nodes are wired in order between the source and the volume stage. */
  setFilters(filters: AudioNode[]): this {
    const previousHead = this.head;
    if (this.source && this.isSourceConnected) disconnect(this.source, previousHead);
    for (const node of this.filterList) disconnect(node);
    this.filterList = [...filters];
    for (let i = 0; i < this.filterList.length; i++) this.filterList[i].connect(this.filterList[i + 1] ?? this.fade);
    if (this.source && this.isSourceConnected) this.source.connect(this.head);
    return this;
  }
  getFilters(): AudioNode[] {
    return [...this.filterList];
  }
  setFilter(filter: AudioNode | null): this {
    return this.setFilters(filter ? [filter] : []);
  }
  getFilter(): AudioNode | null {
    return this.filterList[0] ?? null;
  }

  get volume(): number {
    return this.volumeValue;
  }
  set volume(value: number) {
    this.volumeValue = checkFinite(value, 'volume', 0);
    this.writeGain();
  }
  get loop(): boolean {
    return this.loopValue;
  }
  set loop(value: boolean) {
    this.loopValue = !!value;
    if (this.kind === 'buffer' && this.source) (this.source as AudioBufferSourceNode).loop = this.loopValue;
    if (this.media) this.media.loop = this.loopValue;
  }
  get loopStart(): number {
    return this.loopStartValue;
  }
  set loopStart(value: number) {
    this.loopStartValue = checkFinite(value, 'loopStart', 0);
    if (this.kind === 'buffer' && this.source) (this.source as AudioBufferSourceNode).loopStart = value;
  }
  get loopEnd(): number {
    return this.loopEndValue;
  }
  set loopEnd(value: number) {
    this.loopEndValue = checkFinite(value, 'loopEnd', 0);
    if (this.kind === 'buffer' && this.source) (this.source as AudioBufferSourceNode).loopEnd = value;
  }
  get playbackRate(): number {
    return this.rateValue;
  }
  set playbackRate(value: number) {
    checkFinite(value, 'playbackRate');
    if (this.kind === 'buffer' && this.playing && this.source) {
      const now = this.context.currentTime;
      this.progress += Math.max(now - this.startedAt, 0) * this.rateValue;
      this.startedAt = Math.max(now, this.startedAt);
      smoothParam((this.source as AudioBufferSourceNode).playbackRate, value, this.context, this.listener.smoothing);
    }
    this.rateValue = value;
    if (this.media) this.media.playbackRate = value;
  }
  get detune(): number {
    return this.detuneValue;
  }
  set detune(value: number) {
    this.detuneValue = checkFinite(value, 'detune');
    const node = this.kind === 'buffer' ? (this.source as AudioBufferSourceNode | null) : null;
    if (node?.detune) smoothParam(node.detune, value, this.context, this.listener.smoothing);
  }
  get offset(): number {
    return this.offsetValue;
  }
  set offset(value: number) {
    this.offsetValue = checkFinite(value, 'offset', 0);
  }
  get duration(): number | undefined {
    return this.durationValue;
  }
  set duration(value: number | undefined) {
    this.durationValue = value === undefined ? undefined : checkFinite(value, 'duration', 0);
  }
  /** Current playhead in seconds within the buffer (buffer sources) or media element time. */
  get currentTime(): number {
    if (this.media) return this.media.currentTime;
    if (!this.buffer) return 0;
    const elapsed = this.playing ? Math.max(this.context.currentTime - this.startedAt, 0) * this.rateValue : 0;
    return this.playhead(this.buffer.duration, this.progress + elapsed);
  }

  /** @internal Per-frame hook from the listener; global audio has nothing to update. */
  update(_engine: EngineKernel | null): void {}

  /** Stops playback, disconnects every node and unregisters from the listener. */
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.replaceSource();
    for (const node of this.filterList) disconnect(node);
    this.filterList = [];
    disconnect(this.fade);
    disconnect(this.gain);
    this.disposed = true;
    this.listener.removeSource(this);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  protected get head(): AudioNode {
    return this.filterList[0] ?? this.fade;
  }
  protected setMuted(muted: boolean): void {
    if (muted !== this.muted) {
      this.muted = muted;
      this.writeGain();
    }
  }
  get isMuted(): boolean {
    return this.muted;
  }

  private get isSourceConnected(): boolean {
    return this.kind === 'media' || (this.kind === 'buffer' ? this.source !== null : this.playing);
  }
  private writeGain(): void {
    smoothParam(this.gain.gain, this.muted ? 0 : this.volumeValue, this.context, this.listener.smoothing);
  }
  private setFade(value: number): void {
    const now = this.context.currentTime;
    this.fade.gain.cancelScheduledValues(now);
    this.fade.gain.setValueAtTime(value, now);
  }
  private assertLive(): void {
    if (this.disposed) throw new Error('Audio is disposed');
  }
  private clearTimer(): void {
    if (this.fadeTimer !== undefined) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = undefined;
    }
  }

  /** Wraps `offset + progress` into the buffer or the loop region. */
  private playhead(bufferDuration: number, progress = this.progress): number {
    let position = this.offsetValue + progress;
    if (!this.loopValue) return Math.min(Math.max(position, 0), bufferDuration);
    const start = this.loopStartValue,
      end = this.loopEndValue > 0 ? Math.min(this.loopEndValue, bufferDuration) : bufferDuration;
    if (end > start && position >= end) position = start + ((position - start) % (end - start));
    else if (!(end > start) && bufferDuration > 0) position %= bufferDuration;
    return position;
  }

  private stopNode(delay = 0): void {
    const node = this.source as AudioBufferSourceNode | null;
    if (!node) return;
    if (delay > 0) {
      node.stop(this.context.currentTime + delay);
      return;
    }
    node.onended = null;
    try {
      node.stop();
    } catch {
      /* never started */
    }
    disconnect(node);
    this.source = null;
  }
  private haltOther(rewind: boolean): void {
    if (this.kind === 'media' && this.media) {
      this.media.pause();
      if (rewind) this.media.currentTime = this.offsetValue;
    } else if ((this.kind === 'stream' || this.kind === 'node') && this.source) disconnect(this.source, this.head);
  }
  private replaceSource(): void {
    this.clearTimer();
    if (this.kind === 'buffer') this.stopNode();
    else if (this.kind === 'media' && this.media) {
      this.media.pause();
      this.media.removeEventListener('ended', this.onMediaEnded);
      disconnect(this.source, this.head);
    } else if (this.source) disconnect(this.source, this.head);
    this.playing = false;
    this.kind = null;
    this.source = null;
    this.media = null;
    this.buffer = null;
    this.progress = 0;
  }
}

/**
 * A sound placed in the world through a PannerNode (THREE.PositionalAudio counterpart). Attach it to a core Mesh
 * and the listener reads the mesh world matrix from the engine every frame, or place it with setPosition.
 */
export class PositionalAudio extends Audio {
  readonly panner: PannerNode;
  /** Last world position and cone direction written to the panner. */
  readonly worldPosition = new Float64Array(3);
  readonly worldDirection = new Float64Array([0, 0, 1]);
  muteWhenHidden: boolean;
  private meshValue: Mesh | null = null;
  private readonly localDirection = new Float64Array([0, 0, 1]);
  private readonly directionScratch = new Float64Array(3);
  private written = false;

  constructor(listener: AudioListener, options: PositionalAudioOptions = {}) {
    const panner = listener.context.createPanner();
    super(listener, { ...options, filters: undefined });
    this.panner = panner;
    try {
      this.gain.connect(panner);
      panner.connect(listener.input);
      panner.panningModel = options.panningModel ?? 'HRTF';
      this.distanceModel = options.distanceModel ?? 'inverse';
      this.refDistance = options.refDistance ?? 1;
      this.maxDistance = options.maxDistance ?? 10000;
      this.rolloffFactor = options.rolloffFactor ?? 1;
      this.setDirectionalCone(options.coneInnerAngle ?? 360, options.coneOuterAngle ?? 360, options.coneOuterGain ?? 0);
      this.muteWhenHidden = options.muteWhenHidden ?? false;
      if (options.direction) this.setDirection(options.direction);
      if (options.filters?.length) this.setFilters(options.filters);
      if (options.mesh) this.attach(options.mesh);
      this.writePose();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  override getOutput(): AudioNode {
    return this.panner ?? this.gain;
  }
  /** The panner does not exist yet while the base constructor runs; the subclass wires gain -> panner -> input. */
  protected override connectOutput(): void {}

  get panningModel(): PanningModelType {
    return this.panner.panningModel;
  }
  set panningModel(value: PanningModelType) {
    this.panner.panningModel = value;
  }
  get distanceModel(): DistanceModel {
    return this.panner.distanceModel;
  }
  set distanceModel(value: DistanceModel) {
    if (value !== 'linear' && value !== 'inverse' && value !== 'exponential')
      throw new TypeError(`Unknown distance model ${String(value)}`);
    this.panner.distanceModel = value;
  }
  get refDistance(): number {
    return this.panner.refDistance;
  }
  set refDistance(value: number) {
    this.panner.refDistance = checkFinite(value, 'refDistance', 0);
  }
  get maxDistance(): number {
    return this.panner.maxDistance;
  }
  set maxDistance(value: number) {
    if (checkFinite(value, 'maxDistance') <= 0) throw new RangeError('maxDistance must be > 0');
    this.panner.maxDistance = value;
  }
  get rolloffFactor(): number {
    return this.panner.rolloffFactor;
  }
  set rolloffFactor(value: number) {
    this.panner.rolloffFactor = checkFinite(value, 'rolloffFactor', 0);
  }
  /** Cone angles in degrees and the gain outside the outer cone (0..1). */
  setDirectionalCone(innerAngle: number, outerAngle: number, outerGain: number): this {
    checkFinite(innerAngle, 'coneInnerAngle');
    checkFinite(outerAngle, 'coneOuterAngle');
    if (checkFinite(outerGain, 'coneOuterGain') < 0 || outerGain > 1)
      throw new RangeError('coneOuterGain must be 0..1');
    this.panner.coneInnerAngle = innerAngle;
    this.panner.coneOuterAngle = outerAngle;
    this.panner.coneOuterGain = outerGain;
    return this;
  }

  /** The mesh this sound follows. */
  get mesh(): Mesh | null {
    return this.meshValue;
  }
  /** Follows `mesh` (world position from the engine's matrices). Pass null to keep the last pose. */
  attach(mesh: Mesh | null): this {
    this.meshValue = mesh;
    return this;
  }
  detach(): this {
    return this.attach(null);
  }
  /** Places the sound at a world position and stops following any mesh. */
  setPosition(x: number, y: number, z: number): this {
    checkFinite(x, 'x');
    checkFinite(y, 'y');
    checkFinite(z, 'z');
    this.meshValue = null;
    this.worldPosition[0] = x;
    this.worldPosition[1] = y;
    this.worldPosition[2] = z;
    this.writePose();
    return this;
  }
  /** World direction of the cone when not following a mesh; the local axis when following one. */
  setDirection(direction: Vec3): this {
    const out = this.directionScratch;
    if (!normalize(direction[0], direction[1], direction[2], out, defaultDirection))
      throw new RangeError('Direction must be nonzero');
    this.localDirection.set(out);
    if (!this.meshValue) {
      this.worldDirection.set(out);
      if (this.panner) this.writePose();
    }
    return this;
  }

  /** @internal Reads the attached mesh's world matrix and visibility. Called by the listener every frame. */
  override update(engine: EngineKernel | null): void {
    const mesh = this.meshValue;
    if (!mesh || !engine) return;
    const runtime = engineRuntime(engine),
      id = meshRuntime(mesh).id;
    if (runtime.meshes.get(id) !== mesh) return;
    const store = runtime.store,
      m = store.matrices,
      o = id * 16;
    const [dx, dy, dz] = this.localDirection;
    const x = m[o + 12],
      y = m[o + 13],
      z = m[o + 14],
      direction = this.directionScratch;
    normalize(
      m[o] * dx + m[o + 4] * dy + m[o + 8] * dz,
      m[o + 1] * dx + m[o + 5] * dy + m[o + 9] * dz,
      m[o + 2] * dx + m[o + 6] * dy + m[o + 10] * dz,
      direction,
      defaultDirection,
    );
    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(z) &&
      (x !== this.worldPosition[0] ||
        y !== this.worldPosition[1] ||
        z !== this.worldPosition[2] ||
        direction[0] !== this.worldDirection[0] ||
        direction[1] !== this.worldDirection[1] ||
        direction[2] !== this.worldDirection[2])
    ) {
      this.worldPosition[0] = x;
      this.worldPosition[1] = y;
      this.worldPosition[2] = z;
      this.worldDirection.set(direction);
      this.writePose();
    }
    let hidden = false;
    if (this.muteWhenHidden)
      for (let current = id, depth = 0; current >= 0 && depth < 64; current = store.parents[current], depth++)
        if (store.hidden[current]) {
          hidden = true;
          break;
        }
    this.setMuted(hidden);
  }

  override dispose(): void {
    super.dispose();
    disconnect(this.panner);
    this.meshValue = null;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private writePose(): void {
    const panner = this.panner,
      context = this.context,
      immediate = !this.written,
      smoothing = this.listener.smoothing;
    this.written = true;
    const [px, py, pz] = this.worldPosition,
      [dx, dy, dz] = this.worldDirection;
    if (panner.positionX) {
      smoothParam(panner.positionX, px, context, smoothing, immediate);
      smoothParam(panner.positionY, py, context, smoothing, immediate);
      smoothParam(panner.positionZ, pz, context, smoothing, immediate);
      smoothParam(panner.orientationX, dx, context, smoothing, immediate);
      smoothParam(panner.orientationY, dy, context, smoothing, immediate);
      smoothParam(panner.orientationZ, dz, context, smoothing, immediate);
    } else {
      panner.setPosition(px, py, pz);
      panner.setOrientation(dx, dy, dz);
    }
  }
}
