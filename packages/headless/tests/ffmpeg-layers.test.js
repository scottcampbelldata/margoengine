// KB-FILM-LAYERS2: how encodeWithFFmpeg reads its layer files (an untagged file of 720 lines or more is BT.709, below
// it BT.601, TV range; ITU-T H.273, ITU-R BT.709 and BT.601, JFIF), a source crop, a pad colour for 'contain', the step
// to the film's rate by nearest time, and the one-picture form a still is made with, without ffmpeg: a stand-in program
// reports each file's stream line as ffmpeg's `-i` report does and records the arguments it is given.
// scripts/test-real-ffmpeg-files.mjs runs the same through a real ffmpeg and checks the decoded colours.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeWithFFmpeg,
  ffmpegArguments,
  layersOverPicture,
  layersPictureArguments,
  probeVideo,
  resolveLayers,
} from '../dist/ffmpeg.js';

// ffmpeg's stream lines (`ffmpeg -i`) for the files the tests name.
const STREAMS = {
  'hd.mp4':
    'h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], 16 kb/s, 30 fps, 30 tbr, 15360 tbn (default)',
  'sd.mp4':
    'h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 640x360 [SAR 1:1 DAR 16:9], 11 kb/s, 30 fps, 30 tbr, 15360 tbn (default)',
  'tagged.webm':
    'vp9 (Profile 0), yuv420p(tv, bt709/unknown/unknown, progressive), 1280x720, SAR 1:1 DAR 16:9, 30 fps, 30 tbr, 1k tbn',
  'sd-tagged.mp4':
    'h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 640x360 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 15360 tbn',
  'full.mp4':
    'h264 (High) (avc1 / 0x31637661), yuv420p(pc, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 15360 tbn',
  'photo.jpg':
    'mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 1280x720 [SAR 1:1 DAR 16:9], 25 fps, 25 tbr, 25 tbn',
  'logo.png': 'png, rgba(pc, gbr/unknown/unknown), 64x64 [SAR 1:1 DAR 1:1], 25 fps, 25 tbr, 25 tbn',
  'frame.png': 'png, rgb24(pc, gbr/unknown/unknown), 320x192 [SAR 1:1 DAR 5:3], 25 fps, 25 tbr, 25 tbn',
};

// Stands in for ffmpeg: a probe (`-i <file>` last, no output) prints the file's stream line and exits 1 as ffmpeg does;
// anything else records its arguments, reads standard input to its end and writes its last argument.
const STAND_IN = `
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), streams = JSON.parse(process.env.MARGO_STREAMS);
appendFileSync(process.env.MARGO_ARGS_FILE, JSON.stringify(args) + '\\n');
if (args.at(-2) === '-i') {
  const line = streams[args.at(-1).split(/[\\\\/]/).at(-1)];
  console.error("Input #0, mov,mp4, from '" + args.at(-1) + "':\\n  Duration: 00:00:01.00, start: 0.000000\\n" +
    (line ? '  Stream #0:0[0x1](und): Video: ' + line + '\\n' : '') + 'At least one output file must be specified');
  process.exitCode = 1;
} else {
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => writeFileSync(args.at(-1), 'made'));
  process.stdin.on('error', () => writeFileSync(args.at(-1), 'made'));
}
`;

