#!/usr/bin/env node
// The master encode of a shot (P3, docs/shots.md, Master encode): the frames a shot render wrote (manifest.json) to a
// vertical H.264 High MP4 for the shorts, by the ffmpeg the machine has (outside the repository), with its checks:
// - the master: YouTube's recommended upload settings (YouTube Help, "Recommended upload encoding settings"): H.264
//   High, progressive, CABAC, a closed GOP of half the frame rate, 2 consecutive B-frames, VBR;
//   moov before mdat, 4:2:0, BT.709 primaries, transfer and matrix in the bitstream and in the MP4's colr box,
//   limited range, constant quality near visually lossless, no audio track;
// - the decode-back colour check: a colour chart clip encoded with the same settings and decoded again must come back
//   within a mean CIEDE2000 of 1 (no washed-out or range-shifted encode); sampled frames of the master are measured too;
// - exact frame count and duration (frames / fps), read back with ffprobe;
// - the GOP read back: ffprobe's frame types (a keyframe exactly every fps / 2 frames, at most 2 B-frames in a row)
//   and the x264 settings the encoder wrote into the stream (bframes=2, keyint of fps / 2);
// - the platform proxy check: the master re-encoded at 8 and 3 Mbps (what YouTube and TikTok deliver), with the fine
//   detail left in sampled frames; a frame keeping under half of its detail at either rate is flagged before upload.
// The grade is not the encoder's: AgX and the kit's Grade run in the page (@margoengine/tonemap).
//
//   node tools/shot/encode.mjs <frames folder> [--out <file.mp4>] [--ffmpeg <ffmpeg>] [--crf <n>] [--no-proxy]
//
// MARGO_FFMPEG names ffmpeg (default `ffmpeg` on the PATH); ffprobe is the one beside it. Exit 0 when every check
// passes, 1 when one fails (the report says which), 2 for bad arguments.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { decodePNG } from '@margoengine/headless/compare';
import { detailKeptFloor } from '@margoengine/headless/look';
import { detailKept, imageDeltaE } from './colour.mjs';
import { readMp4 } from './mp4.mjs';

/** Constant quality of the master: near visually lossless (about 50 to 80 Mbps for a busy 1080 x 1920 short at 60). */
export const MASTER_CRF = 12;
/** Frames per closed GOP: half the frame rate (YouTube's recommended upload settings), 30 at 60 fps, 15 at 30. */
export function gopFrames(fps) {
  if (!Number.isInteger(fps) || fps < 2 || fps % 2)
    throw new RangeError(`a master's frame rate must be an even whole number, not ${fps}`);
  return fps / 2;
}
/** Consecutive B-frames of the master (YouTube's recommended upload settings; x264's default is 3). */
export const B_FRAMES = 2;
/** The bit rates of the platform proxy check, Mbps. */
export const PROXY_MBPS = Object.freeze([8, 3]);
/** Mean CIEDE2000 the decode-back colour chart must stay under. */
export const CHART_DELTA_E = 1;
/**
 * A sampled frame keeping less than this share of its fine detail at a proxy rate is flagged for that rate: 0.5 for a
 * shot of the natural look, the look family's own floor (0.6 for `animatedFeature`, `detailKeptFloor`) when the shot names a
 * family, where a flag also fails the master.
 */
export const DETAIL_FLOOR = 0.5;

// RGB to Y'CbCr by the BT.709 matrix at limited range, and the tags that say so (ffmpeg's scaler uses BT.601 unless
// told otherwise).
const COLOUR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'],
  // setparams: the scaler sets the frames' matrix and range but leaves their primaries and transfer unset, and ffmpeg
  // 9 writes the frames' own tags over -color_primaries and -color_trc (2, unspecified, in the bitstream and colr).
  TO_YUV =
    'scale=in_range=full:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
  FROM_YUV = 'scale=in_color_matrix=bt709:in_range=tv:out_range=full,format=rgb24';

