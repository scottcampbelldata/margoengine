// Video files in Node, which has no WebCodecs: raw frames go down a pipe to the ffmpeg the app already has. This entry is
// Node only. ffmpeg is not shipped or downloaded here, and it runs without a shell, so no argument is interpreted.
import { spawn } from 'node:child_process';
import type { HeadlessPixels } from './index.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

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
  /** Stops ffmpeg; the promise rejects with the signal's reason, and a partial file may stay behind. Default none. */
  signal?: AbortSignal;
}

/** What {@link encodeWithFFmpeg} gives back. */
export interface FFmpegResult {
  output: string;
  width: number;
  height: number;
  frames: number;
}

// ffmpeg's scaler converts RGB with the BT.601 matrix unless told otherwise, and players read HD video as BT.709.
const COLOUR = [
    '-vf',
    'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
  ],
  WEBM = [...COLOUR, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0'],
  H264 = [...COLOUR, '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart'],
  MOST_LOG = 4096;

/** The full ffmpeg argument list for a stream of RGBA frames on standard input. */
export function ffmpegArguments(
  width: number,
  height: number,
  { output, fps = 30, args }: Pick<FFmpegOptions, 'output' | 'fps' | 'args'>,
): string[] {
  return [
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
    '-an',
    ...(args ?? (/\.webm$/i.test(output) ? WEBM : H264)),
    output,
  ];
}

/**
 * Pipes frames to ffmpeg and waits for it to finish the file. Frames are all one size. A frame is written only once
 * the pipe has room for it, so a slow encoder slows the render and memory stays flat.
 */
export async function encodeWithFFmpeg(
  frames: AsyncIterable<HeadlessPixels> | Iterable<HeadlessPixels>,
  options: FFmpegOptions,
): Promise<FFmpegResult> {
  const { output, fps = 30, ffmpeg = 'ffmpeg', signal } = options;
  if (typeof output !== 'string' || !output) throw typeError('encodeWithFFmpeg needs an output file', 'headless');
  if (!(fps > 0) || !Number.isFinite(fps)) throw rangeError('Invalid fps', 'headless');
  signal?.throwIfAborted();
  const [program, ...first] = typeof ffmpeg === 'string' ? [ffmpeg] : ffmpeg;
  let child: ReturnType<typeof spawn> | undefined,
    finished: Promise<void> | undefined,
    gone = false,
    wake = () => {},
    width = 0,
    height = 0,
    count = 0,
    log = '';
  const stop = () => child?.kill();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for await (const frame of frames) {
      signal?.throwIfAborted();
      if (!child) {
        ({ width, height } = frame);
        const running = spawn(program, [...first, ...ffmpegArguments(width, height, options)], {
          stdio: ['pipe', 'ignore', 'pipe'],
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
      } else if (frame.width !== width || frame.height !== height)
        throw rangeError('Video frames must all be one size', 'headless');
      if (frame.data.length !== width * height * 4) throw rangeError('Frame data does not match its size', 'headless');
      if (gone) break;
      if (!child.stdin!.write(frame.data)) {
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
    await finished;
    return { output, width, height, frames: count };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', stop);
    if (child && !gone) child.kill();
  }
}
