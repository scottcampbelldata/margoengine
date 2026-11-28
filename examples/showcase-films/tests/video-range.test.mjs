import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { colourSidecar, toLimitedBt709 } from '../video-range.mjs';

const ffmpeg = (args) => {
  const result = spawnSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', ...args], {
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, String(result.stderr));
};

test('the capture filter converts from the range the encoder reported', () => {
  assert.equal(
    colourSidecar('test-results/showcase-last-tram.h264'),
    'test-results/showcase-last-tram.h264.colour.json',
  );
  assert.match(
    toLimitedBt709({ fullRange: true, matrix: 'bt709' }),
    /^scale=in_range=full:in_color_matrix=bt709:out_range=tv/,
  );
  assert.match(
    toLimitedBt709({ fullRange: false, matrix: 'smpte170m' }),
    /^scale=in_range=tv:in_color_matrix=smpte170m:/,
  );
  assert.throws(() => toLimitedBt709(undefined), TypeError);
  assert.throws(() => toLimitedBt709({ matrix: 'bt709' }), RangeError);
  assert.throws(() => toLimitedBt709({ fullRange: true, matrix: 'rgb' }), RangeError);
});

// KB-FILM-RANGE1: Chromium's VideoEncoder writes full-range samples; tagging them limited range without converting
// crushed every level below 16 to black, so the films were darker than their stills.
test('a full-range capture keeps its dark levels through the limited-range export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-range-'));
  try {
    const grey = join(dir, 'grey.png'),
      stream = join(dir, 'capture.h264'),
      out = join(dir, 'out.mp4'),
      back = join(dir, 'back.rgb');
    // A dark night grey (sRGB level 20) and a light one (200), as an encoder that works in full range stores them.
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x141414:s=64x64,format=rgb24', '-frames:v', '1', grey]);
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xc8c8c8:s=64x64,format=rgb24', '-frames:v', '1', join(dir, 'light.png')]);
    for (const [name, png] of [
      ['dark', grey],
      ['light', join(dir, 'light.png')],
    ]) {
      ffmpeg([
        '-i',
        png,
        '-vf',
        'scale=in_range=full:out_range=full:out_color_matrix=bt709,format=yuvj420p',
        '-c:v',
        'libx264',
        '-qp',
        '0',
        '-frames:v',
        '1',
        stream,
      ]);
      ffmpeg([
        '-i',
        stream,
        '-vf',
        toLimitedBt709({ fullRange: true, matrix: 'bt709' }),
        '-c:v',
        'libx264',
        '-qp',
        '0',
        '-color_range',
        'tv',
        '-colorspace',
        'bt709',
        out,
      ]);
      ffmpeg([
        '-i',
        out,
        '-vf',
        'scale=in_range=tv:in_color_matrix=bt709:out_range=full,format=rgb24',
        '-f',
        'rawvideo',
        back,
      ]);
      const pixels = readFileSync(back);
      const mean = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
      const want = name === 'dark' ? 20 : 200;
      assert.ok(Math.abs(mean - want) <= 1.5, `${name}: level ${mean.toFixed(2)} after export, want ${want}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
