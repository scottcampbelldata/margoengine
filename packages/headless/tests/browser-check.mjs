// Real-GPU proof (from the repository root after building packages):
//   node scripts/run-with-timeout.mjs -- node packages/headless/tests/browser-check.mjs
// Renders one cube on a page canvas and through the stand-in canvas, then compares the page's screenshot with the PNG
// bytes at the visual check's limits. Proves the padding, swizzle, row order and encoder on a real device. Then encodes a
// turning cube to WebM and MP4 and plays both back. MARGO_KEEP_VIDEO=<path> keeps the files, to open them in other tools.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { compare } from '../../../scripts/support/visual-image.js';
import { decodePNG } from '../../../tests/support/png.js';
import { readAlpha } from './alpha-video.mjs';

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
  // The same scene in Node on the `webgpu` binding, with no browser: the picture a server makes is the page's.
  const nodeFile = join(tmpdir(), `margo-node-scene-${process.pid}.png`);
  execFileSync(process.execPath, ['packages/headless/tests/node-scene.mts', nodeFile], { stdio: 'inherit', timeout: 120_000 });
  const nodeMetrics = compare(stageSeen, await decodePNG(new Uint8Array(await readFile(nodeFile))));
  await rm(nodeFile);
  assert.ok(nodeMetrics.changed <= LIMITS.changed, `node changed ${nodeMetrics.changed}`);
  assert.ok(nodeMetrics.hot <= LIMITS.hot, `node hot ${nodeMetrics.hot}`);
  console.log(`ok stage in Node: changed ${nodeMetrics.changed}, hot ${nodeMetrics.hot}, mean ${nodeMetrics.mean}`);
  // Video: the browser's encoder, Margo's container, the browser's demuxer and decoder. MOST_DIFFERENCE is the mean
  // channel error a 4 Mbit/s encode of a 256 x 192 cube may show; the wrong frame must show more than any right one.
  const MOST_DIFFERENCE = 2;
  for (const name of ['webm', 'mp4', 'fmp4', 'webm-stream']) {
    const { file, ...result } = await page.evaluate((container) => window.check.video(container), name);
    if (process.env.MARGO_KEEP_VIDEO) await writeFile(`${process.env.MARGO_KEEP_VIDEO}.${name}`, Uint8Array.from(file));
    assert.deepEqual(result.errors, [], 'no validation errors');
    assert.equal(result.frames, 60);
    assert.deepEqual([result.width, result.height], [256, 192]);
    // A streamed WebM's header was written before its end was known, so the joined file states no duration and the
    // element reports none (Infinity) until it has read to the end; its frames still play at their times.
    if (name === 'webm-stream') assert.ok(result.duration === Number.POSITIVE_INFINITY || Math.abs(result.duration - result.expected) < 1 / 30, `duration ${result.duration}`);
    else assert.ok(Math.abs(result.duration - result.expected) < 1 / 30, `duration ${result.duration}`);
    for (const value of result.same) assert.ok(value < MOST_DIFFERENCE, `${name} shows its frames: ${result.same}`);
    assert.ok(result.other > Math.max(...result.same), `${name} frames differ: ${result.other}`);
    if (name === 'fmp4' || name === 'webm-stream') {
      // Header, one fragment or cluster per half-second key frame interval (60 frames at 30 fps: 4), and the index.
      assert.equal(result.pieces, 6);
      if (name === 'webm-stream') assert.ok(result.streamed, 'Chromium takes WebM in Media Source Extensions');
      if (result.streamed) {
        assert.equal(result.streamed.ranges, 1, 'the fragments join with no gap');
        assert.ok(Math.abs(result.streamed.end - result.expected) < 1 / 30, `streamed to ${result.streamed.end}`);
        for (const value of result.streamed.same) assert.ok(value < MOST_DIFFERENCE, `${name} plays from MSE: ${result.streamed.same}`);
      }
    }
    const errors = result.same.map((value) => value.toFixed(2)).join(' ');
    console.log(`ok video ${name}: ${result.codec}, ${result.bytes} B${result.streamed ? `, MSE to ${result.streamed.end.toFixed(3)} s` : ''}, frame error ${errors}, wrong ${result.other.toFixed(2)}`);
  }
  // Alpha video in a <video> element: drawn over blue, the clear third shows blue, the half third the even mix, the solid
  // third and the frame's square red; drawn over nothing, the element's alpha is the frames' (0, 128, 255). The
  // allowance is what a 2 Mbit/s VP8 or VP9 encode of flat regions, through limited-range BT.709, may move a level.
  const ALPHA_LEVELS = 12,
    red = [220, 40, 40],
    blue = [32, 64, 224],
    mix = red.map((value, i) => (value * 128 + blue[i] * 127) / 255);
  // Each from encodeVideo, from streamVideo's WebM joined into a file, and from its pieces given to MSE.
  for (const [codec, decoder, streamed] of [
    ['vp09.00.51.08', 'libvpx-vp9'],
    ['vp8', 'libvpx'],
    ['vp09.00.51.08', 'libvpx-vp9', 'file'],
    ['vp8', 'libvpx', 'file'],
    ['vp09.00.51.08', 'libvpx-vp9', 'mse'],
    ['vp8', 'libvpx', 'mse'],
  ]) {
    const { file, picks, ...result } = await page.evaluate(([name, how]) => window.check.alphaVideo(name, how), [codec, streamed]),
      label = `${codec}${streamed ? ` streamed (${streamed})` : ''}`;
    if (process.env.MARGO_KEEP_VIDEO) await writeFile(`${process.env.MARGO_KEEP_VIDEO}.alpha-${codec}${streamed ? `-${streamed}` : ''}.webm`, Uint8Array.from(file));
    // ffmpeg reads the same file's alpha back with its libvpx decoders (ffmpeg is needed here already: node-check.mjs
    // runs the README's ffmpeg example). FFMPEG names another program.
    const kept = join(tmpdir(), `margo-alpha-${process.pid}-${codec}-${streamed ?? 'whole'}.webm`);
    await writeFile(kept, Uint8Array.from(file));
    const read = readAlpha(process.env.FFMPEG ?? 'ffmpeg', kept, decoder);
    await rm(kept);
    assert.equal(result.alpha, true);
    assert.equal(result.frames, 30);
    assert.deepEqual([result.width, result.height], [128, 96]);
    let worst = 0;
    for (const pick of picks)
      for (const [name, want, alpha] of [
        ['clear', blue, 0],
        ['half', mix, 128],
        ['solid', red, 255],
        ['square', red, 255],
      ]) {
        const { over, alpha: seen } = pick[name],
          off = Math.max(...over.map((value, i) => Math.abs(value - want[i])), Math.abs(seen - alpha));
        worst = Math.max(worst, off);
        assert.ok(off <= ALPHA_LEVELS, `${label} frame ${pick.index} ${name}: over blue ${over}, alpha ${seen}`);
      }
    console.log(`ok alpha video ${label}: ${result.bytes} B, drawn over blue and bare within ${worst} levels; ${decoder} in ffmpeg reads alpha within ${read}`);
  }
  // Formats: the browser's decoders against the encoders.
  const f = await page.evaluate(() => window.check.formats());
  assert.deepEqual(f.errors, [], 'no validation errors');
  // Quality 95 JPEG and quality 0.9 lossy WebP of a rendered cube: a wrong table or transform is off by far more.
  const MEAN = 1,
    MOST = 30;
  if (f.lossyUnsupported) {
    // This browser's canvas has no WebP encoder: the coded error is the right answer, not a measurement.
    assert.equal(f.lossyUnsupported.code, 'unsupported', JSON.stringify(f.lossyUnsupported));
    assert.match(f.lossyUnsupported.message, /cannot encode lossy WebP/);
  }
  for (const key of f.lossyUnsupported ? ['jpeg420', 'jpeg444'] : ['jpeg420', 'jpeg444', 'lossy']) {
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
    `ok formats: jpeg ${f.jpeg420.bytes} B (4:2:0) ${f.jpeg444.bytes} B (4:4:4), mean ${f.jpeg420.mean.toFixed(2)} ${f.jpeg444.mean.toFixed(2)}; lossy webp ${f.lossy ? `${f.lossy.bytes} B, mean ${f.lossy.mean.toFixed(2)}` : 'unsupported here (coded error)'}; exr peak ${f.exr.high}`,
  );
} finally {
  await context.close();
}
