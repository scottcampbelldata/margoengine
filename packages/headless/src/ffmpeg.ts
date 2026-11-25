// Video files in Node, which has no WebCodecs: raw frames go down a pipe to the ffmpeg the app already has. This entry is
// Node only. ffmpeg is not shipped or downloaded here, and it runs without a shell, so no argument is interpreted.
import { spawn } from 'node:child_process';
import type { HeadlessPixels } from './index.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { hexColor } from '@margoengine/math/color';
import { COLOUR_TAGS, colourFilter } from './ffmpeg-colour.js';

/** Options of {@link encodeWithFFmpeg}. */
export interface FFmpegOptions {
  /** File to write; an existing file is replaced. Required. */
  output: string;
  /** Frames per second. Default 30. */
  fps?: number;
  /** The program, or the program and its first arguments (`['nice', 'ffmpeg']`). Default `'ffmpeg'` on the `PATH`. */
  ffmpeg?: string | readonly string[];
  /** Output arguments replacing the default, which is chosen from the file name: VP9 at `-crf 32` for `.webm`, H.264 at
   * `-crf 20` for anything else, both 4:2:0 BT.709. */
  args?: readonly string[];
  /** Sound for the file, piped to ffmpeg beside the frames: Opus for `.webm`, AAC for anything else. With `args`,
   * the sound is input 1 and mapped; the codec is then yours to choose. Default none. */
  audio?: FFmpegAudio;
  /** Keep the frames' alpha: VP9 with an alpha plane (`yuva420p`), which ffmpeg writes beside each frame as WebM
   * BlockAdditions. `.webm` files with the default arguments only. Default false. */
  alpha?: boolean;
  /** Video or picture files laid over the frames inside the same encode (picture in picture), in order, each on
   * top of the ones before. The result goes through the same colour chain as a plain render. Default none. */
  layers?: readonly FFmpegLayer[];
  /** Stops ffmpeg; the promise rejects with the signal's reason, and a partial file may stay behind. Default none. */
  signal?: AbortSignal;
}

/** A file laid over the rendered frames by {@link encodeWithFFmpeg}. */
export interface FFmpegLayer {
  /** A video or picture file ffmpeg reads. Its own sound is not used. */
  input: string;
  /** The box it fills, in pixels of the written frame. Whole numbers inside the frame. */
  rect: { x: number; y: number; width: number; height: number };
  /** Seconds into the video where it shows. Default 0. */
  start?: number;
  /** Seconds it shows; past the end of its file its last frame stays. Default: until its file ends (a still
   * picture, one frame, needs a duration). */
  duration?: number;
  /** Seconds into its file where it starts. Default 0. */
  in?: number;
  /** Playback speed: 2 plays it twice as fast. Default 1. */
  speed?: number;
  /** How it fills the box: `'contain'` (all of it, the rest of the box `pad`), `'cover'` (fills the box, the edges
   * cut) or `'fill'` (stretched). Default `'contain'`. */
  fit?: 'contain' | 'cover' | 'fill';
  /** The part of the file used, `[x, y, width, height]` in its own pixels, cut before the fit. Even whole numbers
   * (4:2:0 chroma covers two by two pixels), inside the file. Default: all of it. */
  crop?: readonly [number, number, number, number];
  /** The colour a `'contain'` fit fills the rest of its box with: `'#rgb'`, `'#rrggbb'` or `'#rrggbbaa'`. Default
   * clear, so the frames show through. */
  pad?: string;
  /** The matrix its YCbCr is read with, replacing the file's tag. Default: the file's tag; untagged, `'bt709'` at
   * 720 lines or more and `'bt601'` below (ITU-R BT.709 is the HD matrix, BT.601 the SD one). RGB files have none. */
  matrix?: FFmpegMatrix;
  /** The range its YCbCr is read with, replacing the file's tag: `'tv'` (limited, 16 to 235) or `'pc'` (full).
   * Default: the file's tag; untagged, `'tv'`. */
  range?: 'tv' | 'pc';
}

/** A YCbCr matrix: ITU-R BT.709, BT.601 (H.273 codes 5 and 6) or BT.2020 non-constant luminance. */
export type FFmpegMatrix = 'bt709' | 'bt601' | 'bt2020';

