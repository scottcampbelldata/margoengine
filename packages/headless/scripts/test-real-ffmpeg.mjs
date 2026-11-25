// encodeWithFFmpeg through a real ffmpeg: writes H.264 and VP9 files, decodes them with the same program and checks the
// frame count, the size, the BT.709 tags and the colours; then AAC and Opus sound beside them, checking its length and
// pitch; then encodeWithFFmpeg's VP9 with alpha, read back by ffmpeg's libvpx decoder with its alpha (test:gpu reads
// encodeVideo's alpha files back the same way). Not a CPU test, as it needs ffmpeg: FFMPEG names the program (default:
// ffmpeg on the path). Run: `npm run test:real-ffmpeg --workspace @margoengine/headless`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWithFFmpeg } from '../dist/ffmpeg.js';
import { alphaFile, readAlpha } from '../tests/alpha-video.mjs';

const program = process.env.FFMPEG ?? 'ffmpeg',
  width = 320,
  height = 192,
  count = 12,
  fps = 12,
  // Four blocks, each a colour with a known BT.709 result.
  blocks = [
    [200, 40, 40],
    [40, 200, 40],
    [40, 40, 200],
    [200, 200, 200],
  ];

function frame(index) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const block = blocks[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)],
        at = (y * width + x) * 4;
      data.set(block, at);
      data[at + 3] = 255;
    }
  // A small square walks across, so that the frames differ and order shows.
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) data.set([0, 0, 0], (y * width + index * 16 + x) * 4);
  return { width, height, data };
}

async function* frames() {
  for (let n = 0; n < count; n++) yield frame(n);
}

const run = (args) => {
  const result = spawnSync(program, args, { maxBuffer: 1 << 28, timeout: 60_000 });
  assert.equal(result.error, undefined, `${program}: ${result.error?.message}`);
  return result;
};

const version = run(['-version']).stdout.toString().split('\n')[0];
const folder = await mkdtemp(join(tmpdir(), 'margo-real-ffmpeg-'));
try {
  for (const [name, codec] of [
    ['clip.mp4', 'h264'],
    ['clip.webm', 'vp9'],
  ]) {
    const output = join(folder, name),
      result = await encodeWithFFmpeg(frames(), { output, fps, ffmpeg: program });
    assert.deepEqual([result.width, result.height, result.frames], [width, height, count]);
    assert.ok((await stat(output)).size > 0);
    // `-i` alone prints the stream line and exits 1: ffmpeg was given no output.
    const line = run(['-hide_banner', '-i', output]).stderr.toString();
    assert.match(line, new RegExp(`Video: ${codec}`), line);
    // ffmpeg prints matrix/primaries/transfer when they differ: BT.709 matrix and primaries, sRGB transfer (H.273 13).
    assert.match(line, /yuv420p\(tv, bt709\/bt709\/iec61966-2-1(, progressive)?\)/, line);
    assert.match(line, new RegExp(`${width}x${height}`), line);
    const decoded = run([
      '-v',
      'error',
      '-i',
      output,
      '-vf',
      'scale=in_color_matrix=bt709:in_range=tv',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    const size = width * height * 3;
    assert.equal(decoded.stdout.length, size * count, `${name}: frames decoded`);
    let worst = 0;
    for (let n = 0; n < count; n++) {
      const base = n * size;
      // The middle of each block, away from chroma edges and the walking square.
      blocks.forEach((want, b) => {
        const x = (b % 2 ? 0.75 : 0.25) * width,
          y = (b < 2 ? 0.3 : 0.75) * height,
          at = base + (Math.floor(y) * width + Math.floor(x)) * 3;
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(decoded.stdout[at + k] - want[k]));
      });
      // The square of frame n stands where this frame put it.
      const at = base + (8 * width + n * 16 + 8) * 3;
      assert.ok(decoded.stdout[at] < 48, `${name}: frame ${n} is out of order`);
    }
    assert.ok(worst <= 8, `${name}: a colour is ${worst} levels off`);
    console.log(
      `PASS ${name}: ${count} frames, ${codec}, BT.709 and sRGB tags, worst colour ${worst} of 255 levels off`,
    );
  }
  // One second of a 440 Hz tone in stereo, the frames lasting one second too (12 at 12 fps).
  const rate = 48_000,
    tone = Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate)),
    audio = { channels: [tone, tone], sampleRate: rate };
  for (const [name, codec] of [
    ['sound.mp4', 'aac'],
    ['sound.webm', 'opus'],
  ]) {
    const output = join(folder, name),
      result = await encodeWithFFmpeg(frames(), { output, fps, ffmpeg: program, audio });
    assert.deepEqual([result.frames, result.audioDuration], [count, 1]);
    const line = run(['-hide_banner', '-i', output]).stderr.toString();
    assert.match(line, new RegExp(`Audio: ${codec}.*48000 Hz, stereo`), line);
    assert.match(line, /Video: (h264|vp9)/, line);
    const decoded = run(['-v', 'error', '-i', output, '-vn', '-f', 'f32le', '-ac', '2', '-ar', String(rate), '-']);
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    const both = new Float32Array(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.length / 4),
      // The left channel; a downmix to one channel would scale the level.
      heard = both.filter((_, i) => i % 2 === 0);
    // The encoders' lead-in is cut by the container (an edit list, Opus pre-skip), so the length is the input's to
    // within one codec frame (1024 AAC samples, 960 Opus samples at 48 kHz).
    assert.ok(Math.abs(heard.length - rate) <= 1024, `${name}: ${heard.length} samples`);
    // Pitch from rising zero crossings over the middle half second: 220 for 440 Hz.
    let rising = 0;
    for (let i = rate / 4; i < (rate * 3) / 4; i++) if (heard[i - 1] < 0 && heard[i] >= 0) rising++;
    assert.ok(Math.abs(rising - 220) <= 1, `${name}: ${rising} cycles in half a second`);
    let peak = 0;
    for (let i = rate / 4; i < (rate * 3) / 4; i++) peak = Math.max(peak, Math.abs(heard[i]));
    assert.ok(Math.abs(peak - 0.5) < 0.05, `${name}: peak ${peak}`);
    console.log(
      `PASS ${name}: ${count} frames and ${heard.length} samples of ${codec}, 440 Hz, peak ${peak.toFixed(3)}`,
    );
  }
  {
    const output = join(folder, 'alpha.webm'),
      result = await encodeWithFFmpeg(alphaFile(), { output, fps: 30, ffmpeg: program, alpha: true });
    assert.equal(result.frames, 30);
    console.log(`PASS alpha.webm: libvpx-vp9 reads alpha within ${readAlpha(program, output, 'libvpx-vp9')} levels`);
  }
  console.log(version);
} finally {
  await rm(folder, { recursive: true, force: true });
}
