// Independent sample-table evidence from FFprobe output only, never its implementation.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { externalAssets, requireExternalAssets } from '../../../scripts/support/external-test-assets.mjs';

const tool = process.argv[2] ?? 'ffprobe';
const version = execFileSync(tool, ['-version'], { encoding: 'utf8', timeout: 20_000 });
if (!/^ffprobe version (?:n)?8\.1\.2(?:[- ]|$)/.test(version))
  throw new Error('This oracle records FFprobe 8.1.2; pass that executable as the first argument');
const file = requireExternalAssets('video/flower.mp4');
const asset = externalAssets.find(({ file }) => file === 'video/flower.mp4');
const probe = (ignoreEdit) =>
  JSON.parse(
    execFileSync(
      tool,
      [
        '-v',
        'error',
        ...(ignoreEdit ? ['-ignore_editlist', '1'] : []),
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height,time_base,extradata,has_b_frames,duration:packet=pts,dts,duration,size,pos,flags',
        '-show_data',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8', timeout: 20_000, maxBuffer: 4 << 20 },
    ),
  );
const raw = probe(true),
  edited = probe(false),
  stream = raw.streams[0];
const hex = stream.extradata
  .split('\n')
  .filter((line) => line.includes(':'))
  .map((line) =>
    line
      .slice(line.indexOf(':') + 1)
      .trim()
      .split(/ {2,}/)[0]
      .replaceAll(' ', ''),
  )
  .join('');
const description = Array.from(Buffer.from(hex, 'hex'));
if (stream.codec_name !== 'h264' || description.length < 8 || stream.has_b_frames !== 2)
  throw new Error('Expected the original MDN AVC B-frame clip, with avcC metadata');
const [num, den] = stream.time_base.split('/').map(Number);
const us = (ticks) => Math.round((Number(ticks) * num * 1000000) / den);
const oracle = {
  source: { url: asset.url, licence: 'CC0-1.0 (MDN cc0-videos)', bytes: asset.size, sha256: asset.sha256 },
  tool: 'FFprobe 8.1.2 (pinned external Gyan FFmpeg GPL build; metadata output only)',
  timeBase: [num, den],
  frameCount: raw.packets.length,
  duration: Number(edited.streams[0].duration),
  hasBFrames: stream.has_b_frames,
  config: { codec: 'avc1.' + Buffer.from(description.slice(1, 4)).toString('hex'), description },
  packets: raw.packets.map((packet) => ({
    pts: Number(packet.pts),
    dts: Number(packet.dts),
    duration: Number(packet.duration),
    offset: Number(packet.pos),
    size: Number(packet.size),
    key: packet.flags.includes('K'),
  })),
  times: edited.packets.map((packet) => us(packet.pts)).sort((a, b) => a - b),
};
writeFileSync(new URL('../test/flower-ffprobe.json', import.meta.url), JSON.stringify(oracle, null, 2) + '\n');
console.log(`FFprobe reference: ${oracle.frameCount} real frames, ${oracle.hasBFrames} B-frame reorder depth`);
