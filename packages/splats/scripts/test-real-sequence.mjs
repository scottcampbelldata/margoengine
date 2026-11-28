// Plays the third-party animated splat sequence of test/real-files/manifest.json through SplatSequence on a real GPU:
// at times on and between the frames the cloud read back is compared with the mix of the two frames, and on the frames
// themselves the picture is compared with a plain cloud of that frame. The files are read from the folder given as the
// argument and checked by SHA-256; they are never committed. Nothing is fetched without --download. Needs built packages.
// Usage: node packages/splats/scripts/test-real-sequence.mjs <cache folder> [--download] [--pictures=<folder>]
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { downloadArguments } from '../../../scripts/support/download-arguments.mjs';
import { pinnedFiles } from '../../../scripts/support/pinned-files.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const args = downloadArguments(
  `Usage: node packages/splats/scripts/test-real-sequence.mjs <cache folder> [--download] [--pictures=<folder>]
Plays the pinned PLY frames in the folder through SplatSequence on the GPU and compares them with the files.
  --download            fetch the files that are missing or changed, then check them
  --pictures=<folder>   also write the pictures drawn there
  --help                print this and download nothing`,
  { download: { type: 'boolean' }, pictures: { type: 'string' } },
  process.argv.slice(2),
  1,
);
if (!args) process.exit(); // process.exit: help or a refused argument, and nothing is open yet

const manifest = JSON.parse(readFileSync(new URL('../test/real-files/manifest.json', import.meta.url))),
  folder = args.positionals[0];
const rows = manifest.frames.map((row) => ({
  path: join(folder, row.file),
  url: row.url,
  sha256: row.sha256,
  size: row.bytes,
}));
const files = await pinnedFiles(rows, {
  command: `node packages/splats/scripts/test-real-sequence.mjs ${folder}`,
  download: args.download,
});

const context = await openBrowser({ startPath: '/packages/splats/test/gpu/splats.html', port: 'free' }),
  { page } = context;
try {
  await page.waitForFunction(() => window.ready ?? window.check?.sequenceFiles, null, { timeout: 30000 });
  await page.route('**/real-sequence/*', (route) =>
    route.fulfill({
      contentType: 'application/octet-stream',
      body: files[Number(route.request().url().split('/').pop())],
    }),
  );
  const frames = files.length,
    // Every frame, a third and two thirds of the way to the next, the last wrapping to the first.
    times = Array.from({ length: frames * 3 }, (_, i) => i / 3),
    stills = [0, 3, 7, frames - 1],
    result = await page.evaluate((o) => window.check.sequenceFiles(o), {
      urls: files.map((_, i) => `/real-sequence/${i}`),
      times,
      stills,
    });
  assert.equal(result.count, manifest.splats);
  assert.equal(result.frames, frames);
  for (const [key, off] of Object.entries(result.worst)) assert.ok(off < 1e-5, `${key} off the mix by ${off}`);
  assert.ok(result.moved > 0.05, `the capture moves: ${result.moved}`);
  const png = (url) => Buffer.from(url.split(',')[1], 'base64'),
    pictures = [];
  for (const [i, k] of stills.entries()) {
    const plain = await decodePNG(png(result.plain[i])),
      played = await decodePNG(png(result.played[i]));
    let differ = 0,
      lit = 0;
    for (let at = 0; at < plain.data.length; at += 4) {
      const gap = Math.max(...[0, 1, 2].map((c) => Math.abs(plain.data[at + c] - played.data[at + c])));
      if (gap > 2) differ++;
      if (Math.max(...plain.data.subarray(at, at + 3)) > 40) lit++;
    }
    assert.ok(lit > 500, `frame ${k} draws: ${lit} lit pixels`);
    assert.equal(differ, 0, `frame ${k}: ${differ} pixels differ from a plain cloud of the frame`);
    pictures.push({ frame: k, lit, differ });
    if (args.pictures) {
      mkdirSync(args.pictures, { recursive: true });
      writeFileSync(join(args.pictures, `frame-${k}.png`), png(result.played[i]));
    }
  }
  assert.notEqual(result.played[0], result.played[2], 'frames draw different pictures');
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  console.log(
    JSON.stringify({
      splats: result.count,
      frames,
      times: times.length,
      worst: result.worst,
      moved: result.moved,
      pictures,
    }),
  );
} finally {
  await context.close();
}
