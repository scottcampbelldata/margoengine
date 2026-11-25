// Voice chat and screen share over the WebRTC links of a PeerMesh. Media tracks ride the same peer connections as the
// netcode data channels, and adding or removing one renegotiates over the existing signalling (the mesh runs the W3C
// "perfect negotiation" pattern). Sources: W3C WebRTC 1.0 (addTrack, removeTrack, negotiationneeded, perfect negotiation
// example), W3C Media Capture and Streams (getUserMedia, audio constraints, MediaStreamTrack.enabled and `ended`), W3C
// Screen Capture (getDisplayMedia), W3C Web Audio API (MediaStreamAudioSourceNode, AnalyserNode, GainNode).
import { fault } from './transport.js';
import type { PeerMesh } from './signal.js';

/** Who an event is about: a peer's room id, or `'self'` for this end. */
export type MediaPeer = number | 'self';

/** Options of {@link MediaSession}. */
export interface MediaSessionOptions {
  /** The `navigator.mediaDevices` to use (default the global one, in a browser). */
  mediaDevices?: Pick<MediaDevices, 'getUserMedia' | 'getDisplayMedia'>;
  /**
   * The Web Audio context that plays remote voices and measures levels (default: one is made on first use). Without
   * Web Audio (no `AudioContext` and none passed) voices are not played or measured: remote streams are still given on
   * `peer.stream` for your own `<audio>` element.
   */
  audioContext?: AudioContext;
  /**
   * Gives a remote voice its own place in your audio graph, for panning in 3D. It gets the peer's id, the peer's
   * volume node and the context, and returns the AudioNode to connect it to (a PannerNode, say, that you have
   * connected onward); return nothing to play it straight to `context.destination`.
   */
  spatial?(peer: number, volume: GainNode, context: AudioContext): AudioNode | void;
  /** Microphone constraints (default echo cancellation, noise suppression and automatic gain control all on). */
  audio?: MediaTrackConstraints;
  /** Start with the microphone closed until {@link MediaSession.talk} is pressed (default false). */
  pushToTalk?: boolean;
  /** RMS level (0 to 1) above which someone starts speaking (default 0.04). */
  speakingOn?: number;
  /** RMS level below which speech may stop (default 0.02): the gap to `speakingOn` is the hysteresis. */
  speakingOff?: number;
  /** Milliseconds the level must stay below `speakingOff` before speech stops (default 250). */
  speakingHangMs?: number;
  /** Milliseconds between level reads (default 50). 0 reads only on {@link MediaSession.poll}. */
  pollMs?: number;
  /** The clock in milliseconds (default `performance.now`). */
  now?: () => number;
}

/** Options of {@link MediaSession.startVoice} and {@link MediaSession.startScreenShare}. */
export interface MediaStartOptions {
  /** Aborts the start (it rejects with the signal's reason, and anything captured meanwhile is stopped). */
  signal?: AbortSignal;
}

/** Options of {@link MediaSession.startScreenShare}. */
export interface ScreenShareOptions extends MediaStartOptions {
  /** `getDisplayMedia` constraints (default `{ video: true, audio: false }`). */
  constraints?: DisplayMediaStreamOptions;
}

/** What a peer sends: its voice stream (audio only) and its screen stream (has video). */
export interface RemoteMedia {
  readonly peer: number;
  /** The peer's voice, or null while it sends none. */
  voice: MediaStream | null;
  /** The peer's shared screen (and its system audio, if shared), or null. */
  screen: MediaStream | null;
  /** Volume from 0 up (default 1). Read it back with {@link MediaSession.volume}. */
  volume: number;
  /** True when this end has muted that peer's voice. */
  muted: boolean;
  /** True while the peer is speaking. */
  speaking: boolean;
}

/** Event types of {@link MediaSession}. */
export interface MediaEventMap {
  /** A peer or this end started or stopped speaking. */
  speaking: { peer: MediaPeer; speaking: boolean };
  /** A peer's voice or screen appeared (`active` true) or went. */
  remote: { peer: number; kind: 'voice' | 'screen'; active: boolean; stream: MediaStream | null };
  /** This end's own screen share ended (stopped, or the user used the browser's stop button). */
  screenended: { peer: 'self' };
  /** A link failed to renegotiate or a track could not be added. */
  error: { peer: MediaPeer; error: unknown };
}

