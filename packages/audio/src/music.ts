/// <reference lib="esnext.disposable" preserve="true" />
import { Mixer } from '@margoengine/mixer';
import type { AudioListener } from './listener.js';
import { fault, rangeError } from '../../shared/errors.js';

/** Stem levels in dB, keyed by stem name. Omitted stems are silent; -Infinity is silence. */
export type MusicState = Readonly<Record<string, number>>;

/** Fixed tempo, shared loop length and audio-clock scheduling defaults. */
export interface AudioMusicOptions {
  /** Tempo in quarter-note beats per minute. Default 120. Fixed while playing. */
  bpm?: number;
  /** Positive integer beats per bar. Default 4. */
  beatsPerBar?: number;
  /** Positive integer beats in every stem loop. Default 4. Buffers must cover this interval. */
  loopBeats?: number;
  /** Audio-clock scheduling headroom in seconds. Default 0.05. */
  leadTime?: number;
  /** Mixer exponential fade seconds (about 98 percent settled). Default 0.02; 0 jumps. */
  fade?: number;
}

/** Grid and fade settings for one game-state transition. */
export interface MusicTransitionOptions {
  /** Grid relative to the start time. Default 'bar'. */
  quantize?: 'beat' | 'bar';
  /** Earliest audio-clock time, also respecting currentTime + leadTime. Default now. */
  after?: number;
  /** Fade duration, overriding the constructor default. */
  fade?: number;
}

function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw rangeError(`Music ${name} must be finite and nonnegative; use audio-clock seconds`, 'state');
  return value;
}

/** Phase-aligned looping stems with game-state gain changes on an audio-clock beat/bar grid. */
export class AudioMusic {
  readonly listener: AudioListener;
  private readonly mixer: Mixer;
  private readonly stems: readonly [string, AudioBuffer][];
  private readonly states = new Map<string, readonly number[]>();
  private readonly beat: number;
  private readonly bar: number;
  private readonly loop: number;
  private readonly leadTime: number;
  private readonly fade: number;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private origin: number | null = null;
  /** Index of the next loop to schedule, counted from origin. */
  private next = 0;
  private disposed = false;

  constructor(
    listener: AudioListener,
    stems: Readonly<Record<string, AudioBuffer>>,
    states: Readonly<Record<string, MusicState>>,
    options: AudioMusicOptions = {},
  ) {
    this.listener = listener;
    const bpm = options.bpm ?? 120,
      beatsPerBar = options.beatsPerBar ?? 4,
      loopBeats = options.loopBeats ?? 4;
    if (
      !Number.isFinite(bpm) ||
      bpm <= 0 ||
      !Number.isInteger(beatsPerBar) ||
      beatsPerBar < 1 ||
      !Number.isInteger(loopBeats) ||
      loopBeats < 1
    )
      throw rangeError('Music needs positive finite bpm and positive integer beatsPerBar/loopBeats', 'state');
    this.beat = 60 / bpm;
    this.bar = this.beat * beatsPerBar;
    this.loop = this.beat * loopBeats;
    if (!Number.isFinite(this.bar) || !Number.isFinite(this.loop) || this.beat <= 0)
      throw rangeError(
        'Music grid must fit finite audio-clock seconds; use a practical tempo and loop length',
        'state',
      );
    this.leadTime = nonnegative(options.leadTime ?? 0.05, 'leadTime');
    this.fade = nonnegative(options.fade ?? 0.02, 'fade');
    this.stems = Object.entries(stems);
    if (
      !this.stems.length ||
      this.stems.some(([name, buffer]) => !name || !Number.isFinite(buffer?.duration) || buffer.duration < this.loop)
    )
      throw fault('state', 'Music needs named decoded stems covering loopBeats; load buffers before construction');
    const names = new Set(this.stems.map(([name]) => name));
    for (const [name, state] of Object.entries(states)) {
      if (
        !name ||
        !state ||
        Object.entries(state).some(
          ([stem, db]) =>
            !names.has(stem) ||
            (db !== -Infinity && (!Number.isFinite(db) || !Number.isFinite(Math.fround(10 ** (db / 20))))),
        )
      )
        throw fault('state', 'Music states need known stem names and finite float32 gains in dB, or -Infinity');
      this.states.set(
        name,
        this.stems.map(([stem]) => (Object.hasOwn(state, stem) ? state[stem] : -Infinity)),
      );
    }
    if (!this.states.size) throw fault('state', 'Music needs at least one named state with stem dB levels');
    this.mixer = new Mixer(listener.context, { destination: listener.input });
    this.stems.forEach((_, i) => this.mixer.createBus(String(i), { gain: -Infinity }));
    listener.addSource(this);
  }

