// Frame sequences and video files. Encoding uses WebCodecs, specified by the W3C, wherever the runtime has it; the
// containers are in video-mux.ts. No node: imports: Node has no WebCodecs, so @margoengine/headless/ffmpeg covers it.
import type { Camera, Engine } from '@margoengine/core';
import { encodePNG, readPixels, type HeadlessPixels } from './index.js';
import { muxMP4, muxWebM, type VideoSample } from './video-mux.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** Where a frame sits in a sequence. */
export interface FrameTiming {
  /** From 0. */
  index: number;
  /** Seconds since the first frame. */
  time: number;
  /** Seconds since the frame before: 0 on the first frame, then `1 / fps`. */
  delta: number;
  /** `index / frames`: from 0 up to but never 1, so a full turn at `progress * 2 * Math.PI` loops with no repeat. */
  progress: number;
}

/** A frame from {@link renderFrames}: RGBA pixels and where it sits. */
export interface RenderedFrame extends HeadlessPixels, FrameTiming {}

/** Options of {@link renderFrames}. */
export interface RenderFramesOptions {
  /** How many frames, a whole number from 1. Required. */
  frames: number;
  /** Frames per second. Default 30. */
  fps?: number;
  /** Camera to render through. Default the engine's camera. */
  camera?: Camera;
  /** Runs before each frame is drawn; move the scene here. May be async. Default none. */
  update?: (frame: FrameTiming) => unknown;
  /** Stops the sequence; the iterator rejects with the signal's reason. Default none. */
  signal?: AbortSignal;
}

const checkFps = (fps: number): void => {
  if (!(fps > 0) || !Number.isFinite(fps)) throw rangeError('Invalid fps', 'headless');
};

/**
 * Renders a sequence one frame at a time on an engine on a headless canvas, reading each back. Time is the sequence's
 * own, not the wall clock, so a slow machine gives the same frames as a fast one. The next frame is not drawn until
 * the consumer asks for it, so one frame of pixels is alive at a time unless the consumer keeps them.
 */
export async function* renderFrames(
  engine: Engine,
  { frames, fps = 30, camera, update, signal }: RenderFramesOptions,
): AsyncGenerator<RenderedFrame, void, void> {
  if (!Number.isInteger(frames) || frames < 1) throw rangeError('Invalid frame count', 'headless');
  checkFps(fps);
  for (let index = 0; index < frames; index++) {
    signal?.throwIfAborted();
    const delta = index ? 1 / fps : 0,
      timing = { index, time: index / fps, delta, progress: index / frames };
    await update?.(timing);
    engine.render({ camera, delta });
    yield { ...timing, ...(await readPixels(engine, { signal })) };
  }
}

/** A file of an image sequence. */
export interface SequenceFile {
  /** From 0. */
  index: number;
  /** For example `frame_0007.png`. */
  name: string;
  /** PNG file bytes. */
  bytes: Uint8Array;
}

/** Options of {@link imageSequence}. */
export interface ImageSequenceOptions {
  /** Start of each file name. Default `'frame_'`. */
  prefix?: string;
  /** Digits of the number in each file name, padded with zeros. Default 4. */
  digits?: number;
}

/** Turns frames into numbered PNG files, one at a time. Writing them is the caller's, so it runs anywhere. */
export async function* imageSequence(
  frames: AsyncIterable<HeadlessPixels> | Iterable<HeadlessPixels>,
  { prefix = 'frame_', digits = 4 }: ImageSequenceOptions = {},
): AsyncGenerator<SequenceFile, void, void> {
  let index = 0;
  for await (const frame of frames) {
    yield { index, name: `${prefix}${String(index).padStart(digits, '0')}.png`, bytes: await encodePNG(frame) };
    index++;
  }
}

/** The part of WebCodecs {@link encodeVideo} uses. */
export interface WebCodecsBinding {
  VideoEncoder: typeof VideoEncoder;
  VideoFrame: typeof VideoFrame;
}

/** Options of {@link encodeVideo}. */
export interface EncodeVideoOptions {
  /** Container. Default `'webm'`. */
  format?: 'webm' | 'mp4';
  /** Frames per second. Default 30. */
  fps?: number;
  /** WebCodecs codec string. WebM takes `vp8`, `vp09.*` and `av01.*`; MP4 takes `avc1.*`, `vp09.*` and `av01.*`.
   * Default the first the runtime supports: VP9, VP8, AV1 for WebM; H.264, VP9, AV1 for MP4. */
  codec?: string;
  /** Bits per second. Default `width * height * fps / 10`, about 6 Mbit/s at 1920 x 1080 and 30 fps. */
  bitrate?: number;
  /** Seconds between key frames, which is how finely a player can seek. Default 2. */
  keyFrameInterval?: number;
  /** Where `VideoEncoder` and `VideoFrame` come from. Default `globalThis`. */
  webCodecs?: WebCodecsBinding;
  /** Stops encoding; the promise rejects with the signal's reason. Default none. */
  signal?: AbortSignal;
}

/** What {@link encodeVideo} gives back. */
export interface EncodedVideo {
  /** The whole file. */
  bytes: Uint8Array;
  /** For example `video/webm; codecs="vp09.00.51.08"`, for a `Blob` or an HTTP header. */
  mimeType: string;
  /** The codec string used. */
  codec: string;
  width: number;
  height: number;
  frames: number;
  /** Seconds. */
  duration: number;
}

const CODECS = {
    webm: ['vp09.00.51.08', 'vp8', 'av01.0.13M.08'],
    mp4: ['avc1.640033', 'avc1.4d0033', 'avc1.420033', 'vp09.00.51.08', 'av01.0.13M.08'],
  },
  ALLOWED = { webm: ['vp8', 'vp09', 'av01'], mp4: ['avc1', 'vp09', 'av01'] },
  QUEUE = 4, // Frames waiting in the encoder before the source is asked for more.
  BITS_PER_PIXEL = 0.1;

