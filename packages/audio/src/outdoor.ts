/// <reference lib="esnext.disposable" preserve="true" />
import type { PositionalAudio } from './audio.js';
import { smoothParam } from './math.js';
import { fault, rangeError } from '../../shared/errors.js';

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
    if (sound.isDisposed || OutdoorAudio.owners.has(sound))
      throw fault(
        'attached',
        'Outdoor audio needs a live, uncontrolled sound; dispose its old controller or use a fresh sound.',
      );
    this.upperDelay = options.maxDelay ?? 30;
    if (!(this.upperDelay > 0 && this.upperDelay <= 180))
      throw rangeError('Outdoor maxDelay must be above 0 and at most 180 seconds; pass a sufficient delay.', 'state');
    this.smoothing = options.smoothing ?? sound.listener.smoothing;
    if (!(this.smoothing >= 0 && Number.isFinite(this.smoothing)))
      throw rangeError(
        'Outdoor smoothing must be finite and nonnegative; pass seconds or use the listener value.',
        'state',
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
    const { delaySeconds, gainDb } = this.path();
    const low = gainDb[0],
      mid = gainDb[4],
      high = gainDb[7];
    if (!(delaySeconds >= 0 && delaySeconds <= this.upperDelay))
      throw rangeError('Outdoor travel time exceeds the delay line; increase maxDelay or shorten the path.', 'state');
    if (
      low === undefined ||
      mid === undefined ||
      high === undefined ||
      !Number.isFinite(low) ||
      !Number.isFinite(mid) ||
      !Number.isFinite(high)
    )
      throw rangeError('Outdoor audio needs finite octave gains; pass a solved eight-band path.', 'state');
    const context = this.sound.context;
    const smoothing = this.initial ? 0 : this.smoothing;
    smoothParam(this.delay.delayTime, delaySeconds, context, smoothing);
    smoothParam(this.level.gain, 10 ** (mid / 20), context, smoothing);
    smoothParam(this.bass.gain, low - mid, context, smoothing);
    smoothParam(this.treble.gain, high - mid, context, smoothing);
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