/** What {@link probeVideo} reads of a file's first video stream. */
export interface VideoProbe {
  /** ffmpeg's name of its codec, such as `'h264'`, `'vp9'`, `'png'` or `'mjpeg'`. */
  codec: string;
  /** ffmpeg's name of its pixel format, such as `'yuv420p'` or `'rgb24'`. */
  pixelFormat: string;
  width: number;
  height: number;
  /** True for RGB, palette and grey pixel formats, which have no YCbCr matrix. */
  rgb: boolean;
  /** The matrix the file is tagged with (ffmpeg's name: `'bt709'`, `'bt470bg'`, `'smpte170m'`, `'bt2020nc'` ...), or
   * undefined when it carries none. */
  matrix?: string;
  /** The range the file is tagged with, or undefined when it carries none. */
  range?: 'tv' | 'pc';
}

/** Sound for {@link encodeWithFFmpeg}. */
export interface FFmpegAudio {
  /** Samples from -1 to 1, one array per channel, one or two channels of one length. */
  channels: readonly Float32Array[];
  /** Samples per second. */
  sampleRate: number;
  /** Bits per second. Default 128000. */
  bitrate?: number;
}

/** Options of {@link layersOverPicture}. */
export interface LayersOverPictureOptions {
  /** Frames per second of the video the picture is a frame of. Default 30. */
  fps?: number;
  /** The frame number the picture is: the layers are laid as frame `frame` of {@link encodeWithFFmpeg} lays them.
   * Required. */
  frame: number;
  /** The layers, as {@link FFmpegOptions.layers}. */
  layers: readonly FFmpegLayer[];
  /** The program, or the program and its first arguments. Default `'ffmpeg'` on the `PATH`. */
  ffmpeg?: string | readonly string[];
  /** Stops ffmpeg; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** What {@link encodeWithFFmpeg} gives back. */
export interface FFmpegResult {
  output: string;
  width: number;
  height: number;
  frames: number;
  /** Seconds of sound written, when there is sound. */
  audioDuration?: number;
}

// The engine's colour chain (ffmpeg-colour.ts): BT.709 matrix and primaries, sRGB transfer, TV range, left chroma.
const colour = (format: string) => ['-vf', colourFilter(format), ...COLOUR_TAGS],
  VP9 = ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0'],
  H264 = [...colour('yuv420p'), '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart'],
  MOST_LOG = 4096,
  SOUND_PIPE = 3, // The sound's pipe: stdio[3], ffmpeg's pipe:3.
  SOUND_BLOCK = 16384; // Sample frames per write to the sound pipe.

/** Checks sound and returns its channel count and length. */
function checkAudio({ channels, sampleRate, bitrate = 128_000 }: FFmpegAudio): number {
  if (!Array.isArray(channels) || (channels.length !== 1 && channels.length !== 2))
    throw rangeError('Audio takes one or two channels', 'headless');
  const length = channels[0].length;
  if (!length || channels.some((channel) => !(channel instanceof Float32Array) || channel.length !== length))
    throw rangeError('Audio channels must be Float32Arrays of one length, above 0', 'headless');
  if (!Number.isInteger(sampleRate) || sampleRate < 1) throw rangeError('Invalid audio sampleRate', 'headless');
  if (!(bitrate > 0) || !Number.isFinite(bitrate)) throw rangeError('Invalid audio bitrate', 'headless');
  return length;
}

/** Little-endian interleaved 32-bit float samples, ffmpeg's `f32le`, of sample frames `start` to `end`. */
function interleave(channels: readonly Float32Array[], start: number, end: number): Uint8Array {
  const count = channels.length,
    out = new DataView(new ArrayBuffer((end - start) * count * 4));
  for (let i = start, at = 0; i < end; i++)
    for (let c = 0; c < count; c++, at += 4) out.setFloat32(at, channels[c][i], true);
  return new Uint8Array(out.buffer);
}

/** Alpha has a binding in WebM only (Matroska BlockAdditions); with `args` the pixel format is the caller's. */
function checkAlpha(output: string, args: readonly string[] | undefined, alpha: boolean | undefined): void {
  if (alpha && (args || !/\.webm$/i.test(output)))
    throw fault('unsupported', 'Alpha video needs a .webm file and the default arguments', 'headless');
}

const number = (x: number) => String(Math.round(x * 1e6) / 1e6);
const SCALE_FLAGS = 'flags=lanczos+accurate_rnd+full_chroma_int';

const MATRICES: readonly string[] = ['bt709', 'bt601', 'bt2020'];

/** `'#rgb'`, `'#rrggbb'` or `'#rrggbbaa'` as ffmpeg's `0xRRGGBBAA`, or undefined when it is none of them. */
function padColour(colour: string): string | undefined {
  const rgba = hexColor(colour);
  return (
    rgba &&
    `0x${rgba
      .map((c) =>
        Math.round(c * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`
  );
}

/** Checks the layers against a `width` x `height` frame and fills in their defaults. */
function checkLayers(width: number, height: number, layers: readonly FFmpegLayer[] | undefined) {
  if (layers === undefined) return [];
  if (!Array.isArray(layers)) throw typeError('layers must be an array', 'headless');
  return layers.map((layer: FFmpegLayer, i) => {
    const at = `Layer ${i}`,
      {
        input,
        rect,
        start = 0,
        duration,
        in: from = 0,
        speed = 1,
        fit = 'contain',
        crop,
        pad,
        matrix,
        range,
      } = layer ?? ({} as FFmpegLayer);
    if (typeof input !== 'string' || !input) throw typeError(`${at} needs an input file`, 'headless');
    const { x, y, width: w, height: h } = rect ?? ({} as FFmpegLayer['rect']);
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height)
      throw rangeError(`${at} rect must be whole pixels inside the ${width}x${height} frame`, 'headless');
    if (!(start >= 0) || !Number.isFinite(start)) throw rangeError(`${at} start must be 0 or more seconds`, 'headless');
    if (duration !== undefined && (!(duration > 0) || !Number.isFinite(duration)))
      throw rangeError(`${at} duration must be above 0 seconds`, 'headless');
    if (!(from >= 0) || !Number.isFinite(from)) throw rangeError(`${at} in must be 0 or more seconds`, 'headless');
    if (!(speed > 0) || !Number.isFinite(speed)) throw rangeError(`${at} speed must be above 0`, 'headless');
    if (!['contain', 'cover', 'fill'].includes(fit))
      throw rangeError(`${at} fit is 'contain', 'cover' or 'fill'`, 'headless');
    if (
      crop !== undefined &&
      (!Array.isArray(crop) ||
        crop.length !== 4 ||
        !crop.every((v) => Number.isInteger(v) && v >= 0 && v % 2 === 0) ||
        crop[2] < 2 ||
        crop[3] < 2)
    )
      throw rangeError(`${at} crop is [x, y, width, height] in even whole pixels, width and height from 2`, 'headless');
    const padding = pad === undefined ? '0x00000000' : typeof pad === 'string' ? padColour(pad) : undefined;
    if (!padding) throw rangeError(`${at} pad is a colour '#rgb', '#rrggbb' or '#rrggbbaa'`, 'headless');
    if (matrix !== undefined && !MATRICES.includes(matrix))
      throw rangeError(`${at} matrix is 'bt709', 'bt601' or 'bt2020'`, 'headless');
    if (range !== undefined && range !== 'tv' && range !== 'pc')
      throw rangeError(`${at} range is 'tv' or 'pc'`, 'headless');
    return { input, x, y, w, h, start, duration, from, speed, fit, crop, padding, matrix, range };
  });
}

