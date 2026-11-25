// Work on finished video files with the ffmpeg the app already has (Node only): a hardware or software H.264 encoder
// with the engine's colour handling, joining files by stream copy, sound laid under a video without encoding its
// picture again, and a stream-copy cut of a recorded span checked frame by frame. ffmpeg is not shipped or downloaded
// here, and it runs without a shell, so no argument is interpreted.
// Sources: ITU-T H.273 (colour code points), ITU-T H.264 Annex E (VUI), ISO/IEC 14496-12 (ISO base media file format:
// boxes, sample tables, edit lists, movie fragments) and ISO/IEC 14496-15 sections 5.3 and 5.4 (avc1 keeps parameter
// sets in the sample entry, avc3 lets them travel in band), and ffmpeg's documentation of its concat demuxer,
// h264_metadata bitstream filter, mov muxer options and encoders. No other project's code was read (docs/clean-room.md
// FE-5).
import { spawn } from 'node:child_process';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { COLOUR_TAGS, colourFilter } from './ffmpeg-colour.js';

/** An H.264 encoder: `'x264'` (software, libx264) or a hardware one: `'nvenc'` (NVIDIA), `'amf'` (AMD), `'qsv'` (Intel). */
export type FFmpegEncoder = 'x264' | 'nvenc' | 'amf' | 'qsv';

/** Options of {@link encoderArguments}. */
export interface EncoderOptions {
  /** Constant quality from 1 to 51, lower is better: x264's CRF, NVENC's CQ, AMF's QP, QSV's global quality. Default 20. */
  quality?: number;
  /**
   * x264's speed preset (`'ultrafast'` to `'placebo'`; x264's own default is `'medium'`), or NVENC's (`'p1'` to `'p7'`;
   * default `'p5'`). AMF and QSV take none. Default: the encoder's.
   */
  preset?: string;
}

/**
 * The H.264 colour tags the engine writes (ITU-T H.273): BT.709 primaries (1) and matrix (1), the sRGB transfer (13) of
 * a rendered frame, TV range and chroma on the left column (chroma_sample_loc_type 0), as an `h264_metadata` bitstream
 * filter, which rewrites the VUI of any H.264 stream, encoded or copied.
 */
export const H264_COLOUR_TAGS =
  'h264_metadata=colour_primaries=1:transfer_characteristics=13:matrix_coefficients=1:video_full_range_flag=0:chroma_sample_loc_type=0';

const X264_PRESETS = [
    'ultrafast',
    'superfast',
    'veryfast',
    'faster',
    'fast',
    'medium',
    'slow',
    'slower',
    'veryslow',
    'placebo',
  ],
  NVENC_PRESETS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];

// Constant quality on each: x264's CRF, NVENC's variable rate with a target CQ and no rate cap, AMF's constant QP, QSV's
// intelligent constant quality; each takes the frame in system memory in a pixel format it reads.
const ENCODERS: Record<
  FFmpegEncoder,
  { codec: string; format: string; presets?: string[]; args: (q: number, preset?: string) => string[] }
