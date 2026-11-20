// GAP-FILM-FFMPEG, GAP-FILM-STREAMCOPY, GAP-FILM-LAYERS: @margoengine/headless/ffmpeg-files and the layers of
// encodeWithFFmpeg, without ffmpeg. The MP4 files here are written box by box from ISO/IEC 14496-12, so every expected
// time is worked out from the test's own numbers; a stand-in program records the ffmpeg arguments it is given.
// scripts/test-real-ffmpeg.mjs runs the same tools through a real ffmpeg and decodes the results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWithFFmpeg, ffmpegArguments } from '../dist/ffmpeg.js';
import {
  H264_COLOUR_TAGS,
  addSound,
  checkSpan,
  copySpan,
  encoderArguments,
  joinVideos,
  mp4Timescale,
  readVideoTrack,
} from '../dist/ffmpeg-files.js';

// ---- MP4 boxes (ISO/IEC 14496-12) ----
const u32 = (...values) => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => (v < 0 ? b.writeInt32BE(v, i * 4) : b.writeUInt32BE(v, i * 4)));
  return b;
};
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};
const full = (type, version, flags, ...parts) => box(type, u32(((version << 24) | flags) >>> 0), ...parts);
const TS = 15360,
  STEP = 512; // ticks per frame at 30 fps

/**
 * An MP4 with one H.264 track whose samples are `frames` (in decode order, each `[k, key]`: presentation frame k at
 * k / 30 s), stored either in sample tables or, with `fragmented`, in one movie fragment. Every sample decodes STEP
 * ticks after the one before, presents (k + 1) * STEP ticks in, and the edit list starts the track at STEP.
 */
function mp4(frames, { fragmented = false, avcC = [1, 100, 0, 31, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 31, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80] } = {}) {
  const offsets = frames.map(([k], i) => (k + 1) * STEP - i * STEP),
    keys = frames.flatMap(([, key], i) => (key ? [i + 1] : [])),
    entry = box('avc1', Buffer.alloc(78), box('avcC', Buffer.from(avcC))),
    tables = fragmented
      ? [full('stsd', 0, 0, u32(1), entry), full('stts', 0, 0, u32(0)), full('stsz', 0, 0, u32(0, 0))]
      : [
          full('stsd', 0, 0, u32(1), entry),
          full('stts', 0, 0, u32(1, frames.length, STEP)),
          full('ctts', 0, 0, u32(frames.length), ...offsets.map((o) => u32(1, o))),
          full('stss', 0, 0, u32(keys.length, ...keys)),
        ],
    trak = box(
      'trak',
      full('tkhd', 0, 3, u32(0, 0, 7), Buffer.alloc(72)),
      box('edts', full('elst', 0, 0, u32(1, frames.length * 1000, STEP, 0x10000))),
      box(
        'mdia',
        full('mdhd', 0, 0, u32(0, 0, TS, frames.length * STEP), Buffer.alloc(4)),
        full('hdlr', 0, 0, u32(0), Buffer.from('vide'), Buffer.alloc(13)),
        box('minf', box('stbl', ...tables)),
      ),
    ),
    moov = box(
      'moov',
      full('mvhd', 0, 0, u32(0, 0, 1000, frames.length * 33), Buffer.alloc(80)),
      trak,
      ...(fragmented ? [box('mvex', full('trex', 0, 0, u32(7, 1, 0, 0, 0x10000)))] : []),
    ),
    // A fragment: tfhd with default sample flags (non-sync), tfdt, and a trun with durations, flags and offsets.
    moof = fragmented
      ? box(
          'moof',
          full('mfhd', 0, 0, u32(1)),
          box(
            'traf',
            full('tfhd', 0, 0x20, u32(7, 0x10000)),
            full('tfdt', 1, 0, Buffer.alloc(8)),
            full('trun', 0, 0x1 | 0x100 | 0x400 | 0x800, u32(frames.length, 0), ...frames.map(([, key], i) => u32(STEP, key ? 0 : 0x10000, offsets[i]))),
          ),
        )
      : Buffer.alloc(0);
  return Buffer.concat([box('ftyp', Buffer.from('isom'), u32(0x200), Buffer.from('isomavc1')), moov, moof, box('mdat', Buffer.alloc(16))]);
}

