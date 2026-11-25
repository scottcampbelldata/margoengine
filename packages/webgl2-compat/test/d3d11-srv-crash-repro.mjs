// Raw WebGL2 repro, no compatibility layer and no Margo code in the page (KB-BOUNCE-COMPATUNITS1 in docs/known-bugs.md):
// on ANGLE Direct3D 11 a fragment program whose sampler2D uniforms plus its large std140 uniform blocks (one dynamically
// indexed array each, which ANGLE turns into StructuredBuffer shader resources after the textures) pass 16 crashes the
// browser's GPU process at its first draw, losing every WebGL context. Not a gate: it prints, per back end, each case's
// result. Every case runs in a fresh browser, so a crash cannot count against the next case.
//
// Run: node scripts/run-with-timeout.mjs --max 10 -- node packages/webgl2-compat/test/d3d11-srv-crash-repro.mjs
//   [--browser=msedge|chrome] [--angle=d3d11,vulkan] [--samplers=12,13,14,15,16] [--blocks=0,1,2,3] [--sizes=16,64]
//   [--forms=array,tail,struct]
import { chromium } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const list = (name, fallback) => arg(name, fallback).split(',').map(Number);
const channel = arg('browser', 'msedge'),
  angles = arg('angle', 'd3d11,vulkan').split(','),
  samplerCounts = list('samplers', '12,13,14,15,16'),
  blockCounts = list('blocks', '0,1,2,3'),
  sizes = list('sizes', '16,64'),
  forms = arg('forms', 'array').split(',');
const page = pathToFileURL(fileURLToPath(new URL('./d3d11-srv-crash-repro.html', import.meta.url))).href;

const limit = setTimeout(() => {
  console.error('d3d11-srv-crash-repro exceeded its 9 minute limit');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 540_000);

for (const angle of angles) {
  console.log(`--use-angle=${angle}`);
  for (const form of forms)
    for (const size of sizes)
      for (const blocks of blockCounts)
        for (const samplers of samplerCounts) {
          if (blocks === 0 && size !== sizes[0]) continue;
          const browser = await chromium.launch({
            channel,
            headless: true,
            args: [`--use-angle=${angle}`],
          });
          try {
            const tab = await browser.newPage();
            await tab.goto(page);
            await tab.waitForFunction(() => window.reproReady);
            const r = await tab.evaluate((o) => window.runRepro(o), {
              samplers,
              blocks,
              size,
              form,
            });
            if (samplers === samplerCounts[0] && blocks === blockCounts[0] && size === sizes[0])
              console.log(`  ${r.renderer}`);
            console.log(
              `  ${form}: samplers ${samplers}, blocks ${blocks} x uvec4[${size}]: ` +
                (r.linked ? (r.lost ? 'CONTEXT LOST' : `drawn, pixel ${r.pixel.join(' ')}`) : `link failed: ${r.log}`),
            );
          } finally {
            // Bounded: a browser that does not close in time is ended (scripts/support/shutdown.mjs).
            await closeAll({ browser });
          }
        }
}
clearTimeout(limit);
process.exit(0); // process.exit: ends any browser that did not close in time (Playwright kills it at exit)