/**
 * The inputs and filter graph that lay `layers` over the frames (`base`, input 0), then run `chain`: each layer read
 * from its `in` (for its duration times its speed, and a second more), cropped, retimed to start at its `start`,
 * stepped to the film's rate by nearest time, scaled into its box with its matrix and range, and overlaid while it
 * shows: frame k shows it when start <= k / fps < start + duration. The graph's output is `[v]`.
 */
function layerGraph(
  layers: ReturnType<typeof checkLayers>,
  firstInput: number,
  fps: number,
  chain: string,
  base = '0:v',
) {
  const inputs: string[] = [],
    parts: string[] = [],
    half = 0.5 / fps;
  layers.forEach((l, i) => {
    inputs.push(
      ...(l.from ? ['-ss', number(l.from)] : []),
      ...(l.duration ? ['-t', number(l.duration * l.speed + 1)] : []),
      '-i',
      l.input,
    );
    // The file's YCbCr is read with the layer's matrix and range when it gives them (resolveLayers fills them in for
    // an untagged file); without them ffmpeg reads the file's tags. RGB files ignore both.
    const read = `${l.matrix ? `:in_color_matrix=${l.matrix}` : ''}${l.range ? `:in_range=${l.range}` : ''}`,
      scale = (w: string | number, h: string | number) => `scale=${w}:${h}${read}:${SCALE_FLAGS},format=rgba`,
      // contain and cover keep the picture's shape as shown: its display aspect, width times the sample aspect ratio
      // (ffmpeg's `sar`, 1 when the file gives none) over height. ISO/IEC 14496-10 Annex E, Table E-1, lists the sample
      // aspect ratios a stream carries, such as 40:33 for 720x480 shown at 16:9. force_original_aspect_ratio reads the
      // stored width and height only, which squeezed such a clip (KB-HEADLESS-LAYER-SAR). The sizes round as it does,
      // so a square-pixel clip scales exactly as before.
      shown = 'iw*sar/ih',
      wider = `gt(${shown},${l.w}/${l.h})`,
      across = `max(1,round(${l.h}*${shown}))`,
      down = `max(1,round(${l.w}/(${shown})))`,
      fit =
        l.fit === 'cover'
          ? `${scale(`'if(${wider},${across},${l.w})'`, `'if(${wider},${l.h},${down})'`)},crop=${l.w}:${l.h}`
          : l.fit === 'fill'
            ? scale(l.w, l.h)
            : `${scale(`'if(${wider},${l.w},${across})'`, `'if(${wider},${down},${l.h})'`)},pad=${l.w}:${l.h}:(ow-iw)/2:(oh-ih)/2:color=${l.padding}`,
      crop = l.crop ? `crop=${l.crop[2]}:${l.crop[3]}:${l.crop[0]}:${l.crop[1]},` : '';
    // Each layer is put on the film's frame times: each clip frame starts on the film frame nearest its own time (the
    // fps filter, round=near), so a clip at another rate drops or repeats frames evenly. With a duration its last frame is held to the end of its window
    // (a still picture is one frame) and it ends there, so it never runs past the rendered frames; without one it
    // shows until its file ends.
    const end = l.duration ? l.start + l.duration : undefined,
      hold =
        end === undefined ? '' : `,tpad=stop_mode=clone:stop_duration=${number(l.duration!)},trim=end=${number(end)}`,
      enable =
        end === undefined
          ? `gte(t,${number(l.start - half)})`
          : `between(t,${number(l.start - half)},${number(end - half)})`;
    parts.push(
      `[${firstInput + i}:v]${crop}setpts=(PTS-STARTPTS)/${number(l.speed)}+${number(l.start)}/TB,fps=${number(fps)}:round=near${hold},${fit},setsar=1[l${i}]`,
    );
    // The rendered frames are the clock: eof_action=pass lets them through once a layer ends, and the output ends
    // with them.
    parts.push(`[${base}][l${i}]overlay=x=${l.x}:y=${l.y}:format=rgb:eof_action=pass:enable='${enable}'[b${i + 1}]`);
    base = `b${i + 1}`;
  });
  parts.push(`[${base}]${chain}[v]`);
  return { inputs, graph: parts.join(';') };
}

