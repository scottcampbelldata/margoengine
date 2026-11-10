// Frame sequences and video files. Encoding uses WebCodecs, specified by the W3C, wherever the runtime has it; the
// containers are in video-mux.ts. No node: imports: Node has no WebCodecs, so @margoengine/headless/ffmpeg covers it.
import type { Camera, Engine } from '@margoengine/core';
import { encodePNG, readPixels, type HeadlessPixels } from './index.js';
import { muxMP4, muxWebM, type SoundTrack, type VideoSample } from './video-mux.js';
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
  bytes: Uint8Array<ArrayBuffer>;
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
    yield {
      index,
      name: `${prefix}${String(index).padStart(digits, '0')}.png`,
      bytes: (await encodePNG(frame)) as Uint8Array<ArrayBuffer>,
    };
    index++;
  }
}

/** The part of WebCodecs {@link encodeVideo} uses. */
export interface WebCodecsBinding {
  VideoEncoder: typeof VideoEncoder;
  VideoFrame: typeof VideoFrame;
  /** Needed only with the `audio` option. */
  AudioEncoder?: typeof AudioEncoder;
  /** Needed only with the `audio` option. */
  AudioData?: typeof AudioData;
  /**
   * Lets an AAC track start on time: the encoder's lead-in is measured through it and cut by the file's edit list.
   * Without it the sound plays late by that lead-in (2112 samples, 44 ms at 48 kHz, from Chromium's AAC on macOS).
   */
  AudioDecoder?: typeof AudioDecoder;
}

/** Sound to put in the file with the frames. */
export interface VideoAudio {
  /** Samples from -1 to 1, one array per channel, one or two channels of one length. */
  channels: readonly Float32Array[];
  /** Samples per second. */
  sampleRate: number;
  /** Bits per second. Default 128000. */
  bitrate?: number;
}

/** Options of {@link encodeVideo}. */
export interface EncodeVideoOptions {
  /** JSON provenance embedded in WebM tags or an MP4 user-data box. Default none. */
  provenance?: Readonly<Record<string, unknown>>;
  /** Maximum retained encoded video payload bytes. Default 512 MiB. Audio is separately owned. */
  maxBytes?: number;
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
  /** Sound for the file: Opus in WebM, and AAC or else Opus in MP4. Default none. */
  audio?: VideoAudio;
  /** Where `VideoEncoder` and `VideoFrame` come from. Default `globalThis`. */
  webCodecs?: WebCodecsBinding;
  /** Stops encoding; the promise rejects with the signal's reason. Default none. */
  signal?: AbortSignal;
}

