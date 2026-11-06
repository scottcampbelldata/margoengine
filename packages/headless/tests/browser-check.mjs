// Real-GPU proof (from the repository root after building packages; check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/headless/tests/browser-check.mjs
// Renders one cube on a page canvas and through the stand-in canvas, then compares the page's screenshot with the PNG
// bytes at the visual check's limits. Proves the padding, swizzle, row order and encoder on a real device. Then encodes a
// turning cube to WebM and MP4 and plays both back. MARGO_KEEP_VIDEO=<path> keeps the files, to open them in other tools.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { compare } from '../../../scripts/support/visual-image.js';
import { decodePNG } from '../../../tests/support/png.js';

// The bit-exact allowance of scripts/visual-regression.js (ALLOWANCE): no tolerance of its own.
const LIMITS = { changed: 0.0005, hot: 0.0002 };

const context = await openBrowser({ startPath: '/packages/headless/tests/browser-check.html', port: 5274 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  await page.evaluate(() => window.check.page());
  const seen = await decodePNG(new Uint8Array(await page.locator('#page').screenshot())),
    { png, format, errors } = await page.evaluate(() => window.check.headless()),
    read = await decodePNG(new Uint8Array(png));
  assert.deepEqual(errors, [], 'no validation errors');
  assert.deepEqual([read.width, read.height], [256, 192]);
  assert.deepEqual([seen.width, seen.height], [256, 192]);
  const metrics = compare(seen, read);
  assert.ok(metrics.changed <= LIMITS.changed, `changed ${metrics.changed}`);
  assert.ok(metrics.hot <= LIMITS.hot, `hot ${metrics.hot}`);
  let drawn = 0;
  for (let i = 0; i < read.data.length; i += 4)
    if (Math.abs(read.data[i] - read.data[0]) + Math.abs(read.data[i + 1] - read.data[1]) > 16) drawn++;
  assert.ok(drawn > 1000, `the cube drew (${drawn} pixels differ from the corner)`);
  assert.deepEqual(pageErrors, []);
  console.log(`ok headless: ${format}, changed ${metrics.changed}, hot ${metrics.hot}, mean ${metrics.mean}`);
  // The same stage scene through createStage on a page and createHeadlessStage, with a lazy feature attached.
  await page.evaluate(() => window.check.stagePage());
  const stageSeen = await decodePNG(new Uint8Array(await page.locator('#stage').screenshot())),
    stageRun = await page.evaluate(() => window.check.stageHeadless()),
    stageRead = await decodePNG(new Uint8Array(stageRun.png)),
    stageMetrics = compare(stageSeen, stageRead);
  assert.deepEqual(stageRun.errors, [], 'no validation errors');
  assert.deepEqual([stageRead.width, stageRead.height], [320, 180]);
  assert.ok(stageMetrics.changed <= LIMITS.changed, `stage changed ${stageMetrics.changed}`);
  assert.ok(stageMetrics.hot <= LIMITS.hot, `stage hot ${stageMetrics.hot}`);
  assert.equal(stageRun.ticks, 1);
  assert.deepEqual(stageRun.size, [64, 48]);
  console.log(`ok stage: changed ${stageMetrics.changed}, hot ${stageMetrics.hot}, mean ${stageMetrics.mean}`);
  // Video: the browser's encoder, Margo's container, the browser's demuxer and decoder. MOST_DIFFERENCE is the mean
  // channel error a 4 Mbit/s encode of a 256 x 192 cube may show; the wrong frame must show more than any right one.
  const MOST_DIFFERENCE = 2;
  for (const name of ['webm', 'mp4']) {
    const { file, ...result } = await page.evaluate((container) => window.check.video(container), name);
    if (process.env.MARGO_KEEP_VIDEO) await writeFile(`${process.env.MARGO_KEEP_VIDEO}.${name}`, Uint8Array.from(file));
    assert.deepEqual(result.errors, [], 'no validation errors');
    assert.equal(result.frames, 60);
    assert.deepEqual([result.width, result.height], [256, 192]);
    assert.ok(Math.abs(result.duration - result.expected) < 1 / 30, `duration ${result.duration}`);
    for (const value of result.same) assert.ok(value < MOST_DIFFERENCE, `${name} shows its frames: ${result.same}`);
    assert.ok(result.other > Math.max(...result.same), `${name} frames differ: ${result.other}`);
    const errors = result.same.map((value) => value.toFixed(2)).join(' ');
    console.log(`ok video ${name}: ${result.codec}, ${result.bytes} B, frame error ${errors}, wrong ${result.other.toFixed(2)}`);
  }
  // Formats: the browser's decoders against the encoders.
  const f = await page.evaluate(() => window.check.formats());
  assert.deepEqual(f.errors, [], 'no validation errors');
  // Quality 95 JPEG and quality 0.9 lossy WebP of a rendered cube: a wrong table or transform is off by far more.
  const MEAN = 1,
    MOST = 30;
  for (const key of ['jpeg420', 'jpeg444', 'lossy']) {
    assert.ok(f[key].mean < MEAN && f[key].largest <= MOST, `${key}: mean ${f[key].mean}, largest ${f[key].largest}`);
  }
  assert.deepEqual(f.jpeg420.size, [256, 192]);
  assert.deepEqual(f.jpeg444.size, [256, 192]);
  // Lossless means the same pixels, including odd sizes and alpha (compared premultiplied, as the decoder keeps them).
  for (const one of f.lossless) {
    assert.deepEqual(one.size, one.want);
    assert.equal(one.largest, 0, `lossless ${one.want}`);
  }
  assert.equal(f.opaque.largest, 0, 'the rendered frame comes back bit for bit');
  assert.deepEqual(f.exr.size, f.exr.want);
  assert.ok(f.exr.high > 1, `the linear frame holds a value over 1 (${f.exr.high})`);
  assert.equal(f.exr.exact, 0, 'half floats read back from the EXR are the texture values');
  console.log(
    `ok formats: jpeg ${f.jpeg420.bytes} B (4:2:0) ${f.jpeg444.bytes} B (4:4:4), mean ${f.jpeg420.mean.toFixed(2)} ${f.jpeg444.mean.toFixed(2)}; lossy webp ${f.lossy.bytes} B, mean ${f.lossy.mean.toFixed(2)}; exr peak ${f.exr.high}`,
  );
} finally {
  await context.close();
}
