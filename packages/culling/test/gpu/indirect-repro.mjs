// Repro of a Playwright WebKit difference, not a check (docs/known-bugs.md, "models-plain-check WebKit 2 pixels"): two
// plain engines draw NodePerformanceTest.glb, and engine A's frames are drawn with drawIndexedIndirect on arguments equal
// to the drawIndexed calls engine B makes. Every buffer and every other command is the same. It prints the differing
// pixels of each frame; on an Apple M6 WebKit gives 2 after the move (and on the direct frames after it), Chromium 0.
//   MARGO_BROWSER=webkit node packages/culling/test/gpu/indirect-repro.mjs
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/culling/test/gpu/indirect-repro.html', port: 5287 }),
  { page } = context;
const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const size = await page.evaluate(() => window.repro.setup());
  const frames = [
    ['overview, both direct', undefined, false],
    ['overview, A indirect', undefined, true],
    ['overview, both direct again', undefined, false],
    ['moved, A indirect', size * 0.02, true],
    ['moved, both direct', undefined, false],
    ['moved again, both direct', size * 0.03, false],
    ['back to the first move, both direct', size * 0.02, false],
  ];
  for (const [label, move, indirect] of frames) {
    await page.evaluate(([m, i]) => window.repro.frame(m, i), [move, indirect]);
    const [x, y] = [await shot('a'), await shot('b')],
      differ = [];
    for (let k = 0; k < x.data.length; k += 4)
      if (x.data[k] !== y.data[k] || x.data[k + 1] !== y.data[k + 1] || x.data[k + 2] !== y.data[k + 2])
        differ.push(`(${(k / 4) % x.width}, ${Math.floor(k / 4 / x.width)})`);
    console.log(`${label}: ${differ.length} pixels differ ${differ.slice(0, 4).join(' ')}`);
  }
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hang past 15 s
  await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
}