/** What {@link encodeVideo} gives back. */
export interface EncodedVideo {
  /** The whole file. */
  bytes: Uint8Array<ArrayBuffer>;
  /** For example `video/webm; codecs="vp09.00.51.08"`, for a `Blob` or an HTTP header. */
  mimeType: string;
  /** The codec string used. */
  codec: string;
  width: number;
  height: number;
  frames: number;
  /** Seconds. */
  duration: number;
  /** The sound codec used, when the file has sound. */
  audioCodec?: 'opus' | 'aac';
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

const SOUND_CODECS = {
    webm: [['opus', 'opus']],
    mp4: [
      ['mp4a.40.2', 'aac'],
      ['opus', 'opus'],
    ],
  } as const,
  SOUND_BLOCK = 0.5; // Seconds of sound in one AudioData.

const PROBE = 8192, // Samples of noise in the lead-in probe.
  LEAD_IN = 4096; // The longest lead-in looked for: AAC encoders put 1024 to 2112 samples first.

/**
 * Samples an encoder made with `config` puts before the sound it is given. WebCodecs reports no such count, and AAC
 * encoders add one (2112 on Chromium's macOS AAC), so it is measured: seeded noise goes through an encoder and a decoder
 * like the real ones, and the lead-in is the shift at which the decoded copy lines up best with the noise. 0 when the
 * binding has no AudioDecoder.
 */
async function encoderLeadIn(
  config: AudioEncoderConfig,
  { AudioEncoder: Encoder, AudioData: Data, AudioDecoder: Decoder }: WebCodecsBinding,
): Promise<number> {
  if (!Encoder || !Data || !Decoder) return 0;
  const noise = new Float32Array(PROBE),
    channels = config.numberOfChannels;
  for (let i = 0, seed = 1; i < PROBE; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    noise[i] = (seed / 2 ** 32 - 0.5) * 0.6;
  }
  const chunks: EncodedAudioChunk[] = [],
    heard: Float32Array[] = [];
  let decoderConfig: AudioDecoderConfig | undefined,
    failure: unknown,
    failed = false;
  const fail = (error: unknown) => {
    failure = error;
    failed = true;
  };
  const encoder = new Encoder({
    output(chunk, metadata) {
      chunks.push(chunk);
      if (metadata?.decoderConfig) decoderConfig = metadata.decoderConfig;
    },
    error: fail,
  });
  try {
    encoder.configure(config);
    const planes = new Float32Array(PROBE * channels);
    for (let c = 0; c < channels; c++) planes.set(noise, c * PROBE);
    const data = new Data({
      format: 'f32-planar',
      sampleRate: config.sampleRate,
      numberOfFrames: PROBE,
      numberOfChannels: channels,
      timestamp: 0,
      data: planes,
    });
    try {
      encoder.encode(data);
    } finally {
      data.close();
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failed) throw failure;
  if (!decoderConfig) throw fault('failed', 'The audio encoder gave no decoder configuration', 'headless');
  const decoder = new Decoder({
    output(audio) {
      const plane = new Float32Array(audio.numberOfFrames);
      audio.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
      heard.push(plane);
      audio.close();
    },
    error: fail,
  });
  try {
    decoder.configure(decoderConfig);
    for (const chunk of chunks) decoder.decode(chunk);
    await decoder.flush();
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  if (failed) throw failure;
  const out = new Float32Array(heard.reduce((sum, plane) => sum + plane.length, 0)),
    span = PROBE - LEAD_IN;
  heard.reduce((at, plane) => (out.set(plane, at), at + plane.length), 0);
  let best = 0,
    most = -Infinity;
  for (let lag = 0; lag <= LEAD_IN && lag + span <= out.length; lag++) {
    let sum = 0;
    for (let i = 0; i < span; i++) sum += noise[i] * out[i + lag];
    if (sum > most) {
      most = sum;
      best = lag;
    }
  }
  return best;
}

/** Encodes sound with WebCodecs into the form the containers take. */
async function encodeSound(
  { channels, sampleRate, bitrate = 128_000 }: VideoAudio,
  format: 'webm' | 'mp4',
  binding: WebCodecsBinding,
  signal: AbortSignal | undefined,
): Promise<SoundTrack> {
  const { AudioEncoder: Encoder, AudioData: Data } = binding;
  if (!Encoder || !Data) throw fault('unsupported', 'The audio option needs AudioEncoder', 'headless');
  if (channels.length !== 1 && channels.length !== 2) throw rangeError('Audio takes one or two channels', 'headless');
  const length = channels[0].length;
  if (!length || channels.some((channel) => channel.length !== length))
    throw rangeError('Audio channels must be one length, above 0', 'headless');
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw rangeError('Invalid audio sampleRate', 'headless');
  if (!(bitrate > 0) || !Number.isFinite(bitrate)) throw rangeError('Invalid audio bitrate', 'headless');
  const base = { sampleRate, numberOfChannels: channels.length, bitrate };
  let chosen: AudioEncoderConfig | undefined, codec: 'opus' | 'aac' | undefined;
  for (const [candidate, name] of SOUND_CODECS[format])
    if ((await Encoder.isConfigSupported({ ...base, codec: candidate })).supported) {
      chosen = { ...base, codec: candidate };
      codec = name;
      break;
    }
  if (!chosen || !codec) throw fault('unsupported', 'No audio codec is available for this format', 'headless');
  const samples: VideoSample[] = [];
  let description: Uint8Array | undefined,
    failure: unknown,
    failed = false;
  const encoder = new Encoder({
    output(chunk, metadata) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, timestamp: chunk.timestamp, duration: chunk.duration ?? 0, key: true });
      const decoder = metadata?.decoderConfig;
      if (decoder?.description) description = copyBytes(decoder.description);
    },
    error(error) {
      failure = error;
      failed = true;
    },
  });
  try {
    encoder.configure(chosen);
    const step = Math.round(SOUND_BLOCK * sampleRate);
    for (let start = 0; start < length; start += step) {
      signal?.throwIfAborted();
      if (failed) throw failure;
      const count = Math.min(step, length - start),
        planes = new Float32Array(count * channels.length);
      channels.forEach((channel, i) => planes.set(channel.subarray(start, start + count), i * count));
      const data = new Data({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: count,
        numberOfChannels: channels.length,
        timestamp: Math.round((start * 1e6) / sampleRate),
        data: planes,
      });
      try {
        encoder.encode(data);
      } finally {
        data.close();
      }
    }
    await encoder.flush();
    if (failed) throw failure;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (codec === 'aac' && !description) throw fault('failed', 'The encoder gave no AAC description', 'headless');
  // Opus states its own lead-in (the OpusHead pre-skip); AAC has nowhere to, so it is measured.
  const leadIn = codec === 'aac' ? await encoderLeadIn(chosen, binding) : 0;
  return { codec, sampleRate, channels: channels.length, description, samples, ...(leadIn ? { leadIn } : {}) };
}

/**
 * Encodes frames to a WebM or MP4 file in memory with WebCodecs. Frames are all one size, and alpha is dropped. Frames
 * are asked for only as the encoder keeps up, so {@link renderFrames} can feed it directly. `audio` adds a sound track.
 */
export async function encodeVideo(
  frames: AsyncIterable<HeadlessPixels> | Iterable<HeadlessPixels>,
  {
    format = 'webm',
    fps = 30,
    codec,
    bitrate,
    keyFrameInterval = 2,
    audio,
    provenance,
    maxBytes = 512 * 1024 * 1024,
    webCodecs = globalThis as unknown as WebCodecsBinding,
    signal,
  }: EncodeVideoOptions = {},
): Promise<EncodedVideo> {
  if (format !== 'webm' && format !== 'mp4') throw typeError('Video format: webm or mp4', 'headless');
  checkFps(fps);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw rangeError('maxBytes must be a positive safe integer', 'headless');
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
    count = 0,
    encodedBytes = 0;
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
            encodedBytes += chunk.byteLength;
            if (encodedBytes > maxBytes) {
              failure = rangeError('Encoded video exceeds maxBytes', 'headless');
              failed = true;
              wake();
              return;
            }
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
  const track = { codec: used, width, height, fps, description, colorSpace, provenance },
    sound = audio ? await encodeSound(audio, format, webCodecs, signal) : undefined;
  return {
    bytes: (format === 'webm'
      ? muxWebM(track, samples, sound)
      : muxMP4(track, samples, sound)) as Uint8Array<ArrayBuffer>,
    mimeType: `video/${format}; codecs="${used}"`,
    codec: used,
    width,
    height,
    frames: samples.length,
    duration: stamp(count) / 1e6,
    ...(sound ? { audioCodec: sound.codec } : {}),
  };
}
