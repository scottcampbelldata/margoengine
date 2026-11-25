// Frame sequences and video files. Encoding uses WebCodecs, specified by the W3C, wherever the runtime has it; the
// containers are in video-mux.ts. No node: imports: Node has no WebCodecs, so @margoengine/headless/ffmpeg covers it.
import type { Camera, Engine } from '@margoengine/core';
import { encodePNG, readPixels, type HeadlessPixels } from './index.js';
import { FragmentedMP4, StreamedWebM, muxMP4, muxWebM, type SoundTrack, type VideoSample } from './video-mux.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { AccumulateTarget, SubFrameOptions, SubFrameTiming } from '@margoengine/headless/accumulate';

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
export interface RenderFramesOptions
  extends Pick<SubFrameOptions, 'shutterPhase' | 'filter' | 'filterWidth' | 'seed' | 'pattern' | 'startFrame'> {
  /** How many frames, a whole number from 1. Required. */
  frames: number;
  /** Frames per second. Default 30. */
  fps?: number;
  /** Camera to render through. Default the engine's camera. */
  camera?: Camera;
  /** Runs before each frame is drawn; move the scene here. May be async. With `samples` or `shutter` it runs before
   * every render of a frame, with that render's time (a {@link SubFrameTiming}). Default none. */
  update?: (frame: FrameTiming | SubFrameTiming) => unknown;
  /** Stops the sequence; the iterator rejects with the signal's reason. Default none. */
  signal?: AbortSignal;
  /** Renders per frame averaged in linear light, for anti-aliasing and motion blur (`renderAccumulated` from
   * `@margoengine/headless/accumulate`, loaded on first use). Default 1: one render a frame, as before. */
  samples?: number;
  /** Share of the frame interval the shutter is open, 0 to 1, for motion blur. Default 0: no blur. */
  shutter?: number;
  /** The Accumulate stage in your PostStack, for `samples` or `shutter`. Default one attached alone. */
  accumulate?: AccumulateTarget;
}

// The samples every encoder is given: Margo converts each RGBA frame itself and hands over 4:2:0 planes labelled with
// this colour space, so the file states what its samples are. Encoders that convert RGBA themselves do not report what
// they wrote: WebKit 27.2 on macOS writes limited-range BT.709 and reports full range with no matrix, so a player drew
// the file contrast-reduced (docs/known-bugs.md, "WebKit headless MP4 drawn contrast-reduced"). Limited-range BT.709 with
// the sRGB transfer of the rendered pixels (ITU-R BT.709-6 item 3.2 to 3.5; ITU-T H.273 code points 1, 13, 1).
const SAMPLE_SPACE: VideoColorSpaceInit = {
  primaries: 'bt709',
  transfer: 'iec61966-2-1',
  matrix: 'bt709',
  fullRange: false,
};

/**
 * Limited-range BT.709 I420 planes of 8-bit RGBA pixels (alpha ignored): Y per pixel, Cb and Cr per 2 x 2 block.
 * Y = 16 + 219 E'Y, Cb = 128 + 224 (E'B - E'Y) / 1.8556, Cr = 128 + 224 (E'R - E'Y) / 1.5748, with
 * E'Y = 0.2126 E'R + 0.7152 E'G + 0.0722 E'B (BT.709-6 items 3.2 to 3.5).
 *
 * Chroma is made where players put it when the stream does not say: ITU-T H.273 chroma_sample_loc_type 0, the default
 * of H.264 and H.265 (Annex E) and what the files state (VP9 `vpcC` chroma 0, Matroska ChromaSiting left and half).
 * A sample sits on luma column 2x, between rows 2y and 2y + 1, so it weighs columns 2x - 1, 2x, 2x + 1 by 1/4, 1/2,
 * 1/4 (the triangle prefilter of that position) and the two rows equally, with edge pixels repeated. A centred 2 x 2
 * mean, labelled this way, is drawn half a pixel to the right.
 */