> = {
  x264: {
    codec: 'libx264',
    format: 'yuv420p',
    presets: X264_PRESETS,
    args: (q, p) => [...(p ? ['-preset', p] : []), '-crf', String(q)],
  },
  nvenc: {
    codec: 'h264_nvenc',
    format: 'yuv420p',
    presets: NVENC_PRESETS,
    args: (q, p = 'p5') => ['-preset', p, '-tune', 'hq', '-rc', 'vbr', '-cq', String(q), '-b:v', '0'],
  },
  amf: {
    codec: 'h264_amf',
    format: 'nv12',
    args: (q) => ['-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q), '-qp_b', String(q)],
  },
  qsv: { codec: 'h264_qsv', format: 'nv12', args: (q) => ['-global_quality', String(q)] },
};

/**
 * The output arguments of an H.264 MP4 from RGBA frames with `encoder`: the same BT.709, TV range, sRGB transfer and
 * left chroma as encodeWithFFmpeg's default, the stream's VUI rewritten by {@link H264_COLOUR_TAGS} whatever the encoder
 * writes, and `+faststart`. Pass them as encodeWithFFmpeg's `args`.
 */
export function encoderArguments(
  encoder: FFmpegEncoder = 'x264',
  { quality = 20, preset }: EncoderOptions = {},
): string[] {
  const e = Object.hasOwn(ENCODERS, encoder) ? ENCODERS[encoder] : undefined;
  if (!e) throw rangeError(`Unknown encoder ${String(encoder)}; use 'x264', 'nvenc', 'amf' or 'qsv'`, 'headless');
  if (!Number.isInteger(quality) || quality < 1 || quality > 51)
    throw rangeError('Encoder quality must be a whole number from 1 to 51', 'headless');
  if (preset !== undefined && !e.presets?.includes(preset))
    throw rangeError(
      e.presets ? `The ${encoder} preset is one of ${e.presets.join(', ')}` : `The ${encoder} encoder takes no preset`,
      'headless',
    );
  return [
    '-vf',
    colourFilter(e.format),
    ...COLOUR_TAGS,
    '-c:v',
    e.codec,
    ...e.args(quality, preset),
    '-bsf:v',
    H264_COLOUR_TAGS,
    '-movflags',
    '+faststart',
  ];
}

/** Options shared by the file tools. */
export interface FFmpegFileOptions {
  /** The program, or the program and its first arguments. Default `'ffmpeg'` on the `PATH`. */
  ffmpeg?: string | readonly string[];
  /** Stops ffmpeg; the promise rejects with the signal's reason and the output is not written. */
  signal?: AbortSignal;
}

/** Runs ffmpeg with `args`, rejecting with its last words in `cause` on a failure; not found is code `'unsupported'`. */
function runFFmpeg(args: readonly string[], { ffmpeg = 'ffmpeg', signal }: FFmpegFileOptions = {}): Promise<void> {
  signal?.throwIfAborted();
  const [program, ...first] = typeof ffmpeg === 'string' ? [ffmpeg] : ffmpeg;
  return new Promise<void>((done, fail) => {
    let log = '';
    const child = spawn(program, [...first, ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }),
      stop = () => child.kill();
    signal?.addEventListener('abort', stop, { once: true });
    child.stderr!.setEncoding('utf8').on('data', (text: string) => (log = (log + text).slice(-4096)));
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
      else if (code === 0) done();
      else fail(Object.assign(fault('failed', 'ffmpeg failed', 'headless'), { cause: log }));
    });
  });
}