async function supportedConfig(
  Encoder: typeof VideoEncoder,
  format: 'webm' | 'mp4',
  codec: string | undefined,
  base: Omit<VideoEncoderConfig, 'codec'>,
): Promise<VideoEncoderConfig> {
  for (const candidate of codec === undefined ? CODECS[format] : [codec]) {
    if (!ALLOWED[format].includes(candidate.split('.')[0]))
      throw rangeError('This codec does not fit this container', 'headless');
    const config: VideoEncoderConfig = {
      ...base,
      codec: candidate,
      ...(candidate.startsWith('avc1') ? { avc: { format: 'avc' } } : {}),
    };
    if ((await Encoder.isConfigSupported(config)).supported) return config;
  }
  throw fault('unsupported', 'No video codec is available for this format and size', 'headless');
}

const copyBytes = (source: AllowSharedBufferSource): Uint8Array =>
  ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
    : new Uint8Array(source).slice();

/**
 * Encodes frames to a WebM or MP4 file in memory with WebCodecs. Frames are all one size, and alpha is dropped. Frames
 * are asked for only as the encoder keeps up, so {@link renderFrames} can feed it directly.
 */
export async function encodeVideo(
  frames: AsyncIterable<HeadlessPixels> | Iterable<HeadlessPixels>,
  {
    format = 'webm',
    fps = 30,
    codec,
    bitrate,
    keyFrameInterval = 2,
    webCodecs = globalThis as unknown as WebCodecsBinding,
    signal,
  }: EncodeVideoOptions = {},
): Promise<EncodedVideo> {
  if (format !== 'webm' && format !== 'mp4') throw typeError('Video format: webm or mp4', 'headless');
  checkFps(fps);
  if (!(keyFrameInterval > 0) || !Number.isFinite(keyFrameInterval))
    throw rangeError('Invalid keyFrameInterval', 'headless');
  if (bitrate !== undefined && (!(bitrate > 0) || !Number.isFinite(bitrate)))
    throw rangeError('Invalid bitrate', 'headless');
  const { VideoEncoder: Encoder, VideoFrame: Frame } = webCodecs;
  if (!Encoder || !Frame) throw fault('unsupported', 'encodeVideo needs WebCodecs', 'headless');
  signal?.throwIfAborted();

  const samples: VideoSample[] = [],
    keyEvery = Math.max(1, Math.round(keyFrameInterval * fps)),
    stamp = (index: number) => Math.round((index * 1e6) / fps);
  let encoder: VideoEncoder | undefined,
    config: VideoEncoderConfig | undefined,
    description: Uint8Array | undefined,
    colorSpace: VideoColorSpaceInit | undefined,
    failure: unknown,
    failed = false,
    wake = () => {},
    count = 0;
  const live = () => {
      signal?.throwIfAborted();
      if (failed) throw failure;
    },
    nudge = () => wake(),
    aborted = new Promise<never>((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  aborted.catch(() => {}); // Read through the race below; an abort may come when nothing is racing it.
  signal?.addEventListener('abort', nudge, { once: true });
  try {
    for await (const { width, height, data } of frames) {
      live();
      if (!encoder) {
        config = await supportedConfig(Encoder, format, codec, {
          width,
          height,
          framerate: fps,
          bitrate: bitrate ?? Math.round(width * height * fps * BITS_PER_PIXEL),
          latencyMode: 'quality',
        });
        live();
        encoder = new Encoder({
          output(chunk, metadata) {
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            samples.push({
              data: bytes,
              timestamp: chunk.timestamp,
              duration: chunk.duration ?? 0,
              key: chunk.type === 'key',
            });
            const decoder = metadata?.decoderConfig;
            if (decoder?.description) description = copyBytes(decoder.description);
            if (decoder?.colorSpace) colorSpace = decoder.colorSpace;
            wake();
          },
          error(error) {
            failure = error;
            failed = true;
            wake();
          },
        });
        encoder.addEventListener('dequeue', nudge);
        encoder.configure(config);
      } else if (width !== config!.width || height !== config!.height)
        throw rangeError('Video frames must all be one size', 'headless');
      if (data.length !== width * height * 4) throw rangeError('Frame data does not match its size', 'headless');
      while (encoder.encodeQueueSize >= QUEUE) {
        await new Promise<void>((resolve) => (wake = resolve));
        live();
      }
      const picture = new Frame(data, {
        format: 'RGBA',
        codedWidth: width,
        codedHeight: height,
        timestamp: stamp(count),
        duration: stamp(count + 1) - stamp(count),
      });
      try {
        encoder.encode(picture, { keyFrame: count % keyEvery === 0 });
      } finally {
        picture.close();
      }
      count++;
    }
    if (!encoder) throw fault('state', 'No frames to encode', 'headless');
    await Promise.race([encoder.flush(), aborted]);
    live();
  } finally {
    signal?.removeEventListener('abort', nudge);
    if (encoder && encoder.state !== 'closed') encoder.close();
  }
  const { codec: used, width, height } = config!;
  if (used.startsWith('avc1') && !description)
    throw fault('failed', 'The encoder gave no H.264 description', 'headless');
  const track = { codec: used, width, height, fps, description, colorSpace };
  return {
    bytes: format === 'webm' ? muxWebM(track, samples) : muxMP4(track, samples),
    mimeType: `video/${format}; codecs="${used}"`,
    codec: used,
    width,
    height,
    frames: samples.length,
    duration: stamp(count) / 1e6,
  };
}