function rgbaToI420(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  codedWidth = width,
  codedHeight = height,
): Uint8Array {
  // A coded size past the frame (an odd frame padded for H.264 or H.265) repeats the last column and row.
  const cw = (codedWidth + 1) >> 1,
    ch = (codedHeight + 1) >> 1,
    size = codedWidth * codedHeight,
    out = new Uint8Array(size + 2 * cw * ch),
    luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  for (let y = 0, i = 0; y < codedHeight; y++)
    for (let x = 0; x < codedWidth; x++, i++) {
      const p = (Math.min(y, height - 1) * width + Math.min(x, width - 1)) * 4;
      out[i] = Math.round(16 + (219 / 255) * luma(data[p], data[p + 1], data[p + 2]));
    }
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let dy = 0; dy < 2; dy++) {
        const row = Math.min(height - 1, 2 * y + dy) * width;
        for (let dx = -1; dx <= 1; dx++) {
          const p = (row + Math.min(width - 1, Math.max(0, 2 * x + dx))) * 4,
            weight = dx ? 1 : 2;
          r += weight * data[p];
          g += weight * data[p + 1];
          b += weight * data[p + 2];
        }
      }
      // The weights sum to 8.
      const e = luma(r, g, b),
        at = size + y * cw + x;
      out[at] = Math.round(128 + (224 / 255) * ((b - e) / 8 / 1.8556));
      out[at + cw * ch] = Math.round(128 + (224 / 255) * ((r - e) / 8 / 1.5748));
    }
  return out;
}

/**
 * The alpha of 8-bit RGBA pixels as an I420 picture for a second encoder: the alpha values as luma, as they are, and
 * flat chroma. WebM carries that picture's frames beside the colour (Matroska codec mappings V_VP8 and V_VP9, "a
 * single-channel encoding of an alpha channel"); players take its luma plane as the alpha.
 */
function alphaToI420(data: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const size = width * height,
    out = new Uint8Array(size + 2 * ((width + 1) >> 1) * ((height + 1) >> 1)).fill(128, size);
  for (let i = 0; i < size; i++) out[i] = data[i * 4 + 3];
  return out;
}

const checkFps = (fps: number): void => {
  if (!(fps > 0) || !Number.isFinite(fps)) throw rangeError('Invalid fps', 'headless');
};

/**
 * Renders a sequence one frame at a time on an engine on a headless canvas, reading each back. Time is the sequence's
 * own, not the wall clock, so a slow machine gives the same frames as a fast one. The next frame is not drawn until
 * the consumer asks for it, so one frame of pixels is alive at a time unless the consumer keeps them. With `samples`
 * above 1 or `shutter` above 0 each frame is `samples` renders over the open shutter averaged in linear light
 * (`renderAccumulated`; `startFrame`, `shutterPhase`, `filter`, `filterWidth`, `seed` and `pattern` apply then);
 * otherwise each frame is one render, exactly as before.
 */
