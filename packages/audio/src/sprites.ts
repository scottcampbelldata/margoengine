/// <reference lib="esnext.disposable" preserve="true" />
import { Audio, type AudioListener, type AudioOptions, type LoadAudioOptions } from '@margoengine/audio';
import { fault, rangeError } from '../../shared/errors.js';

/** A named interval in a shared decoded audio buffer, in seconds. */
export interface AudioSprite {
  /** Start in buffer seconds, finite and nonnegative. */
  offset: number;
  /** Positive finite buffer seconds, wholly within the buffer. */
  duration: number;
  /** Repeat only this interval. Default false. */
  loop?: boolean;
}
/** Sound options independent of the sprite's authored interval/loop. */
export type AudioSpritePlayOptions = Omit<
  AudioOptions,
  'offset' | 'duration' | 'loopStart' | 'loopEnd' | 'loop' | 'autoplay'
>;

/** Named, overlapping clips sharing one buffer; no per-play buffer slicing or copying. */
export class AudioSpriteBank {
  private readonly sprites = new Map<string, Readonly<AudioSprite>>();
  private readonly sounds = new Set<Audio>();
  private disposed = false;

  constructor(
    readonly listener: AudioListener,
    readonly buffer: AudioBuffer,
    sprites: Readonly<Record<string, AudioSprite>>,
  ) {
    if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0)
      throw fault('state', 'Audio sprites need a positive-duration decoded buffer; use listener.load first');
    for (const [name, sprite] of Object.entries(sprites)) {
      if (
        !name ||
        !sprite ||
        !Number.isFinite(sprite.offset) ||
        sprite.offset < 0 ||
        !Number.isFinite(sprite.duration) ||
        sprite.duration <= 0 ||
        sprite.offset + sprite.duration > buffer.duration ||
        (sprite.loop !== undefined && typeof sprite.loop !== 'boolean')
      )
        throw rangeError(
          'Audio sprite names and intervals must be valid and within the buffer; use a nonempty name and offset/duration in seconds',
          'state',
        );
      this.sprites.set(name, Object.freeze({ ...sprite }));
    }
    listener.addSource(this);
  }
  /** Available sprite names, copied in map order. */
  get names(): readonly string[] {
    return [...this.sprites.keys()];
  }

  /** Create a stopped clip with its authored loop bounds, owned until disposed or the bank is disposed. */
  create(name: string, options: AudioSpritePlayOptions = {}): Audio {
    if (this.disposed) throw fault('disposed', 'AudioSpriteBank is disposed; create a new bank');
    const sprite = this.sprites.get(name);
    if (!sprite) throw fault('state', `Unknown audio sprite ${name}; choose a name from bank.names`);
    const sound = new Audio(this.listener, {
      ...options,
      autoplay: false,
      offset: sprite.offset,
      duration: sprite.duration,
      loop: sprite.loop ?? false,
      loopStart: sprite.offset,
      loopEnd: sprite.offset + sprite.duration,
      onEnded: (audio) => {
        try {
          options.onEnded?.(audio);
        } finally {
          this.sounds.delete(audio);
          audio.dispose();
        }
      },
    }).setBuffer(this.buffer);
    this.sounds.add(sound);
    return sound;
  }
  /** Create and start an independent instance; delay defaults to 0 audio-clock seconds. */
  play(name: string, options: AudioSpritePlayOptions = {}, delay = 0): Audio {
    if (!Number.isFinite(delay) || delay < 0)
      throw rangeError('Sprite delay must be finite and nonnegative; use seconds', 'state');
    return this.create(name, options).play(delay);
  }
  /** Stop every instance while preserving their buffers and the sprite map. */
  stopAll(): void {
    for (const sound of this.sounds) if (!sound.isDisposed) sound.stop();
  }
  /** @internal Forget caller-disposed sounds on listener updates. */
  update(): void {
    for (const sound of this.sounds) if (sound.isDisposed) this.sounds.delete(sound);
  }
  /** Stop/release all owned instances. The shared buffer remains usable. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listener.removeSource(this);
    for (const sound of this.sounds) sound.dispose();
    this.sounds.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/** A URL and optional explicit MIME/codec declaration, or a URL with a known extension. */
export type AudioCodecCandidate = string | { readonly url: string; readonly type: string };
/** Loading controls plus an injectable browser capability probe for workers or server-side tests. */
export interface AudioCodecFallbackOptions extends LoadAudioOptions {
  /** Default lazily creates an HTML audio element. Order is the candidate list order; both maybe/probably are eligible. */
  canPlayType?: (type: string) => CanPlayTypeResult;
}
const types: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg; codecs="opus"',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  webm: 'audio/webm',
  flac: 'audio/flac',
};

/**
 * Try each browser-supported URL once in order until fetching/decoding succeeds.
 * Abort stops the complete operation; exhaustion preserves every failure as an AggregateError cause.
 */
export async function loadAudioFallback(
  listener: AudioListener,
  candidates: readonly AudioCodecCandidate[],
  options: AudioCodecFallbackOptions = {},
): Promise<AudioBuffer> {
  options.signal?.throwIfAborted();
  if (!candidates.length)
    throw fault('state', 'Audio fallback needs at least one candidate; pass URLs or {url,type} entries');
  const probe =
    options.canPlayType ??
    (() => {
      if (typeof document === 'undefined')
        throw fault('unsupported', 'Audio fallback needs canPlayType; pass options.canPlayType outside a document');
      const audio = document.createElement('audio');
      return audio.canPlayType.bind(audio);
    })();
  const sources = candidates.map((candidate) => {
    const url = typeof candidate === 'string' ? candidate : candidate?.url;
    const type =
      typeof candidate === 'string'
        ? types[candidate.split(/[?#]/)[0].split('.').at(-1)!.toLowerCase()]
        : candidate?.type;
    if (typeof url !== 'string' || !url || typeof type !== 'string' || !type)
      throw fault(
        'state',
        'Audio fallback candidate needs a URL and a known type; pass {url,type} for extensionless URLs',
      );
    return { url, type };
  });
  const failures: unknown[] = [];
  for (const { url, type } of sources) {
    options.signal?.throwIfAborted();
    const support = probe(type);
    if (support !== 'maybe' && support !== 'probably') continue;
    try {
      return await listener.load(url, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      failures.push(error);
    }
  }
  if (!failures.length)
    throw fault(
      'unsupported',
      'No audio candidate is supported by this browser; supply another MIME/codec alternative',
    );
  throw Object.assign(
    fault('failed', 'Every supported audio candidate failed; inspect cause.errors and supply a working URL/codec'),
    { cause: new AggregateError(failures, 'Audio codec fallback exhausted') },
  );
}
