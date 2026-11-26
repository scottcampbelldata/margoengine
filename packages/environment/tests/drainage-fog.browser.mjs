import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, hardware, close } = await openBrowser({
  startPath: '/packages/environment/tests/drainage-fog.html',
  port: 5411,
});
const uncaught = [];
page.on('pageerror', (error) => uncaught.push(error.message));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 25000 });
  const sample = async (frame, visible) => {
    const state = await page.evaluate(([t, show]) => window.step(t, show), [frame, visible]);
    assert.deepEqual(state.errors, []);
    return { ...state, image: await decodePNG(await page.locator('canvas').screenshot()) };
  };
  const clear = await sample(0, false);
  const initial = await sample(0, true);
  const moved = await sample(120, true);
  const centroid = (frame) => {
    let moment = 0,
      weight = 0;
    for (let i = 0; i < frame.data.length; i += 4) {
      const color =
        Math.abs(frame.data[i] - clear.image.data[i]) +
        Math.abs(frame.data[i + 1] - clear.image.data[i + 1]) +
        Math.abs(frame.data[i + 2] - clear.image.data[i + 2]);
      weight += color;
      moment += color * ((i / 4) % frame.width);
    }
    assert.ok(weight > 0, 'the resolved grid changes the frame');
    return moment / weight;
  };
  const shift = centroid(moved.image) - centroid(initial.image);
  assert.ok(shift > 1, `wind should carry the rendered fog right, observed ${shift} pixels`);
  assert.ok(Math.abs(initial.water - moved.water) < initial.water * 512 * Number.EPSILON);
  await page.evaluate(() => window.retire());
  assert.deepEqual((await sample(120, false)).image.data, clear.image.data);
  assert.deepEqual(uncaught, []);
  console.log(
    `${hardware?.compat ? 'WebGL2 compatibility' : 'WebGPU'}: resolved fog moved ${shift.toFixed(2)} pixels downwind`,
  );
} finally {
  await close();
}