const RGB_FORMAT = /^(?:rgb|bgr|gbr|argb|abgr|0rgb|0bgr|x2rgb|x2bgr|pal8|gray|ya8|ya16|monow|monob)/;

/** The first video stream of ffmpeg's report on an input (`ffmpeg -i`), or undefined when it lists none. */
function parseProbe(report: string): VideoProbe | undefined {
  const line = /^\s*Stream #\d+:\d+.*?: Video: (.*)$/m.exec(report)?.[1];
  if (!line) return undefined;
  // Fields are split at top-level commas: the pixel format's own notes are in brackets.
  const fields: string[] = [];
  let depth = 0,
    field = '';
  for (const c of line) {
    if (c === ',' && depth === 0) {
      fields.push(field.trim());
      field = '';
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    field += c;
  }
  fields.push(field.trim());
  const codec = /^\S+/.exec(fields[0])?.[0] ?? '',
    format = /^([a-z0-9_]+)(?:\((.*)\))?$/.exec(fields[1] ?? ''),
    size = fields.map((f) => /^(\d+)x(\d+)(?:\s|$)/.exec(f)).find(Boolean);
  if (!format || !size) return undefined;
  const pixelFormat = format[1],
    notes = (format[2] ?? '').split(',').map((n) => n.trim()),
    range = notes.find((n) => n === 'tv' || n === 'pc') as 'tv' | 'pc' | undefined,
    // The colour note is the matrix alone when matrix, primaries and transfer agree, else matrix/primaries/transfer.
    colour = notes.find((n) => n.includes('/') || /^(?:bt|smpte|fcc|ycgco|gbr|ictcp|chroma|reserved)/.test(n)),
    matrix = colour?.split('/')[0];
  return {
    codec,
    pixelFormat,
    width: Number(size[1]),
    height: Number(size[2]),
    rgb: RGB_FORMAT.test(pixelFormat) || matrix === 'gbr',
    ...(matrix && matrix !== 'unknown' ? { matrix } : {}),
    ...(range ? { range } : {}),
  };
}

/** Runs ffmpeg and gives back what it wrote on standard error, whatever its exit code. */
function ffmpegReport(
  ffmpeg: string | readonly string[],
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string>;
/** With `failures`, gives back the report only when ffmpeg exits with an error, else undefined. */
function ffmpegReport(
  ffmpeg: string | readonly string[],
  args: readonly string[],
  signal: AbortSignal | undefined,
  failures: true,
): Promise<string | undefined>;
function ffmpegReport(
  ffmpeg: string | readonly string[],
  args: readonly string[],
  signal?: AbortSignal,
  failures = false,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  const [program, ...first] = typeof ffmpeg === 'string' ? [ffmpeg] : ffmpeg;
  return new Promise<string | undefined>((done, fail) => {
    let text = '';
    const child = spawn(program, [...first, ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }),
      stop = () => child.kill();
    signal?.addEventListener('abort', stop, { once: true });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (text += chunk));
    child.once('error', (error: NodeJS.ErrnoException) => {
      signal?.removeEventListener('abort', stop);
      fail(
        error.code === 'ENOENT'
          ? Object.assign(fault('unsupported', 'ffmpeg was not found', 'headless'), { cause: error })
          : error,
      );
    });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) fail(signal.reason);
      else done(failures && code === 0 ? undefined : text);
    });
  });
}

