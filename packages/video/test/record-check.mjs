import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
// #336699 as 8-bit limited-range Y, Cb, Cr under a matrix with luma weights Kr and Kb (ITU-R BT.601 and BT.709).
const colour = [51, 102, 153],
  matrices = [
    ['bt601', [0.299, 0.114]],
    ['bt709', [0.2126, 0.0722]],
  ],
  limited = ([kr, kb]) => {
    const [r, g, b] = colour.map((c) => c / 255),
      y = kr * r + (1 - kr - kb) * g + kb * b;
    return [16 + 219 * y, 128 + (224 * (b - y)) / (2 - 2 * kb), 128 + (224 * (r - y)) / (2 - 2 * kr)];
  },
  near = (a, b, within) => b.every((v, i) => Math.abs(a[i] - v) <= within);
const browser = await openBrowser({ startPath: '/packages/video/test/record-check.html', port: 'free' });
try {
  await browser.page.waitForFunction(() => typeof window.check === 'function');
  const results = await browser.page.evaluate(() => window.check()),
    { hardware } = browser;
  console.log(JSON.stringify({ hardware: browser.hardware, results }, null, 2));
  assert.equal(results.length, 4);
  for (const r of results) {
    if (r.unsupported) {
      assert.equal(r.unsupported, 'unsupported');
      continue;
    }
    assert.ok(r.bytes > 0);
    assert.match(r.type, new RegExp('^video/' + r.format));
    assert.equal(r.width, 64);
    assert.equal(r.height, 64);
    assert.ok(r.audioSeconds > 0.5);
    assert.ok(r.rms > 0.1, 'recorded tone is audible');
    assert.ok(Math.abs(r.hz - 440) < 5, 'recorded audio retains tone pitch');
    assert.equal(r.callerAudio, 'live');
    // What the encoder wrote, read as raw planes through WebCodecs: the limited-range code of #336699 under BT.601
    // (WebKit 27.2: 95, 159, 100) or BT.709 (Chrome 156: 97, 156, 104), whichever is nearer, within 2.5 levels.
    const standard =
      r.encoded?.yuv &&
      matrices
        .map(([name, k]) => [name, Math.max(...limited(k).map((v, i) => Math.abs(r.encoded.yuv[i] - v)))])
        .sort((a, b) => a[1] - b[1])
        .find(([, error]) => error <= 2.5)?.[0];
    if (r.encoded?.yuv) assert.ok(standard, `encoded code values are not #336699: ${JSON.stringify(r)}`);
    if (!near(r.pixel, colour, 4)) {
      // Known browser defect (docs/known-bugs.md, "WebKit draws its own MediaRecorder VP8 WebM 10 levels too bright"):
      // WebKit's <video> draws its own VP8 WebM's correct BT.601 code as (61, 113, 164). Accepted only in WebKit, only
      // for WebM, only with those encoded values and only with that wrong colour; anything else still fails.
      const defect =
        hardware.browserName === 'webkit' &&
        r.format === 'webm' &&
        standard === 'bt601' &&
        near(r.pixel, [61, 113, 164], 4);
      assert.ok(defect, JSON.stringify(r));
      console.log(
        `KNOWN BROWSER DEFECT webkit-vp8-webm-playback-colour: ${r.backend} webm encoded`,
        r.encoded.yuv,
        'drawn',
        r.pixel,
      );
    }
  }
  for (const backend of ['webgpu', 'webgl2']) assert.ok(results.some((r) => r.backend === backend && !r.unsupported));
} finally {
  await browser.close();
}
