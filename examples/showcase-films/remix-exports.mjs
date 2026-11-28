import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [existing, output, ...selection] = process.argv.slice(2);
if (!existing || !output) throw new Error('Pass the source and output folders, then any film IDs to export.');
if (existing === output) throw new Error('Choose a separate folder for the revised exports.');
await mkdir(output, { recursive: true });

const profiles = [
  {
    id: 'first-wake',
    duration: 97,
    level: -20,
    picture: ['First Wake - Continuous Wake - 97s.mp4', 'First Wake - Continuous Wake - Phone.mp4'],
  },
  {
    id: 'glass-bench',
    level: null,
    picture: ['The Glass Bench - Outro - 90s.mp4', 'The Glass Bench - Outro - Phone.mp4'],
  },
  { id: 'robot-cell', file: 'the-robot-cell', level: -19 },
  { id: 'last-tram', folder: 'last-tram-seat-refinement', level: -19 },
  { id: 'above-the-treeline', folder: 'above-the-treeline-grounded', level: -21 },
  { id: 'the-kiln-shift', level: -21, peak: -3.5 },
  { id: 'inside-turbofan', file: 'inside-a-turbofan', folder: 'inside-a-turbofan', level: -20 },
  { id: 'inside-concert-hall', file: 'inside-the-concert-hall', folder: 'inside-the-concert-hall', level: -19 },
  { id: 'the-solar-field', folder: 'showcase-8-11', level: -20 },
  { id: 'the-scanned-workshop', folder: 'showcase-8-11', level: -21 },
  { id: 'city-to-street', folder: 'showcase-8-11', level: -17 },
  { id: 'the-observatory-dome', folder: 'showcase-8-11', level: -20 },
];

for (const id of selection) if (!profiles.some((profile) => profile.id === id)) throw new Error('Unknown film ' + id);

function run(tool, args, timeout = 90_000) {
  const result = spawnSync(tool, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 4_000_000 });
  if (result.status !== 0) throw result.error ?? new Error(result.stderr);
  return result.stdout.trim();
}

function pictureChecksum(path) {
  return run('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-']);
}

for (const profile of profiles) {
  const { id, duration = 90, level, file = id, folder = '', picture, peak = -2 } = profile;
  if (selection.length && !selection.includes(id)) continue;
  const stamp = duration + 's';
  const audio = 'test-results/showcase-' + id + '.wav';
  const newSound = 'test-results/showcase-' + id + '-revised.m4a';
  const filter =
    level === null
      ? 'volume=3dB,alimiter=limit=0.82:attack=2:release=70:level=0:latency=1'
      : `loudnorm=I=${level}:TP=${peak}:LRA=10`;
  run('ffmpeg', [
    '-nostdin',
    '-y',
    '-v',
    'error',
    '-xerror',
    '-i',
    audio,
    '-af',
    filter,
    '-t',
    String(duration),
    '-c:a',
    'aac',
    '-b:a',
    '224k',
    '-ar',
    '48000',
    newSound,
  ]);
  for (const [index, suffix] of ['', '-phone'].entries()) {
    const filename = `${file}-${stamp}${suffix}.mp4`;
    const source = join(existing, folder, picture?.[index] ?? filename);
    const dest = join(output, filename);
    run('ffmpeg', [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-xerror',
      '-i',
      source,
      '-i',
      newSound,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      dest,
    ]);
    assert.equal(pictureChecksum(dest), pictureChecksum(source), `${id} picture stream changed`);
    const probe = JSON.parse(
      run('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,duration,nb_frames,channels:format=duration,size',
        '-of',
        'json',
        dest,
      ]),
    );
    assert.equal(Number(probe.format.duration), duration);
    const [video, sound] = probe.streams;
    assert.equal(video.codec_name, 'h264');
    assert.equal(Number(video.nb_frames), duration * 24);
    assert.equal(sound.codec_name, 'aac');
    assert.equal(sound.channels, 2);
    assert.equal(Number(sound.duration), duration);
    run('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', dest, '-f', 'null', '-']);
    console.log(JSON.stringify({ path: dest, seconds: duration, bytes: Number(probe.format.size) }));
  }
}
