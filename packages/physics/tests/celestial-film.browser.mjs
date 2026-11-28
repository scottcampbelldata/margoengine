import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const radians = Math.PI / 180;
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const near = (a, b, error) => assert(Math.abs(a - b) <= error, JSON.stringify({ actual: a, expected: b, error }));

function changed(a, b) {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const diff =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (diff > 18) count++;
  }
  return count;
}

// Full independent ray geometry for the finite rendered collectors. In the central section the blocker
// covers the same projected aperture interval derived for parallel rows in NREL/TP-5K00-76626 §6.
function receiverGeometry(angle, sun, centres, aperture, length) {
  const normal = [Math.sin(angle), Math.cos(angle), 0];
  const alongPanel = [normal[1], -normal[0], 0];
  const toBlocker = centres[1].map((v, i) => v - centres[0][i]);
  const incidence = dot(normal, sun);
  const travel = dot(normal, toBlocker) / incidence;
  const atBlocker = sun.map((v, i) => v * travel - toBlocker[i]);
  const shift = dot(atBlocker, alongPanel);
  const half = aperture / 2;
  const low = Math.max(-half, -half - shift);
  const high = Math.min(half, half - shift);
  const withinPanelLength = Math.abs(atBlocker[2]) < length / 2;
  return {
    normal,
    alongPanel,
    incidence,
    low,
    high,
    alignedZ: atBlocker[2],
    fraction: travel > 0 && withinPanelLength ? Math.max(0, (high - low) / aperture) : 0,
  };
}

function pixelAt(image, m, point) {
  const [x, y, z] = point;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const ndcX = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  const ndcY = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  const ix = Math.floor(image.width * (0.5 + 0.5 * ndcX));
  const iy = Math.floor(image.height * (0.5 - 0.5 * ndcY));
  assert(ix >= 0 && iy >= 0 && ix < image.width && iy < image.height, 'The camera frames the collector readback.');
  const i = 4 * (ix + iy * image.width);
  return image.data[i] + image.data[i + 1] + image.data[i + 2];
}