/** ffmpeg arguments of the master from a PNG sequence (`pattern`, e.g. frames/frame_%04d.png) at `fps`. */
export function masterArguments({ pattern, fps, frames, output, crf = MASTER_CRF }) {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-framerate',
    String(fps),
    '-start_number',
    '0',
    '-i',
    pattern,
    '-frames:v',
    String(frames),
    '-an',
    '-vf',
    TO_YUV,
    ...COLOUR,
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-preset',
    'slow',
    '-crf',
    String(crf),
    '-g',
    String(gopFrames(fps)),
    '-keyint_min',
    String(gopFrames(fps)),
    '-bf',
    String(B_FRAMES),
    '-sc_threshold',
    '0',
    '-flags',
    '+cgop',
    '-x264-params',
    'open-gop=0',
    '-r',
    String(fps),
    '-movflags',
    '+faststart+write_colr',
    output,
  ];
}

/** ffmpeg arguments of a platform proxy: the master re-encoded at `mbps`. */
export function proxyArguments({ input, mbps, output }) {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-an',
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-preset',
    'medium',
    '-b:v',
    `${mbps}M`,
    '-maxrate',
    `${mbps}M`,
    '-bufsize',
    `${2 * mbps}M`,
    ...COLOUR,
    '-pix_fmt',
    'yuv420p',
    output,
  ];
}

const run = (program, args, { timeout = 3_600_000, input } = {}) => {
  const result = spawnSync(program, args, { timeout, input, maxBuffer: 1 << 30, windowsHide: true });
  if (result.error) throw new Error(`${program} did not run: ${result.error.message} (set MARGO_FFMPEG or --ffmpeg)`);
  if (result.status !== 0)
    throw new Error(
      `${basename(program)} ${args.slice(0, 6).join(' ')} ... exited ${result.status}: ${String(result.stderr).slice(-800)}`,
    );
  return result.stdout;
};

/** Decodes frames `indices` of a video to RGB bytes (BT.709, limited range in, full range out). */
async function decodeFrames(ffmpeg, file, { width, height, indices }) {
  const select = indices.map((i) => `eq(n\\,${i})`).join('+');
  const raw = run(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    file,
    '-vf',
    `select=${select},${FROM_YUV}`,
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    '-',
  ]);
  const size = width * height * 3;
  if (raw.length !== size * indices.length)
    throw new Error(`decoded ${raw.length} bytes, not ${indices.length} frames of ${width} x ${height}`);
  return indices.map((_, k) => raw.subarray(k * size, (k + 1) * size));
}

/** ffprobe's view of the video stream: codec, profile, size, colour tags, frame count and duration. */
function probe(ffprobe, file) {
  const out = JSON.parse(
    run(ffprobe, [
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,profile,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,r_frame_rate,nb_read_frames,duration_ts,time_base,duration:format=bit_rate,nb_streams',
      '-of',
      'json',
      file,
    ]).toString(),
  );
  return { ...out.streams[0], bit_rate: Number(out.format.bit_rate), nb_streams: out.format.nb_streams };
}

/**
 * The GOP of an encoded file, read back: the frame types ffprobe decodes (in display order) and the x264 settings
 * string the encoder writes into the stream. Returns { keyframes, bRun, bFrames, x264 }: the keyframe indices, the
 * longest run of consecutive B-frames, the B-frame count and the encoder's bframes, keyint and keyint_min.
 */
export function readGop(ffprobe, file) {
  const lines = run(ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=key_frame,pict_type',
    '-of',
    'csv=p=0',
    file,
  ])
    .toString()
    .split(/\r?\n/)
    .filter(Boolean);
  return gopOf(lines, readFileSync(file));
}

/** readGop's arithmetic on ffprobe's `key_frame,pict_type` lines and the file's bytes. */
export function gopOf(lines, bytes) {
  const keyframes = [];
  let bRun = 0,
    inRow = 0,
    bFrames = 0;
  lines.forEach((line, index) => {
    const [key, type] = line.split(',');
    if (key === '1') keyframes.push(index);
    if (type === 'B') {
      bFrames++;
      inRow++;
      bRun = Math.max(bRun, inRow);
    } else inRow = 0;
  });
  const text = Buffer.from(bytes).toString('latin1'),
    at = text.indexOf('x264 - core'),
    options = at < 0 ? '' : text.slice(at, text.indexOf('\0', at)),
    option = (name) => {
      const m = options.match(new RegExp(`(?:^| )${name}=(\\d+)`));
      return m ? Number(m[1]) : null;
    };
  return {
    frames: lines.length,
    keyframes,
    bRun,
    bFrames,
    x264: {
      bframes: option('bframes'),
      keyint: option('keyint'),
      keyintMin: option('keyint_min'),
      openGop: option('open_gop'),
    },
  };
}

