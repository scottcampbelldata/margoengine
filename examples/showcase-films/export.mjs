import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { colourSidecar, toLimitedBt709 } from './video-range.mjs';

const [film, output, kind = 'master'] = process.argv.slice(2);
const profile = {
  'robot-cell': { name: 'the-robot-cell', gain: 6.5 },
  'last-tram': { name: 'last-tram', gain: 7.5 },
  'above-the-treeline': { name: 'above-the-treeline', gain: 13 },
  'the-kiln-shift': { name: 'the-kiln-shift', audioFilter: 'loudnorm=I=-26:TP=-3:LRA=9' },
  'the-solar-field': { name: 'the-solar-field', audioFilter: 'loudnorm=I=-17:TP=-1.1:LRA=8' },
  'the-scanned-workshop': { name: 'the-scanned-workshop', audioFilter: 'loudnorm=I=-19:TP=-1.2:LRA=8' },
  'city-to-street': { name: 'city-to-street', audioFilter: 'loudnorm=I=-17:TP=-1.1:LRA=8' },
  'the-observatory-dome': { name: 'the-observatory-dome', audioFilter: 'loudnorm=I=-18:TP=-1.1:LRA=8' },
  'inside-turbofan': { name: 'inside-a-turbofan', audioFilter: 'loudnorm=I=-20:TP=-2:LRA=9' },
  'inside-concert-hall': { name: 'inside-the-concert-hall', audioFilter: 'loudnorm=I=-20:TP=-2:LRA=10' },
  'inside-a-meteorite': { name: 'inside-a-meteorite', audioFilter: 'loudnorm=I=-18:TP=-1.2:LRA=8' },
  'horse-at-the-ridge': { name: 'horse-at-the-ridge', audioFilter: 'loudnorm=I=-18:TP=-1.2:LRA=8' },
  'the-projectionist': { name: 'the-projectionist', audioFilter: 'loudnorm=I=-18:TP=-1.2:LRA=8' },
  'opening-night': { name: 'opening-night', audioFilter: 'loudnorm=I=-18:TP=-1.2:LRA=8' },
  'the-village-that-builds-itself': {
    name: 'the-village-that-builds-itself',
    audioFilter: 'loudnorm=I=-18:TP=-1.2:LRA=8',
  },
  'lantern-courier': { name: 'lantern-courier', audioFilter: 'loudnorm=I=-17:TP=-1.2:LRA=8' },
  'the-voxel-night-shop': { name: 'the-voxel-night-shop', audioFilter: 'loudnorm=I=-19:TP=-1.2:LRA=8' },
  'the-paper-aviary': { name: 'the-paper-aviary', audioFilter: 'loudnorm=I=-18:TP=-1.2:LRA=8' },
}[film];
if (!profile || !output || !['master', 'phone'].includes(kind))
  throw Error('Pass the film, output folder, and master or phone.');
await mkdir(output, { recursive: true });
await mkdir('test-results', { recursive: true });

function command(tool, args, timeout = 240000) {
  const result = spawnSync(tool, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4_000_000 });
  if (result.status !== 0) throw result.error ?? Error(result.stderr.trim() || 'Command failed: ' + tool);
  return result.stdout;
}

const phone = kind === 'phone';
const master = join(output, profile.name + '-90s.mp4');
const path = join(output, profile.name + '-90s' + (phone ? '-phone' : '') + '.mp4');
const stream = 'test-results/showcase-' + film + '.h264';
// The capture's samples are in the encoder's range (full range from Chromium); convert them to the limited range the
// output is tagged with, or every level below 16 decodes as black (KB-FILM-RANGE1).
const source = phone
  ? ['-i', master, '-vf', 'scale=1280:720:flags=lanczos', '-c:a', 'copy']
  : [
      '-framerate',
      '24',
      '-i',
      stream,
      '-i',
      'test-results/showcase-' + film + '.wav',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-af',
      profile.audioFilter ?? 'volume=' + profile.gain + 'dB',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-vf',
      toLimitedBt709(JSON.parse(await readFile(colourSidecar(stream), 'utf8'))),
    ];
command('ffmpeg', [
  '-nostdin',
  '-y',
  '-v',
  'error',
  '-xerror',
  ...source,
  '-c:v',
  'libx264',
  '-preset',
  phone ? 'veryfast' : 'fast',
  '-crf',
  phone ? '23' : '16',
  '-threads',
  '8',
  '-pix_fmt',
  'yuv420p',
  '-profile:v',
  'high',
  '-g',
  phone ? '48' : '12',
  ...(phone ? ['-maxrate', '2800k', '-bufsize', '5600k'] : []),
  '-bf',
  '2',
  '-sc_threshold',
  '0',
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-color_range',
  'tv',
  '-movflags',
  '+faststart',
  path,
]);
const { streams, format } = JSON.parse(
  command('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_name,width,height,r_frame_rate,nb_frames,channels,sample_rate,duration:format=duration,size',
    '-of',
    'json',
    path,
  ]),
);
const video = streams.find((stream) => stream.codec_name === 'h264');
const audio = streams.find((stream) => stream.codec_name === 'aac');
const width = phone ? 1280 : 1920;
const height = phone ? 720 : 1080;
if (
  !video ||
  !audio ||
  Number(format.duration) !== 90 ||
  Number(video.duration) !== 90 ||
  Number(audio.duration) !== 90 ||
  Number(video.nb_frames) !== 2160 ||
  video.width !== width ||
  video.height !== height ||
  video.r_frame_rate !== '24/1' ||
  audio.channels !== 2 ||
  Number(audio.sample_rate) !== 48000
) {
  throw Error('Unexpected export format: ' + JSON.stringify({ streams, format }));
}
command('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], 120000);
console.log(
  JSON.stringify({
    path,
    width,
    height,
    seconds: Number(format.duration),
    frames: Number(video.nb_frames),
    bytes: Number(format.size),
  }),
);