try {
  const setup = await page.evaluate(async () => {
    const { mountCelestialFilm } = await import('/packages/physics/tests/celestial-film.fixture.js');
    const take = await mountCelestialFilm();
    window.celestialFilm = take;
    const { sample, dispose, ...parameters } = take;
    return parameters;
  });
  const {
    cue,
    dawnCheckpoint,
    risingCheckpoint,
    end,
    rate,
    seed,
    cell,
    timeScale,
    epoch,
    pitch,
    aperture,
    length,
    panelThickness,
    crossAxisSlope,
    groundCoverageRatio,
    centres,
  } = setup;
  assert.equal(aperture / pitch, groundCoverageRatio);
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.celestialFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    assert.deepEqual(state.portCell, cell);
    assert.equal(state.epoch.ut1Seconds, epoch.ut1Seconds + (timeScale * state.frame) / rate);
    assert.equal(state.epoch.ttSeconds, epoch.ttSeconds + (timeScale * state.frame) / rate);
    const light = state.sun;
    near(Math.hypot(...light.direction), 1, 8 * Number.EPSILON);
    near(light.horizontal, light.direction[2] * light.directNormal, 2e-12);
    assert(light.elevation > 0 && light.eclipse === 'none');
    const analysis = state.poses.map((row, i) => {
      const geom = receiverGeometry(row.rotation, state.renderSun, centres[i], aperture, length);
      near((centres[i][1][1] - centres[i][0][1]) / pitch, -Math.tan(crossAxisSlope), 2e-15);
      near(geom.fraction, row.shadedFraction, 3e-14);
      return { ...geom, litBeam: light.directNormal * geom.incidence * (1 - geom.fraction) };
    });
    return { state, png, analysis, pixels: await decodePNG(png) };
  }

  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.pixels.data, b.pixels.data);
  }

  const start = await sample(0);
  exact(await sample(cue), start);
  assert(start.state.sun.elevation > 8 * radians && start.state.sun.elevation < 11 * radians);
  const dawn = await sample(cue + dawnCheckpoint, { action: 'save' });
  const shadowless = await sample(cue + dawnCheckpoint, { receivePanelShadow: false });
  assert.deepEqual(dawn.state, shadowless.state);
  const [trueTrack, backtrack] = dawn.state.poses;
  assert.equal(trueTrack.mode, 'track');
  assert.equal(backtrack.mode, 'backtrack');
  assert(trueTrack.rotation - backtrack.rotation > 60 * radians);
  assert(trueTrack.shadedFraction > 0.6 && trueTrack.shadedFraction < 0.75);
  assert(backtrack.shadedFraction < 1e-13);
  near(dawn.analysis[0].litBeam, dawn.analysis[1].litBeam, 1e-10);

  // Read the same panel pixels with and without shadow receiving. Inspect only the clear interior of each strip,
  // away from the analytic shadow edge, the frame, and the panel's far ends where finite overhang matters.
  const witnesses = [0, 0];
  const witnessesLit = [0, 0];
  for (const [i, geom] of dawn.analysis.entries()) {
    for (const z of [1.42, 2.28, 3.12]) {
      for (let j = 1; j < 18; j++) {
        const u = aperture * (j / 18 - 0.5);
        if (Math.min(Math.abs(u - geom.low), Math.abs(u - geom.high)) < 0.13) continue;
        if (Math.abs(z + geom.alignedZ) > length / 2 - 0.4) continue;
        const world = centres[i][0].map(
          (v, k) => v + geom.alongPanel[k] * u + (geom.normal[k] * panelThickness) / 2 + (k === 2 ? z : 0),
        );
        const lit = pixelAt(shadowless.pixels, shadowless.state.matrix, world);
        const withShadow = pixelAt(dawn.pixels, dawn.state.matrix, world);
        if (u > geom.low && u < geom.high && geom.fraction > 0) {
          if (lit - withShadow > 11) witnesses[i]++;
        } else if (Math.abs(lit - withShadow) <= 3) witnessesLit[i]++;
      }
    }
  }
  assert(witnesses[0] >= 24 && witnessesLit[0] >= 7, JSON.stringify({ witnesses, witnessesLit }));
  assert(witnesses[1] === 0 && witnessesLit[1] >= 36, JSON.stringify({ witnesses, witnessesLit }));
  const shadowPixels = changed(dawn.pixels, shadowless.pixels);
  assert(shadowPixels > 1200, JSON.stringify({ shadowPixels }));

  const rising = await sample(cue + risingCheckpoint, { action: 'save' });
  assert(rising.state.poses[0].shadedFraction < trueTrack.shadedFraction);
  const after = await sample(cue + end);
  assert(after.state.sun.elevation > 35 * radians);
  assert.deepEqual(after.state.poses[0], after.state.poses[1]);
  assert.equal(after.state.poses[0].mode, 'track');
  assert.equal(after.state.poses[0].shadedFraction, 0);
  assert(after.state.sun.horizontal > 800 && after.state.sun.horizontal > 2 * dawn.state.sun.horizontal);
  assert(changed(after.pixels, dawn.pixels) > 5000);

  exact(await sample(cue + end + 45), after);
  exact(await sample(cue + risingCheckpoint, { action: 'restore' }), rising);
  exact(await sample(cue + end), after);
  exact(await sample(cue + dawnCheckpoint, { action: 'restore' }), dawn);
  exact(await sample(cue + risingCheckpoint), rising);
  exact(await sample(cue + end), after);
  exact(await sample(0), start);
  exact(await sample(cue + end), after);
  assert.deepEqual(await page.evaluate(() => window.celestialFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_CELESTIAL_FILM_FRAMES === '1') {
    const path = 'packages/physics/test-results/celestial-film';
    await mkdir(path, { recursive: true });
    for (const [name, shot] of Object.entries({ start, dawn, shadowless, rising, after }))
      await writeFile(`${path}/${backend}-${name}.png`, shot.png);
  }
  console.log(
    `${backend} solar: ${(dawn.state.sun.elevation / radians).toFixed(2)}° dawn, ` +
      `${(trueTrack.rotation / radians).toFixed(2)}°/${(backtrack.rotation / radians).toFixed(2)}° tilt, ` +
      `${(100 * trueTrack.shadedFraction).toFixed(2)}%/0% aperture shade, ` +
      `${dawn.analysis[1].litBeam.toFixed(2)} W/m² net geometric direct flux, ` +
      `${witnesses[0]}/${witnessesLit[1]} shadow/safe witnesses and ${shadowPixels} shadow pixels, ` +
      `seed ${seed}, replay ${after.state.hash}.`,
  );
} finally {
  await close();
}