/** Whether a read-back GOP is the master's: a keyframe exactly every `gop` frames, at most B_FRAMES B-frames in a row. */
export function gopPasses({ frames, keyframes, bRun, bFrames, x264 }, gop) {
  const spaced = keyframes.length === Math.ceil(frames / gop) && keyframes.every((k, i) => k === i * gop);
  return (
    spaced &&
    bRun <= B_FRAMES &&
    (frames <= gop || bFrames > 0) &&
    x264.bframes === B_FRAMES &&
    x264.keyint === gop &&
    x264.openGop === 0
  );
}

/**
 * The colour chart: flat patches over the RGB cube (each channel at 0, 16, 64, 128, 192, 235 and 255), a grey ramp and
 * the primaries and secondaries, at `width` x `height`. Returns RGBA bytes and the patches' rectangles.
 */
export function colourChart(width, height) {
  const levels = [0, 16, 64, 128, 192, 235, 255],
    colours = [];
  for (const r of [0, 128, 255]) for (const g of [0, 128, 255]) for (const b of [0, 128, 255]) colours.push([r, g, b]);
  for (const v of levels) colours.push([v, v, v]);
  colours.push(
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [0, 255, 255],
    [255, 0, 255],
    [255, 255, 0],
    [200, 120, 80],
    [60, 90, 160],
    [90, 140, 60],
  );
  const columns = 5,
    rows = Math.ceil(colours.length / columns),
    w = Math.floor(width / columns),
    h = Math.floor(height / rows),
    rgba = new Uint8ClampedArray(width * height * 4).fill(255),
    patches = [];
  colours.forEach((colour, k) => {
    const x0 = (k % columns) * w,
      y0 = Math.floor(k / columns) * h;
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const p = (y * width + x) * 4;
        rgba[p] = colour[0];
        rgba[p + 1] = colour[1];
        rgba[p + 2] = colour[2];
      }
    patches.push({ colour, x0, y0, w, h });
  });
  return { rgba, patches };
}

/**
 * Encodes and checks a shot's master. Writes the MP4 and `<frames>/encode.json` (the report); resolves the report.
 * @param {string} frames The shot's frames folder (with manifest.json).
 */
