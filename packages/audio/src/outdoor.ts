/// <reference lib="esnext.disposable" preserve="true" />
import type { PositionalAudio } from './audio.js';
import { smoothParam } from './math.js';
import { fault } from '../../shared/errors.js';

/** Structural reading so an Audio scene can use a physics path without loading the physics package itself. */
export interface OutdoorAudioPath {
  readonly delaySeconds: number;
  /** Signed gain at 63, 125, 250, 500, 1000, 2000, 4000 and 8000 Hz, in dB. */
  readonly gainDb: ArrayLike<number>;
}

/** Settings for the outdoor audio controller. */
export interface OutdoorAudioOptions {
  /** Maximum travel time supported by the delay line (default 30 s, range above 0 through 180 s). */
  maxDelay?: number;
  /** Smoothing time constant for path changes (default the listener's smoothing setting). */
  smoothing?: number;
}

/** Gives one positional sound the solved path's time of flight, spreading and a broad spectral colour. */
export class OutdoorAudio {
  private static readonly owners = new WeakSet<PositionalAudio>();
  private readonly delay: DelayNode;
  private readonly level: GainNode;
  private readonly bass: BiquadFilterNode;
  private readonly treble: BiquadFilterNode;
  private readonly upperDelay: number;
  private readonly smoothing: number;
  private readonly previousRolloff: number;
  private readonly filters: readonly AudioNode[];
  private initial = true;
  private disposed = false;

  constructor(
    readonly sound: PositionalAudio,
    private readonly path: () => OutdoorAudioPath,
    options: OutdoorAudioOptions = {},
  ) {
    if (!sound || sound.isDisposed || OutdoorAudio.owners.has(sound))
      throw fault(
        'attached',
        'Outdoor audio needs a live, uncontrolled sound. Dispose its old controller or use a fresh sound',
        'outdoor-sound',
      );
    if (typeof path !== 'function')
      throw fault(
        'unsupported',
        'Outdoor audio needs a callback that returns a solved path. Pass a function',
        'outdoor-sound',
      );
    if (!options || typeof options !== 'object')
      throw fault(
        'unsupported',
        'Outdoor audio settings must be an object. Supply settings or omit the argument',
        'outdoor-sound',
      );
    this.upperDelay = options.maxDelay ?? 30;
    if (!(this.upperDelay > 0 && this.upperDelay <= 180))
      throw fault(
        'unsupported',
        'Outdoor maxDelay must be above 0 and at most 180 seconds. Pass a sufficient delay',
        'outdoor-sound',
      );
    this.smoothing = options.smoothing ?? sound.listener.smoothing;
    if (!(this.smoothing >= 0 && Number.isFinite(this.smoothing)))
      throw fault(
        'unsupported',
        'Outdoor smoothing must be finite and nonnegative. Pass seconds or use the listener value',
        'outdoor-sound',
      );
    this.previousRolloff = sound.rolloffFactor;
    const context = sound.context;
    this.delay = context.createDelay(this.upperDelay);
    this.level = context.createGain();
    this.bass = context.createBiquadFilter();
    this.treble = context.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.treble.type = 'highshelf';
    this.bass.frequency.value = Math.min(250, context.sampleRate / 2);
    this.treble.frequency.value = Math.min(2800, context.sampleRate / 2);
    this.filters = [this.delay, this.bass, this.treble, this.level];
    this.update();
    sound.setFilters([...sound.getFilters(), ...this.filters]);
    sound.rolloffFactor = 0;
    sound.listener.addSource(this);
    OutdoorAudio.owners.add(sound);
  }

  /** Apply the latest world reading. The listener calls this on subsequent audio updates. */
  update(): void {
    if (this.disposed) return;
    if (this.sound.isDisposed) {
      this.dispose();
      return;
    }
    const path = this.path();
    if (!path || !(path.delaySeconds >= 0 && path.delaySeconds <= this.upperDelay))
      throw fault(
        'unsupported',
        'Outdoor travel time exceeds the delay line. Increase maxDelay or pass a shorter path',
        'outdoor-sound',
      );
    const { delaySeconds, gainDb } = path;
    if (!gainDb || gainDb.length !== 8)
      throw fault(
        'unsupported',
        'Outdoor audio needs finite octave gains. Pass a solved eight-band path',
        'outdoor-sound',
      );
    for (let band = 0; band < 8; band++)
      if (!Number.isFinite(gainDb[band]))
        throw fault(
          'unsupported',
          'Outdoor audio needs finite octave gains. Pass a solved eight-band path',
          'outdoor-sound',
        );
    const middle = gainDb[4]!;
    const level = 10 ** (middle / 20);
    const bass = gainDb[0]! - middle;
    const treble = gainDb[7]! - middle;
    if (
      !(
        Number.isFinite(Math.fround(level)) &&
        Number.isFinite(Math.fround(bass)) &&
        Number.isFinite(Math.fround(treble))
      )
    )
      throw fault(
        'failed',
        'Outdoor audio gains exceed the representable filter range. Reduce the path gain or equalizer difference',
        'outdoor-sound',
      );
    const context = this.sound.context;
    const smoothing = this.initial ? 0 : this.smoothing;
    smoothParam(this.delay.delayTime, delaySeconds, context, smoothing);
    smoothParam(this.level.gain, level, context, smoothing);
    smoothParam(this.bass.gain, bass, context, smoothing);
    smoothParam(this.treble.gain, treble, context, smoothing);
    this.initial = false;
  }

  /** Remove owned filters and restore the positional distance rolloff. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const sound = this.sound;
    sound.listener.removeSource(this);
    if (!sound.isDisposed) {
      sound.setFilters(sound.getFilters().filter((node) => !this.filters.includes(node)));
      if (sound.rolloffFactor === 0) sound.rolloffFactor = this.previousRolloff;
    }
    for (const filter of this.filters) filter.disconnect();
    OutdoorAudio.owners.delete(sound);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
