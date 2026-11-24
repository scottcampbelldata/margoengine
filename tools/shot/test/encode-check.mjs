// `npm run test:shot-encode` (needs ffmpeg: MARGO_FFMPEG, or ffmpeg on the PATH; no GPU): the master encode of
// tools/shot/encode.mjs on a made-up shot folder of 70 frames at 1080 x 1920 and 60 fps, a slow night gradient
// sprinkled with single-pixel sparks that move every frame. Every master check must pass (stream, BT.709 tags in the
// bitstream and the colr box, moov first, 70 frames exactly, the GOP read back with ffprobe (a keyframe every 30 frames, at most 2 B-frames in a row, x264 bframes=2), the decode-back colour chart under a mean
// CIEDE2000 of 1), the frames must decode back close to their sources, and the sparks must be flagged by the platform
// proxy check: they do not survive a re-encode at 3 Mbps. An ffmpeg that is missing fails the check; it is never skipped.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encodePNG } from '@margoengine/headless';
import { encodeShot } from '../encode.mjs';

const root = resolve(import.meta.dirname, '../../..'),
  day = join(root, 'test-results', 'shots', 'encode-check'),
  frames = join(day, 'encode-test'),
  [width, height] = [1080, 1920],
  count = 70;
rmSync(day, { recursive: true, force: true });
mkdirSync(join(frames, 'frames'), { recursive: true });
let state = 7;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const files = [];
for (let i = 0; i < count; i++) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sky = 8 + Math.round((y / height) * 40);
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      data[p] = sky >> 1;
      data[p + 1] = sky;
      data[p + 2] = Math.min(255, sky * 2);
      data[p + 3] = 255;
    }
  }
  for (let k = 0; k < 6000; k++) {
    const p = (Math.floor(random() * height) * width + Math.floor(random() * width)) * 4;
    data[p] = data[p + 1] = data[p + 2] = 255;
  }
  const file = `frames/frame_${String(i).padStart(4, '0')}.png`;
  writeFileSync(join(frames, file), await encodePNG({ width, height, data }));
  files.push({ index: i, time: i / 60, file, sha256: '' });
}
writeFileSync(
  join(frames, 'manifest.json'),
  JSON.stringify({
    format: 'margo-shot-frames',
    version: 1,
    id: 'encode-test',
    size: [width, height],
    fps: 60,
    seconds: count / 60,
    frames: count,
    determinism: { runs: 2, identical: true },
    probes: { start: { frame: 0, file: files[0].file } },
    output: { master: 'encode-test.mp4', audio: false },
    files,
  }),
);
const report = await encodeShot(frames);
for (const [name, check] of Object.entries(report.checks)) assert.ok(check.pass, `${name}: ${JSON.stringify(check)}`);
assert.equal(report.pass, true);
assert.ok(existsSync(join(day, 'encode-test.mp4')), 'the master is beside the frames folder, named by the manifest');
assert.equal(report.checks.frames.frames, count);
assert.equal(report.checks.frames.seconds, count / 60);
assert.deepEqual(report.checks.gop.firstKeyframes, [0, 30, 60], 'YouTube: a closed GOP of fps / 2');
assert.equal(report.checks.gop.x264.bframes, 2);
assert.ok(report.checks.gop.longestBRun <= 2 && report.checks.gop.bFrames > 0);
for (const { index, mean } of report.frameDeltaE) assert.ok(mean < 1, `frame ${index} decodes back at a mean CIEDE2000 of ${mean}`);
assert.ok(report.proxyFlags.some((flag) => flag.endsWith('at 3 Mbps')), `single-pixel sparks were not flagged at 3 Mbps: ${JSON.stringify(report.proxy)}`);
console.log(`ok: master ${report.bitrateMbps} Mbps, chart mean dE ${report.checks.chart.meanDeltaE}, ${report.proxyFlags.length} flags (${report.proxyFlags[0]})`);
console.log('shot encode check passed');

// T7 in the look family: the same shot naming `animatedFeature` is held to the family's floor of 0.6 and fails its master
// with a detailKept check, where the natural look above only flagged the sparks.
assert.equal(report.checks.detailKept, undefined, 'a natural shot only flags: no detailKept check');
{
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(join(frames, 'manifest.json'), 'utf8'));
  writeFileSync(join(frames, 'manifest.json'), JSON.stringify({ ...manifest, header: { lookFamily: 'animatedFeature' } }));
  const family = await encodeShot(frames);
  assert.equal(family.checks.detailKept.floor, 0.6);
  assert.equal(family.checks.detailKept.family, 'animatedFeature');
  assert.equal(family.checks.detailKept.pass, false, 'the sparks keep under 0.6 of their detail at 3 Mbps');
  assert.equal(family.pass, false);
  console.log(`ok: animatedFeature holds the floor of ${family.checks.detailKept.floor}: worst ${family.checks.detailKept.worst}, master fails`);
}
