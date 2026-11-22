// An ffmpeg read-back of the alpha video checks' files (frames in alpha-frames.js), for test:gpu and test:real-ffmpeg.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ALPHA } from './alpha-frames.js';

export { ALPHA, alphaFile, alphaFrame } from './alpha-frames.js';

/**
 * Decodes `file` with ffmpeg's `decoder` (libvpx or libvpx-vp9, which read the BlockAdditions; ffmpeg's own VP8 and
 * VP9 decoders drop them) and checks each frame's alpha, and its colour where it shows, in the middle of its regions.
 * The matrix is named: ffmpeg's libvpx VP8 decoder takes no colour tags from the container and would use BT.601.
 * Returns the largest alpha error in levels.
 */
export function readAlpha(program, file, decoder) {
  const run = (args) => {
    const result = spawnSync(program, args, { maxBuffer: 1 << 28, timeout: 60_000 });
    assert.equal(result.error, undefined, `${program}: ${result.error?.message}`);
    return result;
  };
  const line = run(['-hide_banner', '-i', file]).stderr.toString();
  assert.match(line, /alpha_mode\s*: 1/, line);
  const decoded = run([
    '-v',
    'error',
    '-c:v',
    decoder,
    '-i',
    file,
    '-vf',
    'scale=in_color_matrix=bt709:in_range=tv',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-',
  ]);
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const { width, height, frames, red } = ALPHA,
    size = width * height * 4;
  assert.equal(decoded.stdout.length, size * frames, `${file}: frames decoded`);
  let worst = 0;
  for (let n = 0; n < frames; n++)
    for (const [x, y, alpha] of [
      [32, 48, 0],
      [64, 48, 128],
      [108, 48, 255],
      [16, (n % 6) * 16 + 8, 255],
    ]) {
      const at = n * size + (y * width + x) * 4,
        seen = decoded.stdout[at + 3];
      assert.ok(Math.abs(seen - alpha) <= 4, `${file}: frame ${n} alpha ${seen} at ${x},${y}, not ${alpha}`);
      worst = Math.max(worst, Math.abs(seen - alpha));
      // Colour under full transparency is not shown, so only the visible regions are checked.
      if (alpha)
        for (let k = 0; k < 3; k++)
          assert.ok(
            Math.abs(decoded.stdout[at + k] - red[k]) <= 8,
            `${file}: frame ${n} colour ${decoded.stdout[at + k]}`,
          );
    }
  return worst;
}