/**
 * Reads the first video stream of `input` (a video or a picture) as ffmpeg reports it: codec, pixel format, size and
 * the matrix and range it is tagged with. Rejects with code `'failed'` and ffmpeg's report in `cause` when ffmpeg finds
 * no video stream in it.
 */
export async function probeVideo(
  input: string,
  { ffmpeg = 'ffmpeg', signal }: { ffmpeg?: string | readonly string[]; signal?: AbortSignal } = {},
): Promise<VideoProbe> {
  if (typeof input !== 'string' || !input) throw typeError('probeVideo needs an input file', 'headless');
  const report = await ffmpegReport(ffmpeg, ['-hide_banner', '-nostdin', '-i', input], signal),
    probe = parseProbe(report);
  if (!probe)
    throw Object.assign(fault('failed', `ffmpeg found no video stream in ${input}`, 'headless'), {
      cause: report.slice(-MOST_LOG),
    });
  return probe;
}

/**
 * The layers with each file's matrix and range filled in where the file carries no tag of its own: BT.709 at 720
 * lines or more and BT.601 below, TV range (ITU-T H.273 leaves untagged colour to the application; HD video, SMPTE
 * ST 296 and ST 274, is ITU-R BT.709, SD video ITU-R BT.601). A JPEG (JFIF, ITU-T T.871) reads BT.601 at full range,
 * and RGB files have no matrix. A layer's own `matrix` and `range` stay as given; a `crop` outside its file throws a
 * RangeError. {@link encodeWithFFmpeg} and {@link layersOverPicture} call this; call it before
 * {@link ffmpegArguments}, which reads no file.
 */
