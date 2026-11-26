import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, hardware, close } = await openBrowser({
  startPath: '/packages/physics/tests/thin-film-render.html',
  port: 'free',
  plugins: [
    {
      name: 'thin-film-isolation',
      config: () => ({
        server: {
          headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          },
        },
      }),
    },
  ],
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

function changed(a, b) {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    count += Number(delta > 12);
  }
  return count;
}

try {
  await page.waitForFunction(() => typeof window.wetWindow?.draw === 'function', null, { timeout: 20_000 });
  const tick = await page.evaluate(() => window.wetWindow.advance());
  assert.ok(tick > 0, 'the live sill must shed an airborne drop');
  async function frame(wet, drops) {
    const state = await page.evaluate((options) => window.wetWindow.draw(options), { wet, drops });
    const png = await page.locator('canvas').screenshot();
    return { state, png, pixels: await decodePNG(png) };
  }
  const dry = await frame(false, false);
  const runnel = await frame(true, false);
  const flight = await frame(true, true);
  assert.equal(dry.state.hash, flight.state.hash);
  assert.equal(runnel.state.hash, flight.state.hash);
  const filmPixels = changed(dry.pixels, runnel.pixels);
  const dropPixels = changed(runnel.pixels, flight.pixels);
  assert.ok(filmPixels > 100, `runnels changed only ${filmPixels} pixels`);
  assert.ok(dropPixels > 2, `airborne water changed only ${dropPixels} pixels`);
  assert.ok(flight.state.rotation[0] > 0);
  assert.ok(flight.state.budget.stored > 0 && flight.state.budget.dripped > 0);
  assert.ok(flight.state.drops.some((d) => d.age >= 0.08 && d.position[1] < 0.068));
  await page.evaluate((t) => window.wetWindow.seek(t), tick);
  const replay = await frame(true, true);
  assert.equal(replay.state.hash, flight.state.hash);
  assert.deepEqual(replay.pixels.data, flight.pixels.data, 'seeking replays the rendered water');
  assert.deepEqual([...errors, ...flight.state.errors, ...replay.state.errors], []);
  const output = 'test-results/fluid07-window';
  await mkdir(output, { recursive: true });
  const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
  await writeFile(`${output}/${backend}.png`, flight.png);
  console.log(
    `${backend} moving window at tick ${tick}: ${filmPixels} wet pixels, ${dropPixels} drop pixels, ${flight.state.hash}.`,
  );
} finally {
  try {
    await page.evaluate(() => window.wetWindow?.dispose());
  } finally {
    await close();
  }
}
