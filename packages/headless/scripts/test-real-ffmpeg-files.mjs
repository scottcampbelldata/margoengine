// The ffmpeg-files tools and encodeWithFFmpeg's layers through a real ffmpeg: a recording with closed one-second GOPs
// and B-frames is read box by box (plain and fragmented) and checked against ffprobe's packet list; a span of it is
// stream copied and decodes to exactly the recording's frames, tagged as an engine chunk; an engine chunk and the
// copied span join by stream copy (avc3, since their parameter sets differ) and decode to both in order; sound is laid
// under a chunk with its picture packets unchanged; a clip is laid over rendered frames only inside its window; and
// every hardware encoder this ffmpeg lists writes the engine's tags. Needs ffmpeg and ffprobe: FFMPEG and FFPROBE name
// them (default: on the path). Run: `npm run test:real-ffmpeg --workspace @margoengine/headless`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWithFFmpeg, layersOverPicture } from '../dist/ffmpeg.js';
import { addSound, checkSpan, copySpan, encoderArguments, joinVideos, readVideoTrack } from '../dist/ffmpeg-files.js';

const program = process.env.FFMPEG ?? 'ffmpeg',
  probe = process.env.FFPROBE ?? 'ffprobe',
  width = 320,
  height = 192;
const run = (tool, args) => {
  const result = spawnSync(tool, args, { maxBuffer: 1 << 28, timeout: 120_000 });
  assert.equal(result.error, undefined, `${tool}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${tool} ${args.join(' ')}: ${result.stderr}`);
  return result;
};
/** Every frame of a file as RGB24, one buffer per frame. */
const decode = (file) => {
  const out = run(program, ['-v', 'error', '-i', file, '-vf', 'scale=in_color_matrix=bt709:in_range=tv', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout,
    size = width * height * 3;
  return Array.from({ length: out.length / size }, (_, i) => out.subarray(i * size, (i + 1) * size));
};
const md5 = (b) => createHash('md5').update(b).digest('hex');
const tags = (file) => run(program, ['-hide_banner', '-i', file]).stderr.toString();
// ffmpeg -i with no output exits 1, so read its stream line without the status check.
const info = (file) => spawnSync(program, ['-hide_banner', '-i', file], { timeout: 60_000 }).stderr.toString();

const folder = await mkdtemp(join(tmpdir(), 'margo-real-ffmpeg-files-'));
try {
  // A 4 s recording at 30 fps: a key frame every second, closed GOPs, two B-frames.
  const recording = join(folder, 'recording.mp4'),
    fragmented = join(folder, 'recording-frag.mp4'),
    x264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '2', '-x264-params', 'keyint=30:min-keyint=30:scenecut=0:open-gop=0'];
  run(program, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30`, '-t', '4', ...x264, '-colorspace', 'bt709', '-color_range', 'tv', recording]);
  run(program, ['-v', 'error', '-y', '-i', recording, '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', fragmented]);
  for (const file of [recording, fragmented]) {
    // Each file against ffprobe's own list: the fragmented copy has no edit list, so its times start at the first
    // frame's composition offset (2 frames with two B-frames), as ffprobe shows too.
    const packets = JSON.parse(run(probe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'json', file]).stdout).packets,
      track = await readVideoTrack(file);
    assert.equal(track.codec, 'avc1');
    assert.equal(track.samples.length, 120);
    track.samples.forEach((s, i) => {
      assert.ok(Math.abs(s.time - Number(packets[i].pts_time)) < 1e-6, `${file} sample ${i}: ${s.time} vs ${packets[i].pts_time}`);
      assert.equal(s.key, packets[i].flags.startsWith('K'), `${file} sample ${i} key`);
    });
    assert.deepEqual(track.samples.filter((s) => s.key).map((s) => Math.floor(s.time)), [0, 1, 2, 3]);
  }
  console.log('PASS readVideoTrack: 120 samples, times and key flags as ffprobe lists them, plain and fragmented');

  // A span from the key frame at 1 s: refused off a key frame, else copied and decoded to the same frames.
  assert.match((await checkSpan(recording, { start: 1.5, frames: 30, fps: 30 })).reason, /not on a key frame/);
  assert.match((await checkSpan(recording, { start: 1, frames: 20, fps: 30 })).reason, /next key frame/);
  const copied = join(folder, 'copied.mp4'),
    source = decode(recording);
  await copySpan(recording, copied, { start: 1, frames: 30, fps: 30, ffmpeg: program });
  const span = decode(copied);
  assert.equal(span.length, 30);
  span.forEach((f, i) => assert.equal(md5(f), md5(source[30 + i]), `copied frame ${i}`));
  assert.match(info(copied), /yuv420p\(tv, bt709\/bt709\/iec61966-2-1/, info(copied));
  const copiedTrack = await readVideoTrack(copied);
  assert.equal(copiedTrack.timescale, 15360);
  copiedTrack.samples.forEach((s) => assert.ok(Math.abs(s.time * 30 - Math.round(s.time * 30)) < 1e-6, `${s.time} on a frame step`));
  console.log('PASS copySpan: 30 frames from the key frame at 1 s decode as the recording\'s own, tagged BT.709 and sRGB, timescale 15360');

  // An engine chunk with each encoder, then a join with the copied span.
  const frame = (n) => {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set([40 + n * 4, 90, 160, 255], i * 4);
    return { width, height, data };
  };
  const chunk = join(folder, 'chunk.mp4');
  await encodeWithFFmpeg(Array.from({ length: 30 }, (_, n) => frame(n)), { output: chunk, fps: 30, ffmpeg: program, args: encoderArguments('x264', { preset: 'veryfast' }) });
  assert.match(info(chunk), /yuv420p\(tv, bt709\/bt709\/iec61966-2-1/, info(chunk));
  const listed = run(program, ['-hide_banner', '-encoders']).stdout.toString();
  for (const [encoder, codec] of [['nvenc', 'h264_nvenc'], ['amf', 'h264_amf'], ['qsv', 'h264_qsv']]) {
    if (!new RegExp(`\\s${codec}\\s`).test(listed)) {
      console.log(`NOT LISTED ${codec}: this ffmpeg build has no such encoder`);
      continue;
    }
    const output = join(folder, `${encoder}.mp4`);
    try {
      await encodeWithFFmpeg(Array.from({ length: 30 }, (_, n) => frame(n)), { output, fps: 30, ffmpeg: program, args: encoderArguments(encoder) });
    } catch (error) {
      console.log(`NO DEVICE ${codec}: ${String(error.cause ?? error.message).trim().split('\n').at(-1)}`);
      continue;
    }
    assert.match(info(output), /h264.*yuv420p\(tv, bt709\/bt709\/iec61966-2-1/, info(output));
    assert.equal(decode(output).length, 30);
    console.log(`PASS ${codec}: 30 frames tagged BT.709, sRGB transfer, TV range`);
  }
  const joined = join(folder, 'joined.mp4');
  assert.equal(await joinVideos([chunk, copied], joined, { ffmpeg: program }), 'avc3');
  const both = decode(joined),
    parts = [...decode(chunk), ...span];
  assert.equal(both.length, 60);
  both.forEach((f, i) => assert.equal(md5(f), md5(parts[i]), `joined frame ${i}`));
  assert.equal((await readVideoTrack(joined)).codec, 'avc3');
  assert.equal(await joinVideos([chunk, chunk], join(folder, 'twice.mp4'), { ffmpeg: program }), 'avc1');
  assert.equal(decode(join(folder, 'twice.mp4')).length, 60);
  console.log('PASS joinVideos: an engine chunk and a copied span join as avc3 and decode to both; one chunk twice joins as avc1');

  // Sound under the chunk: the picture packets stay byte for byte.
  const wav = join(folder, 'tone.wav'),
    withSound = join(folder, 'sound.mp4');
  run(program, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', wav]);
  await addSound(chunk, wav, withSound, { ffmpeg: program });
  const picture = (file) => run(program, ['-v', 'error', '-i', file, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-']).stdout.toString();
  assert.equal(picture(withSound), picture(chunk));
  assert.match(info(withSound), /Audio: aac.*48000 Hz/, info(withSound));
  console.log('PASS addSound: AAC under the chunk, picture packets unchanged');

  // A red clip laid over grey frames in the bottom-right quarter from 0.5 s for 0.5 s.
  const red = join(folder, 'red.mp4'),
    layered = join(folder, 'layered.mp4');
  run(program, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x96:r=30', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red]);
  const grey = { width, height, data: new Uint8Array(width * height * 4).fill(128) };
  await encodeWithFFmpeg(Array.from({ length: 45 }, () => grey), {
    output: layered,
    fps: 30,
    ffmpeg: program,
    layers: [{ input: red, rect: { x: 160, y: 96, width: 160, height: 96 }, start: 0.5, duration: 0.5 }],
  });
  assert.match(info(layered), /yuv420p\(tv, bt709\/bt709\/iec61966-2-1/, info(layered));
  const shown = decode(layered),
    at = (f, x, y) => [...f.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
  assert.equal(shown.length, 45);
  shown.forEach((f, n) => {
    const inside = n >= 15 && n < 30,
      box = at(f, 240, 144),
      outside = at(f, 80, 48);
    assert.ok(outside.every((c) => Math.abs(c - 128) <= 3), `frame ${n} outside the box: ${outside}`);
    if (inside) assert.ok(box[0] > 230 && box[1] < 25 && box[2] < 25, `frame ${n} box should be red: ${box}`);
    else assert.ok(box.every((c) => Math.abs(c - 128) <= 3), `frame ${n} box should be grey: ${box}`);
  });
  console.log('PASS layers: the clip shows in its box for frames 15 to 29 only, the rest grey, tagged as a plain render');
  // A still picture held for its window, after the frames end too: the video keeps the rendered frames' length.
  const dot = join(folder, 'dot.png'),
    still = join(folder, 'still.mp4');
  run(program, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', dot]);
  await encodeWithFFmpeg(Array.from({ length: 30 }, () => grey), {
    output: still,
    fps: 30,
    ffmpeg: program,
    layers: [{ input: dot, rect: { x: 0, y: 0, width: 32, height: 32 }, start: 0.5, duration: 2 }],
  });
  const held = decode(still);
  assert.equal(held.length, 30, 'a layer past the end does not lengthen the video');
  held.forEach((f, n) => assert.equal(at(f, 16, 16)[0] > 200, n >= 15, `frame ${n}`));
  console.log('PASS layers: a still picture is held through its window, and the video ends with the rendered frames');

  // KB-FILM-LAYERS2: untagged clips are read as BT.709 at 720 lines or more and BT.601 below. Each clip is one colour
  // written with its matrix and then stripped of every tag; its exact colour is worked out from its own YCbCr samples.
  const yuv = (file, w, h) => {
      const b = run(program, ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']).stdout;
      return [b[(h >> 1) * w + (w >> 1)], b[w * h + (h >> 2) * (w >> 1) + (w >> 2)], b[w * h + (w * h) / 4 + (h >> 2) * (w >> 1) + (w >> 2)]];
    },
    // ITU-R BT.709-6 (Kr 0.2126, Kb 0.0722) and BT.601-7 (Kr 0.299, Kb 0.114), TV range: Y' 16 to 235, Cb Cr 16 to 240.
    exact = ([Y, U, V], kr, kb) => {
      const y = (Y - 16) / 219, cb = (U - 128) / 224, cr = (V - 128) / 224, r = y + 2 * (1 - kr) * cr, b = y + 2 * (1 - kb) * cb;
      return [r, (y - kr * r - kb * b) / (1 - kr - kb), b].map((v) => Math.round(v * 255));
    },
    lossless = ['-c:v', 'ffv1'],
    frames = (file) => {
      const out = run(program, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout,
        size = width * height * 3;
      return Array.from({ length: out.length / size }, (_, i) => out.subarray(i * size, (i + 1) * size));
    };
  for (const [name, w, h, matrix, kr, kb] of [
    ['hd', 1280, 720, 'bt709', 0.2126, 0.0722],
    ['sd', 640, 360, 'bt601', 0.299, 0.114],
  ]) {
    const clip = join(folder, `${name}.mp4`),
      out = join(folder, `${name}-layer.mkv`);
    run(program, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x3080e0:s=${w}x${h}:r=30`, '-t', '1',
      '-vf', `scale=out_color_matrix=${matrix}:out_range=tv,format=yuv420p,setparams=colorspace=unknown:color_primaries=unknown:color_trc=unknown:range=unknown`,
      '-c:v', 'libx264', '-crf', '1', clip]);
    assert.match(info(clip), /yuv420p\(progressive\)/, 'the clip carries no colour tags');
    await encodeWithFFmpeg([grey, grey], { output: out, fps: 30, ffmpeg: program, args: lossless, layers: [{ input: clip, rect: { x: 0, y: 0, width: 160, height: 90 } }] });
    const got = at(frames(out)[0], 80, 45),
      want = exact(yuv(clip, w, h), kr, kb);
    assert.ok(got.every((c, i) => Math.abs(c - want[i]) <= 1), `${name}: ${got} read, ${want} in ${matrix}`);
    console.log(`PASS layers: an untagged ${w}x${h} clip is read as ${matrix}: ${got} against ${want}`);
  }

  // A 24 fps clip whose frame n has luma 16 + 8n, cropped, on a 30 fps film: each clip frame starts at the film frame
  // nearest its own time, round(n * 30 / 24), so film frame k shows the last clip frame started by then; the contain
  // margins take the pad colour.
  const count = join(folder, 'count.mp4'),
    stepped = join(folder, 'stepped.mkv');
  run(program, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'nullsrc=s=96x64:r=24', '-t', '1', '-vf',
    "geq=lum='if(lt(X,48),16+8*N,235)':cb=128:cr=128,format=yuv420p,setparams=colorspace=bt709:range=tv", '-c:v', 'libx264', '-qp', '0', count]);
  await encodeWithFFmpeg(Array.from({ length: 20 }, () => grey), {
    output: stepped, fps: 30, ffmpeg: program, args: lossless,
    layers: [{ input: count, rect: { x: 0, y: 0, width: 64, height: 32 }, crop: [0, 0, 48, 64], pad: '#ff0000' }],
  });
  const steps = frames(stepped);
  steps.forEach((f, k) => {
    let n = 0;
    while (Math.round(((n + 1) * 30) / 24) <= k) n++;
    const level = Math.round(((8 * n) / 219) * 255);
    assert.ok(Math.abs(at(f, 32, 16)[1] - level) <= 1, `film frame ${k}: ${at(f, 32, 16)} for clip frame ${n} (${level})`);
    assert.deepEqual(at(f, 2, 16), [255, 0, 0], `film frame ${k}: the contain margin is the pad colour`);
  });
  console.log('PASS layers: a 24 fps clip steps to 30 fps by nearest time, cropped, with a padded margin');

  // KB-HEADLESS-LAYER-SAR: contain and cover read the clip's sample aspect ratio. A white 720x480 clip with 32:27
  // samples is 16:9 as shown and fills a 160x90 box; a square-pixel 640x480 clip (4:3) leaves 20-pixel pad margins.
  const anamorphic = join(folder, 'sar.mp4'),
    square = join(folder, 'square.mp4');
  run(program, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=720x480:d=1:r=30', '-vf', 'setsar=32/27', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', anamorphic]);
  run(program, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=640x480:d=1:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', square]);
  assert.match(info(anamorphic), /SAR 32:27/, info(anamorphic));
  for (const [clip, fit, margin] of [[anamorphic, 'contain', 0], [anamorphic, 'cover', 0], [square, 'contain', 20]]) {
    const out = join(folder, `sar-${fit}-${margin}.mkv`);
    await encodeWithFFmpeg([grey], { output: out, fps: 30, ffmpeg: program, args: lossless, layers: [{ input: clip, rect: { x: 0, y: 0, width: 160, height: 90 }, fit, pad: '#ff0000' }] });
    const f = frames(out)[0];
    for (const x of [1, 10, 19, 140, 149, 158]) {
      const edge = x < margin || x >= 160 - margin;
      assert.deepEqual(at(f, x, 45).map((c) => (c > 200 ? 1 : 0)), edge ? [1, 0, 0] : [1, 1, 1], `${fit} ${margin} x=${x}: ${at(f, x, 45)}`);
    }
  }
  console.log('PASS layers: a 32:27 clip fills its 16:9 box under contain and cover; a square 4:3 clip keeps its margins');

  // The still of frame k is the encode's frame k, pixel for pixel (both lossless RGB).
  const frameFile = join(folder, 'frame.png'),
    stillOut = join(folder, 'still.png'),
    layered30 = join(folder, 'still-encode.mkv'),
    stillLayers = [
      { input: join(folder, 'hd.mp4'), rect: { x: 10, y: 20, width: 128, height: 128 }, start: 0.2, duration: 0.5, pad: '#203040c0' },
      { input: count, rect: { x: 150, y: 40, width: 100, height: 100 }, start: 0.1, speed: 1.5, crop: [2, 4, 40, 50], fit: 'cover' },
    ];
  run(program, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}`, '-frames:v', '1', frameFile]);
  const base = { width, height, data: new Uint8Array(width * height * 4) };
  frames(frameFile)[0].forEach((v, i) => (base.data[Math.floor(i / 3) * 4 + (i % 3)] = v));
  for (let i = 3; i < base.data.length; i += 4) base.data[i] = 255;
  await encodeWithFFmpeg(Array.from({ length: 24 }, () => base), { output: layered30, fps: 30, ffmpeg: program, args: lossless, layers: stillLayers });
  const encoded = frames(layered30);
  for (const k of [0, 7, 13, 20]) {
    await layersOverPicture(frameFile, stillOut, { fps: 30, frame: k, layers: stillLayers, ffmpeg: program });
    assert.equal(md5(frames(stillOut)[0]), md5(encoded[k]), `the still of frame ${k} is the encode's frame ${k}`);
  }
  console.log('PASS layersOverPicture: the stills of frames 0, 7, 13 and 20 equal the encode, pixel for pixel');
  console.log(run(program, ['-version']).stdout.toString().split('\n')[0]);
} finally {
  await rm(folder, { recursive: true, force: true });
}
