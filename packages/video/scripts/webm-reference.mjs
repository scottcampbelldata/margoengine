// Regenerate independent packet metadata, never importing a demuxer implementation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { externalAssets, requireExternalAssets } from '../../../scripts/support/external-test-assets.mjs';
const tool = process.argv[2] ?? 'ffprobe',
  file = requireExternalAssets('video/flower.webm'),
  bytes = readFileSync(file);
const version = execFileSync(tool, ['-version'], { encoding: 'utf8', timeout: 20000 });
assert.match(version, /^ffprobe version (?:n)?8\.1\.2(?:[- ]|$)/, 'use FFprobe 8.1.2');
const probe = JSON.parse(
  execFileSync(
    tool,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,time_base:packet=pts,duration,size,pos,flags,data_hash',
      '-show_data_hash',
      'sha256',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 4 << 20 },
  ),
);
assert.equal(probe.streams[0].codec_name, 'vp8');
const packets = probe.packets.map((p) => {
  const position = Number(p.pos),
    size = Number(p.size),
    sha256 = p.data_hash.slice('SHA256:'.length),
    matches = [];
  // FFprobe's pos names the container block, not necessarily its compressed payload.
  // Locate the payload within the bounded EBML block header by its independent digest.
  for (let offset = position; offset < position + 16; offset++)
    if (
      createHash('sha256')
        .update(bytes.subarray(offset, offset + size))
        .digest('hex') === sha256
    )
      matches.push(offset);
  assert.equal(matches.length, 1, 'unique independent packet offset');
  return {
    pts: Number(p.pts),
    duration: Number(p.duration),
    offset: matches[0],
    size,
    key: p.flags.includes('K'),
    sha256,
  };
});
const reference = {
  source: externalAssets.find((a) => a.file === 'video/flower.webm'),
  tool: 'FFprobe 8.1.2, packet-byte offsets verified against each independent SHA-256',
  timeBase: probe.streams[0].time_base.split('/').map(Number),
  config: { codec: 'vp8' },
  packets,
};
writeFileSync(new URL('../test/webm-ffprobe.json', import.meta.url), JSON.stringify(reference, null, 2) + '\n');
console.log('Independent WebM packet oracle:', packets.length);