/** The event {@link MediaSession} dispatches: `detail` is the payload in {@link MediaEventMap}. */
export class MediaSessionEvent<K extends keyof MediaEventMap = keyof MediaEventMap> extends Event {
  constructor(
    type: K,
    readonly detail: MediaEventMap[K],
  ) {
    super(type);
  }
}

/**
 * Decides when someone is speaking from a stream of levels, with hysteresis so a voice that wavers around one line
 * does not flicker: speech starts above `on`, and stops only after the level has stayed under `off` for `hangMs`.
 */
export class SpeakingDetector {
  speaking = false;
  private quietSince: number | null = null;
  constructor(
    readonly on = 0.04,
    readonly off = 0.02,
    readonly hangMs = 250,
  ) {
    if (!(off >= 0 && on > off))
      throw new RangeError(`SpeakingDetector needs 0 <= off < on; got off ${off}, on ${on}`);
  }
  /** Feeds one level at time `now` (ms); returns true when `speaking` changed. */
  update(level: number, now: number): boolean {
    if (level >= this.on) {
      this.quietSince = null;
      if (this.speaking) return false;
      return (this.speaking = true);
    }
    if (!this.speaking || level >= this.off) {
      this.quietSince = null;
      return false;
    }
    this.quietSince ??= now;
    if (now - this.quietSince < this.hangMs) return false;
    this.speaking = false;
    this.quietSince = null;
    return true;
  }
}

/** RMS of time-domain samples (0 to 1). */
const rms = (samples: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
};

interface Meter {
  detector: SpeakingDetector;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  peer: MediaPeer;
}

interface Voice {
  source: MediaStreamAudioSourceNode;
  volume: GainNode;
}

interface Sent {
  senders: RTCRtpSender[];
  stream: MediaStream;
}

/**
 * Voice chat and screen share for the peers of a {@link PeerMesh}. Start the microphone with
 * {@link MediaSession.startVoice} and a screen with {@link MediaSession.startScreenShare}: tracks are added to every
 * link now and to each link made later, and the mesh renegotiates. A remote stream with video is a screen; one with
 * only audio is a voice. Many peers may share at once.
 *
 * @example
 * ```ts
 * const media = new MediaSession(mesh, { pushToTalk: false });
 * media.addEventListener('speaking', (event) => console.log((event as MediaSessionEvent<'speaking'>).detail));
 * await media.startVoice({ signal: AbortSignal.timeout(10_000) });
 * media.setMuted(true);
 * await media.startScreenShare();
 * media.dispose(); // stops the microphone and the screen
 * ```
 */
export class MediaSession extends EventTarget {
  /** What each peer sends now. */
  readonly remotes = new Map<number, RemoteMedia>();
  private readonly devices: Pick<MediaDevices, 'getUserMedia' | 'getDisplayMedia'> | undefined;
  private context: AudioContext | undefined;
  private readonly options: MediaSessionOptions;
  private readonly now: () => number;
  private readonly sent = new Map<'voice' | 'screen', Sent>();
  private readonly voices = new Map<number, Voice>();
  private readonly meters = new Map<MediaPeer, Meter>();
  private readonly cleanup: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private ptt: boolean;
  private talking = false;
  private muted = false;
  private disposed = false;
  private before: PeerMesh['onlink'];
  private beforeUnlink: PeerMesh['onunlink'];

  /** @throws MargoError `unsupported` when there is no `navigator.mediaDevices` here and none was passed. */
  constructor(
    private readonly mesh: PeerMesh,
    options: MediaSessionOptions = {},
  ) {
    super();
    this.options = options;
    this.devices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
    if (!this.devices)
      throw fault('unsupported', 'MediaSession needs navigator.mediaDevices; run it in a browser (HTTPS) or pass mediaDevices');
    this.context = options.audioContext;
    this.now = options.now ?? (() => performance.now());
    this.ptt = options.pushToTalk ?? false;
    const link = (this.before = mesh.onlink),
      unlink = mesh.onunlink;
    this.beforeUnlink = unlink;
    mesh.onlink = (id, peer) => {
      link?.(id, peer);
      this.attach(id, peer);
    };
    mesh.onunlink = (id, peer) => {
      unlink?.(id, peer);
      this.detach(id);
    };
    for (const [id, peer] of mesh.peerConnections) this.attach(id, peer);
    const pollMs = options.pollMs ?? 50;
    if (pollMs > 0) {
      this.timer = setInterval(() => this.poll(), pollMs);
      (this.timer as { unref?(): void }).unref?.();
    }
  }

