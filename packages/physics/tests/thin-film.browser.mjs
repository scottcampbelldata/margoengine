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

function pixelDelta(a, b, i) {
  return (
    Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])
  );
}

function changed(a, b) {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) count += Number(pixelDelta(a, b, i) > 12);
  return count;
}

async function directedRain(interior, output, backend) {
  const take = new URL(page.url());
  take.searchParams.set('storm', '');
  if (interior) take.searchParams.set('interior', '');
  else take.searchParams.delete('interior');
  await page.goto(take.href);
  await page.waitForFunction(() => typeof window.wetWindow?.rainFrame === 'function', null, { timeout: 20_000 });
  const { onset, cutoff, release, hold } = await page.evaluate(() => window.wetWindow.timeline);
  async function frame(tick, action, options = {}) {
    const { state, image } = await page.evaluate(
      async (input) => {
        const state = await window.wetWindow.rainFrame(input);
        return { state, image: await window.wetWindow.captureFrame() };
      },
      { frame: tick, action, ...options },
    );
    // Use the actual GPU render target for full-frame comparisons, before the browser compositor.
    const png = Buffer.from(image, 'base64');
    const { budget: pane, basin, flight, landed } = state;
    assert(Math.abs(pane.rain - state.expectedRain) <= 2e-7 * state.expectedRain, 'rain matches the projected area');
    assert(Math.abs(state.paneVolume - pane.stored) <= 1e-16);
    assert(Math.abs(state.basinVolume - basin.stored) <= 1e-16);
    assert(Math.abs(pane.rain - pane.stored - pane.dripped) <= 1e-16);
    assert(Math.abs(landed - basin.impacts) <= 1e-16);
    assert(Math.abs(flight.received - flight.airborne - flight.outflow) <= 1e-16);
    assert.equal(flight.outflow, landed, 'the collector intercepts every departed resolved drop');
    assert.deepEqual([...errors, ...state.errors], []);
    return { state, png, pixels: await decodePNG(png) };
  }
  function same(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.pixels.data, b.pixels.data, 'the same camera reproduces the full RGBA frame');
  }

  const dry = await frame(onset);
  assert.equal(dry.state.budget.rain, 0);
  assert.equal(dry.state.paneVolume, 0);
  assert.equal(dry.state.landed, 0);
  const first = await frame(onset + 1);
  assert(first.state.budget.rain > 0 && first.state.paneVolume > 0);
  const middle = Math.floor((onset + cutoff) / 2) + 1;
  const wet = await frame(middle, 'save');
  const noFilm = await frame(middle, undefined, { wet: false });
  assert.deepEqual(noFilm.state, wet.state);
  const rainPixels = changed(wet.pixels, noFilm.pixels);
  assert(rainPixels > 100, `the caught spray changes ${rainPixels} pixels`);
  const shutoff = await frame(cutoff);
  const dryAir = await frame(cutoff + 1);
  const drained = await frame(release);
  assert(shutoff.state.rotation[0] > wet.state.rotation[0]);
  assert.equal(dryAir.state.budget.rain, shutoff.state.budget.rain);
  assert.equal(drained.state.budget.rain, shutoff.state.budget.rain);
  assert(drained.state.paneVolume < 0.5 * shutoff.state.paneVolume, 'the water keeps draining once the spray stops');
  assert(drained.state.landed > shutoff.state.landed && shutoff.state.landed > 0);
  const noCatchment = await frame(release, undefined, { catchment: false });
  assert.deepEqual(noCatchment.state, drained.state);
  const catchPixels = changed(drained.pixels, noCatchment.pixels);
  assert(catchPixels > 0, 'the accepted basin water changes the visible collector');

  same(await frame(hold), drained);
  same(await frame(middle, 'restore'), wet);
  same(await frame(release), drained);
  same(await frame(onset), dry);
  same(await frame(release), drained);
  const side = interior ? 'inside' : 'outside';
  await writeFile(`${output}/${backend}-${side}-spray.png`, wet.png);
  await writeFile(`${output}/${backend}-${side}-runoff.png`, drained.png);
  console.log(
    `${backend} ${side} spray: ${rainPixels} wet pixels, ${catchPixels} collector pixels, ` +
      `${(drained.state.budget.rain * 1e6).toFixed(4)} mL intercepted, ` +
      `${(drained.state.landed * 1e6).toFixed(4)} mL caught, ${drained.state.hash}.`,
  );
  await page.evaluate(() => window.wetWindow.dispose());
}

try {
  await page.waitForFunction(() => typeof window.wetWindow?.draw === 'function', null, { timeout: 20_000 });
  const tick = await page.evaluate(() => window.wetWindow.advance());
  assert.ok(tick > 0, 'the live sill must shed an airborne drop');
  async function frame(wet, drops, glaze = true) {
    const state = await page.evaluate((options) => window.wetWindow.draw(options), { wet, drops, glaze });
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
  assert.deepEqual([...errors, ...replay.state.errors], []);
  await page.evaluate(() => window.wetWindow.dispose());
  const inside = new URL(page.url());
  inside.searchParams.set('interior', '');
  await page.goto(inside.href);
  await page.waitForFunction(() => typeof window.wetWindow?.draw === 'function', null, { timeout: 20_000 });
  await page.evaluate((t) => window.wetWindow.seek(t), tick);
  const interiorDry = await frame(false, false);
  const interiorWet = await frame(true, false);
  const bareDry = await frame(false, false, false);
  const bareWet = await frame(true, false, false);
  let glazingPixels = 0;
  for (let i = 0; i < bareWet.pixels.data.length; i += 4) {
    if (pixelDelta(bareDry.pixels, bareWet.pixels, i) > 12) {
      glazingPixels += Number(pixelDelta(interiorWet.pixels, bareWet.pixels, i) > 12);
    }
  }
  const interiorPixels = changed(interiorDry.pixels, interiorWet.pixels);
  for (const control of [interiorDry, interiorWet, bareDry, bareWet])
    assert.equal(control.state.hash, flight.state.hash);
  assert.ok(interiorPixels > 100, `film seen through the interior glazing changed only ${interiorPixels} pixels`);
  assert.ok(glazingPixels > 100, `the foreground glass changed only ${glazingPixels} exposed runnel pixels`);
  await page.evaluate((t) => window.wetWindow.seek(t), tick);
  const interiorReplay = await frame(true, false);
  assert.equal(interiorReplay.state.hash, flight.state.hash);
  assert.deepEqual(interiorReplay.pixels.data, interiorWet.pixels.data, 'seeking preserves the two-layer pane');
  assert.deepEqual([...errors, ...interiorReplay.state.errors], []);
  const output = 'test-results/fluid07-window';
  await mkdir(output, { recursive: true });
  const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
  await writeFile(`${output}/${backend}.png`, flight.png);
  await writeFile(`${output}/${backend}-interior.png`, interiorWet.png);
  console.log(
    `${backend} moving window at tick ${tick}: ${filmPixels} wet pixels, ${dropPixels} drop pixels, ${interiorPixels} pixels seen from inside, ${glazingPixels} runnel pixels changed by glass, ${flight.state.hash}.`,
  );
  await page.evaluate(() => window.wetWindow.dispose());
  await directedRain(false, output, backend);
  await directedRain(true, output, backend);
} finally {
  try {
    await page.evaluate(() => window.wetWindow?.dispose());
  } finally {
    await close();
  }
}
