// @margoengine/cutscene/render: a cutscene at a fixed frame rate into a video file, for trailers. Time is the render's
// own, not the wall clock, so a slow machine makes the same file as a fast one. Frames and the file come from
// @margoengine/headless/video; the sound of the document's audio tracks is mixed here, in plain code, so a mix is the
// same on every machine, and encoded with the same file.
import type { Camera, Engine } from '@margoengine/core';
import {
  type EncodeVideoOptions,
  type EncodedVideo,
  type FrameTiming,
  encodeVideo,
  renderFrames,
} from '@margoengine/headless/video';
import type { CutsceneOptions, CutsceneState } from './cutscene.js';
import { Cutscene } from './cutscene.js';
import type { CutsceneDocument } from './document.js';
import { CutscenePlayer } from './player.js';

/** A sound to mix: an `AudioBuffer`, or anything with the same members. */
export interface MixSound {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

/** Options of {@link mixCutsceneAudio}. */
export interface MixOptions {
  /** Output rate, samples per second. Default 48000. */
  sampleRate?: number;
  /** Output channels, 1 or 2. Default 2. */
  channels?: 1 | 2;
  /** Start of the span to mix, seconds. Default 0. */
  from?: number;
  /** End of the span to mix, seconds. Default the end of the cutscene. */
  to?: number;
}

/** What {@link mixCutsceneAudio} gives back. */
export interface CutsceneMix {
  /** One array per channel. */
  channels: Float32Array[];
  sampleRate: number;
  /** The largest absolute sample. Above 1 the mix will clip when encoded: lower the clips' `volume`. */
  peak: number;
}

/** A frame of {@link cutsceneFrames}. */
export interface CutsceneFrame {
  /** From 0. */
  index: number;
  /** Time on the cutscene, seconds. */
  time: number;
  /** The whole state at that time. */
  state: CutsceneState;
}

/** Options of {@link cutsceneFrames}. */
export interface CutsceneFramesOptions {
  /** Frames per second. Default 30. */
  fps?: number;
  /** Start of the span, seconds. Default 0. */
  from?: number;
  /** End of the span, seconds. Default the end of the cutscene. */
  to?: number;
}

/** Options of {@link renderCutscene}. */
export interface RenderCutsceneOptions
  extends CutsceneFramesOptions,
    Pick<EncodeVideoOptions, 'format' | 'codec' | 'bitrate' | 'keyFrameInterval' | 'webCodecs'>,
    CutsceneOptions {
  /** Puts a frame's state on your scene: objects, animation, particles. May be async. Required. */
  apply: (state: CutsceneState, frame: CutsceneFrame) => unknown;
  /** Render through this camera, set from `state.camera` before `apply`. Default the engine's camera, left to `apply`. */
  camera?: Camera;
  /** The sounds the audio tracks name, by name. Default none: the file has no sound. */
  sounds?: Readonly<Record<string, MixSound>>;
  /** Sample rate of the sound. Default 48000. */
  sampleRate?: number;
  /** Bits per second of the sound. Default 128000. */
  audioBitrate?: number;
  /** Called after each frame is drawn, with frames done and frames in all. Default none. */
  onProgress?: (done: number, total: number) => void;
  /** Stops rendering; the promise rejects with the signal's reason. Default none. */
  signal?: AbortSignal;
}

/** Samples mixed between evaluations; about 2.7 ms at 48 kHz, so a fade is a straight line inside one. */
const BLOCK = 128;

const span = (cutscene: Cutscene, from = 0, to = cutscene.duration): [number, number] => {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > cutscene.duration || !(to > from))
    throw new RangeError(`Render span must lie inside the cutscene (0 to ${cutscene.duration}) with from before to`);
  return [from, to];
};

const positive = (value: number, name: string): void => {
  if (!(value > 0) || !Number.isFinite(value)) throw new RangeError(`${name} must be a finite number above 0`);
};

/** Reads a sound at `time` seconds, by straight lines between its samples; silence outside it. */
function read(sound: MixSound, channel: number, time: number): number {
  const at = time * sound.sampleRate,
    index = Math.floor(at);
  if (index < 0 || index >= sound.length) return 0;
  const data = sound.getChannelData(channel),
    next = index + 1 < sound.length ? data[index + 1] : 0;
  return data[index] + (next - data[index]) * (at - index);
}

/**
 * Mixes the sounds of the document's audio tracks to plain samples: every clip in nested timelines too, with its
 * volume, fades, offset and nested speed, as `evaluate` reports them. The mix is a sum, with no limiter; read `peak`.
 * A mono sound goes to both channels, and a stereo sound in a mono mix is averaged.
 * @throws RangeError naming a sound a clip uses and `sounds` does not hold, or for a bad span.
 */