  private emit<K extends keyof MediaEventMap>(type: K, detail: MediaEventMap[K]): void {
    this.dispatchEvent(new MediaSessionEvent(type, detail));
  }

  /** Events of one type as an async iterator; it ends when `signal` aborts or the session is disposed. */
  async *events<K extends keyof MediaEventMap>(type: K, { signal }: { signal?: AbortSignal } = {}): AsyncGenerator<MediaEventMap[K]> {
    const queue: Array<MediaEventMap[K]> = [];
    let wake: (() => void) | undefined;
    const push = (event: Event) => {
      queue.push((event as MediaSessionEvent<K>).detail);
      wake?.();
    };
    const stop = () => wake?.();
    this.addEventListener(type, push);
    this.addEventListener('dispose', stop);
    signal?.addEventListener('abort', stop);
    try {
      while (!signal?.aborted && !this.disposed) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      this.removeEventListener(type, push);
      this.removeEventListener('dispose', stop);
      signal?.removeEventListener('abort', stop);
    }
  }

  private audio(): AudioContext | undefined {
    if (this.context) return this.context;
    const Context = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    return Context ? (this.context = new Context()) : undefined;
  }

  private meter(peer: MediaPeer, node: AudioNode): void {
    const context = this.audio();
    if (!context) return;
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    node.connect(analyser);
    const o = this.options;
    this.meters.set(peer, {
      detector: new SpeakingDetector(o.speakingOn ?? 0.04, o.speakingOff ?? 0.02, o.speakingHangMs ?? 250),
      analyser,
      samples: new Float32Array(analyser.fftSize),
      peer,
    });
  }

  /** Reads every level once and emits `speaking` events on changes. Runs by itself every `pollMs`; call it to step by hand. */
  poll(): void {
    const now = this.now();
    for (const meter of this.meters.values()) {
      meter.analyser.getFloatTimeDomainData(meter.samples);
      // A closed microphone sends silence to others, and this end's own light follows what it sends.
      const level = meter.peer === 'self' && !this.open() ? 0 : rms(meter.samples);
      if (!meter.detector.update(level, now)) continue;
      const remote = typeof meter.peer === 'number' ? this.remotes.get(meter.peer) : undefined;
      if (remote) remote.speaking = meter.detector.speaking;
      this.emit('speaking', { peer: meter.peer, speaking: meter.detector.speaking });
    }
  }

  // ---- sending ----