export async function* renderFrames(
  engine: Engine,
  options: RenderFramesOptions,
): AsyncGenerator<RenderedFrame, void, void> {
  const { frames, fps = 30, camera, update, signal, samples = 1, shutter = 0 } = options;
  if (samples !== 1 || shutter !== 0) {
    const { renderAccumulated } = await import('@margoengine/headless/accumulate');
    yield* renderAccumulated(engine, { ...options, samples, shutter, output: 'display' });
    return;
  }
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

/**
 * A frame for {@link encodeVideo}: RGBA pixels, and optionally when it is shown. Give `timestamp` on every frame or on
 * none: without it frame n shows at n / fps.
 */
export interface VideoInputFrame extends HeadlessPixels {
  /** Seconds, counted from the first frame's `timestamp`; each frame's later than the one before. Default none. */
  timestamp?: number;
  /** Seconds the last timed frame is shown. Default the gap before it, or 1 / fps for a single frame. Other frames last
   * until the next one. */
  duration?: number;
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
  /** WebCodecs codec string. WebM takes `vp8`, `vp09.*` and `av01.*`; MP4 takes `avc1.*`, `hvc1.*`, `hev1.*`,
   * `vp09.*` and `av01.*`.
   * Default the first the runtime supports: VP9, VP8, AV1 for WebM; H.264, VP9, AV1 for MP4. */
  codec?: string;
  /** Bits per second. Default `width * height * fps / 10`, about 6 Mbit/s at 1920 x 1080 and 30 fps. */
  bitrate?: number;
  /** Seconds between key frames, which is how finely a player can seek. Default 2. */
  keyFrameInterval?: number;
  /** Sound for the file: Opus in WebM, and AAC or else Opus in MP4. Default none. */
  audio?: VideoAudio;
  /** Keep the frames' alpha: a second encoder codes it, and WebM carries it beside each frame (VP9, else VP8; WebM
   * only, as MP4 has no binding for it). Pixels are straight alpha, as `readPixels` gives them. Default false. */
  alpha?: boolean;
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
  /** True when the file carries alpha. */
  alpha?: boolean;
}

const CODECS = {
    webm: ['vp09.00.51.08', 'vp8', 'av01.0.13M.08'],
    mp4: ['avc1.640033', 'avc1.4d0033', 'avc1.420033', 'vp09.00.51.08', 'av01.0.13M.08'],
  },
  ALLOWED = { webm: ['vp8', 'vp09', 'av01'], mp4: ['avc1', 'hvc1', 'hev1', 'vp09', 'av01'] },
  ALPHA = /^(vp8|vp09\.)/, // The codecs whose Matroska mappings carry alpha.
  QUEUE = 4, // Frames waiting in the encoder before the source is asked for more.
  BITS_PER_PIXEL = 0.1;

async function supportedConfig(
  Encoder: typeof VideoEncoder,
  format: 'webm' | 'mp4',
  codec: string | undefined,
  alpha: boolean,
  base: Omit<VideoEncoderConfig, 'codec'>,
): Promise<VideoEncoderConfig> {
  for (const candidate of codec === undefined ? CODECS[format].filter((name) => !alpha || ALPHA.test(name)) : [codec]) {
    if (!ALLOWED[format].includes(candidate.split('.')[0]))
      throw rangeError('This codec does not fit this container', 'headless');
    // H.264 and H.265 4:2:0 state a picture size in steps of two (H.264 7.4.2.1.1 CropUnitX and CropUnitY; H.265
    // 7.4.3.2.1 SubWidthC and SubHeightC), so an odd frame gains a repeated last column or row there.
    const even = /^(avc1|hvc1|hev1)\./.test(candidate);
    const config: VideoEncoderConfig = {
      ...base,
      ...(even ? { width: base.width + (base.width & 1), height: base.height + (base.height & 1) } : {}),
      codec: candidate,
      ...(candidate.startsWith('avc1') ? { avc: { format: 'avc' } } : {}),
      // Length-prefixed units with the parameter sets in `description` (WebCodecs HEVC registration, HevcEncoderConfig).
      ...(/^(hvc1|hev1)\./.test(candidate) ? { hevc: { format: 'hevc' } } : {}),
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
 * The AudioSpecificConfig of an AAC encoder's `description`. The WebCodecs AAC registration says the description is that
 * config (ISO/IEC 14496-3 1.6.2.1), and Chromium gives it so. WebKit (Safari 27.2, Playwright WebKit 2370) gives a whole
 * ES_Descriptor instead, and its own AudioDecoder then refuses it. A description starting with ES_DescrTag (3) is walked
 * per ISO/IEC 14496-1 7.2.6.5 (ES_Descriptor), 7.2.6.6 (DecoderConfigDescriptor) and 8.3.3 (sizes of up to four bytes
 * of seven bits) to its DecSpecificInfo (tag 5); any other description is the config already.
 */
function aacAudioSpecificConfig(description: Uint8Array): Uint8Array {
  if (description[0] !== 3) return description;
  const bad = (): never => {
    throw fault('failed', 'The AAC encoder gave an ES_Descriptor without a DecSpecificInfo', 'headless');
  };
  let at = 0;
  // One descriptor header: its tag must be `tag`; returns the end of its body.
  const enter = (tag: number): number => {
    if (description[at++] !== tag) bad();
    let size = 0;
    for (let i = 0; i < 4; i++) {
      const byte = description[at++] ?? bad();
      size = size * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return at + size <= description.length ? at + size : bad();
    }
    return bad();
  };
  enter(3);
  const flags = description[at + 2] ?? bad();
  at += 3; // ES_ID and the flags byte.
  if (flags & 0x80) at += 2; // dependsOn_ES_ID
  if (flags & 0x40) at += 1 + (description[at] ?? bad()); // URLlength and URLstring
  if (flags & 0x20) at += 2; // OCR_ES_Id
  const config = enter(4);
  at += 13; // objectTypeIndication, streamType and its flags, bufferSizeDB, maxBitrate, avgBitrate.
  if (at >= config) bad();
  const end = enter(5);
  return end <= config ? description.slice(at, end) : bad();
}

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
  if (decoderConfig.description)
    decoderConfig = { ...decoderConfig, description: aacAudioSpecificConfig(copyBytes(decoderConfig.description)) };
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
      if (decoder?.description)
        description =
          codec === 'aac' ? aacAudioSpecificConfig(copyBytes(decoder.description)) : copyBytes(decoder.description);
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
  // The input is contiguous, so its encoded frames are too: each starts where the one before ended, counted in samples.
  // WebKit stamps the first chunk after each AudioData with that AudioData's time though its frames run on (AAC: 22
  // frames of 1024 samples, then a jump of 448 samples, every half second), which in a sample table is a gap.
  if (samples.length && samples.every((sample) => sample.duration > 0)) {
    let frames = Math.round((samples[0].timestamp * sampleRate) / 1e6);
    for (const sample of samples) {
      sample.timestamp = Math.round((frames * 1e6) / sampleRate);
      frames += Math.round((sample.duration * sampleRate) / 1e6);
    }
  }
  if (codec === 'aac' && !description) throw fault('failed', 'The encoder gave no AAC description', 'headless');
  // Opus states its own lead-in (the OpusHead pre-skip); AAC has nowhere to, so it is measured.
  const leadIn = codec === 'aac' ? await encoderLeadIn(chosen, binding) : 0;
  return { codec, sampleRate, channels: channels.length, description, samples, ...(leadIn ? { leadIn } : {}) };
}

/** What the encoder has given so far, and the stream's settings once known. */
interface EncodedBatch {
  samples: VideoSample[];
  config: VideoEncoderConfig;
  description?: Uint8Array;
  /** The frames have their own times. */
  timed: boolean;
}

/** How a run of {@link encodeSamples} ended. */
interface EncodedRun {
  config: VideoEncoderConfig;
  description?: Uint8Array;
  /** Seconds: where the last frame ends. */
  end: number;
  timed: boolean;
}

type SampleOptions = Required<
  Pick<EncodeVideoOptions, 'format' | 'fps' | 'keyFrameInterval' | 'maxBytes' | 'webCodecs' | 'alpha'>
> &
  Pick<EncodeVideoOptions, 'codec' | 'bitrate' | 'signal'>;

function checkOptions({
  format,
  fps,
  maxBytes,
  keyFrameInterval,
  bitrate,
  webCodecs,
  alpha,
  codec,
}: SampleOptions): void {
  checkFps(fps);
  if (alpha && (format !== 'webm' || (codec !== undefined && !ALPHA.test(codec))))
    throw fault('unsupported', 'Alpha video needs WebM with VP9 or VP8', 'headless');
  if (maxBytes !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxBytes) || maxBytes < 1))
    throw rangeError('maxBytes must be a positive safe integer', 'headless');
  if (!(keyFrameInterval > 0) || !Number.isFinite(keyFrameInterval))
    throw rangeError('Invalid keyFrameInterval', 'headless');
  if (bitrate !== undefined && (!(bitrate > 0) || !Number.isFinite(bitrate)))
    throw rangeError('Invalid bitrate', 'headless');
  if (!webCodecs?.VideoEncoder || !webCodecs.VideoFrame)
    throw fault('unsupported', 'Encoding video needs WebCodecs', 'headless');
}

/**
 * Feeds frames to a WebCodecs encoder and yields its samples, in decode order, as they come out: after each frame and
 * after the final flush. Frames are asked for only as the encoder keeps up. Stopping the iteration closes the encoder.
 */
async function* encodeSamples(
  frames: AsyncIterable<VideoInputFrame> | Iterable<VideoInputFrame>,
  { format, fps, codec, bitrate, keyFrameInterval, maxBytes, webCodecs, alpha, signal }: SampleOptions,
): AsyncGenerator<EncodedBatch, EncodedRun, void> {
  const { VideoEncoder: Encoder, VideoFrame: Frame } = webCodecs;
  signal?.throwIfAborted();
  const samples: VideoSample[] = [],
    keyEvery = Math.max(1, Math.round(keyFrameInterval * fps)),
    stamp = (index: number) => Math.round((index * 1e6) / fps);
  // With alpha, a second encoder codes the alpha planes; its frames wait here to be paired with the colour by time.
  const colours: VideoSample[] = [],
    alphas: VideoSample[] = [];
  let encoder: VideoEncoder | undefined,
    alphaEncoder: VideoEncoder | undefined,
    config: VideoEncoderConfig | undefined,
    frameWidth = 0,
    frameHeight = 0,
    description: Uint8Array | undefined,
    failure: unknown,
    failed = false,
    wake = () => {},
    count = 0,
    encodedBytes = 0,
    // Frames with their own times: none known yet (undefined), timed or not. A timed frame waits for the next one,
    // which gives its duration.
    timed: boolean | undefined,
    origin = 0,
    lastTime = 0,
    gap = 0,
    lastKey = Number.NEGATIVE_INFINITY,
    held: { planes: Uint8Array; alpha?: Uint8Array; time: number; duration?: number } | undefined,
    end = 0;
  const live = () => {
      signal?.throwIfAborted();
      if (failed) throw failure;
    },
    nudge = () => wake(),
    aborted = new Promise<never>((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    batch = (): EncodedBatch => ({ samples: samples.splice(0), config: config!, description, timed: !!timed });
  aborted.catch(() => {}); // Read through the race below; an abort may come when nothing is racing it.
  signal?.addEventListener('abort', nudge, { once: true });
  try {
    // One frame to the encoder, and its alpha to the alpha encoder, `time` and `duration` in seconds from the first frame.
    const submit = async (
      planes: Uint8Array,
      alphaPlanes: Uint8Array | undefined,
      time: number,
      duration: number,
      key: boolean,
    ) => {
      while (encoder!.encodeQueueSize >= QUEUE || (alphaEncoder?.encodeQueueSize ?? 0) >= QUEUE) {
        await new Promise<void>((resolve) => (wake = resolve));
        live();
      }
      const timestamp = Math.round(time * 1e6);
      for (const [into, data] of [
        [encoder!, planes],
        [alphaEncoder, alphaPlanes],
      ] as const) {
        if (!into || !data) continue;
        const picture = new Frame(data, {
          format: 'I420',
          codedWidth: config!.width,
          codedHeight: config!.height,
          colorSpace: SAMPLE_SPACE,
          timestamp,
          duration: Math.round((time + duration) * 1e6) - timestamp,
        });
        try {
          into.encode(picture, { keyFrame: key });
        } finally {
          picture.close();
        }
      }
      end = time + duration;
    };
    // A held timed frame, now that its duration is known; key frames come keyFrameInterval seconds apart.
    const release = async (duration: number) => {
      const { planes, alpha: alphaPlanes, time } = held!,
        key = time - lastKey >= keyFrameInterval - 1e-9;
      if (key) lastKey = time;
      held = undefined;
      await submit(planes, alphaPlanes, time, duration, key);
    };
    for await (const input of frames) {
      const { width, height, data } = input,
        stamped = input.timestamp !== undefined;
      live();
      timed ??= stamped;
      if (stamped !== timed) throw rangeError('Give every video frame a timestamp, or none of them', 'headless');
      if (timed) {
        const { timestamp, duration } = input;
        if (typeof timestamp !== 'number' || !Number.isFinite(timestamp))
          throw rangeError('A video frame timestamp is a finite number of seconds', 'headless');
        if (duration !== undefined && !(typeof duration === 'number' && duration > 0 && Number.isFinite(duration)))
          throw rangeError('A video frame duration is a positive number of seconds', 'headless');
        if (count === 0) origin = timestamp;
        else if (!(timestamp - origin > lastTime)) throw rangeError('Video frame timestamps must increase', 'headless');
      }
      if (!encoder) {
        [frameWidth, frameHeight] = [width, height];
        config = await supportedConfig(Encoder, format, codec, alpha, {
          width,
          height,
          framerate: fps,
          bitrate: bitrate ?? Math.round(width * height * fps * BITS_PER_PIXEL),
          latencyMode: 'quality',
        });
        live();
        const error = (error: unknown) => {
            failure = error;
            failed = true;
            wake();
          },
          // Output into `into`; frames go out once each has its alpha, which the two encoders give in the same order.
          output = (into: VideoSample[]) => (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => {
            encodedBytes += chunk.byteLength;
            if (encodedBytes > maxBytes) return error(rangeError('Encoded video exceeds maxBytes', 'headless'));
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            into.push({
              data: bytes,
              timestamp: chunk.timestamp,
              duration: chunk.duration ?? 0,
              key: chunk.type === 'key',
            });
            const decoder = metadata?.decoderConfig;
            if (into === colours && decoder?.description) description = copyBytes(decoder.description);
            for (; colours.length && (!alpha || alphas.length); ) {
              const sample = colours.shift()!,
                mask = alphas.shift();
              if (mask && mask.timestamp !== sample.timestamp)
                return error(fault('failed', 'The alpha encoder gave a frame the colour encoder did not', 'headless'));
              // A seek lands on a key frame, so it is one only when both its colour and its alpha start afresh.
              samples.push(mask ? { ...sample, key: sample.key && mask.key, alpha: mask.data } : sample);
            }
            wake();
          };
        encoder = new Encoder({ output: output(colours), error });
        encoder.addEventListener('dequeue', nudge);
        encoder.configure(config);
        if (alpha) {
          alphaEncoder = new Encoder({ output: output(alphas), error });
          alphaEncoder.addEventListener('dequeue', nudge);
          alphaEncoder.configure(config);
        }
      } else if (width !== frameWidth || height !== frameHeight)
        throw rangeError('Video frames must all be one size', 'headless');
      if (data.length !== width * height * 4) throw rangeError('Frame data does not match its size', 'headless');
      const planes = rgbaToI420(data, width, height, config!.width, config!.height),
        alphaPlanes = alpha ? alphaToI420(data, width, height) : undefined;
      if (timed) {
        const time = input.timestamp! - origin;
        if (held) {
          gap = time - held.time;
          await release(gap);
        }
        held = { planes, alpha: alphaPlanes, time, duration: input.duration };
        lastTime = time;
      } else
        await submit(
          planes,
          alphaPlanes,
          stamp(count) / 1e6,
          (stamp(count + 1) - stamp(count)) / 1e6,
          count % keyEvery === 0,
        );
      count++;
      if (samples.length) yield batch();
    }
    if (!encoder) throw fault('state', 'No frames to encode', 'headless');
    if (held) await release(held.duration ?? (count > 1 ? gap : 1 / fps));
    await Promise.race([Promise.all([encoder.flush(), alphaEncoder?.flush()]), aborted]);
    live();
    if (colours.length || alphas.length)
      throw fault('failed', 'The alpha encoder gave a different number of frames than the colour encoder', 'headless');
    if (samples.length) yield batch();
  } finally {
    signal?.removeEventListener('abort', nudge);
    for (const one of [encoder, alphaEncoder]) if (one && one.state !== 'closed') one.close();
  }
  const used = config!.codec;
  if (used.startsWith('avc1') && !description)
    throw fault('failed', 'The encoder gave no H.264 description', 'headless');
  if ((used.startsWith('hvc1') || used.startsWith('hev1')) && !description)
    throw fault('failed', 'The encoder gave no H.265 description', 'headless');
  return { config: config!, description, end, timed: !!timed };
}

/** RFC 6381: the codecs parameter names every stream in the file, the sound's too. */
const mimeOf = (format: 'webm' | 'mp4', codec: string, sound: SoundTrack | undefined) =>
  `video/${format}; codecs="${codec}${sound ? (sound.codec === 'aac' ? ',mp4a.40.2' : ',opus') : ''}"`;

/**
 * Encodes frames to a WebM or MP4 file in memory with WebCodecs. Frames are all one size; alpha is dropped unless
 * `alpha` keeps it (WebM, VP9 or VP8). Frames are asked for only as the encoder keeps up, so {@link renderFrames} can
 * feed it directly. `audio` adds a sound track.
 */
export async function encodeVideo(
  frames: AsyncIterable<VideoInputFrame> | Iterable<VideoInputFrame>,
  {
    format = 'webm',
    fps = 30,
    codec,
    bitrate,
    keyFrameInterval = 2,
    audio,
    alpha = false,
    provenance,
    maxBytes = 512 * 1024 * 1024,
    webCodecs = globalThis as unknown as WebCodecsBinding,
    signal,
  }: EncodeVideoOptions = {},
): Promise<EncodedVideo> {
  if (format !== 'webm' && format !== 'mp4') throw typeError('Video format: webm or mp4', 'headless');
  const options = { format, fps, codec, bitrate, keyFrameInterval, maxBytes, webCodecs, alpha, signal };
  checkOptions(options);
  const run = encodeSamples(frames, options),
    samples: VideoSample[] = [];
  let step: IteratorResult<EncodedBatch, EncodedRun>;
  while (!(step = await run.next()).done) for (const sample of step.value.samples) samples.push(sample);
  const {
      config: { codec: used, width, height },
      description,
      end,
      timed,
    } = step.value,
    track = {
      codec: used,
      width,
      height,
      fps,
      description,
      colorSpace: SAMPLE_SPACE,
      provenance,
      ...(timed ? { variable: true } : {}),
      ...(alpha ? { alpha } : {}),
    },
    sound = audio ? await encodeSound(audio, format, webCodecs, signal) : undefined;
  return {
    bytes: (format === 'webm'
      ? muxWebM(track, samples, sound)
      : muxMP4(track, samples, sound)) as Uint8Array<ArrayBuffer>,
    mimeType: mimeOf(format, used, sound),
    codec: used,
    width,
    height,
    frames: samples.length,
    duration: Math.round(end * 1e6) / 1e6,
    ...(sound ? { audioCodec: sound.codec } : {}),
    ...(alpha ? { alpha } : {}),
  };
}

/** Options of {@link streamVideo}: those of {@link encodeVideo} less `maxBytes`, as only one key frame interval is held. */
export interface StreamVideoOptions extends Omit<EncodeVideoOptions, 'format' | 'maxBytes'> {
  /** Container: fragmented MP4, or WebM written as a live stream. Default `'mp4'`. */
  format?: 'mp4' | 'webm';
}

/** What {@link streamVideo} returns when its iteration ends: {@link EncodedVideo} without the bytes, already given. */
export type StreamedVideo = Omit<EncodedVideo, 'bytes'>;

/**
 * Encodes frames to a video file and yields it in pieces as it is made, so only one key frame interval of encoded video
 * is held at a time and a long render needs no `maxBytes`. Write each piece as it comes, to a file, a socket or a
 * `WritableStream` (`ReadableStream.from(streamVideo(...))`). The pieces joined are a whole file, and all but the last
 * are what Media Source Extensions take.
 *
 * - `'mp4'` (the default): a fragmented MP4 (ISO/IEC 14496-12 8.8): the header (`ftyp` and `moov`) once the encoder has
 *   given its configuration, one `moof` and `mdat` per key frame interval, then an `mfra` index for seeking.
 * - `'webm'`: a WebM written as a live stream (RFC 9559 6.2): the header, whose Segment has an unknown size and which so
 *   states no duration, one Cluster per key frame interval, then the Cues. `alpha` keeps the frames' alpha (VP9 or VP8),
 *   as {@link encodeVideo} does.
 *
 * The iteration's return value describes the file. Stopping the iteration (`break`, or `signal`) closes the encoder.
 */
export async function* streamVideo(
  frames: AsyncIterable<VideoInputFrame> | Iterable<VideoInputFrame>,
  given: StreamVideoOptions = {},
): AsyncGenerator<Uint8Array<ArrayBuffer>, StreamedVideo, void> {
  const {
    format = 'mp4',
    fps = 30,
    codec,
    bitrate,
    keyFrameInterval = 2,
    audio,
    alpha = false,
    provenance,
    webCodecs = globalThis as unknown as WebCodecsBinding,
    signal,
  } = given;
  if (format !== 'webm' && format !== 'mp4') throw typeError('Video format: webm or mp4', 'headless');
  const options = {
    format,
    fps,
    codec,
    bitrate,
    keyFrameInterval,
    maxBytes: Number.POSITIVE_INFINITY,
    webCodecs,
    alpha,
    signal,
  };
  checkOptions(options);
  // The sound is given whole, so it is encoded first and each fragment carries the stretch of it beside its frames.
  const sound = audio ? await encodeSound(audio, format, webCodecs, signal) : undefined,
    run = encodeSamples(frames, options);
  let writer: FragmentedMP4 | StreamedWebM | undefined,
    count = 0,
    step: IteratorResult<EncodedBatch, EncodedRun>;
  // Stopping this iteration early stops the encoder's too, which closes the encoder.
  try {
    while (!(step = await run.next()).done) {
      const { samples, config, description, timed } = step.value;
      for (const sample of samples) {
        writer ??= new (format === 'webm' ? StreamedWebM : FragmentedMP4)(
          {
            codec: config.codec,
            width: config.width,
            height: config.height,
            fps,
            description,
            colorSpace: SAMPLE_SPACE,
            provenance,
            ...(timed ? { variable: true } : {}),
            ...(alpha ? { alpha } : {}),
          },
          sound,
        );
        count++;
        for (const piece of writer.add(sample)) yield piece as Uint8Array<ArrayBuffer>;
      }
    }
  } finally {
    await run.return(undefined as never);
  }
  const {
    config: { codec: used, width, height },
    end,
  } = step.value;
  for (const piece of writer!.finish()) yield piece as Uint8Array<ArrayBuffer>;
  return {
    mimeType: mimeOf(format, used, sound),
    codec: used,
    width,
    height,
    frames: count,
    duration: Math.round(end * 1e6) / 1e6,
    ...(sound ? { audioCodec: sound.codec } : {}),
    ...(alpha ? { alpha } : {}),
  };
}