// Closed GOPs of three with B-frames: decode order K0 P2 B1 K3 P5 B4.
const CLOSED = [[0, true], [2, false], [1, false], [3, true], [5, false], [4, false]],
  // An open GOP: the key frame at 3 is followed in decode order by a frame shown before it.
  OPEN = [[0, true], [1, false], [3, true], [2, false], [4, false]];

const folder = async () => mkdtemp(join(tmpdir(), 'margo-ffmpeg-files-'));

test('readVideoTrack: codec, timescale, avcC and every sample time and key flag, from sample tables and from fragments', async () => {
  const dir = await folder();
  try {
    for (const fragmented of [false, true]) {
      const file = join(dir, `clip${fragmented}.mp4`);
      await writeFile(file, mp4(CLOSED, { fragmented }));
      const track = await readVideoTrack(file);
      assert.equal(track.codec, 'avc1');
      assert.equal(track.timescale, TS);
      assert.deepEqual([...track.avcConfig.subarray(0, 4)], [1, 100, 0, 31]);
      assert.deepEqual(
        track.samples.map((s) => [Math.round(s.time * 30 * 1e6) / 1e6, s.key]),
        CLOSED,
        fragmented ? 'fragments' : 'sample tables',
      );
    }
    await writeFile(join(dir, 'not.mp4'), Buffer.from('not a video'));
    await assert.rejects(readVideoTrack(join(dir, 'not.mp4')), { code: 'unsupported' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkSpan: a span copies only from a key frame, whole, with no frame decoded after the next key frame', async () => {
  const dir = await folder();
  try {
    const closed = join(dir, 'closed.mp4'),
      open = join(dir, 'open.mp4');
    await writeFile(closed, mp4(CLOSED));
    await writeFile(open, mp4(OPEN, { fragmented: true }));
    assert.deepEqual(await checkSpan(closed, { start: 0, frames: 3, fps: 30 }), { ok: true });
    assert.deepEqual(await checkSpan(closed, { start: 0.1, frames: 3, fps: 30 }), { ok: true });
    assert.deepEqual(await checkSpan(closed, { start: 0, frames: 6, fps: 30 }), { ok: true });
    assert.match((await checkSpan(closed, { start: 1 / 30, frames: 2, fps: 30 })).reason, /not on a key frame/);
    assert.match((await checkSpan(closed, { start: 0, frames: 2, fps: 30 })).reason, /next key frame is not at its end/);
    assert.match((await checkSpan(closed, { start: 0.1, frames: 4, fps: 30 })).reason, /ends before/);
    assert.match((await checkSpan(closed, { start: 0, frames: 3, fps: 25, timescale: 12800 })).reason, /next key frame|off the/);
    assert.match((await checkSpan(open, { start: 0.1, frames: 2, fps: 30 })).reason, /open GOP/);
    await assert.rejects(checkSpan(closed, { start: -1, frames: 3, fps: 30 }), RangeError);
    assert.equal(mp4Timescale(30), 15360);
    assert.equal(mp4Timescale(60), 15360);
    assert.equal(mp4Timescale(24), 12288);
    assert.throws(() => mp4Timescale(29.97), RangeError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A program that stands in for ffmpeg: records its arguments (and an ffconcat list it reads) in MARGO_ARGS_FILE,
// writes its last argument, or fails as told.
const STAND_IN = `
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), list = args.includes('concat') ? readFileSync(args[args.indexOf('-i') + 1], 'utf8') : undefined;
writeFileSync(process.env.MARGO_ARGS_FILE, JSON.stringify({ args, list }));
if (process.env.MARGO_STAND_IN === 'fail') { console.error('Invalid data found'); process.exitCode = 1; }
else writeFileSync(args.at(-1), 'made');
`;
async function standIn(dir) {
  const script = join(dir, 'stand-in.mjs'),
    record = join(dir, 'args.json');
  await writeFile(script, STAND_IN);
  process.env.MARGO_ARGS_FILE = record;
  return { ffmpeg: [process.execPath, script], args: async () => JSON.parse(await readFile(record, 'utf8')) };
}

test('copySpan: the stream copy of a checked span, re-tagged to the engine colours at the chunk timescale', async () => {
  const dir = await folder();
  try {
    const { ffmpeg, args } = await standIn(dir),
      input = join(dir, 'recording.mp4'),
      output = join(dir, 'chunk.mp4');
    await writeFile(input, mp4(CLOSED));
    await copySpan(input, output, { start: 0.1, frames: 3, fps: 30, ffmpeg });
    const { args: given } = await args();
    assert.equal(await readFile(output, 'utf8'), 'made');
    assert.equal(given[given.indexOf('-ss') + 1], '0.100000');
    assert.equal(given[given.indexOf('-frames:v') + 1], '3');
    assert.equal(given[given.indexOf('-bsf:v') + 1], H264_COLOUR_TAGS);
    assert.equal(given[given.indexOf('-video_track_timescale') + 1], '15360');
    assert.deepEqual(given.slice(given.indexOf('-c'), given.indexOf('-c') + 2), ['-c', 'copy']);
    await assert.rejects(copySpan(input, join(dir, 'no.mp4'), { start: 1 / 30, frames: 2, fps: 30, ffmpeg }), (e) => e.code === 'unsupported' && /key frame/.test(e.message));
    assert.deepEqual((await readdir(dir)).filter((f) => f.startsWith('no') || f.includes('.part')), [], 'nothing written for a refused span');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('joinVideos: concat by stream copy, avc1 when the parameter sets agree and avc3 when they differ', async () => {
  const dir = await folder();
  try {
    const { ffmpeg, args } = await standIn(dir),
      [a, b, c] = ['a.mp4', "it's b.mp4", 'c.mp4'].map((f) => join(dir, f)),
      output = join(dir, 'film.mp4');
    await writeFile(a, mp4(CLOSED));
    await writeFile(b, mp4(CLOSED));
    await writeFile(c, mp4(CLOSED, { avcC: [1, 77, 0, 30, 0xff, 0xe1, 0, 2, 0x67, 0x4d, 1, 0, 2, 0x68, 0xce] }));
    assert.equal(await joinVideos([a, b], output, { ffmpeg }), 'avc1');
    let { args: given, list } = await args();
    assert.equal(given[given.indexOf('-tag:v') + 1], 'avc1');
    assert.deepEqual(given.slice(given.indexOf('-f'), given.indexOf('-f') + 4), ['-f', 'concat', '-safe', '0']);
    assert.equal(list, `ffconcat version 1.0\nfile '${a}'\nfile '${b.replace("'", "'\\''")}'\n`);
    assert.equal(await joinVideos([a, b, c], output, { ffmpeg }), 'avc3');
    ({ args: given } = await args());
    assert.equal(given[given.indexOf('-tag:v') + 1], 'avc3');
    assert.equal(await joinVideos([a, c], output, { ffmpeg, sampleEntry: 'avc1' }), 'avc1');
    process.env.MARGO_STAND_IN = 'fail';
    await assert.rejects(joinVideos([a, b], join(dir, 'failed.mp4'), { ffmpeg }), (e) => e.code === 'failed' && /Invalid data/.test(e.cause));
    delete process.env.MARGO_STAND_IN;
    const left = await readdir(dir);
    assert.ok(!left.includes('failed.mp4') && !left.some((f) => f.includes('.part') || f.endsWith('.ffconcat')), left.join());
    await assert.rejects(joinVideos([], output, { ffmpeg }), TypeError);
  } finally {
    delete process.env.MARGO_STAND_IN;
    await rm(dir, { recursive: true, force: true });
  }
});

test('addSound: the picture copied, the sound encoded (AAC for MP4, Opus for WebM) or copied, with an offset', async () => {
  const dir = await folder();
  try {
    const { ffmpeg, args } = await standIn(dir);
    await addSound('film.mp4', 'mix.wav', join(dir, 'out.mp4'), { ffmpeg, offset: 0.5, shortest: true });
    let { args: given } = await args();
    assert.deepEqual(given.slice(given.indexOf('-i'), given.indexOf('-i') + 6), ['-i', 'film.mp4', '-itsoffset', '0.5', '-i', 'mix.wav']);
    assert.deepEqual(given.slice(given.indexOf('-c:v'), given.indexOf('-c:v') + 6), ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192000']);
    assert.ok(given.includes('-shortest') && given.includes('+faststart'));
    await addSound('film.webm', 'mix.wav', join(dir, 'out.webm'), { ffmpeg });
    ({ args: given } = await args());
    assert.equal(given[given.indexOf('-c:a') + 1], 'libopus');
    assert.ok(!given.includes('-itsoffset') && !given.includes('+faststart'));
    await addSound('film.mp4', 'mix.m4a', join(dir, 'out.mp4'), { ffmpeg, codec: 'copy' });
    ({ args: given } = await args());
    assert.deepEqual(given.slice(given.indexOf('-c:a'), given.indexOf('-c:a') + 2), ['-c:a', 'copy']);
    await assert.rejects(addSound('film.mp4', 'mix.wav', 'out.mp4', { ffmpeg, offset: -1 }), RangeError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('encoderArguments: each encoder with the engine colour chain, tags and VUI rewrite', () => {
  const defaults = ffmpegArguments(2, 2, { output: 'x.mp4' }),
    chain = defaults[defaults.indexOf('-vf') + 1];
  for (const [encoder, codec, format] of [
    ['x264', 'libx264', 'yuv420p'],
    ['nvenc', 'h264_nvenc', 'yuv420p'],
    ['amf', 'h264_amf', 'nv12'],
    ['qsv', 'h264_qsv', 'nv12'],
  ]) {
    const args = encoderArguments(encoder);
    assert.equal(args[args.indexOf('-vf') + 1], chain.replace('format=yuv420p', `format=${format}`), encoder);
    assert.equal(args[args.indexOf('-c:v') + 1], codec);
    assert.equal(args[args.indexOf('-bsf:v') + 1], H264_COLOUR_TAGS);
    for (const tag of ['-colorspace', '-color_primaries', '-color_trc', '-color_range', '-chroma_sample_location'])
      assert.equal(args[args.indexOf(tag) + 1], defaults[defaults.indexOf(tag) + 1], `${encoder} ${tag}`);
  }
  assert.deepEqual(encoderArguments('x264', { quality: 17, preset: 'medium' }).slice(-8, -4), ['-preset', 'medium', '-crf', '17']);
  assert.ok(encoderArguments('nvenc', { quality: 23 }).join(' ').includes('-preset p5 -tune hq -rc vbr -cq 23 -b:v 0'));
  assert.throws(() => encoderArguments('vaapi'), RangeError);
  assert.throws(() => encoderArguments('x264', { quality: 0 }), RangeError);
  assert.throws(() => encoderArguments('amf', { preset: 'fast' }), RangeError);
});

test('encodeWithFFmpeg layers: one encode lays clips over the frames, then the same colour chain as a plain render', async () => {
  const plain = ffmpegArguments(640, 360, { output: 'x.mp4', fps: 30 }),
    chain = plain[plain.indexOf('-vf') + 1],
    layers = [
      { input: 'talk.mp4', rect: { x: 400, y: 200, width: 224, height: 144 }, start: 1, duration: 2, in: 5, speed: 2 },
      { input: 'logo.png', rect: { x: 0, y: 0, width: 64, height: 64 }, fit: 'cover' },
    ],
    args = ffmpegArguments(640, 360, { output: 'x.mp4', fps: 30, layers, audio: { channels: [new Float32Array(10)], sampleRate: 48000 } }),
    graph = args[args.indexOf('-filter_complex') + 1];
  assert.ok(!args.includes('-vf'), 'the -vf moves into the graph');
  assert.deepEqual(args.slice(args.indexOf('pipe:3') + 1, args.indexOf('-filter_complex')), ['-ss', '5', '-t', '5', '-i', 'talk.mp4', '-i', 'logo.png']);
  assert.equal(
    graph,
    [
      "[2:v]setpts=(PTS-STARTPTS)/2+1/TB,fps=30:round=near,tpad=stop_mode=clone:stop_duration=2,trim=end=3,scale='if(gt(iw*sar/ih,224/144),224,max(1,round(144*iw*sar/ih)))':'if(gt(iw*sar/ih,224/144),max(1,round(224/(iw*sar/ih))),144)':flags=lanczos+accurate_rnd+full_chroma_int,format=rgba,pad=224:144:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1[l0]",
      "[0:v][l0]overlay=x=400:y=200:format=rgb:eof_action=pass:enable='between(t,0.983333,2.983333)'[b1]",
      "[3:v]setpts=(PTS-STARTPTS)/1+0/TB,fps=30:round=near,scale='if(gt(iw*sar/ih,64/64),max(1,round(64*iw*sar/ih)),64)':'if(gt(iw*sar/ih,64/64),64,max(1,round(64/(iw*sar/ih))))':flags=lanczos+accurate_rnd+full_chroma_int,format=rgba,crop=64:64,setsar=1[l1]",
      "[b1][l1]overlay=x=0:y=0:format=rgb:eof_action=pass:enable='gte(t,-0.016667)'[b2]",
      `[b2]${chain}[v]`,
    ].join(';'),
  );
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '[v]', '-map', '1:a:0']);
  for (const tag of ['-colorspace', '-color_trc', '-c:v', '-crf']) assert.equal(args[args.indexOf(tag) + 1], plain[plain.indexOf(tag) + 1], tag);
  // Arguments without a -vf: the graph ends in a pass-through.
  const custom = ffmpegArguments(64, 64, { output: 'x.mkv', args: ['-c:v', 'ffv1'], layers: [{ input: 'a.mp4', rect: { x: 0, y: 0, width: 8, height: 8 } }] });
  assert.match(custom[custom.indexOf('-filter_complex') + 1], /\[b1\]null\[v\]$/);
  assert.deepEqual(custom.slice(-4), ['-an', '-c:v', 'ffv1', 'x.mkv']);
  for (const bad of [{ x: -2, y: 0, width: 8, height: 8 }, { x: 60, y: 0, width: 8, height: 8 }, { x: 0, y: 0, width: 1.5, height: 8 }])
    assert.throws(() => ffmpegArguments(64, 64, { output: 'x.mp4', layers: [{ input: 'a.mp4', rect: bad }] }), RangeError);
  assert.throws(() => ffmpegArguments(64, 64, { output: 'x.mp4', layers: [{ input: 'a.mp4', rect: { x: 0, y: 0, width: 8, height: 8 }, speed: 0 }] }), RangeError);
  await assert.rejects(
    encodeWithFFmpeg([{ width: 4, height: 4, data: new Uint8Array(64) }], { output: 'x.mp4', ffmpeg: 'never-run', layers: [{ input: '', rect: { x: 0, y: 0, width: 2, height: 2 } }] }),
    TypeError,
  );
});