  private async capture(
    get: () => Promise<MediaStream>,
    signal: AbortSignal | undefined,
  ): Promise<MediaStream> {
    if (this.disposed) throw fault('disposed', 'MediaSession is disposed; create a new one');
    signal?.throwIfAborted();
    const pending = get();
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal!.reason);
      signal?.addEventListener('abort', abort, { once: true });
    });
    try {
      const stream = await Promise.race([pending, aborted]);
      return stream;
    } catch (error) {
      // The capture that finishes after the abort must not leave the microphone or screen open.
      void pending.then((late) => late.getTracks().forEach((track) => track.stop()), () => {});
      throw error;
    } finally {
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }

  private send(kind: 'voice' | 'screen', stream: MediaStream): void {
    this.sent.set(kind, { senders: [], stream });
    for (const [id, peer] of this.mesh.peerConnections) this.addTracks(kind, id, peer);
  }

  private addTracks(kind: 'voice' | 'screen', id: number, peer: RTCPeerConnection): void {
    const sent = this.sent.get(kind);
    if (!sent) return;
    try {
      for (const track of sent.stream.getTracks()) sent.senders.push(peer.addTrack(track, sent.stream));
    } catch (error) {
      this.emit('error', { peer: id, error });
    }
  }

  private unsend(kind: 'voice' | 'screen'): void {
    const sent = this.sent.get(kind);
    if (!sent) return;
    this.sent.delete(kind);
    for (const [id, peer] of this.mesh.peerConnections)
      for (const sender of sent.senders) {
        if (!peer.getSenders().includes(sender)) continue;
        try {
          peer.removeTrack(sender);
        } catch (error) {
          this.emit('error', { peer: id, error });
        }
      }
    for (const track of sent.stream.getTracks()) track.stop();
  }

  /** Whether the microphone is open now: not muted, and (with push-to-talk) the talk key is down. */
  open(): boolean {
    return !this.muted && (!this.ptt || this.talking);
  }

  private applyOpen(): void {
    for (const track of this.sent.get('voice')?.stream.getAudioTracks() ?? []) track.enabled = this.open();
  }

  /**
   * Opens the microphone (`getUserMedia`, echo cancellation, noise suppression and automatic gain control on unless
   * `audio` says otherwise) and sends it to every peer, now and later.
   * @throws MargoError `state` when it is already on; `unsupported` without a microphone API; the signal's reason when
   * `signal` aborts; the browser's error (a `NotAllowedError` for a refused permission) otherwise.
   */
  async startVoice({ signal }: MediaStartOptions = {}): Promise<void> {
    if (this.sent.has('voice')) throw fault('state', 'Voice is already on; call stopVoice first');
    const stream = await this.capture(
      () =>
        this.devices!.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...this.options.audio },
          video: false,
        }),
      signal,
    );
    if (this.sent.has('voice') || this.disposed) {
      for (const track of stream.getTracks()) track.stop();
      throw this.disposed ? fault('disposed', 'MediaSession is disposed; create a new one') : fault('state', 'Voice is already on; call stopVoice first');
    }
    this.send('voice', stream);
    this.applyOpen();
    const context = this.audio();
    if (context) this.meter('self', context.createMediaStreamSource(stream));
  }

  /** Closes the microphone and removes it from every link. */
  stopVoice(): void {
    this.unsend('voice');
    this.meters.delete('self');
  }

  /** Mutes or unmutes the microphone for everyone (the track stays on the link, sending silence). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyOpen();
  }
  /** True while the microphone is muted. */
  get isMuted(): boolean {
    return this.muted;
  }

  /** Turns push-to-talk on or off. On, the microphone is closed until {@link MediaSession.talk}`(true)`. */
  setPushToTalk(enabled: boolean): void {
    this.ptt = enabled;
    this.applyOpen();
  }
  /** Presses (`true`) or releases (`false`) the talk key. Only matters while push-to-talk is on. */
  talk(down: boolean): void {
    this.talking = down;
    this.applyOpen();
  }

  /**
   * Shares a screen, window or tab (`getDisplayMedia`) with every peer. Stopping it from the browser's own control
   * ends the share and emits `screenended`.
   * @throws MargoError `state` when a share is already on; the signal's reason when `signal` aborts; the browser's
   * error (a `NotAllowedError` when the user declines) otherwise.
   */
  async startScreenShare({ signal, constraints = { video: true, audio: false } }: ScreenShareOptions = {}): Promise<void> {
    if (this.sent.has('screen')) throw fault('state', 'A screen is already shared; call stopScreenShare first');
    const stream = await this.capture(() => this.devices!.getDisplayMedia(constraints), signal);
    if (this.sent.has('screen') || this.disposed) {
      for (const track of stream.getTracks()) track.stop();
      throw this.disposed ? fault('disposed', 'MediaSession is disposed; create a new one') : fault('state', 'A screen is already shared; call stopScreenShare first');
    }
    const ended = () => {
      if (this.sent.get('screen')?.stream !== stream) return;
      this.stopScreenShare();
      this.emit('screenended', { peer: 'self' });
    };
    for (const track of stream.getVideoTracks()) track.addEventListener('ended', ended, { once: true });
    this.send('screen', stream);
  }

  /** Stops sharing the screen and removes it from every link. */
  stopScreenShare(): void {
    this.unsend('screen');
  }

  // ---- receiving ----

  /** Sets a peer's playback volume (0 and up, default 1). */
  setVolume(peer: number, volume: number): void {
    if (!(volume >= 0)) throw new RangeError(`volume is ${volume}; pass 0 or more`);
    const remote = this.remotes.get(peer);
    if (!remote) return;
    remote.volume = volume;
    this.applyVolume(peer);
  }
  /** Mutes or unmutes one peer's voice for this end only. */
  mutePeer(peer: number, muted: boolean): void {
    const remote = this.remotes.get(peer);
    if (!remote) return;
    remote.muted = muted;
    this.applyVolume(peer);
  }
  private applyVolume(peer: number): void {
    const remote = this.remotes.get(peer),
      voice = this.voices.get(peer);
    if (remote && voice) voice.volume.gain.value = remote.muted ? 0 : remote.volume;
  }

  private remote(id: number): RemoteMedia {
    let remote = this.remotes.get(id);
    if (!remote) this.remotes.set(id, (remote = { peer: id, voice: null, screen: null, volume: 1, muted: false, speaking: false }));
    return remote;
  }

  private attach(id: number, peer: RTCPeerConnection): void {
    for (const kind of ['voice', 'screen'] as const) this.addTracks(kind, id, peer);
    const ontrack = (event: RTCTrackEvent) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]),
        kind = stream.getVideoTracks().length || event.track.kind === 'video' ? 'screen' : 'voice';
      this.receive(id, kind, stream);
      const gone = () => this.lose(id, kind, stream);
      stream.addEventListener('removetrack', () => {
        if (!stream.getTracks().length) gone();
      });
      event.track.addEventListener('ended', gone, { once: true });
    };
    peer.addEventListener('track', ontrack as EventListener);
    this.cleanup.push(() => peer.removeEventListener('track', ontrack as EventListener));
  }

  private receive(id: number, kind: 'voice' | 'screen', stream: MediaStream): void {
    const remote = this.remote(id);
    if (remote[kind] === stream) return;
    remote[kind] = stream;
    if (kind === 'voice') this.play(id, stream);
    this.emit('remote', { peer: id, kind, active: true, stream });
  }

  private lose(id: number, kind: 'voice' | 'screen', stream: MediaStream): void {
    const remote = this.remotes.get(id);
    if (!remote || remote[kind] !== stream) return;
    remote[kind] = null;
    if (kind === 'voice') this.unplay(id);
    this.emit('remote', { peer: id, kind, active: false, stream: null });
  }

  private play(id: number, stream: MediaStream): void {
    const context = this.audio();
    if (!context) return;
    this.unplay(id);
    const source = context.createMediaStreamSource(stream),
      volume = context.createGain();
    source.connect(volume);
    // Level is read before the volume node, so a muted peer still shows as speaking.
    this.meter(id, source);
    this.voices.set(id, { source, volume });
    this.applyVolume(id);
    volume.connect(this.options.spatial?.(id, volume, context) ?? context.destination);
  }

  private unplay(id: number): void {
    const voice = this.voices.get(id);
    if (!voice) return;
    voice.source.disconnect();
    voice.volume.disconnect();
    this.voices.delete(id);
    this.meters.delete(id);
    const remote = this.remotes.get(id);
    if (remote?.speaking) {
      remote.speaking = false;
      this.emit('speaking', { peer: id, speaking: false });
    }
  }

  private detach(id: number): void {
    const remote = this.remotes.get(id);
    if (remote?.voice) this.lose(id, 'voice', remote.voice);
    if (remote?.screen) this.lose(id, 'screen', remote.screen);
    this.remotes.delete(id);
  }

  /** Stops every track this end sends, leaves the mesh's hooks and ends event iterators. The mesh and its links stay. */
  dispose(): void {
    if (this.disposed) return;
    this.stopVoice();
    this.stopScreenShare();
    this.disposed = true;
    clearInterval(this.timer);
    for (const id of [...this.remotes.keys()]) this.detach(id);
    for (const undo of this.cleanup.splice(0)) undo();
    this.mesh.onlink = this.before;
    this.mesh.onunlink = this.beforeUnlink;
    this.dispatchEvent(new Event('dispose'));
  }
  /** Same as {@link MediaSession.dispose}, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
