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

/** EBML IDs (RFC 9559): Segment and Cluster hold the frames, each in a SimpleBlock or a BlockGroup. */
const SEGMENT = 0x18538067,
  CLUSTER = 0x1f43b675,
  SIMPLE_BLOCK = 0xa3,
  BLOCK_GROUP = 0xa0;
/** WebM and MP4 headers fit far inside this; the first frame follows them. */
const HEAD = 1 << 20;

/**
 * True when a recording holds at least one encoded frame. MediaRecorder stopped before its encoder's first frame still
 * hands over the container header (Chromium: 110 bytes of WebM), which no decoder opens. WebM: a SimpleBlock or
 * BlockGroup inside a Cluster (an EBML walk that steps into Segment and Cluster, which MediaRecorder writes with unknown
 * size, and over every other element). MP4 (ISO/IEC 14496-12): an `mdat` box with a payload. Reads only box headers
 * and the first MiB, so a long recording is not copied.
 */
async function hasEncodedFrame(blob: Blob, mp4: boolean): Promise<boolean> {
  if (mp4) {
    for (let p = 0; p + 8 <= blob.size; ) {
      const head = new DataView(await blob.slice(p, p + 16).arrayBuffer());
      let size = head.getUint32(0),
        header = 8;
      if (size === 1 && head.byteLength >= 16) {
        size = Number(head.getBigUint64(8));
        header = 16;
      } else if (size === 0) size = blob.size - p;
      if (size < header) return false;
      if (head.getUint32(4) === 0x6d646174 /* mdat */) return size > header && p + header < blob.size;
      p += size;
    }
    return false;
  }
  const b = new Uint8Array(await blob.slice(0, HEAD).arrayBuffer()),
    vint = (p: number, id: boolean): { value: number; next: number; unknown: boolean } | undefined => {
      if (p >= b.length || !b[p]) return;
      const width = Math.clz32(b[p]!) - 23;
      if (width > 8 || p + width > b.length) return;
      let value = id ? b[p]! : b[p]! & (255 >> width),
        all = value === 255 >> width;
      for (let i = 1; i < width; i++) {
        value = value * 256 + b[p + i]!;
        all &&= b[p + i] === 255;
      }
      return { value, next: p + width, unknown: !id && all };
    };
  let inCluster = false;
  for (let p = 0; p < b.length; ) {
    const id = vint(p, true),
      size = id && vint(id.next, false);
    if (!id || !size) break;
    if (id.value === SEGMENT || id.value === CLUSTER) {
      inCluster ||= id.value === CLUSTER;
      p = size.next;
      continue;
    }
    if (inCluster && (id.value === SIMPLE_BLOCK || id.value === BLOCK_GROUP) && !size.unknown && size.value > 4)
      return true;
    if (size.unknown) break;
    p = size.next + size.value;
  }
  // Cut off inside the first MiB with no frame seen: a header that long is not one MediaRecorder writes.
  return blob.size > HEAD;
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
    recorder.addEventListener('stop', async () => {
      if (settled) return;
      const type = recorder!.mimeType || mimeType,
        blob = new Blob(chunks, { type });
      if (!blob.size) {
        fail(fault('state', 'Recording produced no data; render frames before stop()'));
        return;
      }
      // A recording stopped before its first encoded frame is a container header that nothing can play.
      let framed: boolean;
      try {
        framed = await hasEncodedFrame(blob, type.startsWith('video/mp4'));
      } catch (error) {
        fail(fault('state', `Recording could not be read back: ${String(error)}`));
        return;
      }
      if (settled) return;
      if (!framed) {
        fail(fault('state', 'Recording holds no encoded frame; render frames for longer before stop()'));
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
