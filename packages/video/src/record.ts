/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** Real-time page recording options. */
export interface CanvasRecordingOptions {
  /**
   * Container. Default 'webm', with codecs chosen by the browser. 'mp4' asks for H.264, and AAC with audio, where the
   * browser offers them, so QuickTime can play the file; otherwise the browser chooses. Unsupported containers throw.
   */
  format?: 'webm' | 'mp4';
  /** Maximum capture rate in frames per second, finite and positive. Default 30. */
  fps?: number;
  /** Audio tracks to include. They are cloned; the caller retains ownership of the originals. Default none. */
  audio?: MediaStream;
  /** Requested video bitrate, a positive integer. Default browser choice. */
  videoBitsPerSecond?: number;
  /** Requested audio bitrate, a positive integer. Default browser choice. */
  audioBitsPerSecond?: number;
  /** Abort discards the result and releases capture tracks. Default none. */
  signal?: AbortSignal;
}

/** One recording. The complete compressed file stays in memory until it finishes. */
export interface CanvasRecording extends Disposable {
  /** Resolves after the final dataavailable event; rejects on abort, disposal or recorder failure. */
  readonly result: Promise<Blob>;
  /** Finishes the recording and returns the same result promise on every call. */
  stop(): Promise<Blob>;
  /** Discards an unfinished recording. Idempotent. */
  dispose(): void;
}

/**
 * Starts recording an origin-clean page canvas and optional audio with MediaRecorder.
 * Works with WebGPU, WebGL2 and 2D canvases; does not create or change an engine.
 * Throws `unsupported` when capture or the requested container is unavailable.
 */
export function recordCanvas(canvas: HTMLCanvasElement, options: CanvasRecordingOptions = {}): CanvasRecording {
  const { format = 'webm', fps = 30, signal } = options;
  signal?.throwIfAborted();
  if (format !== 'webm' && format !== 'mp4')
    throw typeError('Recording format is invalid; pass webm or mp4', 'arguments');
  if (!Number.isFinite(fps) || fps <= 0)
    throw rangeError('Recording fps is invalid; pass a finite positive rate', 'arguments');
  for (const value of [options.videoBitsPerSecond, options.audioBitsPerSecond])
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw rangeError('Recording bitrate is invalid; pass a positive safe integer', 'arguments');
  if (typeof MediaRecorder !== 'function' || typeof canvas?.captureStream !== 'function')
    throw fault('unsupported', 'Canvas recording needs a page with captureStream and MediaRecorder');
  const container = 'video/' + format;
  if (!MediaRecorder.isTypeSupported(container))
    throw fault('unsupported', `This browser cannot record ${container}; choose a supported container`);
  // An MP4 is asked for to open in other programs. Chrome's own choice is VP9 in MP4, which AVFoundation, and so
  // QuickTime Player and Quick Look, cannot decode (macOS 27.2, 2026-11-10); H.264 with AAC plays everywhere.
  const mp4 = options.audio?.getAudioTracks().length
      ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1']
      : ['video/mp4;codecs=avc1'],
    mimeType = (format === 'mp4' && mp4.find((type) => MediaRecorder.isTypeSupported(type))) || container;
  const tracks: MediaStreamTrack[] = [],
    chunks: Blob[] = [];
  let recorder: MediaRecorder | undefined,
    settled = false,
    stopping = false;
  let resolve!: (blob: Blob) => void, reject!: (error: unknown) => void;
  const result = new Promise<Blob>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Disposal can precede a consumer awaiting result. Keep the rejection observable on result.
  void result.catch(() => {});
  const cleanup = (): void => {
    signal?.removeEventListener('abort', abort);
    for (const track of tracks) track.stop();
    chunks.length = 0;
  };
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    cleanup();
    reject(error);
  };
  const abort = (): void => fail(signal!.reason);
  try {
    const stream = canvas.captureStream(fps);
    tracks.push(...stream.getTracks());
    for (const original of options.audio?.getAudioTracks() ?? []) {
      if (original.readyState !== 'live') throw fault('state', 'Recording audio track has ended; supply live audio');
      const track = original.clone();
      tracks.push(track);
      stream.addTrack(track);
    }
    recorder = new MediaRecorder(stream, {
      mimeType,
      ...(options.videoBitsPerSecond === undefined ? {} : { videoBitsPerSecond: options.videoBitsPerSecond }),
      ...(options.audioBitsPerSecond === undefined ? {} : { audioBitsPerSecond: options.audioBitsPerSecond }),
    });
    recorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (!settled && event.data.size) chunks.push(event.data);
    });
    recorder.addEventListener('error', () =>
      fail(fault('state', 'MediaRecorder failed; check the capture source and codecs')),
    );
    recorder.addEventListener('stop', () => {
      if (settled) return;
      const blob = new Blob(chunks, { type: recorder!.mimeType || mimeType });
      if (!blob.size) {
        fail(fault('state', 'Recording produced no data; render frames before stop()'));
        return;
      }
      settled = true;
      cleanup();
      resolve(blob);
    });
    signal?.addEventListener('abort', abort, { once: true });
    recorder.start();
  } catch (error) {
    const failure = fault(
      'state',
      `Canvas recording could not start: ${String(error)}; check origin access and live tracks`,
    );
    fail(failure);
    throw failure;
  }
  const dispose = (): void => fail(fault('disposed', 'Canvas recording was disposed before completion'));
  return {
    result,
    stop() {
      if (!settled && !stopping) {
        stopping = true;
        recorder!.stop();
      }
      return result;
    },
    dispose,
    [Symbol.dispose ?? Symbol()]: dispose,
  } as CanvasRecording;
}