  /**
   * Start every stem at the same audio time and loop phase. Returns that time. Already playing raises state.
   * Each loop k of each stem is its own one-shot source started at `at + k * loop` on the audio clock, so a browser
   * that rounds start times to whole frames stays within a frame of the grid and never accumulates drift.
   */
  start(state: string, at = this.listener.context.currentTime + this.leadTime): number {
    this.assertLive();
    const levels = this.levels(state),
      context = this.listener.context;
    nonnegative(at, 'start time');
    if (this.origin !== null || at < context.currentTime || !Number.isFinite(at + this.loop))
      throw fault(
        'state',
        'Music start needs a stopped transport and a finite future time; stop first or use transition',
      );
    this.stems.forEach((_, i) => this.mixer.bus(String(i)).setGain(levels[i], { at: context.currentTime, seconds: 0 }));
    this.origin = at;
    this.next = 0;
    try {
      this.schedule();
    } catch (error) {
      this.stop();
      throw error;
    }
    return at;
  }

  /** Schedule a state on the next grid boundary. A new request replaces automation at/after its boundary. */
  transition(state: string, options: MusicTransitionOptions = {}): number {
    this.assertLive();
    const levels = this.levels(state);
    if (this.origin === null) throw fault('state', 'Music is stopped; call start(state) before transitioning');
    const quantize = options.quantize ?? 'bar';
    if (quantize !== 'beat' && quantize !== 'bar') throw fault('state', "Music quantize must be 'beat' or 'bar'");
    const after = nonnegative(options.after ?? this.listener.context.currentTime, 'after');
    const fade = nonnegative(options.fade ?? this.fade, 'fade');
    const grid = quantize === 'beat' ? this.beat : this.bar;
    const earliest = Math.max(this.origin, after, this.listener.context.currentTime + this.leadTime);
    const at = this.origin + Math.ceil((earliest - this.origin) / grid) * grid;
    if (!Number.isFinite(at))
      throw rangeError('Music transition time overflow; use a nearer audio-clock time', 'state');
    levels.forEach((db, i) => this.mixer.bus(String(i)).setGain(db, { at, seconds: fade }));
    return at;
  }

  /** Stop immediately, including scheduled starts. A later start resets the grid and all pending state automation. */
  stop(): void {
    this.assertLive();
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.origin = null;
  }
  /** @internal Keeps loops scheduled ahead of the audio clock; every loop end refills too, so hidden tabs keep time. */
  update(): void {
    if (!this.disposed && this.origin !== null) this.schedule();
  }
  /**
   * Schedule loops whose start lies before the horizon: an OfflineAudioContext's whole render (it runs in one go),
   * otherwise max(1 s, 2 loops) past currentTime + leadTime. A loop whose start already passed (a stalled main
   * thread) starts now at its matching offset, so the grid holds.
   */
  private schedule(): void {
    const context = this.listener.context,
      origin = this.origin!,
      now = context.currentTime;
    const offline = context as Partial<OfflineAudioContext>;
    const horizon =
      typeof offline.startRendering === 'function' && typeof offline.length === 'number'
        ? offline.length / context.sampleRate
        : now + this.leadTime + Math.max(1, 2 * this.loop);
    for (let when = origin + this.next * this.loop; when < horizon; when = origin + ++this.next * this.loop) {
      const late = Math.max(0, now - when);
      if (late >= this.loop) continue;
      this.stems.forEach(([, buffer], i) => {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.mixer.bus(String(i)).input);
        source.onended = () => {
          this.sources.delete(source);
          source.disconnect();
          this.update();
        };
        try {
          source.start(when + late, late, this.loop - late);
        } catch (error) {
          source.disconnect();
          throw error;
        }
        this.sources.add(source);
      });
    }
  }
  /** Stop sources, release owned mixer buses, keep shared buffers. Listener teardown also disposes music. */
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.listener.removeSource(this);
    this.mixer.dispose();
  }
  private levels(name: string): readonly number[] {
    const levels = this.states.get(name);
    if (!levels) throw fault('state', `Unknown music state ${name}; define it in the constructor`);
    return levels;
  }
  private assertLive(): void {
    if (this.disposed) throw fault('disposed', 'AudioMusic is disposed; create a new transport');
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