/** Writes through a temporary file beside `output`, renamed in place once ffmpeg succeeds, so a failure leaves no half file. */
async function writeVia(output: string, make: (temp: string) => Promise<void>): Promise<void> {
  const temp = join(
    dirname(output),
    `.${basename(output)}.${process.pid}.part${/\.[^./\\]+$/.exec(output)?.[0] ?? ''}`,
  );
  try {
    await make(temp);
    await rename(temp, output);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const name = (path: unknown, what: string, tool: string) => {
  if (typeof path !== 'string' || !path) throw typeError(`${tool} needs ${what}`, 'headless');
  return path;
};

// ---- ISO base media file format (ISO/IEC 14496-12) ----

type Box = { type: string; at: number; end: number; body: number };
/** The boxes inside `bytes` from `from` to `to` (section 4.2: 32-bit size, or 1 and a 64-bit size; 0 runs to the end). */
function boxes(bytes: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  for (let at = from; at + 8 <= to; ) {
    let size = bytes.readUInt32BE(at),
      header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(bytes.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) break;
    out.push({ type: bytes.toString('latin1', at + 4, at + 8), at, end: at + size, body: at + header });
    at += size;
  }
  return out;
}
const child = (bytes: Buffer, parent: Box | undefined, type: string, skip = 0) =>
  parent && boxes(bytes, parent.body + skip, parent.end).find((b) => b.type === type);

/** One sample of a video track, in decode order. */
export interface VideoSample {
  /** Presentation time in seconds, after the edit list. */
  time: number;
  /** A sync sample (a key frame a decoder can start from). */
  key: boolean;
}

/** What {@link readVideoTrack} gives back. */
export interface VideoTrack {
  /** The sample entry's four-character code: `'avc1'` or `'avc3'` for H.264, `'hvc1'`, `'av01'` and so on. */
  codec: string;
  /** Ticks per second of the track's media timescale. */
  timescale: number;
  /** The H.264 decoder configuration (the sample entry's `avcC` box body), or undefined for other codecs. */
  avcConfig?: Uint8Array;
  /** Every sample, from the `moov` sample tables and any movie fragments, in decode order. */
  samples: VideoSample[];
}

/** Reads the top-level boxes of a file: type, place and size, without reading their bodies. */
async function topBoxes(file: Awaited<ReturnType<typeof open>>, end: number): Promise<Box[]> {
  const out: Box[] = [],
    head = Buffer.alloc(16);
  for (let at = 0; at + 8 <= end; ) {
    await file.read(head, 0, 16, at);
    let size = head.readUInt32BE(0),
      header = 8;
    if (size === 1) {
      size = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) break;
    out.push({ type: head.toString('latin1', 4, 8), at, end: at + size, body: at + header });
    at += size;
  }
  return out;
}

/**
 * The first video track of an MP4 or MOV file (ISO/IEC 14496-12): its codec, timescale, H.264 configuration and every
 * sample's presentation time and key flag, from the sample tables (`stts`, `ctts`, `stss`) and movie fragments (`trex`,
 * `tfhd`, `tfdt`, `trun`), with the edit list's start applied. Reads box headers, `moov` and each `moof`, never `mdat`.
 * Rejects with code `'unsupported'` when the file has no video track.
 */
export async function readVideoTrack(path: string): Promise<VideoTrack> {
  name(path, 'a file', 'readVideoTrack');
  const file = await open(path, 'r');
  try {
    const end = (await file.stat()).size,
      top = await topBoxes(file, end),
      read = async (b: Box) => {
        const bytes = Buffer.alloc(b.end - b.at);
        await file.read(bytes, 0, bytes.length, b.at);
        return bytes;
      },
      moovBox = top.find((b) => b.type === 'moov');
    if (!moovBox) throw fault('unsupported', `${basename(path)} has no moov box (not an MP4 or MOV file)`, 'headless');
    const m = await read(moovBox),
      moov: Box = { type: 'moov', at: 0, end: m.length, body: moovBox.body - moovBox.at },
      mvhd = child(m, moov, 'mvhd'),
      movieScale = mvhd ? m.readUInt32BE(mvhd.body + (m[mvhd.body] === 1 ? 20 : 12)) : 1;
    for (const trak of boxes(m, moov.body, moov.end).filter((b) => b.type === 'trak')) {
      const mdia = child(m, trak, 'mdia'),
        hdlr = child(m, mdia, 'hdlr');
      if (!hdlr || m.toString('latin1', hdlr.body + 8, hdlr.body + 12) !== 'vide') continue;
      const tkhd = child(m, trak, 'tkhd'),
        trackId = tkhd ? m.readUInt32BE(tkhd.body + (m[tkhd.body] === 1 ? 20 : 12)) : 0,
        mdhd = child(m, mdia, 'mdhd'),
        timescale = mdhd ? m.readUInt32BE(mdhd.body + (m[mdhd.body] === 1 ? 20 : 12)) : 0,
        stbl = child(m, child(m, mdia, 'minf'), 'stbl'),
        stsd = child(m, stbl, 'stsd');
      if (!timescale || !stsd) continue;
      // stsd: a full box (4 bytes) and an entry count (4), then sample entries; a visual sample entry has 78 bytes
      // before its own boxes (section 12.1.3).
      const entry = boxes(m, stsd.body + 8, stsd.end)[0],
        avcC = entry && (entry.type === 'avc1' || entry.type === 'avc3') ? child(m, entry, 'avcC', 78) : undefined;
      // Decode times and composition offsets from the sample tables (sections 8.6.1.2, 8.6.1.3, 8.6.2).
      const decode: number[] = [],
        offset: number[] = [],
        key: boolean[] = [],
        stts = child(m, stbl, 'stts'),
        ctts = child(m, stbl, 'ctts'),
        stss = child(m, stbl, 'stss');
      let t = 0;
      if (stts)
        for (let e = 0, n = m.readUInt32BE(stts.body + 4); e < n; e++) {
          const count = m.readUInt32BE(stts.body + 8 + e * 8),
            delta = m.readUInt32BE(stts.body + 12 + e * 8);
          for (let i = 0; i < count; i++, t += delta) decode.push(t);
        }
      if (ctts)
        for (let e = 0, n = m.readUInt32BE(ctts.body + 4); e < n; e++) {
          const count = m.readUInt32BE(ctts.body + 8 + e * 8),
            value = m.readInt32BE(ctts.body + 12 + e * 8);
          for (let i = 0; i < count; i++) offset.push(value);
        }
      const sync = stss ? new Set<number>() : undefined;
      if (stss)
        for (let e = 0, n = m.readUInt32BE(stss.body + 4); e < n; e++) sync!.add(m.readUInt32BE(stss.body + 8 + e * 4));
      for (let i = 0; i < decode.length; i++) key.push(!sync || sync.has(i + 1));
      // Movie fragments (section 8.8): defaults from trex, then each moof's traf for this track.
      const trex = boxes(m, child(m, moov, 'mvex')?.body ?? 0, child(m, moov, 'mvex')?.end ?? 0).find(
          (b) => b.type === 'trex' && m.readUInt32BE(b.body + 4) === trackId,
        ),
        trexDuration = trex ? m.readUInt32BE(trex.body + 12) : 0,
        trexFlags = trex ? m.readUInt32BE(trex.body + 20) : 0;
      for (const moofBox of top.filter((b) => b.type === 'moof')) {
        const f = await read(moofBox);
        for (const traf of boxes(f, moofBox.body - moofBox.at, f.length).filter((b) => b.type === 'traf')) {
          const tfhd = child(f, traf, 'tfhd');
          if (!tfhd || f.readUInt32BE(tfhd.body + 4) !== trackId) continue;
          const flags = f.readUInt32BE(tfhd.body) & 0xffffff;
          let p = tfhd.body + 8;
          if (flags & 0x1) p += 8;
          if (flags & 0x2) p += 4;
          const defaultDuration = flags & 0x8 ? f.readUInt32BE(p) : trexDuration;
          if (flags & 0x8) p += 4;
          if (flags & 0x10) p += 4;
          const defaultFlags = flags & 0x20 ? f.readUInt32BE(p) : trexFlags,
            tfdt = child(f, traf, 'tfdt');
          if (tfdt) t = f[tfdt.body] === 1 ? Number(f.readBigUInt64BE(tfdt.body + 4)) : f.readUInt32BE(tfdt.body + 4);
          for (const trun of boxes(f, traf.body, traf.end).filter((b) => b.type === 'trun')) {
            const version = f[trun.body],
              rf = f.readUInt32BE(trun.body) & 0xffffff,
              count = f.readUInt32BE(trun.body + 4);
            let q = trun.body + 8;
            if (rf & 0x1) q += 4;
            const first = rf & 0x4 ? f.readUInt32BE(q) : undefined;
            if (rf & 0x4) q += 4;
            for (let i = 0; i < count; i++) {
              const duration = rf & 0x100 ? f.readUInt32BE(q) : defaultDuration;
              if (rf & 0x100) q += 4;
              if (rf & 0x200) q += 4;
              const sampleFlags =
                rf & 0x400 ? f.readUInt32BE(q) : i === 0 && first !== undefined ? first : defaultFlags;
              if (rf & 0x400) q += 4;
              const cto = rf & 0x800 ? (version ? f.readInt32BE(q) : f.readUInt32BE(q)) : 0;
              if (rf & 0x800) q += 4;
              decode.push(t);
              offset.push(cto);
              // sample_is_non_sync_sample is bit 16 of the sample flags (section 8.8.3.1).
              key.push(!(sampleFlags & 0x10000));
              t += duration;
            }
          }
        }
      }
      // The edit list (section 8.6.6): leading empty edits delay the track; the first media edit says where it starts.
      let delay = 0,
        start = 0;
      const elst = child(m, child(m, trak, 'edts'), 'elst');
      if (elst) {
        const v1 = m[elst.body] === 1,
          size = v1 ? 20 : 12;
        for (let e = 0, n = m.readUInt32BE(elst.body + 4); e < n; e++) {
          const at = elst.body + 8 + e * size,
            duration = v1 ? Number(m.readBigUInt64BE(at)) : m.readUInt32BE(at),
            mediaTime = v1 ? Number(m.readBigInt64BE(at + 8)) : m.readInt32BE(at + 4);
          if (mediaTime === -1) delay += duration / movieScale;
          else {
            start = mediaTime;
            break;
          }
        }
      }
      return {
        codec: entry?.type ?? 'unknown',
        timescale,
        ...(avcC ? { avcConfig: new Uint8Array(m.subarray(avcC.body, avcC.end)) } : {}),
        samples: decode.map((d, i) => ({ time: (d + (offset[i] ?? 0) - start) / timescale + delay, key: key[i] })),
      };
    }
    throw fault('unsupported', `${basename(path)} has no video track`, 'headless');
  } finally {
    await file.close();
  }
}

// ---- Stream copy ----

/**
 * The MP4 track timescale ffmpeg's muxer gives an encode at `fps` frames a second (the rate doubled until it reaches
 * 10,000: 15,360 at 30 and 60 fps, 12,288 at 24), so a copied span written at it joins engine chunks with every frame
 * on a whole tick. Whole frame rates only.
 */
export function mp4Timescale(fps: number): number {
  if (!Number.isInteger(fps) || fps < 1) throw rangeError('mp4Timescale needs a whole frame rate', 'headless');
  let ticks = fps;
  while (ticks < 10_000) ticks *= 2;
  return ticks;
}

/** The span {@link checkSpan} and {@link copySpan} take. */
export interface SpanOptions {
  /** Seconds into the file where the span starts: a key frame's presentation time. */
  start: number;
  /** Frames the span holds. */
  frames: number;
  /** The frame rate the span must hold: frame k at start + k / fps. */
  fps: number;
  /** Ticks per second of the file the span is written to. Default {@link mp4Timescale}(fps). */
  timescale?: number;
}

/** Why a span cannot be stream copied, or ok. */
export type SpanCheck = { ok: true; reason?: undefined } | { ok: false; reason: string };

const spanOf = (options: SpanOptions) => {
  const { start, frames, fps } = options;
  if (!(start >= 0) || !Number.isFinite(start))
    throw rangeError('The span start must be 0 or more seconds', 'headless');
  if (!Number.isInteger(frames) || frames < 1)
    throw rangeError('The span needs a whole number of frames, 1 or more', 'headless');
  if (!(fps > 0) || !Number.isFinite(fps)) throw rangeError('Invalid span fps', 'headless');
  const timescale = options.timescale ?? mp4Timescale(fps);
  if (!Number.isInteger(timescale) || timescale < 1)
    throw rangeError('The span timescale must be a whole number above 0', 'headless');
  return { start, frames, fps, timescale };
};

/**
 * Whether `frames` frames from `start` of an MP4 or MOV file can be cut by stream copy into a file whose frames sit at
 * start + k / fps: H.264; a key frame within half a tick of `start` (ticks of `timescale`); the next `frames` samples
 * in decode order are exactly the frames k = 0 to frames - 1, each within half a tick of its step, so no frame is
 * missing and none is decoded after the next key frame as an open GOP's leading frames are.
 */
export async function checkSpan(path: string, options: SpanOptions): Promise<SpanCheck> {
  const { ok, reason } = await inspectSpan(path, spanOf(options));
  return ok ? { ok } : { ok, reason };
}

/** checkSpan's work, with the key frame's own time when the span can be copied. */
async function inspectSpan(
  path: string,
  { start, frames, fps, timescale }: Required<SpanOptions>,
): Promise<SpanCheck & { key?: number }> {
  const track = await readVideoTrack(name(path, 'a file', 'checkSpan')),
    no = (reason: string): SpanCheck => ({ ok: false, reason }),
    half = 0.5 / timescale;
  if (track.codec !== 'avc1' && track.codec !== 'avc3') return no(`it is ${track.codec}, not H.264`);
  const first = track.samples.findIndex((s) => s.key && Math.abs(s.time - start) < half);
  if (first < 0) return no(`${start} s is not on a key frame`);
  const span = track.samples.slice(first, first + frames);
  if (span.length < frames) return no('the file ends before the span does');
  const seen = new Set<number>();
  for (const s of span) {
    const k = Math.round((s.time - start) * fps);
    if (k < 0) return no(`a frame before ${start} s is decoded after its key frame (an open GOP)`);
    if (k >= frames || seen.has(k))
      return no(
        `its first ${frames} frames from ${start} s are not the ${frames} frames of the span: the next key frame is not at its end`,
      );
    if (Math.abs(s.time - start - k / fps) >= half)
      return no(`a frame time is off the 1/${fps} s steps by more than half a tick of ${timescale}`);
    seen.add(k);
  }
  return { ok: true, key: span[0].time };
}

/** Options of {@link copySpan}. */
export interface CopySpanOptions extends SpanOptions, FFmpegFileOptions {}

/**
 * Cuts `frames` frames from `start` of an H.264 MP4 or MOV recording into `output` by stream copy (no decode, no
 * encode): the picture alone, its VUI rewritten to the engine's colour tags ({@link H264_COLOUR_TAGS}), at `timescale`
 * (default the engine chunks' {@link mp4Timescale}), with `+faststart`, so it joins engine chunks with
 * {@link joinVideos}. Rejects with code `'unsupported'` and {@link checkSpan}'s reason when the span cannot be copied.
 */
export async function copySpan(input: string, output: string, options: CopySpanOptions): Promise<void> {
  name(output, 'an output file', 'copySpan');
  const span = spanOf(options),
    check = await inspectSpan(input, span);
  if (!check.ok)
    throw fault(
      'unsupported',
      `${basename(input)} cannot be stream copied from ${span.start} s: ${check.reason}`,
      'headless',
    );
  // Seek to the key frame's own time rounded up to ffmpeg's microseconds, so the seek, which takes the last key frame
  // at or before its time, never lands on the key frame before.
  const seek = (Math.ceil(check.key! * 1e6) / 1e6).toFixed(6);
  await writeVia(output, (temp) =>
    runFFmpeg(
      [
        '-y',
        '-v',
        'error',
        '-nostdin',
        '-ss',
        seek,
        '-i',
        input,
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-frames:v',
        String(span.frames),
        '-c',
        'copy',
        '-bsf:v',
        H264_COLOUR_TAGS,
        '-video_track_timescale',
        String(span.timescale),
        '-movflags',
        '+faststart',
        temp,
      ],
      options,
    ),
  );
}

/** Options of {@link joinVideos}. */
export interface JoinOptions extends FFmpegFileOptions {
  /**
   * `'auto'` (default) writes `avc3` when the files' H.264 parameter sets differ, since `avc1` keeps one set in its
   * sample entry and a join then carries each file's own sets in band (ISO/IEC 14496-15), and `avc1` when they agree;
   * or force either.
   */
  sampleEntry?: 'auto' | 'avc1' | 'avc3';
}

/**
 * Joins video files end to end by stream copy, without encoding again (ffmpeg's concat demuxer), into `output` with
 * `+faststart`. The files must share codec, size and frame rate, as chunks of one render do. Resolves the sample
 * entry written for H.264 MP4 or MOV inputs (`'avc1'` or `'avc3'`), else undefined.
 */
export async function joinVideos(
  inputs: readonly string[],
  output: string,
  options: JoinOptions = {},
): Promise<'avc1' | 'avc3' | undefined> {
  if (!Array.isArray(inputs) || !inputs.length) throw typeError('joinVideos needs one or more input files', 'headless');
  for (const input of inputs) name(input, 'input files', 'joinVideos');
  name(output, 'an output file', 'joinVideos');
  const mode = options.sampleEntry ?? 'auto';
  if (!['auto', 'avc1', 'avc3'].includes(mode)) throw rangeError("sampleEntry is 'auto', 'avc1' or 'avc3'", 'headless');
  options.signal?.throwIfAborted();
  const configs = await Promise.all(
      inputs.map((f) =>
        readVideoTrack(f).then(
          (t) => t.avcConfig,
          () => undefined,
        ),
      ),
    ),
    h264 = configs.every((c) => c !== undefined),
    differ = h264 && configs.some((c) => Buffer.compare(c!, configs[0]!) !== 0),
    entry = !h264 ? undefined : mode === 'auto' ? (differ ? 'avc3' : 'avc1') : mode;
  // The concat list (ffmpeg's ffconcat format): absolute paths in single quotes, a quote written as '\''.
  const list = join(dirname(resolve(output)), `.${basename(output)}.${process.pid}.ffconcat`);
  await writeFile(
    list,
    'ffconcat version 1.0\n' + inputs.map((f) => `file '${resolve(f).replace(/'/g, "'\\''")}'\n`).join(''),
  );
  try {
    await writeVia(output, (temp) =>
      runFFmpeg(
        [
          '-y',
          '-v',
          'error',
          '-nostdin',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          list,
          '-map',
          '0',
          '-c',
          'copy',
          ...(entry ? ['-tag:v', entry] : []),
          '-movflags',
          '+faststart',
          temp,
        ],
        options,
      ),
    );
  } finally {
    await rm(list, { force: true });
  }
  return entry;
}

/** Options of {@link addSound}. */
export interface AddSoundOptions extends FFmpegFileOptions {
  /** Audio codec: `'aac'` (default for MP4 and MOV), `'opus'` (default for WebM), or `'copy'` to keep the sound's own. */
  codec?: 'aac' | 'opus' | 'copy';
  /** Bits per second when encoding. Default 192000. */
  bitrate?: number;
  /** Seconds of picture before the sound starts. Default 0. */
  offset?: number;
  /** End the file with the shorter of picture and sound. Default false: the file keeps both lengths. */
  shortest?: boolean;
}

/**
 * Lays the sound file `sound` (WAV, FLAC, MP3, AAC or any file ffmpeg reads; its first audio stream) under the video
 * `video` without encoding the picture again (`-c:v copy`), into `output`. Any sound the video had is replaced.
 */
export async function addSound(
  video: string,
  sound: string,
  output: string,
  options: AddSoundOptions = {},
): Promise<void> {
  name(video, 'a video file', 'addSound');
  name(sound, 'a sound file', 'addSound');
  name(output, 'an output file', 'addSound');
  const webm = /\.webm$/i.test(output),
    codec = options.codec ?? (webm ? 'opus' : 'aac'),
    bitrate = options.bitrate ?? 192_000,
    offset = options.offset ?? 0;
  if (!['aac', 'opus', 'copy'].includes(codec))
    throw rangeError("addSound codec is 'aac', 'opus' or 'copy'", 'headless');
  if (!(bitrate > 0) || !Number.isFinite(bitrate)) throw rangeError('Invalid addSound bitrate', 'headless');
  if (!(offset >= 0) || !Number.isFinite(offset))
    throw rangeError('addSound offset must be 0 or more seconds', 'headless');
  const audio =
    codec === 'copy'
      ? ['-c:a', 'copy']
      : ['-c:a', codec === 'opus' ? 'libopus' : 'aac', '-b:a', String(Math.round(bitrate))];
  await writeVia(output, (temp) =>
    runFFmpeg(
      [
        '-y',
        '-v',
        'error',
        '-nostdin',
        '-i',
        video,
        ...(offset ? ['-itsoffset', String(offset)] : []),
        '-i',
        sound,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        ...audio,
        ...(options.shortest ? ['-shortest'] : []),
        ...(webm ? [] : ['-movflags', '+faststart']),
        temp,
      ],
      options,
    ),
  );
}