export async function resolveLayers(
  layers: readonly FFmpegLayer[],
  { ffmpeg = 'ffmpeg', signal }: { ffmpeg?: string | readonly string[]; signal?: AbortSignal } = {},
): Promise<FFmpegLayer[]> {
  if (!Array.isArray(layers)) throw typeError('layers must be an array', 'headless');
  const probes = new Map<string, Promise<VideoProbe>>();
  return Promise.all(
    layers.map(async (layer: FFmpegLayer, i) => {
      if (typeof layer?.input !== 'string' || !layer.input)
        throw typeError(`Layer ${i} needs an input file`, 'headless');
      if (layer.matrix && layer.range && !layer.crop) return { ...layer };
      if (!probes.has(layer.input)) probes.set(layer.input, probeVideo(layer.input, { ffmpeg, signal }));
      const probe = await probes.get(layer.input)!,
        [cx, cy, cw, ch] = layer.crop ?? [0, 0, probe.width, probe.height];
      if (cx + cw > probe.width || cy + ch > probe.height)
        throw rangeError(`Layer ${i} crop must lie inside its ${probe.width}x${probe.height} file`, 'headless');
      if (probe.rgb) return { ...layer };
      const jfif = probe.codec === 'mjpeg' || probe.pixelFormat.startsWith('yuvj'),
        matrix: FFmpegMatrix = jfif || probe.height < 720 ? 'bt601' : 'bt709';
      return {
        ...layer,
        ...(layer.matrix || probe.matrix ? {} : { matrix }),
        ...(layer.range || probe.range ? {} : { range: jfif ? 'pc' : 'tv' }),
      } as FFmpegLayer;
    }),
  );
}