export async function encodeShot(
  frames,
  { out, ffmpeg = process.env.MARGO_FFMPEG || 'ffmpeg', crf = MASTER_CRF, proxy = true, samples = 8 } = {},
) {
  const manifest = JSON.parse(readFileSync(join(frames, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'margo-shot-frames')
    throw new TypeError(`${frames}/manifest.json is not a shot render's manifest`);
  if (manifest.determinism?.identical === false)
    throw new Error('the render failed its determinism check; render it again before encoding');
  const [width, height] = manifest.size,
    { fps } = manifest,
    count = manifest.frames,
    ffprobe = join(dirname(ffmpeg), basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe')),
    probeCommand = existsSync(ffprobe) ? ffprobe : 'ffprobe',
    output = resolve(out ?? join(dirname(frames), manifest.output?.master ?? `${manifest.id}.mp4`));
  manifest.files.forEach((file, i) => {
    if (file.file !== `frames/frame_${String(i).padStart(4, '0')}.png`)
      throw new Error(`frame ${i} is ${file.file}, not in sequence`);
  });
  const work = mkdtempSync(join(tmpdir(), 'margo-encode-')),
    report = { format: 'margo-shot-encode', version: 1, id: manifest.id, master: output, checks: {}, pass: true };
  const check = (name, pass, detail) => {
    report.checks[name] = { pass, ...detail };
    if (!pass) report.pass = false;
  };
  try {
    run(
      ffmpeg,
      masterArguments({ pattern: join(frames, 'frames', 'frame_%04d.png'), fps, frames: count, output, crf }),
    );
    // The master's stream, tags and length.
    const info = probe(probeCommand, output),
      [num, den] = info.time_base.split('/').map(Number),
      seconds = (Number(info.duration_ts) * num) / den;
    report.bitrateMbps = Math.round(info.bit_rate / 1e4) / 100;
    report.bytes = statSync(output).size;
    check(
      'stream',
      info.codec_name === 'h264' &&
        info.profile === 'High' &&
        info.width === width &&
        info.height === height &&
        info.pix_fmt === 'yuv420p' &&
        info.nb_streams === 1,
      {
        codec: info.codec_name,
        profile: info.profile,
        size: [info.width, info.height],
        pix_fmt: info.pix_fmt,
        streams: info.nb_streams,
      },
    );
    check(
      'tags',
      info.color_range === 'tv' &&
        info.color_space === 'bt709' &&
        info.color_transfer === 'bt709' &&
        info.color_primaries === 'bt709',
      {
        range: info.color_range,
        matrix: info.color_space,
        transfer: info.color_transfer,
        primaries: info.color_primaries,
      },
    );
    const box = readMp4(readFileSync(output)),
      colr = box.tracks[0]?.colr;
    check(
      'colr',
      !!colr &&
        colr.type === 'nclx' &&
        colr.primaries === 1 &&
        colr.transfer === 1 &&
        colr.matrix === 1 &&
        colr.fullRange === false,
      { colr: colr ?? null },
    );
    check('faststart', box.faststart, { order: box.order });
    check(
      'frames',
      Number(info.nb_read_frames) === count &&
        info.r_frame_rate === `${fps}/1` &&
        Math.abs(seconds - count / fps) < 1e-9,
      {
        frames: Number(info.nb_read_frames),
        want: count,
        rate: info.r_frame_rate,
        seconds,
        wantSeconds: count / fps,
      },
    );
    const gop = gopFrames(fps),
      read = readGop(probeCommand, output);
    check('gop', gopPasses(read, gop), {
      gop,
      keyframes: read.keyframes.length,
      firstKeyframes: read.keyframes.slice(0, 4),
      longestBRun: read.bRun,
      bFrames: read.bFrames,
      x264: read.x264,
    });
    // Decode-back colour: the chart through the same encode.
    const chart = colourChart(width, height),
      chartPng = join(work, 'chart_%04d.png');
    writeFileSync(join(work, 'chart.rgba'), chart.rgba);
    run(ffmpeg, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${width}x${height}`,
      '-i',
      join(work, 'chart.rgba'),
      '-frames:v',
      '1',
      join(work, 'chart_0000.png'),
    ]);
    const chartFrames = gopFrames(fps);
    for (let i = 1; i < chartFrames; i++)
      writeFileSync(join(work, `chart_${String(i).padStart(4, '0')}.png`), readFileSync(join(work, 'chart_0000.png')));
    const chartMp4 = join(work, 'chart.mp4');
    run(ffmpeg, masterArguments({ pattern: chartPng, fps, frames: chartFrames, output: chartMp4, crf }));
    const [back] = await decodeFrames(ffmpeg, chartMp4, { width, height, indices: [chartFrames - 1] });
    let chartSum = 0,
      chartMax = 0,
      patches = 0;
    for (const { x0, y0, w, h } of chart.patches) {
      // Inside each patch, away from its edges where 4:2:0 chroma blends neighbours.
      const inner = (array, channels) => {
        const sub = new Uint8Array((w - 16) * (h - 16) * channels);
        for (let y = 0; y < h - 16; y++)
          sub.set(
            array.subarray(((y0 + 8 + y) * width + x0 + 8) * channels, ((y0 + 8 + y) * width + x0 + w - 8) * channels),
            y * (w - 16) * channels,
          );
        return sub;
      };
      const { mean, max } = imageDeltaE(inner(chart.rgba, 4), inner(back, 3), {
        width: w - 16,
        height: h - 16,
        step: 4,
      });
      chartSum += mean;
      chartMax = Math.max(chartMax, max);
      patches++;
    }
    const chartMean = chartSum / patches;
    check('chart', chartMean < CHART_DELTA_E, {
      meanDeltaE: round(chartMean),
      maxDeltaE: round(chartMax),
      patches,
      bound: CHART_DELTA_E,
    });
    // Sampled frames of the master against their source PNGs.
    const picks = [
      ...new Set([
        ...Object.values(manifest.probes ?? {}).map((p) => p.frame),
        ...Array.from({ length: samples }, (_, k) => Math.floor((k * count) / samples)),
      ]),
    ]
      .filter((i) => i >= 0 && i < count)
      .sort((a, b) => a - b);
    const sources = await Promise.all(
      picks.map(async (i) => (await decodePNG(readFileSync(join(frames, manifest.files[i].file)))).data),
    );
    const decoded = await decodeFrames(ffmpeg, output, { width, height, indices: picks });
    const frameErrors = picks.map((index, k) => ({
      index,
      ...imageDeltaE(sources[k], decoded[k], { width, height, step: 3 }),
    }));
    report.frameDeltaE = frameErrors.map(({ index, mean, max }) => ({ index, mean: round(mean), max: round(max) }));
    // The platform proxies: what fine detail survives a re-encode at the platforms' rates.
    if (proxy) {
      report.proxy = [];
      for (const mbps of PROXY_MBPS) {
        const file = join(work, `proxy-${mbps}.mp4`);
        run(ffmpeg, proxyArguments({ input: output, mbps, output: file }));
        const frames2 = await decodeFrames(ffmpeg, file, { width, height, indices: picks });
        const kept = frames2.map((rgb, k) => detailKept(decoded[k], rgb, { width, height }));
        report.proxy.push({ mbps, detailKept: kept.map(round), worst: round(Math.min(...kept)) });
      }
      // A shot of the natural look: a warning for the reviewer, not a failed master (fine detail is a choice of the shot).
      // A shot that names a look family is held to its floor and fails the master (T7, the roadmap's 0.6).
      const family = manifest.header?.lookFamily ?? null,
        floor = family === null ? DETAIL_FLOOR : detailKeptFloor(family);
      report.proxyFlags = report.proxy.flatMap(({ mbps, detailKept: kept }) =>
        picks
          .filter((_, k) => kept[k] < floor)
          .map((index) => `frame ${index} keeps ${kept[picks.indexOf(index)]} of its fine detail at ${mbps} Mbps`),
      );
      if (family !== null)
        check('detailKept', report.proxyFlags.length === 0, {
          family,
          floor,
          worst: Math.min(...report.proxy.map((row) => row.worst)),
        });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileSync(join(frames, 'encode.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

const round = (value) => Math.round(value * 1000) / 1000;

// The command line: resolves to 0 for a master that passed every check, 1 for a failed one, 2 for bad arguments.
async function main() {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        ffmpeg: { type: 'string' },
        crf: { type: 'string' },
        'no-proxy': { type: 'boolean' },
      },
    }));
    if (positionals.length !== 1) throw new TypeError('name one frames folder (with manifest.json)');
  } catch (error) {
    console.error(
      `${error.message}\nusage: node tools/shot/encode.mjs <frames folder> [--out <file.mp4>] [--ffmpeg <ffmpeg>] [--crf <n>] [--no-proxy]`,
    );
    return 2;
  }
  try {
    const report = await encodeShot(resolve(positionals[0]), {
      out: values.out,
      ...(values.ffmpeg ? { ffmpeg: values.ffmpeg } : {}),
      ...(values.crf ? { crf: Number(values.crf) } : {}),
      proxy: !values['no-proxy'],
    });
    for (const [name, result] of Object.entries(report.checks))
      console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${name} ${JSON.stringify(result)}`);
    for (const flag of report.proxyFlags ?? []) console.log(`flag ${flag}`);
    console.log(`${report.pass ? 'master ok' : 'master FAILED'}: ${report.master} (${report.bitrateMbps} Mbps)`);
    return report.pass ? 0 : 1;
  } catch (error) {
    console.error(error.stack ?? String(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