async function standIn() {
  const dir = await mkdtemp(join(tmpdir(), 'margo-layers-')),
    script = join(dir, 'stand-in.mjs'),
    record = join(dir, 'args.jsonl');
  await writeFile(script, STAND_IN);
  await writeFile(record, '');
  process.env.MARGO_ARGS_FILE = record;
  process.env.MARGO_STREAMS = JSON.stringify(STREAMS);
  return {
    dir,
    ffmpeg: [process.execPath, script],
    runs: async () =>
      (await readFile(record, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

const grey = (w, h) => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(128) });
const box = { x: 0, y: 0, width: 160, height: 90 };
const graphOf = (args) => args[args.indexOf('-filter_complex') + 1];
/** The scale of layer `i` in a graph. */
const scaleOf = (graph, i) =>
  graph
    .split(';')
    .find((p) => p.endsWith(`[l${i}]`))
    .match(/scale=.*?,format=rgba/)[0];

test('probeVideo reads the codec, pixel format, size and colour tags of ffmpeg report lines', async () => {
  const s = await standIn();
  try {
    assert.deepEqual(await probeVideo('hd.mp4', { ffmpeg: s.ffmpeg }), {
      codec: 'h264',
      pixelFormat: 'yuv420p',
      width: 1280,
      height: 720,
      rgb: false,
    });
    assert.deepEqual(await probeVideo('tagged.webm', { ffmpeg: s.ffmpeg }), {
      codec: 'vp9',
      pixelFormat: 'yuv420p',
      width: 1280,
      height: 720,
      rgb: false,
      matrix: 'bt709',
      range: 'tv',
    });
    assert.deepEqual(await probeVideo('sd-tagged.mp4', { ffmpeg: s.ffmpeg }), {
      codec: 'h264',
      pixelFormat: 'yuv420p',
      width: 640,
      height: 360,
      rgb: false,
      matrix: 'bt709',
      range: 'tv',
    });
    assert.deepEqual(await probeVideo('full.mp4', { ffmpeg: s.ffmpeg }), {
      codec: 'h264',
      pixelFormat: 'yuv420p',
      width: 1920,
      height: 1080,
      rgb: false,
      range: 'pc',
    });
    assert.equal((await probeVideo('photo.jpg', { ffmpeg: s.ffmpeg })).matrix, 'bt470bg');
    assert.deepEqual(await probeVideo('logo.png', { ffmpeg: s.ffmpeg }), {
      codec: 'png',
      pixelFormat: 'rgba',
      width: 64,
      height: 64,
      rgb: true,
      matrix: 'gbr',
      range: 'pc',
    });
    await assert.rejects(
      probeVideo('song.mp3', { ffmpeg: s.ffmpeg }),
      (e) => e.code === 'failed' && /no video stream/.test(e.message),
    );
    await assert.rejects(probeVideo('', { ffmpeg: s.ffmpeg }), TypeError);
    await assert.rejects(probeVideo('hd.mp4', { ffmpeg: 'never-run-ffmpeg' }), (e) => e.code === 'unsupported');
  } finally {
    await s.done();
  }
});

test('an untagged layer file is read as BT.709 at 720 lines or more and BT.601 below, TV range; tags and overrides win', async () => {
  const s = await standIn();
  try {
    const out = join(s.dir, 'out.mp4'),
      files = ['hd.mp4', 'sd.mp4', 'tagged.webm', 'sd-tagged.mp4', 'full.mp4', 'photo.jpg', 'logo.png'],
      layers = files.map((input) => ({ input, rect: box, duration: 1 }));
    layers.push({ input: 'hd.mp4', rect: box, matrix: 'bt601', range: 'pc' });
    await encodeWithFFmpeg([grey(320, 192)], { output: out, ffmpeg: s.ffmpeg, layers });
    const runs = await s.runs(),
      encode = runs.find((a) => a.includes('-filter_complex')),
      graph = graphOf(encode);
    assert.equal(runs.length, files.length + 1, 'each file is read once, then one encode');
    const read = (i) => scaleOf(graph, i).match(/:in_[a-z_]+=[a-z0-9]+/g) ?? [];
    assert.deepEqual(read(0), [':in_color_matrix=bt709', ':in_range=tv'], 'untagged 1280x720: BT.709, TV range');
    assert.deepEqual(read(1), [':in_color_matrix=bt601', ':in_range=tv'], 'untagged 640x360: BT.601, TV range');
    assert.deepEqual(read(2), [], 'tagged: ffmpeg reads its tags');
    assert.deepEqual(read(3), [], 'an SD file tagged BT.709 keeps its tag');
    assert.deepEqual(read(4), [':in_color_matrix=bt709'], 'a range tag alone keeps its range');
    assert.deepEqual(read(5), [], 'a JPEG reads its JFIF tags');
    assert.deepEqual(read(6), [], 'an RGB picture has no matrix');
    assert.deepEqual(
      read(7),
      [':in_color_matrix=bt601', ':in_range=pc'],
      'a layer matrix and range replace the default',
    );
    // Resolved layers keep everything else as given.
    const [resolved] = await resolveLayers([{ input: 'hd.mp4', rect: box, start: 2, fit: 'cover' }], {
      ffmpeg: s.ffmpeg,
    });
    assert.deepEqual(resolved, { input: 'hd.mp4', rect: box, start: 2, fit: 'cover', matrix: 'bt709', range: 'tv' });
    const [untaggedJpeg] = await resolveLayers([{ input: 'photo.jpg', rect: box }], {
      ffmpeg: [
        process.execPath,
        '-e',
        "console.error('  Stream #0:0: Video: mjpeg (Baseline), yuvj420p(progressive), 1920x1080, 25 fps'); process.exit(1)",
        '--',
      ],
    });
    assert.deepEqual(
      [untaggedJpeg.matrix, untaggedJpeg.range],
      ['bt601', 'pc'],
      'an untagged JPEG is JFIF: BT.601, full range',
    );
  } finally {
    await s.done();
  }
});

test('layers crop their file, pad a contain fit with a colour and step to the film rate by nearest time', async () => {
  const graph = graphOf(
      ffmpegArguments(320, 192, {
        output: 'x.mp4',
        fps: 24,
        layers: [
          { input: 'hd.mp4', rect: box, crop: [100, 50, 640, 360], pad: '#203040', matrix: 'bt709', range: 'tv' },
          { input: 'logo.png', rect: box, pad: '#ff0000cc', fit: 'contain' },
          { input: 'logo.png', rect: box, pad: '#0f0', fit: 'cover' },
        ],
      }),
    ),
    parts = graph.split(';');
  assert.equal(
    parts[0],
    "[1:v]crop=640:360:100:50,setpts=(PTS-STARTPTS)/1+0/TB,fps=24:round=near,scale='if(gt(iw*sar/ih,160/90),160,max(1,round(90*iw*sar/ih)))':'if(gt(iw*sar/ih,160/90),max(1,round(160/(iw*sar/ih))),90)':in_color_matrix=bt709:in_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=rgba,pad=160:90:(ow-iw)/2:(oh-ih)/2:color=0x203040ff,setsar=1[l0]",
  );
  // KB-HEADLESS-LAYER-SAR: contain and cover size the picture by its display aspect, iw * sar / ih, so a clip with
  // non-square samples keeps its shape; fill stretches to the box as before.
  assert.match(parts[4], /scale='if\(gt\(iw\*sar\/ih,160\/90\),max\(1,round\(90\*iw\*sar\/ih\)\),160\)'/);
  assert.match(
    graphOf(
      ffmpegArguments(64, 64, {
        output: 'x.mp4',
        layers: [{ input: 'a.mp4', rect: { x: 0, y: 0, width: 8, height: 8 }, fit: 'fill' }],
      }),
    ),
    /scale=8:8:flags/,
  );
  assert.match(parts[2], /pad=160:90:\(ow-iw\)\/2:\(oh-ih\)\/2:color=0xff0000cc,/);
  assert.doesNotMatch(parts[4], /pad=/, 'cover has no margins to pad');
  assert.match(
    ffmpegArguments(64, 64, {
      output: 'x.mp4',
      layers: [{ input: 'a.mp4', rect: { x: 0, y: 0, width: 8, height: 8 } }],
    }).join(' '),
    /color=0x00000000,/,
    'default pad: clear',
  );
  for (const crop of [[1, 0, 8, 8], [0, 0, 7, 8], [0, 0, 0, 8], [0, 0, 8], 'all'])
    assert.throws(
      () =>
        ffmpegArguments(64, 64, {
          output: 'x.mp4',
          layers: [{ input: 'a.mp4', rect: { x: 0, y: 0, width: 8, height: 8 }, crop }],
        }),
      RangeError,
      String(crop),
    );
  for (const bad of [{ pad: 'red' }, { pad: '#12345' }, { matrix: 'bt470' }, { range: 'full' }])
    assert.throws(
      () =>
        ffmpegArguments(64, 64, {
          output: 'x.mp4',
          layers: [{ input: 'a.mp4', rect: { x: 0, y: 0, width: 8, height: 8 }, ...bad }],
        }),
      RangeError,
      JSON.stringify(bad),
    );
  const s = await standIn();
  try {
    await assert.rejects(
      resolveLayers([{ input: 'sd.mp4', rect: box, crop: [0, 0, 640, 362] }], { ffmpeg: s.ffmpeg }),
      (e) => e instanceof RangeError && /640x360/.test(e.message),
    );
  } finally {
    await s.done();
  }
});

test('layersOverPicture lays the layers over one picture as frame k of the encode, through the same graph', async () => {
  const layers = [
      {
        input: 'hd.mp4',
        rect: { x: 8, y: 8, width: 160, height: 90 },
        start: 1,
        duration: 2,
        crop: [0, 0, 640, 360],
        matrix: 'bt709',
        range: 'tv',
      },
    ],
    still = layersPictureArguments(320, 192, { picture: 'frame.png', output: 'still.png', fps: 30, frame: 45, layers }),
    encode = ffmpegArguments(320, 192, { output: 'x.mkv', fps: 30, args: ['-c:v', 'ffv1'], layers });
  assert.deepEqual(still.slice(0, 5), ['-y', '-framerate', '30', '-i', 'frame.png']);
  assert.deepEqual(still.slice(-7), ['-map', '[v]', '-frames:v', '1', '-update', '1', 'still.png']);
  const stillGraph = graphOf(still).split(';'),
    encodeGraph = graphOf(encode).split(';');
  assert.equal(
    stillGraph[0],
    '[0:v]trim=end_frame=1,setpts=PTS-STARTPTS+45,format=rgb24[p]',
    'the picture is frame 45 at the film time base',
  );
  assert.equal(stillGraph[1], encodeGraph[0], 'the layer is read exactly as the encode reads it');
  assert.equal(stillGraph[2], encodeGraph[1].replace('[0:v]', '[p]'));
  assert.equal(stillGraph[3], '[b1]format=rgb24[v]');
  assert.throws(
    () => layersPictureArguments(320, 192, { picture: 'frame.png', output: 'still.png', frame: 1.5, layers }),
    RangeError,
  );
  const s = await standIn();
  try {
    const output = join(s.dir, 'still.png');
    await layersOverPicture('frame.png', output, {
      fps: 30,
      frame: 12,
      layers: [{ input: 'sd.mp4', rect: box }],
      ffmpeg: s.ffmpeg,
    });
    const runs = await s.runs(),
      made = runs.at(-1);
    assert.deepEqual(
      runs.slice(0, 2).map((a) => a.at(-1)),
      ['frame.png', 'sd.mp4'],
      'the picture and the layer file are read first',
    );
    assert.match(
      graphOf(made),
      /in_color_matrix=bt601:in_range=tv/,
      'the still reads an untagged file as the encode does',
    );
    assert.match(graphOf(made), /setpts=PTS-STARTPTS\+12,/);
    assert.equal(await readFile(output, 'utf8'), 'made');
  } finally {
    await s.done();
  }
});