/** The full ffmpeg argument list for a stream of RGBA frames on standard input. */
export function ffmpegArguments(
  width: number,
  height: number,
  {
    output,
    fps = 30,
    args,
    audio,
    alpha,
    layers,
  }: Pick<FFmpegOptions, 'output' | 'fps' | 'args' | 'audio' | 'alpha' | 'layers'>,
): string[] {
  checkAlpha(output, args, alpha);
  const boxes = checkLayers(width, height, layers);
  const webm = /\.webm$/i.test(output),
    sound = audio
      ? {
          input: [
            '-f',
            'f32le',
            '-ar',
            String(audio.sampleRate),
            '-ac',
            String(audio.channels.length),
            '-i',
            `pipe:${SOUND_PIPE}`,
          ],
          map: ['-map', '0:v:0', '-map', '1:a:0'],
          codec: [
            ...(webm ? ['-c:a', 'libopus'] : ['-c:a', 'aac']),
            '-b:a',
            String(Math.round(audio.bitrate ?? 128_000)),
          ],
        }
      : undefined;
  const frames = [
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${width}x${height}`,
      '-r',
      String(fps),
      '-i',
      'pipe:0',
    ],
    out = args ?? [...(webm ? [...colour(alpha ? 'yuva420p' : 'yuv420p'), ...VP9] : H264), ...(sound?.codec ?? [])];
  if (!boxes.length) return [...frames, ...(sound ? [...sound.input, ...sound.map] : ['-an']), ...out, output];
  // The output's -vf (the colour chain) moves to the end of the layer graph, which replaces it.
  const at = out.indexOf('-vf'),
    { inputs, graph } = layerGraph(boxes, sound ? 2 : 1, fps, at < 0 ? 'null' : out[at + 1]);
  return [
    ...frames,
    ...(sound?.input ?? []),
    ...inputs,
    '-filter_complex',
    graph,
    '-map',
    '[v]',
    ...(sound ? ['-map', '1:a:0'] : ['-an']),
    ...(at < 0 ? out : [...out.slice(0, at), ...out.slice(at + 2)]),
    output,
  ];
}

/**
 * The ffmpeg argument list of {@link layersOverPicture}: `picture` (`width` x `height`, one frame) as frame `frame` of
 * a video at `fps`, with `layers` laid over it by the same graph {@link encodeWithFFmpeg} uses, written to `output` as
 * one picture (PNG for a `.png` name). Reads no file: call {@link resolveLayers} first for the default colours.
 */
export function layersPictureArguments(
  width: number,
  height: number,
  {
    picture,
    output,
    fps = 30,
    frame,
    layers,
  }: { picture: string; output: string; fps?: number; frame: number; layers: readonly FFmpegLayer[] },
): string[] {
  if (typeof picture !== 'string' || !picture) throw typeError('layersOverPicture needs a picture file', 'headless');
  if (typeof output !== 'string' || !output) throw typeError('layersOverPicture needs an output file', 'headless');
  if (!(fps > 0) || !Number.isFinite(fps)) throw rangeError('Invalid fps', 'headless');
  if (!Number.isInteger(frame) || frame < 0) throw rangeError('frame must be a whole number from 0', 'headless');
  const boxes = checkLayers(width, height, layers);
  // The picture is one frame at the film's time base, placed at frame `frame`; each layer meets it exactly as it
  // meets that frame of an encode, so the still shows what the video shows there.
  const { inputs, graph } = layerGraph(boxes, 1, fps, 'format=rgb24', 'p');
  return [
    '-y',
    '-framerate',
    String(fps),
    '-i',
    picture,
    ...inputs,
    '-filter_complex',
    `[0:v]trim=end_frame=1,setpts=PTS-STARTPTS+${frame},format=rgb24[p];${graph}`,
    '-map',
    '[v]',
    '-frames:v',
    '1',
    '-update',
    '1',
    output,
  ];
}

/**
 * Lays `layers` over `picture`, a rendered frame `frame` of a video at `fps`, as {@link encodeWithFFmpeg} lays them on
 * that frame, and writes the result to `output` (PNG for a `.png` name), so a still matches the encode. Layer files are
 * read as {@link resolveLayers} reads them. A failure rejects with code `'failed'` and the end of ffmpeg's log in
 * `cause`.
 */
export async function layersOverPicture(
  picture: string,
  output: string,
  options: LayersOverPictureOptions,
): Promise<void> {
  const { fps = 30, frame, layers, ffmpeg = 'ffmpeg', signal } = options ?? ({} as LayersOverPictureOptions);
  const size = await probeVideo(picture, { ffmpeg, signal }),
    args = layersPictureArguments(size.width, size.height, {
      picture,
      output,
      fps,
      frame,
      layers: await resolveLayers(layers, { ffmpeg, signal }),
    });
  const log = await ffmpegReport(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', ...args], signal, true);
  if (log !== undefined)
    throw Object.assign(fault('failed', 'ffmpeg failed', 'headless'), { cause: log.slice(-MOST_LOG) });
}

/** An RGBA frame grown to `codedWidth` x `codedHeight` by repeating its last column and row. */
function padFrame(
  data: Uint8Array,
  width: number,
  height: number,
  codedWidth: number,
  codedHeight: number,
): Uint8Array {
  const out = new Uint8Array(codedWidth * codedHeight * 4);
  for (let y = 0; y < codedHeight; y++) {
    const from = Math.min(y, height - 1) * width * 4,
      to = y * codedWidth * 4;
    out.set(data.subarray(from, from + width * 4), to);
    for (let x = width; x < codedWidth; x++) out.copyWithin(to + x * 4, to + (width - 1) * 4, to + width * 4);
  }
  return out;
}

/**
 * Pipes frames to ffmpeg and waits for it to finish the file. Frames are all one size. A frame is written only once
 * the pipe has room for it, so a slow encoder slows the render and memory stays flat. With the default H.264 arguments
 * an odd width or height gains a repeated last column or row, since H.264 4:2:0 states sizes in steps of two (ITU-T
 * H.264 7.4.2.1.1); the result gives the size written.
 */
export async function encodeWithFFmpeg(
  frames: AsyncIterable<HeadlessPixels> | Iterable<HeadlessPixels>,
  options: FFmpegOptions,
): Promise<FFmpegResult> {
  const { output, fps = 30, ffmpeg = 'ffmpeg', signal, audio } = options;
  if (typeof output !== 'string' || !output) throw typeError('encodeWithFFmpeg needs an output file', 'headless');
  if (!(fps > 0) || !Number.isFinite(fps)) throw rangeError('Invalid fps', 'headless');
  const soundLength = audio === undefined ? 0 : checkAudio(audio);
  checkAlpha(output, options.args, options.alpha);
  signal?.throwIfAborted();
  // Each layer file is read once first, so an untagged one is read with the engine's default matrix and range.
  const layers = options.layers === undefined ? undefined : await resolveLayers(options.layers, { ffmpeg, signal }),
    settings = { ...options, layers };
  const [program, ...first] = typeof ffmpeg === 'string' ? [ffmpeg] : ffmpeg;
  let child: ReturnType<typeof spawn> | undefined,
    finished: Promise<void> | undefined,
    gone = false,
    wake = () => {},
    width = 0,
    height = 0,
    codedWidth = 0,
    codedHeight = 0,
    count = 0,
    log = '',
    sounding: Promise<void> | undefined;
  const stop = () => child?.kill();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for await (const frame of frames) {
      signal?.throwIfAborted();
      if (!child) {
        ({ width, height } = frame);
        const even = !options.args && !/\.webm$/i.test(output);
        [codedWidth, codedHeight] = even ? [width + (width & 1), height + (height & 1)] : [width, height];
        const running = spawn(program, [...first, ...ffmpegArguments(codedWidth, codedHeight, settings)], {
          stdio: audio ? ['pipe', 'ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
          windowsHide: true,
        });
        child = running;
        running.stderr!.setEncoding('utf8').on('data', (text: string) => {
          log = (log + text).slice(-MOST_LOG);
        });
        // A pipe closing early is reported through the exit code below, with ffmpeg's own words.
        running.stdin!.on('error', () => {});
        finished = new Promise<void>((resolve, reject) => {
          running.once('error', (error: NodeJS.ErrnoException) => {
            gone = true;
            wake();
            reject(
              error.code === 'ENOENT'
                ? Object.assign(fault('unsupported', 'ffmpeg was not found', 'headless'), { cause: error })
                : error,
            );
          });
          running.once('close', (code) => {
            gone = true;
            wake();
            if (code === 0) resolve();
            else reject(Object.assign(fault('failed', 'ffmpeg failed', 'headless'), { cause: log }));
          });
        });
        finished.catch(() => {}); // Read below; it may settle while a frame is still being made.
        // The sound goes down its own pipe while the frames go down theirs, each waiting only for its own room, so
        // ffmpeg reading one input ahead of the other never stalls both.
        if (audio)
          sounding = writeSound(
            running.stdio[SOUND_PIPE] as NodeJS.WritableStream,
            audio.channels,
            soundLength,
            () => gone,
          );
      } else if (frame.width !== width || frame.height !== height)
        throw rangeError('Video frames must all be one size', 'headless');
      if (frame.data.length !== width * height * 4) throw rangeError('Frame data does not match its size', 'headless');
      if (gone) break;
      const bytes =
        codedWidth === width && codedHeight === height
          ? frame.data
          : padFrame(frame.data, width, height, codedWidth, codedHeight);
      if (!child.stdin!.write(bytes)) {
        const pipe = child.stdin!,
          room = () => wake();
        pipe.once('drain', room);
        await new Promise<void>((resolve) => (wake = resolve));
        pipe.off('drain', room);
      }
      count++;
    }
    if (!child) throw fault('state', 'No frames to encode', 'headless');
    child.stdin!.end();
    await sounding;
    await finished;
    return {
      output,
      width: codedWidth,
      height: codedHeight,
      frames: count,
      ...(audio ? { audioDuration: soundLength / audio.sampleRate } : {}),
    };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', stop);
    if (child && !gone) child.kill();
  }
}

/** Writes sound to its pipe in blocks, waiting for room after each, then closes it. Stops when ffmpeg is gone. */
async function writeSound(
  pipe: NodeJS.WritableStream,
  channels: readonly Float32Array[],
  length: number,
  gone: () => boolean,
): Promise<void> {
  // A pipe closing early is reported through ffmpeg's exit code, with its own words.
  pipe.on('error', () => {});
  for (let start = 0; start < length && !gone(); start += SOUND_BLOCK) {
    if (!pipe.write(interleave(channels, start, Math.min(length, start + SOUND_BLOCK))))
      await new Promise<void>((resolve) => {
        const done = () => {
          pipe.off('drain', done);
          pipe.off('close', done);
          resolve();
        };
        pipe.on('drain', done);
        pipe.on('close', done);
      });
  }
  pipe.end();
}
