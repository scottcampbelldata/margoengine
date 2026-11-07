// Real-GPU proof of @margoengine/cutscene/render (from the repository root after building packages; check:gpu-packages
// takes the GPU lock around it): node packages/cutscene/tests/render-browser.mjs
// Renders a cutscene to WebM and MP4 with sound, then reads the files back with the browser's own demuxers and decoders.
// MARGO_KEEP_VIDEO=<path> keeps the files, to open them in other tools.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { waitReady, watchPage } from './page-ready.mjs';

const context = await openBrowser({ startPath: '/packages/cutscene/tests/render-browser.html', port: 5341 }),
  { page } = context;
let pageErrors = [];
try {
  pageErrors = await watchPage(page);
  await waitReady(page, pageErrors);
  for (const format of ['webm', 'mp4']) {
    const { file, ...result } = await page.evaluate((name) => window.check(name), format);
    if (process.env.MARGO_KEEP_VIDEO) await writeFile(`${process.env.MARGO_KEEP_VIDEO}.${format}`, Uint8Array.from(file));
    assert.deepEqual(result.errors, [], 'no validation errors');
    assert.deepEqual(pageErrors, []);
    // 2 s at 30 frames a second, and frame i shows i / 30 exactly.
    assert.equal(result.frames, 60);
    assert.deepEqual(result.times, Array.from({ length: 60 }, (_, i) => i / 30));
    assert.equal(result.progress.at(-1), 60);
    assert.ok(Math.abs(result.duration - 2) < 0.1, `duration ${result.duration}`);
    // The player fired every instant once, in order, on the file's own clock.
    const named = result.fired.filter((line) => /^(event|marker)/.test(line));
    assert.deepEqual(named, ['event:early@0.5', 'marker:half@1', 'event:late@1.5']);
    // The transform moved the cube right across the picture, and the cut at 1 s to a camera half as far made it larger.
    assert.ok(result.before.at > 0 && result.before.at < result.middle.at, `moves right: ${JSON.stringify(result)}`);
    assert.ok(result.after.covered > 2 * result.middle.covered, 'the shot changed at the cut');
    // Sound: silent to 1 s, then the tone. An RMS of 0.5 / sqrt(2) is what a sine of height 0.5 has; a lossy codec at
    // 128 kbit/s keeps a plain sine well within a tenth of it. The onset allows one 20 ms codec frame and a pre-skip
    // the encoder did not report; the pitch allows one crossing in the 0.6 s counted, plus the decoder's resampling.
    const { sound } = result;
    assert.ok(sound.quiet < 0.01, `quiet before the clip: ${sound.quiet}`);
    assert.ok(Math.abs(sound.loud - 0.5 / Math.SQRT2) < 0.035, `the tone's level: ${sound.loud}`);
    assert.ok(Math.abs(sound.onset - 1) < 0.03, `the tone starts at the clip: ${sound.onset}`);
    assert.ok(Math.abs(sound.hertz - 440) < 2, `the tone's pitch: ${sound.hertz}`);
    console.log(
      `ok render ${format}: ${result.codec} + ${result.audioCodec}, ${result.bytes} B, ${result.frames} frames, duration ${result.duration.toFixed(3)} s, onset ${sound.onset.toFixed(4)} s, ${sound.hertz.toFixed(1)} Hz, level ${sound.loud.toFixed(3)}`,
    );
  }
} finally {
  await context.close();
}
