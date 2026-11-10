import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ port: 'free' });
try {
  const result = await browser.page.evaluate(async () => {
    const { transitionChecks } = await import('/packages/transitions/test/gpu-browser.js');
    const { liveChecks } = await import('/packages/transitions/test/live-browser.js');
    const { viewportChecks } = await import('/packages/transitions/test/viewport-browser.js');
    const { glslChecks } = await import('/packages/transitions/test/glsl-browser.js');
    const { presetChecks } = await import('/packages/transitions/test/presets-browser.js');
    const { fullLiveChecks } = await import('/packages/transitions/test/full-live-browser.js');
    return {
      ...(await glslChecks()),
      ...(await presetChecks()),
      ...(await fullLiveChecks()),
      ...(await transitionChecks()),
      ...(await liveChecks()),
      ...(await viewportChecks()),
    };
  });
  assert.ok(result.pixels > 0);
  console.log(JSON.stringify({ ...result, hardware: browser.hardware }));
} finally {
  await browser.close();
}
