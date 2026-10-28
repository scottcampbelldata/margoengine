// WebGL2 capability report (`npm run capabilities --workspace @margoengine/webgl2-compat`): runs probeWebGL2 from
// this package's dist in each installed Chromium browser and ANGLE back end, with WebGPU switched off, and prints one
// line per configuration with the tier, what is missing and the extensions the layer cares about. The numbers in
// docs/webgl2-compat-roadmap.md ("Minimum tier") come from this script. Pass --json for the full reports.
import { chromium } from 'playwright-core';
import { probeScript } from './probe-script.mjs';

const probe = probeScript(),
  json = process.argv.includes('--json');

/** [label, channel, extra switches]: the installed browsers, then Chrome on each ANGLE back end it offers here. */
const CONFIGS = [
  ['Chrome (default back end)', 'chrome', []],
  ['Edge (default back end)', 'msedge', []],
  ['Chrome, ANGLE OpenGL', 'chrome', ['--use-angle=gl']],
  ['Chrome, ANGLE Vulkan', 'chrome', ['--use-angle=vulkan']],
  ['Chrome, SwiftShader (CPU)', 'chrome', ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']],
];

const reports = [];
for (const [label, channel, args] of CONFIGS) {
  let browser;
  try {
    browser = await chromium.launch({ channel, args: ['--disable-features=WebGPU', ...args], timeout: 60_000 });
  } catch (error) {
    reports.push({ label, error: `could not launch: ${String(error.message).split('\n')[0]}` });
    continue;
  }
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: probe });
    const caps = await page.evaluate(() => globalThis.__compat.probeWebGL2());
    reports.push({ label, webgpu: await page.evaluate(() => 'gpu' in navigator), ...caps });
  } catch (error) {
    reports.push({ label, error: String(error.message).split('\n')[0] });
  } finally {
    await browser.close();
  }
}

if (json) console.log(JSON.stringify(reports, null, 1));
else
  for (const r of reports) {
    if (r.error || !r.tier) {
      console.log(`${r.label}: ${r.error ?? 'no WebGL2'}`);
      continue;
    }
    const on = Object.entries(r.extensions)
      .filter(([, v]) => v)
      .map(([k]) => k);
    console.log(
      `${r.label}: tier ${r.tier}${r.missing.length ? ` (missing ${r.missing.join(', ')})` : ''}; ${r.renderer}; ` +
        `max samples ${r.limits.MAX_SAMPLES}, draw buffers ${r.limits.MAX_DRAW_BUFFERS}, fragment units ${r.limits.MAX_TEXTURE_IMAGE_UNITS}, ` +
        `uniform block ${r.limits.MAX_UNIFORM_BLOCK_SIZE} B; extensions: ${on.join(' ')}`,
    );
  }