export function mixCutsceneAudio(
  cutscene: Cutscene,
  sounds: Readonly<Record<string, MixSound>>,
  { sampleRate = 48_000, channels = 2, from, to }: MixOptions = {},
): CutsceneMix {
  positive(sampleRate, 'sampleRate');
  if (channels !== 1 && channels !== 2) throw new RangeError('channels must be 1 or 2');
  const [start, end] = span(cutscene, from, to),
    total = Math.round((end - start) * sampleRate),
    out = Array.from({ length: channels }, () => new Float32Array(total)),
    // Blocks break at every clip's start and end, so the set of sounds cannot change inside one.
    edges = [
      ...new Set(
        cutscene.instants
          .filter((event) => event.type === 'audio' && event.kind !== 'event')
          .map((event) => Math.ceil((event.time - start) * sampleRate - 1e-6))
          .filter((sample) => sample > 0 && sample < total),
      ),
    ].sort((a, b) => a - b);
  edges.push(total);
  const seconds = (sample: number): number => start + sample / sampleRate;
  let sample = 0,
    next = 0;
  while (sample < total) {
    while (edges[next] <= sample) next++;
    const stop = Math.min(sample + BLOCK, edges[next]),
      count = stop - sample,
      // Two evaluations inside the block give the line each clip's time and volume follow through it.
      near = seconds(sample + count / 4),
      far = seconds(sample + (3 * count) / 4),
      first = cutscene.evaluate(near).audio,
      second = cutscene.evaluate(far).audio;
    first.forEach((clip, i) => {
      const other = second[i] ?? clip,
        sound = sounds[clip.sound];
      if (!sound || !Object.hasOwn(sounds, clip.sound)) throw new RangeError(`No sound '${clip.sound}' to mix; add it to sounds`);
      const rate = far > near ? (other.time - clip.time) / (far - near) : 1,
        fade = far > near ? (other.volume - clip.volume) / (far - near) : 0;
      for (let n = sample; n < stop; n++) {
        const lead = seconds(n) - near,
          time = clip.time + rate * lead,
          volume = Math.max(0, clip.volume + fade * lead),
          stereo = sound.numberOfChannels > 1;
        if (channels === 1) out[0][n] += volume * (stereo ? (read(sound, 0, time) + read(sound, 1, time)) / 2 : read(sound, 0, time));
        else {
          out[0][n] += volume * read(sound, 0, time);
          out[1][n] += volume * read(sound, stereo ? 1 : 0, time);
        }
      }
    });
    sample = stop;
  }
  let peak = 0;
  for (const channel of out) for (const value of channel) peak = Math.max(peak, Math.abs(value));
  return { channels: out, sampleRate, peak };
}

/**
 * The frames of a span at a fixed rate: frame `i` shows `from + i / fps`, and the last starts before `to`. Plain state
 * with no engine, for a pipeline of your own.
 */
export function* cutsceneFrames(
  cutscene: Cutscene,
  { fps = 30, from, to }: CutsceneFramesOptions = {},
): Generator<CutsceneFrame, void, void> {
  positive(fps, 'fps');
  const [start, end] = span(cutscene, from, to),
    frames = frameCount(start, end, fps);
  for (let index = 0; index < frames; index++) {
    const time = start + index / fps;
    yield { index, time, state: cutscene.evaluate(time) };
  }
}

/** Whole frames that start before the end. A duration that is a whole number of frames must not gain one by rounding. */
const frameCount = (from: number, to: number, fps: number): number => Math.max(1, Math.ceil((to - from) * fps - 1e-9));

/**
 * Renders a cutscene to a WebM or MP4 file with WebCodecs, at a fixed frame rate. The engine must be on a
 * `createHeadlessCanvas` canvas of the video's size. A {@link CutscenePlayer} you pass fires every instant in order as
 * the frames go by, as if it played; listeners may spawn things, and the frames show them.
 * @throws RangeError for a bad span or rate, or a sound nobody gave; see `encodeVideo` for what the encoder refuses.
 */
export async function renderCutscene(
  engine: Engine,
  cutscene: Cutscene | CutscenePlayer | CutsceneDocument | string | unknown,
  options: RenderCutsceneOptions,
): Promise<EncodedVideo> {
  const {
    apply,
    camera,
    fps = 30,
    from,
    to,
    sounds,
    sampleRate,
    audioBitrate,
    onProgress,
    signal,
    tracks,
    ...video
  } = options;
  if (typeof apply !== 'function') throw new TypeError('renderCutscene needs apply(state, frame) to put state on your scene');
  positive(fps, 'fps');
  const player =
    cutscene instanceof CutscenePlayer
      ? cutscene
      : new CutscenePlayer(cutscene instanceof Cutscene ? cutscene : new Cutscene(cutscene, { tracks }));
  const scene = player.cutscene,
    [start, end] = span(scene, from, to),
    frames = frameCount(start, end, fps),
    audio = sounds ? mixCutsceneAudio(scene, sounds, { sampleRate, from: start, to: end }) : undefined;
  player.seek(start);
  const finished = player.play();
  const update = async ({ index }: FrameTiming): Promise<void> => {
    const time = start + index / fps;
    if (index) player.skip(time);
    const state = scene.evaluate(time);
    if (camera && state.camera) {
      camera.position = state.camera.position;
      camera.target = state.camera.target;
      camera.fov = state.camera.fov;
      camera.up = state.camera.up;
    }
    await apply(state, { index, time, state });
    if (index) onProgress?.(index, frames);
  };
  try {
    const file = await encodeVideo(renderFrames(engine, { frames, fps, camera, update, signal }), {
      ...video,
      fps,
      signal,
      ...(audio ? { audio: { channels: audio.channels, sampleRate: audio.sampleRate, bitrate: audioBitrate } } : {}),
    });
    onProgress?.(frames, frames);
    player.skip(end);
    return file;
  } finally {
    player.pause();
    await finished;
  }
}
